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

function harness({ now, logs, profiles, bitrixResult }) {
  let clock = Date.parse(now);
  const db = { attendance_logs: logs, attendance_auto_logouts: [] };
  const posts = [];
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
  const matches = (row, url) => [...url.searchParams].every(([k, v]) => {
    if (['select', 'order', 'limit', 'on_conflict'].includes(k)) return true;
    if (v === 'not.is.null') return row[k] != null;
    if (v.startsWith('eq.')) return String(row[k]) === v.slice(3);
    if (v.startsWith('lt.')) return Number(row[k] || 0) < Number(v.slice(3));
    if (v.startsWith('gte.')) return new Date(row[k]) >= new Date(v.slice(4));
    if (v.startsWith('in.(')) return v.slice(4, -1).split(',').includes(String(row[k]));
    return true;
  });
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, console, setTimeout, Map, Set,
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } },
    process: { env: { SUPABASE_URL: 'https://db.example.test', SUPABASE_SERVICE_ROLE_KEY: 's', BIOMETRIC_API_KEY: 'test-device' } },
    require(name) {
      if (name === '../company-config') return require('../company-config');
      if (name === '../lib/attendance') return attendance;
      if (name === '../lib/mailer') return { async sendMail() { return { ok: true }; } };
      if (name === '../lib/bitrix') return {
        isConfigured: () => true, senderFor: ({ enroll }) => ({ base: 'hook', enroll }),
        async sendAndLog(payload) { posts.push(payload); return bitrixResult || { ok: true }; },
        async logAttempt() {},
      };
      throw new Error(name);
    },
    async fetch(raw, init = {}) {
      const url = new URL(raw), table = url.pathname.replace('/rest/v1/', ''), method = init.method || 'GET';
      if (table === 'profiles') return response(profiles);
      if (table === 'shifts') return response([{ id: 1, name: 'Day', start_time: '09:30', end_time: '18:30', working_days: [1, 2, 3, 4, 5, 6], is_default: true }]);
      if (table === 'bitrix_targets') return response([{ company: COMPANY, enabled: true, dialog_id: 'chat100' }]);
      const rows = db[table];
      if (!rows) throw new Error(`Unexpected ${method} ${table}`);
      if (method === 'GET') return response(rows.filter(r => matches(r, url)));
      if (method === 'PATCH') { rows.filter(r => matches(r, url)).forEach(r => Object.assign(r, JSON.parse(init.body))); return response(null, 204); }
      if (method === 'POST') {
        const made = [].concat(JSON.parse(init.body)).filter(b => !rows.some(r => r.user_id === b.user_id && r.log_date === b.log_date));
        rows.push(...made);
        return response(made, 201);
      }
      throw new Error(method);
    },
  }, { filename: 'attendance-webhook.js' });
  return {
    db, posts,
    at(iso) { clock = Date.parse(iso); },
    async tick(job = 'attendance_tick') {
      const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await module.exports({ method: 'POST', query: { job }, headers: { authorization: 'Bearer test-device' }, body: {} }, res);
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
  const res = await h.tick();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.attendance.auto_logouts, 1);
  assert.equal(h.posts.length, 1);
  assert.match(h.posts[0].message, /Logout 6:30 PM · shift ended without a punch-out/);
  assert.equal(h.posts[0].kind, 'auto_logout');
  assert.deepEqual([h.db.attendance_auto_logouts[0].kind, h.db.attendance_auto_logouts[0].bitrix_ok], ['no_punch_out', true]);

  h.at('2026-09-15T18:50:00+05:30');
  await h.tick('shift_switch');                          // the scheduler's own call runs it too
  assert.equal(h.posts.length, 1, 'posted exactly once');
});

test('someone who went on a break and never came back left at that break', async () => {
  const h = harness({ now: '2026-09-15T19:00:00+05:30', profiles: [person],
    logs: [punch(1, '09:31', 'IN', 'LOGIN'), punch(2, '15:10', 'OUT', 'BREAK_OUT')] });
  await h.tick();
  assert.match(h.posts[0].message, /Logout 3:10 PM · did not return from break by shift end/);
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
    punch(1, '17:00', 'OUT', 'BREAK_OUT', { bitrix_status: 'failed', bitrix_attempts: 0 }),
    punch(2, '17:05', 'IN', 'BREAK_IN', { bitrix_status: 'deferred', bitrix_attempts: 1 }),
    punch(3, '17:10', 'OUT', 'BREAK_OUT', { bitrix_status: 'failed', bitrix_attempts: 4 }),
    punch(4, '17:15', 'IN', 'BREAK_IN', { bitrix_status: 'sent', bitrix_attempts: 1 }),
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
