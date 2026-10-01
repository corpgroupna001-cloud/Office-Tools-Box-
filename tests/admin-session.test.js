const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sessions = require('../lib/admin-session');
const env = { ADMIN_PASSWORD: 'test-admin-password', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key', SUPABASE_URL: 'https://db.example.test' };

function backend(config = env, opts = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/admin.js'), 'utf8'), {
    module, process: { env: config }, console: opts.console || console, URL, Date,
    setTimeout: cb => { cb(); },
    require(name) {
      if (name === '../lib/request-auth') return require('../lib/request-auth');
      if (name === '../lib/service-rpc') return require('../lib/service-rpc');
      if (name === '../company-config') return require('../company-config');
      if (name === '../lib/admin-session') return sessions;
      if (name === '../lib/attendance') return require('../lib/attendance');
      if (name === '../lib/mailer' || name === '../lib/bitrix') return {};
      // The audit trail has its own tests; here it must not reach the network.
      if (name === '../lib/admin-audit') return { auditWrap: res => res, recordSecurityEvent: async (...a) => { (opts.events || []).push(a[0]); return true; } };
      if (name === '../lib/employee-admin') return require('../lib/employee-admin');
      if (name === '../lib/setup-health') return require('../lib/setup-health');
      throw new Error(name);
    },
    fetch: opts.fetch || (async () => new Response(JSON.stringify([]), { status: 200 })),
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
      elements.set(id, { value: '', textContent: '', disabled: false, hidden: id === 'gate-pw', style: {}, focus() {},
        classList: { add: c => classes.add(c), remove: c => classes.delete(c),
          contains: c => classes.has(c), toggle(c, on) { on ? classes.add(c) : classes.delete(c); } },
        addEventListener: (event, fn) => handlers.set(id + ':' + event, fn),
      });
    }
    return elements.get(id);
  }
  const request = backend();
  jar.store = jar.store || {};
  const search = jar.search || '';
  const context = {
    adminAuthenticated: false, allResults: [], renderAll() {},
    window: { WSShell: { setUser() {}, toast() {} }, addEventListener() {}, setTimeout: () => 0 },
    location: { origin: 'https://work-suite.example.test', pathname: '/wsm-admin', search, hash: '',
      get href() { return this.origin + this.pathname + this.search; },
      reload() { context.reloaded = true; }, replace(u) { context.replaced = u; } },
    history: { state: null, replaceState() {} },
    localStorage: { getItem: k => (k in jar.store ? jar.store[k] : null), setItem: (k, v) => { jar.store[k] = String(v); }, removeItem: k => { delete jar.store[k]; } },
    URL, URLSearchParams, atob, clearTimeout() {},
    CustomEvent: class { constructor(type) { this.type = type; } },
    document: { readyState: 'loading', getElementById: element, addEventListener: (event,fn) => handlers.set(event,fn),
      dispatchEvent: event => calls.push(event.type), querySelectorAll: () => [] },
    async fetch(url, options) {
      assert.equal(options.credentials, 'same-origin');
      const body = JSON.parse(options.body);
      calls.push(body.action);
      if (jar.offline) throw new TypeError('Failed to fetch');
      const r = await request(body, jar.cookie || '');
      if (r.headers['Set-Cookie']) jar.cookie = r.headers['Set-Cookie'].split(';')[0];
      return new Response(JSON.stringify(r.body), { status: r.code });
    },
  };
  context.WSShell = context.window.WSShell;
  // admin/inactivity.js owns Lock; it runs in the same page.
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../admin/inactivity.js'), 'utf8'),
    { ...context, window: context.window, document: context.document });
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
  assert.equal(refreshed.context.replaced, '/wsm-admin?locked=manual');
  assert.equal(jar.cookie, 'ws_admin_session=', 'the server cleared the HttpOnly cookie');
  jar.search = '?locked=manual';
  const locked = pageContext(jar);
  await locked.handlers.get('DOMContentLoaded')();
  assert.equal(locked.context.adminAuthenticated, false);
  assert.equal(locked.element('dashboard').classList.contains('hidden'), true);
  assert.match(locked.element('gate-error').textContent, /locked/);
  // Signing in with the password opens it again and lifts the lock mark.
  locked.element('gate-password').value = env.ADMIN_PASSWORD;
  await locked.handlers.get('gate-form:submit')({ preventDefault() {} });
  assert.equal(locked.context.adminAuthenticated, true);
  assert.equal(jar.store.wsAdminLocked, undefined);
});

test('a Lock whose logout never reached the server still keeps the console shut', async () => {
  const jar = { cookie: 'ws_admin_session=' + sessions.createSession(env) };
  const open = pageContext(jar);
  await open.handlers.get('DOMContentLoaded')();
  assert.equal(open.context.adminAuthenticated, true);
  jar.offline = true;                                   // the network drops as Lock is pressed
  await open.handlers.get('logout-btn:click')();
  assert.equal(open.context.replaced, '/wsm-admin?locked=manual');
  assert.match(jar.cookie, /^ws_admin_session=.+/, 'the cookie is still valid');
  jar.offline = false;
  const reloaded = pageContext(jar);
  await reloaded.handlers.get('DOMContentLoaded')();
  assert.equal(reloaded.context.adminAuthenticated, false, 'a leftover cookie does not reopen a locked console');
  assert.equal(reloaded.calls.includes('session'), false);
  assert.ok(reloaded.calls.includes('logout'), 'the page retries ending the cookie');
  assert.equal(jar.cookie, 'ws_admin_session=');
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

/* ------------------------------------------------ admin password attempts (SEC-09) */

/** A stand-in for the database limiter (ws_rate_hit / ws_rate_clear), shared like the real table. */
function limiter() {
  const hits = new Map();
  const fetch = async (url, init = {}) => {
    const fn = String(url).split('/rpc/')[1];
    const args = init.body ? JSON.parse(init.body) : {};
    if (fn === 'ws_rate_hit') {
      const n = (hits.get(args.p_key) || 0) + 1;
      hits.set(args.p_key, n);
      return new Response(JSON.stringify({ allowed: n <= args.p_max, hits: n, retry_after: 600 }), { status: 200 });
    }
    if (fn === 'ws_rate_clear') { hits.delete(args.p_key); return new Response('', { status: 204 }); }
    return new Response('[]', { status: 200 });
  };
  return { fetch, hits };
}
const from = ip => ({ 'x-forwarded-for': ip });

test('ten wrong admin passwords from one address shut it out, even for the right password', async () => {
  const db = limiter(), events = [];
  for (let i = 0; i < 10; i++) {
    const r = await backend(env, { fetch: db.fetch, events })({ action: 'login', password: 'guess-' + i }, '', from('203.0.113.5'));
    assert.equal(r.code, 401);
  }
  const blocked = await backend(env, { fetch: db.fetch, events })({ action: 'login', password: env.ADMIN_PASSWORD }, '', from('203.0.113.5'));
  assert.equal(blocked.code, 429);
  assert.equal(blocked.headers['Set-Cookie'], undefined);
  assert.ok(Number(blocked.headers['Retry-After']) > 0);
  assert.deepEqual(events, ['admin_password_locked'], 'one audit row when the address is first shut out');
  // Another address, and the cookie of an admin already signed in, are unaffected.
  assert.equal((await backend(env, { fetch: db.fetch })({ action: 'login', password: env.ADMIN_PASSWORD }, '', from('203.0.113.6'))).code, 200);
});

test('parallel guesses are counted before any password is checked: at most ten are tried', async () => {
  const db = limiter();
  const call = backend(env, { fetch: db.fetch });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => call({ action: 'results', password: 'guess-' + i }, '', from('198.51.100.20'))));
  const codes = results.map(r => r.code);
  assert.equal(codes.filter(c => c === 401).length, 10);
  assert.equal(codes.filter(c => c === 429).length, 10, 'every password-bearing action counts, not only login');
});

test('the right password clears its address\'s count', async () => {
  const db = limiter();
  for (let i = 0; i < 9; i++) await backend(env, { fetch: db.fetch })({ action: 'login', password: 'typo' }, '', from('192.0.2.44'));
  assert.equal((await backend(env, { fetch: db.fetch })({ action: 'login', password: env.ADMIN_PASSWORD }, '', from('192.0.2.44'))).code, 200);
  assert.equal(db.hits.has('admin-pw:ip:192.0.2.44'), false);
});

test('when the database limiter cannot be reached a per-instance count still holds, and no password is logged', async () => {
  const lines = [];
  const quiet = { ...console, warn: (...a) => lines.push(a.join(' ')) };
  const down = async () => new Response(JSON.stringify({ message: 'down' }), { status: 503 });
  const call = backend(env, { fetch: down, console: quiet });
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await call({ action: 'login', password: 'secret-guess-' + i }, '', from('203.0.113.99'))).code);
  assert.deepEqual(codes, [...Array(10).fill(401), 429, 429]);
  assert.ok(lines.some(l => l.includes('admin_password_rejected')));
  assert.equal(lines.some(l => l.includes('secret-guess')), false);
});

test('setup health is for administrators only and never carries a secret (F-01)', async () => {
  const config = { ...env, MAIL_API_KEY: 'mail-key-value-123', SMTP_PASS: 'smtp-pass-value-456', SMTP_HOST: 'mail.example' };
  assert.equal((await backend(config)({ action: 'setup_health' })).code, 401);
  const login = await backend(config)({ action: 'login', password: env.ADMIN_PASSWORD });
  const r = await backend(config)({ action: 'setup_health' }, login.headers['Set-Cookie'].split(';')[0]);
  assert.equal(r.code, 200);
  assert.ok(r.body.checks.length > 10);
  const text = JSON.stringify(r.body);
  for (const secret of [env.ADMIN_PASSWORD, env.SUPABASE_SERVICE_ROLE_KEY, 'mail-key-value-123', 'smtp-pass-value-456']) assert.equal(text.includes(secret), false, secret);
});
