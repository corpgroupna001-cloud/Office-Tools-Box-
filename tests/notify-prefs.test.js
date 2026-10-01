// lib/notify-prefs.js — notification settings applied at delivery (F-03).
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../lib/notify-prefs');

const at = iso => new Date(iso);                // all times below are UTC
const quiet = (start, end, tz = 'Asia/Kolkata') => ({ push_enabled: true, muted_categories: [], quiet_enabled: true, quiet_start: start, quiet_end: end, timezone: tz });

test('no settings saved: every push goes, as before', () => {
  for (const k of ['message', 'call', 'task.assigned', 'deal.assigned', 'task.reminder', 'anything']) assert.deepEqual(N.pushDecision(undefined, k), { allowed: true });
});

test('categories', () => {
  assert.equal(N.categoryOf('message'), 'messages');
  assert.equal(N.categoryOf('mention'), 'messages');
  assert.equal(N.categoryOf('task.assigned'), 'tasks');
  assert.equal(N.categoryOf('task'), 'tasks');
  assert.equal(N.categoryOf('task.reminder'), 'reminders');
  assert.equal(N.categoryOf('lead.follow_up'), 'reminders');
  assert.equal(N.categoryOf('deal.assigned'), 'crm');
  assert.equal(N.categoryOf('invoice.paid'), 'crm');
  assert.equal(N.categoryOf('event.invited'), 'calendar');
  assert.equal(N.categoryOf('project.added'), 'projects');
  assert.equal(N.categoryOf('document'), 'documents');
  assert.equal(N.categoryOf('call'), 'calls');
  assert.equal(N.categoryOf('feed.comment'), 'other');
});

test("quiet hours across midnight, in the person's own time zone", () => {
  const p = quiet('22:00', '07:00');                         // India time
  assert.equal(N.inQuietHours(p, at('2026-10-01T16:29:00Z')), false, '21:59 IST');
  assert.equal(N.inQuietHours(p, at('2026-10-01T16:30:00Z')), true, '22:00 IST');
  assert.equal(N.inQuietHours(p, at('2026-10-01T20:00:00Z')), true, '01:30 IST');
  assert.equal(N.inQuietHours(p, at('2026-10-02T01:29:00Z')), true, '06:59 IST');
  assert.equal(N.inQuietHours(p, at('2026-10-02T01:30:00Z')), false, '07:00 IST');
  const ny = quiet('22:00', '07:00', 'America/New_York');    // the same instant is 18:00 there
  assert.equal(N.inQuietHours(ny, at('2026-10-01T22:00:00Z')), false);
  assert.equal(N.inQuietHours(ny, at('2026-10-02T03:00:00Z')), true, '23:00 in New York');
  assert.equal(N.inQuietHours(quiet('09:00', '17:00'), at('2026-10-01T06:00:00Z')), true, 'a daytime window, 11:30 IST');
  assert.equal(N.inQuietHours(quiet('09:00', '09:00'), at('2026-10-01T03:40:00Z')), false, 'start = end is no quiet time');
  assert.equal(N.inQuietHours({ ...p, quiet_enabled: false }, at('2026-10-01T20:00:00Z')), false);
  assert.equal(N.inQuietHours(quiet('22:00', '07:00', 'Not/AZone'), at('2026-10-01T20:00:00Z')), true, 'an unknown zone falls back to India time');
});

test('decisions: off, muted, quiet (to retry), calls policy, call-end always', () => {
  const night = at('2026-10-01T20:00:00Z');
  const p = { ...quiet('22:00', '07:00'), muted_categories: ['crm'] };
  assert.deepEqual(N.pushDecision(p, 'deal.assigned', at('2026-10-01T06:00:00Z')), { allowed: false, reason: 'muted', retry: false });
  assert.deepEqual(N.pushDecision(p, 'message', night), { allowed: false, reason: 'quiet', retry: true });
  assert.deepEqual(N.pushDecision(p, 'call', night), { allowed: true }, 'calls ring in quiet hours by default');
  assert.deepEqual(N.pushDecision({ ...p, calls_in_quiet: false }, 'call', night), { allowed: false, reason: 'quiet', retry: true });
  assert.deepEqual(N.pushDecision({ ...p, muted_categories: ['messages', 'tasks', 'crm', 'calendar', 'projects', 'documents', 'reminders', 'other'] }, 'call', at('2026-10-01T06:00:00Z')), { allowed: true }, 'calls are not a mutable category');
  assert.deepEqual(N.pushDecision({ ...p, push_enabled: false }, 'call', at('2026-10-01T06:00:00Z')), { allowed: false, reason: 'off', retry: false });
  assert.deepEqual(N.pushDecision({ ...p, push_enabled: false }, 'call-end', night), { allowed: true }, 'clearing a ringing notification');
});
