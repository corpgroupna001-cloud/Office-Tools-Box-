// Messenger & calls v2 (supabase-messenger-calls-migration.sql) on a real
// Postgres engine (PGlite): the inbox, and every rule of a call exactly as the
// database enforces it for signed-in employees. Time-outs are exercised by
// back-dating rows as the service, the way a closed laptop would leave them.
//
// Skips itself when the dev dependency is missing: npm i -D @electric-sql/pglite
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, as, makeUser, pglite } = require('./fixtures/load-db');

const skip = pglite() ? false : 'PGlite is not installed (npm i -D @electric-sql/pglite)';
const NOVA = 'Nova Sportsmart Private Limited';
const JOBWAYS = 'Jobways Point LLP';
const RLS = /row-level security/;

let db, A, C, D, E, B;     // A, C, D, E Nova employees; B another company
const q = async (uid, sql, params) => (await as(db, uid, () => db.query(sql, params))).rows;
const svc = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (uid, sql, params) => (await q(uid, sql, params))[0];
const json = v => (typeof v === 'string' ? JSON.parse(v) : v);
const arr = ids => (ids ? `{${ids.join(',')}}` : null);

const start = async (uid, callees, media = 'audio', conv = null) =>
  (await one(uid, `select public.ws_call_start($1::uuid[], $2, $3::uuid) as id`, [arr(callees), media, conv])).id;
const act = async (uid, call, action, device = null) =>
  json((await one(uid, `select public.ws_call_action($1::uuid, $2, $3) as s`, [call, action, device])).s);
const get = async (uid, call) => json((await one(uid, `select public.ws_call_get($1::uuid) as s`, [call])).s);
const stateOf = (s, uid) => (s.participants.find(p => p.user_id === uid) || {}).state;
const callLogs = async (a, b) => svc(`select body, read_at from messages where body like '\\_\\_CALL\\_\\_::%'
  and ((sender_id = $1 and recipient_id = $2) or (sender_id = $2 and recipient_id = $1)) order by id`, [a, b]);
const missedBells = async uid => (await svc(`select count(*)::int n from notifications where user_id = $1 and kind = 'call.missed'`, [uid]))[0].n;

test.before(async () => {
  if (skip) return;
  db = await freshDb();
  A = await makeUser(db, { email: 'anil@nova.test', name: 'Anil Kumar', company: NOVA });
  C = await makeUser(db, { email: 'chitra@nova.test', name: 'Chitra Rao', company: NOVA });
  D = await makeUser(db, { email: 'dev@nova.test', name: 'Dev Patel', company: NOVA });
  E = await makeUser(db, { email: 'esha@nova.test', name: 'Esha Iyer', company: NOVA });
  B = await makeUser(db, { email: 'bala@jobways.test', name: 'Bala J', company: JOBWAYS });
});

test('the inbox lists each conversation once with its last message and unread count', { skip }, async () => {
  await q(A, `insert into messages (sender_id, recipient_id, body) values ($1, $2, 'first')`, [A, C]);
  await q(C, `insert into messages (sender_id, recipient_id, body) values ($1, $2, 'reply one')`, [C, A]);
  await q(C, `insert into messages (sender_id, recipient_id, body) values ($1, $2, 'reply two')`, [C, A]);
  const g = await one(A, `insert into conversations (name) values ('Inbox group') returning id`);
  await q(A, `insert into conversation_members (conversation_id, user_id, added_by) values ($1, $2, $3)`, [g.id, D, A]);
  await q(D, `insert into messages (sender_id, conversation_id, body) values ($1, $2, 'group hello')`, [D, g.id]);

  const rows = await q(A, `select * from public.ws_chat_inbox()`);
  const dm = rows.find(r => r.kind === 'dm' && r.peer_id === C);
  assert.equal(dm.last_body, 'reply two');
  assert.equal(Number(dm.unread), 2);
  const grp = rows.find(r => r.kind === 'group' && r.conversation_id === g.id);
  assert.equal(grp.last_body, 'group hello');
  assert.equal(Number(grp.unread), 1);
  assert.equal(rows.filter(r => r.kind === 'dm' && r.peer_id === C).length, 1, 'one row per person');

  const cRows = await q(C, `select * from public.ws_chat_inbox()`);
  assert.equal(Number(cRows.find(r => r.peer_id === A).unread), 1, 'the other side counts its own unread');
  assert.equal((await q(B, `select * from public.ws_chat_inbox()`)).length, 0, 'someone outside sees nothing');
});

test('a message id chosen by the browser is unique per sender, so a retried send cannot duplicate', { skip }, async () => {
  const cid = '9d7b8f5e-1c2a-4b3d-8e4f-a1b2c3d4e5f6';
  await q(A, `insert into messages (sender_id, recipient_id, body, client_id) values ($1, $2, 'once', $3)`, [A, C, cid]);
  await assert.rejects(q(A, `insert into messages (sender_id, recipient_id, body, client_id) values ($1, $2, 'once', $3)`, [A, C, cid]), /duplicate key|unique/);
  await q(C, `insert into messages (sender_id, recipient_id, body, client_id) values ($1, $2, 'mine too', $3)`, [C, A, cid]);
});

test('a chat attachment is readable by its uploader and its conversation only, and goes with its message', { skip }, async () => {
  const seen = async (uid, name) => (await q(uid, `select name from storage.objects where bucket_id = 'chat-files' and name = $1`, [name])).length;
  const path = `${A}/1757571000000-ab12cd-plan.pdf`;
  await q(A, `insert into storage.objects (bucket_id, name) values ('chat-files', $1)`, [path]);
  assert.equal(await seen(A, path), 1, 'the uploader');
  assert.equal(await seen(C, path), 0, 'nobody else before it is sent');
  const m = await one(A, `insert into messages (sender_id, recipient_id, body) values ($1, $2, $3) returning id`,
    [A, C, `__FILE__::${path}::application/pdf::1200::plan.pdf`]);
  assert.equal(await seen(C, path), 1, 'the recipient');
  assert.equal(await seen(D, path), 0, 'a colleague outside the chat');
  assert.equal(await seen(B, path), 0, 'another company');
  assert.equal((await q(D, `select name from storage.objects where bucket_id = 'chat-files'`)).filter(r => r.name.startsWith(`${A}/`)).length, 0,
    'nobody can list someone else’s folder');
  await q(A, `update messages set body = '__DELETED__' where id = $1`, [m.id]);
  assert.equal(await seen(C, path), 0, 'deleting it for everyone withdraws the file');

  const g = await one(A, `insert into conversations (name) values ('Files') returning id`);
  await q(A, `insert into conversation_members (conversation_id, user_id, added_by) values ($1, $2, $3)`, [g.id, D, A]);
  const gpath = `${A}/1757571000001-cd34ef-photo.png`;
  await q(A, `insert into storage.objects (bucket_id, name) values ('chat-files', $1)`, [gpath]);
  await q(A, `insert into messages (sender_id, conversation_id, body) values ($1, $2, $3)`, [A, g.id, `__FILE__::${gpath}::image/png::10::photo.png`]);
  assert.equal(await seen(D, gpath), 1, 'a group member');
  assert.equal(await seen(C, gpath), 0, 'not a member of that group');
});

test('a 1:1 call: only its two people see it, nobody writes it directly, and it rings, connects and ends', { skip }, async () => {
  const id = await start(A, [C], 'video');
  let s = await get(A, id);
  assert.equal(s.status, 'ringing');
  assert.equal(s.media, 'video');
  assert.deepEqual([stateOf(s, A), stateOf(s, C)], ['joined', 'invited']);
  assert.equal((await q(C, `select id from calls where id = $1`, [id])).length, 1, 'the callee sees it');
  assert.equal((await q(D, `select id from calls where id = $1`, [id])).length, 0, 'a colleague does not');
  assert.equal((await q(B, `select call_id from call_participants where call_id = $1`, [id])).length, 0);
  await assert.rejects(q(A, `insert into calls (created_by, media) values ($1, 'audio')`, [A]), RLS, 'no direct inserts');
  assert.equal((await q(C, `update call_participants set state = 'joined' where call_id = $1 returning call_id`, [id])).length, 0, 'no direct updates');
  await assert.rejects(get(D, id), /Call not found/);
  await assert.rejects(q(A, `select public.ws_call_settle($1::uuid)`, [id]), /permission denied/, 'the internal settle is not callable');

  s = await act(C, id, 'ringing');
  assert.equal(stateOf(s, C), 'ringing', 'the caller can now show "Ringing…"');
  s = await act(C, id, 'join', 'phone-1');
  assert.equal(s.status, 'active');
  assert.ok(s.answered_at);
  assert.equal(s.participants.find(p => p.user_id === C).device_id, 'phone-1');
  s = await act(C, id, 'heartbeat', 'phone-1');
  assert.equal(s.status, 'active');
  s = await act(A, id, 'leave');
  assert.equal(s.status, 'ended');
  assert.equal(s.end_reason, 'hangup');
  assert.deepEqual([stateOf(s, A), stateOf(s, C)], ['left', 'left']);

  const logs = (await callLogs(A, C)).filter(l => l.body.startsWith('__CALL__::video::completed::'));
  assert.equal(logs.length, 1, 'the database logs the call exactly once');
  assert.match(logs[0].body, /^__CALL__::video::completed::\d+$/);
  assert.ok(logs[0].read_at, 'a call you took is not an unread message');
  await assert.rejects(act(C, id, 'join', 'phone-1'), /This call has ended/);
  assert.equal(await missedBells(C), 0);
});

test('a declined call ends as declined, without a missed-call bell', { skip }, async () => {
  const id = await start(A, [C]);
  const s = await act(C, id, 'decline');
  assert.equal(s.status, 'declined');
  assert.equal(s.end_reason, 'declined');
  const last = (await callLogs(A, C)).pop();
  assert.equal(last.body, '__CALL__::audio::declined::0');
  assert.equal(await missedBells(C), 0);
});

test('hanging up before an answer is a missed call for the callee: logged unread and belled', { skip }, async () => {
  const id = await start(A, [C]);
  const s = await act(A, id, 'leave');
  assert.equal(s.status, 'missed');
  assert.equal(s.end_reason, 'cancelled');
  assert.equal(stateOf(s, C), 'missed');
  const last = (await callLogs(A, C)).pop();
  assert.equal(last.body, '__CALL__::audio::missed::0');
  assert.equal(last.read_at, null, 'a missed call stays unread');
  assert.equal(await missedBells(C), 1);
  const n = await one(C, `select title, body, url from notifications where user_id = $1 and kind = 'call.missed'`, [C]);
  assert.deepEqual(n, { title: 'Missed voice call', body: 'from Anil Kumar', url: `/chat/#thread=${A}` });
});

test('an unanswered invitation times out after 45 seconds', { skip }, async () => {
  const id = await start(A, [C]);
  await svc(`update call_participants set invited_at = now() - interval '50 seconds' where call_id = $1 and user_id = $2`, [id, C]);
  const s = await get(A, id);
  assert.equal(s.status, 'missed');
  assert.equal(s.end_reason, 'no_answer');
  assert.equal((await q(C, `select public.ws_call_live() as l`))[0].l.length, 0, 'nothing is ringing any more');
});

test('someone already in a call is busy and does not ring; nobody can start two calls', { skip }, async () => {
  const id = await start(A, [C]);
  await act(C, id, 'join', 'c-1');
  const busy = await start(D, [C]);
  const s = await get(D, busy);
  assert.equal(s.status, 'busy');
  assert.equal(stateOf(s, C), 'busy');
  const log = (await callLogs(D, C)).pop();
  assert.equal(log.body, '__CALL__::audio::busy::0');
  assert.ok((await missedBells(C)) >= 2, 'the busy callee hears they missed it');
  await assert.rejects(start(A, [D]), /You are already in a call/);
  await act(A, id, 'leave');
});

test('a device that stops heartbeating is dropped after 40 seconds, ending a 1:1 call', { skip }, async () => {
  const id = await start(A, [C]);
  await act(C, id, 'join', 'c-1');
  await svc(`update call_participants set last_seen_at = now() - interval '60 seconds' where call_id = $1 and user_id = $2`, [id, C]);
  const s = await get(A, id);
  assert.equal(s.status, 'ended');
  assert.equal(stateOf(s, C), 'left');
});

test('picking up on a second device takes over: the first device can no longer hang up', { skip }, async () => {
  const id = await start(A, [C]);
  await act(C, id, 'join', 'laptop');
  await act(C, id, 'join', 'phone');
  let s = await act(C, id, 'leave', 'laptop');
  assert.equal(s.status, 'active', 'the old tab closing does not end the call');
  s = await act(C, id, 'heartbeat', 'laptop');
  assert.equal(s.participants.find(p => p.user_id === C).device_id, 'phone');
  s = await act(C, id, 'leave', 'phone');
  assert.equal(s.status, 'ended');
});

test('a group call rings every member, is visible to members only, shares one live call and admits late members', { skip }, async () => {
  const g = await one(A, `insert into conversations (name) values ('Ops') returning id`);
  await q(A, `insert into conversation_members (conversation_id, user_id, added_by) values ($1, $2, $3), ($1, $4, $3)`, [g.id, C, A, D]);
  const id = await start(A, null, 'video', g.id);
  let s = await get(C, id);
  assert.equal(s.conversation_id, g.id);
  assert.deepEqual(s.participants.map(p => p.state).sort(), ['invited', 'invited', 'joined']);
  assert.equal((await q(E, `select id from calls where id = $1`, [id])).length, 0, 'not a member: not visible');
  await assert.rejects(start(E, null, 'audio', g.id), /You are not in this group/);
  assert.equal(await start(D, null, 'audio', g.id), id, 'a member starting a call joins the live one instead');

  s = await act(C, id, 'join', 'c-1');
  assert.equal(s.status, 'active');
  await q(A, `insert into conversation_members (conversation_id, user_id, added_by) values ($1, $2, $3)`, [g.id, E, A]);
  s = await act(E, id, 'join', 'e-1');
  assert.equal(stateOf(s, E), 'joined', 'a member added later can join the live call');
  s = await act(A, id, 'leave');
  assert.equal(s.status, 'active', 'two people are still talking');
  await act(C, id, 'leave', 'c-1');
  s = await get(E, id);
  assert.equal(s.status, 'active', 'one person left, but D is still being rung: the call waits for them');
  await svc(`update call_participants set invited_at = now() - interval '50 seconds' where call_id = $1 and user_id = $2`, [id, D]);
  s = await get(E, id);
  assert.equal(s.status, 'ended', 'alone with nobody left ringing: the call is over');
  assert.equal(stateOf(s, D), 'missed');
  const log = await svc(`select body from messages where conversation_id = $1 and body like '\\_\\_CALL\\_\\_::%'`, [g.id]);
  assert.equal(log.length, 1);
  assert.match(log[0].body, /^__CALL__::video::completed::\d+$/);
});

test('bad requests are refused with a reason', { skip }, async () => {
  await assert.rejects(start(A, [A]), /Nobody to call/);
  await assert.rejects(start(A, ['00000000-0000-4000-8000-000000000000']), /Nobody to call/, 'someone who does not exist');
  await assert.rejects(q(A, `select public.ws_call_start($1::uuid[], 'hologram', null)`, [arr([C])]), /Unknown call type/);
  const id = await start(A, [C]);
  await assert.rejects(act(A, id, 'explode'), /Unknown call action/);
  await assert.rejects(act(B, id, 'join'), /Call not found/, 'someone from another company cannot join');
  await act(A, id, 'leave');
  const many = [];
  for (let i = 0; i < 8; i++) many.push(await makeUser(db, { email: `p${i}@nova.test`, name: `Person ${i}`, company: NOVA }));
  await assert.rejects(start(A, many), /at most 8 people/);
});

test('ws_call_live shows a ringing call to the callee until it is answered or turned down', { skip }, async () => {
  const id = await start(D, [E]);
  const live = json((await one(E, `select public.ws_call_live() as l`)).l);
  const mine = live.find(c => c.id === id);
  assert.ok(mine, 'the ringing call is listed');
  assert.equal(mine.participants.find(p => p.user_id === E).state, 'invited');
  await act(E, id, 'decline');
  assert.ok(!json((await one(E, `select public.ws_call_live() as l`)).l).some(c => c.id === id), 'gone once declined');
});
