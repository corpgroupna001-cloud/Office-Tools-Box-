const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const attendance = require('../lib/attendance');

// Exercise the real handler and event classification with isolated external
// services. No SMTP, Bitrix, Supabase credentials or third-party packages.
const source = fs.readFileSync(path.join(__dirname, '../api/attendance-webhook.js'), 'utf8');
const COMPANY = 'CORPGROUP';
const NOW = Date.parse('2026-09-08T19:00:00+05:30');
const punches = ['09:30', '11:00', '11:15', '13:00', '13:30', '18:30'].map(time => ({
  employee_code: '00000008', employee_name: 'Test Employee',
  log_datetime: `2026-09-08 ${time}:00`, device_sn: 'TEST-READER',
}));

function harness(options = {}) {
  let now = NOW;
  const rows = [], emails = [], posts = [], audit = [], releases = [];
  const profile = { id: 'employee-1', full_name: 'Test Employee', email: 'employee@example.test',
    company: COMPANY, employee_code: '00000008', shift_id: 1, ...options.profile };
  const shifts = [{ id: 1, start_time: '09:30', end_time: '18:30',
    working_days: [1, 2, 3, 4, 5, 6], is_default: true }, ...(options.shifts || [])];
  const response = data => new Response(JSON.stringify(data), { status: 200 });
  const module = { exports: {} };
  const sandbox = {
    module, console, setTimeout, Map, Set,
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    process: { env: { SUPABASE_URL: 'https://db.example.test', SUPABASE_SERVICE_ROLE_KEY: 'test-service',
      BIOMETRIC_API_KEY: 'test-device' } },
    require(name) {
      if (name === '../company-config') return require('../company-config');
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
      if (table === 'attendance_logs') {
        if (method === 'GET') return response(rows);
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
    rows, emails, posts, audit,
    release() { releases.splice(0).forEach(resolve => resolve()); },
    expire() { now += 8000; },
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
