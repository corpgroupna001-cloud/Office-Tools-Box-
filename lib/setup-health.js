// @ts-check
// Setup health for the admin console (F-01): which settings are present and
// which database migrations have run, in words an administrator can act on.
//
// Nothing secret leaves here: a setting is reported as set or not (and, for
// the admin password, whether it is long enough), never its value. Every
// database check is a read — a zero-row select of a column a migration adds,
// or a function a migration adds called so that it touches no data — so a
// check never sends mail or a push and never changes a row.

/** @typedef {{ id: string, group: string, label: string, state: 'ok'|'missing'|'degraded'|'off', detail?: string, fix?: string }} Check */

const COMPANY_SENDERS = { SMTP_USER_1: 'Nova Sportsmart / Protathlitis', SMTP_USER_2: 'Jobways Point', SMTP_USER_3: 'Genie Lamp' };

/**
 * Settings, from the environment. Values are only looked at, never returned.
 * @param {Record<string, string | undefined>} env
 * @returns {Check[]}
 */
function configChecks(env) {
  const set = k => !!String(env[k] || '').trim();
  /** @type {Check[]} */
  const out = [];
  const add = (id, label, state, fix, detail) => out.push({ id, group: 'Settings', label, state, ...(fix ? { fix } : {}), ...(detail ? { detail } : {}) });

  for (const [k, label] of [['SUPABASE_URL', 'Supabase project address'], ['SUPABASE_ANON_KEY', 'Supabase public key'], ['SUPABASE_SERVICE_ROLE_KEY', 'Supabase service key']]) {
    add(k, label, set(k) ? 'ok' : 'missing', set(k) ? '' : `Set ${k} in Vercel (Supabase → Project Settings → API) and redeploy.`);
  }
  const pw = String(env.ADMIN_PASSWORD || '');
  add('ADMIN_PASSWORD', 'Admin password', !pw ? 'missing' : pw.length < 12 ? 'degraded' : 'ok',
    !pw ? 'Set ADMIN_PASSWORD in Vercel.' : pw.length < 12 ? 'Use at least 12 characters; administrators can also open the console with their own account.' : '');

  const mailCore = set('SMTP_HOST') && set('SMTP_PASS') && set('MAIL_API_KEY');
  const missingCore = ['SMTP_HOST', 'SMTP_PASS', 'MAIL_API_KEY'].filter(k => !set(k));
  add('mail', 'Email (sign-up codes, invitations, invoices, attendance)', mailCore ? 'ok' : 'missing',
    mailCore ? '' : `Set ${missingCore.join(', ')} in Vercel.`);
  const noSender = Object.entries(COMPANY_SENDERS).filter(([k]) => !set(k)).map(([, c]) => c);
  add('mail_senders', 'Sender mailbox per company', noSender.length === 0 ? 'ok' : noSender.length === 3 ? 'missing' : 'degraded',
    noSender.length ? `No mailbox for ${noSender.join(', ')}: set SMTP_USER_1/2/3.` : '');
  add('smtp_tls', 'Mail server certificate check', 'ok', '',
    set('SMTP_TLS_SERVERNAME') ? 'verified against SMTP_TLS_SERVERNAME' : 'verified against SMTP_HOST; if mail fails with a certificate error, set SMTP_TLS_SERVERNAME');

  add('biometric', 'Biometric attendance device', set('BIOMETRIC_API_KEY') ? 'ok' : 'off', set('BIOMETRIC_API_KEY') ? '' : 'Set BIOMETRIC_API_KEY to receive punches from the device cloud.');
  add('cron', 'Scheduled jobs (WFH reminders)', set('CRON_SECRET') ? 'ok' : 'degraded', set('CRON_SECRET') ? '' : 'Set CRON_SECRET so only Vercel can trigger the scheduled endpoints.');
  const push = set('VAPID_PUBLIC_KEY') && set('VAPID_PRIVATE_KEY');
  add('push', 'Push notifications', push ? 'ok' : 'off', push ? '' : 'Generate keys with `npx web-push generate-vapid-keys` and set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.');
  const ai = set('GROQ_API_KEY') || set('GROQ_API') || set('GROQ_KEY');
  add('ai', 'AI passages and quizzes (Groq)', ai ? 'ok' : 'off', ai ? '' : 'Set GROQ_API_KEY to generate typing passages and quizzes.');
  const turn = (set('CLOUDFLARE_TURN_KEY_ID') && set('CLOUDFLARE_TURN_API_TOKEN')) || (set('METERED_TURN_DOMAIN') && set('METERED_TURN_API_KEY')) || (set('TURN_URLS') && (set('TURN_SECRET') || set('TURN_CREDENTIAL')));
  add('turn', 'Calls through strict firewalls (TURN relay)', turn ? 'ok' : 'off', turn ? '' : 'Optional: see SETUP.md "Calls behind strict firewalls".');
  return out;
}

/** Migrations to look for, oldest first: what each adds that a zero-row read can see. */
const MIGRATIONS = [
  [1, 'supabase-crm-foundation-migration.sql', 'profiles?select=app_role&limit=0'],
  [2, 'supabase-work-migration.sql', 'tasks?select=id&limit=0'],
  [3, 'supabase-invoices-migration.sql', 'invoices?select=id&limit=0'],
  [4, 'supabase-messenger-migration.sql', 'conversations?select=id&limit=0'],
  [6, 'supabase-b24-migration.sql', 'documents?select=published_token&limit=0'],
  [7, 'supabase-messenger-calls-migration.sql', 'calls?select=id&limit=0'],
  [8, 'supabase-crm-import-migration.sql', 'crm_import_layouts?select=id&limit=0'],
  [9, 'supabase-employee-id-migration.sql', 'profiles?select=employee_id&limit=0'],
  [10, 'supabase-crm-sales-migration.sql', 'crm_quotes?select=id&limit=0'],
  [13, 'supabase-task-summary-migration.sql', 'tasks?select=result_required&limit=0'],
  [16, 'supabase-access-control-migration.sql', 'ws_invitations?select=id&limit=0'],
  [17, 'supabase-otp-limits-migration.sql', 'pending_signups?select=signup_ref&limit=0'],
  [18, 'supabase-document-links-migration.sql', 'documents?select=published_expires_at&limit=0'],
  [19, 'supabase-crm-summary-migration.sql', 'rpc:crm_lead_summary'],
  [20, 'supabase-task-completion-migration.sql', 'tasks?select=result_summary&limit=0'],
  [21, 'supabase-favorites-migration.sql', 'user_favorites?select=user_id&limit=0'],
  [22, 'supabase-notification-prefs-migration.sql', 'notification_prefs?select=user_id&limit=0'],
  [23, 'supabase-attendance-corrections-migration.sql', 'attendance_corrections?select=id&limit=0'],
  [24, 'supabase-delivery-queue-migration.sql', 'delivery_jobs?select=id&limit=0'],
  [25, 'supabase-bitrix-automation-migration.sql', 'bitrix_targets?select=punch_enabled,auto_login,auto_logout&limit=0'],
];

/**
 * @param {{ url: string, key: string, request?: typeof fetch }} db
 * @returns {Promise<Check[]>}
 */
async function databaseChecks({ url, key, request = fetch }) {
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const probe = async target => {
    try {
      if (target.startsWith('rpc:')) {
        // Called for an owner nobody has, so it adds up no rows.
        const r = await request(`${url}/rest/v1/rpc/${target.slice(4)}`, { method: 'POST', headers, body: JSON.stringify({ p_owner: '00000000-0000-4000-8000-000000000000' }) });
        return r.ok ? 'ok' : r.status === 404 ? 'missing' : 'error';
      }
      const r = await request(`${url}/rest/v1/${target}`, { headers });
      if (r.ok) return 'ok';
      const j = /** @type {any} */ (await r.json().catch(() => ({})));
      return ['PGRST204', 'PGRST205', '42703', '42P01', 'PGRST200'].includes(String(j.code)) || r.status === 404 ? 'missing' : 'error';
    } catch { return 'error'; }
  };
  /** @type {Check[]} */
  const out = [];
  const results = await Promise.all(MIGRATIONS.map(([, , target]) => probe(String(target))));
  MIGRATIONS.forEach(([n, file], i) => {
    const r = results[i];
    out.push({ id: 'migration_' + n, group: 'Database', label: `Migration ${n}: ${file}`, state: r === 'ok' ? 'ok' : r === 'missing' ? 'missing' : 'degraded',
      ...(r === 'ok' ? {} : { fix: r === 'missing' ? `Run ${file} in Supabase → SQL Editor (see SETUP.md for the order).` : 'Could not check: is the service key right?' }) });
  });

  // The session gate from migration 16: every table covered, the pre-request installed.
  try {
    const r = await request(`${url}/rest/v1/rpc/ws_access_control_status`, { method: 'POST', headers, body: '{}' });
    if (r.ok) {
      const s = /** @type {any} */ (await r.json());
      const problems = [];
      if (s.tables_gated !== s.tables_with_rls) problems.push(`${s.tables_with_rls - s.tables_gated} table(s) without the gate: run \`select public.ws_apply_session_gate();\``);
      if (!s.storage_gated) problems.push('storage is not gated');
      if (!s.pre_request) problems.push('the PostgREST pre-request check is not installed (see SETUP.md section 16)');
      if (!s.mfa_check) problems.push('two-step verification cannot be checked (no access to auth.mfa_factors)');
      if (!s.session_check) problems.push('ended sessions cannot be checked (no access to auth.sessions)');
      if (!s.private_columns_hidden) problems.push('exit reasons are readable: run migration 16 again');
      out.push({ id: 'access_gate', group: 'Database', label: 'Access control (active account, two-step, live session)',
        state: problems.length ? 'degraded' : 'ok', ...(problems.length ? { fix: problems.join('; ') } : {}),
        detail: `${s.tables_gated}/${s.tables_with_rls} tables gated · ${s.pending_accounts} sign-up(s) waiting for approval` });
    }
  } catch { /* reported by the migration 16 row */ }

  // Files left in the retired public bucket (migration 18).
  try {
    const r = await request(`${url}/rest/v1/rpc/ws_published_leftovers`, { method: 'POST', headers, body: JSON.stringify({ p_limit: 500 }) });
    if (r.ok) {
      const n = /** @type {any[]} */ (await r.json()).length;
      out.push({ id: 'published_leftovers', group: 'Database', label: 'Old public file copies', state: n ? 'degraded' : 'ok',
        detail: n ? `${n}${n === 500 ? '+' : ''} file(s) left in the retired "published" bucket (no longer reachable)` : 'none left',
        ...(n ? { fix: 'Remove them with the button below.' } : {}) });
    }
  } catch { /* optional */ }
  return out;
}

/** Everything, with a one-line summary. */
async function setupHealth(env, db) {
  const checks = [...configChecks(env), ...(db.url && db.key ? await databaseChecks(db) : [])];
  const count = s => checks.filter(c => c.state === s).length;
  return { checks, summary: { ok: count('ok'), missing: count('missing'), degraded: count('degraded'), off: count('off') }, checked_at: new Date().toISOString() };
}

module.exports = { configChecks, databaseChecks, setupHealth, MIGRATIONS };
