// lib/delivery.js against a stand-in for the queue's database functions and
// mocked transports: nothing is ever really sent (F-06).
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/delivery');

/** The queue functions of migration 24, in memory, behind fetch. */
function fakeQueue({ missing = false } = {}) {
  const jobs = [], calls = [];
  let n = 0;
  const request = async (url, init) => {
    const fn = String(url).split('/rpc/')[1], a = JSON.parse(init.body);
    calls.push({ fn, a });
    const reply = (data, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(data) });
    if (missing) return reply({ code: 'PGRST202', message: 'Could not find the function' }, 404);
    if (fn === 'ws_delivery_enqueue') {
      const old = jobs.find(j => j.idempotency_key === a.p_key);
      if (old) return reply({ ...old, created: false });
      const j = { id: 'j' + (++n), idempotency_key: a.p_key, channel: a.p_channel, payload: a.p_payload, attempts: a.p_attempts,
        status: a.p_dead ? 'dead' : a.p_attempts ? 'failed' : 'pending', last_error: a.p_error, due: !a.p_attempts };
      jobs.push(j);
      return reply({ ...j, created: true });
    }
    if (fn === 'ws_delivery_claim') {
      const due = jobs.filter(j => (j.status === 'pending' || j.status === 'failed') && j.due && (!a.p_id || j.id === a.p_id)).slice(0, a.p_limit);
      due.forEach(j => { j.status = 'sending'; j.attempts++; j.due = false; });
      return reply(due.map(j => ({ ...j })));
    }
    if (fn === 'ws_delivery_result') {
      const j = jobs.find(x => x.id === a.p_id);
      j.status = a.p_ok ? 'sent' : a.p_permanent || j.attempts >= 5 ? 'dead' : 'failed';
      j.last_error = a.p_error;
      return reply({ ...j });
    }
    throw new Error(fn);
  };
  return { jobs, calls, db: { url: 'https://db.test', key: 'service', request } };
}

test('classify: what is worth sending again, per channel', () => {
  const t = (ch, out) => D.classify(ch, out).permanent;
  assert.equal(D.classify('email', { ok: true }).ok, true);
  assert.equal(t('email', { ok: false, reason: 'smtp_send_failed', detail: 'Connection timeout' }), false);
  assert.equal(t('email', { ok: false, reason: 'smtp_send_failed', detail: '421 4.7.0 Try again later' }), false);
  assert.equal(t('email', { ok: false, reason: 'smtp_send_failed', detail: '550 5.1.1 User unknown' }), true);
  assert.equal(t('email', { ok: false, reason: 'no_recipient' }), true);
  assert.equal(t('email', { ok: false, reason: 'smtp_not_configured' }), true);
  assert.equal(t('bitrix', { ok: false, reason: 'timeout' }), false);
  assert.equal(t('bitrix', { ok: false, reason: 'http_503' }), false);
  assert.equal(t('bitrix', { ok: false, reason: 'QUERY_LIMIT_EXCEEDED' }), false);
  assert.equal(D.classify('bitrix', { ok: false, reason: 'no_group' }).ok, true, 'no group: nothing to deliver to');
  assert.equal(t('bitrix', { ok: false, reason: 'ACCESS_DENIED' }), true);
  assert.equal(t('push', { ok: false, reason: 'push_failed', statusCode: 503 }), false);
  assert.equal(t('push', { ok: false, reason: 'push_failed', statusCode: 410 }), true);
  assert.match(D.classify('email', { ok: false, reason: 'smtp_send_failed', detail: 'x' }).error, /^smtp_send_failed: x$/);
});

test('a first attempt that worked queues nothing; one that failed is queued with its error', async () => {
  const q = fakeQueue();
  const job = { key: 'attendance:1:email', channel: 'email', kind: 'attendance.punch', payload: { to: 'e@x.test' } };
  assert.deepEqual(await D.recordFirstAttempt(q.db, job, { ok: true }), { ok: true, queued: false });
  assert.equal(q.calls.length, 0);
  const r = await D.recordFirstAttempt(q.db, job, { ok: false, reason: 'smtp_send_failed', detail: 'timeout' });
  assert.equal(r.queued, true);
  assert.deepEqual([q.jobs[0].status, q.jobs[0].attempts, q.jobs[0].last_error], ['failed', 1, 'smtp_send_failed: timeout']);
  const p = await D.recordFirstAttempt(q.db, { ...job, key: 'attendance:2:email' }, { ok: false, reason: 'no_recipient', detail: 'none' });
  assert.equal(p.permanent, true);
  assert.equal(q.jobs[1].status, 'dead', 'kept for review, not retried');
});

test('the same message queued twice is one job', async () => {
  const q = fakeQueue();
  const job = { key: 'attendance:5:bitrix', channel: 'bitrix', kind: 'attendance.punch', payload: { message: 'Login 9:30' } };
  const a = await D.enqueue(q.db, job), b = await D.enqueue(q.db, job);
  assert.deepEqual([a.created, b.created, q.jobs.length], [true, false, 1]);
});

test('one channel failing does not hold up another; each outcome is written back', async () => {
  const q = fakeQueue();
  await D.enqueue(q.db, { key: 'a:1:email', channel: 'email', kind: 'k', payload: { to: 'e@x.test' } });
  await D.enqueue(q.db, { key: 'a:1:bitrix', channel: 'bitrix', kind: 'k', payload: { message: 'hi' } });
  await D.enqueue(q.db, { key: 'a:1:push', channel: 'push', kind: 'k', payload: { title: 't' } });
  const sent = { email: 0, bitrix: 0, push: 0 }, written = [];
  const report = await D.runDue(q.db, {
    email: async () => { sent.email++; return { ok: false, reason: 'smtp_send_failed', detail: 'Greeting never received' }; },
    bitrix: async () => { sent.bitrix++; return { ok: true }; },
    push: async () => { sent.push++; throw new Error('socket hang up'); },
  }, { onResult: (job, o) => { written.push([job.channel, o.status]); } });
  assert.deepEqual(sent, { email: 1, bitrix: 1, push: 1 });
  assert.deepEqual(Object.fromEntries(q.jobs.map(j => [j.channel, j.status])), { email: 'failed', bitrix: 'sent', push: 'failed' });
  assert.deepEqual(written.sort(), [['bitrix', 'sent'], ['email', 'failed'], ['push', 'failed']]);
  assert.deepEqual([report.claimed, report.sent, report.failed], [3, 1, 2]);
});

test('a channel nobody can send here is a permanent failure, not a loop', async () => {
  const q = fakeQueue();
  await D.enqueue(q.db, { key: 'a:2:push', channel: 'push', kind: 'k', payload: {} });
  const r = await D.runDue(q.db, {});
  assert.equal(r.dead, 1);
  assert.match(q.jobs[0].last_error, /no_transport/);
});

test('the time budget is respected, and a queue that is not installed is reported, not guessed', async () => {
  const q = fakeQueue();
  for (let i = 0; i < 10; i++) await D.enqueue(q.db, { key: `a:${i}:email`, channel: 'email', kind: 'k', payload: {} });
  let clock = 0;
  const r = await D.runDue(q.db, { email: async () => { clock += 6000; return { ok: true }; } }, { batch: 2, deadlineAt: 10000, now: () => clock });
  assert.equal(r.stopped_at_budget, true);
  assert.ok(r.claimed < 10 && r.sent === r.claimed, JSON.stringify(r));
  const m = await D.runDue(fakeQueue({ missing: true }).db, { email: async () => ({ ok: true }) });
  assert.deepEqual([m.available, m.missing, m.claimed], [false, true, 0]);
});

test('deliverNow sends a message once, however often it is asked', async () => {
  const q = fakeQueue();
  let posts = 0;
  const job = { key: 'leave:42:filed', channel: 'bitrix', kind: 'attendance.leave', payload: { message: 'Leave filed' } };
  const send = async p => { posts++; assert.equal(p.message, 'Leave filed'); return { ok: true }; };
  const a = await D.deliverNow(q.db, job, send);
  const b = await D.deliverNow(q.db, job, send);
  assert.deepEqual([a.sent, b.duplicate, posts, q.jobs[0].status], [true, true, 1, 'sent']);
  const m = await D.deliverNow(fakeQueue({ missing: true }).db, job, send);
  assert.equal(m.missing, true);
  assert.equal(posts, 1, 'the caller decides what to do before migration 24');
});
