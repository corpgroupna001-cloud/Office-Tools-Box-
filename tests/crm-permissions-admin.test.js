// Admin console: CRM access permissions through api/admin.js (crm_perm_load /
// crm_perm_save), against a stand-in PostgREST that understands eq / is.null
// filters and the four verbs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sessions = require('../lib/admin-session');

const plain = v => JSON.parse(JSON.stringify(v));
const R1 = '11111111-1111-4111-8111-111111111111', R2 = '22222222-2222-4222-8222-222222222222';
const P1 = '33333333-3333-4333-8333-333333333333', U1 = '44444444-4444-4444-8444-444444444444';

function backend() {
  const db = {
    crm_roles: [{ id: R1, name: 'Employee', is_system: true }, { id: R2, name: 'Sales', is_system: false }],
    crm_role_permissions: [{ id: 'p1', role_id: R1, entity: 'deal', pipeline_id: null, action: 'read', level: 'all', extra: {} }],
    crm_role_assignments: [{ id: '55555555-5555-4555-8555-555555555555', role_id: R1, principal_type: 'all', principal_id: null, principal_key: null }],
    crm_pipelines: [{ id: P1, name: 'Accounts' }], crm_pipeline_stages: [], crm_lead_statuses: [], departments: [],
    profiles: [{ id: U1, full_name: 'Kemi Ade', employee_id: 'GL-PIS-CSM-IC-001' }],
  };
  let n = 0;
  const match = u => row => [...u.searchParams].every(([k, v]) => {
    if (['select', 'order', 'limit'].includes(k)) return true;
    if (v === 'is.null') return row[k] == null;
    if (v.startsWith('eq.')) return String(row[k]) === v.slice(3);
    return true;
  });
  const fakeFetch = async (url, opts = {}) => {
    const u = new URL(url), table = u.pathname.split('/').pop(), rows = db[table];
    const method = opts.method || 'GET';
    if (method === 'GET') return new Response(JSON.stringify(rows.filter(match(u))), { status: 200 });
    if (method === 'POST') {
      const made = [].concat(JSON.parse(opts.body)).map(b => ({ id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, extra: {}, ...b }));
      if (table === 'crm_role_assignments' && made.some(m => rows.some(r => r.role_id === m.role_id && r.principal_type === m.principal_type && (r.principal_id || r.principal_key) === (m.principal_id || m.principal_key)))) {
        return new Response(JSON.stringify({ code: '23505' }), { status: 409 });
      }
      rows.push(...made);
      return new Response(/representation/.test((opts.headers || {}).Prefer || '') ? JSON.stringify(made) : '', { status: 201 });
    }
    const hit = rows.filter(match(u));
    if (method === 'PATCH') hit.forEach(r => Object.assign(r, JSON.parse(opts.body)));
    if (method === 'DELETE') db[table] = rows.filter(r => !hit.includes(r));
    return new Response(null, { status: 204 });
  };
  const mod = { exports: {} };
  const env = { ADMIN_PASSWORD: 'pw', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_URL: 'https://db.example.test' };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/admin.js'), 'utf8'), {
    module: mod, process: { env }, console, URL, Date, Promise, setTimeout: cb => cb(), fetch: fakeFetch,
    require(name) {
      if (name === '../lib/request-auth') return require('../lib/request-auth');
      if (name === '../lib/admin-session') return sessions;
      if (name === '../lib/admin-audit') return { auditWrap: r => r };
      if (name === '../lib/crm-import' || name === '../company-config') return require(name);
      return {};
    },
  });
  const call = async (body, cookie) => {
    const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = plain(b); return this; } };
    await mod.exports({ method: 'POST', headers: { host: 'x.example.test', cookie }, body }, res);
    return res;
  };
  return { db, call };
}

test('the console reads, sets and clears CRM permissions, per pipeline too', async () => {
  const { db, call } = backend();
  const cookie = (await call({ action: 'login', password: 'pw' })).headers['Set-Cookie'].split(';')[0];
  const save = (op, data) => call({ action: 'crm_perm_save', op, ...data }, cookie);

  const load = await call({ action: 'crm_perm_load' }, cookie);
  assert.equal(load.code, 200);
  assert.deepEqual([load.body.roles.length, load.body.permissions.length, load.body.assignments.length, load.body.people[0].employee_id], [2, 1, 1, 'GL-PIS-CSM-IC-001']);

  // A whole row at once, then one cell changed, then a pipeline's own entry added and removed.
  let r = await save('perm_set', { role_id: R2, entity: 'lead', actions: ['read', 'add', 'edit'], level: 'own' });
  assert.equal(r.code, 200);
  assert.equal(r.body.permissions.length, 3);
  r = await save('perm_set', { role_id: R2, entity: 'lead', perm_action: 'edit', level: 'all' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(db.crm_role_permissions.filter(p => p.role_id === R2).map(p => `${p.action}:${p.level}`).sort(), ['add:own', 'edit:all', 'read:own']);
  await save('perm_set', { role_id: R2, entity: 'deal', pipeline_id: P1, actions: ['read'], level: 'none' });
  assert.equal(db.crm_role_permissions.filter(p => p.pipeline_id === P1).length, 1);
  await save('perm_set', { role_id: R2, entity: 'deal', pipeline_id: P1, actions: ['read'], level: '' });
  assert.equal(db.crm_role_permissions.filter(p => p.pipeline_id === P1).length, 0, 'back to "as for all pipelines"');

  // What the table would refuse is refused here first.
  assert.equal((await save('perm_set', { role_id: R2, entity: 'lead', actions: ['fly'], level: 'all' })).code, 400);
  assert.equal((await save('perm_set', { role_id: R2, entity: 'lead', actions: ['read'], level: 'everything' })).code, 400);
  assert.equal((await save('perm_set', { role_id: R2, entity: 'lead', actions: ['read'], level: '' })).code, 400, 'only a pipeline entry can be cleared');
});

test('roles are created, copied, renamed and given; built-in roles stay', async () => {
  const { db, call } = backend();
  const cookie = (await call({ action: 'login', password: 'pw' })).headers['Set-Cookie'].split(';')[0];
  const save = (op, data) => call({ action: 'crm_perm_save', op, ...data }, cookie);

  const copy = await save('role_create', { name: 'Employee (copy)', copy_from: R1 });
  assert.equal(copy.code, 200);
  assert.deepEqual(db.crm_role_permissions.filter(p => p.role_id === copy.body.role.id).map(p => `${p.entity}:${p.action}:${p.level}`), ['deal:read:all']);
  assert.equal((await save('role_update', { id: copy.body.role.id, name: 'Juniors' })).code, 200);
  assert.equal(db.crm_roles.find(r => r.id === copy.body.role.id).name, 'Juniors');

  assert.equal((await save('role_delete', { id: R1 })).code, 400, 'built-in');
  assert.equal((await save('role_delete', { id: R2 })).code, 200);
  assert.equal(db.crm_roles.some(r => r.id === R2), false);

  assert.equal((await save('assign_add', { role_id: R1, principal_type: 'user', principal_id: U1 })).code, 200);
  assert.equal((await save('assign_add', { role_id: R1, principal_type: 'user', principal_id: U1 })).code, 409);
  assert.equal((await save('assign_add', { role_id: R1, principal_type: 'app_role', principal_key: 'boss' })).code, 400);
  assert.equal((await save('assign_add', { role_id: R1, principal_type: 'user' })).code, 400);
  const given = db.crm_role_assignments.find(a => a.principal_id === U1);
  assert.equal((await save('assign_remove', { id: given.id })).code, 200);
  assert.equal(db.crm_role_assignments.some(a => a.principal_id === U1), false);
  assert.equal((await save('assign_remove', { id: 'not-an-id' })).code, 400);
});

test('Save sends the whole matrix at once: a new role, its levels, stages and people', async () => {
  const { db, call } = backend();
  const cookie = (await call({ action: 'login', password: 'pw' })).headers['Set-Cookie'].split(';')[0];
  const out = await call({
    action: 'crm_perm_save', op: 'batch',
    new_roles: [{ tmp: 'new-1', name: 'Payroll Specialist' }],
    renames: [{ id: R2, name: 'Sales team' }],
    levels: [
      { role_id: 'new-1', entity: 'lead', pipeline_id: null, action: 'read', level: 'all' },
      { role_id: 'new-1', entity: 'deal', pipeline_id: P1, action: 'read', level: 'none' },
      { role_id: R1, entity: 'deal', pipeline_id: null, action: 'read', level: 'own' },
    ],
    stages: [{ role_id: 'new-1', entity: 'deal', pipeline_id: P1, stages: ['s-1', 's-2'] }],
    assign_add: [{ role_id: 'new-1', principal_type: 'user', principal_id: U1 }, { role_id: 'new-1', principal_type: 'app_role', principal_key: 'manager' }],
    assign_remove: ['55555555-5555-4555-8555-555555555555'],
  }, cookie);
  assert.equal(out.code, 200, JSON.stringify(out.body));
  const made = db.crm_roles.find(r => r.name === 'Payroll Specialist');
  assert.ok(made);
  assert.equal(out.body.created['new-1'], made.id);
  const mine = db.crm_role_permissions.filter(p => p.role_id === made.id).map(p => `${p.entity}:${p.pipeline_id ? 'P1' : '*'}:${p.action}:${p.level}:${(p.extra.stages || []).join('+')}`).sort();
  assert.deepEqual(mine, ['deal:P1:move_stage:all:s-1+s-2', 'deal:P1:read:none:', 'lead:*:read:all:']);
  assert.equal(db.crm_role_permissions.find(p => p.id === 'p1').level, 'own');
  assert.equal(db.crm_roles.find(r => r.id === R2).name, 'Sales team');
  assert.deepEqual(db.crm_role_assignments.filter(a => a.role_id === made.id).map(a => a.principal_type).sort(), ['app_role', 'user']);
  assert.equal(db.crm_role_assignments.some(a => a.id === '55555555-5555-4555-8555-555555555555'), false);

  // Nothing is written when any entry is wrong: the new role below is not created.
  const before = db.crm_roles.length;
  assert.equal((await call({ action: 'crm_perm_save', op: 'batch', new_roles: [{ tmp: 'new-3', name: 'Half' }],
    assign_add: [{ role_id: 'new-3', principal_type: 'user', principal_id: 'not-a-person' }] }, cookie)).code, 400);
  assert.equal(db.crm_roles.length, before);
  // A new role left as "Role name", or a built-in role deleted, refuses the save.
  assert.equal((await call({ action: 'crm_perm_save', op: 'batch', new_roles: [{ tmp: 'new-2', name: 'Role name' }] }, cookie)).code, 400);
  assert.equal((await call({ action: 'crm_perm_save', op: 'batch', deletes: [R1] }, cookie)).code, 400);
});
