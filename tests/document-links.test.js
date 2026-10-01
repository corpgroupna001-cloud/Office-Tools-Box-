// Public document links (SEC-07, F-05): no public copies, every view checked.
//
// The database half (supabase-document-links-migration.sql on PGlite) and the
// endpoint half: /api/public-document (api/linkpreview.js ?fn=document) run
// against a stand-in Supabase whose RPCs are the PGlite database, so turning
// a link off, expiring it or deleting the document is seen exactly as the
// endpoint would see it. Also the link-preview cache bound (PERF-02).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { freshDb, as, makeUser, pglite } = require('./fixtures/load-db');

const skip = pglite() ? false : 'WS_SKIP_DB_TESTS=1: database tests skipped on purpose';
const NOVA = 'Nova Sportsmart Private Limited';
const URL_ = 'https://db.example.test';

let db, A, C;
const q = async (uid, sql, params) => (await as(db, uid, () => db.query(sql, params))).rows;
const svc = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (uid, sql, params) => (await q(uid, sql, params))[0];
const json = v => (typeof v === 'string' ? JSON.parse(v) : v);
async function anon(sql, params) {
  await db.exec('set role anon');
  try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); }
}
let n = 0;
const token = () => (++n).toString(36).padStart(4, '0').repeat(8);
/** A stored file A owns, published under a fresh token. */
async function publishedFile(extra = {}) {
  const t = token();
  const doc = await one(A, `insert into documents (name, storage_path, mime_type, size_bytes) values ($1, $2, $3, 1200) returning id`,
    [extra.name || 'Quote.pdf', `${A}/${t}-quote.pdf`, extra.mime || 'application/pdf']);
  await q(A, `update documents set published_token = $1, published_at = now() where id = $2`, [t, doc.id]);
  return { id: doc.id, token: t };
}

test.before(async () => {
  if (skip) return;
  db = await freshDb();
  A = await makeUser(db, { email: 'anil@nova.test', name: 'Anil', company: NOVA });
  C = await makeUser(db, { email: 'chitra@nova.test', name: 'Chitra', company: NOVA });
});

/* ------------------------------------------------------------ database */
test('the published bucket is private and nobody can add copies to it any more', { skip }, async () => {
  assert.equal((await svc(`select public from storage.buckets where id = 'published'`))[0].public, false);
  const { token: t } = await publishedFile();
  await assert.rejects(q(A, `insert into storage.objects (bucket_id, name) values ('published', $1)`, [`${t}/file`]), /row-level security/);
});

test('a live link gives the server the stored file; off, expired or deleted gives nothing', { skip }, async () => {
  const f = await publishedFile();
  const live = json((await svc(`select public.ws_published_file($1) f`, [f.token]))[0].f);
  assert.equal(live.bucket, 'documents');
  assert.match(live.path, new RegExp(`^${A}/`));
  const pub = json((await anon(`select public.ws_published_document($1) d`, [f.token]))[0].d);
  assert.equal(pub.file, true);
  assert.equal('path' in pub, false, 'the public answer does not say where the file is stored');
  await assert.rejects(anon(`select public.ws_published_file($1)`, [f.token]), /permission denied/, 'server only');
  await assert.rejects(q(A, `select public.ws_published_file($1)`, [f.token]), /permission denied/);
  // Turned off.
  await q(A, `update documents set published_token = null, published_at = null where id = $1`, [f.id]);
  assert.equal((await svc(`select public.ws_published_file($1) f`, [f.token]))[0].f, null);
  assert.equal((await anon(`select public.ws_published_document($1) d`, [f.token]))[0].d, null);
  // Deleted (moved to the bin) while on.
  const g = await publishedFile();
  await svc(`update documents set archived_at = now() where id = $1`, [g.id]);
  assert.equal((await svc(`select public.ws_published_file($1) f`, [g.token]))[0].f, null);
});

test('expiring links: the database ends them on time; a past date is refused; a new link starts without one', { skip }, async () => {
  const f = await publishedFile();
  await assert.rejects(q(A, `update documents set published_expires_at = now() - interval '1 minute' where id = $1`, [f.id]), /cannot expire in the past/);
  await q(A, `update documents set published_expires_at = now() + interval '1 hour' where id = $1`, [f.id]);
  assert.ok(json((await svc(`select public.ws_published_file($1) f`, [f.token]))[0].f));
  // Time passes (bypassing the trigger, which rightly refuses setting a past date).
  await db.exec(`set session_replication_role = replica`);
  try { await svc(`update documents set published_expires_at = now() - interval '1 second' where id = $1`, [f.id]); }
  finally { await db.exec(`set session_replication_role = origin`); }
  assert.equal((await svc(`select public.ws_published_file($1) f`, [f.token]))[0].f, null, 'expired');
  assert.equal((await anon(`select public.ws_published_document($1) d`, [f.token]))[0].d, null);
  // The owner gives the same link a new expiry (the dialog's "Change expiry"): it opens again, then never expires.
  await q(A, `update documents set published_expires_at = now() + interval '7 days' where id = $1`, [f.id]);
  assert.ok(json((await svc(`select public.ws_published_file($1) f`, [f.token]))[0].f), 'an expired link with a new expiry works again');
  await q(A, `update documents set published_expires_at = null where id = $1`, [f.id]);
  assert.ok(json((await svc(`select public.ws_published_file($1) f`, [f.token]))[0].f));
  const t2 = token();
  await q(A, `update documents set published_token = $1 where id = $2`, [t2, f.id]);
  assert.equal((await svc(`select published_expires_at from documents where id = $1`, [f.id]))[0].published_expires_at, null, 'a new link does not inherit the old expiry');
  await q(A, `update documents set published_token = null where id = $1`, [f.id]);
  await q(A, `update documents set published_expires_at = now() + interval '1 day' where id = $1`, [f.id]);
  assert.equal((await svc(`select published_expires_at from documents where id = $1`, [f.id]))[0].published_expires_at, null, 'no expiry without a link');
  assert.equal((await q(C, `update documents set published_token = $1 where id = $2 returning id`, [token(), f.id])).length, 0, 'only editors publish');
});

/* ------------------------------------------------------------ endpoint */
function endpoint(state = {}) {
  const signed = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (state.down) throw new TypeError('fetch failed');
    const body = init.body ? JSON.parse(init.body) : {};
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const rpcFn = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (rpcFn) {
      const keys = Object.keys(body);
      try { return reply((await db.query(`select to_jsonb(public.${rpcFn[1]}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})) r`, keys.map(k => body[k]))).rows[0].r); }
      catch (e) { return reply({ code: e.code, message: e.message }, 400); }
    }
    const sign = url.pathname.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
    if (sign) {
      signed.push({ bucket: sign[1], path: decodeURIComponent(sign[2]), expiresIn: body.expiresIn });
      return reply({ signedURL: `/object/sign/${sign[1]}/${sign[2]}?token=signed-${signed.length}` });
    }
    throw new Error('unexpected ' + url.pathname);
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/linkpreview.js'), 'utf8'), {
    module, exports: module.exports, fetch, URL, Response, console, setTimeout, clearTimeout, Date, Map,
    process: { env: { SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: 'service-key' } },
    require: name => (name === '../lib/request-auth' ? require('../lib/request-auth') : name === '../lib/service-rpc' ? require('../lib/service-rpc') : require(name)),
  });
  const call = async (query) => {
    const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; },
      json(b) { this.body = b; return this; }, end() { return this; } };
    await module.exports({ method: 'GET', query: { fn: 'document', ...query }, headers: { 'x-forwarded-for': '203.0.113.50' } }, res);
    return res;
  };
  return { call, signed, module };
}

test('/api/public-document checks the link on every request and hands out a one-minute signed URL', { skip }, async () => {
  const f = await publishedFile();
  const e = endpoint();
  const first = await e.call({ t: f.token });
  assert.equal(first.code, 302);
  assert.equal(first.headers['Cache-Control'], 'no-store');
  assert.match(first.headers.Location, /^https:\/\/db\.example\.test\/storage\/v1\/object\/sign\/documents\//);
  assert.deepEqual(e.signed.map(s => s.expiresIn), [60]);
  assert.match(e.signed[0].path, new RegExp(`^${A}/`), 'the original file, not a copy');
  const dl = await e.call({ t: f.token, download: '1' });
  assert.equal(new URL(dl.headers.Location).searchParams.get('download'), 'Quote.pdf');
  // Turned off: the very next request is refused, whatever was handed out before.
  await q(A, `update documents set published_token = null where id = $1`, [f.id]);
  const after = await e.call({ t: f.token });
  assert.equal(after.code, 404);
  assert.equal(e.signed.length, 2, 'nothing more is signed');
});

test('audio and video get a longer-lived URL so playback does not stop; bad tokens and outages are refused', { skip }, async () => {
  const v = await publishedFile({ name: 'Demo.mp4', mime: 'video/mp4' });
  const e = endpoint();
  assert.equal((await e.call({ t: v.token })).code, 302);
  assert.equal(e.signed[0].expiresIn, 900);
  assert.equal((await e.call({ t: 'short' })).code, 404);
  assert.equal((await e.call({ t: 'z'.repeat(32) })).code, 404, 'unknown token');
  const down = endpoint({ down: true });
  assert.equal((await down.call({ t: v.token })).code, 503, 'cannot check: refuse');
  await svc(`update documents set archived_at = now() where id = $1`, [v.id]);
  assert.equal((await e.call({ t: v.token })).code, 404, 'deleted');
});

/* ------------------------------------------------------- PERF-02 cache */
test('the link-preview cache stays bounded and forgets expired answers, whatever kind of page answered', () => {
  const { module } = endpoint();
  const { CACHE, cached, remember, CACHE_MAX, CACHE_TTL } = module.exports.cache;
  CACHE.clear();
  const t0 = 1_000_000;
  for (let i = 0; i < CACHE_MAX * 3; i++) remember(`https://files.example/${i}.pdf`, { title: 'pdf' }, t0 + i);
  assert.equal(CACHE.size, CACHE_MAX, 'never more than the bound');
  assert.equal(cached('https://files.example/0.pdf', t0 + 10), null, 'the oldest went first');
  assert.ok(cached(`https://files.example/${CACHE_MAX * 3 - 1}.pdf`, t0 + CACHE_MAX * 3));
  const later = t0 + CACHE_MAX * 3 + CACHE_TTL + 1;
  assert.equal(cached(`https://files.example/${CACHE_MAX * 3 - 2}.pdf`, later), null, 'expired');
  CACHE.clear();
  for (let i = 0; i < CACHE_MAX; i++) remember(`https://old.example/${i}`, { title: 'old' }, t0);
  remember('https://fresh.example/', { title: 'x' }, t0 + CACHE_TTL + 1);
  assert.equal(CACHE.size, 1, 'a full cache clears expired entries before evicting live ones');
});

test('a non-HTML answer goes through the same bounded insert (the path that used to skip it)', async () => {
  // Fake http/https: every URL answers 200 with a PDF, the case PERF-02 was about.
  const fakeLib = { request(u, opts, cb) {
    const req = new EventEmitter(); req.end = () => {
      const res = new EventEmitter(); res.statusCode = 200; res.headers = { 'content-type': 'application/pdf' };
      res.resume = () => {}; res.destroy = () => {}; res.setEncoding = () => {};
      setImmediate(() => cb(res));
    }; req.destroy = () => {}; return req; } };
  const module = { exports: {} };
  const fetch = async () => new Response(JSON.stringify({ id: 'u1', email: 'a@b.co' }), { status: 200 });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/linkpreview.js'), 'utf8'), {
    module, exports: module.exports, fetch, URL, Response, console, setTimeout, clearTimeout, Date, Map, setImmediate,
    process: { env: { SUPABASE_URL: URL_, SUPABASE_ANON_KEY: 'anon' } },
    require: name => (name === 'http' || name === 'https' ? fakeLib : name === '../lib/request-auth' ? require('../lib/request-auth')
      : name === '../lib/service-rpc' ? require('../lib/service-rpc') : require(name)),
  });
  const { CACHE, CACHE_MAX } = module.exports.cache;
  for (let i = 0; i < CACHE_MAX + 40; i++) {
    const res = { code: 200, headers: {}, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
    await module.exports({ method: 'GET', query: { url: `https://8.8.8.8/doc-${i}.pdf` }, headers: { authorization: 'Bearer t' } }, res);
    assert.equal(res.code, 200);
  }
  assert.equal(CACHE.size, CACHE_MAX);
});
