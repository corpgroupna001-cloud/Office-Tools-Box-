const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sessions = require('../lib/admin-session');
const env = { ADMIN_PASSWORD: 'test-admin-password', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key', SUPABASE_URL: 'https://db.example.test' };

function backend(config = env) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/admin.js'), 'utf8'), {
    module, process: { env: config }, console, URL, Date,
    setTimeout: cb => { cb(); },
    require(name) {
      if (name === '../lib/admin-session') return sessions;
      if (name === '../lib/attendance') return require('../lib/attendance');
      if (name === '../lib/mailer' || name === '../lib/bitrix') return {};
      throw new Error(name);
    },
    fetch: async () => new Response(JSON.stringify([]), { status: 200 }),
  });
  return async (body, cookie = '', headers = {}) => {
    const res = { code: 200, headers: {}, setHeader(k,v) { this.headers[k] = v; },
      status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await module.exports({ method: 'POST', headers: { host: 'work-suite.example.test', cookie, ...headers }, body }, res);
    return res;
  };
}

test('login issues a protected cookie and a fresh server restores the admin session', async () => {
  const login = await backend()({ action: 'login', password: env.ADMIN_PASSWORD });
  assert.equal(login.code, 200);
  const cookie = login.headers['Set-Cookie'];
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api/admin', 'Max-Age=43200']) assert.ok(cookie.includes(attribute));
  assert.equal(cookie.includes(env.ADMIN_PASSWORD), false);
  const restored = await backend()({ action: 'session' }, cookie.split(';')[0]);
  assert.equal(restored.code, 200);
  assert.equal(restored.body.authenticated, true);
  const report = await backend()({ action: 'results' }, cookie.split(';')[0]);
  assert.equal(report.code, 200);
  assert.equal(report.headers['Cache-Control'], 'no-store');
});

test('unauthenticated refresh and incorrect login remain locked', async () => {
  assert.equal((await backend()({ action: 'session' })).code, 401);
  const denied = await backend()({ action: 'login', password: 'wrong' });
  assert.equal(denied.code, 401);
  assert.equal(denied.headers['Set-Cookie'], undefined);
});

test('cookie tampering, expiry and configuration rotation invalidate the session', () => {
  const now = Date.now();
  const token = sessions.createSession(env, now);
  const cookie = 'ws_admin_session=' + token;
  assert.equal(sessions.validSession(cookie, env, now), true);
  assert.equal(sessions.validSession(cookie + 'tampered', env, now), false);
  assert.equal(sessions.validSession(cookie, env, now + sessions.TTL_SECONDS * 1000), false);
  assert.equal(sessions.validSession(cookie, { ...env, ADMIN_PASSWORD: 'changed' }, now), false);
  assert.equal(sessions.validSession(cookie, { ...env, SUPABASE_SERVICE_ROLE_KEY: 'changed' }, now), false);
  assert.equal(sessions.validSession('ws_admin_session=not-a-session', env), false);
});

test('Lock expires the browser cookie; the next refresh needs login', async () => {
  const login = await backend()({ action: 'login', password: env.ADMIN_PASSWORD });
  const logout = await backend()({ action: 'logout' }, login.headers['Set-Cookie'].split(';')[0]);
  assert.equal(logout.code, 200);
  assert.ok(logout.headers['Set-Cookie'].includes('Max-Age=0'));
  assert.equal((await backend()({ action: 'session' }, logout.headers['Set-Cookie'].split(';')[0])).code, 401);
});

test('cross-origin requests cannot log in, mutate data or clear sessions', async () => {
  for (const action of ['login', 'logout', 'results']) {
    const response = await backend()({ action, password: env.ADMIN_PASSWORD }, '', { origin: 'https://other.example.test' });
    assert.equal(response.code, 403);
  }
  assert.equal((await backend()({ action: 'login', password: env.ADMIN_PASSWORD }, '', { origin: 'https://work-suite.example.test' })).code, 200);
});

test('legacy password API callers keep working during rollout', async () => {
  assert.equal((await backend()({ action: 'results', password: env.ADMIN_PASSWORD })).code, 200);
});

test('the new admin page exists and old login routes redirect without changing API routes', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '../wsm-admin/index.html')));
  assert.equal(fs.existsSync(path.join(__dirname, '../admin/index.html')), false);
  const config = require('../vercel.json');
  for (const old of ['/admin', '/admin/', '/admin/index.html', '/Network.ADMIN']) {
    assert.equal(config.redirects.find(r => r.source === old).destination, '/wsm-admin');
  }
  assert.equal(config.redirects.some(r => r.source === '/api/admin'), false);
});

// Run the actual page's login/restore block with DOM stubs and a cookie jar.
// Reload creates a new page context, so no JavaScript login state survives.
function pageContext(jar) {
  const handlers = new Map();
  const elements = new Map();
  const calls = [];
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set(id === 'dashboard' ? ['hidden'] : []);
      elements.set(id, { value: '', textContent: '', disabled: false,
        classList: { add: c => classes.add(c), remove: c => classes.delete(c),
          contains: c => classes.has(c), toggle(c, on) { on ? classes.add(c) : classes.delete(c); } },
        addEventListener: (event, fn) => handlers.set(id + ':' + event, fn),
      });
    }
    return elements.get(id);
  }
  const request = backend();
  const context = {
    adminAuthenticated: false, allResults: [], renderAll() {},
    window: { WSShell: { setUser() {}, toast() {} } },
    location: { reload() { context.reloaded = true; } },
    CustomEvent: class { constructor(type) { this.type = type; } },
    document: { getElementById: element, addEventListener: (event,fn) => handlers.set(event,fn),
      dispatchEvent: event => calls.push(event.type) },
    async fetch(url, options) {
      assert.equal(options.credentials, 'same-origin');
      const body = JSON.parse(options.body);
      calls.push(body.action);
      const r = await request(body, jar.cookie || '');
      if (r.headers['Set-Cookie']) jar.cookie = r.headers['Set-Cookie'].split(';')[0];
      return new Response(JSON.stringify(r.body), { status: r.code });
    },
  };
  context.WSShell = context.window.WSShell;
  const html = fs.readFileSync(path.join(__dirname, '../wsm-admin/index.html'), 'utf8');
  const start = html.indexOf("        const gate = document.getElementById('gate');");
  const end = html.indexOf("        document.getElementById('refresh-btn').addEventListener", start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(html.slice(start, end), context);
  return { context, calls, element, handlers };
}

test('admin page restores after refresh, dispatches unlock, and stays locked after Lock', async () => {
  const jar = {};
  const first = pageContext(jar);
  await first.handlers.get('DOMContentLoaded')();
  assert.equal(first.context.adminAuthenticated, false);
  first.element('gate-password').value = env.ADMIN_PASSWORD;
  await first.handlers.get('gate-form:submit')({ preventDefault() {} });
  assert.equal(first.context.adminAuthenticated, true);
  assert.equal(first.element('gate-password').value, '');
  assert.ok(first.calls.includes('admin-unlocked'));
  const refreshed = pageContext(jar);
  await refreshed.handlers.get('DOMContentLoaded')();
  assert.equal(refreshed.context.adminAuthenticated, true);
  assert.equal(refreshed.element('dashboard').classList.contains('hidden'), false);
  assert.ok(refreshed.calls.includes('admin-unlocked'));
  assert.equal(refreshed.calls.includes('login'), false, 'refresh does not resend a password');
  await refreshed.handlers.get('logout-btn:click')();
  assert.equal(refreshed.context.reloaded, true);
  const locked = pageContext(jar);
  await locked.handlers.get('DOMContentLoaded')();
  assert.equal(locked.context.adminAuthenticated, false);
  assert.equal(locked.element('dashboard').classList.contains('hidden'), true);
});

test('expired session during an admin request returns the page to login', async () => {
  const jar = { cookie: 'ws_admin_session=' + sessions.createSession(env) };
  const page = pageContext(jar);
  await page.handlers.get('DOMContentLoaded')();
  jar.cookie = '';
  await page.context.adminFetch({ method: 'POST', body: JSON.stringify({ action: 'results' }) });
  assert.equal(page.context.adminAuthenticated, false);
  assert.equal(page.element('dashboard').classList.contains('hidden'), true);
  assert.match(page.element('gate-error').textContent, /session expired/);
});
