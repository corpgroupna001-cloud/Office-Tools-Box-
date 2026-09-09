// Admin audit trail.
//
// Wraps the response object so every non-read admin action records what was
// attempted and how it ended, without each action having to remember to log.
// New mutating actions are audited by default: the exemption list below names
// the reads, not the writes.
//
// The record is written AFTER the response is sent, so the console never waits
// on the audit table; the handler still awaits it, which keeps the serverless
// invocation alive long enough for the write to land.

const READ_ONLY = new Set([
  'login', 'logout', 'session',
  'results', 'quiz_results', 'employees', 'audit_log',
  'wfh_recordings', 'friday_report', 'roster_list',
  'mail_logs', 'mail_status',
  'bitrix_status', 'bitrix_hooks', 'bitrix_logs',
  'leave_list', 'holiday_list', 'shift_list',
  'att_daily_report', 'att_logs', 'att_unmapped', 'att_selfies',
]);

// Reads that change nothing but reach a third party, so they are worth keeping:
// a Bitrix profile probe and a test email both leave a trace outside WorkSuite.
const TITLES = {
  update_employee: 'Edited employee',
  create_employee: 'Added employee',
  set_employee_status: 'Changed employment status',
  bulk_employees: 'Bulk employee import',
  delete_employee: 'Deleted employee',
  reset_password: 'Sent password reset',
  set_wfh: 'Changed work-from-home flag',
  set_device: 'Changed required check-in devices',
  wfh_delete: 'Deleted a check-in recording',
  wfh_review: 'Reviewed a check-in recording',
  att_review: 'Reviewed an attendance selfie',
  att_recompute: 'Recomputed attendance',
  att_resend: 'Resent an attendance email',
  att_map_code: 'Mapped a biometric code',
  att_unmap_code: 'Unmapped a biometric code',
  roster_bind: 'Linked a device enrolment',
  roster_unbind: 'Unlinked a device enrolment',
  leave_decide: 'Decided a leave request',
  holiday_save: 'Saved a holiday',
  holiday_delete: 'Deleted a holiday',
  holiday_prefill: 'Pre-filled the holiday list',
  shift_save: 'Saved a shift',
  shift_delete: 'Deleted a shift',
  shift_assign: 'Assigned a shift',
  pay_set_rate: 'Set a pay rate',
  pay_clear_rate: 'Cleared a pay rate',
  pay_role2_set: 'Set a second-role pay rate',
  pay_role2_clear: 'Cleared a second-role pay rate',
  mail_test: 'Sent a test email',
  bitrix_save: 'Saved Bitrix settings',
  bitrix_test: 'Sent a Bitrix test message',
  bitrix_hook_test: 'Tested a Bitrix webhook',
};

const clip = (value, max = 300) => value == null ? null : String(value).slice(0, max);

/** Who or what the action was aimed at, from whatever the request happened to carry. */
function targetOf(body) {
  const id = body.id || body.user_id || body.enroll || body.employee_code || body.shift_id || body.holiday_id || null;
  const label = body.full_name || body.email || body.employee_name || body.name || body.company ||
                body.enroll || body.employee_code || null;
  return { target_id: clip(id, 100), target_label: clip(label, 200) };
}

/** A one-line description an HR reader can follow without knowing the API. */
function summaryOf(action, body) {
  const bits = [];
  if (body.status) bits.push('status ' + body.status);
  if (body.company) bits.push(body.company);
  if (body.month) bits.push(body.month);
  if (body.date || body.from || body.to) bits.push([body.date, body.from, body.to].filter(Boolean).join(' → '));
  if (typeof body.is_wfh === 'boolean') bits.push(body.is_wfh ? 'work from home' : 'in office');
  if (body.apply === true) bits.push('applied');
  if (body.apply === false) bits.push('preview only');
  if (Array.isArray(body.rows)) bits.push(body.rows.length + ' rows');
  return clip([TITLES[action] || action, bits.join(' · ')].filter(Boolean).join(' — '), 500);
}

async function record(action, body, { httpStatus, payload, req }) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return false;
  const ok = httpStatus >= 200 && httpStatus < 300;
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  try {
    const r = await fetch(url + '/rest/v1/admin_audit', {
      method: 'POST', signal: AbortSignal.timeout(1500),
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json',
                 Prefer: 'return=minimal' },
      body: JSON.stringify({
        action: clip(action, 100),
        ...targetOf(body),
        summary: summaryOf(action, body),
        status: ok ? 'ok' : 'failed',
        http_status: httpStatus,
        detail: ok ? null : clip(payload && (payload.error || payload.message)),
        actor_ip: clip(forwarded, 60) || null,
      }),
    });
    // A missing table is the expected state before the migration runs, and is
    // not worth failing an otherwise successful admin action over.
    if (!r.ok) console.warn('Admin audit unavailable:', r.status);
    return r.ok;
  } catch { console.warn('Admin audit unavailable'); return false; }
}

/**
 * Returns `res` with status/json instrumented. The same object is mutated, so
 * the existing `return res.status(n).json(x)` chains keep working unchanged.
 */
function auditWrap(res, req, action, body) {
  if (READ_ONLY.has(action)) return res;
  const status = res.status.bind(res);
  const json = res.json.bind(res);
  let httpStatus = 200;
  res.status = code => { httpStatus = code; status(code); return res; };
  res.json = payload => {
    const sent = json(payload);
    // Respond first, record second: the caller returns this promise, so the
    // invocation stays alive for the write without delaying the reply.
    return record(action, body || {}, { httpStatus, payload, req }).then(() => sent, () => sent);
  };
  return res;
}

module.exports = { auditWrap, READ_ONLY, TITLES, summaryOf, targetOf };
