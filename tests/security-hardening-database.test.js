// supabase-security-hardening-migration.sql on PGlite: notification links,
// admin-owned profile columns, WFH QC, internal helpers and anonymous
// callers, signup codes, and files carried by chat messages.
//
// Skips itself when the dev dependency is missing: npm i -D @electric-sql/pglite
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, as, makeUser, pglite } = require('./fixtures/load-db');

const skip = pglite() ? false : 'PGlite is not installed (npm i -D @electric-sql/pglite)';
const NOVA = 'Nova Sportsmart Private Limited';
const JOBWAYS = 'Jobways Point LLP';
const ADMIN_ONLY = /can only be changed by an administrator/;

let db, M, A, C, X;          // M Nova manager; A, C Nova employees; X admin

const q = async (uid, sql, params) => (await as(db, uid, () => db.query(sql, params))).rows;
const svc = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (uid, sql, params) => (await q(uid, sql, params))[0];
async function anon(sql, params) {
  await db.exec('set role anon');
  try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); }
}

test.before(async () => {
  if (skip) return;
  db = await freshDb({ twice: true });
  M = await makeUser(db, { email: 'maya@nova.test', name: 'Maya Manager', company: NOVA, role: 'manager' });
  A = await makeUser(db, { email: 'anil@nova.test', name: 'Anil Kumar', company: NOVA });
  C = await makeUser(db, { email: 'chitra@nova.test', name: 'Chitra Rao', company: NOVA });
  X = await makeUser(db, { email: 'admin@nova.test', name: 'Asha Admin', company: NOVA, role: 'admin' });
});

test('notification links are in-app paths or nothing', { skip }, async () => {
  const urls = ['javascript:alert(1)', 'https://evil.test/x', '//evil.test', '/\\evil.test', '/deals/?id=1', '/'];
  for (const u of urls) await q(A, `insert into notifications (user_id, actor_id, kind, title, url) values ($1, $2, 'mention', 't', $3)`, [C, A, u]);
  const got = (await q(C, `select url from notifications order by created_at, id`)).map(r => r.url);
  assert.deepEqual(got.sort(), [null, null, null, null, '/', '/deals/?id=1'].sort());
  await q(A, `select public.ws_notify($1, 'x', 't', null, 'javascript:alert(2)')`, [C]);
  assert.equal((await q(C, `select count(*)::int n from notifications where url like 'javascript%'`))[0].n, 0);
});

test('people cannot change admin-owned columns of their own profile', { skip }, async () => {
  for (const [col, v] of [['company2', JOBWAYS], ['is_wfh', true], ['manager_id', M], ['employee_code', '9999'],
                          ['status', 'inactive'], ['department', 'Sales'], ['job_title', 'CEO']]) {
    await assert.rejects(q(A, `update profiles set ${col} = $2 where id = $1`, [A, v]), ADMIN_ONLY, col);
  }
  await assert.rejects(q(A, `update profiles set email_verified = not coalesce(email_verified, false) where id = $1`, [A]), ADMIN_ONLY, 'email_verified');
  await assert.rejects(q(A, `update profiles set company = $2 where id = $1`, [A, JOBWAYS]), ADMIN_ONLY, 'the company is picked once');
  await assert.rejects(q(A, `update profiles set email = 'me@evil.test' where id = $1`, [A]), /email settings/);
  // What people do edit keeps working.
  assert.equal((await one(A, `update profiles set full_name = 'Anil K', avatar_url = 'x', last_seen_at = now() where id = $1 returning full_name`, [A])).full_name, 'Anil K');
  // The admin console (service role) and an admin on their own row still manage everything.
  assert.equal((await svc(`update profiles set company2 = $2, department = 'Sales' where id = $1 returning company2`, [A, JOBWAYS]))[0].company2, JOBWAYS);
  assert.equal((await one(X, `update profiles set department = 'Board' where id = $1 returning department`, [X])).department, 'Board');
  await svc(`update profiles set company2 = null where id = $1`, [A]);
});

test('the company can be chosen once, from the known companies', { skip }, async () => {
  const N = await makeUser(db, { email: 'new@x.test', name: 'New Person', company: null });
  await svc(`update profiles set company = null where id = $1`, [N]);
  await assert.rejects(q(N, `update profiles set company = 'Made Up Ltd' where id = $1`, [N]), /Unknown company/);
  assert.equal((await one(N, `update profiles set company = $2 where id = $1 returning company`, [N, JOBWAYS])).company, JOBWAYS);
  await assert.rejects(q(N, `update profiles set company = $2 where id = $1`, [N, NOVA]), ADMIN_ONLY);
});

test('WFH clips: nobody approves their own; a new clip goes back to review', { skip }, async () => {
  const r = await one(A, `insert into wfh_recordings (user_id, week_of, status, reviewed_at) values ($1, '2026-09-14', 'approved', now()) returning status, reviewed_at`, [A]);
  assert.deepEqual(r, { status: 'pending', reviewed_at: null });
  const id = (await svc(`update wfh_recordings set status = 'approved', reviewed_at = now() where user_id = $1 returning id`, [A]))[0].id;
  assert.equal((await one(A, `update wfh_recordings set status = 'approved', review_note = 'fine' where id = $1 returning status, review_note`, [id])).review_note, null);
  assert.equal((await one(A, `select status from wfh_recordings where id = $1`, [id])).status, 'approved', 'an unrelated update keeps the review');
  assert.equal((await one(A, `update wfh_recordings set mobile_path = 'a/b.webm' where id = $1 returning status`, [id])).status, 'pending');
});

test('internal helpers are closed to anonymous callers; crm_log stays in the caller company', { skip }, async () => {
  for (const sql of [`select public.crm_log('x', 'lead', gen_random_uuid(), 'l', '{}', '${NOVA}')`,
                     `select public.ws_notify(gen_random_uuid(), 'k', 't')`,
                     `select public.next_invoice_number('${NOVA}')`,
                     `select public.invoice_recalc(gen_random_uuid())`]) {
    await assert.rejects(anon(sql), /permission denied/, sql);
  }
  await assert.rejects(q(A, `select public.next_invoice_number($1)`, [NOVA]), /permission denied/, 'numbers are only drawn by the invoice trigger');
  await assert.rejects(q(A, `select public.crm_log('call.logged', 'lead', gen_random_uuid(), 'x', '{}', $1)`, [JOBWAYS]), /Not allowed/);
  assert.ok((await one(A, `select public.crm_log('call.logged', 'lead', gen_random_uuid(), 'x') id`)).id, 'its own company is fine');
  // Invoices still get numbers through the trigger.
  const inv = await one(M, `insert into invoices (bill_to_name) values ('Acme') returning invoice_number`);
  assert.match(inv.invoice_number, /^INV-\d{4}-\d{4}$/);
});

test('signup codes are invisible to the browser', { skip }, async () => {
  await svc(`insert into signup_verifications (user_id, code_hash, expires_at) values ($1, 'h', now() + interval '10 minutes')`, [A]);
  assert.equal((await q(A, `select * from signup_verifications`)).length, 0);
  assert.equal((await q(A, `update signup_verifications set attempts = 0 returning user_id`)).length, 0);
});

test('a chat message can only carry a file its sender can see', { skip }, async () => {
  const mine = `${A}/1-abc-report.pdf`;
  await q(A, `insert into messages (sender_id, recipient_id, body) values ($1, $2, $3)`, [A, C, `__FILE__::${mine}::report.pdf`]);
  // C received it, so C may forward it.
  await q(C, `insert into messages (sender_id, recipient_id, body) values ($1, $2, $3)`, [C, M, `__FILE__::${mine}::report.pdf`]);
  // M never saw this one; a guessed path is refused.
  const other = `${A}/2-secret.pdf`;
  await assert.rejects(q(M, `insert into messages (sender_id, recipient_id, body) values ($1, $2, $3)`, [M, C, `__FILE__::${other}::x.pdf`]), /files you have access to/);
  assert.equal((await q(A, `insert into messages (sender_id, recipient_id, body) values ($1, $2, 'hello') returning id`, [A, C])).length, 1, 'plain text is untouched');
});
