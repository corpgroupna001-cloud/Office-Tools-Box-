// The CRM import migration on a real Postgres engine (PGlite).
//
// The import writes deals and leads with INSERT … ON CONFLICT (external_ref),
// through PostgREST. The first version of the migration made that index
// partial, which ON CONFLICT cannot use, and every batch failed in production.
// These tests run that first version, then the current file on top — the path
// a live database takes — and write the way the import does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { freshDb, as, makeUser, pglite } = require('./fixtures/load-db');

const skip = pglite() ? false : 'PGlite is not installed (npm i -D @electric-sql/pglite)';
let db, U, pipe, stage;

test.before(async () => {
  if (skip) return;
  // freshDb runs the current import migration last; the first version runs before it again.
  db = await freshDb();
  await db.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'crm-import-migration-v1.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname, '..', 'supabase-crm-import-migration.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname, '..', 'supabase-crm-import-migration.sql'), 'utf8'));   // and again: re-runnable
  U = await makeUser(db, { email: 'ic@genie.test', name: 'Kemi Ade', company: 'Genie Lamp Private Limited' });
  pipe = (await db.query(`insert into crm_pipelines (name) values ('Proxy Interview Supports') returning id`)).rows[0].id;
  stage = (await db.query(`insert into crm_pipeline_stages (pipeline_id, name, position) values ($1, 'Semi Deal', 1) returning id`, [pipe])).rows[0].id;
});

/** A deal written the way PostgREST writes ?on_conflict=external_ref with merge-duplicates. */
const upsertDeal = (ref, title, row) => db.query(
  `insert into crm_deals (external_ref, title, pipeline_id, stage_id, source_row, created_at)
   values ($1, $2, $3, $4, $5, '2026-09-12T03:11:57+05:30')
   on conflict (external_ref) do update set title = excluded.title, source_row = excluded.source_row
   returning id, title`, [ref, title, pipe, stage, row]);

test('a deal is matched on its source id: the second import updates it', { skip }, async () => {
  const first = (await upsertDeal('bitrix:deal:17639', 'JW-RMS-IS-202609011001', { ID: '17639', Weekday: 'Monday' })).rows[0];
  const again = (await upsertDeal('bitrix:deal:17639', 'Renamed', { ID: '17639', Weekday: 'Tuesday' })).rows[0];
  assert.equal(again.id, first.id);
  const row = (await db.query(`select title, source_row, created_at from crm_deals where id = $1`, [first.id])).rows[0];
  assert.equal(row.title, 'Renamed');
  assert.equal(row.source_row.Weekday, 'Tuesday');
  assert.equal(new Date(row.created_at).toISOString(), '2026-09-11T21:41:57.000Z', 'the export\'s own date, on India time');
});

test('leads upsert on their source id too, and hand-made records need none', { skip }, async () => {
  const lead = `insert into crm_leads (external_ref, name) values ($1, $2) on conflict (external_ref) do update set name = excluded.name returning id`;
  const a = (await db.query(lead, ['bitrix:lead:2951', 'GL-EBS-USA-BGC-20260911001'])).rows[0].id;
  const b = (await db.query(lead, ['bitrix:lead:2951', 'GL-EBS-USA-BGC-20260911001'])).rows[0].id;
  assert.equal(a, b);
  await db.query(`insert into crm_leads (name) values ('typed in'), ('typed in too')`);
  await db.query(`insert into crm_deals (title, pipeline_id, stage_id) values ('by hand', $1, $2), ('by hand 2', $1, $2)`, [pipe, stage]);
  assert.equal((await db.query(`select count(*)::int n from crm_leads where external_ref is null`)).rows[0].n, 2);
});

test('the partial index from the first version is gone', { skip }, async () => {
  const idx = (await db.query(`select indexname, indexdef from pg_indexes where tablename in ('crm_deals', 'crm_leads') and indexdef ilike '%external_ref%'`)).rows;
  assert.deepEqual(idx.map(i => i.indexname).sort(), ['crm_deals_external_ref_key', 'crm_leads_external_ref_key']);
  idx.forEach(i => assert.doesNotMatch(i.indexdef, /where/i));
});

test('source_row holds an object and nothing else', { skip }, async () => {
  await assert.rejects(upsertDeal('bitrix:deal:1', 'x', JSON.stringify(['not', 'an', 'object'])), /source_row_ck/);
});

test('the column layout is for the console only, never a browser session', { skip }, async () => {
  await db.query(`insert into crm_import_layouts (entity, headers) values ('deal', array['ID', 'Pipeline'])
                  on conflict (entity) do update set headers = excluded.headers`);
  await assert.rejects(db.query(`insert into crm_import_layouts (entity) values ('invoice')`), /entity_ck/);
  await assert.rejects(as(db, U, () => db.query(`select * from crm_import_layouts`)), /permission denied/);
});
