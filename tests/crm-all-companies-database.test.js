// supabase-crm-all-companies-migration.sql on PGlite: the "All companies"
// level. The case it fixes: a Nova person given every permission still saw
// no deals or leads, because the imported records belong to Genie Lamp.
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, as, makeUser, pglite } = require('./fixtures/load-db');

const skip = pglite() ? false : 'PGlite is not installed (npm i -D @electric-sql/pglite)';
const NOVA = 'Nova Sportsmart Private Limited';
const GENIE = 'Genie Lamp Private Limited';

let db, V, G, E, X;          // V Vinay (Nova); G Genie Lamp seller; E another Nova employee; X admin
const q = async (uid, sql, params) => (await as(db, uid, () => db.query(sql, params))).rows;
const svc = async (sql, params) => (await db.query(sql, params)).rows;

test.before(async () => {
  if (skip) return;
  db = await freshDb({ twice: true });
  V = await makeUser(db, { email: 'vinay@nova.test', name: 'Sirimilla Vinay', company: NOVA });
  G = await makeUser(db, { email: 'seller@genie.test', name: 'Genie Seller', company: GENIE });
  E = await makeUser(db, { email: 'emp@nova.test', name: 'Nova Employee', company: NOVA });
  X = await makeUser(db, { email: 'admin@nova.test', name: 'Admin', company: NOVA, role: 'admin' });
  // A Genie Lamp pipeline and imported records: one deal and one lead of Genie Lamp, one lead with no company.
  const p = (await svc(`insert into crm_pipelines (name, company) values ('Accounts', $1) returning id`, [GENIE]))[0].id;
  const s = (await svc(`insert into crm_pipeline_stages (pipeline_id, name, position) values ($1, 'Receive Advance Payments', 1) returning id`, [p]))[0].id;
  await svc(`insert into crm_deals (title, company, owner_id, created_by, pipeline_id, stage_id) values ('GL-PIS-IS-20260918003', $1, $2, $2, $3, $4)`, [GENIE, G, p, s]);
  await svc(`insert into crm_leads (name, company, owner_id, created_by) values ('GL-EBS-20260320001', $1, $2, $2)`, [GENIE, G]);
  await svc(`insert into crm_leads (name, company) values ('Orphan import', null)`);
});

const seen = async uid => ({
  deals: (await q(uid, `select title from crm_deals`)).length,
  leads: (await q(uid, `select name from crm_leads`)).length,
  pipelines: (await q(uid, `select name from crm_pipelines where name = 'Accounts'`)).length,
});

test('"All" (the Manager role) stays inside the person\'s own company', { skip }, async () => {
  const mgr = (await svc(`select id from crm_roles where name = 'Manager'`))[0].id;
  await q(X, `insert into crm_role_assignments (role_id, principal_type, principal_id) values ($1, 'user', $2)`, [mgr, V]);
  assert.deepEqual(await seen(V), { deals: 0, leads: 0, pipelines: 0 }, 'the reported problem');
});

test('the seeded "Full CRM access (every company)" role shows every company and records with none', { skip }, async () => {
  const full = (await svc(`select id from crm_roles where name = 'Full CRM access (every company)'`));
  assert.equal(full.length, 1, 'seeded once although the file ran twice');
  await q(X, `insert into crm_role_assignments (role_id, principal_type, principal_id) values ($1, 'user', $2)`, [full[0].id, V]);
  assert.deepEqual(await seen(V), { deals: 1, leads: 2, pipelines: 1 });
  const lv = (await q(V, `select public.ws_crm_levels('deal', 'read') l`))[0].l;
  assert.equal((typeof lv === 'string' ? JSON.parse(lv) : lv)['*'], 'companies');
  assert.equal((await q(V, `update crm_deals set title = title || ' ✓' returning id`)).length, 1, 'and may edit them');
  assert.equal((await q(V, `select 1 from crm_pipeline_stages s join crm_pipelines p on p.id = s.pipeline_id where p.name = 'Accounts'`)).length, 1);
});

test('nobody else gains anything', { skip }, async () => {
  assert.deepEqual(await seen(E), { deals: 0, leads: 0, pipelines: 0 });
  assert.deepEqual(await seen(G), { deals: 1, leads: 1, pipelines: 1 }, 'Genie Lamp still sees its own, not the company-less record');
});
