// supabase-task-completion-migration.sql (migration 20) on PGlite: a task
// whose status summary is required cannot be completed without one, however
// the completion arrives — single update, bulk update, a board column mapped
// to a done status, or the API directly (BUG-05).
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, as, makeUser, pglite } = require('./fixtures/load-db');

const skip = pglite() ? false : 'PGlite is not installed (npm i -D @electric-sql/pglite)';
const NOVA = 'Nova Sportsmart Private Limited';
const NEEDS = /needs a status summary/;

let db, A, C;
const q = async (uid, sql, params) => (await as(db, uid, () => db.query(sql, params))).rows;
const svc = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (uid, sql, params) => (await q(uid, sql, params))[0];
const task = async (title, required = true) => (await one(A, `insert into tasks (title, assignee_id, result_required) values ($1, $2, $3) returning id`, [title, A, required])).id;
const comments = async id => (await svc(`select body from comments where entity_type = 'task' and entity_id = $1 order by created_at`, [id])).map(r => r.body);

test.before(async () => {
  if (skip) return;
  db = await freshDb({ twice: true });
  A = await makeUser(db, { email: 'anil@nova.test', name: 'Anil', company: NOVA });
  C = await makeUser(db, { email: 'chitra@nova.test', name: 'Chitra', company: NOVA });
});

test('completing a task that needs a summary without one is refused; with one it completes and posts it', { skip }, async () => {
  const id = await task('Quarterly audit');
  await assert.rejects(q(A, `update tasks set status = 'completed' where id = $1`, [id]), NEEDS);
  await assert.rejects(q(A, `update tasks set status = 'completed', result_summary = '   ' where id = $1`, [id]), NEEDS, 'blank is not a summary');
  const done = await one(A, `update tasks set status = 'completed', result_summary = ' Audit filed with the auditor. ' where id = $1 returning completed_at, result_summary, result_by`, [id]);
  assert.ok(done.completed_at);
  assert.equal(done.result_summary, 'Audit filed with the auditor.');
  assert.equal(done.result_by, A);
  assert.deepEqual(await comments(id), ['Task status summary:\nAudit filed with the auditor.'], 'posted on the timeline in the same transaction');
});

test('a bulk update cannot slip one through; leaving required tasks out completes the rest', { skip }, async () => {
  const req = await task('Needs words'), plain = await task('Simple', false);
  await assert.rejects(q(A, `update tasks set status = 'completed' where id = any($1)`, [[req, plain]]), NEEDS, 'the whole statement fails');
  assert.equal((await svc(`select completed_at from tasks where id = $1`, [plain]))[0].completed_at, null, 'nothing half-done');
  const rows = await q(A, `update tasks set status = 'completed' where id = any($1) and result_required = false returning id`, [[req, plain]]);
  assert.deepEqual(rows.map(r => r.id), [plain]);
});

test('a board column that marks cards done is held to the same rule', { skip }, async () => {
  const board = await one(A, `insert into boards (name) values ('Ops') returning id`);
  const doneCol = await one(A, `insert into board_columns (board_id, name, position, maps_to_status) values ($1, 'Done', 1, 'completed') returning id`, [board.id]);
  const id = await task('Card');
  await assert.rejects(q(A, `update tasks set board_id = $2, board_column_id = $3 where id = $1`, [id, board.id, doneCol.id]), NEEDS);
  const ok = await one(A, `update tasks set board_id = $2, board_column_id = $3, result_summary = 'Shipped' where id = $1 returning status, completed_at`, [id, board.id, doneCol.id]);
  assert.equal(ok.status, 'completed');
});

test('reopening clears the summary, so the next completion needs a new one', { skip }, async () => {
  const id = await task('Cycle');
  await q(A, `update tasks set status = 'completed', result_summary = 'First pass' where id = $1`, [id]);
  const reopened = await one(A, `update tasks set status = 'todo' where id = $1 returning result_summary, completed_at`, [id]);
  assert.deepEqual(reopened, { result_summary: null, completed_at: null });
  await assert.rejects(q(A, `update tasks set status = 'completed' where id = $1`, [id]), NEEDS);
  await q(A, `update tasks set status = 'completed', result_summary = 'Second pass' where id = $1`, [id]);
  assert.equal((await comments(id)).length, 2);
});

test('a task cannot be created already completed without its summary; tasks that need none are unaffected', { skip }, async () => {
  await assert.rejects(q(A, `insert into tasks (title, status, result_required) values ('Born done', 'completed', true)`), NEEDS);
  const plain = await task('No summary needed', false);
  assert.ok((await one(A, `update tasks set status = 'completed' where id = $1 returning completed_at`, [plain])).completed_at);
  assert.deepEqual(await comments(plain), []);
});

test('only people who may edit the task can complete it; the service key is not held to the summary', { skip }, async () => {
  const id = await task('Private to Anil');
  await svc(`update tasks set assignee_id = $2, created_by = $2 where id = $1`, [id, A]);
  assert.equal((await q(C, `update tasks set status = 'completed', result_summary = 'Not mine' where id = $1 returning id`, [id])).length, 0);
  assert.ok((await svc(`update tasks set status = 'completed' where id = $1 returning completed_at`, [id]))[0].completed_at, 'data repair with the service key');
});
