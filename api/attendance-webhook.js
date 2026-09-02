// ============================================================
// Biometric attendance ingest.
//
// The Realtime / OnlineRealSoft biometric cloud POSTs here every time
// somebody touches a reader ("Parallel Data Export Setting → Third-Party API
// Integration"). We store the punch and email the employee immediately.
//
// Contract we ask the vendor for (configured on their ERP_Third_PartyApi page):
//   POST  https://work-suite-mauve.vercel.app/api/attendance-webhook
//   Authorization: Bearer <BIOMETRIC_API_KEY>
//   Content-Type: application/json      Data Sending Format: Body
//   { "employee_code": "1023", "employee_name": "Sirimilla Vinay",
//     "direction": "IN", "log_datetime": "2026-09-02 08:45:00",
//     "downloaded_at": "2026-09-02 08:46:00",
//     "device_sn": "SN-009128", "device_name": "Main Gate" }
//
// IN/OUT: the Realtime export does NOT actually send a direction — its
// payload is only employee_code, employee_name, log_datetime, downloaded_at,
// device_sn and device_name. So when no direction arrives we DERIVE it from
// the punch's position in that employee's IST day (1st = IN, 2nd = OUT, …)
// and flag the row direction_derived. An explicit direction from the device
// always wins, so this needs no change if the vendor ever starts sending one.
//
// It is deliberately forgiving about shape: keys are matched
// case/underscore-insensitively, a single object or an array (or {data:[…]})
// are both accepted, and IN/OUT can arrive as `direction`, as separate
// `in`/`out` fields, or as 1/0.
//
// Env required in Vercel:
//   BIOMETRIC_API_KEY            shared secret the device sends
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   SMTP_* (see lib/mailer.js)
//   ATTENDANCE_EMAIL_MAX_AGE_HOURS  optional, default 12 — see BACKFILL below
// ============================================================

const { sendMail } = require('../lib/mailer');
const {
  parseDeviceDateTime, istParts, normalizeDirection,
  matchProfileByName, buildPunchEmail,
  evaluateShift, timeToMinutes, offsetFromBoundary,
} = require('../lib/attendance');

// Vercel Hobby kills the function at 10s. Stop starting new sends at 7.5s and
// leave the rest as 'pending' — the admin Attendance tab can resend those.
const EMAIL_DEADLINE_MS = 7500;
const EMAIL_CONCURRENCY = 4;
const MAX_RECORDS = 500;

// BACKFILL GUARD: the vendor's "Manual Data Export" can replay any date range.
// Punches older than this are stored but NOT emailed, so re-exporting last
// month never spams 24 people with hundreds of stale notifications.
const DEFAULT_EMAIL_MAX_AGE_HOURS = 12;

// ---------- tiny helpers ----------

const norm = k => String(k).toLowerCase().replace(/[\s_\-.]/g, '');

/** Case- and underscore-insensitive field lookup with aliases. */
function pick(flat, ...aliases) {
  for (const a of aliases) {
    const v = flat[norm(a)];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

function flatten(record) {
  const out = {};
  for (const [k, v] of Object.entries(record || {})) out[norm(k)] = v;
  return out;
}

function truthy(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no' && s !== 'null';
}

/** Run tasks with bounded concurrency, stopping cleanly at a wall-clock deadline. */
async function runBounded(items, limit, deadlineAt, worker, onSkipped) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      if (Date.now() > deadlineAt) { onSkipped(items[idx]); continue; }
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

module.exports = async function handler(req, res) {
  const startedAt = Date.now();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-worksuite-attendance-key');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const API_KEY      = process.env.BIOMETRIC_API_KEY;

  // ---- Auth. Accept the three shapes the vendor's auth dropdown can produce.
  const authz    = String(req.headers.authorization || '');
  const bearer   = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : '';
  const supplied = bearer
    || String(req.headers['x-api-key'] || '')
    || String(req.headers['x-worksuite-attendance-key'] || '')
    || String(req.query?.key || '');

  if (!API_KEY) return res.status(500).json({ error: 'BIOMETRIC_API_KEY not configured on server.' });
  if (supplied !== API_KEY) {
    await new Promise(r => setTimeout(r, 400)); // slow down guessing
    return res.status(401).json({ error: 'unauthorized' });
  }

  // A GET with a valid key is a health check — handy when pasting the URL
  // into the vendor's form to confirm the endpoint and key are live.
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, endpoint: 'attendance-webhook', ready: Boolean(SUPABASE_URL && SERVICE_KEY) });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Supabase server config missing.' });

  // ---- Body → array of records ----
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { body = {}; } }
  body = body || {};

  let records = Array.isArray(body)
    ? body
    : (body.data || body.logs || body.records || body.attendance || body.Table || null);
  if (!Array.isArray(records)) records = [body];
  records = records.filter(r => r && typeof r === 'object').slice(0, MAX_RECORDS);

  if (!records.length) return res.status(400).json({ error: 'no records in payload' });

  const H = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };

  const maxAgeHours = Number(process.env.ATTENDANCE_EMAIL_MAX_AGE_HOURS || DEFAULT_EMAIL_MAX_AGE_HOURS);
  const emailCutoff = Date.now() - maxAgeHours * 3600 * 1000;

  try {
    // ---- 1. Everyone we know about, in one query ----
    const pRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?select=id,email,full_name,company,employee_code,shift_id&limit=2000`,
      { headers: H }
    );
    if (!pRes.ok) {
      return res.status(502).json({ error: 'profiles fetch failed', detail: (await pRes.text()).slice(0, 200) });
    }
    const profiles = await pRes.json();

    // Shifts are optional: if the migration hasn't been run, punches still
    // land and email, just without the late / early note.
    let shiftById = new Map(), defaultShift = null;
    try {
      const shRes = await fetch(`${SUPABASE_URL}/rest/v1/shifts?select=*`, { headers: H });
      if (shRes.ok) {
        const list = await shRes.json();
        shiftById = new Map(list.map(x => [x.id, x]));
        defaultShift = list.find(x => x.is_default) || null;
      }
    } catch { /* no shifts table yet */ }
    const shiftFor = p => (p && p.shift_id && shiftById.get(p.shift_id)) || defaultShift || null;
    const byCode = new Map(
      profiles.filter(p => p.employee_code).map(p => [String(p.employee_code).trim(), p])
    );

    // ---- 2. Normalise every record, resolving who it belongs to ----
    const rows = [];
    const rejected = [];
    const autoLinked = [];

    for (const rec of records) {
      const flat = flatten(rec);

      const code = pick(flat, 'employee_code', 'employeecode', 'empcode', 'emp_code', 'employeeid', 'empid', 'code', 'userid');
      if (code === undefined) { rejected.push({ record: rec, reason: 'missing employee_code' }); continue; }
      const employeeCode = String(code).trim();

      const employeeName = pick(flat, 'employee_name', 'employeename', 'empname', 'name', 'username') || null;

      // Direction: an explicit field, or separate in/out flags, or nothing.
      let direction = normalizeDirection(
        pick(flat, 'direction', 'punch_type', 'punchtype', 'inout', 'in_out', 'io', 'type', 'status', 'attendance_type')
      );
      if (direction === 'UNKNOWN') {
        const inFlag = flat[norm('in')], outFlag = flat[norm('out')];
        if (truthy(inFlag) && !truthy(outFlag)) direction = 'IN';
        else if (truthy(outFlag) && !truthy(inFlag)) direction = 'OUT';
      }

      // Timestamp: a full datetime, else date + time stitched together.
      let when = parseDeviceDateTime(
        pick(flat, 'log_datetime', 'logdatetime', 'log_date_time', 'punchtime', 'punch_time', 'datetime', 'timestamp', 'logtimestamp')
      );
      if (!when) {
        const d = pick(flat, 'log_date', 'logdate', 'date');
        const t = pick(flat, 'log_time', 'logtime', 'time');
        if (d) when = parseDeviceDateTime(t ? `${d} ${t}` : String(d));
      }
      if (!when) { rejected.push({ record: rec, reason: 'missing or unparseable log_datetime' }); continue; }

      const t = istParts(when);

      // Who is this? Code first; fall back to the name the device sends and
      // remember the code on that profile so it only ever happens once.
      let profile = byCode.get(employeeCode) || null;
      let matchReason = profile ? 'employee_code' : null;

      if (!profile && employeeName) {
        const m = matchProfileByName(employeeName, profiles);
        if (m.profile && !m.profile.employee_code) {
          const linkRes = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(m.profile.id)}`,
            { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ employee_code: employeeCode }) }
          );
          if (linkRes.ok) {
            m.profile.employee_code = employeeCode;
            byCode.set(employeeCode, m.profile);
            profile = m.profile;
            matchReason = `auto_linked:${m.reason}`;
            autoLinked.push({ employee_code: employeeCode, name: m.profile.full_name });
          }
        } else if (m.profile && m.profile.employee_code !== employeeCode) {
          // Name matches someone already bound to a different code — that is a
          // data conflict, not something to guess at. Leave it for an admin.
          matchReason = 'conflict_name_bound_to_other_code';
        }
      }

      const isOldBackfill = when.getTime() < emailCutoff;

      rows.push({
        insert: {
          user_id:       profile ? profile.id : null,
          employee_code: employeeCode,
          employee_name: employeeName,
          direction,
          log_datetime:  when.toISOString(),
          log_date:      t.isoDate,
          log_time:      t.isoTime,
          downloaded_at: (parseDeviceDateTime(pick(flat, 'downloaded_at', 'downloaddatetime', 'download_date_time', 'downloadedon')) || null)?.toISOString() || null,
          device_sn:     String(pick(flat, 'device_sn', 'deviceserialno', 'device_serial_no', 'serialno', 'serial_number', 'sn') || ''),
          device_no:     pick(flat, 'device_no', 'deviceno', 'device_number') || null,
          device_name:   pick(flat, 'device_name', 'devicename', 'devicelocation', 'location') || null,
          email_status:  !profile ? 'unmapped' : isOldBackfill ? 'skipped' : 'pending',
          email_to:      profile ? profile.email : null,
          email_error:   !profile
            ? `No profile for code ${employeeCode}${employeeName ? ` / name "${employeeName}"` : ''} (${matchReason || 'no_match'})`
            : isOldBackfill ? `Backfill: punch older than ${maxAgeHours}h — stored, not emailed.` : null,
          raw: rec,
        },
        profile,
        when,
      });
    }

    // ---- 2b. Derive IN/OUT for anything the device didn't label ----
    // Counted by position within the employee's IST day, using both what is
    // already stored and the earlier records in this same batch.
    // Runs over EVERY row, not just undirected ones: the ordinal also tells
    // us whether a punch is the day's first, which is what makes a "late"
    // note on the email trustworthy.
    {
      const groups = new Map();
      for (const r of rows) {
        const key = `${r.insert.employee_code}|${r.insert.log_date}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
      }

      await Promise.all([...groups.entries()].map(async ([key, list]) => {
        const sep  = key.lastIndexOf('|');
        const code = key.slice(0, sep);
        const day  = key.slice(sep + 1);

        let stored = [];
        try {
          const r = await fetch(
            `${SUPABASE_URL}/rest/v1/attendance_logs` +
            `?employee_code=eq.${encodeURIComponent(code)}&log_date=eq.${day}` +
            `&select=log_datetime&limit=1000`,
            { headers: H }
          );
          if (r.ok) stored = (await r.json()).map(x => new Date(x.log_datetime).getTime());
        } catch { /* fall back to batch-only ordering */ }

        // Compare against absolute instants, so an out-of-order or replayed
        // batch still lands on the same parity as a live sequence would.
        list.sort((a, b) => new Date(a.insert.log_datetime) - new Date(b.insert.log_datetime));
        for (const item of list) {
          const t = new Date(item.insert.log_datetime).getTime();
          const priors = stored.filter(x => x < t).length;
          item.isFirstOfDay = priors === 0;
          if (item.insert.direction === 'UNKNOWN') {
            item.insert.direction = priors % 2 === 0 ? 'IN' : 'OUT';
            item.insert.direction_derived = true;
          }
          stored.push(t);
        }
      }));
    }

    if (!rows.length) {
      return res.status(200).json({ success: true, received: records.length, stored: 0, emailed: 0, rejected });
    }

    // ---- 3. One insert for the whole batch. ON CONFLICT DO NOTHING means a
    //         replayed export inserts nothing and therefore emails nothing.
//         Keyed on (employee_code, log_datetime, device_sn) — not direction,
//         which is derived and can legitimately be recomputed.
    const insRes = await fetch(
      `${SUPABASE_URL}/rest/v1/attendance_logs?on_conflict=employee_code,log_datetime,device_sn`,
      {
        method: 'POST',
        headers: { ...H, Prefer: 'return=representation,resolution=ignore-duplicates' },
        body: JSON.stringify(rows.map(r => r.insert)),
      }
    );
    if (!insRes.ok) {
      const detail = (await insRes.text()).slice(0, 300);
      console.error('[attendance] insert failed', detail);
      return res.status(502).json({ error: 'insert failed', detail });
    }
    const inserted = await insRes.json();

    // Re-attach the resolved profile to each freshly inserted row.
    // Must match the unique index: direction is derived and therefore not
    // part of a punch's identity.
    const keyOf = r => `${r.employee_code}|${new Date(r.log_datetime).getTime()}|${r.device_sn || ''}`;
    const metaByKey = new Map(rows.map(r => [keyOf(r.insert), r]));

    const toEmail = inserted
      .map(row => ({ row, meta: metaByKey.get(keyOf(row)) }))
      .filter(x => x.meta && x.meta.profile && x.row.email_status === 'pending');

    const duplicates = rows.length - inserted.length;

    // ---- 4. Notify ----
    let emailed = 0, failed = 0, deferred = 0;
    const deadlineAt = startedAt + EMAIL_DEADLINE_MS;

    await runBounded(
      toEmail, EMAIL_CONCURRENCY, deadlineAt,
      async ({ row, meta }) => {
        const p = meta.profile;
        const shift = shiftFor(p);

        // Only annotate a boundary we can actually stand behind:
        //  - lateness, only on the day's FIRST punch (a 2pm return from lunch
        //    is not "4 hours late for a 9:30 shift");
        //  - leaving early, only from the shift's midpoint onwards, so a
        //    lunch-break exit isn't reported as going home early.
        let pastMidpoint = false;
        if (shift) {
          const st = timeToMinutes(shift.start_time), en = timeToMinutes(shift.end_time);
          const span = (((en - st) % 1440) + 1440) % 1440 || 1440;
          const mid  = (st + Math.floor(span / 2)) % 1440;
          pastMidpoint = offsetFromBoundary(timeToMinutes(istParts(meta.when).isoTime), mid) >= 0;
        }
        const shiftEval = shift ? evaluateShift({
          shift,
          firstIn:  (row.direction === 'IN'  && meta.isFirstOfDay) ? meta.when : null,
          lastOut:  (row.direction === 'OUT' && pastMidpoint)      ? meta.when : null,
          date: meta.when,
        }) : null;

        const { subject, html, text } = buildPunchEmail({
          fullName: p.full_name,
          direction: row.direction,
          when: meta.when,
          deviceName: row.device_name,
          employeeCode: row.employee_code,
          shift: shiftEval,
        });

        const result = await sendMail({ company: p.company, to: p.email, subject, html, text });
        if (result.ok) emailed++; else failed++;

        await fetch(`${SUPABASE_URL}/rest/v1/attendance_logs?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: { ...H, Prefer: 'return=minimal' },
          body: JSON.stringify({
            email_status: result.ok ? 'sent' : 'failed',
            emailed_at:   result.ok ? new Date().toISOString() : null,
            email_error:  result.ok ? null : `${result.reason}: ${result.detail}`.slice(0, 400),
          }),
        }).catch(() => {});
      },
      () => { deferred++; } // left 'pending' — resend from the admin tab
    );

    // Always 200 once the punches are safely stored: the vendor logs a failure
    // for any non-2xx, and a mail problem is ours to retry, not theirs.
    return res.status(200).json({
      success: true,
      received: records.length,
      stored: inserted.length,
      duplicates,
      emailed,
      failed,
      deferred,
      unmapped: inserted.filter(r => r.email_status === 'unmapped').length,
      backfill_skipped: inserted.filter(r => r.email_status === 'skipped').length,
      auto_linked: autoLinked,
      rejected,
      ms: Date.now() - startedAt,
    });
  } catch (e) {
    console.error('[attendance] error', e);
    return res.status(500).json({ error: 'server error', detail: String(e && e.message || e).slice(0, 300) });
  }
};
