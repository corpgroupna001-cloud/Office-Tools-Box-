const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const attendance = require('../lib/attendance');

// Exercise the real handler and event classification with isolated external
// services. No SMTP, Bitrix, Supabase credentials or third-party packages.
const source = fs.readFileSync(path.join(__dirname, '../api/attendance-webhook.js'), 'utf8');
const COMPANY = 'Nova Sportsmart Private Limited';
const NOW = Date.parse('2026-09-08T19:00:00+05:30');
const punches = ['09:30', '11:00', '11:15', '13:00', '13:30', '18:30'].map(time => ({
  employee_code: '00000008', employee_name: 'Test Employee',
  log_datetime: `2026-09-08 ${time}:00`, device_sn: 'TEST-READER',
}));

// The PostgREST filters the handler uses, so reads return what the database would.
const matches = (row, url) => [...url.searchParams].every(([k, v]) => {
  if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) return true;
  if (v === 'not.is.null') return row[k] != null;
  if (v.startsWith('eq.')) return String(row[k]) === decodeURIComponent(v.slice(3));
  if (v.startsWith('gte.')) return new Date(row[k]) >= new Date(v.slice(4));
  if (v.startsWith('lte.')) return new Date(row[k]) <= new Date(v.slice(4));
  return true;
});

function harness(options = {}) {
  let now = options.now ? Date.parse(options.now) : NOW;
  const rows = [], emails = [], posts = [], audit = [], releases = [];
  const profile = { id: 'employee-1', full_name: 'Test Employee', email: 'employee@example.test',
    company: COMPANY, employee_code: '00000008', shift_id: 1, ...options.profile };
  const shifts = [{ id: 1, start_time: '09:30', end_time: '18:30',
    working_days: [1, 2, 3, 4, 5, 6], is_default: true }, ...(options.shifts || [])];
  const response = data => new Response(JSON.stringify(data), { status: 200 });
  const module = { exports: {} };
  const sandbox = {
    module, console, setTimeout, clearTimeout, AbortController, Map, Set,
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    process: { env: { SUPABASE_URL: 'https://db.example.test', SUPABASE_SERVICE_ROLE_KEY: 'test-service',
      BIOMETRIC_API_KEY: 'test-device' } },
    require(name) {
      if (name === '../lib/request-auth') return require('../lib/request-auth');
      if (name === '../company-config') return require('../company-config');
      if (name === 'crypto') return require('crypto');
      if (name === '../lib/attendance') return attendance;
      if (name === '../lib/mailer') return { async sendMail(mail) {
        emails.push(mail);
        if (options.holdMail) await new Promise(resolve => releases.push(resolve));
        return options.mailResult || { ok: true };
      } };
      if (name === '../lib/bitrix') return {
        isConfigured: () => true,
        senderFor: ({ enroll }) => ({ base: 'test-hook', enroll }),
        async sendAndLog(payload) {
          posts.push(payload);
          return options.bitrixResult || { ok: true, result: posts.length };
        },
        async logAttempt(payload) { audit.push(payload); },
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    async fetch(rawUrl, init = {}) {
      const url = new URL(rawUrl);
      const table = url.pathname.replace('/rest/v1/', '');
      const method = init.method || 'GET';
      if (table === 'profiles') return response([profile]);
      if (table === 'shifts') return response(shifts);
      if (table === 'bitrix_targets') {
        return response(options.noGroup ? [] : [
          { company: COMPANY, enabled: true, dialog_id: 'chat100' },
          { company: 'Jobways Point LLP', enabled: true, dialog_id: 'chat200' },
        ]);
      }
      if (table === 'rpc/record_enrolments') return response(null);
      if (url.pathname === '/auth/v1/user') return response({ id: profile.id });
      if (table === 'attendance_logs') {
        if (method === 'GET') return response(rows.filter(row => matches(row, url)));
        if (method === 'POST') {
          const inserted = JSON.parse(init.body).map((row, index) => ({ ...row, id: rows.length + index + 1 }));
          rows.push(...inserted);
          if (options.expireAfterInsert) now += 8000;
          return response(inserted);
        }
        if (method === 'PATCH') {
          const patch = JSON.parse(init.body);
          if (options.holdMailStatus && patch.email_status) {
            await new Promise(resolve => releases.push(resolve));
          }
          Object.assign(rows.find(row => String(row.id) === url.searchParams.get('id').slice(3)), patch);
          return response(null);
        }
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'attendance-webhook.js' });
  return {
    rows, emails, posts, audit, profile,
    release() { releases.splice(0).forEach(resolve => resolve()); },
    expire() { now += 8000; },
    at(iso) { now = Date.parse(iso); },
    async selfie(event_type) {
      const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; } };
      await module.exports({ method: 'POST', headers: { authorization: 'Bearer user-token' },
        body: { mode: 'selfie', event_type, latitude: 17.4, longitude: 78.4, selfie_path: `${profile.id}/s.jpg` } }, res);
      return res;
    },
    async send(body = punches) {
      const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; } };
      await module.exports({ method: 'POST', headers: { authorization: 'Bearer test-device' }, body }, res);
      return res;
    },
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('all biometric events reach Bitrix while SMTP workers are still waiting', async () => {
  const h = harness({ holdMail: true });
  const pending = h.send();
  try {
    for (let i = 0; i < 20 && h.posts.length < punches.length; i++) await flush();
    assert.equal(h.emails.length, 4, 'SMTP queue is occupied by its first four sends');
    assert.equal(h.posts.length, 6, 'Bitrix must process the whole batch independently');
    assert.deepEqual(h.rows.map(row => row.event_type),
      ['LOGIN', 'BREAK_OUT', 'BREAK_IN', 'BREAK_OUT', 'BREAK_IN', 'LOGOUT']);
    for (const label of ['Login', 'Break out', 'Break in', 'Logout']) {
      assert.ok(h.posts.some(post => post.message.includes(`· ${label} `)), label);
    }
  } finally {
    // Model SMTP finishing after the old Bitrix deadline.
    h.expire();
    h.release();
  }
  const res = await pending;
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.emailed, 4);
  assert.equal(res.body.deferred, 2);
  assert.equal(res.body.bitrix_sent, 6);
  assert.equal(res.body.bitrix_deferred, 0);
});

test('a slow email status write does not block Bitrix', async () => {
  const h = harness({ holdMailStatus: true });
  const pending = h.send();
  try {
    for (let i = 0; i < 20 && h.posts.length < punches.length; i++) await flush();
    assert.equal(h.posts.length, 6);
  } finally {
    h.expire();
    h.release();
  }
  assert.equal((await pending).body.bitrix_sent, 6);
});

test('email and Bitrix report the same event for each punch', async () => {
  const h = harness();
  const res = await h.send();
  assert.equal(res.body.emailed, 6);
  assert.equal(res.body.bitrix_sent, 6);
  for (const row of h.rows) {
    const label = attendance.eventLabel(row.event_type, row.direction);
    const time = attendance.istParts(new Date(row.log_datetime)).prettyTime;
    assert.ok(h.emails.some(mail => mail.subject.includes(label) && mail.subject.includes(time)));
    assert.ok(h.posts.some(post => post.message.includes(`${label} ${time}`)));
  }
});

test('SMTP failure does not suppress Bitrix', async () => {
  const h = harness({ mailResult: { ok: false, reason: 'smtp_send_failed', detail: 'test failure' } });
  const res = await h.send();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.failed, 6);
  assert.equal(res.body.bitrix_sent, 6);
});

test('Bitrix failure does not suppress email or lose stored punches', async () => {
  const h = harness({ bitrixResult: { ok: false, reason: 'CANCELED' } });
  const res = await h.send();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stored, 6);
  assert.equal(res.body.emailed, 6);
  assert.equal(res.body.bitrix_failed, 6);
});

test('vendor replays do not send duplicate email or Bitrix messages', async () => {
  const h = harness();
  await h.send();
  const res = await h.send();
  assert.equal(res.body.stored, 0);
  assert.equal(res.body.duplicates, 6);
  assert.equal(h.emails.length, 6);
  assert.equal(h.posts.length, 6);
});

test('old backfills are stored without sending either notification', async () => {
  const h = harness();
  const res = await h.send(punches.map(p => ({ ...p, log_datetime: p.log_datetime.replace('09-08', '09-01') })));
  assert.equal(res.body.stored, 6);
  assert.equal(res.body.backfill_skipped, 6);
  assert.equal(h.emails.length, 0);
  assert.equal(h.posts.length, 0);
});

test('deadline skips are visible in the Bitrix audit log', async () => {
  const h = harness({ expireAfterInsert: true });
  const res = await h.send();
  assert.equal(res.statusCode, 200);
  assert.equal(h.posts.length, 0);
  assert.equal(res.body.bitrix_deferred, 6);
  assert.equal(res.body.bitrix_skipped, 0);
  assert.equal(h.audit.length, 6);
  assert.ok(h.audit.every(entry => entry.out.reason === 'deadline' && entry.out.ok === false));
});

test('unmapped company groups remain intentional skips', async () => {
  const h = harness({ noGroup: true });
  const res = await h.send();
  assert.equal(res.body.emailed, 6);
  assert.equal(res.body.bitrix_skipped, 6);
  assert.equal(res.body.bitrix_failed, 0);
  assert.equal(h.posts.length, 0);
});

test('dual-shift punches still post to the company active at punch time', async () => {
  const h = harness({ profile: { shift2_id: 2, company2: 'Jobways Point LLP' },
    shifts: [{ id: 2, start_time: '17:00', end_time: '20:00', working_days: [1, 2, 3, 4, 5, 6] }] });
  await h.send();
  assert.equal(h.posts.filter(post => post.company === COMPANY).length, 5);
  assert.equal(h.posts.filter(post => post.company === 'Jobways Point LLP').length, 1);
  assert.equal(h.posts.find(post => post.company === 'Jobways Point LLP').dialogId, 'chat200');
});

// ---- IN/OUT by shift time, through the real handler ----
const one = (date, time) => [{ employee_code: '00000008', employee_name: 'Test Employee', log_datetime: `${date} ${time}`, device_sn: 'TEST-READER' }];
const lines = h => h.posts.map(p => p.message.replace(/^\S+ \[B\]Test Employee\[\/B\] · /, ''));

test('a night shift with no break punches posts Login, then Logout at 3 AM', async () => {
  const h = harness({ now: '2026-09-14T17:56:00+05:30', profile: { company: 'Jobways Point LLP', shift_id: null } });
  await h.send(one('2026-09-14', '17:55:00'));
  h.at('2026-09-15T03:03:00+05:30');
  await h.send(one('2026-09-15', '03:02:00'));
  h.at('2026-09-15T17:57:00+05:30');
  await h.send(one('2026-09-15', '17:56:00'));
  assert.deepEqual(lines(h), ['Login 5:55 PM', 'Logout 3:02 AM', 'Login 5:56 PM']);
  assert.deepEqual(h.rows.map(r => r.log_date), ['2026-09-14', '2026-09-14', '2026-09-15']);
  assert.ok(h.posts.every(p => p.company === 'Jobways Point LLP'));
});

test('a punch at the shift end after a missed return is the Logout', async () => {
  const h = harness();
  for (const t of ['09:30:00', '13:00:00', '18:31:00']) { h.at(`2026-09-08T${t}+05:30`); await h.send(one('2026-09-08', t)); }
  assert.deepEqual(lines(h), ['Login 9:30 AM', 'Break out 1:00 PM', 'Logout 6:31 PM']);
});

test('only the logout punched: a Logout with the login noted as missing, not a late Login', async () => {
  const h = harness();
  await h.send(one('2026-09-08', '18:31:00'));
  assert.deepEqual(lines(h), ['Logout 6:31 PM · login not punched']);
  assert.match(h.emails[0].subject, /Logout at 6:31 PM/);
});

test('a double tap is stored but announced once', async () => {
  const h = harness();
  const res = await h.send(['09:30:00', '09:30:04', '13:00:00', '13:40:00', '18:31:00'].map(t => one('2026-09-08', t)[0]));
  assert.equal(res.body.stored, 5);
  assert.deepEqual(lines(h), ['Login 9:30 AM', 'Break out 1:00 PM', 'Break in 1:40 PM', 'Logout 6:31 PM']);
  const repeat = h.rows.find(r => r.log_time === '09:30:04');
  assert.deepEqual([repeat.event_type, repeat.email_status, repeat.bitrix_status], ['LOGIN', 'skipped', 'skipped']);
  assert.equal(h.emails.length, 4);
});

test('a punch the reader delivers after a later one is labelled in hindsight and marked synced late', async () => {
  const h = harness();
  h.at('2026-09-08T13:01:00+05:30');
  await h.send(one('2026-09-08', '13:00:00'));
  await h.send(one('2026-09-08', '09:30:00'));
  assert.deepEqual(lines(h), ['Login 1:00 PM · 3h 30m late', 'Login 9:30 AM · synced late']);
  assert.equal(h.rows.find(r => r.log_time === '13:00:00').event_type, 'BREAK_OUT');
});

test('a WFH selfie in the second shift goes to the second company, judged against the combined day', async () => {
  const h = harness({ profile: { is_wfh: true, shift2_id: 2, company2: 'Jobways Point LLP' },
    shifts: [{ id: 2, name: 'Evening', start_time: '18:30', end_time: '20:00', working_days: [1, 2, 3, 4, 5, 6] }] });
  h.at('2026-09-08T09:31:00+05:30');
  assert.equal((await h.selfie('LOGIN')).statusCode, 200);
  h.at('2026-09-08T19:00:00+05:30');
  assert.equal((await h.selfie('LOGOUT')).statusCode, 200);
  assert.deepEqual(h.posts.map(p => p.company), [COMPANY, 'Jobways Point LLP']);
  assert.match(h.posts[1].message, /Logout 7:00 PM · 1h 00m early · from home/);
  assert.deepEqual(h.rows.map(r => r.log_date), ['2026-09-08', '2026-09-08']);
});

test('a WFH night worker\'s 3 AM selfie logout stays on the evening it began', async () => {
  const h = harness({ now: '2026-09-14T18:00:00+05:30', profile: { is_wfh: true, company: 'Jobways Point LLP', shift_id: null } });
  await h.selfie('LOGIN');
  h.at('2026-09-15T03:05:00+05:30');
  await h.selfie('LOGOUT');
  assert.deepEqual(h.rows.map(r => r.log_date), ['2026-09-14', '2026-09-14']);
  assert.doesNotMatch(h.posts[1].message, /early/);
});

test('moving someone from nights to days does not rewrite the nights they already worked', async () => {
  const h = harness({ now: '2026-09-14T17:59:00+05:30', profile: { shift_id: 7 },
    shifts: [{ id: 7, name: 'Night', start_time: '18:00', end_time: '03:00', grace_minutes: 10, early_out_grace_minutes: 10, working_days: [1, 2, 3, 4, 5, 6] }] });
  for (const [d, t] of [['2026-09-14', '17:58:00'], ['2026-09-15', '03:02:00'], ['2026-09-15', '18:01:00'], ['2026-09-16', '03:03:00']]) {
    h.at(`${d}T${t}+05:30`);
    await h.send(one(d, t));
  }
  const before = h.rows.map(r => [r.log_date, r.direction, r.event_type].join(' '));
  assert.deepEqual(before, ['2026-09-14 IN LOGIN', '2026-09-14 OUT LOGOUT', '2026-09-15 IN LOGIN', '2026-09-15 OUT LOGOUT']);
  // Wednesday off; from Thursday on the General day shift.
  h.profile.shift_id = 1;
  // 08:55 is under 30 hours after the last night's 03:03 logout, inside what one ingest may patch.
  h.at('2026-09-17T08:56:00+05:30');
  await h.send(one('2026-09-17', '08:55:00'));
  assert.deepEqual(h.rows.slice(0, 4).map(r => [r.log_date, r.direction, r.event_type].join(' ')), before);
  assert.deepEqual([h.rows[4].log_date, h.rows[4].event_type], ['2026-09-17', 'LOGIN']);
});
