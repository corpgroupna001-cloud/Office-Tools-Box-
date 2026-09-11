#!/usr/bin/env node
// WebRTC tests for calls — opt-in, like the smoke test:
//
//     npm run test:calls          (CHROME_PATH=/path/to/chrome to pick a browser)
//
// Part 1, the engine: opens tests/ui-smoke/mesh-harness.html in the installed
// Chrome with a fake camera and microphone. The harness connects real
// RTCPeerConnections through an in-memory signalling bus and checks the things
// that broke calls before: connecting, media both ways, camera off/on without
// renegotiation, ICE restart, a late third person, lost signals, leaving.
//
// Part 2, the call window: two separate browser profiles (caller and callee)
// open /call/ against a stand-in Supabase served by this script — REST, the
// ws_call_* functions as a small state machine, and Realtime over a WebSocket
// (presence, broadcast, postgres_changes) speaking supabase-js's own protocol.
// The callee accepts, media flows both ways, mute and camera changes reach the
// other side, hanging up ends it for both, the notification's Decline link
// works, and an unknown call says so. Screenshots go to tests/ui-smoke/out/.
//
// Exits non-zero when anything fails.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'out');
let puppeteer, WebSocket;
try { puppeteer = require('puppeteer-core'); WebSocket = require('ws'); } catch { console.error('puppeteer-core is missing: run npm install'); process.exit(2); }
const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(p => fs.existsSync(p));
if (!CHROME) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2); }

/* ------------------------------------------------------ stand-in Supabase */
const A = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', full_name: 'Asha Caller', email: 'asha@nova.test', avatar_url: null };
const B = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', full_name: 'Bala Callee', email: 'bala@nova.test', avatar_url: null };
const PEOPLE = [A, B];
const b64url = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function session(u) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const user = { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, user_metadata: { full_name: u.full_name }, app_metadata: {}, created_at: new Date().toISOString() };
  return { access_token: `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: u.id, role: 'authenticated', exp })}.test`, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'r-' + u.id, user };
}
const userOf = req => {
  const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').split('.')[1];
  try { return JSON.parse(Buffer.from(t, 'base64url').toString()).sub; } catch { return null; }
};

const calls = new Map();
const pushes = [];                  // every POST /api/push, as { uid, body }
let startDelay = 0, lastStarted = null;
function newCall(id) {
  const now = new Date().toISOString();
  calls.set(id, {
    id, status: 'ringing', media: 'video', conversation_id: null, created_by: A.id, created_at: now, answered_at: null, ended_at: null, end_reason: null,
    participants: [
      { user_id: A.id, role: 'caller', state: 'joined', device_id: null, invited_at: now, joined_at: now, left_at: null },
      { user_id: B.id, role: 'callee', state: 'invited', device_id: null, invited_at: now, joined_at: null, left_at: null },
    ],
  });
  return calls.get(id);
}
const stateOf = c => ({ ...c, now: new Date().toISOString(), participants: c.participants.map(p => ({ ...p })) });
function settle(c) {
  const pending = c.participants.filter(p => ['invited', 'ringing'].includes(p.state)).length;
  const joined = c.participants.filter(p => p.state === 'joined').length;
  const answered = c.participants.some(p => p.role === 'callee' && p.joined_at);
  const callerIn = c.participants.some(p => p.role === 'caller' && p.state === 'joined');
  const end = status => {
    c.participants.forEach(p => { if (['invited', 'ringing'].includes(p.state)) p.state = 'missed'; if (p.state === 'joined') { p.state = 'left'; p.left_at = new Date().toISOString(); } });
    c.status = status; c.ended_at = new Date().toISOString();
  };
  if (c.status === 'ringing') {
    if (answered) { c.status = 'active'; c.answered_at = c.answered_at || new Date().toISOString(); }
    else if (!callerIn || !pending) { const callees = c.participants.filter(p => p.role === 'callee'); end(callees.every(p => p.state === 'declined') ? 'declined' : 'missed'); return; }
  }
  if (c.status === 'active' && joined <= 1 && (!pending || !joined)) end('ended');
}
function callRpc(fn, body, uid) {
  if (fn === 'ws_call_start') {
    const id = randomUUID(), now = new Date().toISOString();
    const c = { id, status: 'ringing', media: body.p_media, conversation_id: null, created_by: uid, created_at: now, answered_at: null, ended_at: null, end_reason: null,
      participants: [{ user_id: uid, role: 'caller', state: 'joined', device_id: null, invited_at: now, joined_at: now, left_at: null },
        ...(body.p_callees || []).map(u => ({ user_id: u, role: 'callee', state: 'invited', device_id: null, invited_at: now, joined_at: null, left_at: null }))] };
    calls.set(id, c);
    lastStarted = id;
    emitCallChanges(c, 'INSERT');
    return [200, id];
  }
  if (fn === 'ws_call_live') {
    return [200, [...calls.values()].filter(c => ['ringing', 'active'].includes(c.status)
      && c.participants.some(p => p.user_id === uid && ['invited', 'ringing', 'joined'].includes(p.state))).map(stateOf)];
  }
  const c = calls.get(body && body.p_call);
  if (!c) return [400, { code: 'P0001', message: 'Call not found' }];
  const me = c.participants.find(p => p.user_id === uid);
  if (!me) return [400, { code: '42501', message: 'Call not found' }];
  if (fn === 'ws_call_get') return [200, stateOf(c)];
  if (fn !== 'ws_call_action') return [404, { code: 'PGRST202', message: 'Could not find the function' }];
  const before = JSON.stringify(c);
  const live = ['ringing', 'active'].includes(c.status);
  const act = body.p_action;
  if (act === 'join') {
    if (!live) return [400, { code: 'P0001', message: 'This call has ended' }];
    Object.assign(me, { state: 'joined', device_id: body.p_device, joined_at: me.joined_at || new Date().toISOString(), left_at: null });
  } else if (act === 'ringing') { if (me.state === 'invited') me.state = 'ringing'; }
  else if (act === 'decline') { if (['invited', 'ringing'].includes(me.state)) me.state = 'declined'; }
  else if (act === 'leave') {
    if (me.state === 'joined' && (!body.p_device || !me.device_id || me.device_id === body.p_device)) { me.state = 'left'; me.left_at = new Date().toISOString(); }
    else if (['invited', 'ringing'].includes(me.state)) me.state = 'declined';
  }
  if (live) settle(c);
  if (JSON.stringify(c) !== before) emitCallChanges(c);
  return [200, stateOf(c)];
}

// ---- Realtime: supabase-js's vsn 2.0.0 protocol (JSON arrays; user broadcasts arrive as binary frames)
const sockets = new Set();          // { ws, channels: Map(topic -> { key, bindings, meta }) }
const frame = (topic, event, payload, joinRef = null, ref = null) => JSON.stringify([joinRef, ref, topic, event, payload]);
function inTopic(topic) { return [...sockets].filter(s => s.channels.has(topic)); }
function presenceEntry(meta) { return { metas: [meta] }; }
function emitCallChanges(c, type = 'UPDATE') {
  const stamp = new Date().toISOString();
  const rows = [['calls', { ...c, participants: undefined }], ...c.participants.map(p => ['call_participants', { call_id: c.id, ...p }])];
  for (const s of sockets) {
    for (const [topic, ch] of s.channels) {
      for (const b of ch.bindings) {
        for (const [table, record] of rows) {
          if (b.table !== table || !['*', type].includes(b.event)) continue;
          const m = /^(\w+)=eq\.(.+)$/.exec(b.filter || '');
          if (m && String(record[m[1]]) !== m[2]) continue;
          const rec = JSON.parse(JSON.stringify(record));
          s.ws.send(frame(topic, 'postgres_changes', { ids: [b.id], data: { schema: 'public', table, commit_timestamp: stamp, type, record: rec, old_record: {}, columns: Object.keys(rec).map(name => ({ name, type: 'text' })), errors: null } }));
        }
      }
    }
  }
}
function onSocketMessage(s, data, isBinary) {
  if (isBinary) {
    const b = Buffer.from(data);
    if (b[0] !== 3) return;                                   // user broadcast push
    const [jl, rl, tl, el, ml, enc] = [b[1], b[2], b[3], b[4], b[5], b[6]];
    let o = 7 + jl + rl;
    const topic = b.subarray(o, o + tl).toString(); o += tl;
    const event = b.subarray(o, o + el).toString(); o += el + ml;
    const payload = enc === 1 ? JSON.parse(b.subarray(o).toString() || '{}') : null;
    inTopic(topic).filter(x => x !== s).forEach(x => x.ws.send(frame(topic, 'broadcast', { type: 'broadcast', event, payload })));
    return;
  }
  const [joinRef, ref, topic, event, payload] = JSON.parse(String(data));
  const reply = (response = {}) => s.ws.send(frame(topic, 'phx_reply', { status: 'ok', response }, joinRef, ref));
  if (event === 'phx_join') {
    const cfg = (payload && payload.config) || {};
    const bindings = (cfg.postgres_changes || []).map((b, i) => ({ id: 1000 + i, ...b }));
    s.channels.set(topic, { key: cfg.presence && cfg.presence.key, bindings, meta: null });
    reply({ postgres_changes: bindings });
    const state = {};
    inTopic(topic).forEach(x => { const ch = x.channels.get(topic); if (ch.meta) state[ch.key] = presenceEntry(ch.meta); });
    s.ws.send(frame(topic, 'presence_state', state));
  } else if (event === 'presence') {
    const ch = s.channels.get(topic);
    reply();
    if (!ch) return;
    const leaves = {}, joins = {};
    if (ch.meta) leaves[ch.key] = presenceEntry(ch.meta);
    if (payload.event === 'track') { ch.meta = { ...payload.payload, phx_ref: Math.random().toString(36).slice(2) }; joins[ch.key] = presenceEntry(ch.meta); }
    else ch.meta = null;
    inTopic(topic).forEach(x => x.ws.send(frame(topic, 'presence_diff', { joins, leaves })));
  } else if (event === 'broadcast') {
    reply();
    inTopic(topic).filter(x => x !== s).forEach(x => x.ws.send(frame(topic, 'broadcast', payload)));
  } else if (event === 'phx_leave') {
    leaveTopic(s, topic);
    reply();
  } else {
    reply();                                                  // heartbeat, access_token
  }
}
function leaveTopic(s, topic) {
  const ch = s.channels.get(topic);
  if (!ch) return;
  s.channels.delete(topic);
  if (ch.meta) inTopic(topic).forEach(x => x.ws.send(frame(topic, 'presence_diff', { joins: {}, leaves: { [ch.key]: presenceEntry(ch.meta) } })));
}

/* ------------------------------------------------------------ web server */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
let ORIGIN = '';
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { try { r(b ? JSON.parse(b) : null); } catch { r(null); } }); });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  if (p === '/__calls-page') {
    // A bare WorkSuite-like page: a Supabase client and the global calls script, nothing else.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>calls.js</title>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script>
window.__events = [];
['ws:call-incoming', 'ws:call-ended', 'ws:call-resume', 'ws:call-active'].forEach(n => window.addEventListener(n, e => window.__events.push(n)));
fetch('/api/config').then(r => r.json()).then(cfg => { window.__WS_SB__ = supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey); });
</script>
<script src="/calls.js"></script></head>
<body style="font-family:system-ui;padding:24px"><h1>Some WorkSuite page</h1>
<button id="start" onclick="WSCalls.start({ userIds: ['${B.id}'], video: true })">Call Bala</button></body></html>`);
  }
  if (p === '/api/config') return json(res, 200, { supabaseUrl: `${ORIGIN}/sb`, supabaseAnonKey: 'test-anon-key' });
  if (p === '/api/ice') return json(res, 200, { iceServers: [{ urls: 'stun:127.0.0.1:9' }], relay: false, provider: 'test' });
  if (p === '/api/push') {
    const body = (await readBody(req)) || {};
    const uid = userOf(req);
    pushes.push({ uid, body });
    // The real endpoint leaves for the caller first when asked (pagehide), then pushes.
    if (body.action === 'call-end' && body.leave) callRpc('ws_call_action', { p_call: body.call_id, p_action: 'leave', p_device: body.device }, uid);
    return json(res, 200, { success: true });
  }
  if (p.startsWith('/api/')) { await readBody(req); return json(res, 200, { success: true }); }
  if (p.startsWith('/sb/')) {
    const body = await readBody(req);
    const uid = userOf(req);
    if (p.startsWith('/sb/auth/v1/user')) { const u = PEOPLE.find(x => x.id === uid); return u ? json(res, 200, session(u).user) : json(res, 401, {}); }
    if (p.startsWith('/sb/auth/v1/')) return json(res, 200, {});
    if (p === '/sb/rest/v1/rpc/ws_call_start' && startDelay) await new Promise(r => setTimeout(r, startDelay));
    if (p.startsWith('/sb/rest/v1/rpc/')) { const [status, out] = callRpc(p.slice('/sb/rest/v1/rpc/'.length), body, uid); return json(res, status, out); }
    if (p === '/sb/rest/v1/profiles') {
      let rows = PEOPLE;
      const id = url.searchParams.get('id') || '';
      if (id.startsWith('eq.')) rows = rows.filter(r => r.id === id.slice(3));
      if (id.startsWith('in.')) rows = rows.filter(r => id.includes(r.id));
      return json(res, 200, req.method === 'GET' ? rows.map(r => ({ ...r, email_verified: true, company: 'Nova' })) : []);
    }
    return json(res, 200, []);
  }
  let file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
const wss = new WebSocket.Server({ server, path: '/sb/realtime/v1/websocket' });
wss.on('connection', ws => {
  const s = { ws, channels: new Map() };
  sockets.add(s);
  ws.on('message', (d, bin) => { try { onSocketMessage(s, d, bin); } catch (e) { console.error('realtime mock:', e.message); } });
  ws.on('close', () => { sockets.delete(s); [...s.channels.keys()].forEach(t => leaveTopic(s, t)); });
});

/* -------------------------------------------------- part 2: the call window */
async function callWindowChecks(browser) {
  const results = [];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const check = async (name, fn) => {
    const t0 = Date.now();
    try { await fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); }
    catch (e) { results.push({ name, ok: false, ms: Date.now() - t0, error: String(e && e.message || e).split('\n')[0] }); }
  };
  const until = async (page, fn, arg, ms, label) => {
    try { await page.waitForFunction(fn, { timeout: ms, polling: 100 }, arg); }
    catch { throw new Error(`timed out after ${ms} ms: ${label}`); }
  };
  const errors = [];
  async function open(user, route, viewport) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport(viewport || { width: 1040, height: 720 });
    page.on('pageerror', e => errors.push(`${user ? user.full_name : 'signed out'}: ${String(e && e.message || e).split('\n')[0]}`));
    if (process.env.CALLS_VERBOSE) page.on('console', m => console.log(`   ${user ? user.full_name.split(' ')[0] : 'anon'}:`, m.text()));
    await page.evaluateOnNewDocument((s) => {
      try { if (s) localStorage.setItem('sb-localhost-auth-token', s); localStorage.setItem('ws-call-debug', '0'); } catch (e) { /* ignore */ }
    }, user ? JSON.stringify(session(user)) : null);
    await page.goto(ORIGIN + route, { waitUntil: 'load' });
    return { ctx, page };
  }
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, `call-${name}.png`) });
  fs.mkdirSync(OUT, { recursive: true });

  const CALL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  newCall(CALL);
  let caller, callee;
  await check('caller sees "Calling…", then "Ringing…" once the callee’s device has it', async () => {
    caller = await open(A, `/call/?id=${CALL}`);
    await until(caller.page, () => document.body.classList.contains('phase-calling') && /Calling|Ringing/.test(document.getElementById('panel-sub').textContent), null, 15000, 'calling screen');
    callee = await open(B, `/call/?id=${CALL}`, { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await until(callee.page, () => document.body.classList.contains('phase-incoming') && !!document.querySelector('.pbtn.accept'), null, 15000, 'incoming screen');
    await until(caller.page, () => document.getElementById('panel-sub').textContent === 'Ringing…', null, 8000, 'Ringing… on the caller');
    await shot(caller.page, 'calling-desktop');
    await shot(callee.page, 'incoming-phone');
  });

  await check('accepting connects both sides with video both ways', async () => {
    await callee.page.click('.pbtn.accept');
    const live = () => {
      const t = document.querySelector('#tiles .tile:not(.self)');
      return document.body.classList.contains('phase-incall') && t && t.classList.contains('has-video') && t.querySelector('.tile-status').hidden;
    };
    await until(caller.page, live, null, 20000, 'caller in call with remote video');
    await until(callee.page, live, null, 20000, 'callee in call with remote video');
    await until(caller.page, () => /^\d+:\d\d$/.test(document.getElementById('tb-sub').textContent), null, 5000, 'call timer');
    await wait(800);
    await shot(caller.page, 'incall-desktop');
    await shot(callee.page, 'incall-phone');
  });

  await check('mute and camera-off reach the other side', async () => {
    await callee.page.click('#btn-mic');
    await until(caller.page, () => { const t = document.querySelector('#tiles .tile:not(.self)'); return t && !t.querySelector('.mic-off').hidden; }, null, 5000, 'mute icon on the caller’s screen');
    await caller.page.click('#btn-cam');
    await until(callee.page, () => { const t = document.querySelector('#tiles .tile:not(.self)'); return t && !t.classList.contains('has-video'); }, null, 8000, 'avatar instead of video on the callee’s screen');
    await until(caller.page, () => !document.getElementById('self-tile').classList.contains('has-video'), null, 3000, 'caller’s own preview off');
    await caller.page.click('#btn-cam');
    await until(callee.page, () => { const t = document.querySelector('#tiles .tile:not(.self)'); return t && t.classList.contains('has-video'); }, null, 10000, 'video back on the callee’s screen');
  });

  await check('the devices sheet shows how each person is connected', async () => {
    await caller.page.click('#btn-devices');
    await until(caller.page, () => /Relay server: not configured/.test(document.getElementById('conn-relay').textContent)
      && /Bala Callee/.test(document.getElementById('conn-peers').textContent)
      && /direct|via relay/.test(document.getElementById('conn-peers').textContent), null, 6000, 'connection details');
    await shot(caller.page, 'devices-desktop');
    await caller.page.keyboard.press('Escape');
  });

  await check('hanging up ends the call for both, with its duration', async () => {
    await caller.page.click('#btn-hangup');
    const ended = () => document.body.classList.contains('phase-ended') && /Call ended/.test(document.getElementById('panel-title').textContent) && /^\d+:\d\d$/.test(document.getElementById('panel-sub').textContent);
    await until(caller.page, ended, null, 8000, 'ended on the caller');
    await until(callee.page, ended, null, 8000, 'ended on the callee');
    const c = calls.get(CALL);
    if (c.status !== 'ended') throw new Error('server status ' + c.status);
    await wait(300);
    if (!pushes.some(x => x.body.action === 'call-end' && x.body.call_id === CALL)) throw new Error('no call-end push after the call ended');
    await shot(callee.page, 'ended-phone');
  });
  for (const x of [caller, callee]) if (x) await x.ctx.close();

  await check('closing the call window leaves the call (pagehide) and the other side ends', async () => {
    const CALL4 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    newCall(CALL4);
    const a = await open(A, `/call/?id=${CALL4}`);
    const b = await open(B, `/call/?id=${CALL4}&answer=1`);
    const live = () => { const t = document.querySelector('#tiles .tile:not(.self)'); return document.body.classList.contains('phase-incall') && t && t.classList.contains('has-video'); };
    await until(a.page, live, null, 20000, 'caller in call');
    await until(b.page, live, null, 20000, 'callee in call');
    await b.page.close();
    await until(a.page, () => document.body.classList.contains('phase-ended') && /Call ended/.test(document.getElementById('panel-title').textContent), null, 10000, 'caller sees the call end');
    await wait(500);
    if (!pushes.some(x => x.uid === B.id && x.body.action === 'call-end' && x.body.leave === true && x.body.call_id === CALL4)) throw new Error('no leave + call-end push from the closed window');
    if (calls.get(CALL4).status !== 'ended') throw new Error('server status ' + calls.get(CALL4).status);
    await a.ctx.close(); await b.ctx.close();
  });

  await check('calls.js: WSCalls.start opens the call window and the other person’s page rings, Accept connects', async () => {
    const a = await open(A, '/__calls-page');
    const b = await open(B, '/__calls-page');
    for (const x of [a, b]) await until(x.page, () => window.WSCalls && window.__WS_SB__, null, 8000, 'calls.js loaded');
    await Promise.all([a.page.evaluate(() => WSCalls.ready), b.page.evaluate(() => WSCalls.ready)]);
    const inPage = async (page, fn, ms, label) => {            // survives the popup's navigation
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { try { if (await page.evaluate(fn)) return; } catch { /* navigating */ } await wait(150); }
      throw new Error(`timed out after ${ms} ms: ${label}`);
    };
    const popupOf = page => new Promise(r => page.once('popup', r));
    const aPop = popupOf(a.page);
    await a.page.click('#start');
    const callerWin = await aPop;
    callerWin.on('pageerror', e => errors.push('caller popup: ' + String(e && e.message || e).split('\n')[0]));
    await inPage(callerWin, () => location.pathname === '/call/' && document.body.classList.contains('phase-calling'), 15000, 'caller popup calling');
    await until(b.page, () => !!document.querySelector('#wsc-root .wsc-card .wsc-accept'), null, 10000, 'incoming card on the other page');
    await shot(b.page, 'ringing-card-desktop');
    if (!(await b.page.evaluate(() => window.__events.includes('ws:call-incoming')))) throw new Error('no ws:call-incoming event');
    const bPop = popupOf(b.page);
    await b.page.click('.wsc-accept');
    const calleeWin = await bPop;
    calleeWin.on('pageerror', e => errors.push('callee popup: ' + String(e && e.message || e).split('\n')[0]));
    await until(b.page, () => !document.querySelector('.wsc-card'), null, 3000, 'card gone after accepting');
    const live = () => { const t = document.querySelector('#tiles .tile:not(.self)'); return document.body.classList.contains('phase-incall') && t && t.classList.contains('has-video'); };
    await inPage(callerWin, live, 20000, 'caller popup in call');
    await inPage(calleeWin, live, 20000, 'callee popup in call');
    await until(b.page, () => !!document.getElementById('wsc-pill'), null, 8000, 'Return to call pill');
    await callerWin.click('#btn-hangup');
    await inPage(calleeWin, () => document.body.classList.contains('phase-ended'), 8000, 'callee popup ended');
    await until(b.page, () => !document.getElementById('wsc-pill') && window.__events.includes('ws:call-resume'), null, 8000, 'pill gone and ws:call-resume');

    // A call window on its Accept / Decline screen (opened from a notification) has not taken the
    // call: the card keeps ringing, no "Return to call", and declining there resumes this page.
    await b.page.evaluate(() => { window.__events = []; });
    const CALL5 = '12121212-1212-4121-8121-121212121212';
    emitCallChanges(newCall(CALL5), 'INSERT');
    await until(b.page, () => !!document.querySelector('.wsc-card .wsc-accept'), null, 8000, 'card for the second call');
    const win5 = await b.ctx.newPage();
    await win5.goto(`${ORIGIN}/call/?id=${CALL5}`, { waitUntil: 'load' });
    await until(win5, () => document.body.classList.contains('phase-incoming') && !!document.querySelector('.pbtn.decline'), null, 10000, 'incoming screen in the window');
    await wait(1500);
    if (!(await b.page.evaluate(() => !!document.querySelector('.wsc-card') && !document.getElementById('wsc-pill')))) throw new Error('the Accept/Decline window was treated as an answered call');
    await win5.click('.pbtn.decline');
    await until(b.page, () => !document.querySelector('.wsc-card') && window.__events.includes('ws:call-resume'), null, 8000, 'card gone and ws:call-resume after declining in the window');
    await win5.close();

    // Closing the "Starting call…" window before the server answers is a cancel: this tab stays put.
    startDelay = 1200;
    const before = lastStarted;
    const pop = popupOf(a.page);
    await a.page.click('#start');
    await (await pop).close();
    await until(a.page, () => true, null, 100, 'noop');
    await wait(2500);
    startDelay = 0;
    if (lastStarted === before) throw new Error('no call was started');
    if (new URL(a.page.url()).pathname !== '/__calls-page') throw new Error('the tab was pulled into the call: ' + a.page.url());
    if (calls.get(lastStarted).status === 'ringing') throw new Error('the cancelled call is still ringing');
    await until(b.page, () => !document.querySelector('.wsc-card'), null, 8000, 'no card left ringing for the cancelled call');
    for (const x of [a, b]) await x.ctx.close();
  });

  const CALL2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  newCall(CALL2);
  await check('the notification’s Decline link declines the call', async () => {
    // The return address is hostile: after declining, the page must stay on this site.
    const d = await open(B, `/call/?id=${CALL2}&decline=1&return=${encodeURIComponent('/.//evil.example/x')}`, { width: 390, height: 844, isMobile: true });
    await until(d.page, () => /Call declined/.test((document.getElementById('panel-title') || {}).textContent || '') || !location.pathname.startsWith('/call'), null, 6000, 'declined screen');
    const c = calls.get(CALL2);
    if (c.status !== 'declined') throw new Error('server status ' + c.status);
    await new Promise(r => setTimeout(r, 2500));
    const landed = new URL(d.page.url());
    if (landed.origin !== ORIGIN || landed.pathname !== '/evil.example/x') throw new Error('redirected to ' + d.page.url());
    await d.ctx.close();
  });

  await check('an unknown call says so (desktop and phone)', async () => {
    for (const [vp, size] of [['desktop', { width: 1040, height: 720 }], ['phone', { width: 390, height: 844, isMobile: true }]]) {
      const x = await open(A, '/call/?id=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', size);
      await until(x.page, () => document.getElementById('panel-title').textContent === 'Call not found', null, 8000, 'not found screen');
      const overflow = await x.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) throw new Error(`horizontal overflow ${overflow}px on ${vp}`);
      await shot(x.page, `notfound-${vp}`);
      await x.ctx.close();
    }
  });

  errors.forEach(e => results.push({ name: 'uncaught page error', ok: false, error: e }));
  return results;
}

(async () => {
  await new Promise(r => server.listen(0, 'localhost', r));
  const origin = ORIGIN = `http://localhost:${server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  let results = [];
  const only = process.argv[2];
  if (only !== 'window') {
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(String(e && e.message || e)));
      if (process.env.CALLS_VERBOSE) page.on('console', m => console.log('   page:', m.text()));
      await page.goto(`${origin}/tests/ui-smoke/mesh-harness.html`, { waitUntil: 'load' });
      page.setDefaultTimeout(180000);
      results = await page.evaluate(() => window.runAll());
      errors.forEach(e => results.push({ name: 'uncaught page error', ok: false, error: e }));
      await page.close();
    } catch (e) {
      results.push({ name: 'harness', ok: false, error: String(e && e.message || e) });
    }
  }
  if (only !== 'engine') {
    try { results.push(...await callWindowChecks(browser)); }
    catch (e) { results.push({ name: 'call window', ok: false, error: String(e && e.message || e) }); }
  }
  await browser.close();
  wss.close();
  server.close();
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ms != null ? `  (${r.ms} ms)` : ''}`);
    if (!r.ok) console.log(`       ${r.error}`);
  }
  console.log(`\n${results.length - failed}/${results.length} call checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
