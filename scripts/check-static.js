#!/usr/bin/env node
// Static checks for a site with no build step (npm run check):
//
//   - every local <script src> / <link href> in an HTML page points at a file
//     that exists (absolute paths resolve from the repository root, as Vercel
//     serves them);
//   - external scripts come from an allowed CDN at an exact version, and no
//     page compiles Tailwind at run time;
//   - the vendored libraries and ui/tailwind.css match what npm run build:assets
//     writes (scripts/build-assets.js --check);
//   - vercel.json parses, every function it names exists, every /api rewrite
//     lands on a real function, and the Hobby plan limits hold
//     (12 functions, 2 crons);
//   - every migration file is run by the test database (tests/fixtures/load-db.js),
//     and every one in the CRM set is named in SETUP.md, so a new one cannot be
//     forgotten in either.
//
// Exits 1 with a list of problems, 0 when everything holds.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', '.vercel', '__cdn', 'exports', 'desktop', 'mobile', 'out']);
const MAX_FUNCTIONS = 12;
const MAX_CRONS = 2;
// Files that are not deployment migrations: a destructive reset (never run on
// live data), the matching reseed, a demo seed and the PGlite stand-in.
const NOT_MIGRATIONS = new Set(['supabase-full-reset.sql', 'supabase-reseed-after-reset.sql', 'supabase-crm-demo-seed.sql']);
// External hosts pages may load code from. Each URL must name an exact version.
const CDN_HOSTS = new Set(['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com']);

const problems = [];
const problem = (file, msg) => problems.push(`${file}: ${msg}`);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') { if (SKIP_DIRS.has(entry.name) || entry.isDirectory()) continue; }
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out); else out.push(full);
  }
  return out;
}
const rel = f => path.relative(ROOT, f).split(path.sep).join('/');

/* ------------------------------------------------------------ HTML refs */
function checkReference(page, ref, kind) {
  if (/^(data:|blob:|mailto:|tel:|#|javascript:)/i.test(ref)) return;
  if (/^(https?:)?\/\//i.test(ref)) {
    const url = new URL(ref, 'https://x.invalid');
    if (kind === 'script') {
      if (url.hostname === 'cdn.tailwindcss.com') return problem(page, `runtime Tailwind (${ref}): link the prebuilt /ui/tailwind.css (npm run build:assets)`);
      if (!CDN_HOSTS.has(url.hostname)) return problem(page, `script from an unexpected host: ${ref}`);
      if (!/@\d+\.\d+\.\d+(?:[-+][\w.]+)?(\/|$)/.test(url.pathname)) problem(page, `external script without an exact version: ${ref}`);
    }
    return;
  }
  const clean = ref.split(/[?#]/)[0];
  if (!clean) return;
  const target = clean.startsWith('/') ? path.join(ROOT, clean) : path.join(path.dirname(path.join(ROOT, page)), clean);
  const candidates = [target, target + '.html', path.join(target, 'index.html')];
  if (!candidates.some(c => fs.existsSync(c) && fs.statSync(c).isFile())) problem(page, `${kind} reference to a missing file: ${ref}`);
}

const files = walk(ROOT);
const pages = files.filter(f => f.endsWith('.html')).map(rel);
for (const page of pages) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) checkReference(page, m[1], 'script');
  for (const m of html.matchAll(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi)) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    if (href) checkReference(page, href[1], 'stylesheet');
  }
}
// Scripts that load other scripts at run time (the auth guard's fallback loader).
for (const file of files.filter(f => f.endsWith('.js')).map(rel)) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const m of src.matchAll(/['"](https:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)\/[^'"]+\.js|https:\/\/cdn\.jsdelivr\.net\/npm\/[^'"]+)['"]/g)) {
    if (file.startsWith('tests/') || file.startsWith('scripts/')) continue;
    checkReference(file, m[1], 'script');
  }
}

/* ------------------------------------------------------------ deploy build */
// Vercel runs `npm run build` (or `vercel-build`) on every deploy when one is
// defined, after .vercelignore has removed scripts/. Nothing needs building
// there - ui/vendor and ui/tailwind.css are committed - so neither may exist.
const pkgScripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts || {};
for (const name of ['build', 'vercel-build']) {
  if (pkgScripts[name]) problem('package.json', `a "${name}" script runs on every Vercel deploy, where scripts/ is not uploaded; the assets are committed, so call it "build:assets"`);
}

/* ------------------------------------------------------------ vercel.json */
let vercel = null;
try { vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')); }
catch (e) { problem('vercel.json', 'is not valid JSON: ' + e.message); }
const functions = fs.readdirSync(path.join(ROOT, 'api')).filter(f => f.endsWith('.js'));
if (functions.length > MAX_FUNCTIONS) problem('api/', `${functions.length} serverless functions; the Vercel Hobby plan allows ${MAX_FUNCTIONS}. Extend an existing handler and reach it through a rewrite.`);
if (vercel) {
  for (const name of Object.keys(vercel.functions || {})) {
    if (!fs.existsSync(path.join(ROOT, name))) problem('vercel.json', `functions names a missing file: ${name}`);
  }
  if ((vercel.crons || []).length > MAX_CRONS) problem('vercel.json', `${vercel.crons.length} crons; the Hobby plan allows ${MAX_CRONS}`);
  for (const c of vercel.crons || []) {
    const fn = String(c.path || '').split('?')[0].replace(/^\//, '') + '.js';
    if (!fs.existsSync(path.join(ROOT, fn))) problem('vercel.json', `cron path has no function: ${c.path}`);
  }
  for (const r of vercel.rewrites || []) {
    const dest = String(r.destination || '').split('?')[0];
    if (vercel.cleanUrls && dest.startsWith('/') && /\.html$/.test(dest)) {
      problem('vercel.json', `rewrite ${r.source} → ${dest} must omit .html when cleanUrls is enabled`);
    }
    if (dest.startsWith('/api/')) {
      if (!fs.existsSync(path.join(ROOT, dest.slice(1) + '.js'))) problem('vercel.json', `rewrite ${r.source} → missing function ${dest}`);
    } else if (dest.startsWith('/') && !dest.includes(':')) {
      const file = path.join(ROOT, dest);
      const candidates = [file, path.join(file, 'index.html')];
      if (vercel.cleanUrls) candidates.push(file + '.html');
      if (!candidates.some(f => fs.existsSync(f) && fs.statSync(f).isFile())) {
        problem('vercel.json', `rewrite ${r.source} → missing file ${dest}`);
      }
    }
  }
}

/* ------------------------------------------------------------ migrations */
const { BASE, CRM } = require('../tests/fixtures/load-db');
const loaded = new Set([...BASE, ...CRM]);
const setup = fs.readFileSync(path.join(ROOT, 'SETUP.md'), 'utf8');
for (const f of loaded) if (!fs.existsSync(path.join(ROOT, f))) problem('tests/fixtures/load-db.js', `lists a missing migration: ${f}`);
for (const f of fs.readdirSync(ROOT).filter(f => /^supabase-.*\.sql$/.test(f))) {
  if (NOT_MIGRATIONS.has(f)) continue;
  if (!loaded.has(f)) problem(f, 'is not run by tests/fixtures/load-db.js');
  if (CRM.includes(f) && !setup.includes(f)) problem(f, 'is not described in SETUP.md');
}

/* ------------------------------------------------------------ assets */
try {
  require('node:child_process').execFileSync(process.execPath, [path.join(__dirname, 'build-assets.js'), '--check'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
} catch (e) {
  problem('ui/vendor, ui/tailwind.css', String((e.stderr && e.stderr.toString()) || e.message).trim());
}

/* ------------------------------------------------------------ report */
if (problems.length) {
  console.error(`${problems.length} static check problem(s):\n  ` + problems.join('\n  '));
  process.exit(1);
}
console.log(`static checks passed: ${pages.length} pages, ${functions.length}/${MAX_FUNCTIONS} functions, ${loaded.size} migrations`);
