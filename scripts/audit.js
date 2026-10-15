#!/usr/bin/env node
/* ===========================================================================
 * npm audit, with a short, dated list of accepted advisories.
 *
 *   node scripts/audit.js [--level high] [--dir desktop]
 *
 * Fails (exit 1) on any advisory at or above --level, EXCEPT ones listed in
 * scripts/audit-allowlist.json. Every entry there needs a reason and a
 * review_by date; once that date passes the entry stops counting and CI
 * fails again, so an exception cannot quietly become permanent. An entry that
 * no longer matches anything is reported, so the list does not rot either.
 *
 * Why not `npm audit --audit-level=high` alone: it has no way to accept an
 * advisory that has no fixed release (braces <= 3.0.3 under Tailwind 3), so
 * one dev-only build tool kept every CI run red and hid new problems.
 * =========================================================================== */
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const level = opt('level', 'high');
const dir = path.resolve(__dirname, '..', opt('dir', '.'));
if (!(level in RANK)) { console.error(`unknown --level ${level}`); process.exit(2); }

let report;
try {
  report = execFileSync('npm', ['audit', '--json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
} catch (e) {
  report = e.stdout;            // npm audit exits non-zero whenever it finds anything
}
let data;
try { data = JSON.parse(report || '{}'); } catch { console.error('npm audit did not return JSON:\n' + String(report).slice(0, 500)); process.exit(2); }
if (data.error) { console.error('npm audit failed:', JSON.stringify(data.error)); process.exit(2); }

const allowFile = path.join(__dirname, 'audit-allowlist.json');
const today = new Date().toISOString().slice(0, 10);
const allow = (fs.existsSync(allowFile) ? JSON.parse(fs.readFileSync(allowFile, 'utf8')) : [])
  .filter(a => !a.dir || path.resolve(__dirname, '..', a.dir) === dir);
const active = new Map(allow.filter(a => a.review_by >= today).map(a => [a.advisory, a]));
const used = new Set();

// Advisories are the objects in `via`; packages that only depend on a
// vulnerable package list its name there as a string and are covered by it.
const failing = [];
for (const [pkg, v] of Object.entries(data.vulnerabilities || {})) {
  for (const via of v.via || []) {
    if (typeof via !== 'object' || RANK[via.severity] < RANK[level]) continue;
    const id = String(via.url || '').split('/').pop();
    if (active.has(id)) { used.add(id); continue; }
    failing.push(`${via.severity.padEnd(8)} ${pkg} ${via.range}  ${via.title}  ${via.url}`);
  }
}

const rel = path.relative(path.resolve(__dirname, '..'), dir) || '.';
for (const a of allow) {
  if (a.review_by < today) console.log(`expired:  ${a.advisory} (review_by ${a.review_by}) - re-check it: ${a.reason}`);
  else if (used.has(a.advisory)) console.log(`accepted: ${a.advisory} until ${a.review_by} - ${a.reason}`);
  else console.log(`unused:   ${a.advisory} no longer reported in ${rel}; remove it from scripts/audit-allowlist.json`);
}
if (failing.length) {
  console.error(`\nnpm audit (${rel}): ${failing.length} advisory(ies) at or above "${level}":`);
  failing.forEach(f => console.error('  ' + f));
  console.error('\nFix them (npm audit fix), or - only if there is no fix and it cannot be reached in production - add a dated entry to scripts/audit-allowlist.json.');
  process.exit(1);
}
console.log(`npm audit (${rel}): nothing at or above "${level}" outside the allowlist.`);
