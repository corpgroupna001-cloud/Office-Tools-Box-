// scripts/dev-server.js — the local server behind `npm run dev` (QUAL-01):
// static pages with clean URLs, vercel.json rewrites and redirects, and the
// /api handlers with Vercel's helpers. No network: the handlers called here
// answer from the environment alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dev = require('../scripts/dev-server');

let server, base;
test.before(async () => {
  process.env.SUPABASE_URL = 'https://dev-project.supabase.example';
  process.env.SUPABASE_ANON_KEY = 'anon-dev-key';
  server = dev.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test('pages are served with clean URLs; private files are not', async () => {
  const crm = await fetch(base + '/crm');
  assert.equal(crm.status, 200);
  assert.match(crm.headers.get('content-type'), /text\/html/);
  assert.equal((await fetch(base + '/ui/vendor/supabase-js.js')).status, 200);
  for (const p of ['/package.json', '/.env.example', '/api/config.js', '/lib/mailer.js', '/tests/fixtures/load-db.js', '/scripts/dev-server.js', '/%2e%2e/%2e%2e/etc/hosts']) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
});

test('/api handlers run with Vercel helpers and the environment', async () => {
  const r = await fetch(base + '/api/config');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.supabaseUrl, 'https://dev-project.supabase.example');
  assert.equal(j.supabaseAnonKey, 'anon-dev-key');
});

test('vercel.json rewrites (with their query) and redirects apply', async () => {
  const admin = await fetch(base + '/wsm-admin/employees');
  assert.equal(admin.status, 200, ':path* rewrite to the admin page');
  assert.match(await admin.text(), /Administration/);
  const red = await fetch(base + '/admin', { redirect: 'manual' });
  assert.equal(red.status, 307);
  assert.equal(red.headers.get('location'), '/wsm-admin');
  // /api/ice → /api/push?fn=ice: reaches push.js, which wants a signed-in caller.
  const ice = await fetch(base + '/api/ice');
  assert.ok([401, 500].includes(ice.status), `push handler answered ${ice.status}`);
});

test('.env.local fills only what the shell has not set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-env-'));
  const file = path.join(dir, '.env.local');
  fs.writeFileSync(file, '# comment\nA_ONE=1\nA_TWO="two words"\nALREADY=from-file\n\nnot a line\n');
  const env = { ALREADY: 'from-shell' };
  assert.equal(dev.loadEnv(file, env), 2);
  assert.deepEqual(env, { ALREADY: 'from-shell', A_ONE: '1', A_TWO: 'two words' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rule patterns: :param and :path*', () => {
  assert.deepEqual(dev.applyRules([{ source: '/wsm-admin/:path*', destination: '/wsm-admin/index.html' }], '/wsm-admin/a/b').dest, '/wsm-admin/index.html');
  assert.equal(dev.applyRules([{ source: '/x/:id', destination: '/y?id=:id' }], '/x/42').dest, '/y?id=42');
  assert.equal(dev.applyRules([{ source: '/x/:id', destination: '/y' }], '/z'), null);
});
