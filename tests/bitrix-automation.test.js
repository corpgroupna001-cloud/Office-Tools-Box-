const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduledJobs, queueScheduled } = require('../lib/bitrix-automation');

const day = { id: 1, start_time: '09:00:00', end_time: '18:00:00', working_days: [1, 2, 3, 4, 5] };
const night = { id: 2, start_time: '18:00:00', end_time: '03:00:00', working_days: [1, 2, 3, 4, 5] };
const person = { id: 'p', full_name: 'Test Person', status: 'active', employee_code: '102', company: 'A', shift_id: 1 };
const target = { company: 'A', enabled: true, dialog_id: 'chat1', punch_enabled: true, auto_login: true, auto_logout: true };
const input = { profiles: [person], shifts: [day, night], targets: [target], holidays: [], leaves: [], now: '2026-10-02T09:05:00+05:30' };
const jobs = extra => scheduledJobs({ ...input, ...extra });

test('shift starts and ends queue separate labeled notices, without attendance writes', () => {
  assert.equal(jobs({ now: '2026-10-02T08:59:00+05:30' }).length, 0);
  const [login] = jobs();
  assert.equal(login.kind, 'scheduled_login');
  assert.match(login.payload.message, /scheduled shift start/);
  assert.equal(login.source_table, 'profiles');
  assert.equal(login.expires_at, '2026-10-02T04:30:00.000Z');
  const [logout] = jobs({ now: '2026-10-02T18:05:00+05:30' });
  assert.equal(logout.kind, 'scheduled_logout');
  assert.notEqual(login.key, logout.key);
  assert.equal(jobs({ now: '2026-10-02T10:00:00+05:30' }).length, 0, 'missed old notices are not replayed');
  assert.equal(jobs({ shifts: [{ ...day, start_time: '09:03:00' }] })[0].key, login.key, 'editing a sent shift does not queue it twice');
});

test('overnight logout belongs to its shift start day, including Friday into Saturday', () => {
  const [out] = jobs({ profiles: [{ ...person, shift_id: 2 }], now: '2026-10-03T03:05:00+05:30' });
  assert.equal(out.kind, 'scheduled_logout');
  assert.match(out.key, /2026-10-02:1:logout$/);
  assert.equal(jobs({ now: '2026-10-03T09:05:00+05:30' }).length, 0, 'weekend start is skipped');
});

test('second company shifts route to their own group and have independent keys', () => {
  const out = jobs({ profiles: [{ ...person, shift2_id: 2, company2: 'B' }],
    targets: [target, { ...target, company: 'B', dialog_id: 'chat2' }], now: '2026-10-02T18:05:00+05:30' });
  assert.deepEqual(out.map(x => [x.company, x.kind]), [['A', 'scheduled_logout'], ['B', 'scheduled_login']]);
  assert.notEqual(out[0].key, out[1].key);
});

test('inactive staff, approved leave, holidays and paused settings never schedule messages', () => {
  for (const status of ['inactive', 'pending']) assert.equal(jobs({ profiles: [{ ...person, status }] }).length, 0);
  assert.equal(jobs({ profiles: [{ ...person, employee_code: null }] }).length, 0);
  for (const change of [{ enabled: false }, { dialog_id: null }, { auto_login: false }]) {
    assert.equal(jobs({ targets: [{ ...target, ...change }] }).length, 0);
  }
  assert.equal(jobs({ holidays: [{ holiday_date: '2026-10-02', company: null }] }).length, 0);
  const leave = { user_id: 'p', start_date: '2026-10-01', end_date: '2026-10-03', status: 'approved' };
  assert.equal(jobs({ leaves: [leave] }).length, 0);
  assert.equal(jobs({ leaves: [{ ...leave, status: 'pending' }] }).length, 1);
  assert.equal(jobs({ targets: [{ ...target, punch_enabled: false }] }).length, 1, 'punch controls are independent');
});

test('queueing fails closed on incomplete schedule data and does nothing before opt-in', async () => {
  let reads = 0, enqueues = 0;
  const sb = async () => { reads++; return new Response('{}', { status: 503 }); };
  const db = { request: async () => { enqueues++; throw new Error('unexpected enqueue'); } };
  const off = await queueScheduled({ sb, db, targets: [{ ...target, auto_login: false, auto_logout: false }] });
  assert.equal(reads, 0);
  assert.equal(off.queued, 0);
  const failed = await queueScheduled({ sb, db, targets: [target], now: Date.parse(input.now) });
  assert.equal(failed.queued, 0);
  assert.equal(enqueues, 0);
  assert.match(failed.notes.join(' '), /could not be read/);
});
