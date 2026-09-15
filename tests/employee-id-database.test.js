// Employee ID (profiles.employee_id) on a real Postgres engine (PGlite).
// The ID people are known by: unique whatever the case, set only by an
// administrator, and never confused with the biometric employee_code.
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, as, makeUser, pglite } = require('./fixtures/load-db');

const skip = pglite() ? false : 'PGlite is not installed (npm i -D @electric-sql/pglite)';
const NOVA = 'Nova Sportsmart Private Limited';
let db, A, B, X;

test.before(async () => {
  if (skip) return;
  db = await freshDb({ twice: true });
  A = await makeUser(db, { email: 'anil@nova.test', name: 'Anil Kumar', company: NOVA });
  B = await makeUser(db, { email: 'bala@nova.test', name: 'Bala J', company: NOVA });
  X = await makeUser(db, { email: 'admin@nova.test', name: 'Asha Admin', company: NOVA, role: 'admin' });
});
const id = async uid => (await db.query('select employee_id, employee_code from profiles where id = $1', [uid])).rows[0];

test('the admin console (service role) sets an Employee ID beside the biometric code', { skip }, async () => {
  await db.query(`update profiles set employee_id = 'GL-PIS-CSM-IC-001', employee_code = '00000123' where id = $1`, [A]);
  assert.deepEqual(await id(A), { employee_id: 'GL-PIS-CSM-IC-001', employee_code: '00000123' });
});

test('an Employee ID belongs to one person, whatever the letter case', { skip }, async () => {
  await assert.rejects(db.query(`update profiles set employee_id = 'gl-pis-csm-ic-001' where id = $1`, [B]), /profiles_employee_id_key/);
  await assert.rejects(db.query(`update profiles set employee_id = ' GL-X ' where id = $1`, [B]), /profiles_employee_id_ck/);
  await db.query(`update profiles set employee_id = null where id = $1`, [B]);        // many people may have none
});

test('an employee cannot give themselves an Employee ID or change theirs', { skip }, async () => {
  await assert.rejects(as(db, A, () => db.query(`update profiles set employee_id = 'MINE-1' where id = $1`, [A])), /only be set by an administrator/);
  await assert.rejects(as(db, B, () => db.query(`update profiles set employee_id = 'MINE-2' where id = $1`, [B])), /only be set by an administrator/);
  // Their own name still saves.
  await as(db, A, () => db.query(`update profiles set full_name = 'Anil K' where id = $1`, [A]));
  assert.equal((await id(A)).employee_id, 'GL-PIS-CSM-IC-001');
});

test('a workspace admin\'s session may set an Employee ID (the guard lets admins through)', { skip }, async () => {
  // Row level security still limits a session to its own profile row.
  await as(db, X, () => db.query(`update profiles set employee_id = 'CG-SBM-EM-CEO-001' where id = $1`, [X]));
  assert.equal((await id(X)).employee_id, 'CG-SBM-EM-CEO-001');
});
