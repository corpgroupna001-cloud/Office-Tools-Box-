// supabase-access-control-migration.sql (migration 16) on PGlite:
// sign-up needs an invitation or an approval (SEC-01), the session gate —
// active account, second step done, session not ended (SEC-02, SEC-03) —
// private HR columns (SEC-04), and the upgrade of a database that already
// has people and records in it.
//
// Skips itself when the dev dependency is missing: npm i -D @electric-sql/pglite
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, as, makeUser, sqlOf, pglite } = require('./fixtures/load-db');

const skip = pglite() ? false : 'PGlite is not installed (npm i -D @electric-sql/pglite)';
const NOVA = 'Nova Sportsmart Private Limited';
const JOBWAYS = 'Jobways Point LLP';
const DENIED = /permission denied/;
const GATE = 'supabase-access-control-migration.sql';
const OTP = 'supabase-otp-limits-migration.sql';

let db, A, C, M, X;      // A, C Nova employees; M Nova manager; X workspace admin

const q = async (uid, sql, params, claims) => (await as(db, uid, () => db.query(sql, params), claims)).rows;
const svc = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (uid, sql, params, claims) => (await q(uid, sql, params, claims))[0];
const json = v => (typeof v === 'string' ? JSON.parse(v) : v);

/** A login made the way Supabase Auth makes one (direct sign-up, or the admin API): the trigger writes the profile. */
async function authUser(email, company = NOVA) {
  const r = await svc(`insert into auth.users (email, raw_user_meta_data) values ($1, jsonb_build_object('full_name', 'New Person', 'company', $2::text)) returning id`, [email, company]);
  return r[0].id;
}
/** Something private to A's company that every active colleague can read. */
async function companyTask(uid) {
  return (await one(uid, `insert into tasks (title) values ('Quarter plan') returning id`)).id;
}

test.before(async () => {
  if (skip) return;
  db = await freshDb({ twice: true });
  M = await makeUser(db, { email: 'maya@nova.test', name: 'Maya Manager', company: NOVA, role: 'manager' });
  A = await makeUser(db, { email: 'anil@nova.test', name: 'Anil Kumar', company: NOVA, manager_id: M });
  C = await makeUser(db, { email: 'chitra@nova.test', name: 'Chitra Rao', company: NOVA });
  X = await makeUser(db, { email: 'asha@nova.test', name: 'Asha Admin', company: NOVA, role: 'admin' });
});

/* ------------------------------------------------------------- SEC-01 */
test('a login made straight through Supabase Auth is pending and sees nothing', { skip }, async () => {
  const task = await companyTask(A);
  const P = await authUser('stranger@gmail.test');
  assert.equal((await svc(`select status from profiles where id = $1`, [P]))[0].status, 'pending');
  assert.equal((await q(P, `select id from tasks where id = $1`, [task])).length, 0, 'no company tasks');
  assert.equal((await q(P, `select id from profiles`)).length, 0, 'not even the directory');
  assert.equal((await q(P, `select id from crm_contacts`)).length, 0);
  await assert.rejects(q(P, `insert into tasks (title) values ('sneaky')`), /row-level security/);
  assert.equal((await one(P, `select public.ws_role() r`)).r, 'none');
  assert.equal((await one(P, `select public.ws_same_company($1) ok`, [NOVA])).ok, false);
  const me = json((await one(P, `select public.ws_my_access() a`)).a);
  assert.equal(me.access, 'pending');
  assert.equal(me.company, NOVA);
  // Approved by an administrator (service key): in.
  await svc(`update profiles set status = 'active' where id = $1`, [P]);
  assert.equal((await q(P, `select id from tasks where id = $1`, [task])).length, 1);
});

test('nobody can make themselves active, or an admin, through their own profile', { skip }, async () => {
  const P = await authUser('self-promoter@nova.test');
  assert.equal((await q(P, `update profiles set status = 'active', app_role = 'admin' where id = $1 returning id`, [P])).length, 0, 'a pending account cannot touch any row');
  await assert.rejects(q(A, `update profiles set status = 'pending', app_role = 'admin' where id = $1`, [A]), /administrator/, 'nor can an active one change these');
  assert.equal((await svc(`select status from profiles where id = $1`, [P]))[0].status, 'pending');
  // Without a profile row the gate refuses the insert outright…
  await svc(`delete from profiles where id = $1`, [P]);
  const insert = `insert into profiles (id, email, full_name, company, status, app_role, email_verified) values ($1, 'x@nova.test', 'X', $2, 'active', 'admin', true)`;
  await assert.rejects(q(P, insert, [P, NOVA]), /row-level security/);
  // …and should the gate ever be missing, the row still carries none of the administrator's columns.
  await svc(`drop policy ws_session_gate on public.profiles`);
  try {
    await q(P, insert, [P, NOVA]);
    const row = (await svc(`select status, app_role, email_verified from profiles where id = $1`, [P]))[0];
    assert.deepEqual(row, { status: 'pending', app_role: 'employee', email_verified: false });
  } finally {
    await svc(`select public.ws_apply_session_gate()`);
  }
});

test('invitations: one per address and company, claimed once, not after expiry or revocation', { skip }, async () => {
  const id1 = (await svc(`select public.ws_invite_record('New.Hire@Nova.test ', $1, $2) id`, [NOVA, M]))[0].id;
  const id2 = (await svc(`select public.ws_invite_record('new.hire@nova.test', $1, $2) id`, [NOVA, M]))[0].id;
  assert.equal(id1, id2, 'sending again extends the same invitation');
  assert.equal((await svc(`select public.ws_invite_open('new.hire@nova.test', $1) ok`, [NOVA]))[0].ok, true);
  assert.equal((await svc(`select public.ws_invite_open('new.hire@nova.test', $1) ok`, [JOBWAYS]))[0].ok, false, 'another company is not invited');
  const U = await authUser('new.hire@nova.test');
  const claims = await Promise.all([1, 2, 3].map(() => svc(`select public.ws_invite_claim('new.hire@nova.test', $1, $2) ok`, [NOVA, U])));
  assert.deepEqual(claims.map(r => r[0].ok).sort(), [false, false, true], 'claimed exactly once');
  assert.equal((await svc(`select public.ws_invite_claim('new.hire@nova.test', $1, $2) ok`, [NOVA, U]))[0].ok, false, 'used up');
  await svc(`select public.ws_invite_record('late@nova.test', $1, null)`, [NOVA]);
  await svc(`update ws_invitations set expires_at = now() - interval '1 minute' where email = 'late@nova.test'`);
  assert.equal((await svc(`select public.ws_invite_claim('late@nova.test', $1, $2) ok`, [NOVA, U]))[0].ok, false, 'expired');
  await svc(`select public.ws_invite_record('gone@nova.test', $1, null)`, [NOVA]);
  await svc(`update ws_invitations set revoked_at = now() where email = 'gone@nova.test'`);
  assert.equal((await svc(`select public.ws_invite_claim('gone@nova.test', $1, $2) ok`, [NOVA, U]))[0].ok, false, 'revoked');
  // Browsers cannot read or write invitations, or call the server functions.
  await assert.rejects(q(A, `select * from ws_invitations`), DENIED);
  await assert.rejects(q(A, `select public.ws_invite_record('me@x.test', $1, null)`, [NOVA]), DENIED);
  await assert.rejects(q(A, `select public.ws_invite_claim('new.hire@nova.test', $1, $2)`, [NOVA, A]), DENIED);
});

/* ---------------------------------------------------------- SEC-03 */
test('offboarding: a token issued before someone left stops working at once', { skip }, async () => {
  const L = await makeUser(db, { email: 'leaver@nova.test', name: 'Lee Leaver', company: NOVA });
  const sess = (await svc(`insert into auth.sessions (user_id) values ($1) returning id`, [L]))[0].id;
  const claims = { session_id: sess, aal: 'aal1' };
  const task = await companyTask(A);
  assert.equal((await q(L, `select id from tasks where id = $1`, [task], claims)).length, 1, 'before: an employee');
  // The admin console marks them inactive; even if the login ban call failed, the database refuses them.
  await svc(`update profiles set status = 'inactive', exit_date = current_date, exit_reason = 'Resigned' where id = $1`, [L]);
  assert.equal((await q(L, `select id from tasks where id = $1`, [task], claims)).length, 0);
  assert.equal((await q(L, `select id from profiles`, [], claims)).length, 0);
  await assert.rejects(q(L, `update profiles set full_name = 'Still here' where id = $1`, [L], claims).then(r => { if (!r.length) throw new Error('permission denied: no row'); }), DENIED);
  await assert.rejects(q(L, `insert into storage.objects (bucket_id, name) values ('documents', $1)`, [`${L}/x.pdf`], claims), /row-level security/);
  assert.equal(json((await one(L, `select public.ws_my_access() a`, [], claims)).a).access, 'inactive');
  // History is kept.
  assert.equal((await svc(`select count(*)::int n from tasks where id = $1`, [task]))[0].n, 1);
});

test('ending sessions: a token whose session is gone is refused, other sessions are not', { skip }, async () => {
  const S = await makeUser(db, { email: 'sam@nova.test', name: 'Sam Sessions', company: NOVA });
  const [s1, s2] = [(await svc(`insert into auth.sessions (user_id) values ($1) returning id`, [S]))[0].id,
                    (await svc(`insert into auth.sessions (user_id) values ($1) returning id`, [S]))[0].id];
  await svc(`insert into auth.refresh_tokens (token, user_id, session_id) values ('r1', $1, $2), ('legacy', $1, null)`, [String(S), s1]);
  assert.equal((await q(S, `select id from profiles where id = $1`, [S], { session_id: s1 })).length, 1);
  await svc(`delete from auth.sessions where id = $1`, [s1]);       // signed out on one device
  assert.equal((await q(S, `select id from profiles where id = $1`, [S], { session_id: s1 })).length, 0);
  assert.equal(json((await one(S, `select public.ws_my_access() a`, [], { session_id: s1 })).a).access, 'session_ended');
  assert.equal((await q(S, `select id from profiles where id = $1`, [S], { session_id: s2 })).length, 1, 'the other device is fine');
  // The admin console ends them all when someone leaves.
  assert.equal((await svc(`select public.ws_end_sessions($1) n`, [S]))[0].n, 1);
  assert.equal((await q(S, `select id from profiles where id = $1`, [S], { session_id: s2 })).length, 0);
  assert.equal((await svc(`select count(*)::int n from auth.refresh_tokens where user_id = $1`, [String(S)]))[0].n, 0, 'refresh tokens go too');
  await assert.rejects(q(A, `select public.ws_end_sessions($1)`, [S]), DENIED, 'not callable from a browser');
});

/* ---------------------------------------------------------- SEC-02 */
test('two-step verification: with an authenticator set up, an aal1 token gets nothing; aal2 does', { skip }, async () => {
  const F = await makeUser(db, { email: 'fatima@nova.test', name: 'Fatima Factor', company: NOVA });
  const task = await companyTask(A);
  await svc(`insert into auth.mfa_factors (user_id, status) values ($1, 'unverified')`, [F]);
  assert.equal((await q(F, `select id from tasks where id = $1`, [task], { aal: 'aal1' })).length, 1, 'an unfinished set-up does not lock anyone out');
  await svc(`update auth.mfa_factors set status = 'verified' where user_id = $1`, [F]);
  assert.equal((await q(F, `select id from tasks where id = $1`, [task], { aal: 'aal1' })).length, 0, 'password only: refused');
  assert.equal((await q(F, `select id from tasks where id = $1`, [task])).length, 0, 'no aal claim counts as aal1');
  await assert.rejects(q(F, `insert into tasks (title) values ('x')`, [], { aal: 'aal1' }), /row-level security/);
  assert.equal((await one(F, `select public.ws_is_manager() ok`, [], { aal: 'aal1' })).ok, false);
  const me = json((await one(F, `select public.ws_my_access() a`, [], { aal: 'aal1' })).a);
  assert.equal(me.access, 'mfa_required');
  assert.equal(me.mfa_enrolled, true);
  assert.equal((await q(F, `select id from tasks where id = $1`, [task], { aal: 'aal2' })).length, 1, 'after the code: in');
  // Recovery: an administrator removes the lost authenticator; the password alone works again.
  await svc(`delete from auth.mfa_factors where user_id = $1`, [F]);
  assert.equal((await q(F, `select id from tasks where id = $1`, [task], { aal: 'aal1' })).length, 1);
});

test('the PostgREST pre-request check names the reason and lets ws_my_access through', { skip }, async () => {
  const P = await authUser('waiting@nova.test');
  await assert.rejects(q(P, `select public.ws_pre_request()`), err => {
    assert.match(err.message, /cannot use WorkSuite data \(pending\)/);
    assert.equal(err.code, '42501');
    assert.equal(err.hint, 'ws_access:pending');
    return true;
  });
  await as(db, P, async () => {
    await db.query(`select set_config('request.path', '/rpc/ws_my_access', false)`);
    try { await db.query(`select public.ws_pre_request()`); }
    finally { await db.query(`select set_config('request.path', '', false)`); }
  });
  await q(A, `select public.ws_pre_request()`);                                      // active: no error
  await db.exec('set role anon');
  try { await db.query(`select public.ws_pre_request()`); } finally { await db.exec('reset role'); }
});

test('every table with RLS, and storage, carries the session gate', { skip }, async () => {
  const missing = await svc(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                              where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
                                and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname
                                                  and p.policyname = 'ws_session_gate' and p.permissive = 'RESTRICTIVE')`);
  assert.deepEqual(missing.map(r => r.relname), [], 'a migration added a table without calling ws_apply_session_gate()');
  assert.equal((await svc(`select count(*)::int n from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'ws_session_gate'`))[0].n, 1);
  const status = json((await svc(`select public.ws_access_control_status() s`))[0].s);
  assert.equal(status.tables_gated, status.tables_with_rls);
  assert.equal(status.storage_gated, true);
  assert.equal(status.private_columns_hidden, true);
  await assert.rejects(q(X, `select public.ws_access_control_status()`), DENIED, 'the health check is the server\'s');
});

/* ---------------------------------------------------------- SEC-04 */
test('private HR columns: nobody reads them with their own token; the directory still works', { skip }, async () => {
  await svc(`update profiles set exit_date = '2026-09-30', exit_reason = 'Performance concerns' where id = $1`, [C]);
  for (const [who, uid] of [['employee', A], ['manager', M], ['workspace admin', X]]) {
    await assert.rejects(q(uid, `select exit_reason from profiles where id = $1`, [C]), DENIED, who);
    await assert.rejects(q(uid, `select exit_date from profiles where id = $1`, [C]), DENIED, who);
    await assert.rejects(q(uid, `select * from profiles where id = $1`, [C]), DENIED, `${who}: select *`);
    await assert.rejects(q(uid, `select to_jsonb(p) from profiles p where id = $1`, [C]), DENIED, `${who}: whole row`);
  }
  await assert.rejects(q(C, `select exit_reason from profiles where id = $1`, [C]), DENIED, 'not even their own');
  // What the directory, chat and org chart read is unchanged.
  const row = await one(A, `select id, full_name, email, company, department, job_title, phone, manager_id, status, avatar_url, employee_id, app_role
                            from profiles where id = $1`, [C]);
  assert.equal(row.full_name, 'Chitra Rao');
  // Editing your own profile still works.
  assert.equal((await one(A, `update profiles set full_name = 'Anil K' where id = $1 returning full_name`, [A])).full_name, 'Anil K');
  await q(A, `insert into profiles (id, email, avatar_url) values ($1, 'anil@nova.test', 'data:x') on conflict (id) do update set avatar_url = excluded.avatar_url`, [A]);
  // Workspace admins read them through the function; others get nothing.
  const priv = json((await one(X, `select public.ws_profile_private($1) p`, [C])).p);
  assert.equal(priv.exit_reason, 'Performance concerns');
  assert.equal((await one(M, `select public.ws_profile_private($1) p`, [C])).p, null);
  assert.equal((await one(A, `select public.ws_profile_private($1) p`, [C])).p, null);
});

/* --------------------------------------------------------- upgrade */
test('upgrading a database that already has people and records keeps everyone working', { skip }, async () => {
  const old = await freshDb({ without: [GATE, OTP] });
  const P = await makeUser(old, { email: 'priya@nova.test', name: 'Priya', company: NOVA });
  const Q = await makeUser(old, { email: 'quinn@nova.test', name: 'Quinn', company: NOVA });
  await old.query(`update profiles set status = 'inactive' where id = $1`, [Q]);
  const t = (await as(old, P, () => old.query(`insert into tasks (title) values ('Before the upgrade') returning id`))).rows[0].id;
  for (const f of [GATE, OTP, GATE, OTP]) await old.exec(sqlOf(f));               // in order, then again: idempotent
  const statuses = (await old.query(`select id, status from profiles where id in ($1, $2)`, [P, Q])).rows;
  assert.equal(statuses.find(r => r.id === P).status, 'active', 'existing people keep their status');
  assert.equal(statuses.find(r => r.id === Q).status, 'inactive');
  assert.equal((await as(old, P, () => old.query(`select title from tasks where id = $1`, [t]))).rows[0].title, 'Before the upgrade');
  assert.equal((await as(old, Q, () => old.query(`select id from tasks where id = $1`, [t]))).rows.length, 0, 'someone who already left is shut out');
  await old.close();
});
