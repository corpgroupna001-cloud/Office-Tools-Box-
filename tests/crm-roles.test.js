// Workspace roles reach the database only through the admin console, and the
// console validates them before the service key touches a profile.
const test = require('node:test');
const assert = require('node:assert/strict');
const people = require('../lib/employee-admin');

const COMPANY = 'Nova Sportsmart Private Limited';

test('the admin editor accepts exactly the three workspace roles', () => {
  for (const role of ['employee', 'manager', 'admin']) {
    assert.deepEqual(people.employeePatch({ app_role: role }, {}), { app_role: role });
  }
  assert.deepEqual(people.ROLES, ['employee', 'manager', 'admin']);
});

test('an unknown role is refused before anything is written', () => {
  assert.throws(() => people.employeePatch({ app_role: 'superuser' }, {}), /employee, manager or admin/);
  assert.throws(() => people.employeePatch({ app_role: '' }, {}), /employee, manager or admin/);
});

test('a null role means back to employee; an absent role leaves the profile alone', () => {
  assert.deepEqual(people.employeePatch({ app_role: null }, {}), { app_role: 'employee' });
  assert.deepEqual(people.employeePatch({ department: 'Sales' }, {}), { department: 'Sales' });
});

test('roles ride along with the rest of the editor patch', () => {
  const patch = people.employeePatch({ full_name: 'Priya Sharma', company: COMPANY, app_role: 'manager' }, { company: COMPANY });
  assert.equal(patch.app_role, 'manager');
  assert.equal(patch.full_name, 'Priya Sharma');
});

test('a profile table without app_role names the CRM migration to run', async () => {
  const calls = [];
  const request = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ method, url });
    if (method === 'GET' && url.includes('/rest/v1/profiles')) return new Response(JSON.stringify([{ id: '11111111-1111-1111-1111-111111111111', company: COMPANY }]), { status: 200 });
    if (method === 'GET' && url.includes('/auth/v1/admin/users/')) return new Response(JSON.stringify({ email: 'p@example.com', user_metadata: {} }), { status: 200 });
    if (method === 'PATCH' && url.includes('/rest/v1/profiles')) return new Response(JSON.stringify({ code: 'PGRST204', message: "Could not find the 'app_role' column" }), { status: 400 });
    return new Response('[]', { status: 200 });
  };
  await assert.rejects(
    people.updateEmployee({ id: '11111111-1111-1111-1111-111111111111', app_role: 'manager' }, { url: 'https://db.example.test', key: 'k', request }),
    e => e.status === 409 && /supabase-crm-foundation-migration\.sql/.test(e.message));
  assert.equal(calls.filter(c => c.method === 'PUT').length, 0, 'the login account is never touched when the profile write fails');
});
