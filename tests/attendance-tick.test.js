// The attendance job (?job=attendance_tick, and the shift-switch call that
// runs it too): punches Bitrix did not take are sent again, and a shift that
// ended with nobody punched out gets its Logout, posted exactly once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const attendance = require('../lib/attendance');

const source = fs.readFileSync(path.join(__dirname, '../api/attendance-webhook.js'), 'utf8');
const COMPANY = 'Nova Sportsmart Private Limited';

const DAY_SHIFT = { id: 1, name: 'Day', start_time: '09:30', end_time: '18:30', working_days: [1, 2, 3, 4, 5, 6], is_default: true };

function harness({ now, logs, profiles, bitrixResult, shifts = [DAY_SHIFT], targets, maxRows = Infinity, scheduler, failClaim, failPage, bitrixDelay = 0 }) {
  let clock = Date.parse(now);
  const db = { attendance_logs: logs, attendance_auto_logouts: [], shift_switch_posts: [],
               worksuite_scheduler: scheduler ? [{ id: 1, ...scheduler }] : [] };
  const posts = [];
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
  const matches = (row, url) => [...url.searchParams].every(([k, v]) => {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'or'].includes(k)) return true;
    if (v === 'not.is.null') return row[k] != null;
    if (v.startsWith('eq.')) return String(row[k]) === v.slice(3);
    if (v.startsWith('lt.')) return /^\d+$/.test(v.slice(3)) ? Number(row[k] || 0) < Number(v.slice(3)) : row[k] != null && new Date(row[k]) < new Date(v.slice(3));
    if (v.startsWith('gte.')) return new Date(row[k]) >= new Date(v.slice(4));
    if (v.startsWith('lte.')) return new Date(row[k]) <= new Date(v.slice(4));
    if (v.startsWith('gt.')) return new Date(row[k]) > new Date(v.slice(3));
    if (v.startsWith('in.(')) return v.slice(4, -1).split(',').includes(String(row[k]));
    return true;
  });
  const orOk = (row, url) => {
    const or = url.searchParams.get('or');
    if (or !== '(bitrix_ok.is.null,bitrix_ok.is.false)') return true;
    return row.bitrix_ok == null || row.bitrix_ok === false;
  };
  const page = (rows, url) => {
    const off = Number(url.searchParams.get('offset') || 0);
    const lim = Math.min(Number(url.searchParams.get('limit') || Infinity), maxRows);
    return rows.slice(off, off + lim);
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, console, setTimeout, Map, Set,
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } },
    process: { env: { SUPABASE_URL: 'https://db.example.test', SUPABASE_SERVICE_ROLE_KEY: 's', BIOMETRIC_API_KEY: 'test-device' } },
    require(name) {
      if (name === '../lib/request-auth') return require('../lib/request-auth');
      if (name === '../company-config') return require('../company-config');
      if (name === 'crypto') return require('crypto');
      if (name === '../lib/attendance') return attendance;
      if (name === '../lib/mailer') return { async sendMail() { return { ok: true }; } };
      if (name === '../lib/bitrix') return {
        isConfigured: () => true, senderFor: ({ enroll }) => ({ base: 'hook', enroll }),
        async sendAndLog(payload) {
          posts.push(payload);
          if (bitrixDelay) await new Promise(r => setTimeout(r, bitrixDelay));
          return typeof bitrixResult === 'function' ? bitrixResult(payload) : (bitrixResult || { ok: true });
        },
        async logAttempt() {},
      };
      throw new Error(name);
    },
    async fetch(raw, init = {}) {
      const url = new URL(raw), table = url.pathname.replace('/rest/v1/', ''), method = init.method || 'GET';
      if (table === 'profiles') return response(profiles.filter(p => matches(p, url)));
      if (table === 'shifts') return response(shifts);
      if (table === 'bitrix_targets') return response(targets || [{ company: COMPANY, enabled: true, dialog_id: 'chat100' }]);
      const rows = db[table];
      if (!rows) throw new Error(`Unexpected ${method} ${table}`);
      if (method === 'GET') {
        if (failPage && failPage(table, Number(url.searchParams.get('offset') || 0))) return response({ message: 'upstream' }, 503);
        return response(page(rows.filter(r => matches(r, url) && orOk(r, url)), url));
      }
      if (method === 'PATCH') {
        const hit = rows.filter(r => matches(r, url));
        hit.forEach(r => Object.assign(r, JSON.parse(init.body)));
        return response(hit, 200);
      }
      if (method === 'POST') {
        if (failClaim && table === 'attendance_auto_logouts' && failClaim()) return response({ message: 'upstream timeout' }, 503);
        const keyOf = b => table === 'shift_switch_posts' ? `${b.user_id}|${b.post_date}` : `${b.user_id}|${b.log_date}`;
        const made = [].concat(JSON.parse(init.body)).filter(b => !rows.some(r => keyOf(r) === keyOf(b)))
          .map(b => ({ attempts: 0, created_at: new Date(clock).toISOString(), ...b }));
        rows.push(...made);
        return response(made, 201);
      }
      throw new Error(method);
    },
  }, { filename: 'attendance-webhook.js' });
  return {
    db, posts,
    at(iso) { clock = Date.parse(iso); },
    async tick(job = 'attendance_tick', key = 'test-device', query = {}) {
      const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
      await module.exports({ method: 'POST', query: { job, ...query }, headers: { authorization: `Bearer ${key}` }, body: {} }, res);
      return res;
    },
  };
}

const person = { id: 'u1', full_name: 'Test Employee', email: 'e@x.test', company: COMPANY, employee_code: '00000008', shift_id: 1 };
const punch = (id, time, direction, event_type, extra = {}) => ({ id, user_id: 'u1', employee_code: '00000008', direction, event_type,
  log_datetime: `2026-09-15T${time}:00+05:30`, log_date: '2026-09-15', source: 'biometric', ...extra });

test('a login with no punch-out is logged out at the shift end, once', async () => {
  const h = harness({ now: '2026-09-15T18:20:00+05:30', profiles: [person], logs: [punch(1, '09:31', 'IN', 'LOGIN')] });
  assert.equal((await h.tick()).body.attendance.auto_logouts, 0, 'the shift is still on');

  h.at('2026-09-15T18:45:00+05:30');
  assert.equal((await h.tick()).body.attendance.auto_logouts, 0, 'half an hour to punch out late');

  h.at('2026-09-15T19:01:00+05:30');
  const res = await h.tick();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.attendance.auto_logouts, 1);
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0].message, /Logout 6:30 PM · shift ended without a punch-out/);
  assert.equal(h.posts[0].kind, 'auto_logout');
  assert.deepEqual([h.db.attendance_auto_logouts[0].kind, h.db.attendance_auto_logouts[0].bitrix_ok], ['no_punch_out', true]);

  h.at('2026-09-15T19:06:00+05:30');
  await h.tick('shift_switch');                          // the scheduler's own call runs it too
  assert.equal(h.posts.length, 1, 'posted exactly once');
});

test('someone who went on a break and never came back left at that break', async () => {
  const h = harness({ now: '2026-09-15T19:00:00+05:30', profiles: [person],
    logs: [punch(1, '09:31', 'IN', 'LOGIN'), punch(2, '15:10', 'OUT', 'BREAK_OUT')] });
  await h.tick();
  assert.match(h.posts[0].message, /Logout 3:10 PM · 3h 20m early · did not return from break by shift end/);
  assert.equal(h.db.attendance_logs[1].event_type, 'LOGOUT');
});

test('a proper logout, or overtime still going on, is left alone', async () => {
  const done = harness({ now: '2026-09-15T19:00:00+05:30', profiles: [person],
    logs: [punch(1, '09:31', 'IN', 'LOGIN'), punch(2, '18:32', 'OUT', 'LOGOUT')] });
  await done.tick();
  assert.equal(done.posts.length, 0);
  const late = harness({ now: '2026-09-15T19:00:00+05:30', profiles: [person],
    logs: [punch(1, '09:31', 'IN', 'LOGIN'), punch(2, '17:00', 'OUT', 'BREAK_OUT'), punch(3, '18:40', 'IN', 'BREAK_IN')] });
  await late.tick();
  assert.equal(late.posts.length, 0, 'back after the end: still working');
});

test('punches Bitrix did not take are sent again, up to four times', async () => {
  const logs = [
    punch(1, '17:00', 'OUT', 'BREAK_OUT', { bitrix_status: 'failed', bitrix_attempts: 0, bitrix_at: '2026-09-15T17:00:05+05:30' }),
    punch(2, '17:05', 'IN', 'BREAK_IN', { bitrix_status: 'deferred', bitrix_attempts: 1, bitrix_at: '2026-09-15T17:05:05+05:30' }),
    punch(3, '17:10', 'OUT', 'BREAK_OUT', { bitrix_status: 'failed', bitrix_attempts: 4, bitrix_at: '2026-09-15T17:10:05+05:30' }),
    punch(4, '17:15', 'IN', 'BREAK_IN', { bitrix_status: 'sent', bitrix_attempts: 1, bitrix_at: '2026-09-15T17:15:05+05:30' }),
  ];
  const h = harness({ now: '2026-09-15T18:00:00+05:30', profiles: [person], logs });
  const res = await h.tick();
  assert.deepEqual([res.body.attendance.retried, res.body.attendance.retry_sent], [2, 2]);
  assert.deepEqual(h.posts.map(p => p.message.match(/· (Break \w+ [\d:]+ [AP]M)/)[1]), ['Break out 5:00 PM', 'Break in 5:05 PM']);
  assert.deepEqual(logs.map(l => [l.bitrix_status, l.bitrix_attempts]), [['sent', 1], ['sent', 2], ['failed', 4], ['sent', 1]]);
});

test('the calendar counts a day nobody closed as ending at the shift end', () => {
  const day = attendance.classifyDay({ date: '2026-09-14', shift: { start_time: '09:30', end_time: '18:30' }, today: '2026-09-15',
    punches: [{ log_datetime: '2026-09-14T09:30:00+05:30', direction: 'IN', event_type: 'LOGIN' }] });
  assert.equal(day.autoLogout, true);
  assert.equal(day.workedMinutes, 540);
  const night = attendance.shiftEndAt('2026-09-14', { start_time: '18:00', end_time: '03:00' });
  assert.equal(night.toISOString(), '2026-09-14T21:30:00.000Z', 'an overnight shift ends the next morning');
});

test('someone who punches out within half an hour of the end gets no automatic logout', async () => {
  const h = harness({ now: '2026-09-15T18:50:00+05:30', profiles: [person], logs: [punch(1, '09:31', 'IN', 'LOGIN')] });
  await h.tick();
  h.db.attendance_logs.push(punch(2, '18:52', 'OUT', 'LOGOUT'));
  h.at('2026-09-15T19:10:00+05:30');
  await h.tick();
  assert.equal(h.posts.length, 0);
});

test('an automatic logout Bitrix did not take is sent again, once it has settled', async () => {
  let calls = 0;
  const h = harness({ now: '2026-09-15T19:01:00+05:30', profiles: [person], logs: [punch(1, '09:31', 'IN', 'LOGIN')],
    bitrixResult: () => (++calls === 1 ? { ok: false, reason: 'timeout', detail: 'aborted' } : { ok: true }) });
  await h.tick();
  assert.deepEqual([h.db.attendance_auto_logouts[0].bitrix_ok, h.posts.length], [false, 1]);
  h.at('2026-09-15T19:02:00+05:30');
  await h.tick();
  assert.equal(h.posts.length, 1, 'not while the first attempt may still be settling');
  h.at('2026-09-15T19:06:00+05:30');
  const res = await h.tick();
  assert.deepEqual([res.body.attendance.auto_retried, res.body.attendance.auto_retry_sent], [1, 1]);
  assert.match(h.posts[1].message, /Logout 6:30 PM · shift ended without a punch-out/);
  assert.deepEqual([h.db.attendance_auto_logouts[0].bitrix_ok, h.db.attendance_auto_logouts[0].attempts], [true, 1]);
  h.at('2026-09-15T19:20:00+05:30');
  await h.tick();
  assert.equal(h.posts.length, 2, 'delivered: never again');
});

test('a failed automatic logout is not sent again after the person punched', async () => {
  const h = harness({ now: '2026-09-15T19:01:00+05:30', profiles: [person], logs: [punch(1, '09:31', 'IN', 'LOGIN')],
    bitrixResult: { ok: false, reason: 'http_503', detail: '' } });
  await h.tick();
  h.db.attendance_logs.push(punch(2, '19:03', 'OUT', 'LOGOUT'));
  h.at('2026-09-15T19:10:00+05:30');
  await h.tick();
  assert.equal(h.posts.length, 1);
  assert.equal(h.db.attendance_auto_logouts[0].attempts, 3);
});

test('more than a thousand punches: everyone is read, so nobody who punched out is logged out automatically', async () => {
  const logs = [];
  const people = [];
  for (let i = 0; i < 300; i++) {
    const id = `p${i}`;
    people.push({ ...person, id, full_name: `Person ${i}`, employee_code: String(1000 + i) });
    const out = i === 299 ? [] : [['18:31', 'OUT', 'LOGOUT']];
    [['09:30', 'IN', 'LOGIN'], ['13:00', 'OUT', 'BREAK_OUT'], ['13:40', 'IN', 'BREAK_IN'], ...out].forEach(([t, d, e], j) =>
      logs.push(punch(`${id}-${j}`, t, d, e, { user_id: id, employee_code: String(1000 + i) })));
  }
  const h = harness({ now: '2026-09-15T19:05:00+05:30', profiles: people, logs, maxRows: 1000 });
  const res = await h.tick();
  assert.equal(res.body.attendance.auto_logouts, 1);
  assert.match(h.posts[0].message, /Person 299/);
});

test('a claim that fails for one person does not stop the others, and is tried again', async () => {
  let n = 0;
  const people = [person, { ...person, id: 'u2', full_name: 'Second Person', employee_code: '00000009' }];
  const logs = [punch(1, '09:31', 'IN', 'LOGIN'), punch(2, '09:40', 'IN', 'LOGIN', { user_id: 'u2', employee_code: '00000009' })];
  const h = harness({ now: '2026-09-15T19:01:00+05:30', profiles: people, logs, failClaim: () => ++n === 1 });
  const res = await h.tick();
  assert.equal(res.body.attendance.auto_logouts, 1);
  assert.match(res.body.attendance.notes.join(' '), /failed: 503/);
  h.at('2026-09-15T19:06:00+05:30');
  await h.tick();
  assert.equal(h.posts.length, 2);
});

test('a night worker on the company default shift is logged out the next morning', async () => {
  const JOBWAYS = 'Jobways Point LLP';
  const night = { id: 'n1', full_name: 'Night Worker', email: 'n@x.test', company: JOBWAYS, employee_code: '00000031', shift_id: null };
  const logs = [{ id: 1, user_id: 'n1', employee_code: '00000031', direction: 'IN', event_type: 'LOGIN',
                  log_datetime: '2026-09-14T18:05:00+05:30', log_date: '2026-09-14', source: 'biometric' }];
  const h = harness({ now: '2026-09-15T03:20:00+05:30', profiles: [night], logs,
    targets: [{ company: JOBWAYS, enabled: true, dialog_id: 'jw' }] });
  await h.tick();
  assert.equal(h.posts.length, 0, 'within the half hour after 3:00');
  h.at('2026-09-15T03:31:00+05:30');
  await h.tick();
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0].message, /Logout 3:00 AM · shift ended without a punch-out/);
  assert.equal(h.posts[0].company, JOBWAYS);
});

test('the scheduler proves itself with the secret the database made; the old placeholder is refused', async () => {
  const secret = 'a'.repeat(32) + 'b'.repeat(32);
  const h = harness({ now: '2026-09-15T12:00:00+05:30', profiles: [person], logs: [], scheduler: { secret } });
  const refused = await h.tick('shift_switch', 'PASTE-YOUR-BIOMETRIC_API_KEY');
  assert.equal(refused.statusCode, 401);
  assert.equal(h.db.worksuite_scheduler[0].last_run_at, undefined);
  const ok = await h.tick('shift_switch', secret);
  assert.equal(ok.statusCode, 200);
  const beat = h.db.worksuite_scheduler[0];
  assert.deepEqual([beat.last_job, beat.last_ok], ['shift_switch', true]);
  assert.ok(beat.last_run_at && beat.last_result.attendance);
  assert.equal((await h.tick('shift_switch', 'x'.repeat(64))).statusCode, 401, 'a wrong secret of the right length');
});

// Dual shift: SportsMart 10-5 (Nova) then Jobways Evening 5-7 (company2).
const DAY10 = { id: 1, name: 'SportsMart 10-5', start_time: '10:00', end_time: '17:00', grace_minutes: 10, early_out_grace_minutes: 10, working_days: [1, 2, 3, 4, 5, 6], is_default: true };
const EVE = { id: 2, name: 'Jobways Evening', start_time: '17:00', end_time: '19:00', grace_minutes: 10, early_out_grace_minutes: 10, working_days: [1, 2, 3, 4, 5] };
const dual = { ...person, id: 'd1', full_name: 'Dual Person', employee_code: '00000044', shift_id: 1, shift2_id: 2, company2: 'Jobways Point LLP' };
const dualPunch = (id, time, direction, event_type) => ({ id, user_id: 'd1', employee_code: '00000044', direction, event_type,
  log_datetime: `2026-09-14T${time}:00+05:30`, log_date: '2026-09-14', source: 'biometric' });
const dualHarness = (logs, extra = {}) => harness({ now: '2026-09-14T17:00:30+05:30', profiles: [dual], logs, shifts: [DAY10, EVE],
  targets: [{ company: COMPANY, enabled: true, dialog_id: 'nova' }, { company: 'Jobways Point LLP', enabled: true, dialog_id: 'jw' }], ...extra });

test('the 5pm switch posts Logout to the first company and Login to the second, once', async () => {
  const h = dualHarness([dualPunch(1, '09:58', 'IN', 'LOGIN')]);
  const res = await h.tick('shift_switch');
  assert.deepEqual(JSON.parse(JSON.stringify(res.body.shift_switch.results)), [{ user: 'Dual Person', first: 'sent', second: 'sent' }]);
  assert.deepEqual(h.posts.map(p => p.company), [COMPANY, 'Jobways Point LLP']);
  h.at('2026-09-14T17:05:30+05:30');
  await h.tick('shift_switch');
  assert.equal(h.posts.length, 2);
});

test('someone who came only for the evening shift is not switched', async () => {
  const h = dualHarness([dualPunch(1, '17:00', 'IN', 'LOGIN')], { now: '2026-09-14T17:05:00+05:30' });
  const res = await h.tick('shift_switch');
  assert.deepEqual(JSON.parse(JSON.stringify(res.body.shift_switch.results)), [{ user: 'Dual Person', skipped: 'came for the second shift only' }]);
  assert.equal(h.posts.length, 0);
});

test('a switch half Bitrix did not take is sent again, and only that half', async () => {
  let calls = 0;
  const h = dualHarness([dualPunch(1, '09:58', 'IN', 'LOGIN')],
    { bitrixResult: p => (p.company === 'Jobways Point LLP' && ++calls === 1 ? { ok: false, reason: 'timeout' } : { ok: true }) });
  await h.tick('shift_switch');
  assert.deepEqual([h.db.shift_switch_posts[0].first_ok, h.db.shift_switch_posts[0].second_ok], [true, false]);
  h.at('2026-09-14T17:05:30+05:30');
  const res = await h.tick('shift_switch');
  assert.deepEqual(JSON.parse(JSON.stringify(res.body.shift_switch.results)), [{ user: 'Dual Person', first: 'sent before', second: 'sent' }]);
  assert.deepEqual(h.posts.map(p => p.company), [COMPANY, 'Jobways Point LLP', 'Jobways Point LLP']);
  assert.equal(h.db.shift_switch_posts[0].second_ok, true);
});

test('the admin\'s Run now does not count as the scheduler being alive', async () => {
  const h = harness({ now: '2026-09-15T12:00:00+05:30', profiles: [person], logs: [], scheduler: { secret: 'c'.repeat(64) } });
  assert.equal((await h.tick('shift_switch', 'test-device')).statusCode, 200);
  assert.equal(h.db.worksuite_scheduler[0].last_job, 'shift_switch', 'a scheduler using the device key still records its runs');
  h.db.worksuite_scheduler[0].last_job = null;
  assert.equal((await h.tick('shift_switch', 'test-device', { manual: '1' })).statusCode, 200);
  assert.equal(h.db.worksuite_scheduler[0].last_job, null);
});

test('the switch ignores yesterday\'s unclosed day: someone absent today is not switched', async () => {
  const yesterday = { ...dualPunch(1, '09:58', 'IN', 'LOGIN'), log_datetime: '2026-09-13T09:58:00+05:30', log_date: '2026-09-13' };
  const h = dualHarness([yesterday]);
  const res = await h.tick('shift_switch');
  assert.deepEqual(JSON.parse(JSON.stringify(res.body.shift_switch.results)), [{ user: 'Dual Person', skipped: 'not on site' }]);
  assert.equal(h.posts.length, 0);
});

test('two overlapping runs send a failed punch once', async () => {
  const logs = [punch(1, '17:00', 'OUT', 'BREAK_OUT', { bitrix_status: 'failed', bitrix_attempts: 0, bitrix_at: '2026-09-15T17:00:05+05:30' })];
  const h = harness({ now: '2026-09-15T18:00:00+05:30', profiles: [person], logs, bitrixDelay: 20 });
  await Promise.all([h.tick(), h.tick('shift_switch', 'test-device', { manual: '1' })]);
  assert.equal(h.posts.length, 1);
  assert.deepEqual([logs[0].bitrix_status, logs[0].bitrix_attempts], ['sent', 1]);
});

test('a read that fails part-way skips the automatic logouts rather than guessing', async () => {
  const people = [], logs = [];
  for (let i = 0; i < 300; i++) {
    const id = `p${i}`;
    people.push({ ...person, id, full_name: `Person ${i}`, employee_code: String(1000 + i) });
    [['09:30', 'IN', 'LOGIN'], ['13:00', 'OUT', 'BREAK_OUT'], ['13:40', 'IN', 'BREAK_IN'], ['18:31', 'OUT', 'LOGOUT']].forEach(([t, d, e], j) =>
      logs.push(punch(`${id}-${j}`, t, d, e, { user_id: id, employee_code: String(1000 + i) })));
  }
  const h = harness({ now: '2026-09-15T19:05:00+05:30', profiles: people, logs, maxRows: 1000,
    failPage: (table, offset) => table === 'attendance_logs' && offset >= 1000 });
  const res = await h.tick();
  assert.equal(h.posts.length, 0);
  assert.match(res.body.attendance.notes.join(' '), /attendance read failed/);
});

test('a failed automatic logout is dropped when a punch the reader held back arrives', async () => {
  const h = harness({ now: '2026-09-15T19:01:00+05:30', profiles: [person], logs: [punch(1, '09:31', 'IN', 'LOGIN', { created_at: '2026-09-15T09:31:05+05:30' })],
    bitrixResult: p => (p.kind === 'auto_logout' && !h.retried ? (h.retried = true, { ok: false, reason: 'timeout' }) : { ok: true }) });
  await h.tick();
  // 18:25, before the shift end, but stored only at 19:04.
  h.db.attendance_logs.push(punch(2, '18:25', 'OUT', 'LOGOUT', { created_at: '2026-09-15T19:04:00+05:30' }));
  h.at('2026-09-15T19:10:00+05:30');
  await h.tick();
  assert.equal(h.posts.filter(p => p.kind === 'auto_logout').length, 1, 'not re-sent');
});

test('a repeat tap does not keep a day open or close it', async () => {
  const logs = [punch(1, '09:31', 'IN', 'LOGIN'),
    punch(2, '09:31', 'IN', 'LOGIN', { log_datetime: '2026-09-15T09:31:40+05:30', email_status: 'skipped', email_error: 'Repeat tap within 2 minutes of the previous punch: stored, not announced.' })];
  const h = harness({ now: '2026-09-15T19:01:00+05:30', profiles: [person], logs });
  await h.tick();
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0].message, /Logout 6:30 PM · shift ended without a punch-out/);
});

test('two overlapping runs re-send a failed automatic logout once, and a failed switch half once', async () => {
  let failed = false;
  const h = harness({ now: '2026-09-15T19:01:00+05:30', profiles: [person], logs: [punch(1, '09:31', 'IN', 'LOGIN')], bitrixDelay: 30,
    bitrixResult: () => (failed ? { ok: true } : (failed = true, { ok: false, reason: 'timeout' })) });
  await h.tick();
  h.at('2026-09-15T19:06:00+05:30');
  await Promise.all([h.tick(), (async () => { await new Promise(r => setTimeout(r, 5)); return h.tick('shift_switch', 'test-device', { manual: '1' }); })()]);
  assert.equal(h.posts.filter(p => p.kind === 'auto_logout').length, 2, 'the failed one and one re-send');
  assert.equal(h.db.attendance_auto_logouts[0].attempts, 1);

  let calls = 0;
  const d = dualHarness([dualPunch(1, '09:58', 'IN', 'LOGIN')], { bitrixDelay: 30,
    bitrixResult: p => (p.company === 'Jobways Point LLP' && ++calls === 1 ? { ok: false, reason: 'timeout' } : { ok: true }) });
  await d.tick('shift_switch');
  d.at('2026-09-14T17:05:30+05:30');
  await Promise.all([d.tick('shift_switch'), (async () => { await new Promise(r => setTimeout(r, 5)); return d.tick('shift_switch', 'test-device', { manual: '1' }); })()]);
  assert.equal(d.posts.filter(p => p.company === 'Jobways Point LLP').length, 2);
});

test('a repeat tap on the break-out does not stop the automatic logout being re-sent', async () => {
  let failed = false;
  const logs = [punch(1, '09:31', 'IN', 'LOGIN'), punch(2, '15:10', 'OUT', 'BREAK_OUT'),
    punch(3, '15:10', 'OUT', 'BREAK_OUT', { log_datetime: '2026-09-15T15:10:40+05:30', email_status: 'skipped', email_error: 'Repeat tap within 2 minutes of the previous punch: stored, not announced.' })];
  const h = harness({ now: '2026-09-15T19:01:00+05:30', profiles: [person], logs,
    bitrixResult: () => (failed ? { ok: true } : (failed = true, { ok: false, reason: 'timeout' })) });
  await h.tick();
  h.at('2026-09-15T19:06:00+05:30');
  await h.tick();
  assert.equal(h.posts.length, 2);
  assert.equal(h.db.attendance_auto_logouts[0].bitrix_ok, true);
});
