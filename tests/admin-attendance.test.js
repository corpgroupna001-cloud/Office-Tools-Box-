// The admin console's attendance actions (api/admin.js, att_*): the recompute
// that relabels stored punches, the daily report, the notification resend and
// the scheduled job's status - all read against the rules in lib/attendance,
// so the admin sees the same day the calendar, Bitrix and the pay sheet do.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const attendance = require('../lib/attendance');
const sessions = require('../lib/admin-session');

const source = fs.readFileSync(path.join(__dirname, '../api/admin.js'), 'utf8');
const env = { ADMIN_PASSWORD: 'pw', SUPABASE_URL: 'https://db.example.test', SUPABASE_SERVICE_ROLE_KEY: 'k', BIOMETRIC_API_KEY: 'device-key' };
const COMPANY = 'Protathlitis Sportsmart LLP';     // no company default shift: only the assigned one counts
const ALL_WEEK = [1, 2, 3, 4, 5, 6, 7];
const DAY = { id: 1, name: 'Day', start_time: '09:30', end_time: '18:30', working_days: ALL_WEEK, grace_minutes: 10, early_out_grace_minutes: 0, is_default: true };
const NIGHT = { id: 2, name: 'Night', start_time: '18:00', end_time: '03:00', working_days: ALL_WEEK, grace_minutes: 10, early_out_grace_minutes: 0 };
const person = (id, shift, extra = {}) => ({ id, full_name: `Person ${id}`, email: `${id}@example.test`, company: COMPANY,
  employee_code: `code-${id}`, shift_id: shift ? shift.id : null, ...extra });

/**
 * api/admin.js in a sandbox with a stand-in Supabase. Tables are arrays; the
 * PostgREST filters the actions use (eq, gte, lte, in, is.null) are applied,
 * limit / offset page the result, and every request is recorded. `maxRows`
 * is Supabase's per-request cap (max_rows, 1,000 by default): a read gets at
 * most that many rows whatever its limit asks for.
 */
function harness({ now = '2026-09-10T12:00:00+05:30', db = {}, env: envOverride, webhook, mailer, maxRows = Infinity } = {}) {
  let clock = Date.parse(now);
  const calls = [], mails = [], timeouts = [];
  const tables = { profiles: [], shifts: [DAY, NIGHT], attendance_logs: [], holidays: [], leave_requests: [], leave_types: [], ...db };
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
  const matches = (row, params) => params.every(([k, v]) => {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) return true;
    if (v === 'is.null') return row[k] == null;
    if (v === 'not.is.null') return row[k] != null;
    if (v.startsWith('eq.')) return String(row[k]) === v.slice(3);
    if (v.startsWith('gte.')) return k.endsWith('datetime') ? Date.parse(row[k]) >= Date.parse(v.slice(4)) : String(row[k]) >= v.slice(4);
    if (v.startsWith('lte.')) return k.endsWith('datetime') ? Date.parse(row[k]) <= Date.parse(v.slice(4)) : String(row[k]) <= v.slice(4);
    if (v.startsWith('in.(')) return v.slice(4, -1).split(',').includes(String(row[k]));
    return true;
  });
  const fetch = async (raw, init = {}) => {
    const url = new URL(raw), method = init.method || 'GET';
    calls.push({ url: raw, method, headers: init.headers || {}, body: init.body || null });
    if (url.hostname !== 'db.example.test') {
      if (!webhook) throw new Error('unexpected ' + raw);
      return webhook(url, init);
    }
    const table = url.pathname.replace('/rest/v1/', '');
    if (table.startsWith('rpc/')) {
      const fn = tables[table];
      return fn ? reply(fn) : reply({ code: 'PGRST202', message: 'Could not find the function' }, 404);
    }
    const rows = tables[table];
    if (!rows) return reply({ code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` }, 404);
    const params = [...url.searchParams];
    if (method === 'GET') {
      const found = rows.filter(r => matches(r, params));
      if (table === 'attendance_logs') {
        found.sort((a, b) => Date.parse(a.log_datetime) - Date.parse(b.log_datetime) || String(a.id).localeCompare(String(b.id)));
      }
      const offset = Number(url.searchParams.get('offset')) || 0;
      const limit = Math.min(Number(url.searchParams.get('limit')) || found.length, maxRows);
      return reply(found.slice(offset, offset + limit));
    }
    if (method === 'PATCH') {
      const hit = rows.filter(r => matches(r, params));
      hit.forEach(r => Object.assign(r, JSON.parse(init.body)));
      return reply(hit);
    }
    throw new Error(`${method} ${table}`);
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, console, URL, setTimeout: cb => cb(), fetch, Map, Set,
    // Real signals; the wait each one was made with is recorded.
    AbortSignal: { timeout: ms => { timeouts.push(ms); return AbortSignal.timeout(ms); } },
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } },
    process: { env: envOverride || env },
    require(name) {
      if (name === '../company-config') return require('../company-config');
      if (name === '../lib/attendance') return attendance;
      if (name === '../lib/admin-session') return sessions;
      if (name === '../lib/admin-audit') return { auditWrap: r => r };
      if (name === '../lib/mailer') return mailer || { async sendMail(m) { mails.push(m); return { ok: true }; } };
      return {};
    },
  }, { filename: 'admin.js' });
  return {
    tables, calls, mails, timeouts,
    at(iso) { clock = Date.parse(iso); },
    async call(body, headers = {}) {
      // Through JSON, as the browser gets it (and out of the sandbox's realm).
      const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
        status(c) { this.code = c; return this; }, json(b) { this.body = JSON.parse(JSON.stringify(b)); return this; } };
      await module.exports({ method: 'POST', headers: { host: 'work-suite.example.test', ...headers },
                             body: { password: env.ADMIN_PASSWORD, ...body } }, res);
      return res;
    },
  };
}

/** Punches labelled by the lib itself - what ingest stores. */
function stored(rows, shift) {
  const list = attendance.assignDays(rows, shift === undefined ? {} : { shiftFor: () => shift });
  return list.map(({ priors, day_started_at, duplicate, missing_login, ...r }) => r);
}
const punchAt = (id, iso, extra = {}) => ({ id, log_datetime: iso, direction: 'UNKNOWN', direction_derived: false, source: 'biometric', ...extra });

/* ============================ Recompute ============================ */

test('a night shift recomputed from the middle of the week keeps every label', async () => {
  // Six punches a night, 18:00-03:00, including breaks after midnight: the
  // part of each night that falls on the next date is what used to arrive
  // without its login when the read started at the first date's midnight.
  const rows = [];
  let n = 0;
  for (const date of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12']) {
    const next = attendance.addDaysIso(date, 1);
    for (const iso of [`${date}T18:01`, `${date}T22:15`, `${date}T22:45`, `${next}T00:40`, `${next}T01:10`, `${next}T03:04`]) {
      rows.push(punchAt(`n${++n}`, `${iso}:00+05:30`, { user_id: 'night', employee_code: 'code-night' }));
    }
  }
  const logs = stored(rows, NIGHT);
  assert.deepEqual(logs.filter(l => l.log_date === '2026-09-10').map(l => l.event_type),
    ['LOGIN', 'BREAK_OUT', 'BREAK_IN', 'BREAK_OUT', 'BREAK_IN', 'LOGOUT'], 'the stored night is one day');

  // Read from midnight only, the 00:40 break-out is the first punch there is.
  const inRange = logs.filter(l => l.log_datetime >= '2026-09-10T00:00' && l.log_datetime < '2026-09-12T00:00');
  const narrow = attendance.assignDays(inRange, { shiftFor: () => NIGHT });
  assert.ok(narrow.some((m, i) => m.event_type !== inRange[i].event_type), 'without the context the night is relabelled');

  const h = harness({ db: { profiles: [person('night', NIGHT)], attendance_logs: logs.map(l => ({ ...l })) } });
  const res = await h.call({ action: 'att_recompute', from: '2026-09-10', to: '2026-09-11' });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.changes, 0, JSON.stringify(res.body.sample));
  assert.equal(res.body.scanned, inRange.length, 'only the range asked for is judged');
  assert.ok(res.body.context > 0, 'the nights either side were read as context');

  const read = h.calls.find(c => c.url.includes('/attendance_logs?'));
  const u = new URL(read.url);
  assert.deepEqual(u.searchParams.getAll('log_datetime'),
    [`gte.${new Date(Date.parse('2026-09-10T00:00:00+05:30') - 36 * 3600e3).toISOString()}`,
     `lte.${new Date(Date.parse('2026-09-11T23:59:59+05:30') + 36 * 3600e3).toISOString()}`]);

  const applied = await h.call({ action: 'att_recompute', from: '2026-09-10', to: '2026-09-11', apply: true });
  assert.equal(applied.body.patched, 0);
  assert.equal(h.calls.filter(c => c.method === 'PATCH').length, 0, 'nothing is rewritten');
});

test('recompute reports and patches only rows inside the range', async () => {
  const logs = stored([
    punchAt('a1', '2026-09-09T18:02:00+05:30', { user_id: 'night', employee_code: 'code-night' }),
    punchAt('a2', '2026-09-10T03:03:00+05:30', { user_id: 'night', employee_code: 'code-night' }),
  ], NIGHT).map(l => ({ ...l, event_type: 'BREAK_IN' }));          // both stored wrong
  const h = harness({ db: { profiles: [person('night', NIGHT)], attendance_logs: logs } });
  const res = await h.call({ action: 'att_recompute', from: '2026-09-10', to: '2026-09-10', apply: true });
  assert.deepEqual(res.body.sample.map(c => [c.id, c.after.event_type]), [['a2', 'LOGOUT']]);
  assert.equal(res.body.patched, 1);
  assert.equal(h.tables.attendance_logs.find(l => l.id === 'a1').event_type, 'BREAK_IN', 'the evening before is context only');
});

test('a code nobody holds is judged by the gap between punches, not the default shift', async () => {
  const rows = ['09:30', '13:00', '18:40'].map((t, i) => punchAt(`u${i}`, `2026-09-10T${t}:00+05:30`, { user_id: null, employee_code: '00000099' }));
  const logs = stored(rows);                                        // no shift: what ingest does for an unmapped code
  assert.deepEqual(logs.map(l => l.event_type), ['LOGIN', 'BREAK_OUT', 'BREAK_IN']);
  assert.notDeepEqual(stored(rows, DAY).map(l => l.event_type), logs.map(l => l.event_type),
    'the default shift would read 18:40 as the logout');

  const h = harness({ db: { attendance_logs: logs } });
  const res = await h.call({ action: 'att_recompute', from: '2026-09-10', to: '2026-09-10' });
  assert.equal(res.body.changes, 0, JSON.stringify(res.body.sample));
});

/** `people` on the day shift, four punches a day over `dates`, every label stored wrong (as after a rules change). */
function staleMonth(people, dates, { lastDayPunches = ['09:31'] } = {}) {
  const profiles = [], logs = [];
  let n = 0;
  for (let i = 0; i < people; i++) {
    const p = person(`p${i}`, DAY);
    profiles.push(p);
    const raw = [];
    dates.forEach((date, d) => {
      for (const t of (d === dates.length - 1 ? lastDayPunches : ['09:31', '13:00', '13:40', '18:35'])) {
        raw.push(punchAt(`r${String(++n).padStart(6, '0')}`, `${date}T${t}:00+05:30`, { user_id: p.id, employee_code: p.employee_code }));
      }
    });
    logs.push(...stored(raw, DAY).map(l => ({ ...l, event_type: 'BREAK_IN', right: l.event_type })));
  }
  return { profiles, logs };
}
const datesFrom = (first, count) => Array.from({ length: count }, (_, i) => attendance.addDaysIso(first, i));

test('recompute reads every page under Supabase\'s 1,000-row cap, so Check / Apply reaches the recent days', async () => {
  // 24 people x 4 punches x 17 days: about 1,650 rows with the context, and
  // Supabase answers 1,000 a request. The old single read judged only the
  // oldest 1,000 and then said "All ... punches already follow the current rules".
  const { profiles, logs } = staleMonth(24, datesFrom('2026-09-02', 17));
  const h = harness({ now: '2026-09-18T12:00:00+05:30', maxRows: 1000, db: { profiles, attendance_logs: logs } });
  const from = '2026-09-04', to = '2026-09-18';

  // SETUP.md's loop: Check, Apply, Check again until nothing is left.
  let check;
  for (let round = 0; round < 20; round++) {
    check = (await h.call({ action: 'att_recompute', from, to })).body;
    assert.equal(check.truncated, false, 'the whole range fits in one pass');
    assert.equal(check.judged_to, null);
    if (!check.changes) break;
    const applied = (await h.call({ action: 'att_recompute', from, to, apply: true })).body;
    assert.ok(applied.patched > 0 && !applied.failed, JSON.stringify(applied));
  }
  assert.equal(check.changes, 0);

  const inRange = h.tables.attendance_logs.filter(l =>
    Date.parse(l.log_datetime) >= Date.parse(`${from}T00:00:00+05:30`) && Date.parse(l.log_datetime) <= Date.parse(`${to}T23:59:59+05:30`));
  assert.equal(check.scanned, inRange.length, 'every punch in the range was judged');
  const wrong = inRange.filter(l => l.event_type !== l.right);
  assert.deepEqual(wrong.map(l => `${l.id} ${l.log_date}`), [], 'no punch is left with the old label');
  for (const date of ['2026-09-13', '2026-09-17', '2026-09-18']) {
    assert.ok(inRange.some(l => l.log_date === date), `${date} is in the data`);
  }

  // Page by page, in a stable order.
  const reads = h.calls.filter(c => c.method === 'GET' && c.url.includes('/attendance_logs?')).slice(0, 3).map(c => new URL(c.url).searchParams);
  assert.deepEqual(reads.map(q => [q.get('limit'), q.get('offset')]), [['1000', '0'], ['1000', '1000'], ['1000', '0']]);
  assert.equal(reads[0].get('order'), 'log_datetime.asc,id.asc');
});

test('a pass over the 20,000-row cap says how far it judged, and never touches what it did not', async () => {
  // 100 people x 4 punches x 55 days = 22,000 rows.
  const dates = datesFrom('2026-07-26', 55);
  const { profiles, logs } = staleMonth(100, dates, { lastDayPunches: ['09:31', '13:00', '13:40', '18:35'] });
  const h = harness({ now: '2026-09-19T12:00:00+05:30', maxRows: 1000, db: { profiles, attendance_logs: logs } });
  const from = '2026-07-27', to = '2026-09-18';

  const res = (await h.call({ action: 'att_recompute', from, to })).body;
  assert.equal(res.truncated, true);
  const judgedTo = Date.parse(res.judged_to);
  assert.ok(judgedTo < Date.parse(`${to}T23:59:59+05:30`), res.judged_to);
  const read = h.calls.filter(c => c.url.includes('/attendance_logs?'));
  assert.equal(read.length, 20, 'twenty pages of 1,000, then it stops');
  // The newest row read is followed by up to 36 h it could not see, so the
  // judging stops 36 h before it.
  const newestRead = logs.slice().sort((a, b) => Date.parse(a.log_datetime) - Date.parse(b.log_datetime) || a.id.localeCompare(b.id))
    .filter(l => Date.parse(l.log_datetime) >= Date.parse(`${from}T00:00:00+05:30`) - 36 * 3600e3)[19999];
  assert.equal(judgedTo, Date.parse(newestRead.log_datetime) - 36 * 3600e3);
  assert.equal(res.scanned, logs.filter(l => Date.parse(l.log_datetime) >= Date.parse(`${from}T00:00:00+05:30`)
    && Date.parse(l.log_datetime) <= judgedTo).length);
  assert.ok(res.sample.every(c => Date.parse(c.log_datetime) <= judgedTo));
});

test('recompute leaves the job\'s Logout at a break nobody came back from', async () => {
  // 09:35 in, 13:00 out on a break, never back. The job closed the day at that
  // break and relabelled it LOGOUT; the rules alone, until the next day
  // starts, still read it as a break.
  const D = '2026-09-10';
  const rows = [
    { id: 'b1', user_id: 'onbreak', employee_code: 'code-onbreak', log_datetime: `${D}T09:35:00+05:30`, log_date: D, direction: 'IN', direction_derived: true, event_type: 'LOGIN', source: 'biometric' },
    { id: 'b2', user_id: 'onbreak', employee_code: 'code-onbreak', log_datetime: `${D}T13:00:00+05:30`, log_date: D, direction: 'OUT', direction_derived: true, event_type: 'LOGOUT', source: 'biometric' },
  ];
  const auto = [{ user_id: 'onbreak', log_date: D, kind: 'break_not_returned', logout_at: '2026-09-10T07:30:00+00:00', company: COMPANY }];

  const without = harness({ now: `${D}T19:40:00+05:30`, db: { profiles: [person('onbreak', DAY)], attendance_logs: rows.map(r => ({ ...r })) } });
  const before = (await without.call({ action: 'att_recompute', from: D, to: D })).body;
  assert.deepEqual(before.sample.map(c => [c.id, c.after.event_type]), [['b2', 'BREAK_OUT']], 'the rules alone would undo it');

  const h = harness({ now: `${D}T19:40:00+05:30`, db: { profiles: [person('onbreak', DAY)], attendance_logs: rows.map(r => ({ ...r })),
                                                     attendance_auto_logouts: auto } });
  const res = (await h.call({ action: 'att_recompute', from: D, to: D, apply: true })).body;
  assert.equal(res.changes, 0, JSON.stringify(res.sample));
  assert.equal(h.tables.attendance_logs.find(r => r.id === 'b2').event_type, 'LOGOUT');

  // They did come back after all (a punch the reader held back): it was a break.
  const back = harness({ now: `${D}T19:40:00+05:30`, db: { profiles: [person('onbreak', DAY)], attendance_logs: rows.map(r => ({ ...r })).concat(
    { id: 'b3', user_id: 'onbreak', employee_code: 'code-onbreak', log_datetime: `${D}T13:45:00+05:30`, log_date: D, direction: 'IN', direction_derived: true, event_type: 'BREAK_IN', source: 'biometric' }),
    attendance_auto_logouts: auto } });
  const after = (await back.call({ action: 'att_recompute', from: D, to: D })).body;
  assert.deepEqual(after.sample.map(c => [c.id, c.after.event_type]), [['b2', 'BREAK_OUT']]);
});

/* ============================ Daily report ============================ */

const labelled = (id, userId, iso, direction, event_type, extra = {}) => ({
  id, user_id: userId, employee_code: `code-${userId}`, log_datetime: iso, log_date: iso.slice(0, 10),
  direction, event_type, source: 'biometric', email_status: 'sent', ...extra });

test('the daily report shows the Out the calendar and the pay sheet count', async () => {
  const D = '2026-09-10';
  const db = {
    profiles: [person('open', DAY), person('lunch', DAY), person('onbreak', DAY), person('nologin', DAY), person('night', NIGHT)],
    attendance_logs: [
      labelled('o1', 'open', `${D}T09:31:00+05:30`, 'IN', 'LOGIN'),
      labelled('l1', 'lunch', `${D}T09:31:00+05:30`, 'IN', 'LOGIN'),
      labelled('l2', 'lunch', `${D}T13:00:00+05:30`, 'OUT', 'BREAK_OUT'),
      labelled('l3', 'lunch', `${D}T13:40:00+05:30`, 'IN', 'BREAK_IN'),
      labelled('b1', 'onbreak', `${D}T09:35:00+05:30`, 'IN', 'LOGIN'),
      labelled('b2', 'onbreak', `${D}T13:00:00+05:30`, 'OUT', 'BREAK_OUT'),
      labelled('m1', 'nologin', `${D}T18:32:00+05:30`, 'OUT', 'LOGOUT'),
      labelled('n1', 'night', `${D}T18:02:00+05:30`, 'IN', 'LOGIN'),
      labelled('n2', 'night', '2026-09-11T03:05:00+05:30', 'OUT', 'LOGOUT', { log_date: D }),
    ],
  };

  // Mid-afternoon: nobody's shift is over.
  const h = harness({ now: `${D}T14:00:00+05:30`, db });
  let res = await h.call({ action: 'att_daily_report', date: D });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  let row = id => res.body.rows.find(r => r.user_id === id);

  assert.deepEqual([row('open').last_out, row('open').on_clock, row('open').status], [null, true, 'No check-out'], 'logged in, shift on: on the clock');
  assert.equal(row('lunch').last_out, null, 'a break with a return after it is not the Out');
  assert.equal(row('lunch').is_early_out, false);
  assert.equal(row('lunch').on_clock, true);
  assert.deepEqual([row('onbreak').last_out_time, row('onbreak').on_break, row('onbreak').is_early_out], ['1:00 PM', true, false],
    'on a break right now: not an early Out');

  // Evening: the day shift has ended.
  h.at(`${D}T19:00:00+05:30`);
  res = await h.call({ action: 'att_daily_report', date: D });
  row = id => res.body.rows.find(r => r.user_id === id);
  assert.deepEqual([row('open').last_out_time, row('open').auto_logout, row('open').status, row('open').is_early_out],
    ['6:30 PM', true, 'Present', false], 'nobody punched out: the shift end is the Out');
  assert.equal(row('open').duration, '8h 59m');
  assert.deepEqual([row('lunch').last_out_time, row('lunch').auto_logout], ['6:30 PM', true]);
  assert.deepEqual([row('onbreak').last_out_time, row('onbreak').auto_logout, row('onbreak').auto_logout_kind, row('onbreak').is_early_out],
    ['1:00 PM', false, 'break_not_returned', true], 'never came back: left at the break, early');
  assert.deepEqual([row('nologin').first_in, row('nologin').missing_login, row('nologin').is_late, row('nologin').last_out_time],
    [null, true, false, '6:32 PM'], 'the logout alone: no In, no hours of late');

  // The night shift is judged against its own window, through 03:05 next morning.
  assert.deepEqual([row('night').first_in_time, row('night').last_out_time, row('night').is_late, row('night').is_early_out, row('night').on_clock],
    ['6:02 PM', '3:05 AM', false, false, false]);
  assert.equal(row('night').duration, '9h 03m');

  const t = res.body.totals;
  assert.equal(t.auto_logout, 2);
  assert.equal(t.no_checkout, 0, 'a day the shift end closed is not No check-out');
  assert.equal(t.present, 5);
  assert.equal(t.missing_login, 1);
});

test('the report reads a dual-shift evening against the second shift', async () => {
  const EVE = { id: 3, name: 'Evening', start_time: '17:00', end_time: '19:00', working_days: ALL_WEEK, grace_minutes: 5, early_out_grace_minutes: 0 };
  const h = harness({ now: '2026-09-10T20:00:00+05:30', db: {
    shifts: [DAY, NIGHT, EVE],
    profiles: [person('dual', DAY, { shift2_id: 3, company2: 'Jobways Point LLP' })],
    attendance_logs: [labelled('d1', 'dual', '2026-09-10T17:02:00+05:30', 'IN', 'LOGIN'),
                      labelled('d2', 'dual', '2026-09-10T19:01:00+05:30', 'OUT', 'LOGOUT')],
  } });
  const r = (await h.call({ action: 'att_daily_report', date: '2026-09-10' })).body.rows[0];
  assert.deepEqual([r.shift_name, r.is_late, r.late_minutes], ['Evening', false, 2], 'late is measured from 17:00, not 09:30');
});

test('for half an hour after the shift end the report keeps people on the clock, as the job and the calendar do', async () => {
  const D = '2026-09-10';
  const h = harness({ now: `${D}T18:45:00+05:30`, db: {
    profiles: [person('open', DAY), person('onbreak', DAY)],
    attendance_logs: [
      labelled('o1', 'open', `${D}T09:31:00+05:30`, 'IN', 'LOGIN'),
      labelled('b1', 'onbreak', `${D}T09:35:00+05:30`, 'IN', 'LOGIN'),
      labelled('b2', 'onbreak', `${D}T18:10:00+05:30`, 'OUT', 'BREAK_OUT'),
    ],
  } });
  let res = await h.call({ action: 'att_daily_report', date: D });
  let row = id => res.body.rows.find(r => r.user_id === id);
  assert.deepEqual([row('open').last_out, row('open').auto_logout, row('open').on_clock, row('open').status],
    [null, false, true, 'No check-out'], '15 minutes past the end: still on the clock, no automatic Out yet');
  assert.deepEqual([row('onbreak').on_break, row('onbreak').auto_logout_kind, row('onbreak').is_early_out], [true, null, false]);
  assert.deepEqual([res.body.totals.on_clock, res.body.totals.auto_logout], [1, 0]);

  h.at(`${D}T19:00:00+05:30`);
  res = await h.call({ action: 'att_daily_report', date: D });
  row = id => res.body.rows.find(r => r.user_id === id);
  assert.deepEqual([row('open').last_out_time, row('open').auto_logout, row('open').on_clock], ['6:30 PM', true, false]);
  assert.deepEqual([row('onbreak').on_break, row('onbreak').auto_logout_kind, row('onbreak').is_early_out], [false, 'break_not_returned', true]);
});

test('after the job has run the report still says who left at a break, and a later punch wins over the job', async () => {
  const D = '2026-09-10';
  const h = harness({ now: `${D}T19:40:00+05:30`, db: {
    profiles: [person('onbreak', DAY), person('late', DAY), person('open', DAY)],
    attendance_logs: [
      labelled('b1', 'onbreak', `${D}T09:35:00+05:30`, 'IN', 'LOGIN'),
      // The job relabelled the break it never came back from.
      labelled('b2', 'onbreak', `${D}T13:00:00+05:30`, 'OUT', 'LOGOUT'),
      labelled('l1', 'late', `${D}T09:31:00+05:30`, 'IN', 'LOGIN'),
      // Stayed on: the job posted at 19:00, the real punch-out came at 19:10.
      labelled('l2', 'late', `${D}T19:10:00+05:30`, 'OUT', 'LOGOUT'),
      labelled('o1', 'open', `${D}T09:31:00+05:30`, 'IN', 'LOGIN'),
    ],
    attendance_auto_logouts: [
      { user_id: 'onbreak', log_date: D, kind: 'break_not_returned', logout_at: '2026-09-10T07:30:00+00:00' },
      { user_id: 'late', log_date: D, kind: 'no_punch_out', logout_at: '2026-09-10T13:00:00+00:00' },
      { user_id: 'open', log_date: D, kind: 'no_punch_out', logout_at: '2026-09-10T13:00:00+00:00' },
    ],
  } });
  const res = await h.call({ action: 'att_daily_report', date: D });
  const row = id => res.body.rows.find(r => r.user_id === id);
  assert.deepEqual([row('onbreak').last_out_time, row('onbreak').auto_logout, row('onbreak').auto_logout_kind, row('onbreak').status],
    ['1:00 PM', false, 'break_not_returned', 'Present'], 'the CSV still reads "Yes (left at break)"');
  assert.deepEqual([row('late').last_out_time, row('late').auto_logout, row('late').auto_logout_kind], ['7:10 PM', false, null],
    'they punched out after the automatic Logout: the punch is the Out');
  assert.deepEqual([row('open').last_out_time, row('open').auto_logout, row('open').auto_logout_kind, row('open').duration],
    ['6:30 PM', true, 'no_punch_out', '8h 59m']);
  assert.ok(h.calls.some(c => c.url.includes('/attendance_auto_logouts?') && c.url.includes(`log_date=eq.${D}`)));
});

test('a repeat tap counts for nothing in the report and in the pay grid', async () => {
  const D = '2026-09-10';
  const repeat = { email_status: 'skipped', email_error: 'Repeat tap of the 18:35 punch' };
  const db = {
    profiles: [person('rep', DAY)],
    attendance_logs: [
      labelled('t1', 'rep', `${D}T09:31:00+05:30`, 'IN', 'LOGIN'),
      labelled('t2', 'rep', `${D}T18:35:00+05:30`, 'OUT', 'LOGOUT'),
      // Stored before repeats copied the punch they repeat: read as a login.
      labelled('t3', 'rep', `${D}T18:36:00+05:30`, 'IN', 'BREAK_IN', repeat),
    ],
  };
  const h = harness({ now: `${D}T21:00:00+05:30`, db });
  const r = (await h.call({ action: 'att_daily_report', date: D })).body.rows[0];
  assert.deepEqual([r.last_out_time, r.status, r.on_clock, r.duration], ['6:35 PM', 'Present', false, '9h 04m']);

  const pay = await h.call({ action: 'pay_list', month: '2026-09' });
  assert.equal(pay.code, 200, JSON.stringify(pay.body));
  assert.deepEqual(pay.body.employees[0].times[D].slice(0, 2), ['09:31', '18:35']);
  const read = h.calls.find(c => c.url.includes('/attendance_logs?') && c.url.includes('log_date=gte.'));
  assert.match(new URL(read.url).searchParams.get('select'), /email_status,email_error/);
});

/* ============================ Resend ============================ */

test('a resent mail carries the event and the shift note', async () => {
  const D = '2026-09-10';
  const h = harness({ db: {
    profiles: [person('p', DAY)],
    attendance_logs: [
      labelled('r1', 'p', `${D}T09:55:00+05:30`, 'IN', 'LOGIN', { email_status: 'failed' }),
      labelled('r2', 'p', `${D}T13:00:00+05:30`, 'OUT', 'BREAK_OUT', { email_status: 'pending' }),
      labelled('r3', 'p', `${D}T13:01:00+05:30`, 'OUT', 'BREAK_OUT', { email_status: 'skipped', email_error: 'Repeat tap of the 13:00 punch' }),
      labelled('r4', 'p', `${D}T17:00:00+05:30`, 'OUT', 'LOGOUT', { email_status: 'failed' }),
      labelled('r5', 'p', `${D}T17:30:00+05:30`, 'IN', null, { email_status: 'failed' }),
    ],
  } });
  const res = await h.call({ action: 'att_resend', date: D });
  assert.deepEqual([res.body.candidates, res.body.sent], [4, 4], 'the repeat tap is not pending, so it is not resent');
  const subjects = h.mails.map(m => m.subject);
  assert.match(subjects[0], /Login at 9:55 AM \(25m late\)/);
  assert.match(subjects[1], /Break out at 1:00 PM —/);
  assert.match(subjects[2], /Logout at 5:00 PM \(1h 30m early\)/);
  assert.match(subjects[3], /Checked In at 5:30 PM —/, 'a row with no event falls back to its direction');

  const byId = await h.call({ action: 'att_resend', id: 'r3' });
  assert.deepEqual([byId.body.sent, byId.body.skipped], [0, 1], 'asked for by id, a repeat tap is still not announced');
});

/* ============================ Scheduler ============================ */

test('scheduler status is fail-soft before the migration', async () => {
  const h = harness();
  const res = await h.call({ action: 'att_scheduler_status' });
  assert.equal(res.code, 200);
  assert.deepEqual([res.body.scheduler, res.body.status, res.body.migration_needed, res.body.auto_logouts, res.body.switch_posts],
    [null, null, true, null, null]);
});

test('scheduler status reports the last run and the day\'s logouts, never the secret', async () => {
  const h = harness({ db: {
    profiles: [person('p', DAY, { employee_id: 'E-1' })],
    worksuite_scheduler: [{ id: 1, secret: 'a'.repeat(64), site_url: 'https://x', last_run_at: '2026-09-10T06:25:00Z', last_job: 'shift_switch',
                            last_ok: true, last_result: { attendance: { auto_logouts: 1, notes: ['retry stopped at the time budget'] } } }],
    'rpc/worksuite_scheduler_status': { job: { jobname: 'worksuite-shift-switch', schedule: '*/5 * * * *', active: true, uses_db_secret: true }, runs: [], http: [], problems: [] },
    attendance_auto_logouts: [{ user_id: 'p', log_date: attendance.istToday(), kind: 'no_punch_out', logout_at: '2026-09-10T13:00:00Z',
                                company: COMPANY, bitrix_ok: false, detail: 'failed: timeout' }],
    shift_switch_posts: [],
  } });
  const res = await h.call({ action: 'att_scheduler_status' });
  assert.equal(res.code, 200);
  assert.equal(JSON.stringify(res.body).includes('a'.repeat(64)), false);
  assert.equal(res.body.scheduler.last_ok, true);
  assert.deepEqual(res.body.scheduler.last_result.attendance.notes, ['retry stopped at the time budget']);
  assert.equal(res.body.status.job.uses_db_secret, true);
  assert.deepEqual([res.body.auto_logouts[0].full_name, res.body.auto_logouts[0].employee_id, res.body.auto_logouts[0].bitrix_ok, res.body.auto_logouts[0].attempts],
    ['Person p', 'E-1', false, null], 'attempts is null until its column exists');
  assert.deepEqual(res.body.switch_posts, []);
});

test('Run now calls the deployed job with the device key', async () => {
  const seen = [];
  const h = harness({ webhook: async (url, init) => {
    seen.push({ url: url.href, auth: init.headers.Authorization, method: init.method });
    return new Response(JSON.stringify({ ok: true, attendance: { auto_logouts: 2 } }), { status: 200 });
  } });
  const res = await h.call({ action: 'att_scheduler_run' }, { 'x-forwarded-proto': 'https' });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.deepEqual(seen, [{ url: 'https://work-suite.example.test/api/attendance-webhook?job=shift_switch&manual=1', auth: 'Bearer device-key', method: 'POST' }]);
  assert.equal(res.body.attendance.auto_logouts, 2);

  await h.call({ action: 'att_scheduler_run' }, { host: 'evil.example/..' });
  assert.equal(seen[1].url, 'https://work-suite-mauve.vercel.app/api/attendance-webhook?job=shift_switch&manual=1', 'an odd Host falls back to production');

  const refused = harness({ env: { ...env, BIOMETRIC_API_KEY: '' } });
  const r = await refused.call({ action: 'att_scheduler_run' });
  assert.equal(r.code, 500);
  assert.match(r.body.error, /BIOMETRIC_API_KEY/);
});

test('the job answering with an error is reported, not swallowed', async () => {
  const h = harness({ webhook: async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }) });
  const res = await h.call({ action: 'att_scheduler_run' });
  assert.equal(res.code, 502);
  assert.match(res.body.error, /401/);
});

test('Run now waits up to 50 s, and a job still going after that is "still running", not a failure', async () => {
  // vercel.json gives api/admin.js 60 s (the default is 10), so the wait fits.
  const config = require('../vercel.json');
  assert.equal(config.functions['api/admin.js'].maxDuration, 60);
  assert.equal(config.functions['api/attendance-webhook.js'].maxDuration, 60);

  const slow = harness({ webhook: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } });
  const res = await slow.call({ action: 'att_scheduler_run' });
  assert.equal(res.code, 202, JSON.stringify(res.body));
  assert.deepEqual(res.body, { running: true, message: 'Still running - check the list below in a minute' });
  assert.deepEqual(slow.timeouts, [50000]);

  const down = harness({ webhook: async () => { throw new TypeError('fetch failed'); } });
  const r = await down.call({ action: 'att_scheduler_run' });
  assert.equal(r.code, 502, 'a job that cannot be reached is still a failure');
});

test('without a session or the password the scheduler actions stay locked', async () => {
  const h = harness();
  const res = { code: 200, headers: {}, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, console, URL, setTimeout: cb => cb(), fetch: async () => { throw new Error('no'); }, AbortSignal, Date,
    process: { env }, require: n => (n === '../company-config' ? require('../company-config') : n === '../lib/attendance' ? attendance
      : n === '../lib/admin-session' ? sessions : n === '../lib/admin-audit' ? { auditWrap: r => r } : {}) });
  await module.exports({ method: 'POST', headers: { host: 'work-suite.example.test' }, body: { action: 'att_scheduler_run' } }, res);
  assert.equal(res.code, 401);
  assert.equal(h.calls.length, 0);
});

/* ============================ Admin page ============================ */

// The page's own attApi and Run-now click handler, cut from wsm-admin/index.html
// and run against a stubbed /api/admin answer.
function runNowPage(answer) {
  const html = fs.readFileSync(path.join(__dirname, '../wsm-admin/index.html'), 'utf8');
  const cut = (from, to) => {
    const a = html.indexOf(from), b = html.indexOf(to, a);
    assert.ok(a >= 0 && b > a, `cannot find ${from}`);
    return html.slice(a, b);
  };
  const handlers = {};
  const context = {
    adminFetch: async () => answer(),
    document: { getElementById: id => ({ addEventListener: (ev, fn) => { handlers[`${id}:${ev}`] = fn; } }) },
    loadAttendance: async () => {},
  };
  vm.runInNewContext('let attSchedulerRan = null, attReport = null;\n' +
    cut('        async function attApi(payload) {', '        async function loadAttendance() {') +
    cut('        // Run the job now (the same call pg_cron makes)', '        // The Out as the calendar and pay sheet count it') +
    'this.ran = () => attSchedulerRan; this.attApi = attApi;', context);
  return {
    attApi: context.attApi,
    async press() {
      const btn = { disabled: false, textContent: '' };
      await handlers['att-scheduler:click']({ target: { closest: () => btn } });
      return context.ran();
    },
  };
}
const jsonAnswer = (body, status = 200) => () => new Response(JSON.stringify(body), { status });

test('Run now shows the job\'s notes and is not green when a step was skipped or failed', async () => {
  const failed = await runNowPage(jsonAnswer({ success: true, attendance: { auto_logouts: 0, retried: 0,
    notes: ['auto logout for <b>Asha</b> failed: 503 upstream'] } })).press();
  assert.equal(failed.tone, 'bad');
  assert.match(failed.text, /Notes: auto logout for <b>Asha<\/b> failed: 503 upstream/, 'the note is there (escaped when shown)');

  const skipped = await runNowPage(jsonAnswer({ success: true, attendance: { auto_logouts: 0,
    notes: ['auto logout skipped: run supabase-attendance-scheduler-migration.sql'] } })).press();
  assert.equal(skipped.tone, 'warn');

  const budget = await runNowPage(jsonAnswer({ success: true, attendance: { auto_logouts: 2, retried: 1, retry_sent: 1,
    notes: ['retry stopped at the time budget'] } })).press();
  assert.equal(budget.tone, 'ok', 'running out of time is only a note');
  assert.match(budget.text, /^Ran just now: 2 automatic logouts · 1 of 1 Bitrix retries sent\. Notes: retry stopped at the time budget$/);

  const errored = await runNowPage(jsonAnswer({ success: true, attendance: { error: 'profiles fetch failed' } })).press();
  assert.equal(errored.tone, 'bad');

  const running = await runNowPage(jsonAnswer({ running: true, message: 'Still running - check the list below in a minute' }, 202)).press();
  assert.deepEqual([running.tone, running.text], ['info', 'Still running - check the list below in a minute']);

  // The banner escapes the line and colours it by tone.
  const html = fs.readFileSync(path.join(__dirname, '../wsm-admin/index.html'), 'utf8');
  assert.match(html, /ATT_RAN_TONE\[attSchedulerRan\.tone\] \|\| ATT_RAN_TONE\.bad\}">\$\{escapeHtml\(attSchedulerRan\.text\)\}/);
});

test('a platform error page reads as what it is, not as a JSON syntax error', async () => {
  const page = runNowPage(() => new Response('An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT\n\nbom1::abc', { status: 504 }));
  await assert.rejects(page.attApi({ action: 'scheduler_run' }),
    { message: 'The server timed out (504): An error occurred with your deployment FUNCTION_INVOCATION_TIMEOUT bom1::abc' });
  const ran = await page.press();
  assert.equal(ran.tone, 'bad');
  assert.match(ran.text, /^Run now failed: The server timed out \(504\)/);

  const gateway = runNowPage(() => new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502 }));
  await assert.rejects(gateway.attApi({ action: 'daily_report' }), { message: 'The server answered (502): 502 Bad Gateway' });

  const refused = runNowPage(jsonAnswer({ error: 'The attendance job answered 401' }, 502));
  await assert.rejects(refused.attApi({ action: 'scheduler_run' }), { message: 'The attendance job answered 401' });
});

test('the recompute card never says "All ... follow the current rules" for a pass that stopped short', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../admin/attendance-tools.js'), 'utf8');
  const run = async answer => {
    const elements = new Map(), handlers = {};
    const el = id => {
      if (!elements.has(id)) elements.set(id, { id, value: '', textContent: '', className: '', innerHTML: '', disabled: false, style: {},
        classList: { toggle() {}, add() {}, remove() {} }, addEventListener: (ev, fn) => { handlers[`${id}:${ev}`] = fn; } });
      return elements.get(id);
    };
    vm.runInNewContext(src, { window: {}, document: { getElementById: el, querySelectorAll: () => [] }, Intl,
      adminFetch: async () => new Response(JSON.stringify(answer), { status: 200 }), adminAuthenticated: true });
    await handlers['recompute-check:click']();
    return el('recompute-result');
  };
  const short = await run({ from: '2026-07-27', to: '2026-09-18', changes: 0, scanned: 18000, people: 100,
                            truncated: true, judged_to: '2026-09-11T11:35:00.000Z', sample: [] });
  assert.doesNotMatch(short.textContent, /All .* follow/);
  assert.match(short.textContent, /^None of the 18000 punches checked would change\. Too many punches for one pass: only those up to 11 Sept? 17:05 were checked/);
  assert.match(short.className, /amber/);

  const whole = await run({ changes: 0, scanned: 120, people: 4, truncated: false, judged_to: null, sample: [] });
  assert.equal(whole.textContent, 'All 120 punches already follow the current rules.');
  assert.match(whole.className, /emerald/);
});

test('recompute for one Biometric ID leaves everyone else alone', async () => {
  // Two people whose stored labels are both out of date (all IN).
  const rows = [];
  for (const who of ['a', 'b']) {
    ['09:31', '13:00', '13:40', '18:35'].forEach((t, i) =>
      rows.push({ ...punchAt(`${who}${i}`, `2026-09-08T${t}:00+05:30`, { user_id: who, employee_code: `code-${who}` }),
                  log_date: '2026-09-08', direction: 'IN', direction_derived: true, event_type: 'LOGIN' }));
  }
  const h = harness({ db: { profiles: [person('a', DAY), person('b', DAY)], attendance_logs: rows } });
  const one = await h.call({ action: 'att_recompute', from: '2026-09-08', to: '2026-09-08', employee_code: 'code-a' });
  assert.equal(one.code, 200, JSON.stringify(one.body));
  assert.deepEqual([one.body.people, one.body.changes], [1, 3]);
  assert.ok(one.body.sample.every(c => c.employee_code === 'code-a'));
  const all = await h.call({ action: 'att_recompute', from: '2026-09-08', to: '2026-09-08' });
  assert.deepEqual([all.body.people, all.body.changes], [2, 6]);
});
