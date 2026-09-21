// supabase-crm-roles-migration.sql on PGlite: the ready-made CRM roles.
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, as, makeUser, pglite } = require('./fixtures/load-db');

const skip = pglite() ? false : 'PGlite is not installed (npm i -D @electric-sql/pglite)';
const NOVA = 'Nova Sportsmart Private Limited';
let db;
const svc = async (sql, params) => (await db.query(sql, params)).rows;
const level = async (role, entity, action) =>
  (await svc(`select p.level from crm_role_permissions p join crm_roles r on r.id = p.role_id where r.name = $1 and p.entity = $2 and p.action = $3 and p.pipeline_id is null`, [role, entity, action]))[0].level;

test.before(async () => { if (!skip) db = await freshDb({ twice: true }); });

test('six roles are seeded once, assigned to nobody', { skip }, async () => {
  const names = (await svc(`select name from crm_roles where name in ('Super admin','Admin','Team lead','Sales executive','Accounts','Read only')`)).map(r => r.name);
  assert.equal(names.length, 6);
  assert.equal((await svc(`select count(*)::int n from crm_role_assignments a join crm_roles r on r.id = a.role_id where r.name = any($1)`, [names]))[0].n, 0);
});

test('each role grants what its name says', { skip }, async () => {
  assert.equal(await level('Super admin', 'deal', 'read'), 'companies');
  assert.equal(await level('Admin', 'settings', 'edit'), 'all');
  assert.equal(await level('Team lead', 'lead', 'edit'), 'subdepartments');
  assert.equal(await level('Team lead', 'lead', 'delete'), 'own');
  assert.equal(await level('Sales executive', 'deal', 'read'), 'department');
  assert.equal(await level('Sales executive', 'deal', 'edit'), 'own');
  assert.equal(await level('Accounts', 'invoice', 'edit'), 'all');
  assert.equal(await level('Accounts', 'lead', 'read'), 'none');
  assert.equal(await level('Read only', 'deal', 'edit'), 'none');
  assert.equal(await level('Read only', 'deal', 'read'), 'all');
});

test('a person given "Read only" reads the company but cannot edit', { skip }, async () => {
  const owner = await makeUser(db, { email: 'o@nova.test', name: 'Owner', company: NOVA });
  const ro = await makeUser(db, { email: 'ro@nova.test', name: 'Reader', company: NOVA });
  await svc(`delete from crm_role_assignments`);            // only the role under test applies
  const rid = (await svc(`select id from crm_roles where name = 'Read only'`))[0].id;
  await svc(`insert into crm_role_assignments (role_id, principal_type, principal_id) values ($1, 'user', $2)`, [rid, ro]);
  await svc(`insert into crm_leads (name, company, owner_id, created_by) values ('Lead A', $1, $2, $2)`, [NOVA, owner]);
  const rows = (await as(db, ro, () => db.query(`select name from crm_leads`))).rows;
  assert.deepEqual(rows.map(r => r.name), ['Lead A']);
  const upd = (await as(db, ro, () => db.query(`update crm_leads set name = 'x' returning id`))).rows;
  assert.equal(upd.length, 0);
});
