const test = require('node:test');
const assert = require('node:assert/strict');
const people = require('../lib/employee-admin');
const { auditWrap, summaryOf } = require('../lib/admin-audit');

const URL_BASE = 'https://db.example.test';
const KEY = 'test-service-key';
const COMPANY = 'Nova Sportsmart Private Limited';

/**
 * A stand-in Supabase. Routes are matched in order; each returns
 * [status, body] and every call is recorded so a test can assert that
 * something was — or was not — written.
 */
function supabase(routes = []) {
  const calls = [];
  const request = async (url, options = {}) => {
    const method = options.method || 'GET';
    const path = url.slice(URL_BASE.length);
    calls.push({ method, path, body: options.body ? JSON.parse(options.body) : null });
    for (const [test, handler] of routes) {
      if (test(method, path)) {
        const [status, body] = handler(method, path, calls.at(-1).body);
        return new Response(JSON.stringify(body ?? null), { status });
      }
    }
    return new Response('[]', { status: 200 });
  };
  return { request, calls, wrote: (method, fragment) => calls.filter(c => c.method === method && c.path.includes(fragment)) };
}

const on = (method, fragment) => (m, p) => m === method && p.includes(fragment);
const NO_PROFILE = [on('GET', '/rest/v1/profiles'), () => [200, []]];

/* ============================ Adding an employee ============================ */

test('a new employee gets an account, a filled-in profile and an invite — and no password travels', async () => {
  const sb = supabase([
    NO_PROFILE,
    [on('POST', '/auth/v1/admin/users'), () => [200, { id: '11111111-1111-4111-8111-111111111111' }]],
    [on('PATCH', '/rest/v1/profiles'), (m, p, body) => [200, [{ id: '11111111-1111-4111-8111-111111111111', ...body }]]],
    [on('POST', '/auth/v1/recover'), () => [200, {}]],
  ]);
  const out = await people.createEmployee(
    { email: 'New.Person@Example.com', full_name: 'New Person', company: COMPANY, department: 'Operations' },
    { url: URL_BASE, key: KEY, request: sb.request });

  assert.equal(out.success, true);
  assert.equal(out.warning, undefined);
  assert.equal(out.employee.email, 'new.person@example.com', 'the login email is stored lowercased');
  assert.equal(out.employee.department, 'Operations');
  assert.equal(out.employee.email_verified, true, 'an admin adding a colleague is the verification');

  const created = sb.wrote('POST', '/auth/v1/admin/users')[0].body;
  assert.equal(created.email_confirm, true);
  assert.ok(created.password.length >= 24, 'the throwaway password is long');
  assert.equal(sb.wrote('POST', '/auth/v1/recover').length, 1, 'the invite is what lets them in');
});

test('an email already in WorkSuite is refused before any account is created', async () => {
  const sb = supabase([[on('GET', '/rest/v1/profiles'), () => [200, [{ id: 'existing' }]]]]);
  await assert.rejects(
    people.createEmployee({ email: 'taken@example.com', full_name: 'Taken', company: COMPANY },
      { url: URL_BASE, key: KEY, request: sb.request }),
    e => e.status === 409 && /already exists/.test(e.message));
  assert.equal(sb.wrote('POST', '/auth/v1/admin/users').length, 0);
});

test('a profile that will not save takes the half-made login account back out', async () => {
  const sb = supabase([
    NO_PROFILE,
    [on('POST', '/auth/v1/admin/users'), () => [200, { id: '22222222-2222-4222-8222-222222222222' }]],
    [on('PATCH', '/rest/v1/profiles'), () => [409, { code: '23505' }]],
  ]);
  await assert.rejects(
    people.createEmployee({ email: 'clash@example.com', full_name: 'Clash', company: COMPANY, employee_code: '00000008' },
      { url: URL_BASE, key: KEY, request: sb.request }),
    e => e.status === 409 && /biometric code/.test(e.message));
  assert.equal(sb.wrote('DELETE', '/auth/v1/admin/users').length, 1, 'no orphan login is left behind');
  assert.equal(sb.wrote('POST', '/auth/v1/recover').length, 0);
});

test('an employee is never created without the fields the rest of WorkSuite needs', async () => {
  const sb = supabase([NO_PROFILE]);
  const call = data => people.createEmployee(data, { url: URL_BASE, key: KEY, request: sb.request });
  await assert.rejects(call({ full_name: 'No Email', company: COMPANY }), /Email is required/);
  await assert.rejects(call({ email: 'a@b.com', company: COMPANY }), /Full name is required/);
  await assert.rejects(call({ email: 'a@b.com', full_name: 'No Company' }), /Company is required/);
  await assert.rejects(call({ email: 'a@b.com', full_name: 'Bad Co', company: 'Made Up Ltd' }), /valid company/);
  assert.equal(sb.wrote('POST', '/auth/v1/admin/users').length, 0);
});

/* ============================== Offboarding ============================== */

test('offboarding blocks the login and records the exit without deleting anything', async () => {
  const sb = supabase([
    [on('PATCH', '/rest/v1/profiles'), (m, p, body) => [200, [{ id: 'x', ...body }]]],
    [on('PUT', '/auth/v1/admin/users'), () => [200, {}]],
  ]);
  const out = await people.setEmployeeStatus(
    { id: '33333333-3333-4333-8333-333333333333', status: 'inactive', exit_date: '2026-09-30', exit_reason: 'Resigned' },
    { url: URL_BASE, key: KEY, request: sb.request });

  assert.equal(out.employee.status, 'inactive');
  assert.equal(out.employee.exit_date, '2026-09-30');
  assert.equal(out.employee.exit_reason, 'Resigned');
  assert.equal(out.warning, undefined);
  assert.equal(sb.wrote('PUT', '/auth/v1/admin/users')[0].body.ban_duration, '876000h');
  assert.equal(sb.wrote('DELETE', '/auth/v1/admin/users').length, 0, 'offboarding is not deletion');
});

test('reactivating lifts the ban and clears the exit details', async () => {
  const sb = supabase([
    [on('PATCH', '/rest/v1/profiles'), (m, p, body) => [200, [{ id: 'x', ...body }]]],
    [on('PUT', '/auth/v1/admin/users'), () => [200, {}]],
  ]);
  const out = await people.setEmployeeStatus({ id: '33333333-3333-4333-8333-333333333333', status: 'active' },
    { url: URL_BASE, key: KEY, request: sb.request });
  assert.equal(out.employee.status, 'active');
  assert.equal(out.employee.exit_date, null);
  assert.equal(sb.wrote('PUT', '/auth/v1/admin/users')[0].body.ban_duration, 'none');
});

test('a login that could not be blocked is reported rather than silently assumed', async () => {
  const sb = supabase([
    [on('PATCH', '/rest/v1/profiles'), (m, p, body) => [200, [{ id: 'x', ...body }]]],
    [on('PUT', '/auth/v1/admin/users'), () => [502, {}]],
  ]);
  const out = await people.setEmployeeStatus({ id: '33333333-3333-4333-8333-333333333333', status: 'inactive' },
    { url: URL_BASE, key: KEY, request: sb.request });
  assert.match(out.warning, /could not be blocked/);
});

test('offboarding rejects a bad status, id or last working day', async () => {
  const sb = supabase();
  const call = data => people.setEmployeeStatus(data, { url: URL_BASE, key: KEY, request: sb.request });
  const id = '33333333-3333-4333-8333-333333333333';
  await assert.rejects(call({ id: 'not-a-uuid', status: 'inactive' }), /Invalid employee ID/);
  await assert.rejects(call({ id, status: 'deleted' }), /active or inactive/);
  await assert.rejects(call({ id, status: 'inactive', exit_date: '2026-02-31' }), /valid last working day/);
  assert.equal(sb.calls.length, 0);
});

test('a missing migration names the file to run instead of a database error', async () => {
  const sb = supabase([[on('PATCH', '/rest/v1/profiles'), () => [400, { code: 'PGRST204' }]]]);
  await assert.rejects(
    people.setEmployeeStatus({ id: '33333333-3333-4333-8333-333333333333', status: 'inactive' },
      { url: URL_BASE, key: KEY, request: sb.request }),
    /supabase-admin-console-migration\.sql/);
});

/* ============================== Bulk import ============================== */

const bulkBackend = existing => supabase([
  // The roll-call of who already exists, which bulkEmployees matches rows against.
  [(m, p) => m === 'GET' && p.includes('select=id,email'), () => [200, existing]],
  // createEmployee's own "is this address taken?" check, for rows it will create.
  [(m, p) => m === 'GET' && p.includes('select=id&email=eq.'), () => [200, []]],
  [on('GET', '/rest/v1/profiles'), (m, p) => [200, [{ id: p.match(/id=eq\.([^&]+)/)?.[1] || 'x', email: 'known@example.com', company: COMPANY, full_name: 'Known Person' }]]],
  [on('GET', '/rest/v1/shifts'), () => [200, [{ id: 1 }]]],
  [on('POST', '/auth/v1/admin/users'), () => [200, { id: '44444444-4444-4444-8444-444444444444' }]],
  [on('GET', '/auth/v1/admin/users'), () => [200, { email: 'known@example.com', user_metadata: {} }]],
  [on('PUT', '/auth/v1/admin/users'), () => [200, {}]],
  [on('PATCH', '/rest/v1/profiles'), (m, p, body) => [200, [{ id: 'x', ...body }]]],
  [on('POST', '/auth/v1/recover'), () => [200, {}]],
]);

test('a preview reports what each row would do and writes nothing at all', async () => {
  const sb = bulkBackend([{ id: '55555555-5555-4555-8555-555555555555', email: 'known@example.com' }]);
  const out = await people.bulkEmployees({ apply: false, rows: [
    { line: 2, email: 'known@example.com', department: 'Support' },
    { line: 3, email: 'brand.new@example.com', full_name: 'Brand New', company: COMPANY },
  ] }, { url: URL_BASE, key: KEY, request: sb.request });

  assert.equal(out.applied, false);
  assert.deepEqual(out.tally, { update: 1, create: 1 });
  assert.equal(out.rows[0].outcome, 'update');
  assert.equal(out.rows[1].outcome, 'create');
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    assert.equal(sb.calls.filter(c => c.method === method).length, 0, `preview must not ${method}`);
  }
});

test('applying matches on email: known addresses update, new ones are created and invited', async () => {
  const sb = bulkBackend([{ id: '55555555-5555-4555-8555-555555555555', email: 'known@example.com' }]);
  const out = await people.bulkEmployees({ apply: true, rows: [
    { line: 2, email: 'known@example.com', department: 'Support' },
    { line: 3, email: 'brand.new@example.com', full_name: 'Brand New', company: COMPANY },
  ] }, { url: URL_BASE, key: KEY, request: sb.request });

  assert.equal(out.applied, true);
  assert.deepEqual(out.tally, { update: 1, create: 1 });
  assert.equal(sb.wrote('POST', '/auth/v1/admin/users').length, 1, 'only the unknown address makes an account');
  assert.equal(sb.wrote('POST', '/auth/v1/recover').length, 1);
});

test('an update from a spreadsheet never silently changes someone\'s login address', async () => {
  const sb = bulkBackend([{ id: '55555555-5555-4555-8555-555555555555', email: 'known@example.com' }]);
  await people.bulkEmployees({ apply: true, rows: [
    { line: 2, email: 'known@example.com', full_name: 'Renamed Person' },
  ] }, { url: URL_BASE, key: KEY, request: sb.request });
  const patched = sb.wrote('PATCH', '/rest/v1/profiles')[0].body;
  assert.equal(patched.full_name, 'Renamed Person');
  assert.equal('email' in patched, false);
});

test('one bad row is reported on its own line and does not stop the rows around it', async () => {
  const sb = bulkBackend([]);
  const out = await people.bulkEmployees({ apply: true, rows: [
    { line: 2, email: 'first@example.com', full_name: 'First Person', company: COMPANY },
    { line: 3, email: 'no.company@example.com', full_name: 'No Company' },
    { line: 4, email: '', full_name: 'No Email At All' },
    { line: 5, email: 'first@example.com', full_name: 'Duplicate' },
    { line: 6, email: 'last@example.com', full_name: 'Last Person', company: COMPANY },
  ] }, { url: URL_BASE, key: KEY, request: sb.request });

  assert.deepEqual(out.tally, { create: 2, error: 3 });
  assert.match(out.rows[1].message, /Company is required/);
  assert.match(out.rows[2].message, /Missing email/);
  assert.match(out.rows[3].message, /Duplicate email/);
  assert.equal(out.rows[4].outcome, 'create');
  assert.deepEqual(out.rows.map(r => r.line), [2, 3, 4, 5, 6], 'every row keeps its line number from the file');
});

test('an oversized or empty import is refused before it reaches the database', async () => {
  const sb = supabase();
  const options = { url: URL_BASE, key: KEY, request: sb.request };
  await assert.rejects(people.bulkEmployees({ rows: [] }, options), /No rows to import/);
  const tooMany = Array.from({ length: people.BULK_LIMIT + 1 }, (_, i) => ({ email: `p${i}@example.com` }));
  await assert.rejects(people.bulkEmployees({ rows: tooMany }, options), /at most 500 rows/);
  assert.equal(sb.calls.length, 0);
});

/* =============================== Audit log =============================== */

function auditRun(action, body, send) {
  const written = [];
  const request = async (url, options) => { written.push(JSON.parse(options.body)); return new Response('', { status: 201 }); };
  const globalFetch = globalThis.fetch;
  globalThis.fetch = request;
  const previous = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = URL_BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = KEY;

  const sent = [];
  const res = { status(code) { this.code = code; return this; }, json(payload) { sent.push(payload); return payload; } };
  const wrapped = auditWrap(res, { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } }, action, body);
  return Promise.resolve(send(wrapped)).then(async result => {
    globalThis.fetch = globalFetch;
    process.env.SUPABASE_URL = previous.url; process.env.SUPABASE_SERVICE_ROLE_KEY = previous.key;
    return { written, sent, result };
  });
}

test('a change is recorded with who it touched, and the reply is not held up by the write', async () => {
  const { written, sent } = await auditRun('delete_employee', { id: 'abc', full_name: 'Leaver Person' },
    res => res.status(200).json({ success: true }));
  assert.equal(sent.length, 1, 'the admin gets their answer');
  assert.equal(written.length, 1);
  assert.equal(written[0].action, 'delete_employee');
  assert.equal(written[0].target_id, 'abc');
  assert.equal(written[0].target_label, 'Leaver Person');
  assert.equal(written[0].status, 'ok');
  assert.equal(written[0].http_status, 200);
  assert.equal(written[0].actor_ip, '203.0.113.7', 'the first hop is the caller, not our own proxy');
});

test('a failed change is recorded as failed, with the reason the admin saw', async () => {
  const { written } = await auditRun('update_employee', { id: 'abc' },
    res => res.status(409).json({ error: 'Email already belongs to another employee' }));
  assert.equal(written[0].status, 'failed');
  assert.equal(written[0].http_status, 409);
  assert.match(written[0].detail, /already belongs/);
});

test('reads are not logged, so the trail stays a list of changes', async () => {
  for (const action of ['results', 'employees', 'mail_logs', 'audit_log', 'session', 'login']) {
    const { written } = await auditRun(action, { password: 'super-secret' }, res => res.status(200).json({ ok: true }));
    assert.equal(written.length, 0, action + ' should not be audited');
  }
});

test('an unrecognised new action is audited by default rather than slipping through', async () => {
  const { written } = await auditRun('some_future_write', { id: 'z' }, res => res.status(200).json({ ok: true }));
  assert.equal(written.length, 1);
});

test('nothing sensitive from the request body reaches the log', async () => {
  const { written } = await auditRun('bitrix_save',
    { password: 'admin-password', code: '123456', webhook: 'https://example.bitrix24.in/rest/1/secret/', company: COMPANY },
    res => res.status(200).json({ success: true }));
  const text = JSON.stringify(written[0]);
  for (const secret of ['admin-password', '123456', 'secret']) assert.equal(text.includes(secret), false, secret + ' leaked');
  assert.match(written[0].summary, /Saved Bitrix settings/);
});

test('the summary reads as a sentence an HR reader can follow', () => {
  assert.equal(summaryOf('set_employee_status', { status: 'inactive' }), 'Changed employment status — status inactive');
  assert.equal(summaryOf('bulk_employees', { rows: [1, 2, 3], apply: true }), 'Bulk employee import — applied · 3 rows');
  assert.equal(summaryOf('set_wfh', { is_wfh: true }), 'Changed work-from-home flag — work from home');
});
