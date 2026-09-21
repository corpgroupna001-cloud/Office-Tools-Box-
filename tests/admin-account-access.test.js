// /api/admin without the password: a WorkSuite account whose workspace role
// is admin gets in with its own session; anyone else is refused.
const test = require('node:test');
const assert = require('node:assert/strict');

const env = { ADMIN_PASSWORD: 'pw', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon', ADMIN_SESSION_SECRET: 'x'.repeat(40) };
Object.assign(process.env, env);
const USERS = { 'tok-admin': { id: 'u-admin', role: 'admin' }, 'tok-emp': { id: 'u-emp', role: 'employee' }, 'tok-gone': { id: 'u-gone', role: 'admin', status: 'inactive' } };
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.endsWith('/auth/v1/user')) {
    const t = String(opts.headers.Authorization).replace('Bearer ', '');
    const who = USERS[t];
    return { ok: !!who, json: async () => (who ? { id: who.id, email: who.id + '@x.test' } : {}) };
  }
  const m = u.match(/profiles\?id=eq\.([^&]+)/);
  if (m) { const who = Object.values(USERS).find(x => x.id === decodeURIComponent(m[1])); return { ok: true, json: async () => (who ? [{ full_name: who.id, app_role: who.role, status: who.status || 'active' }] : []) }; }
  return { ok: true, json: async () => [] };
};
const handler = require('../api/admin.js');
async function call(token, action = 'session') {
  const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  await handler({ method: 'POST', headers: { host: 'x', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: { action } }, res);
  return res;
}

test('an admin account opens the console without the password', async () => {
  const r = await call('tok-admin');
  assert.equal(r.code, 200);
  assert.equal(r.body.via, 'account');
});
test('employees, deactivated admins and strangers are refused', async () => {
  for (const t of ['tok-emp', 'tok-gone', 'forged', null]) assert.equal((await call(t)).code, 401, String(t));
});
test('the account never counts as the password for the login action', async () => {
  assert.equal((await call('tok-admin', 'login')).code, 401);
});
