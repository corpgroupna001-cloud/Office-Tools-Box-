#!/usr/bin/env node
// @ts-check
// Local development server (npm run dev): the site the way Vercel serves it,
// without the Vercel CLI or an account.
//
//   - static files with cleanUrls (/crm → crm/index.html, /x → x.html);
//   - vercel.json redirects and rewrites (":param" and ":path*" patterns,
//     query strings in destinations, e.g. /api/ice → /api/push?fn=ice);
//   - /api/<name> runs api/<name>.js with Vercel's Node helpers (req.query,
//     req.body, res.status().json() / .send() / .redirect());
//   - environment from .env.local (copy .env.example), then the shell.
//
// It talks to whatever Supabase project .env.local names: use a development
// project, never production data. Handlers are re-loaded on every request, so
// edits show up without a restart. Cron schedules do not run.
//
//   PORT=3000 npm run dev
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm' };
// Never served: tooling, tests, secrets (as Vercel's .vercelignore and the build do).
const PRIVATE = /^\/(?:\.|node_modules\/|tests\/|scripts\/|desktop\/|mobile\/|types\/|lib\/|api\/.*\.js$|package(?:-lock)?\.json$|tsconfig|eslint\.config|tailwind\.config)/;

/** KEY=value lines; quotes stripped; existing environment wins. */
function loadEnv(file, env = process.env) {
  if (!fs.existsSync(file)) return 0;
  let n = 0;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (!(m[1] in env)) { env[m[1]] = v; n++; }
  }
  return n;
}

/** A vercel.json "source" as a matcher: { re, keys } for ":name" and ":name*" segments. */
function compile(source) {
  const keys = [];
  const re = new RegExp('^' + source.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\/:(\w+)\*/g, (_, k) => { keys.push(k); return '(?:/(.*))?'; })
    .replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  return { re, keys };
}
function applyRules(rules, pathname) {
  for (const r of rules || []) {
    const { re, keys } = compile(r.source);
    const m = re.exec(pathname);
    if (!m) continue;
    let dest = r.destination;
    keys.forEach((k, i) => { dest = dest.replace(new RegExp(`:${k}\\*?`, 'g'), m[i + 1] || ''); });
    return { rule: r, dest };
  }
  return null;
}

function staticFile(pathname) {
  const clean = decodeURIComponent(pathname).replace(/\/+$/, '') || '/';
  if (PRIVATE.test(clean) || clean.includes('..')) return null;
  const base = path.join(ROOT, clean);
  for (const f of [base, base + '.html', path.join(base, 'index.html')]) {
    try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/** Vercel's Node helpers on top of http.ServerResponse. */
function vercelResponse(res) {
  const r = /** @type {any} */ (res);
  r.status = code => { res.statusCode = code; return r; };
  r.json = obj => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); return r; };
  r.send = body => {
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return r.json(body);
    res.end(body == null ? '' : body); return r;
  };
  r.redirect = (a, b) => { const [code, url] = typeof a === 'number' ? [a, b] : [307, a]; res.statusCode = code; res.setHeader('Location', url); res.end(); return r; };
  return r;
}

async function runApi(name, req, res, url) {
  const file = path.join(ROOT, 'api', name + '.js');
  if (!/^[\w-]+$/.test(name) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('Not found'); }
  // Fresh code on every request: drop this repo's handlers and helpers from the require cache.
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'api')) || k.startsWith(path.join(ROOT, 'lib')) || k === path.join(ROOT, 'company-config.js')) delete require.cache[k];
  const raw = await readBody(req);
  const type = String(req.headers['content-type'] || '');
  let body = raw;
  if (type.includes('application/json')) { try { body = raw ? JSON.parse(raw) : {}; } catch { body = raw; } }
  else if (type.includes('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(raw));
  const r = /** @type {any} */ (req);
  r.query = Object.fromEntries(url.searchParams);
  r.body = body;
  try { await require(file)(r, vercelResponse(res)); }
  catch (e) {
    console.error(`[dev] /api/${name}`, e);
    if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message || 'Internal error' })); }
  }
}

function createServer() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  return http.createServer(async (req, res) => {
    let url = new URL(req.url || '/', 'http://localhost');
    const redirect = applyRules(config.redirects, url.pathname);
    if (redirect) { res.statusCode = redirect.rule.permanent ? 308 : 307; res.setHeader('Location', redirect.dest); return res.end(); }
    // Vercel serves a real file before it rewrites; API paths go to their function.
    if (!url.pathname.startsWith('/api/') || !fs.existsSync(path.join(ROOT, url.pathname.replace(/\/+$/, '') + '.js'))) {
      const rewrite = staticFile(url.pathname) ? null : applyRules(config.rewrites, url.pathname);
      if (rewrite) {
        const dest = new URL(rewrite.dest, 'http://localhost');
        url.searchParams.forEach((v, k) => { if (!dest.searchParams.has(k)) dest.searchParams.set(k, v); });
        url = dest;
      }
    }
    if (url.pathname.startsWith('/api/')) return runApi(url.pathname.slice(5).replace(/\/+$/, ''), req, res, url);
    const file = staticFile(url.pathname);
    if (!file) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain'); return res.end('Not found'); }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(file).pipe(res);
  });
}

if (require.main === module) {
  const n = loadEnv(path.join(ROOT, '.env.local'));
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => {
    console.log(`WorkSuite on http://localhost:${port}  (${n} settings from .env.local${n ? '' : ' — copy .env.example to .env.local'})`);
  });
}

module.exports = { createServer, loadEnv, compile, applyRules, staticFile };
