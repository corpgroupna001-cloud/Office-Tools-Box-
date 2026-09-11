// /api/push and /api/ice (api/push.js) end to end, with Supabase and the push
// service stubbed: who may ask for which push, who receives it, what it says.
const test = require('node:test');
const assert = require('node:assert/strict');
const webpush = require('web-push');

const A = '11111111-1111-4111-8111-111111111111';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const G = '55555555-5555-4555-8555-555555555555';
const CALL = '66666666-6666-4666-8666-666666666666';
const TOKENS = { 'tok-a': A, 'tok-c': C, 'tok-d': D };

let sent = [];
webpush.setVapidDetails = () => {};
webpush.sendNotification = async (sub, payload, opts) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), opts }); };

let rows;
let rpcCalls = [];
function reset() {
  const now = new Date().toISOString();
  sent = [];
  rpcCalls = [];
  rows = {
    profiles: [{ id: A, full_name: 'Anil Kumar', email: 'anil@nova.test' }, { id: C, full_name: 'Chitra Rao' }],
    messages: [
      { id: 7, sender_id: A, recipient_id: C, conversation_id: null, body: 'hello there', mentions: [], created_at: now },
      { id: 8, sender_id: A, recipient_id: null, conversation_id: G, body: 'team update', mentions: [], created_at: now },
    ],
    conversations: [{ id: G, name: 'Ops' }],
    conversation_members: [{ conversation_id: G, user_id: A, muted: false }, { conversation_id: G, user_id: C, muted: false }, { conversation_id: G, user_id: D, muted: true }],
    push_subscriptions: [
      { user_id: A, endpoint: 'https://push.test/a', p256dh: 'k', auth: 'x' },
      { user_id: C, endpoint: 'https://push.test/c', p256dh: 'k', auth: 'x' },
      { user_id: D, endpoint: 'https://push.test/d', p256dh: 'k', auth: 'x' },
    ],
    calls: [{ id: CALL, created_by: A, status: 'ringing', media: 'video', conversation_id: null }],
    call_participants: [{ call_id: CALL, user_id: A, role: 'caller', state: 'joined' }, { call_id: CALL, user_id: C, role: 'callee', state: 'ringing' }],
  };
}

const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
global.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.pathname === '/auth/v1/user') {
    const id = TOKENS[String(init.headers.Authorization).replace('Bearer ', '')];
    return id ? reply(200, { id }) : reply(401, {});
  }
  if (u.pathname === '/rest/v1/rpc/ws_call_action') {
    // The caller hanging up while ringing: the database settles the call as missed.
    const args = JSON.parse(init.body);
    rpcCalls.push({ token: String(init.headers.Authorization).replace('Bearer ', ''), args });
    const call = rows.calls.find(c => c.id === args.p_call);
    if (call && args.p_action === 'leave' && call.status === 'ringing') {
      call.status = 'missed';
      rows.call_participants.forEach(p => { if (p.call_id === call.id) p.state = p.role === 'caller' ? 'left' : 'missed'; });
    }
    return reply(200, {});
  }
  if (!u.pathname.startsWith('/rest/v1/')) throw new Error(`unexpected fetch ${url}`);
  const table = u.pathname.slice('/rest/v1/'.length);
  let list = rows[table] || [];
  for (const [k, v] of u.searchParams) {
    if (k === 'select' || k === 'on_conflict') continue;
    const [op, ...rest] = v.split('.');
    const val = rest.join('.');
    if (op === 'eq') list = list.filter(r => String(r[k]) === val);
    if (op === 'in') { const set = new Set(val.replace(/^\(|\)$/g, '').split(',')); list = list.filter(r => set.has(String(r[k]))); }
  }
  if (init.method === 'DELETE') { rows[table] = (rows[table] || []).filter(r => !list.includes(r)); return reply(200, []); }
  return reply(200, list);
};

Object.assign(process.env, {
  SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'service', VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv',
});
for (const k of ['CLOUDFLARE_TURN_KEY_ID', 'METERED_TURN_DOMAIN', 'TURN_URLS']) delete process.env[k];
const handler = require('../api/push');

async function call({ method = 'POST', token, body, query = {} }) {
  const res = { statusCode: 0, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; } };
  await handler({ method, query, url: '/api/push', headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res);
  return res;
}

test('GET answers the public VAPID key without a session', async () => {
  reset();
  const r = await call({ method: 'GET' });
  assert.deepEqual([r.statusCode, r.body], [200, { publicKey: 'pub' }]);
});

test('/api/ice needs a session and never caches credentials in shared caches', async () => {
  reset();
  assert.equal((await call({ method: 'GET', query: { fn: 'ice' } })).statusCode, 401);
  const r = await call({ method: 'GET', query: { fn: 'ice' }, token: 'tok-c' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.provider, 'stun');
  assert.ok(r.body.iceServers[0].urls.length);
  assert.equal(r.headers['cache-control'], 'private, no-store');
});

test('a direct message is announced to its recipient only, in the server’s words', async () => {
  reset();
  const r = await call({ token: 'tok-a', body: { action: 'message', message_id: 7 } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(sent.map(s => s.endpoint), ['https://push.test/c']);
  assert.deepEqual(sent[0].payload, { type: 'message', title: 'Anil Kumar', body: 'hello there', url: `/chat/#thread=${A}`, tag: `dm-${A}`, from: A });
  assert.deepEqual(sent[0].opts, { TTL: 3600, urgency: 'normal' });
});

test('nobody can announce someone else’s message, or a message that does not exist', async () => {
  reset();
  assert.equal((await call({ token: 'tok-c', body: { action: 'message', message_id: 7 } })).statusCode, 403);
  assert.equal((await call({ token: 'tok-a', body: { action: 'message', message_id: 999 } })).statusCode, 404);
  assert.equal((await call({ token: 'tok-a', body: { action: 'message', message_id: 'x' } })).statusCode, 400);
  assert.equal(sent.length, 0);
});

test('a group message reaches unmuted members except the sender', async () => {
  reset();
  await call({ token: 'tok-a', body: { action: 'message', message_id: 8 } });
  assert.deepEqual(sent.map(s => s.endpoint), ['https://push.test/c']);
  assert.equal(sent[0].payload.title, 'Ops');
  assert.equal(sent[0].payload.body, 'Anil: team update');
});

test('only the caller rings, urgently and briefly, and only the people being rung', async () => {
  reset();
  assert.equal((await call({ token: 'tok-c', body: { action: 'call', call_id: CALL } })).statusCode, 403);
  const r = await call({ token: 'tok-a', body: { action: 'call', call_id: CALL } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(sent.map(s => s.endpoint), ['https://push.test/c']);
  assert.equal(sent[0].payload.type, 'call');
  assert.equal(sent[0].payload.url, `/call/?id=${CALL}`);
  assert.deepEqual(sent[0].opts, { TTL: 45, urgency: 'high' });
  assert.equal((await call({ token: 'tok-a', body: { action: 'call', call_id: 'nope' } })).statusCode, 400);
});

test('after a missed call the ringing notification becomes "Missed call"; outsiders cannot trigger it', async () => {
  reset();
  rows.calls[0].status = 'missed';
  rows.call_participants[1].state = 'missed';
  assert.equal((await call({ token: 'tok-d', body: { action: 'call-end', call_id: CALL } })).statusCode, 403);
  const r = await call({ token: 'tok-a', body: { action: 'call-end', call_id: CALL } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(sent.map(s => s.endpoint), ['https://push.test/c'], 'the caller gets nothing');
  assert.equal(sent[0].payload.title, 'Missed video call');
  assert.equal(sent[0].payload.tag, `call-${CALL}`);
});

test('a closing call window hangs up as the caller first, so the phone then shows "Missed call"', async () => {
  reset();
  const r = await call({ token: 'tok-a', body: { action: 'call-end', call_id: CALL, leave: true, device: 'sid-1' } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(rpcCalls, [{ token: 'tok-a', args: { p_call: CALL, p_action: 'leave', p_device: 'sid-1' } }], 'with the caller’s own token, not the service key');
  assert.deepEqual(sent.map(s => s.endpoint), ['https://push.test/c']);
  assert.equal(sent[0].payload.title, 'Missed video call');
});

test('the legacy free-form notify still works for CRM pages', async () => {
  reset();
  const r = await call({ token: 'tok-a', body: { action: 'notify', to: C, title: 'Task assigned', body: 'Chase Acme', url: '/tasks/', tag: 'task' } });
  assert.equal(r.statusCode, 200);
  assert.equal(sent[0].payload.title, 'Task assigned');
  assert.equal((await call({ token: 'tok-a', body: { action: 'notify', to: 'not-a-user' } })).statusCode, 400);
});
