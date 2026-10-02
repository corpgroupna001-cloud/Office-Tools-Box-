#!/usr/bin/env node
// Browser assets the pages load from this site instead of a CDN (DEP-03):
//
//   ui/vendor/*.js     third-party libraries at the exact versions in
//                      package.json, copied from node_modules
//   ui/tailwind.css    Tailwind compiled ahead of time (tailwind.config.js)
//
//   npm run build:assets            writes them
//   node scripts/build-assets.js --check
//                            exits 1 when a committed file differs from what
//                            the build would write (npm run check runs this)
//
// The outputs are committed, so Vercel serves them as static files and the
// deployment needs no build step.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const pkg = name => JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;

// published file -> [package, file inside it]
const VENDOR = {
  'ui/vendor/supabase-js.js': ['@supabase/supabase-js', 'dist/umd/supabase.js'],
  'ui/vendor/chart.umd.js': ['chart.js', 'dist/chart.umd.js'],
  'ui/vendor/html2canvas.min.js': ['html2canvas', 'dist/html2canvas.min.js'],
  'ui/vendor/confetti.browser.js': ['canvas-confetti', 'dist/confetti.browser.js'],
};

function vendored(name, file) {
  const src = path.join(ROOT, 'node_modules', name, file);
  if (!fs.existsSync(src)) throw new Error(`${name} is not installed: run npm ci`);
  const declared = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).devDependencies || {})[name];
  if (!declared || !/^\d+\.\d+\.\d+$/.test(declared)) throw new Error(`${name} must be pinned to an exact version in package.json (found ${declared})`);
  if (pkg(name) !== declared) throw new Error(`${name} ${pkg(name)} is installed but package.json pins ${declared}: run npm ci`);
  return `/*! ${name}@${declared} — vendored by scripts/build-assets.js; do not edit */\n` + fs.readFileSync(src, 'utf8');
}

function tailwind() {
  const bin = path.join(ROOT, 'node_modules', '.bin', 'tailwindcss');
  if (!fs.existsSync(bin)) throw new Error('tailwindcss is not installed: run npm ci');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-tw-')), 'tailwind.css');
  execFileSync(bin, ['-c', path.join(ROOT, 'tailwind.config.js'), '-i', path.join(__dirname, 'tailwind.input.css'), '-o', out, '--minify'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  const css = fs.readFileSync(out, 'utf8');
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  return `/*! Tailwind CSS v${pkg('tailwindcss')} — built by scripts/build-assets.js from tailwind.config.js; do not edit */\n` + css;
}

function outputs() {
  const files = {};
  for (const [dest, [name, file]] of Object.entries(VENDOR)) files[dest] = vendored(name, file);
  files['ui/tailwind.css'] = tailwind();
  return files;
}

const check = process.argv.includes('--check');
let files;
try { files = outputs(); }
catch (e) { console.error(e.message); process.exit(1); }
const stale = [];
for (const [dest, text] of Object.entries(files)) {
  const full = path.join(ROOT, dest);
  const now = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
  if (now === text) continue;
  if (check) stale.push(dest);
  else { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); console.log('wrote', dest, `(${Math.round(text.length / 1024)} KB)`); }
}
if (check && stale.length) {
  console.error(`out of date (run npm run build:assets): ${stale.join(', ')}`);
  process.exit(1);
}
if (check) console.log(`assets up to date: ${Object.keys(files).length} files`);
