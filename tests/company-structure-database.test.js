// supabase-company-structure-migration.sql on PGlite: the Bitrix24 company
// structure, heads by Employee ID, re-runs add nothing, everyone reads it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { freshDb, as, makeUser, pglite } = require('./fixtures/load-db');

const skip = pglite() ? false : 'PGlite is not installed (npm i -D @electric-sql/pglite)';
const SQL = fs.readFileSync(path.join(__dirname, '..', 'supabase-company-structure-migration.sql'), 'utf8');
let db, NA, JWE;
const svc = async (sql, params) => (await db.query(sql, params)).rows;
const pathOf = async name => (await svc(`with recursive up as (
    select id, name, parent_id, 0 lvl from departments where name = $1
    union all select d.id, d.name, d.parent_id, up.lvl + 1 from departments d join up on d.id = up.parent_id)
  select string_agg(name, ' > ' order by lvl desc) p from up`, [name]))[0].p;

test.before(async () => {
  if (skip) return;
  db = await freshDb();
  NA = await makeUser(db, { email: 'na@nova.test', name: 'Sirimilla Vinay', company: 'Nova Sportsmart Private Limited' });
  JWE = await makeUser(db, { email: 'e@jw.test', name: 'Jobways Person', company: 'Jobways Point LLP' });
  await svc(`update profiles set employee_id = 'CG-ITSA-SNA-NA-001' where id = $1`, [NA]);
  await db.exec(SQL);                 // now with people: heads are found
  await db.exec(SQL);                 // and again: nothing doubles
});

test('the tree follows Bitrix24, from the group down to the leaves', { skip }, async () => {
  assert.equal(await pathOf('Accountant'), 'Corporate Group > Jobways Point LLP > Resume Marketing Services > Operations Management > Resume Marketing Management > Accounts and Reconciliation > Accountant');
  assert.equal((await svc(`select count(*)::int n from departments where parent_id = (select id from departments where name = 'Jobways Point LLP')`))[0].n, 9);
  assert.equal((await svc(`select count(*)::int n from departments where parent_id = (select id from departments where name = 'Genie Lamp Private Limited')`))[0].n, 10);
  assert.equal((await svc(`select count(*)::int n from departments where parent_id = (select id from departments where name = 'Nova Sportsmart Private Limited')`))[0].n, 12);
  assert.match(await pathOf('Own Brand Commerce'), /^Corporate Group > SPORTSMART > Nova Sportsmart Private Limited > /);
  const dup = await svc(`select parent_id, lower(name) n, count(*) from departments group by 1, 2 having count(*) > 1`);
  assert.deepEqual(dup, [], 'running it twice adds nothing');
});

test('heads are set by Employee ID', { skip }, async () => {
  const heads = await svc(`select d.name from department_members m join departments d on d.id = m.department_id where m.user_id = $1 and m.role = 'head' order by 1`, [NA]);
  assert.ok(heads.some(h => h.name === 'Network Administrator'));
});

test('everyone signed in reads the whole chart', { skip }, async () => {
  const n = (await as(db, JWE, () => db.query(`select count(*)::int n from departments where company = 'Nova Sportsmart Private Limited'`))).rows[0].n;
  assert.ok(n > 10);
});
