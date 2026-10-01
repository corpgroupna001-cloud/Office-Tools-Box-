// Sign-up and email codes end to end: the real /api handlers (signup-start,
// signup-complete, verify) against a Supabase stand-in whose database is the
// PGlite one with every migration — so the row locks, counters, invitations
// and transactions under test are the real SQL (SEC-01, SEC-06, BUG-03).
//
// The stand-in answers the handful of REST and Auth calls the handlers make;
// mail is captured, never sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { freshDb, makeUser, pglite } = require('./fixtures/load-db');

const skip = pglite() ? false : 'WS_SKIP_DB_TESTS=1: database tests skipped on purpose';
const NOVA = 'Nova Sportsmart Private Limited';
const JOBWAYS = 'Jobways Point LLP';
const URL_ = 'https://db.example.test';
const env = { SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: 'service-key', SUPABASE_ANON_KEY: 'anon-key', MAIL_API_KEY: 'mail-key' };
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

let db;
const svc = async (sql, params) => (await db.query(sql, params)).rows;

/* ---------------------------------------------------------- the stand-in */
function supabase(state) {
  const json = (data, status = 200) => new Response(data === undefined ? '' : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  return async function fetch(input, init = {}) {
    const url = new URL(String(input));
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.pathname === '/api/mail') {
      state.mail.push(body);
      return state.mailFails ? json({ error: 'smtp down' }, 502) : json({ success: true });
    }
    if (state.offline) throw new TypeError('fetch failed');
    // Database functions, called with named arguments as PostgREST does.
    const rpcMatch = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (rpcMatch) {
      const fn = rpcMatch[1];
      if (state.failRpc && state.failRpc[fn]) { state.failRpc[fn]--; return json({ code: 'XX000', message: 'injected failure' }, 500); }
      const keys = Object.keys(body || {});
      const sql = `select to_jsonb(public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})) as r`;
      try { return json((await db.query(sql, keys.map(k => body[k]))).rows[0].r); }
      catch (e) { return json({ code: e.code, message: e.message }, e.code === 'P0002' ? 404 : 400); }
    }
    if (url.pathname === '/rest/v1/profiles') {
      const where = [], params = [];
      for (const [k, v] of url.searchParams) {
        if (['select', 'limit'].includes(k)) continue;
        const m = /^eq\.(.*)$/.exec(v);
        if (m) { params.push(m[1]); where.push(`${k} = $${params.length}`); }
      }
      const cond = where.length ? 'where ' + where.join(' and ') : '';
      if (method === 'GET') {
        const cols = url.searchParams.get('select') || '*';
        return json((await db.query(`select ${cols} from profiles ${cond}`, params)).rows);
      }
      if (method === 'PATCH') {
        if (state.profilePatchFails) return json({ message: 'injected' }, 500);
        const keys = Object.keys(body);
        const set = keys.map((k, i) => `${k} = $${params.length + i + 1}`).join(', ');
        return json((await db.query(`update profiles set ${set} ${cond} returning id`, [...params, ...keys.map(k => body[k])])).rows);
      }
    }
    if (url.pathname === '/auth/v1/admin/users' && method === 'POST') {
      if (state.createDropsId) return json({});
      const exists = await svc(`select id from auth.users where lower(email) = lower($1)`, [body.email]);
      if (exists.length) return json({ msg: 'A user with this email address has already been registered' }, 422);
      const r = await svc(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [body.email, body.user_metadata || {}]);
      state.passwords[r[0].id] = body.password;
      return json({ id: r[0].id, email: body.email, user_metadata: body.user_metadata });
    }
    const userMatch = url.pathname.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/);
    if (userMatch) {
      const [u] = await svc(`select id, email, raw_user_meta_data from auth.users where id = $1`, [userMatch[1]]);
      if (!u) return json({ msg: 'not found' }, 404);
      if (method === 'PUT') { state.passwords[u.id] = body.password; return json({ id: u.id }); }
      return json({ id: u.id, email: u.email, user_metadata: u.raw_user_meta_data });
    }
    if (url.pathname === '/auth/v1/user') {
      const token = String(init.headers.Authorization || '').replace('Bearer ', '');
      const u = state.tokens[token];
      return u ? json(u) : json({ msg: 'invalid' }, 401);
    }
    throw new Error(`stand-in has no answer for ${method} ${url.pathname}${url.search}`);
  };
}

/** Load an /api handler in a sandbox whose fetch is the stand-in. */
function handler(file, state) {
  const module = { exports: {} };
  const fetch = supabase(state);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api', file), 'utf8'), {
    module, exports: module.exports, process: { env }, fetch, Response, URL, Buffer, console,
    require(name) {
      if (name === 'crypto') return require('crypto');
      if (name === '../lib/request-auth') return require('../lib/request-auth');
      if (name === '../lib/service-rpc') return require('../lib/service-rpc');
      if (name === './signup-start') return require('../api/signup-start');
      throw new Error('unexpected require ' + name);
    },
  });
  return async (body, { ip = '203.0.113.7', token, query = {} } = {}) => {
    const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; },
      json(b) { this.body = b; return this; }, end() { return this; } };
    await module.exports({ method: 'POST', body, query, headers: { host: 'work.example.test', 'x-forwarded-for': ip, ...(token ? { authorization: 'Bearer ' + token } : {}) } }, res);
    return res;
  };
}
function world(extra = {}) { return { mail: [], passwords: {}, tokens: {}, ...extra }; }
const codeFrom = mail => /verification code: (\d{6})/.exec(mail.subject)[1];
let n = 0;
const fresh = () => `person${++n}@nova.test`;

test.before(async () => { if (!skip) db = await freshDb(); });

/* ---------------------------------------------------------------- SEC-06 */
test('twenty wrong codes sent at once are twenty guesses: six count, the rest are refused', { skip }, async () => {
  const s = world(), email = fresh();
  assert.equal((await handler('signup-start.js', s)({ email, company: NOVA, full_name: 'Guess Who' })).code, 200);
  const right = codeFrom(s.mail[0]);
  const wrong = right === '000000' ? '111111' : '000000';
  const complete = handler('signup-complete.js', s);
  const results = await Promise.all(Array.from({ length: 20 }, () => complete({ email, code: wrong, password: 'secret-pass' })));
  const codes = results.map(r => r.code).sort();
  assert.deepEqual(codes, [...Array(6).fill(401), ...Array(14).fill(429)]);
  assert.equal((await svc(`select attempts from pending_signups where email = $1`, [email]))[0].attempts, 6, 'the old code stored 1');
  assert.equal((await complete({ email, code: right, password: 'secret-pass' })).code, 429, 'the right code is too late now');
  assert.equal((await svc(`select count(*)::int n from auth.users where email = $1`, [email]))[0].n, 0);
});

test('resend: parallel requests send one code; five an hour at most; a failed email can be retried at once', { skip }, async () => {
  const s = world(), email = fresh();
  const start = handler('signup-start.js', s);
  const results = await Promise.all(Array.from({ length: 5 }, () => start({ email, company: NOVA })));
  assert.deepEqual(results.map(r => r.code).sort(), [200, 429, 429, 429, 429]);
  assert.equal(s.mail.length, 1);
  for (let i = 0; i < 4; i++) {
    await svc(`update pending_signups set sent_at = now() - interval '2 minutes' where email = $1`, [email]);
    assert.equal((await start({ email, company: NOVA })).code, 200);
  }
  await svc(`update pending_signups set sent_at = now() - interval '2 minutes' where email = $1`, [email]);
  const sixth = await start({ email, company: NOVA });
  assert.equal(sixth.code, 429);
  assert.equal(sixth.body.error, 'too_many_codes');
  // A mail server failure takes the code back, so asking again works straight away.
  const t = world({ mailFails: true }), other = fresh();
  assert.equal((await handler('signup-start.js', t)({ email: other, company: NOVA })).code, 502);
  t.mailFails = false;
  assert.equal((await handler('signup-start.js', t)({ email: other, company: NOVA })).code, 200);
});

test('expiry, a code used twice in parallel, and a used code', { skip }, async () => {
  const s = world(), email = fresh();
  await handler('signup-start.js', s)({ email, company: NOVA, full_name: 'Twice Over' });
  const code = codeFrom(s.mail[0]);
  const complete = handler('signup-complete.js', s);
  await svc(`update pending_signups set expires_at = now() - interval '1 second' where email = $1`, [email]);
  assert.equal((await complete({ email, code, password: 'secret-pass' })).code, 410);
  await svc(`update pending_signups set expires_at = now() + interval '10 minutes' where email = $1`, [email]);
  const both = await Promise.all([complete({ email, code, password: 'secret-pass' }), complete({ email, code, password: 'other-pass' })]);
  assert.deepEqual(both.map(r => r.code).sort(), [200, 409]);
  assert.equal((await svc(`select count(*)::int n from auth.users where email = $1`, [email]))[0].n, 1, 'one account');
  assert.equal((await complete({ email, code, password: 'secret-pass' })).code, 410, 'the code is used up');
});

test('per-network limit: one address cannot ask for codes for endless mailboxes', { skip }, async () => {
  const s = world();
  const start = handler('signup-start.js', s);
  const ip = '198.51.100.9';
  for (let i = 0; i < 30; i++) assert.equal((await start({ email: fresh(), company: NOVA }, { ip })).code, 200);
  assert.equal((await start({ email: fresh(), company: NOVA }, { ip })).code, 429);
  assert.equal((await start({ email: fresh(), company: NOVA }, { ip: '198.51.100.10' })).code, 200, 'another network is unaffected');
});

test('storage errors refuse rather than guess', { skip }, async () => {
  const s = world({ offline: true }), email = fresh();
  assert.equal((await handler('signup-start.js', s)({ email, company: NOVA })).code, 503);
  assert.equal(s.mail.length, 0);
  assert.equal((await handler('signup-complete.js', s)({ email, code: '123456', password: 'secret-pass' })).code, 503);
});

/* ---------------------------------------------------------------- SEC-01 */
async function signUp(s, email, company, body = {}) {
  const r1 = await handler('signup-start.js', s)({ email, company, full_name: 'New Joiner' });
  assert.equal(r1.code, 200, JSON.stringify(r1.body));
  const code = codeFrom(s.mail[s.mail.length - 1]);
  return { start: r1, done: await handler('signup-complete.js', s)({ email, code, password: 'secret-pass', ...body }) };
}

test('without an invitation the new account waits for approval; with one it is active', { skip }, async () => {
  const s = world();
  const stranger = fresh();
  const a = await signUp(s, stranger, NOVA);
  assert.equal(a.start.body.invited, false);
  assert.deepEqual([a.done.code, a.done.body.status], [200, 'pending']);
  const p = (await svc(`select status, email_verified, company from profiles where email = $1`, [stranger]))[0];
  assert.deepEqual(p, { status: 'pending', email_verified: true, company: NOVA });

  const M = await makeUser(db, { email: 'inviter@nova.test', name: 'Inviter', company: NOVA, role: 'manager' });
  const invited = fresh();
  await svc(`select public.ws_invite_record($1, $2, $3)`, [invited, NOVA, M]);
  const b = await signUp(s, invited, NOVA);
  assert.equal(b.start.body.invited, true);
  assert.deepEqual([b.done.code, b.done.body.status], [200, 'active']);
  assert.ok((await svc(`select accepted_at from ws_invitations where email = $1`, [invited]))[0].accepted_at, 'the invitation is used');
});

test('an invitation for another company, an expired one or a revoked one does not make anyone active', { skip }, async () => {
  const s = world();
  const wrongCo = fresh();
  await svc(`select public.ws_invite_record($1, $2, null)`, [wrongCo, JOBWAYS]);
  assert.equal((await signUp(s, wrongCo, NOVA)).done.body.status, 'pending');
  const expired = fresh();
  await svc(`select public.ws_invite_record($1, $2, null)`, [expired, NOVA]);
  await svc(`update ws_invitations set expires_at = now() - interval '1 day' where email = $1`, [expired]);
  assert.equal((await signUp(s, expired, NOVA)).done.body.status, 'pending');
  const revoked = fresh();
  await svc(`select public.ws_invite_record($1, $2, null)`, [revoked, NOVA]);
  await svc(`update ws_invitations set revoked_at = now() where email = $1`, [revoked]);
  assert.equal((await signUp(s, revoked, NOVA)).done.body.status, 'pending');
});

test('the company is the one the code was sent for; it cannot be swapped at the last step', { skip }, async () => {
  const s = world(), email = fresh();
  await handler('signup-start.js', s)({ email, company: NOVA });
  const code = codeFrom(s.mail[0]);
  const complete = handler('signup-complete.js', s);
  const swapped = await complete({ email, code, password: 'secret-pass', company: JOBWAYS });
  assert.deepEqual([swapped.code, swapped.body.error], [400, 'company_changed']);
  const ok = await complete({ email, code, password: 'secret-pass' });
  assert.equal(ok.code, 200);
  assert.equal((await svc(`select company from profiles where email = $1`, [email]))[0].company, NOVA);
});

test('an existing address cannot sign up again, and someone else\'s account is never taken over', { skip }, async () => {
  const s = world();
  const email = fresh();
  await signUp(s, email, NOVA);
  assert.equal((await handler('signup-start.js', s)({ email, company: NOVA })).code, 409);
  // An account made elsewhere between the two steps (say a direct Supabase sign-up) is not ours.
  const victim = fresh();
  await handler('signup-start.js', s)({ email: victim, company: NOVA });
  const code = codeFrom(s.mail[s.mail.length - 1]);
  await svc(`insert into auth.users (email, raw_user_meta_data) values ($1, '{"signup_ref":"someone-else"}')`, [victim]);
  const r = await handler('signup-complete.js', s)({ email: victim, code, password: 'secret-pass' });
  assert.deepEqual([r.code, r.body.error], [409, 'already_registered']);
  assert.equal((await svc(`select status from profiles where email = $1`, [victim]))[0].status, 'pending', 'and it stays pending');
});

/* ---------------------------------------------------------------- BUG-03 */
test('a sign-up that fails part way says so, and the same code finishes it', { skip }, async () => {
  const s = world({ failRpc: { ws_signup_finish: 1 } }), email = fresh();
  await handler('signup-start.js', s)({ email, company: NOVA, full_name: 'Half Way' });
  const code = codeFrom(s.mail[0]);
  const complete = handler('signup-complete.js', s);
  const first = await complete({ email, code, password: 'first-pass' });
  assert.deepEqual([first.code, first.body.error], [502, 'not_finished'], 'no false success');
  const row = (await svc(`select created_user_id, verified_at from pending_signups where email = $1`, [email]))[0];
  assert.ok(row.created_user_id && row.verified_at, 'the code is not burnt');
  const again = await complete({ email, code, password: 'second-pass' });
  assert.deepEqual([again.code, again.body.status], [200, 'pending']);
  assert.equal((await svc(`select count(*)::int n from auth.users where email = $1`, [email]))[0].n, 1, 'no second account');
  assert.equal(s.passwords[row.created_user_id], 'second-pass', 'the password typed last is the one that works');
  assert.equal((await svc(`select email_verified from profiles where email = $1`, [email]))[0].email_verified, true);
  assert.equal((await svc(`select count(*)::int n from pending_signups where email = $1`, [email]))[0].n, 0);
});

test('an account created before the server stopped is recognised on the retry (signup_ref)', { skip }, async () => {
  const s = world({ failRpc: { ws_signup_mark_created: 1 } }), email = fresh();
  await handler('signup-start.js', s)({ email, company: NOVA });
  const code = codeFrom(s.mail[0]);
  const complete = handler('signup-complete.js', s);
  assert.equal((await complete({ email, code, password: 'secret-pass' })).code, 502);
  const r = await complete({ email, code, password: 'secret-pass' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal((await svc(`select count(*)::int n from auth.users where email = $1`, [email]))[0].n, 1);
});

test('a create call that returns no user id is not reported as success', { skip }, async () => {
  const s = world({ createDropsId: true }), email = fresh();
  await handler('signup-start.js', s)({ email, company: NOVA });
  const r = await handler('signup-complete.js', s)({ email, code: codeFrom(s.mail[0]), password: 'secret-pass' });
  assert.equal(r.code, 502);
  assert.notEqual(r.body.success, true);
});

/* ------------------------------------------------- verify.js (existing accounts) */
async function unverifiedUser(email) {
  const id = await makeUser(db, { email, name: 'Old Timer', company: NOVA });
  await svc(`update profiles set email_verified = false where id = $1`, [id]);
  const token = 'tok-' + id;
  return { id, token, user: { id, email } };
}

test('verify: parallel wrong codes all count, the right one verifies and is used up together', { skip }, async () => {
  const { id, token, user } = await unverifiedUser(fresh());
  const s = world({ tokens: { [token]: user } });
  const verify = handler('verify.js', s);
  assert.equal((await verify({ full_name: 'Old Timer' }, { token, query: { fn: 'send' } })).code, 200);
  const code = codeFrom(s.mail[0]);
  const wrong = code === '000000' ? '111111' : '000000';
  const results = await Promise.all(Array.from({ length: 10 }, () => verify({ code: wrong }, { token, query: { fn: 'check' } })));
  assert.deepEqual(results.map(r => r.code).sort(), [...Array(6).fill(401), ...Array(4).fill(429)]);
  assert.equal((await svc(`select attempts from signup_verifications where user_id = $1`, [id]))[0].attempts, 6);
  // A new code (after the minute) starts a fresh count; the right code verifies.
  await svc(`update signup_verifications set sent_at = now() - interval '2 minutes' where user_id = $1`, [id]);
  await verify({}, { token, query: { fn: 'send' } });
  const ok = await verify({ code: codeFrom(s.mail[1]) }, { token, query: { fn: 'check' } });
  assert.deepEqual([ok.code, ok.body.success], [200, true]);
  assert.equal((await svc(`select email_verified from profiles where id = $1`, [id]))[0].email_verified, true);
  assert.equal((await svc(`select count(*)::int n from signup_verifications where user_id = $1`, [id]))[0].n, 0);
});

test('verify: when the profile cannot be saved the reply is an error and the code still works', { skip }, async () => {
  const { id, token, user } = await unverifiedUser(fresh());
  const s = world({ tokens: { [token]: user } });
  const verify = handler('verify.js', s);
  await verify({}, { token, query: { fn: 'send' } });
  const code = codeFrom(s.mail[0]);
  s.failRpc = { ws_verify_code_check: 1 };
  const failed = await verify({ code }, { token, query: { fn: 'check' } });
  assert.ok(failed.code >= 500, `got ${failed.code}`);
  assert.notEqual(failed.body.success, true, 'the old handler said {success:true} here');
  assert.equal((await svc(`select email_verified from profiles where id = $1`, [id]))[0].email_verified, false);
  assert.equal((await svc(`select count(*)::int n from signup_verifications where user_id = $1`, [id]))[0].n, 1, 'code kept');
  assert.equal((await verify({ code }, { token, query: { fn: 'check' } })).code, 200);
});

test('verify: a pending or offboarded account, or an aal1 token with an authenticator, is refused', { skip }, async () => {
  const { id, token, user } = await unverifiedUser(fresh());
  const s = world({ tokens: { [token]: user } });
  const verify = handler('verify.js', s);
  await svc(`update profiles set status = 'inactive' where id = $1`, [id]);
  assert.equal((await verify({}, { token, query: { fn: 'send' } })).code, 403);
  await svc(`update profiles set status = 'active' where id = $1`, [id]);
  s.tokens[token] = { ...user, factors: [{ id: 'f1', status: 'verified' }] };
  const r = await verify({}, { token, query: { fn: 'send' } });
  assert.deepEqual([r.code, r.body.error], [403, 'ws_access:mfa_required']);
  assert.equal(s.mail.length, 0);
});

test('verify (database): a code checked for an account with no profile changes nothing', { skip }, async () => {
  const [u] = await svc(`insert into auth.users (email) values ($1) returning id`, [fresh()]);
  await svc(`select public.ws_verify_code_issue($1, $2)`, [u.id, sha256('123456')]);
  await svc(`delete from profiles where id = $1`, [u.id]);
  await assert.rejects(svc(`select public.ws_verify_code_check($1, $2)`, [u.id, sha256('123456')]), /profile for this account is missing/);
  const row = (await svc(`select attempts from signup_verifications where user_id = $1`, [u.id]))[0];
  assert.equal(row.attempts, 0, 'rolled back with the failed update: neither verified nor used up');
});
