#!/usr/bin/env node
// Browser smoke test for every WorkSuite page — opt-in, not part of `npm test`:
//
//     npm run smoke:ui            (CHROME_PATH=/path/to/chrome to pick a browser)
//
// Serves the repository the way Vercel does (cleanUrls), answers Supabase from
// fixture rows on the same origin (tests/ui-smoke/fixtures.js), signs in as a
// fictional manager, and drives the installed Chrome through each page at
// desktop and phone width. A page fails on an uncaught script error, a
// "could not load" state on screen, a missing app shell, or horizontal
// overflow on a phone. Screenshots go to tests/ui-smoke/out/ (git-ignored).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const F = require('./fixtures');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
let puppeteer;
try { puppeteer = require('puppeteer-core'); } catch { console.error('puppeteer-core is missing: run npm install'); process.exit(2); }
const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => fs.existsSync(p));
if (!CHROME) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2); }

const PAGES = [
  ['/', 'home'], ['/', 'signin'], ['/', 'pending'], ['/crm', 'crm'], ['/crm/settings', 'crm-settings'], ['/companies', 'companies'],
  ['/contacts', 'contacts'], ['/contacts?id=C1', 'contact-record'],
  ['/leads', 'leads'], ['/leads?view=list', 'leads-list'], ['/leads?id=L1', 'lead-record'], ['/leads?id=L4', 'lead-imported'],
  ['/deals', 'deals'], ['/deals?view=list', 'deals-list'], ['/deals?id=D1', 'deal-record'], ['/deals?id=D4', 'deal-imported'],
  ['/boards', 'boards'], ['/boards?id=B1', 'board'],
  ['/projects', 'projects'], ['/projects?id=P1', 'project-record'],
  ['/tasks', 'tasks'], ['/tasks?id=T1', 'task-record'], ['/tasks?id=new', 'task-new'], ['/tasks?id=new', 'task-people'],
  ['/documents', 'documents'], ['/documents?id=DOC1', 'document-record'],
  ['/documents/public?t=smokepublic0000000000000000000001', 'public-doc'], ['/documents/public?t=smokeoff00000000000000000000000001', 'public-doc-off'],
  ['/calendar', 'calendar'], ['/calendar?view=day', 'calendar-day'], ['/calendar?view=week', 'calendar-week'],
  ['/calendar?view=month', 'calendar-month'], ['/calendar?view=schedule', 'calendar-schedule'], ['/calendar?view=month', 'calendar-partial'], ['/employees', 'employees'],
  ['/employees?view=tiles', 'employees-tiles'], ['/employees/structure/', 'org-chart'], ['/employees?id=22222222-2222-4222-8222-222222222222', 'employee-record'],
  ['/invoices', 'invoices'], ['/invoices?id=I1', 'invoice-record'],
  ['/quotes', 'quotes'], ['/quotes?id=Q1', 'quote-record'], ['/crm/forecast', 'forecast'],
  ['/crm/settings?section=lost', 'crm-lost-reasons'], ['/crm/settings?section=forms', 'crm-web-forms'], ['/form?f=smoke0000000000000000000000000001', 'web-form'],
  ['/chat', 'messenger'], [`/call?id=${F.CALL}`, 'call'], ['/attendance', 'attendance'],
  ['/wsm-admin', 'admin'], ['/wsm-admin?gate=1', 'admin-gate'], ['/wsm-admin/employees', 'admin-employees'], ['/wsm-admin?tab=attendance', 'admin-legacy-tab'], ['/crm', 'themes'], ['/crm', 'dialogs'], ['/crm', 'paging'], ['/tasks', 'task-complete'], ['/typingtest', 'typing'], ['/mcqquiz', 'quiz'], ['/signature', 'signature'], ['/recordings', 'recordings'],
];
const CRM_PAGES = new Set(['crm', 'crm-settings', 'companies', 'contacts', 'contact-record', 'leads', 'leads-list', 'lead-record', 'lead-imported', 'deals', 'deals-list', 'deal-record', 'deal-imported', 'boards', 'board', 'projects',
  'project-record', 'tasks', 'task-record', 'task-new', 'task-people', 'documents', 'document-record', 'calendar', 'calendar-day', 'calendar-week', 'calendar-month', 'calendar-schedule', 'employees', 'employees-tiles', 'org-chart', 'employee-record', 'invoices', 'invoice-record', 'quotes', 'quote-record', 'forecast', 'crm-lost-reasons', 'crm-web-forms']);
const VIEWPORTS = [['desktop', { width: 1366, height: 900 }], ['phone', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]];

// SMOKE_BIG=1 fills every list with far more rows than fits on screen, so the
// scroll checks below meet long chats, long tables and long menus.
// SMOKE_SCROLL=1 makes scroll findings fail the run instead of being notes.
const BIG = process.env.SMOKE_BIG === '1';
const SCROLL_STRICT = process.env.SMOKE_SCROLL === '1';

/* -------------------------------------------------------------- server */
let DB = F.db({ big: BIG });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { r(b ? JSON.parse(b) : null); } catch { r(null); } }); });

// PostgREST filters used by the pages: eq / neq / is / in / gt / gte / lt / lte / not.is.
// Anything else (or=, ilike, cs) is ignored, which only makes results broader.
function filterFn(col, expr) {
  const m = /^(not\.)?(eq|neq|is|in|gt|gte|lt|lte)\.(.*)$/s.exec(expr);
  if (!m) return () => true;
  const [, not, op, raw] = m;
  const val = raw === 'null' ? null : raw === 'true' ? true : raw === 'false' ? false : raw;
  const list = op === 'in' ? raw.replace(/^\(|\)$/g, '').split(',').map(s => s.replace(/^"|"$/g, '')) : null;
  const test = r => {
    const v = r[col];
    switch (op) {
      case 'eq': return String(v) === String(val);
      case 'neq': return String(v) !== String(val);
      case 'is': return val === null ? v == null : v === val;
      case 'in': return list.includes(String(v));
      case 'gt': return v != null && String(v) > String(val);
      case 'gte': return v != null && String(v) >= String(val);
      case 'lt': return v != null && String(v) < String(val);
      case 'lte': return v != null && String(v) <= String(val);
    }
    return true;
  };
  return not ? r => !test(r) : test;
}
const MAX_ROWS = 1000;
const SKIP_PARAMS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'or', 'and']);
const FK_OF = { calendar_events: 'event_id', documents: 'document_id', invoices: 'invoice_id', projects: 'project_id', tasks: 'task_id',
  conversations: 'conversation_id', crm_deals: 'deal_id', crm_contacts: 'contact_id', boards: 'board_id', calls: 'call_id' };
function embed(row, select, table) {
  if (!select || !select.includes('(')) return row;
  const out = { ...row };
  for (const m of select.matchAll(/(?:^|,)\s*(?:(\w+):)?(\w+)\(/g)) {
    const alias = m[1] || m[2], target = m[2];
    const rows = DB[target] || [];
    if (row[`${alias}_id`] !== undefined) out[alias] = rows.find(r => String(r.id) === String(row[`${alias}_id`])) || null;
    else if (row[`${target.replace(/s$/, '')}_id`] !== undefined) out[alias] = rows.find(r => String(r.id) === String(row[`${target.replace(/s$/, '')}_id`])) || null;
    else { const fk = FK_OF[table]; out[alias] = fk ? rows.filter(r => String(r[fk]) === String(row.id)) : []; }
  }
  return out;
}
function orderRows(rows, order) {
  if (!order) return rows;
  const keys = order.split(',').map(s => { const [col, dir] = s.split('.'); return { col, desc: dir === 'desc' }; });
  return rows.slice().sort((a, b) => {
    for (const k of keys) {
      const x = a[k.col], y = b[k.col];
      if (x == y) continue; // eslint-disable-line eqeqeq
      if (x == null) return 1; if (y == null) return -1;
      return (x < y ? -1 : 1) * (k.desc ? -1 : 1);
    }
    return 0;
  });
}
async function supabase(req, res, url) {
  const p = url.pathname.slice('/sb'.length);
  const body = await readBody(req);
  const stamp = new Date().toISOString();
  if (p.startsWith('/auth/v1/user')) return send(res, 200, F.session().user);
  if (p.startsWith('/auth/v1/token')) return send(res, 200, F.session());
  if (p.startsWith('/auth/v1/')) return send(res, 200, {});
  if (p.startsWith('/storage/v1/object/sign/')) return send(res, 200, { signedURL: '/object/public/placeholder.png' });
  if (p.startsWith('/storage/v1/object/public/')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return fs.createReadStream(path.join(ROOT, 'icon-192.png')).pipe(res); }
  if (p.startsWith('/storage/v1/')) return send(res, 200, { Key: 'documents/smoke' });
  if (p.startsWith('/rest/v1/rpc/')) {
    const fn = p.slice('/rest/v1/rpc/'.length);
    try { return send(res, 200, F.RPC[fn] ? F.RPC[fn](body || {}, DB) : null); }
    catch (e) { return send(res, 400, { code: 'P0001', message: String(e.message || e) }); }
  }
  if (!p.startsWith('/rest/v1/')) return send(res, 404, { message: 'not mocked' });

  const table = decodeURIComponent(p.slice('/rest/v1/'.length));
  // A page can make a table fail, to check how it reports a source it could not load.
  if (DB.__fail && DB.__fail[table]) return send(res, DB.__fail[table][0], DB.__fail[table][1]);
  const rows = DB[table] || (DB[table] = []);
  const filters = [...url.searchParams].filter(([k]) => !SKIP_PARAMS.has(k)).map(([k, v]) => filterFn(k, v));
  let matched = rows.filter(r => filters.every(f => f(r)));
  const single = String(req.headers.accept || '').includes('vnd.pgrst.object');
  const method = req.method;
  if (method === 'GET' || method === 'HEAD') {
    matched = orderRows(matched, url.searchParams.get('order'));
    const total = matched.length;
    // Like PostgREST with Supabase's max-rows: never more than 1,000 rows in one response.
    const offset = Number(url.searchParams.get('offset')) || 0;
    const limit = Math.min(Number(url.searchParams.get('limit')) || MAX_ROWS, MAX_ROWS);
    const outRows = matched.slice(offset, offset + limit).map(r => embed(r, url.searchParams.get('select'), table));
    const headers = { 'Content-Range': `0-${Math.max(0, outRows.length - 1)}/${total}` };
    if (method === 'HEAD') return send(res, 200, undefined, headers);
    if (single) return outRows.length === 1 ? send(res, 200, outRows[0], headers)
      : send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${outRows.length} rows` });
    return send(res, 200, outRows, headers);
  }
  if (method === 'POST') {
    // Messages have bigserial ids in the real table (threads page by id); everything else a uuid.
    const nextId = rows.reduce((n, r) => Math.max(n, Number(r.id) || 0), 0) + 1;
    const items = (Array.isArray(body) ? body : [body || {}]).map((b, i) => ({ id: table === 'messages' ? nextId + i : randomUUID(), created_at: stamp, updated_at: stamp, ...b }));
    rows.push(...items);
    return send(res, 201, single ? items[0] : items);
  }
  if (method === 'PATCH') { matched.forEach(r => Object.assign(r, body || {}, { updated_at: stamp })); return send(res, 200, single ? (matched[0] || null) : matched); }
  if (method === 'DELETE') { DB[table] = rows.filter(r => !matched.includes(r)); return send(res, 200, matched); }
  return send(res, 405, {});
}
// A few fictional people so the admin tables (Employees, the Overview's attendance) draw real rows.
const ADMIN_PEOPLE = [
  ['WS-0001', 'Asha Verma', 'Sportsmart Retail Private Limited', 'General shift (long name)', 'Present', false],
  ['WS-0002', 'Rahul Menon', 'Northwind Logistics & Warehousing', 'Evening support', 'Present', true],
  ['WS-0003', 'Priya Nair', 'Sportsmart Retail Private Limited', 'General shift (long name)', 'Absent', false],
].map(([employee_id, full_name, company, shift_name, status, late], i) => ({
  id: `a000000${i}-0000-4000-8000-000000000000`, employee_id, full_name, company, shift_name, status, is_late: late, late_minutes: late ? 12 : 0,
  email: full_name.toLowerCase().replace(' ', '.') + '@example.com', employee_code: String(101 + i), is_working_day: true,
  created_at: '2026-09-04T09:03:00Z', last_test_at: i ? '2026-09-18T11:40:00Z' : null, status_emp: 'active', is_wfh: i === 1,
  tests: 3 * i, best_wpm: 40 + 7 * i, quiz_attempts: i, best_quiz_score: 60 + 10 * i, quiz_violations: i === 2 ? 1 : 0,
  first_in: status === 'Present' ? '2026-09-21T03:45:00Z' : null, last_out: i === 0 ? '2026-09-21T12:40:00Z' : null,
}));
function adminApi(req, res) {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    let action = '';
    try { action = JSON.parse(raw || '{}').action || ''; } catch { /* empty */ }
    const base = { success: true, results: [], rows: [], items: [], employees: [], data: [], shifts: [] };
    const emps = ADMIN_PEOPLE.map(({ status, status_emp, ...e }) => ({ ...e, status: status_emp }));
    if (action === 'employees') return send(res, 200, { ...base, employees: emps });
    if (action === 'shift_list') return send(res, 200, { ...base, employees: emps });
    if (action === 'setup_health') {
      const H = require('../../lib/setup-health');
      const checks = [...H.configChecks({ SUPABASE_URL: 'x', SUPABASE_ANON_KEY: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', ADMIN_PASSWORD: 'short', SMTP_HOST: 'x', SMTP_PASS: 'x', MAIL_API_KEY: 'x', SMTP_USER_1: 'x' }),
        { id: 'migration_20', group: 'Database', label: 'Migration 20: supabase-task-completion-migration.sql', state: 'missing', fix: 'Run supabase-task-completion-migration.sql in Supabase → SQL Editor.' },
        { id: 'published_leftovers', group: 'Database', label: 'Old public file copies', state: 'degraded', detail: '3 file(s) left', fix: 'Remove them with the button below.' }];
      const n = st => checks.filter(c => c.state === st).length;
      return send(res, 200, { checks, summary: { ok: n('ok'), missing: n('missing'), degraded: n('degraded'), off: n('off') } });
    }
    if (action === 'att_daily_report') return send(res, 200, { ...base, date: '2026-09-21', rows: ADMIN_PEOPLE,
      totals: { employees: 3, present: 2, late: 1, absent: 1 } });
    send(res, 200, base);
  });
}
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/api/config') return send(res, 200, { supabaseUrl: `${ORIGIN}/sb`, supabaseAnonKey: 'smoke-anon-key' });
  if (p === '/api/push' && req.method === 'GET') return send(res, 200, { publicKey: '' });
  // The admin console: a signed-in session and empty lists, enough to draw every tab's frame.
  // /wsm-admin?gate=1: someone who is not an administrator sees the gate.
  if (p === '/api/admin' && /[?&]gate=1/.test(String(req.headers.referer || ''))) return send(res, 401, { error: 'Admin session expired. Please sign in again.' });
  if (p === '/api/admin') return adminApi(req, res);
  // The typing test's AI passage (/api/groq calls Groq in production): a fixed one here.
  if (p === '/api/groq') return send(res, 200, { passage: 'Every small step forward builds the habit that carries a team through the busy season.', tip: 'Keep your wrists relaxed.',
    source: 'fixture', theme: 'teamwork', themeLabel: 'Teamwork', category: 'motivation', person: null, level: 'steady', wordCount: 16, duration: 60 });
  if (p.startsWith('/api/')) return send(res, 404, { error: 'not available in the smoke test' });
  if (p === '/messenger' || p === '/messenger/') p = '/chat/';
  if (p === '/admin' || p.startsWith('/admin/') && !p.endsWith('.js') && !p.endsWith('.css')) p = '/wsm-admin';
  // /wsm-admin/<section> is the admin console itself (vercel.json rewrites it the same way).
  if (/^\/wsm-admin\/[^.]+$/.test(p)) p = '/wsm-admin';
  let file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  else if (!fs.existsSync(file) && fs.existsSync(path.join(file, 'index.html'))) file = path.join(file, 'index.html');
  else if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}
let ORIGIN = '';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, ORIGIN || 'http://localhost');
  if (url.pathname.startsWith('/sb/')) return supabase(req, res, url).catch(e => send(res, 500, { message: String(e) }));
  serveStatic(req, res, url);
});

/* -------------------------------------------------------------- checks */
async function visit(browser, route, name, [vpName, viewport]) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [], consoleErrors = [];
  page.on('pageerror', e => errors.push(String(e && e.message || e).split('\n')[0]));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/WebSocket|realtime|ERR_|Failed to load resource|favicon|net::|status of 40[46]|status of 406/i.test(t)) return;
    consoleErrors.push(t.slice(0, 200));
  });
  await page.setRequestInterception(true);
  page.on('request', r => {
    const u = r.url();
    if (u.startsWith(ORIGIN)) return r.continue();
    if (/fonts\.(googleapis|gstatic)\.com/.test(u)) return r.respond({ status: 200, contentType: 'text/css', body: '' });
    // Pages must start without any CDN (DEP-03): their libraries and CSS are served from the site.
    if (process.env.SMOKE_ALLOW_CDN === '1' && /cdn\.tailwindcss\.com/.test(u)) return r.continue();   // comparison runs only
    if (/cdn\.jsdelivr\.net|cdn\.tailwindcss\.com|cdnjs\.cloudflare\.com|unpkg\.com/.test(u)) { cdnHits.push(u); return r.respond({ status: 404, body: '' }); }
    return r.respond({ status: 204, body: '' });
  });
  const key = `sb-${new URL(ORIGIN).hostname.split('.')[0]}-auth-token`;
  await page.evaluateOnNewDocument((k, s, w) => {
    try {
      if (w.signedOut) localStorage.removeItem(k); else localStorage.setItem(k, s); localStorage.setItem('ws-theme', w.theme || 'light');
      if (w.wallpaper) localStorage.setItem('ws-wallpaper', w.wallpaper);   // SMOKE_WALLPAPER=northern npm run smoke:ui
      localStorage.setItem('ws-rules-seen-chat', '1');      // Messenger's one-time rules dialog, already acknowledged
    } catch (e) { /* ignore */ }
  }, key, JSON.stringify(F.session()), { wallpaper: process.env.SMOKE_WALLPAPER || '', theme: process.env.SMOKE_THEME || '', signedOut: name === 'signin' });
  const result = { route, name, viewport: vpName, errors, consoleErrors, problems: [], notes: [] };
  const cdnHits = [];
  // A signed-in account still waiting for an administrator's approval.
  // T2 needs a status summary; the others do not (BUG-05).
  if (name === 'task-complete') DB.tasks.forEach(t => { t.result_required = t.id === 'T2'; });
  // Far more people than one response holds: everything that lists them must page (PERF-01).
  if (name === 'paging') {
    for (let i = 0; i < 2500; i++) DB.profiles.push({ id: `p0000000-0000-4000-8000-${String(i).padStart(12, '0')}`, full_name: `Person ${String(i).padStart(4, '0')}`,
      email: `p${i}@example.test`, company: 'Nova Sportsmart Private Limited', status: 'active', app_role: 'employee', created_at: '2026-01-01T00:00:00Z' });
  }
  // Two calendar sources fail (a server error and a permission refusal); the rest must still show.
  if (name === 'calendar-partial') DB.__fail = { tasks: [500, { message: 'upstream timeout' }], leave_requests: [403, { code: '42501', message: 'permission denied for table leave_requests' }] };
  if (name === 'pending') DB.__access = { signed_in: true, access: 'pending', status: 'pending', email_verified: true, company: 'Nova Sportsmart Private Limited', full_name: 'Maya Manager' };
  try {
    await page.goto(ORIGIN + route, { waitUntil: 'load', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2600));
    // A code / error dialog opened while signing in must sit above the sign-in card.
    if (name === 'signin') {
      const onTop = await page.evaluate(() => {
        if (typeof showOtpModal !== 'function') return 'no showOtpModal';
        showOtpModal({ email: 'x@y.test', onVerify: async () => ({ ok: false }) });
        const host = document.getElementById('verify-code-modal');
        const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        if (!(host && host.contains(el))) return 'code dialog covered by ' + (el && (el.id || el.className));
        // The "Verified - Continue" message that finishes the sign-in must show too.
        document.getElementById('vc-cancel').click();
        showDialog({ type: 'success', title: 'Verified', message: 'x', buttonText: 'Continue' });
        const fm = document.getElementById('feedback-modal');
        const el2 = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        return fm && fm.contains(el2) ? 'ok' : 'success dialog covered by ' + (el2 && (el2.id || el2.className));
      });
      if (onTop !== 'ok') result.problems.push('sign-in dialog hidden: ' + onTop);
      await new Promise(r => setTimeout(r, 1200));                     // let the dialog finish its entrance before the picture
    }
    if (name === 'task-people') { await page.evaluate(() => document.querySelector('[data-assignee]').click()); await new Promise(r => setTimeout(r, 300)); }
    if (name === 'themes') { await page.evaluate(() => window.WSShell.openThemes()); await new Promise(r => setTimeout(r, 400)); }
    const info = await page.evaluate(() => {
      const w = window.innerWidth;
      const text = (document.querySelector('#ws-page') || document.body).innerText || '';
      const offenders = [];
      if (document.documentElement.scrollWidth > w + 1) {
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width && r.right > w + 1) {
            let p = el.parentElement, clipped = false;
            while (p) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') { clipped = true; break; } p = p.parentElement; }
            if (!clipped) offenders.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''} (${Math.round(r.right)}px)`);
            if (offenders.length >= 4) break;
          }
        }
      }
      return {
        shell: !!document.querySelector('.ws-shell'),
        overflow: document.documentElement.scrollWidth - w,
        offenders,
        errorText: (text.match(/Could not load[^\n]*|Something went wrong[^\n]*|not set up yet[^\n]*|record was not found[^\n]*/i) || [null])[0],
        signedOut: location.pathname === '/' && !!document.querySelector('#auth-modal:not(.hidden)'),
        title: document.title,
      };
    });
    // The call window is full-screen and the public web form is for visitors: neither has the shell.
    if (!info.shell && !['home', 'call', 'web-form', 'signin', 'pending', 'admin-gate', 'public-doc', 'public-doc-off'].includes(name)) result.problems.push('app shell did not mount');
    if (name === 'calendar-partial') {
      const t = await page.evaluate(() => document.body.innerText);
      if (!/Some items are missing from this view/.test(t) || !/Tasks:/.test(t) || !/Leave:/.test(t)) result.problems.push('a failed calendar source was not reported');
      if (!(await page.$('[data-cal-retry]'))) result.problems.push('no Retry for the failed sources');
      if (!(await page.$('.cal-month .cal-ev, .cal-month [data-key]'))) result.notes.push('no items drawn on the partial calendar');
    }
    if (name === 'public-doc' && !/Academy kit: 1,680/.test(await page.evaluate(() => document.body.innerText))) result.problems.push('the public document did not render');
    if (name === 'public-doc-off' && !/no longer available/.test(await page.evaluate(() => document.body.innerText))) result.problems.push('a link that is off did not say so');
    if (name === 'web-form' && !/Talk to our sales team/.test(await page.evaluate(() => document.body.innerText))) result.problems.push('web form did not render');
    if (cdnHits.length) result.problems.push(`loaded from a CDN at start-up: ${[...new Set(cdnHits)].join(', ')}`);
    if (vpName === 'phone' && info.overflow > 1) result.problems.push(`horizontal overflow ${info.overflow}px: ${info.offenders.join(', ')}`);
    if (CRM_PAGES.has(name) && info.errorText) result.problems.push(`error state on screen: "${info.errorText.slice(0, 90)}"`);
    if (info.signedOut && name !== 'signin' && name !== 'pending') result.problems.push('ended on the sign-in screen');
    if ((name === 'signin' || name === 'pending') && !info.signedOut) result.problems.push('the sign-in screen did not show');
    if (name === 'pending' && !/Waiting for approval/.test(await page.evaluate(() => document.body.innerText))) result.problems.push('a pending account was not told it waits for approval');
    // The fixtures keep a call ringing for Maya; outside Messenger and the call
    // window its card would cover the page being checked and photographed.
    if (name !== 'messenger' && name !== 'call') await page.evaluate(() => { const r = document.getElementById('wsc-root'); if (r) r.style.display = 'none'; });
    const sc = await scrollAudit(page);
    const scrollFindings = [...sc.clipped.map(c => `cut off: ${c}`), ...sc.nested.map(n => `nested scrolling: ${n}`)];
    if (SCROLL_STRICT) result.problems.push(...scrollFindings); else result.notes.push(...scrollFindings);
    // The picture is of the page as it loads; interactions come after it.
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, `${name}-${vpName}.png`) });
    if (name === 'messenger') await messengerScroll(page, vpName, result);
    if (vpName === 'desktop') await interact(page, name, result);
  } catch (e) {
    result.problems.push(`navigation failed: ${String(e.message || e).split('\n')[0]}`);
  }
  await page.close();
  return result;
}

// Scrolling: nothing sizeable cut off without a way to scroll to it, the page
// itself not locked while its content runs past the screen, and no big scroll
// area inside another (two scrollbars fighting over the same wheel or swipe).
async function scrollAudit(page) {
  return page.evaluate(() => {
    const vh = innerHeight;
    const label = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
      + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
    const shown = el => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0; };
    const scrollers = [], clipped = [], nested = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 100 || r.width < 150) continue;
      const extra = el.scrollHeight - el.clientHeight;
      if (extra <= 2) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') scrollers.push({ el, name: label(el), h: r.height });
      else if ((cs.overflowY === 'hidden' || cs.overflowY === 'clip') && extra > 40 && (!cs.webkitLineClamp || cs.webkitLineClamp === 'none')) {
        clipped.push(`${label(el)} hides ${extra}px`);
      }
    }
    const docExtra = document.scrollingElement.scrollHeight - vh;
    const locked = ['html', 'body'].some(t => /hidden|clip/.test(getComputedStyle(document.querySelector(t)).overflowY));
    // A full-screen dialog on top is meant to hold the page still behind it.
    const dialogOpen = [...document.querySelectorAll('body *')].some(el => {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width >= innerWidth * 0.9 && r.height >= vh * 0.9;
    });
    if (docExtra > 2 && locked && !dialogOpen) clipped.unshift(`the page is ${docExtra}px taller than the screen but cannot scroll`);
    for (const s of scrollers) {
      if (s.h < vh * 0.4) continue;
      let p = s.el.parentElement;
      for (; p; p = p.parentElement) if (scrollers.some(o => o.el === p && o.h >= vh * 0.4)) break;
      if (p) nested.push(`${s.name} inside ${label(p)}`);
      else if (docExtra > 2 && !locked && s.h >= vh * 0.6) nested.push(`${s.name} inside the page, which also scrolls ${docExtra}px`);
    }
    return { docExtra, clipped: clipped.slice(0, 5), nested: nested.slice(0, 5) };
  });
}

// Messenger: a long chat opens at its newest message with the header and the
// message box on screen, the page never scrolls behind it, and scrolling up
// loads earlier messages without jumping away from where you were.
async function messengerScroll(page, vpName, result) {
  const expect = async (label, fn) => { try { const ok = await fn(); if (!ok) result.problems.push(`${vpName}: ${label}`); } catch (e) { result.problems.push(`${vpName}: ${label}: ${e.message.split('\n')[0]}`); } };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const onScreen = sel => page.evaluate(s => {
    const el = document.querySelector(s); if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.height > 20 && r.top >= -1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1;
  }, sel);
  const fits = await page.evaluate(() => document.scrollingElement.scrollHeight <= innerHeight + 1);
  if (!fits) {
    // Say which box grew: every ancestor of the chat list, with its height and overflow.
    const chain = await page.evaluate(() => {
      const out = [];
      for (let el = document.getElementById('mx-list'); el && el !== document.documentElement; el = el.parentElement) {
        const cs = getComputedStyle(el);
        out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className).trim().split(/\s+/).slice(0, 3).join('.')} h=${Math.round(el.getBoundingClientRect().height)} oy=${cs.overflowY} ${cs.display}${cs.gridTemplateRows && cs.display === 'grid' ? ' rows=' + cs.gridTemplateRows.slice(0, 30) : ''}`);
      }
      return out.join(' < ');
    });
    result.notes.push(`height chain: ${chain}`);
  }
  await expect('the Messenger page itself does not scroll, only its lists', async () => fits);
  const opened = await page.evaluate(() => {
    const it = [...document.querySelectorAll('.mx-item')].find(e => /Anil Kumar/.test(e.textContent));
    if (it) it.click();
    return !!it;
  });
  if (!opened) { result.problems.push(`${vpName}: the Anil Kumar chat is not in the list`); return; }
  await wait(1500);
  const pos = await page.evaluate(() => {
    const s = document.getElementById('mx-scroll');
    return s ? { gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight), top: Math.round(s.scrollTop), h: s.clientHeight, sh: s.scrollHeight,
      n: document.querySelectorAll('#mx-msgs .mx-bubble').length, older: !document.getElementById('mx-older').hidden } : null;
  });
  await expect(`a chat opens at its newest message${pos ? ` (${JSON.stringify(pos)})` : ''}`, async () => !!pos && pos.gap < 48);
  await expect('the conversation header is on screen', () => onScreen('#mx-head-name'));
  await expect('the message box is on screen', () => onScreen('#mx-compose'));
  await expect('the page still does not scroll with a chat open', () => page.evaluate(() => document.scrollingElement.scrollHeight <= innerHeight + 1));
  await page.screenshot({ path: path.join(OUT, `messenger-thread-${vpName}.png`) });
  if (!BIG) return;
  const count = () => page.evaluate(() => document.querySelectorAll('#mx-msgs .mx-bubble').length);
  const before = await count();
  const anchor = await page.evaluate(() => {
    const s = document.getElementById('mx-scroll'); s.scrollTop = 0; s.dispatchEvent(new Event('scroll'));
    const first = document.querySelector('#mx-msgs .mx-bubble'); return first ? first.textContent.slice(0, 40) : '';
  });
  await wait(2000);
  const after = await count();
  await expect(`scrolling up loads earlier messages (${before} → ${after})`, async () => after > before);
  await expect('after loading, the message you were reading stays in view', () => page.evaluate(text => {
    const s = document.getElementById('mx-scroll');
    const el = [...document.querySelectorAll('#mx-msgs .mx-bubble')].find(b => b.textContent.slice(0, 40) === text);
    if (!s || !el) return false;
    const r = el.getBoundingClientRect(), box = s.getBoundingClientRect();
    return s.scrollTop > 40 && r.bottom > box.top && r.top < box.bottom;
  }, anchor));
  await page.screenshot({ path: path.join(OUT, `messenger-older-${vpName}.png`) });
  await expect('at rest, no date label sits on top of a message', () => page.evaluate(() => {
    const s = document.getElementById('mx-scroll').getBoundingClientRect();
    const labels = [...document.querySelectorAll('#mx-msgs .mx-day span, #mx-floatday.show span')]
      .map(e => e.getBoundingClientRect()).filter(r => r.height && r.bottom > s.top && r.top < s.bottom);
    const bubbles = [...document.querySelectorAll('#mx-msgs .mx-bubble')].map(e => e.getBoundingClientRect());
    return !labels.some(d => bubbles.some(b => d.left < b.right && d.right > b.left && d.top < b.bottom && d.bottom > b.top));
  }));
  await page.evaluate(() => { const s = document.getElementById('mx-scroll'); s.scrollTop = Math.floor((s.scrollHeight - s.clientHeight) / 2); });
  await wait(250);
  await expect('while scrolling, the date floats at the top of the thread', () => page.evaluate(() => {
    const f = document.getElementById('mx-floatday'); return !!f && f.classList.contains('show') && /\S/.test(f.textContent);
  }));
  await wait(1500);
  await expect('the floating date fades once scrolling stops', () => page.evaluate(() => !document.getElementById('mx-floatday').classList.contains('show')));
}

// dialogs.js with the keyboard only (UI-01): the answer must be the button that
// has focus, never "OK" because Enter was pressed somewhere.
async function dialogKeyboard(page, expect, wait) {
  // Ask a question; the page keeps the answer in window.__answers.
  const ask = (kind, opts) => page.evaluate((k, o) => { window.__answers = window.__answers || []; window.wsDialog[k](o).then(v => window.__answers.push(v)); }, kind, opts);
  const answers = () => page.evaluate(() => window.__answers.splice(0));
  const focused = () => page.evaluate(() => document.activeElement && document.activeElement.id);
  await expect('a destructive confirm opens with focus on Cancel, and Enter there cancels', async () => {
    await ask('confirm', { title: 'Delete for good?', message: 'x', okText: 'Delete', danger: true }); await wait(80);
    const f = await focused();
    await page.keyboard.press('Enter'); await wait(80);
    const a = await answers();
    return f === 'ws-dialog-cancel' && a.length === 1 && a[0] === false;
  });
  await expect('Tab and Shift+Tab stay on the dialog buttons; Enter answers for the focused one', async () => {
    await ask('confirm', { title: 'Send?', message: 'x' }); await wait(80);
    const start = await focused();                                   // not destructive: the main button
    await page.keyboard.press('Tab'); const t1 = await focused();
    await page.keyboard.press('Tab'); const t2 = await focused();
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift'); const t3 = await focused();
    await page.keyboard.press('Enter'); await wait(80);
    const a = await answers();
    return start === 'ws-dialog-ok' && t1 === 'ws-dialog-cancel' && t2 === 'ws-dialog-ok' && t3 === 'ws-dialog-cancel' && a[0] === false;
  });
  await expect('Escape cancels, Space on OK confirms', async () => {
    await ask('confirm', { title: 'Q1', message: 'x' }); await wait(80); await page.keyboard.press('Escape'); await wait(80);
    await ask('confirm', { title: 'Q2', message: 'x' }); await wait(80); await page.keyboard.press('Space'); await wait(80);
    const a = await answers();
    return a.length === 2 && a[0] === false && a[1] === true;
  });
  await expect('the dialog is announced as modal and the page behind is out of reach', async () => {
    await ask('confirm', { title: 'Archive?', message: 'Moves it.' }); await wait(80);
    const r = await page.evaluate(() => {
      const card = document.getElementById('ws-dialog-card');
      const behind = [...document.body.children].filter(el => el.id !== 'ws-dialog-overlay');
      return { role: card.getAttribute('role'), modal: card.getAttribute('aria-modal'), label: document.getElementById(card.getAttribute('aria-labelledby')).textContent,
               inert: behind.length > 0 && behind.every(el => el.hasAttribute('inert')) };
    });
    await page.keyboard.press('Escape'); await wait(80); await answers();
    const freed = await page.evaluate(() => ![...document.body.children].some(el => el.hasAttribute('inert')));
    return r.role === 'alertdialog' && r.modal === 'true' && r.label === 'Archive?' && r.inert && freed;
  });
  await expect('focus goes back where it was', async () => {
    await page.evaluate(() => { const b = document.createElement('button'); b.id = 'smoke-origin'; b.textContent = 'origin'; document.body.appendChild(b); b.focus(); });
    await ask('alert', { title: 'Saved', message: 'x' }); await wait(80);
    await page.keyboard.press('Enter'); await wait(80);
    const back = await focused();
    const a = await answers();
    await page.evaluate(() => document.getElementById('smoke-origin').remove());
    if (back !== 'smoke-origin') throw new Error(`focus is on ${back}`);
    return a.length === 1 && a[0] == null;              // an alert answers nothing (undefined arrives as null)
  });
  await expect('a second dialog waits for the first; each answer reaches its own question', async () => {
    await page.evaluate(() => {
      window.__answers = [];
      window.wsDialog.confirm({ title: 'First', message: '1' }).then(v => window.__answers.push(['first', v]));
      window.wsDialog.confirm({ title: 'Second', message: '2', danger: true }).then(v => window.__answers.push(['second', v]));
    });
    await wait(80);
    const t1 = await page.evaluate(() => document.getElementById('ws-dialog-title').textContent);
    await page.keyboard.press('Enter'); await wait(80);                 // OK on the first
    const t2 = await page.evaluate(() => document.getElementById('ws-dialog-title').textContent);
    await page.keyboard.press('Enter'); await wait(80);                 // Cancel (destructive) on the second
    const a = await answers();
    return t1 === 'First' && t2 === 'Second' && JSON.stringify(a) === JSON.stringify([['first', true], ['second', false]]);
  });
}

// Completing tasks from the browser (BUG-05): the summary a task requires is
// asked for and sent in the same update, in single and bulk completion, and a
// failed lookup refuses instead of completing.
async function taskCompletion(page, expect, wait) {
  const within = (p, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`timed out: ${what}`)), 6000))]);
  const patches = [];
  page.on('request', r => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/tasks')) patches.push({ url: decodeURIComponent(r.url()), body: r.postData() }); });
  const fillAndSubmit = async text => {
    await page.waitForSelector('.crm-modal textarea', { timeout: 3000 });
    for (const ta of await page.$$('.crm-modal textarea')) { await ta.click(); await page.keyboard.type(text); }
    await page.evaluate(() => { const b = [...document.querySelectorAll('.crm-modal .foot button')].find(x => x.dataset.primary); b.click(); });
  };
  await expect('a single completion asks for the summary and sends it with the status', async () => {
    const done = page.evaluate(() => window.WSCrm.completeTask({ id: 'T2' }));
    await fillAndSubmit('Measurements received');
    const ok = await within(done, 'single completion'); await wait(100);
    const p = patches.find(x => x.url.includes('id=eq.T2'));
    const body = p && JSON.parse(p.body);
    return ok === true && body && body.status === 'completed' && body.result_summary === 'Measurements received';
  });
  await expect('cancelling the summary does not complete the task', async () => {
    patches.length = 0;
    const done = page.evaluate(() => window.WSCrm.completeTask({ id: 'T2' }));
    await page.waitForSelector('.crm-modal textarea', { timeout: 3000 });
    await page.evaluate(() => { const b = [...document.querySelectorAll('.crm-modal .foot button')].find(x => /Cancel/.test(x.textContent)); b.click(); });
    return (await within(done, 'cancel')) === false && patches.length === 0;
  });
  await expect('bulk Complete: tasks without a summary rule go together, the one that needs a summary gets its own', async () => {
    patches.length = 0;
    const done = page.evaluate(() => window.WSCrm.completeTasks(['T1', 'T2', 'T3']));
    await fillAndSubmit('Bluewave measured');
    const out = await within(done, 'bulk completion'); await wait(100);
    const bulk = patches.find(x => x.url.includes('id=in.(T1,T3)'));
    const single = patches.find(x => x.url.includes('id=eq.T2'));
    if (!bulk) throw new Error('no bulk update: ' + patches.map(x => x.url).join(' | '));
    return out && out.done >= 1 && bulk.url.includes('result_required=eq.false') && single && JSON.parse(single.body).result_summary === 'Bluewave measured';
  });
  await expect('a failed lookup refuses to complete instead of skipping the summary', async () => {
    patches.length = 0;
    const r = await page.evaluate(async () => {
      const C = window.WSCrm, sb = C.ctx().sb, from = sb.from.bind(sb);
      sb.from = t => (t === 'tasks' ? { select: () => ({ in: async () => ({ data: null, error: { code: '503', message: 'Service unavailable' } }) }) } : from(t));
      try { await C.completeTask({ id: 'T2' }); return 'completed'; } catch (e) { return 'refused'; } finally { sb.from = from; }
    });
    return r === 'refused' && patches.length === 0;
  });
}

// A few interactions that exercise the shared runtime, not just the first paint.
async function interact(page, name, result) {
  const expect = async (label, fn) => { try { const ok = await fn(); if (!ok) result.problems.push(`interaction failed: ${label}`); } catch (e) { result.problems.push(`interaction threw: ${label}: ${e.message.split('\n')[0]}`); } };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  if (name === 'dialogs') await dialogKeyboard(page, expect, wait);
  if (name === 'task-complete') await taskCompletion(page, expect, wait);
  if (name === 'paging') {
    await expect('the people list holds everyone, not the first 1,000', () => page.evaluate(() => window.WSCrm.activePeople().length > 2500));
    await expect('fetchAll pages to the end, and says when it stopped at its cap', () => page.evaluate(async () => {
      const sb = window.WSCrm.ctx().sb;
      const all = await window.WSCrm.fetchAll(() => sb.from('profiles').select('id').order('id'));
      const capped = await window.WSCrm.fetchAll(() => sb.from('profiles').select('id').order('id'), 2000);
      return all.length > 2500 && all.partial === false && new Set(all.map(r => r.id)).size === all.length && capped.length === 2000 && capped.partial === true;
    }));
  }
  if (name === 'contacts') {
    await expect('Create opens the new-contact page in a slider', async () => {
      await page.click('[data-create]');
      const frame = await (await page.waitForSelector('.ws-slider iframe', { timeout: 3000 })).contentFrame();
      await frame.waitForSelector('.b24-new input', { timeout: 8000 });
      return true;
    });
    await expect('Escape closes the slider', async () => { await page.keyboard.press('Escape'); await wait(400); return !(await page.$('.ws-slider')); });
    await expect('the list shows the fixture contacts', async () => (await page.$$('.b24-grid-table tbody tr[data-id]')).length >= 2);
  }
  if (name === 'messenger') {
    // A message's chevron is the page's own button: it must open the message
    // menu and leave the workspace menu alone.
    await expect('the message chevron leaves the workspace menu alone', async () => {
      const more = await page.$('.mx-more');
      if (!more) return true;                        // no messages in this fixture
      await more.click();
      await wait(250);
      // The button carries data-act="menu" for Messenger's own menu; the shell
      // used to catch it and open Configure menu over the whole workspace.
      return page.evaluate(() => !document.querySelector('.ws-side.editing'));
    });
  }
  if (name === 'deals') await expect('the pipeline shows one column per stage', async () => (await page.$$('.kb-col')).length >= 5 || (await page.$$('.ws-table tbody tr')).length >= 1);
  if (name === 'deals-list') {
    const text = () => page.evaluate(() => document.querySelector('.b24-grid-table').innerText);
    await expect('the list opens on All pipelines, with deals from both', async () => {
      const t = await text();
      return /All pipelines/.test(await page.evaluate(() => document.querySelector('[data-pipes]').textContent)) && t.includes('Acme academy kit supply') && t.includes('Robel Geleta - Background check');
    });
    await expect('an imported deal shows its Bitrix24 number, type, repeat mark, amount, payment status and responsible', async () => {
      const t = await text();
      return ['17651', 'Employment BGC Saviors - USA - Background Check', '(Repeat inquiry)', '$500', 'Partially paid', 'GL-EBS-ESM-SLE-001', 'Employment BGC Supports'].every(s => t.includes(s));
    });
    await expect('every row has a stage bar', async () => (await page.$$('.b24-grid-table tbody tr[data-id] .b24-stagebar')).length >= 3);
    await expect('the column settings offer the export columns', async () => {
      await page.click('[data-colsettings]'); await wait(300);
      const ok = (await page.evaluate(() => document.querySelector('.b24-colpop').innerText)).includes('Candidate Payment Status');
      await page.click('.b24-colpop [data-cancel]');
      return ok;
    });
    await expect('switching to Kanban opens the default pipeline', async () => {
      await page.click('[data-view="kanban"]'); await wait(1500);
      return (await page.$$('.kb-col')).length === 6 && /Sales/.test(await page.evaluate(() => document.querySelector('[data-pipes]').textContent));
    });
  }
  if (name === 'leads-list') await expect('an imported lead shows its source, repeat mark, position, date and who the file named', async () => {
    const t = await page.evaluate(() => document.querySelector('.b24-grid-table').innerText);
    return ['Repeat lead', 'Data Engineer', '20.03.2026', 'GL-EBS-ESM-SLE-001', 'Sunrise Academy'].every(s => t.includes(s)) && (await page.$$('.b24-grid-table .b24-stagebar')).length >= 3;
  });
  if (name === 'leads-list') await expect('clicking a stage segment moves the lead', async () => {
    await page.click('tr[data-id="L1"] [data-lead-seg][data-stage="contacted"]'); await wait(1200);
    return page.evaluate(() => document.querySelector('tr[data-id="L1"] .b24-stagebar-l').textContent === 'Contacted');
  });
  if (name === 'leads-list') await expect('hovering a stage segment shows the stage name', async () => {
    await page.hover('tr[data-id="L2"] .b24-stagebar .seg:nth-child(3)'); await wait(200);
    const t = await page.evaluate(() => { const el = document.querySelector('.b24-stage-tip'); return el && !el.hidden ? el.innerText : ''; });
    await page.screenshot({ path: path.join(OUT, 'leads-list-stagetip-desktop.png') });
    await page.mouse.move(5, 5);
    return t.includes('Qualified') && t.includes('Double-click - View');
  });
  if (name === 'leads-list') await expect('double-clicking a row opens the lead', async () => {
    await page.click('tr[data-id="L2"] td[data-col="created_at"]', { count: 2 });
    const ok = !!(await page.waitForSelector('.ws-slider iframe', { timeout: 3000 }).catch(() => null));
    await page.keyboard.press('Escape'); await wait(400);
    return ok;
  });
  if (name === 'deals-list') {
    // (runs after the Kanban switch above, so it checks the gear on the board view too)
    await expect('the gear menu offers the exports and access permissions', async () => {
      await page.click('[data-gear]'); await wait(300);
      const t = await page.evaluate(() => (document.querySelector('.crm-menu.open') || {}).innerText || '');
      await page.keyboard.press('Escape');
      return ['Configure pipelines and stages', 'Import custom CSV data', 'Export to CSV', 'Export to Excel', 'Access permissions'].every(x => t.includes(x));
    });
  }
  if (name === 'lead-imported') await expect('an imported lead card shows Bitrix24 fields and its custom section', async () => {
    const t = await page.evaluate(() => document.querySelector('#card').innerText);
    return ['LEAD INFORMATION', 'Repeat lead', 'GL-EBS-ESM-SLE-001', 'Wants a callback', 'CUSTOM SECTION', 'Referrer', 'Grace Mensah', 'Complete lead'].every(x => t.includes(x));
  });
  if (name === 'deal-imported') await expect('an imported deal card shows the amount, payment box, type and custom section', async () => {
    const t = await page.evaluate(() => document.querySelector('#card').innerText);
    return ['ABOUT DEAL', '$500', 'Receive payment', 'Deal total', 'Employment BGC Saviors - USA - Background Check', 'Robel Geleta', 'CUSTOM SECTION', 'Candidate Payment Status', 'Close deal', 'Employment BGC Supports'].every(x => t.includes(x));
  });
  if (name === 'deal-record') await expect('the section edit link opens every field of the section', async () => {
    await page.click('.b24-sect [data-sect-edit="0"]'); await wait(400);
    const n = await page.evaluate(() => document.querySelectorAll('.ws-modal .crm-field, [role=dialog] .crm-field').length);
    await page.keyboard.press('Escape'); await wait(200);
    return n >= 5;
  });
  if (name === 'tasks') await expect('My Tasks lists my tasks', async () => (await page.$$('.b24-grid-table tbody tr[data-id], .kb-card')).length >= 1);
  if (name === 'typing') await expect('with its dialogs closed, the typing test page scrolls again', async () => {
    await page.evaluate(() => {
      document.querySelectorAll('#ws-rules-overlay.show').forEach(o => o.classList.remove('show'));
      document.querySelectorAll('[id$="-modal"].flex').forEach(m => { m.classList.add('hidden'); m.classList.remove('flex'); });
    });
    await wait(150);
    return page.evaluate(() => !['html', 'body'].some(t => /hidden|clip/.test(getComputedStyle(document.querySelector(t)).overflowY)));
  });
  if (name === 'task-record') await expect('the star adds the task to favourites, and Ctrl+K lists it first', async () => {
    const star = await page.waitForSelector('[data-ws-fav="task:T1"]', { timeout: 3000 });
    const pressed = () => page.evaluate(() => document.querySelector('[data-ws-fav="task:T1"]').getAttribute('aria-pressed'));
    if (await pressed() !== 'false') throw new Error('starts as ' + await pressed());
    await star.focus(); await page.keyboard.press('Enter'); await wait(600);          // by keyboard
    if (await pressed() !== 'true') throw new Error('after Enter: ' + await pressed());
    await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control'); await wait(900);
    const t = (await page.evaluate(() => (document.querySelector('#ws-cmdk-results') || {}).textContent || '')).replace(/\s+/g, ' ');
    await page.keyboard.press('Escape');
    if (!(/Favourites/.test(t) && t.indexOf('Send revised proposal to Acme') > -1 && t.indexOf('Favourites') < t.indexOf('Go to'))) throw new Error('palette: ' + t.slice(0, 160).replace(/\n/g, ' | '));
    return true;
  });
  if (name === 'admin') await expect('Setup health lists what is missing and offers the clean-up', async () => {
    await wait(600);
    const t = await page.evaluate(() => (document.getElementById('ov-health') || {}).innerText || '');
    return /Migration 20/.test(t) && /Admin password/.test(t) && !!(await page.$('#ov-health-clean'));
  });
  if (name === 'typing') await expect('the typing test shows its passage', async () => (await page.evaluate(() => document.body.innerText)).includes('busy season'));
  if (name === 'calendar') await expect('a calendar view renders', async () => !!(await page.$('.cal-month, .cal-week, .cal-agenda')));
  if (name === 'invoice-record') await expect('the invoice sheet shows its total', async () => (await page.evaluate(() => document.body.innerText)).includes('1,680'));
  if (name === 'crm') {
    await expect('the command palette opens and finds a contact', async () => {
      await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
      await wait(250);
      await page.type('#ws-cmdk-input', 'Ravi');
      await wait(900);
      await page.screenshot({ path: path.join(OUT, 'crm-palette-desktop.png') });
      return (await page.evaluate(() => document.querySelector('#ws-cmdk-results') && document.querySelector('#ws-cmdk-results').innerText || '')).includes('Ravi Shah');
    });
  }
  if (name === 'contact-record') await expect('the Deals tab lists the linked deal', async () => {
    const tab = await page.$('.b24-card-tabs [data-tab="deals"]'); if (!tab) return false; await tab.click(); await wait(400);
    return (await page.evaluate(() => document.body.innerText)).includes('Acme academy kit supply');
  });
}

/* ---------------------------------------------------------------- main */
(async () => {
  await new Promise(r => server.listen(0, 'localhost', r));
  ORIGIN = `http://localhost:${server.address().port}`;
  // CI runners (Ubuntu 24.04) block the user namespaces Chrome's sandbox needs; a throwaway runner may skip it.
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: [...(process.env.CI ? ['--no-sandbox'] : []), '--no-first-run', '--no-default-browser-check',
    // A fake camera and microphone, already allowed, so the call page renders as it would for a person.
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const results = [];
  const only = process.argv[2] ? new Set(process.argv.slice(2)) : null;
  for (const [route, name] of PAGES) {
    if (only && !only.has(name)) continue;
    for (const vp of VIEWPORTS) {
      DB = F.db({ big: BIG });                      // every page starts from the same data
      results.push(await visit(browser, route, name, vp));
    }
  }
  await browser.close();
  server.close();
  let failed = 0;
  for (const r of results) {
    const bad = r.errors.length || r.problems.length;
    if (bad) failed++;
    console.log(`${bad ? 'FAIL' : 'ok  '} ${r.name.padEnd(16)} ${r.viewport.padEnd(7)} ${r.route}`);
    r.errors.forEach(e => console.log(`       script error: ${e}`));
    r.problems.forEach(p => console.log(`       ${p}`));
    r.notes.forEach(n => console.log(`       note: ${n}`));
    if (process.env.SMOKE_VERBOSE) r.consoleErrors.forEach(e => console.log(`       console: ${e}`));
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed}/${results.length} page views passed · screenshots in ${path.relative(process.cwd(), OUT)}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
