// supabase-attendance-corrections-migration.sql (migration 23) on PGlite:
// employees ask, reviewers decide once, the device's record is kept (F-04).
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, as, makeUser, pglite } = require('./fixtures/load-db');

const skip = pglite() ? false : 'WS_SKIP_DB_TESTS=1: database tests skipped on purpose';
const NOVA = 'Nova Sportsmart Private Limited';
const JOBWAYS = 'Jobways Point LLP';
const RLS = /row-level security/;

let db, M, E, P, B, X;   // M manages E; P a Nova peer; B another company; X workspace admin
const q = async (uid, sql, params) => (await as(db, uid, () => db.query(sql, params))).rows;
const svc = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (uid, sql, params) => (await q(uid, sql, params))[0];
const json = v => (typeof v === 'string' ? JSON.parse(v) : v);
const ago = h => new Date(Date.now() - h * 3600e3).toISOString();

async function punch(uid, iso, direction = 'IN') {
  return (await svc(`insert into attendance_logs (user_id, employee_code, direction, log_datetime, log_date, log_time, device_sn, source)
                     values ($1, 'E100', $2, $3, ($3::timestamptz at time zone 'Asia/Kolkata')::date, ($3::timestamptz at time zone 'Asia/Kolkata')::time, 'dev1', 'biometric') returning id`, [uid, direction, iso]))[0].id;
}
const ask = (uid, f) => one(uid, `insert into attendance_corrections (kind, direction, requested_at, log_id, reason) values ($1, $2, $3, $4, $5) returning *`,
  [f.kind || 'missing', f.direction || 'OUT', f.at, f.log || null, f.reason || 'Forgot to punch out at the door']);

test.before(async () => {
  if (skip) return;
  db = await freshDb();
  M = await makeUser(db, { email: 'maya@nova.test', name: 'Maya', company: NOVA, role: 'manager' });
  E = await makeUser(db, { email: 'esha@nova.test', name: 'Esha', company: NOVA, manager_id: M });
  P = await makeUser(db, { email: 'pavan@nova.test', name: 'Pavan', company: NOVA });
  B = await makeUser(db, { email: 'bala@jobways.test', name: 'Bala', company: JOBWAYS });
  X = await makeUser(db, { email: 'asha@nova.test', name: 'Asha', company: NOVA, role: 'admin' });
});

test('an employee asks for their own correction only; it starts pending, whatever they send', { skip }, async () => {
  const c = await one(E, `insert into attendance_corrections (user_id, kind, direction, requested_at, reason, status, reviewed_by)
                          values ($1, 'missing', 'OUT', $2, 'Forgot to punch out', 'approved', $1) returning user_id, status, reviewed_by, work_date`, [P, ago(30)]);
  assert.deepEqual([c.user_id, c.status, c.reviewed_by], [E, 'pending', null], 'the author is always the caller');
  assert.ok(c.work_date);
  await assert.rejects(ask(E, { at: new Date(Date.now() + 3 * 3600e3).toISOString() }), /not happened yet/);
  await assert.rejects(ask(E, { at: ago(24 * 60) }), /45 days/);
  await assert.rejects(ask(E, { at: ago(5), reason: 'no' }), /check/);
  const bLog = await punch(B, ago(10));
  await assert.rejects(ask(E, { kind: 'wrong_time', at: ago(9), log: bLog }), /not yours/);
  assert.equal((await q(P, `select id from attendance_corrections`)).length, 0, 'a peer sees nothing');
  assert.ok((await q(M, `select id from attendance_corrections where user_id = $1`, [E])).length >= 1, "the manager sees the team's");
  assert.equal((await q(B, `select id from attendance_corrections`)).length, 0);
});

test('only someone who manages the person decides; nobody decides their own; never twice', { skip }, async () => {
  const c = await ask(E, { at: ago(20) });
  await assert.rejects(q(E, `select public.ws_review_attendance_correction($1, true)`, [c.id]), /own correction/);
  await assert.rejects(q(P, `select public.ws_review_attendance_correction($1, true)`, [c.id]), /manager or an administrator/);
  await assert.rejects(q(B, `select public.ws_review_attendance_correction($1, true)`, [c.id]), /manager or an administrator/);
  await assert.rejects(q(E, `update attendance_corrections set status = 'approved' where id = $1 returning id`, [c.id]).then(r => { if (!r.length) throw new Error('row-level security: no row'); }), RLS);
  const done = json((await one(M, `select public.ws_review_attendance_correction($1, true, 'Saw her leave') r`, [c.id])).r);
  assert.deepEqual([done.status, done.reviewed_by, done.review_note], ['approved', M, 'Saw her leave']);
  await assert.rejects(q(X, `select public.ws_review_attendance_correction($1, false)`, [c.id]), /already approved/, 'decided once');
  const own = await ask(X, { at: ago(3) });
  await assert.rejects(q(X, `select public.ws_review_attendance_correction($1, true)`, [own.id]), /own correction/, 'administrators too');
  assert.ok((await q(E, `select id from notifications where user_id = $1 and kind = 'attendance.correction'`, [E])).length, 'the employee hears the decision');
});

test('approval adds a punch and supersedes the wrong one; the device record is kept and audited', { skip }, async () => {
  const wrong = await punch(E, ago(50), 'OUT');
  const c = await ask(E, { kind: 'wrong_time', direction: 'OUT', at: ago(48), log: wrong, reason: 'Device clock was two hours fast' });
  const r = json((await one(X, `select public.ws_review_attendance_correction($1, true) r`, [c.id])).r);
  assert.equal(r.status, 'approved');
  assert.equal(json(r.before).log_id, Number(wrong));
  const added = (await svc(`select id, user_id, source, direction, correction_id, email_status from attendance_logs where id = $1`, [r.applied_log_id]))[0];
  assert.deepEqual([added.user_id, added.source, added.direction, added.correction_id, added.email_status], [E, 'correction', 'OUT', c.id, 'skipped']);
  const old = (await svc(`select log_datetime, superseded_by, device_sn from attendance_logs where id = $1`, [wrong]))[0];
  assert.equal(Number(old.superseded_by), Number(r.applied_log_id), 'the wrong punch is marked, not changed or deleted');
  assert.equal(old.device_sn, 'dev1');
  // What every day / report / pay-sheet read asks for: the punches that count.
  const live = (await svc(`select id from attendance_logs where user_id = $1 and superseded_by is null`, [E])).map(x => Number(x.id));
  assert.ok(live.includes(Number(r.applied_log_id)) && !live.includes(Number(wrong)));
  await assert.rejects(ask(E, { kind: 'wrong_time', at: ago(47), log: wrong }), /already corrected/);
  const mine = (await q(E, `select id from attendance_logs`)).map(x => Number(x.id));
  assert.ok(mine.includes(Number(r.applied_log_id)) && !mine.includes(Number(wrong)), 'the employee\u2019s own pages read the punches that count');
  const team = (await q(M, `select id from attendance_logs where user_id = $1`, [E])).map(x => Number(x.id));
  assert.ok(!team.includes(Number(wrong)), 'so does the manager\u2019s view');
});

test('a rejection adds nothing; the admin console decides with the service key and a label', { skip }, async () => {
  const before = (await svc(`select count(*)::int n from attendance_logs where user_id = $1`, [E]))[0].n;
  const c = await ask(E, { at: ago(26) });
  const r = json((await svc(`select public.ws_review_attendance_correction($1, false, 'No record of this', 'Admin console (password)') r`, [c.id]))[0].r);
  assert.deepEqual([r.status, r.reviewer_label, r.applied_log_id], ['rejected', 'Admin console (password)', null]);
  assert.equal((await svc(`select count(*)::int n from attendance_logs where user_id = $1`, [E]))[0].n, before);
  const pending = await ask(E, { at: ago(27) });
  assert.equal((await q(E, `delete from attendance_corrections where id = $1 returning id`, [pending.id])).length, 1, 'a pending request can be withdrawn');
  assert.equal((await q(E, `delete from attendance_corrections where id = $1 returning id`, [c.id])).length, 0, 'a decided one cannot');
});
