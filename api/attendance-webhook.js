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
// This endpoint serves TWO callers, which is why it is not two files: the
// Hobby plan caps a deployment at 12 serverless functions and we are on the
// line.
//   1. The biometric cloud, authenticating with BIOMETRIC_API_KEY.
//   2. A WFH employee's browser posting a selfie punch, authenticating with
//      their own Supabase access token (mode:'selfie'). Their JWT is verified
//      against Supabase, so a punch can only ever be filed as the person
//      actually signed in, and the timestamp is taken from the server.
//
// Env required in Vercel:
//   BIOMETRIC_API_KEY            shared secret the device sends
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   SMTP_* (see lib/mailer.js)
//   ATTENDANCE_EMAIL_MAX_AGE_HOURS  optional, default 12 — see BACKFILL below
// ============================================================

const { sendMail } = require('../lib/mailer');
const bitrix = require('../lib/bitrix');
const {
  parseDeviceDateTime, istParts, normalizeDirection,
  matchProfileByName, buildPunchEmail,
  evaluateShift, timeToMinutes, offsetFromBoundary,
  istToday, monthDates, buildMonth, classifyDay,
  weekOffsFor, holidayOn, DAY_STATUS,
  deriveEventType, buildPunchChatLine, buildLeaveChatLine,
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
    // Not the device key — the only other accepted caller is a signed-in
    // employee filing their own selfie punch.
    let maybe = req.body;
    if (typeof maybe === 'string') { try { maybe = JSON.parse(maybe || '{}'); } catch { maybe = {}; } }
    if (req.method === 'POST' && supplied && maybe && USER_MODES.has(maybe.mode)) {
      if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Supabase server config missing.' });
      if (maybe.mode === 'selfie') {
        return handleSelfiePunch({ res, token: supplied, body: maybe, SUPABASE_URL, SERVICE_KEY, startedAt });
      }
      // Read-only views for the signed-in employee. They live here rather than
      // in a new file because the Hobby plan allows 12 serverless functions and
      // the repo has 12; and here they can reuse the token check above.
      return handleUserView({ res, token: supplied, body: maybe, SUPABASE_URL, SERVICE_KEY });
    }
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

      // The device's own "Employee Code" (the CG-… string), when it sends one.
      // It is NOT the enrolment number above, arrives late, and on this reader
      // arrives truncated - so it is recorded for reference but nothing keys on
      // it. Try named fields, then fall back to shape: a hyphenated code with
      // letters, which the numeric enroll number never matches.
      let staffCode = pick(flat, 'staff_code', 'staffcode', 'staff_id', 'staffid',
                                 'badge_no', 'badgeno', 'card_no', 'cardno', 'emp_code2');
      if (staffCode == null) {
        for (const v of Object.values(flat)) {
          const str = String(v == null ? '' : v).trim();
          if (/^[A-Za-z]{2,}-[A-Za-z0-9-]{1,}$/.test(str) && str !== employeeName) { staffCode = str; break; }
        }
      }
      staffCode = staffCode == null ? null : String(staffCode).trim() || null;

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
        staffCode,
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
          item.priorsToday = priors;
          // Name the event, not just the direction: Login / Break out /
          // Break in / Logout is what the email and the screens show. The
          // reader never sends this, so it is derived from position in the
          // day plus the shift end - see deriveEventType.
          item.insert.event_type = deriveEventType({
            priorsToday: priors,
            direction: item.insert.direction,
            when: item.insert.log_datetime,
            shift: shiftFor(item.profile),
          });
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

    // The identity of a punch, matching the unique index (direction is derived).
    const keyOfInsert = r => `${r.employee_code}|${new Date(r.log_datetime).getTime()}|${r.device_sn || ''}`;

    // ---- 3b. Maintain the biometric roster (device_enrolments).
    // One row per person the reader knows, upserted from the punches that
    // actually landed (replays insert nothing, so they add nothing here). The
    // roster is what the admin binds against, and keeping it in its own table
    // is what lets it survive an attendance wipe. It must never break a punch,
    // so its failure is swallowed - a missing roster row is a lesser problem
    // than a 500 that makes the reader retry the whole export.
    try {
      const metaFor = new Map(rows.map(r => [keyOfInsert(r.insert), r]));
      const byEnroll = new Map();
      for (const ins of inserted) {
        const meta = metaFor.get(keyOfInsert(ins));
        const t = new Date(ins.log_datetime).getTime();
        const cur = byEnroll.get(ins.employee_code) || {
          enroll_no: ins.employee_code, device_name: null, staff_code: null,
          device_sn: ins.device_sn || null, min: t, max: t, punches: 0,
        };
        cur.punches += 1;
        cur.min = Math.min(cur.min, t);
        cur.max = Math.max(cur.max, t);
        if (ins.employee_name) cur.device_name = ins.employee_name;
        if (meta && meta.staffCode) cur.staff_code = meta.staffCode;
        if (ins.device_sn) cur.device_sn = ins.device_sn;
        byEnroll.set(ins.employee_code, cur);
      }
      if (byEnroll.size) {
        const items = [...byEnroll.values()].map(e => ({
          enroll_no: e.enroll_no, device_name: e.device_name, staff_code: e.staff_code,
          device_sn: e.device_sn, punches: e.punches,
          first_seen: new Date(e.min).toISOString(), last_seen: new Date(e.max).toISOString(),
        }));
        const rr = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_enrolments`, {
          method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        });
        if (!rr.ok) console.error('[attendance] roster upsert failed', (await rr.text()).slice(0, 200));
      }
    } catch (e) { console.error('[attendance] roster upsert threw', String(e && e.message || e)); }

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

        meta.shiftEval = shiftEval;   // reused by the Bitrix line below

        const { subject, html, text } = buildPunchEmail({
          fullName: p.full_name,
          direction: row.direction,
          eventType: row.event_type,
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

    // ---- 5. Bitrix ----
    // One message per GROUP per batch, not per punch. Bitrix allows roughly
    // two requests a second per portal, so a twenty-punch export sent one
    // call at a time would spend ten seconds and blow the function's budget.
    // Batched, the worst case is three calls - one per configured group - and
    // every punch still appears, one line each.
    let bitrixSent = 0, bitrixFailed = 0;
    if (bitrix.isConfigured() && toEmail.length) {
      try {
        const tRes = await fetch(
          `${SUPABASE_URL}/rest/v1/bitrix_targets?select=company,dialog_id,enabled`,
          { headers: H }
        );
        const targets = tRes.ok ? await tRes.json() : [];
        const byCompany = new Map(targets.map(t => [t.company, t]));

        const lines = new Map();   // dialog_id -> [line, ...]
        for (const { row, meta } of toEmail) {
          const t = byCompany.get(meta.profile.company);
          if (!t || !t.enabled || !t.dialog_id) continue;   // unmapped = silent, by design
          if (!lines.has(t.dialog_id)) lines.set(t.dialog_id, []);
          lines.get(t.dialog_id).push(buildPunchChatLine({
            fullName:  meta.profile.full_name,
            eventType: row.event_type,
            direction: row.direction,
            when:      meta.when,
            shift:     meta.shiftEval || null,
            source:    row.source,
          }));
        }

        // dialog -> company, so the log row says which company it was for.
        const companyOf = new Map();
        targets.forEach(t => { if (t.dialog_id && !companyOf.has(t.dialog_id)) companyOf.set(t.dialog_id, t.company); });

        const posts = await Promise.all([...lines.entries()].map(([dialogId, list]) =>
          bitrix.sendAndLog({
            SUPABASE_URL, H, kind: 'punch',
            company: companyOf.get(dialogId), dialogId,
            message: list.join('\n'),
          })
        ));
        posts.forEach(r => { if (r.ok) bitrixSent++; else {
          bitrixFailed++;
          console.error('[attendance] bitrix post failed:', r.reason, r.detail);
        } });
      } catch (e) {
        // A Bitrix problem must never turn a stored punch into a 500 - the
        // vendor would retry the whole export.
        bitrixFailed++;
        console.error('[attendance] bitrix step threw', String(e && e.message || e));
      }
    }

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
      bitrix_sent: bitrixSent,
      bitrix_failed: bitrixFailed,
      auto_linked: autoLinked,
      rejected,
      ms: Date.now() - startedAt,
    });
  } catch (e) {
    console.error('[attendance] error', e);
    return res.status(500).json({ error: 'server error', detail: String(e && e.message || e).slice(0, 300) });
  }
};


// ============================================================
// Selfie punch from a WFH employee's browser.
//
// Trust model: the caller proves who they are with their own Supabase access
// token, and everything that matters is decided server-side — identity from
// the verified token, the timestamp from this server's clock, and the WFH
// eligibility from their profile. The client supplies only the event, the
// photo path and the GPS fix.
// ============================================================

const EVENT_DIRECTION = {
  LOGIN:     'IN',
  BREAK_OUT: 'OUT',   // stepping away
  BREAK_IN:  'IN',    // coming back
  LOGOUT:    'OUT',
};
const EVENT_LABEL = {
  LOGIN: 'Login', LOGOUT: 'Logout', BREAK_OUT: 'Break start', BREAK_IN: 'Break end',
};

// A repeat of the same event inside this window is treated as a double-tap.
const SELFIE_REPEAT_WINDOW_MS = 60 * 1000;

/**
 * Post one message into whichever Bitrix group a company is mapped to.
 * Silent when Bitrix is not configured or the company has no group - both
 * are ordinary states, not errors.
 */
async function postToCompanyGroup({ SUPABASE_URL, H, company, message, kind = 'punch' }) {
  if (!bitrix.isConfigured() || !company || !message) return { ok: false, reason: 'skipped' };
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/bitrix_targets?select=dialog_id,enabled&company=eq.${encodeURIComponent(company)}&limit=1`,
    { headers: H }
  );
  if (!r.ok) return { ok: false, reason: 'targets_unavailable' };
  const t = (await r.json())[0];
  if (!t || !t.enabled || !t.dialog_id) return { ok: false, reason: 'no_group' };
  return bitrix.sendAndLog({ SUPABASE_URL, H, kind, company, dialogId: t.dialog_id, message });
}

// Modes a signed-in employee (Supabase JWT, not the device key) may ask for.
const USER_MODES = new Set(['selfie', 'calendar', 'team_status', 'leave_filed']);

/**
 * Read-only views for a signed-in employee.
 *
 *   calendar     — the caller's OWN month, classified exactly the way the
 *                  admin grid and the pay sheet classify it, because it runs
 *                  through the same buildMonth().
 *   team_status  — who is working / on leave / off today. Names and status
 *                  only: no times, no coordinates, no photos, no salary.
 *                  It needs the service key because leave_requests is RLS'd
 *                  to "your own rows", which is right for the table and wrong
 *                  for a team directory.
 */
async function handleUserView({ res, token, body, SUPABASE_URL, SERVICE_KEY }) {
  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
  const sb = (path) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });

  try {
    const anonKey = process.env.SUPABASE_ANON_KEY || SERVICE_KEY;
    const uRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
    });
    if (!uRes.ok) return res.status(401).json({ error: 'session_expired', detail: 'Your session expired. Refresh the page and sign in again.' });
    const user = await uRes.json();
    const userId = user && user.id;
    if (!userId) return res.status(401).json({ error: 'session_expired' });

    const today = istToday();

    // ---------------- leave_filed ----------------
    // The page files leave straight into Supabase under RLS, which is right -
    // but that means no server ever sees it, and the Bitrix webhook URL is a
    // credential that must not reach a browser. So the page tells us the id
    // of the row it just created and we read it back and announce it. The
    // client is not trusted for any of the content: only for the id, and the
    // row is then checked to belong to the caller.
    if (body.mode === 'leave_filed') {
      const id = String(body.leave_id || '');
      if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'bad_leave_id' });

      const [lRes, tRes, pRes] = await Promise.all([
        sb(`leave_requests?id=eq.${id}&select=*&limit=1`).then(r => r.ok ? r.json() : []),
        sb('leave_types?select=id,name').then(r => r.ok ? r.json() : []),
        sb(`profiles?id=eq.${encodeURIComponent(userId)}&select=full_name,company&limit=1`).then(r => r.ok ? r.json() : []),
      ]);
      const leave = lRes[0];
      // Announce only your own request, and only while it is still pending -
      // so this route can never be replayed to re-announce a decided one.
      if (!leave || leave.user_id !== userId || leave.status !== 'pending') {
        return res.status(200).json({ ok: true, posted: false, reason: 'not_announceable' });
      }
      const profile = pRes[0] || {};
      const typeName = (tRes.find(t => t.id === leave.leave_type_id) || {}).name || 'Leave';
      const out = await postToCompanyGroup({
        SUPABASE_URL, H, company: profile.company,
        kind: 'leave',
        message: buildLeaveChatLine({
          kind: 'filed', fullName: profile.full_name || 'Employee', typeName,
          startDate: leave.start_date, endDate: leave.end_date,
          dayPart: leave.day_part, reason: leave.reason,
        }),
      });
      return res.status(200).json({ ok: true, posted: !!out.ok });
    }

    // ---------------- team_status ----------------
    if (body.mode === 'team_status') {
      const [profiles, shifts, policies, holidays, leaves, types, logs] = await Promise.all([
        sb('profiles?select=id,full_name,email,company,shift_id,is_wfh&limit=2000').then(r => r.ok ? r.json() : []),
        sb('shifts?select=*').then(r => r.ok ? r.json() : []),
        sb('company_policies?select=company,week_offs').then(r => r.ok ? r.json() : []),
        sb(`holidays?select=holiday_date,name,company&holiday_date=eq.${today}`).then(r => r.ok ? r.json() : []),
        sb(`leave_requests?select=user_id,leave_type_id,day_part,start_date,end_date&status=eq.approved&start_date=lte.${today}&end_date=gte.${today}`).then(r => r.ok ? r.json() : []),
        sb('leave_types?select=id,name').then(r => r.ok ? r.json() : []),
        sb(`attendance_logs?select=user_id,log_date,log_datetime,direction,event_type&log_date=eq.${today}&limit=3000`).then(r => r.ok ? r.json() : []),
      ]);

      const shiftById = new Map(shifts.map(s => [s.id, s]));
      const defaultShift = shifts.find(s => s.is_default) || null;
      const typeName = new Map(types.map(t => [t.id, t.name]));
      const leaveBy = new Map(leaves.map(l => [l.user_id, { ...l, type_name: typeName.get(l.leave_type_id) || 'Leave' }]));
      const logsBy = new Map();
      logs.forEach(r => {
        if (!r.user_id) return;
        if (!logsBy.has(r.user_id)) logsBy.set(r.user_id, []);
        logsBy.get(r.user_id).push(r);
      });

      const people = profiles.map(p => {
        const shift = (p.shift_id && shiftById.get(p.shift_id)) || defaultShift || null;
        const day = classifyDay({
          date: today, shift,
          weekOffs: weekOffsFor(p.company, policies),
          holiday: holidayOn(today, holidays, p.company),
          leave: leaveBy.get(p.id) || null,
          punches: logsBy.get(p.id) || [],
          today,
        });
        const meta = DAY_STATUS[day.status] || {};
        return {
          id: p.id,
          email: p.email,
          name: p.full_name || p.email,
          is_wfh: p.is_wfh === true,
          status: day.status,
          label: day.status === 'holiday' ? (day.holidayName || 'Holiday')
               : day.status === 'leave'   ? (day.leaveType || 'On leave')
               : meta.label || day.status,
          icon: meta.icon || '',
          color: meta.color || null,
        };
      });
      return res.status(200).json({ today, people });
    }

    // ---------------- calendar (own month only) ----------------
    const month = /^\d{4}-\d{2}$/.test(String(body.month || '')) ? String(body.month) : today.slice(0, 7);
    const dates = monthDates(month);
    const from = dates[0], to = dates[dates.length - 1];

    const [profileRows, shifts, policies, holidays, leaves, types, logs] = await Promise.all([
      sb(`profiles?select=id,full_name,company,shift_id,is_wfh&id=eq.${encodeURIComponent(userId)}&limit=1`).then(r => r.ok ? r.json() : []),
      sb('shifts?select=*').then(r => r.ok ? r.json() : []),
      sb('company_policies?select=company,week_offs').then(r => r.ok ? r.json() : []),
      sb(`holidays?select=holiday_date,name,company&holiday_date=gte.${from}&holiday_date=lte.${to}`).then(r => r.ok ? r.json() : []),
      // Scoped to this user by id, not merely by RLS — the service key would
      // happily return everyone's.
      sb(`leave_requests?select=user_id,leave_type_id,day_part,start_date,end_date&status=eq.approved&user_id=eq.${encodeURIComponent(userId)}&start_date=lte.${to}&end_date=gte.${from}`).then(r => r.ok ? r.json() : []),
      sb('leave_types?select=id,name').then(r => r.ok ? r.json() : []),
      sb(`attendance_logs?select=user_id,log_date,log_datetime,direction,event_type,source&user_id=eq.${encodeURIComponent(userId)}&log_date=gte.${from}&log_date=lte.${to}&limit=2000`).then(r => r.ok ? r.json() : []),
    ]);

    const profile = profileRows[0] || {};
    const shift = (profile.shift_id && shifts.find(s => s.id === profile.shift_id))
               || shifts.find(s => s.is_default) || null;
    const typeName = new Map(types.map(t => [t.id, t.name]));
    const weekOffs = weekOffsFor(profile.company, policies);

    const mon = buildMonth({
      ym: month, company: profile.company, shift, weekOffs, holidays,
      leaves: leaves.map(l => ({ ...l, type_name: typeName.get(l.leave_type_id) || 'Leave' })),
      punches: logs, today,
    });

    const hhmm = iso => iso ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : null;
    return res.status(200).json({
      month, today,
      legend: DAY_STATUS,
      week_offs: weekOffs,
      shift_name: shift ? shift.name : null,
      totals: mon.totals,
      days: mon.days.map(d => ({
        date: d.date, status: d.status,
        in: hhmm(d.firstIn), out: hhmm(d.lastOut),
        late: d.lateMinutes || 0,
        note: d.holidayName || d.leaveType || null,
      })),
    });
  } catch (e) {
    return res.status(500).json({ error: 'view_failed', detail: String(e && e.message || e).slice(0, 200) });
  }
}

// ---------------------------------------------------------------------------
// Turning a GPS fix into a place a human can read.
//
// Coordinates are the record of truth and are always stored; this is only the
// friendly label beside them. So it is deliberately fail-soft: a slow or
// rate-limited geocoder must never cost somebody their attendance punch.
// Nominatim is free and needs no key, but its usage policy requires a real
// identifying User-Agent, and it will throttle abuse.
//
// Note on what GPS can and cannot tell you: this yields street, area, city and
// postcode. A room number, a floor, or which gate to unload at is not derivable
// from coordinates by any service — that has to be entered by a person.
// ---------------------------------------------------------------------------
const GEOCODE_TIMEOUT_MS = 2500;

function formatAddress(j) {
  const a = (j && j.address) || {};
  const parts = [
    [a.house_number, a.road].filter(Boolean).join(' '),
    a.neighbourhood || a.suburb || a.city_district,
    a.city || a.town || a.village || a.county,
    a.postcode,
  ].filter(Boolean);
  // The same name often arrives twice (suburb == city_district, say).
  const seen = new Set();
  const out = parts.filter(x => {
    const k = String(x).trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const s = out.join(', ');
  if (s) return s.slice(0, 300);
  return j && j.display_name ? String(j.display_name).slice(0, 300) : null;
}

async function reverseGeocode(lat, lng) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1` +
      `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`,
      {
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'WorkSuite-Attendance/1.0 (internal HR tool; contact corpgroup.na001@gmail.com)',
          'Accept-Language': 'en',
        },
      }
    );
    if (!r.ok) return null;
    return formatAddress(await r.json());
  } catch {
    return null;   // timeout, throttle, DNS, anything: the punch still saves
  } finally {
    clearTimeout(timer);
  }
}

async function handleSelfiePunch({ res, token, body, SUPABASE_URL, SERVICE_KEY, startedAt }) {
  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };

  try {
    // ---- 1. Who is this, really? Ask Supabase, don't trust the payload ----
    const anonKey = process.env.SUPABASE_ANON_KEY || SERVICE_KEY;
    const uRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
    });
    if (!uRes.ok) return res.status(401).json({ error: 'session_expired', detail: 'Your session expired. Refresh the page and sign in again.' });
    const user = await uRes.json();
    const userId = user && user.id;
    if (!userId) return res.status(401).json({ error: 'session_expired', detail: 'Could not confirm who you are. Sign in again.' });

    // ---- 2. Validate what the client did supply ----
    const eventType = String(body.event_type || '').toUpperCase();
    if (!EVENT_DIRECTION[eventType]) {
      return res.status(400).json({ error: 'bad_event', detail: 'Unknown punch type.' });
    }

    // Number(null) and Number('') are both 0, which would quietly accept a
    // missing fix as the coordinates of Null Island. Reject blanks first.
    const blank = v => v === null || v === undefined || v === '';
    const lat = blank(body.latitude) ? NaN : Number(body.latitude);
    const lng = blank(body.longitude) ? NaN : Number(body.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({
        error: 'location_required',
        detail: 'Location is required. Allow location access and try again.',
      });
    }

    const selfiePath = String(body.selfie_path || '');
    // The storage policy already confines uploads to the user's own folder;
    // re-check here so a row can never point at somebody else's photo.
    if (!selfiePath || !selfiePath.startsWith(`${userId}/`)) {
      return res.status(400).json({ error: 'bad_selfie_path', detail: 'Selfie upload missing or not yours.' });
    }

    // ---- 3. Eligibility ----
    const pRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}` +
      `&select=id,email,full_name,company,employee_code,shift_id,is_wfh&limit=1`,
      { headers: H }
    );
    if (!pRes.ok) return res.status(502).json({ error: 'profile fetch failed' });
    const profile = (await pRes.json())[0];
    if (!profile) return res.status(404).json({ error: 'no_profile', detail: 'No profile found for your account.' });
    if (profile.is_wfh !== true) {
      return res.status(403).json({ error: 'not_wfh', detail: 'Selfie attendance is for work-from-home employees. Use the biometric reader.' });
    }

    // ---- 4. Server clock, not the client's ----
    const when = new Date();
    const t = istParts(when);

    const sinceIso = new Date(when.getTime() - SELFIE_REPEAT_WINDOW_MS).toISOString();
    const dupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/attendance_logs?user_id=eq.${encodeURIComponent(userId)}` +
      `&event_type=eq.${eventType}&log_datetime=gte.${encodeURIComponent(sinceIso)}&select=id&limit=1`,
      { headers: H }
    );
    if (dupRes.ok && (await dupRes.json()).length) {
      return res.status(429).json({ error: 'too_soon', detail: `You already recorded ${EVENT_LABEL[eventType]} moments ago.` });
    }

    let priorToday = 0;
    try {
      const cRes = await fetch(
        `${SUPABASE_URL}/rest/v1/attendance_logs?user_id=eq.${encodeURIComponent(userId)}` +
        `&log_date=eq.${t.isoDate}&select=id&limit=200`,
        { headers: H }
      );
      if (cRes.ok) priorToday = (await cRes.json()).length;
    } catch { /* worst case we omit the shift note */ }

    // ---- 5. Store ----
    // The client sends its own lookup for the photo stamp; we do our own here
    // so the stored address comes from the server, not from whatever a browser
    // chose to post.
    const locationAddress = await reverseGeocode(lat, lng);

    const insertRow = {
      user_id:       userId,
      employee_code: profile.employee_code || null,
      employee_name: profile.full_name || null,
      direction:     EVENT_DIRECTION[eventType],
      log_datetime:  when.toISOString(),
      log_date:      t.isoDate,
      log_time:      t.isoTime,
      device_sn:     '',
      device_name:   'WFH selfie',
      source:        'selfie',
      event_type:    eventType,
      selfie_path:   selfiePath,
      latitude:      lat,
      longitude:     lng,
      accuracy_m:    Number.isFinite(Number(body.accuracy_m)) ? Number(body.accuracy_m) : null,
      location_address: locationAddress,
      review_status: 'pending',
      email_status:  'pending',
      email_to:      profile.email || null,
      raw:           {
        mode: 'selfie', event_type: eventType, latitude: lat, longitude: lng,
        accuracy_m: body.accuracy_m ?? null,
        // Quality signals the client measured on the frame it actually sent.
        brightness: body.brightness ?? null,
        face_detected: body.face_detected ?? null,
        face_method: body.face_method ?? null,
      },
    };

    const insRes = await fetch(`${SUPABASE_URL}/rest/v1/attendance_logs`, {
      method: 'POST',
      headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify([insertRow]),
    });
    if (!insRes.ok) {
      const detail = (await insRes.text()).slice(0, 300);
      if (/duplicate key|unique/i.test(detail)) {
        return res.status(429).json({ error: 'too_soon', detail: 'That punch is already recorded.' });
      }
      console.error('[selfie] insert failed', detail);
      return res.status(502).json({ error: 'insert_failed', detail: 'Could not save the punch. Try again.' });
    }
    const row = (await insRes.json())[0];

    // ---- 6. Notify, using the same rules as a device punch ----
    let shiftEval = null;
    try {
      const shRes = await fetch(`${SUPABASE_URL}/rest/v1/shifts?select=*`, { headers: H });
      if (shRes.ok) {
        const list = await shRes.json();
        const shift = list.find(x => x.id === profile.shift_id) || list.find(x => x.is_default) || null;
        if (shift) {
          const st = timeToMinutes(shift.start_time), en = timeToMinutes(shift.end_time);
          const span = (((en - st) % 1440) + 1440) % 1440 || 1440;
          const mid  = (st + Math.floor(span / 2)) % 1440;
          const past = offsetFromBoundary(timeToMinutes(t.isoTime), mid) >= 0;
          shiftEval = evaluateShift({
            shift,
            firstIn: (eventType === 'LOGIN' && priorToday === 0) ? when : null,
            lastOut: (eventType === 'LOGOUT' && past)            ? when : null,
            date: when,
          });
        }
      }
    } catch { /* email still goes out, just without the shift note */ }

    let emailed = false, emailError = null;
    if (profile.email) {
      const { subject, html, text } = buildPunchEmail({
        fullName: profile.full_name,
        direction: insertRow.direction,
        eventType,                       // the selfie path KNOWS the event -
        when,                            // it was never a guess here
        deviceName: `WFH selfie · ${EVENT_LABEL[eventType]}`,
        employeeCode: profile.employee_code,
        shift: shiftEval,
      });
      const result = await sendMail({ company: profile.company, to: profile.email, subject, html, text });
      emailed = result.ok;
      if (!result.ok) emailError = `${result.reason}: ${result.detail}`.slice(0, 400);
    }

    await fetch(`${SUPABASE_URL}/rest/v1/attendance_logs?id=eq.${row.id}`, {
      method: 'PATCH',
      headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({
        email_status: emailed ? 'sent' : 'failed',
        emailed_at:   emailed ? new Date().toISOString() : null,
        email_error:  emailed ? null : emailError,
      }),
    }).catch(() => {});

    // Same group post as a biometric punch - a WFH selfie is a punch. Awaited
    // but never allowed to fail the request: the photo is already stored.
    try {
      await postToCompanyGroup({ SUPABASE_URL, H, company: profile.company, message:
        buildPunchChatLine({
          fullName: profile.full_name, eventType, direction: insertRow.direction,
          when, shift: shiftEval, source: 'selfie',
        }) });
    } catch (e) { console.error('[selfie] bitrix', String(e && e.message || e)); }

    return res.status(200).json({
      success: true,
      id: row.id,
      event: eventType,
      label: EVENT_LABEL[eventType],
      direction: insertRow.direction,
      at: t.prettyTime,
      date: t.prettyDate,
      emailed,
      late_minutes: shiftEval && shiftEval.isLate ? shiftEval.lateMinutes : null,
      ms: Date.now() - startedAt,
    });
  } catch (e) {
    console.error('[selfie] error', e);
    return res.status(500).json({ error: 'server_error', detail: 'Something went wrong saving the punch.' });
  }
}
