// supabase-favorites-migration.sql (migration 21) on PGlite: favourites are
// per person and never reveal a record the person cannot see (F-02).
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, as, makeUser, pglite } = require('./fixtures/load-db');

const skip = pglite() ? false : 'WS_SKIP_DB_TESTS=1: database tests skipped on purpose';
const NOVA = 'Nova Sportsmart Private Limited';
const JOBWAYS = 'Jobways Point LLP';
const RLS = /row-level security/;

let db, A, C, B;
const q = async (uid, sql, params) => (await as(db, uid, () => db.query(sql, params))).rows;
const svc = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (uid, sql, params) => (await q(uid, sql, params))[0];
const favs = async uid => (await q(uid, `select entity_type, title, url from public.ws_my_favorites()`)).map(r => `${r.entity_type}:${r.title}`);

test.before(async () => {
  if (skip) return;
  db = await freshDb();
  A = await makeUser(db, { email: 'anil@nova.test', name: 'Anil', company: NOVA });
  C = await makeUser(db, { email: 'chitra@nova.test', name: 'Chitra', company: NOVA });
  B = await makeUser(db, { email: 'bala@jobways.test', name: 'Bala', company: JOBWAYS });
});

test('a person stars a record they can see, and finds it with a title and a link', { skip }, async () => {
  const t = await one(A, `insert into tasks (title, assignee_id) values ('Renew the lease', $1) returning id`, [A]);
  await q(A, `insert into user_favorites (entity_type, entity_id) values ('task', $1)`, [t.id]);
  const rows = await q(A, `select entity_type, title, url from public.ws_my_favorites()`);
  assert.deepEqual(rows, [{ entity_type: 'task', title: 'Renew the lease', url: `/tasks/?id=${t.id}` }]);
  assert.deepEqual(await favs(C), [], 'favourites are personal');
  assert.equal((await q(C, `select * from user_favorites`)).length, 0);
  await assert.rejects(q(C, `insert into user_favorites (user_id, entity_type, entity_id) values ($1, 'task', $2)`, [A, t.id]), RLS, 'nobody stars for someone else');
  await q(A, `delete from user_favorites where entity_id = $1`, [t.id]);
  assert.deepEqual(await favs(A), []);
});

test('a record you cannot see cannot be starred', { skip }, async () => {
  const doc = await one(A, `insert into documents (name, doc_kind, visibility, content, mime_type, size_bytes) values ('Salary plan', 'document', 'private', '{}', 'application/json', 0) returning id`);
  await assert.rejects(q(C, `insert into user_favorites (entity_type, entity_id) values ('document', $1)`, [doc.id]), RLS, 'private to Anil');
  await assert.rejects(q(B, `insert into user_favorites (entity_type, entity_id) values ('document', $1)`, [doc.id]), RLS, 'another company');
  await assert.rejects(q(A, `insert into user_favorites (entity_type, entity_id) values ('task', gen_random_uuid())`), RLS, 'no such record');
});

test('when access goes or the record is deleted, the favourite drops out — its title never shows', { skip }, async () => {
  const doc = await one(A, `insert into documents (name, doc_kind, visibility, content, mime_type, size_bytes) values ('Team notes', 'document', 'company', '{}', 'application/json', 0) returning id`);
  await q(C, `insert into user_favorites (entity_type, entity_id) values ('document', $1)`, [doc.id]);
  assert.deepEqual(await favs(C), ['document:Team notes']);
  await q(A, `update documents set visibility = 'private' where id = $1`, [doc.id]);      // Anil takes it back
  assert.deepEqual(await favs(C), [], 'no longer visible: gone from the list, title not returned');
  const t = await one(C, `insert into tasks (title, assignee_id) values ('Old task', $1) returning id`, [C]);
  await q(C, `insert into user_favorites (entity_type, entity_id) values ('task', $1)`, [t.id]);
  await svc(`update tasks set archived_at = now() where id = $1`, [t.id]);
  assert.deepEqual(await favs(C), [], 'archived');
  await svc(`delete from tasks where id = $1`, [t.id]);
  assert.deepEqual(await favs(C), [], 'deleted');
});
