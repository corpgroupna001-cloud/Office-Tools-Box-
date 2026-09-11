// The cron side of CRM reminders: generate, push once, mark, clean up.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runAndPush, PUSH_KINDS } = require('../lib/crm-reminders');

const URL_BASE = 'https://db.example.test';
const VAPID = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:test@example.test' };
const NOW = Date.parse('2026-09-11T04:00:00Z');   // 09:30 IST

function backend({ rpcStatus = 200, queue = [], subs = [] } = {}) {
  const calls = [];
  const request = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ method, url, body: options.body ? JSON.parse(options.body) : null });
    const path = url.slice(URL_BASE.length);
    if (path.startsWith('/rest/v1/rpc/crm_run_reminders')) return new Response(JSON.stringify({ tasks: 1 }), { status: rpcStatus });
    if (path.startsWith('/rest/v1/notifications') && method === 'GET') return new Response(JSON.stringify(queue), { status: 200 });
    if (path.startsWith('/rest/v1/push_subscriptions') && method === 'GET') return new Response(JSON.stringify(subs), { status: 200 });
    return new Response(null, { status: 204 });
  };
  return { request, calls, of: (method, frag) => calls.filter(c => c.method === method && c.url.includes(frag)) };
}
function fakePush(fail = {}) {
  const sent = [];
  return { sent, setVapidDetails() {}, async sendNotification(sub, payload) {
    if (fail[sub.endpoint]) { const e = new Error('gone'); e.statusCode = fail[sub.endpoint]; throw e; }
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  } };
}

test('reminders are generated, pushed once to every device, and marked as pushed', async () => {
  const b = backend({
    queue: [{ id: 'n1', user_id: 'u1', kind: 'task.reminder', title: 'Reminder: call Acme', body: 'Due 11 Sep 2026', url: '/tasks/?id=t1' }],
    subs: [{ user_id: 'u1', endpoint: 'https://push/a', p256dh: 'k', auth: 'a' }, { user_id: 'u1', endpoint: 'https://push/b', p256dh: 'k', auth: 'a' }],
  });
  const wp = fakePush();
  const out = await runAndPush({ url: URL_BASE, key: 'svc', webpush: wp, vapid: VAPID, request: b.request, now: NOW });
  assert.deepEqual(out.generated, { tasks: 1 });
  assert.equal(out.queued, 1); assert.equal(out.pushed, 1);
  assert.equal(wp.sent.length, 2, 'both of the person’s devices');
  assert.deepEqual(wp.sent[0].payload, { title: 'Reminder: call Acme', body: 'Due 11 Sep 2026', url: '/tasks/?id=t1', tag: 'task.reminder' });
  const mark = b.of('PATCH', '/rest/v1/notifications');
  assert.equal(mark.length, 1);
  assert.match(mark[0].url, /id=in\.\(n1\)/);
  assert.equal(mark[0].body.pushed_at, new Date(NOW).toISOString());
});

test('only reminder kinds from the last day are taken from the queue', async () => {
  const b = backend();
  await runAndPush({ url: URL_BASE, key: 'svc', webpush: fakePush(), vapid: VAPID, request: b.request, now: NOW });
  const q = b.of('GET', '/rest/v1/notifications')[0].url;
  assert.match(q, /pushed_at=is\.null/);
  assert.ok(q.includes(`kind=in.(${PUSH_KINDS.join(',')})`));
  assert.ok(!PUSH_KINDS.includes('task.assigned'), 'assignment pushes come from the acting browser, not here');
  assert.ok(q.includes(encodeURIComponent(new Date(NOW - 24 * 3600 * 1000).toISOString())));
});

test('a person without a device is still marked, so the job never retries them forever', async () => {
  const b = backend({ queue: [{ id: 'n2', user_id: 'nobody', kind: 'task.digest', title: '2 tasks due today' }] });
  const out = await runAndPush({ url: URL_BASE, key: 'svc', webpush: fakePush(), vapid: VAPID, request: b.request, now: NOW });
  assert.equal(out.noSubscription, 1); assert.equal(out.pushed, 0);
  assert.equal(b.of('PATCH', '/rest/v1/notifications').length, 1);
});

test('expired browser subscriptions are deleted, like /api/push does', async () => {
  const b = backend({
    queue: [{ id: 'n3', user_id: 'u1', kind: 'event.reminder', title: 'At 3:00 pm: Review' }],
    subs: [{ user_id: 'u1', endpoint: 'https://push/old', p256dh: 'k', auth: 'a' }, { user_id: 'u1', endpoint: 'https://push/new', p256dh: 'k', auth: 'a' }],
  });
  const out = await runAndPush({ url: URL_BASE, key: 'svc', webpush: fakePush({ 'https://push/old': 410 }), vapid: VAPID, request: b.request, now: NOW });
  assert.equal(out.pushed, 1); assert.equal(out.cleaned, 1);
  const del = b.of('DELETE', '/rest/v1/push_subscriptions');
  assert.equal(del.length, 1);
  assert.ok(del[0].url.includes(encodeURIComponent('https://push/old')));
});

test('without VAPID keys reminders are still generated but nothing is pushed or marked', async () => {
  const b = backend({ queue: [{ id: 'n4', user_id: 'u1', kind: 'task.reminder', title: 'x' }] });
  const out = await runAndPush({ url: URL_BASE, key: 'svc', webpush: fakePush(), vapid: {}, request: b.request, now: NOW });
  assert.equal(out.skipped_push, 'no_vapid');
  assert.equal(b.of('POST', '/rpc/crm_run_reminders').length, 1);
  assert.equal(b.of('PATCH', '/rest/v1/notifications').length, 0);
});

test('a database without the reminders migration is skipped quietly', async () => {
  const b = backend({ rpcStatus: 404 });
  const out = await runAndPush({ url: URL_BASE, key: 'svc', webpush: fakePush(), vapid: VAPID, request: b.request, now: NOW });
  assert.deepEqual(out, { skipped: 'crm_reminders_not_installed' });
  assert.equal(b.calls.length, 1);
});

test('a network failure is reported, never thrown into the cron', async () => {
  const out = await runAndPush({ url: URL_BASE, key: 'svc', webpush: fakePush(), vapid: VAPID, request: async () => { throw new Error('socket hang up'); }, now: NOW });
  assert.equal(out.error, 'socket hang up');
});
