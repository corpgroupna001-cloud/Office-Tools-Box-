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
  ['/', 'home'], ['/crm', 'crm'], ['/crm/settings', 'crm-settings'], ['/companies', 'companies'],
  ['/contacts', 'contacts'], ['/contacts?id=C1', 'contact-record'],
  ['/leads', 'leads'], ['/leads?id=L1', 'lead-record'],
  ['/deals', 'deals'], ['/deals?id=D1', 'deal-record'],
  ['/boards', 'boards'], ['/boards?id=B1', 'board'],
  ['/projects', 'projects'], ['/projects?id=P1', 'project-record'],
  ['/tasks', 'tasks'], ['/tasks?id=T1', 'task-record'],
  ['/documents', 'documents'], ['/documents?id=DOC1', 'document-record'],
  ['/calendar', 'calendar'], ['/calendar?view=day', 'calendar-day'], ['/calendar?view=week', 'calendar-week'],
  ['/calendar?view=month', 'calendar-month'], ['/calendar?view=schedule', 'calendar-schedule'], ['/employees', 'employees'],
  ['/employees?view=tiles', 'employees-tiles'], ['/employees/structure/', 'org-chart'], ['/employees?id=22222222-2222-4222-8222-222222222222', 'employee-record'],
  ['/invoices', 'invoices'], ['/invoices?id=I1', 'invoice-record'],
  ['/chat', 'messenger'], [`/call?id=${F.CALL}`, 'call'], ['/attendance', 'attendance'],
  ['/typingtest', 'typing'], ['/mcqquiz', 'quiz'], ['/signature', 'signature'], ['/recordings', 'recordings'],
];
const CRM_PAGES = new Set(['crm', 'crm-settings', 'companies', 'contacts', 'contact-record', 'leads', 'lead-record', 'deals', 'deal-record', 'boards', 'board', 'projects',
  'project-record', 'tasks', 'task-record', 'documents', 'document-record', 'calendar', 'calendar-day', 'calendar-week', 'calendar-month', 'calendar-schedule', 'employees', 'employees-tiles', 'org-chart', 'employee-record', 'invoices', 'invoice-record']);
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
  const rows = DB[table] || (DB[table] = []);
  const filters = [...url.searchParams].filter(([k]) => !SKIP_PARAMS.has(k)).map(([k, v]) => filterFn(k, v));
  let matched = rows.filter(r => filters.every(f => f(r)));
  const single = String(req.headers.accept || '').includes('vnd.pgrst.object');
  const method = req.method;
  if (method === 'GET' || method === 'HEAD') {
    matched = orderRows(matched, url.searchParams.get('order'));
    const total = matched.length;
    const limit = Number(url.searchParams.get('limit')) || 0;
    const outRows = (limit ? matched.slice(0, limit) : matched).map(r => embed(r, url.searchParams.get('select'), table));
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
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/api/config') return send(res, 200, { supabaseUrl: `${ORIGIN}/sb`, supabaseAnonKey: 'smoke-anon-key' });
  if (p === '/api/push' && req.method === 'GET') return send(res, 200, { publicKey: '' });
  if (p.startsWith('/api/')) return send(res, 404, { error: 'not available in the smoke test' });
  if (p === '/messenger' || p === '/messenger/') p = '/chat/';
  if (p === '/admin' || p.startsWith('/admin/') && !p.endsWith('.js') && !p.endsWith('.css')) p = '/wsm-admin';
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
    if (/cdn\.jsdelivr\.net|cdn\.tailwindcss\.com|cdnjs\.cloudflare\.com/.test(u)) return r.continue();
    return r.respond({ status: 204, body: '' });
  });
  const key = `sb-${new URL(ORIGIN).hostname.split('.')[0]}-auth-token`;
  await page.evaluateOnNewDocument((k, s) => {
    try {
      localStorage.setItem(k, s); localStorage.setItem('ws-theme', 'light');
      localStorage.setItem('ws-rules-seen-chat', '1');      // Messenger's one-time rules dialog, already acknowledged
    } catch (e) { /* ignore */ }
  }, key, JSON.stringify(F.session()));
  const result = { route, name, viewport: vpName, errors, consoleErrors, problems: [], notes: [] };
  try {
    await page.goto(ORIGIN + route, { waitUntil: 'load', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2600));
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
    if (!info.shell && name !== 'home' && name !== 'call') result.problems.push('app shell did not mount');   // the call window is full-screen, no shell
    if (vpName === 'phone' && info.overflow > 1) result.problems.push(`horizontal overflow ${info.overflow}px: ${info.offenders.join(', ')}`);
    if (CRM_PAGES.has(name) && info.errorText) result.problems.push(`error state on screen: "${info.errorText.slice(0, 90)}"`);
    if (info.signedOut) result.problems.push('ended on the sign-in screen');
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

// A few interactions that exercise the shared runtime, not just the first paint.
async function interact(page, name, result) {
  const expect = async (label, fn) => { try { const ok = await fn(); if (!ok) result.problems.push(`interaction failed: ${label}`); } catch (e) { result.problems.push(`interaction threw: ${label}: ${e.message.split('\n')[0]}`); } };
  const wait = ms => new Promise(r => setTimeout(r, ms));
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
  if (name === 'tasks') await expect('My Tasks lists my tasks', async () => (await page.$$('.b24-grid-table tbody tr[data-id], .kb-card')).length >= 1);
  if (name === 'typing') await expect('with its dialogs closed, the typing test page scrolls again', async () => {
    await page.evaluate(() => {
      document.querySelectorAll('#ws-rules-overlay.show').forEach(o => o.classList.remove('show'));
      document.querySelectorAll('[id$="-modal"].flex').forEach(m => { m.classList.add('hidden'); m.classList.remove('flex'); });
    });
    await wait(150);
    return page.evaluate(() => !['html', 'body'].some(t => /hidden|clip/.test(getComputedStyle(document.querySelector(t)).overflowY)));
  });
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
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check',
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
