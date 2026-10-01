// supabase-delivery-queue-migration.sql (migration 24) on PGlite: one job per
// message, claimed by one sender, retried with backoff, dead when it cannot
// succeed, sent again only by an administrator — and never after it went out (F-06).
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, as, makeUser, pglite } = require('./fixtures/load-db');

const skip = pglite() ? false : 'WS_SKIP_DB_TESTS=1: database tests skipped on purpose';
let db, U;
const svc = async (sql, params) => (await db.query(sql, params)).rows;
const json = v => (typeof v === 'string' ? JSON.parse(v) : v);
const enqueue = async (key, extra = {}) => json((await svc(
  `select public.ws_delivery_enqueue($1, $2, 'attendance.punch', $3::jsonb, 'Nova', 'attendance_logs', '7', $4, $5, $6, $7) j`,
  [key, extra.channel || 'email', JSON.stringify(extra.payload || { to: 'e@x.test' }), extra.attempts || 0, extra.error || null, !!extra.dead, extra.expires || null]))[0].j);
const claim = async (limit = 10, id = null) => svc(`select * from public.ws_delivery_claim($1, 120, $2)`, [limit, id]);
const result = async (id, attempt, ok, error = null, permanent = false) => json((await svc(`select public.ws_delivery_result($1, $2, $3, $4, $5) r`, [id, attempt, ok, error, permanent]))[0].r);
const job = async id => (await svc(`select * from delivery_jobs where id = $1`, [id]))[0];
const due = id => svc(`update delivery_jobs set next_attempt_at = now() - interval '1 second' where id = $1`, [id]);

test.before(async () => {
  if (skip) return;
  db = await freshDb();
  U = await makeUser(db, { email: 'esha@nova.test', name: 'Esha', company: 'Nova Sportsmart Private Limited' });
});

test('a message is queued once per key; asking again finds the first job', { skip }, async () => {
  const a = await enqueue('attendance:7:email');
  const b = await enqueue('attendance:7:email', { payload: { to: 'other@x.test' } });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.id, a.id);
  assert.equal(json(b.payload).to, 'e@x.test', 'the first payload is kept');
  assert.equal((await svc(`select count(*)::int n from delivery_jobs where idempotency_key = 'attendance:7:email'`))[0].n, 1);
  const bx = await enqueue('attendance:7:bitrix', { channel: 'bitrix' });
  assert.notEqual(bx.id, a.id, 'each channel is its own job');
});

test('one sender per job; transient failures back off and give up as dead, kept for review', { skip }, async () => {
  const j = await enqueue('attendance:8:email');
  const first = await claim();
  assert.ok(first.some(x => x.id === j.id));
  assert.equal((await claim()).filter(x => x.id === j.id).length, 0, 'a claimed job is not handed out twice');
  let row = await job(j.id);
  assert.deepEqual([row.status, row.attempts], ['sending', 1]);
  const after1 = await result(j.id, 1, false, 'smtp_send_failed: timeout');
  assert.equal(after1.status, 'failed');
  const wait = (Date.parse(after1.next_attempt_at) - Date.now()) / 1000;
  assert.ok(wait > 50 && wait <= 61, 'first retry after a minute: ' + wait);
  assert.equal((await claim(10, j.id)).length, 0, 'not due yet');
  const waits = [];
  for (let n = 2; n <= 5; n++) {
    await due(j.id);
    const [c] = await claim(10, j.id);
    assert.equal(c.attempts, n);
    const r = await result(j.id, n, false, 'smtp_send_failed: timeout');
    waits.push(Math.round((Date.parse(r.next_attempt_at) - Date.now()) / 60000));
    if (n < 5) assert.equal(r.status, 'failed');
    else assert.equal(r.status, 'dead', 'five attempts, then dead');
  }
  assert.deepEqual(waits.slice(0, 3), [5, 15, 60]);
  await due(j.id);
  assert.equal((await claim(10, j.id)).length, 0, 'a dead job is not sent again by itself');
  row = await job(j.id);
  assert.match(row.last_error, /timeout/);
});

test('a permanent failure stops at once; an administrator can send it again, never a sent one', { skip }, async () => {
  const j = await enqueue('attendance:9:bitrix', { channel: 'bitrix' });
  await claim(10, j.id);
  assert.equal((await result(j.id, 1, false, 'no_group', true)).status, 'dead');
  const again = json((await svc(`select public.ws_delivery_retry($1) r`, [j.id]))[0].r);
  assert.equal(again.status, 'pending');
  assert.ok(again.max_attempts >= 4);
  await assert.rejects(svc(`select public.ws_delivery_retry($1)`, [j.id]), /Already waiting/);
  const [c] = await claim(10, j.id);
  assert.equal((await result(j.id, c.attempts, true)).status, 'sent');
  await assert.rejects(svc(`select public.ws_delivery_retry($1)`, [j.id]), /Already delivered/);
  await due(j.id);
  assert.equal((await claim(10, j.id)).length, 0, 'sent means sent');
});

test('a first attempt that already failed is recorded; a permanent one is queued as dead', { skip }, async () => {
  const t = await enqueue('attendance:10:email', { attempts: 1, error: 'smtp_send_failed: connection reset' });
  assert.deepEqual([t.status, t.attempts], ['failed', 1]);
  const d = await enqueue('attendance:11:email', { attempts: 1, error: 'no_recipient: no email', dead: true });
  assert.equal(d.status, 'dead');
});

test('late answers: a stale failure is ignored, a success always wins; an abandoned attempt comes back', { skip }, async () => {
  const j = await enqueue('attendance:12:email');
  await claim(10, j.id);
  // The sender went quiet: its lease runs out and another run takes the job.
  await svc(`update delivery_jobs set locked_until = now() - interval '1 second' where id = $1`, [j.id]);
  const [again] = await claim(10, j.id);
  assert.equal(again.attempts, 2, 'claimed again after the lease');
  assert.equal((await result(j.id, 1, false, 'late timeout')).stale, true, 'the first attempt\'s failure no longer counts');
  assert.equal((await job(j.id)).status, 'sending');
  assert.equal((await result(j.id, 1, true)).status, 'sent', 'but its success does: the message went out');
  assert.equal((await result(j.id, 2, false, 'x')).stale, true);
  assert.equal((await job(j.id)).status, 'sent');
});

test('a message too old to be useful is not sent late', { skip }, async () => {
  const j = await enqueue('attendance:13:bitrix', { channel: 'bitrix', expires: new Date(Date.now() + 1000).toISOString() });
  await svc(`update delivery_jobs set expires_at = now() - interval '1 second' where id = $1`, [j.id]);
  assert.equal((await claim(10, j.id)).length, 0);
  const row = await job(j.id);
  assert.equal(row.status, 'dead');
  assert.match(row.last_error, /expired/);
});

test('counts per channel and status for the console', { skip }, async () => {
  const c = json((await svc(`select public.ws_delivery_counts() c`))[0].c);
  assert.ok(c.email && c.email.dead >= 1 && c.bitrix && c.bitrix.sent >= 1, JSON.stringify(c));
});

test('nobody signed in or anonymous can read the queue or call its functions', { skip }, async () => {
  await assert.rejects(as(db, U, () => db.query(`select * from delivery_jobs`)), /permission denied/);
  await assert.rejects(as(db, U, () => db.query(`select public.ws_delivery_enqueue('x:1:email', 'email', 'k', '{}'::jsonb)`)), /permission denied/);
  await assert.rejects(as(db, U, () => db.query(`select * from public.ws_delivery_claim(10)`)), /permission denied/);
  await assert.rejects(as(db, U, () => db.query(`select public.ws_delivery_counts()`)), /permission denied/);
  await db.exec('set role anon');
  try { await assert.rejects(db.query(`select * from delivery_jobs`), /permission denied/); }
  finally { await db.exec('reset role'); }
});
