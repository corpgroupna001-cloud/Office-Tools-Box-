// IN/OUT by shift time. The reader sends a bare timestamp; lib/attendance
// assignDays decides the attendance day, IN/OUT and Login/Break/Logout from
// the person's shift. Each scenario is checked twice: the labels a punch gets
// the moment it arrives (what the group and the email say), and the labels
// once the whole day is in (what the calendar and pay sheet use).
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/attendance');

const GENERAL = { id: 9, name: 'General', start_time: '09:30:00', end_time: '18:30:00', grace_minutes: 10, early_out_grace_minutes: 10, working_days: [1, 2, 3, 4, 5, 6], is_default: true };
const NOVA = { name: 'Nova', start_time: '09:00:00', end_time: '18:00:00', grace_minutes: 10, early_out_grace_minutes: 10, working_days: [1, 2, 3, 4, 5, 6] };
const NIGHT = { name: 'Jobways', start_time: '18:00:00', end_time: '03:00:00', grace_minutes: 10, early_out_grace_minutes: 10, working_days: [1, 2, 3, 4, 5] };
const DAY10 = { id: 1, name: 'SportsMart 10-5', start_time: '10:00', end_time: '17:00', grace_minutes: 10, early_out_grace_minutes: 10, working_days: [1, 2, 3, 4, 5, 6] };
const EVE = { id: 2, name: 'Jobways Evening', start_time: '17:00', end_time: '19:00', grace_minutes: 10, early_out_grace_minutes: 10, working_days: [1, 2, 3, 4, 5] };

const shiftForOf = (s1, s2) => punch => (s2 ? A.effectiveShift(s1, s2, A.istIsoWeekday(new Date(punch.log_datetime))) : s1);
// 2026-09-14 is a Monday. "Mon 18:00" -> an IST instant.
const DAYS = { Sun: '2026-09-13', Mon: '2026-09-14', Tue: '2026-09-15', Wed: '2026-09-16', Thu: '2026-09-17', Fri: '2026-09-18', Sat: '2026-09-19' };
const at = s => { const [d, t] = s.split(' '); return new Date(`${DAYS[d]}T${t.length === 5 ? t + ':00' : t}+05:30`).toISOString(); };
const punch = (s, extra = {}) => ({ id: s, log_datetime: at(s), direction: 'UNKNOWN', ...extra });

/** Punches arriving one at a time, each re-deriving the lot, as the webhook does. */
function live(times, opts) {
  const stored = [];
  const posted = [];
  for (const s of times) {
    stored.push(punch(s));
    const out = A.assignDays(stored.map(p => ({ ...p })), opts);
    const me = out.find(r => r.id === s);
    posted.push(me.duplicate ? `${s} (repeat)` : `${s} ${me.event_type}`);
    // Keep what was stored, the way the webhook patches it back.
    out.forEach(r => { const row = stored.find(x => x.id === r.id); Object.assign(row, { direction: r.direction, direction_derived: r.direction_derived, log_date: r.log_date, event_type: r.event_type }); });
  }
  const final = A.assignDays(stored.map(p => ({ ...p })), opts);
  return { posted, final: final.map(r => `${r.id} ${r.log_date.slice(5)} ${r.event_type}${r.duplicate ? ' dup' : ''}${r.missing_login ? ' missing-login' : ''}`) };
}

test('a night shift with no break punches is one day: the 3 AM punch is the Logout', () => {
  const r = live(['Mon 17:55', 'Tue 03:02', 'Tue 17:56', 'Wed 03:01', 'Wed 17:58', 'Thu 03:04'], { shiftFor: shiftForOf(NIGHT) });
  assert.deepEqual(r.posted, ['Mon 17:55 LOGIN', 'Tue 03:02 LOGOUT', 'Tue 17:56 LOGIN', 'Wed 03:01 LOGOUT', 'Wed 17:58 LOGIN', 'Thu 03:04 LOGOUT']);
  assert.deepEqual(r.final, ['Mon 17:55 09-14 LOGIN', 'Tue 03:02 09-14 LOGOUT', 'Tue 17:56 09-15 LOGIN', 'Wed 03:01 09-15 LOGOUT', 'Wed 17:58 09-16 LOGIN', 'Thu 03:04 09-16 LOGOUT']);
});

test('a night shift with breaks, and the next evening starting a new day', () => {
  const r = live(['Mon 17:55', 'Mon 22:00', 'Mon 22:30', 'Tue 03:02', 'Tue 17:55'], { shiftFor: shiftForOf(NIGHT) });
  assert.deepEqual(r.final, ['Mon 17:55 09-14 LOGIN', 'Mon 22:00 09-14 BREAK_OUT', 'Mon 22:30 09-14 BREAK_IN', 'Tue 03:02 09-14 LOGOUT', 'Tue 17:55 09-15 LOGIN']);
  assert.equal(r.posted[3], 'Tue 03:02 LOGOUT');
});

test('arriving after midnight for a night shift belongs to the evening before', () => {
  const r = live(['Tue 00:20', 'Tue 03:05', 'Tue 17:55', 'Tue 22:00', 'Tue 22:30', 'Wed 03:02'], { shiftFor: shiftForOf(NIGHT) });
  assert.deepEqual(r.final, ['Tue 00:20 09-14 LOGIN', 'Tue 03:05 09-14 LOGOUT', 'Tue 17:55 09-15 LOGIN',
    'Tue 22:00 09-15 BREAK_OUT', 'Tue 22:30 09-15 BREAK_IN', 'Wed 03:02 09-15 LOGOUT']);
  const end = A.shiftEndAt('2026-09-14', NIGHT);
  assert.equal(end.toISOString(), at('Tue 03:00'));
});

test('a night with only the punch-out is that night\'s Logout, and the next night reads normally', () => {
  const r = live(['Tue 18:01', 'Tue 22:00', 'Tue 22:30', 'Wed 03:01', 'Thu 03:02', 'Thu 18:02', 'Thu 22:00', 'Thu 22:30', 'Fri 03:03'], { shiftFor: shiftForOf(NIGHT) });
  assert.deepEqual(r.final, ['Tue 18:01 09-15 LOGIN', 'Tue 22:00 09-15 BREAK_OUT', 'Tue 22:30 09-15 BREAK_IN', 'Wed 03:01 09-15 LOGOUT',
    'Thu 03:02 09-16 LOGOUT missing-login',
    'Thu 18:02 09-17 LOGIN', 'Thu 22:00 09-17 BREAK_OUT', 'Thu 22:30 09-17 BREAK_IN', 'Fri 03:03 09-17 LOGOUT']);
});

test('a punch at the shift end is the Logout even after a missed punch', () => {
  const opts = { shiftFor: shiftForOf(NOVA) };
  // Return from the break not punched.
  assert.deepEqual(live(['Mon 09:00', 'Mon 13:00', 'Mon 18:00'], opts).posted, ['Mon 09:00 LOGIN', 'Mon 13:00 BREAK_OUT', 'Mon 18:00 LOGOUT']);
  assert.deepEqual(live(['Mon 09:00', 'Mon 13:00', 'Mon 18:07'], opts).posted, ['Mon 09:00 LOGIN', 'Mon 13:00 BREAK_OUT', 'Mon 18:07 LOGOUT']);
  // Morning punch missed.
  assert.deepEqual(live(['Mon 13:00', 'Mon 14:00', 'Mon 18:00'], opts).final, ['Mon 13:00 09-14 LOGIN', 'Mon 14:00 09-14 BREAK_OUT', 'Mon 18:00 09-14 LOGOUT']);
  // Only the punch-out: a Logout with the login missing, not a 9-hour-late Login.
  assert.deepEqual(live(['Mon 18:05'], opts).final, ['Mon 18:05 09-14 LOGOUT missing-login']);
  assert.deepEqual(live(['Mon 17:58'], opts).final, ['Mon 17:58 09-14 LOGOUT missing-login']);
});

test('a real break across the shift end still reads as a break, then the Logout', () => {
  const opts = { shiftFor: shiftForOf(NOVA) };
  assert.deepEqual(live(['Mon 09:00', 'Mon 17:00', 'Mon 18:15', 'Mon 20:00'], opts).final,
    ['Mon 09:00 09-14 LOGIN', 'Mon 17:00 09-14 BREAK_OUT', 'Mon 18:15 09-14 BREAK_IN', 'Mon 20:00 09-14 LOGOUT']);
  assert.deepEqual(live(['Mon 09:00', 'Mon 13:00', 'Mon 14:00', 'Mon 21:30', 'Mon 21:45', 'Mon 22:40'], opts).final,
    ['Mon 09:00 09-14 LOGIN', 'Mon 13:00 09-14 BREAK_OUT', 'Mon 14:00 09-14 BREAK_IN', 'Mon 21:30 09-14 BREAK_OUT', 'Mon 21:45 09-14 BREAK_IN', 'Mon 22:40 09-14 LOGOUT']);
  // A break missed in the day and one taken in overtime.
  assert.deepEqual(live(['Mon 09:00', 'Mon 13:00', 'Mon 21:30', 'Mon 21:45', 'Mon 22:40'], opts).final,
    ['Mon 09:00 09-14 LOGIN', 'Mon 13:00 09-14 BREAK_OUT', 'Mon 21:30 09-14 BREAK_OUT', 'Mon 21:45 09-14 BREAK_IN', 'Mon 22:40 09-14 LOGOUT']);
});

test('a double tap is one punch and does not flip the day', () => {
  const opts = { shiftFor: shiftForOf(NOVA) };
  const d = live(['Mon 09:00:00', 'Mon 09:00:04', 'Mon 13:00', 'Mon 14:00', 'Mon 18:00'], opts);
  assert.deepEqual(d.posted, ['Mon 09:00:00 LOGIN', 'Mon 09:00:04 (repeat)', 'Mon 13:00 BREAK_OUT', 'Mon 14:00 BREAK_IN', 'Mon 18:00 LOGOUT']);
  assert.deepEqual(d.final, ['Mon 09:00:00 09-14 LOGIN', 'Mon 09:00:04 09-14 LOGIN dup', 'Mon 13:00 09-14 BREAK_OUT', 'Mon 14:00 09-14 BREAK_IN', 'Mon 18:00 09-14 LOGOUT']);
  const e = live(['Mon 09:00', 'Mon 13:00', 'Mon 14:00', 'Mon 18:00:00', 'Mon 18:00:06'], opts);
  assert.deepEqual(e.final.slice(3), ['Mon 18:00:00 09-14 LOGOUT', 'Mon 18:00:06 09-14 LOGOUT dup']);
  // A double-tapped login and nothing else still gets its automatic logout.
  const only = A.assignDays([punch('Mon 09:00:00'), punch('Mon 09:00:30')], opts);
  assert.deepEqual(A.autoLogoutFor({ date: '2026-09-14', shift: NOVA, punches: only, now: at('Mon 19:00') }).kind, 'no_punch_out');
});

test('arriving late, early, or staying late', () => {
  const nova = { shiftFor: shiftForOf(NOVA) };
  assert.deepEqual(live(['Mon 14:30', 'Mon 18:00'], nova).posted, ['Mon 14:30 LOGIN', 'Mon 18:00 LOGOUT']);
  assert.deepEqual(live(['Mon 08:15', 'Mon 13:00', 'Mon 14:00', 'Mon 18:02'], nova).final.map(x => x.split(' ').pop()), ['LOGIN', 'BREAK_OUT', 'BREAK_IN', 'LOGOUT']);
  // Overtime to 22:30, back at 9 next morning: a new day.
  assert.deepEqual(live(['Mon 09:00', 'Mon 13:00', 'Mon 14:00', 'Mon 22:30', 'Tue 09:00'], nova).final.slice(3),
    ['Mon 22:30 09-14 LOGOUT', 'Tue 09:00 09-15 LOGIN']);
  const night = { shiftFor: shiftForOf(NIGHT) };
  assert.deepEqual(live(['Mon 23:30', 'Tue 03:01'], night).posted, ['Mon 23:30 LOGIN', 'Tue 03:01 LOGOUT']);
  // In at 13:30 for an 18:00 start, after the night before.
  assert.deepEqual(live(['Mon 18:00', 'Tue 03:02', 'Tue 13:30', 'Tue 22:00', 'Tue 22:30', 'Wed 03:00'], night).final,
    ['Mon 18:00 09-14 LOGIN', 'Tue 03:02 09-14 LOGOUT', 'Tue 13:30 09-15 LOGIN', 'Tue 22:00 09-15 BREAK_OUT', 'Tue 22:30 09-15 BREAK_IN', 'Wed 03:00 09-15 LOGOUT']);
  // Night overtime to 06:30, back that evening.
  assert.deepEqual(live(['Mon 18:00', 'Mon 22:30', 'Mon 23:00', 'Tue 06:30', 'Tue 18:00'], night).final.slice(3),
    ['Tue 06:30 09-14 LOGOUT', 'Tue 18:00 09-15 LOGIN']);
});

test('dual shifts: one merged day, the evening part alone, and Saturday', () => {
  const opts = { shiftFor: shiftForOf(DAY10, EVE) };
  assert.deepEqual(live(['Mon 09:58', 'Mon 13:00', 'Mon 13:40', 'Mon 19:02'], opts).posted, ['Mon 09:58 LOGIN', 'Mon 13:00 BREAK_OUT', 'Mon 13:40 BREAK_IN', 'Mon 19:02 LOGOUT']);
  assert.deepEqual(live(['Sat 09:58', 'Sat 17:03'], opts).posted, ['Sat 09:58 LOGIN', 'Sat 17:03 LOGOUT']);
  // Only the evening shift: judged from its own 17:00 start.
  assert.deepEqual(live(['Mon 17:04', 'Mon 19:01'], opts).posted, ['Mon 17:04 LOGIN', 'Mon 19:01 LOGOUT']);
  const day = A.classifyDay({ date: '2026-09-14', shift: DAY10, shift2: EVE, punches: A.assignDays([punch('Mon 17:04'), punch('Mon 19:01')], opts), today: '2026-09-15' });
  assert.equal(day.status, 'present');
  assert.equal(day.lateMinutes, 4);
  // A double tap at 09:58 no longer leaves them "not on site" at 17:00.
  const taps = A.assignDays([punch('Mon 09:58:00'), punch('Mon 09:58:05'), punch('Mon 13:00'), punch('Mon 13:40')], opts);
  assert.equal(taps[taps.length - 1].direction, 'IN');
});

test('without a shift, days are still cut by the gap between punches', () => {
  const r = live(['Mon 18:00', 'Mon 22:00', 'Mon 22:30', 'Tue 03:00', 'Tue 18:00'], { shiftFor: () => null });
  assert.deepEqual(r.final, ['Mon 18:00 09-14 LOGIN', 'Mon 22:00 09-14 BREAK_OUT', 'Mon 22:30 09-14 BREAK_IN', 'Tue 03:00 09-14 LOGOUT', 'Tue 18:00 09-15 LOGIN']);
  const none = live(['Mon 09:00', 'Mon 13:00', 'Mon 14:00', 'Mon 18:00'], {});
  assert.deepEqual(none.final.map(x => x.split(' ').pop()), ['LOGIN', 'BREAK_OUT', 'BREAK_IN', 'LOGOUT']);
});

test('a night worker left on the day shift still keeps one day while taking breaks', () => {
  const r = live(['Mon 18:00', 'Mon 22:00', 'Mon 22:30', 'Tue 03:00'], { shiftFor: shiftForOf(GENERAL) });
  assert.deepEqual(r.final, ['Mon 18:00 09-14 LOGIN', 'Mon 22:00 09-14 BREAK_OUT', 'Mon 22:30 09-14 BREAK_IN', 'Tue 03:00 09-14 LOGOUT']);
});

test('the same punches give the same days whether they arrive together, reversed, or from a window cut mid-week', () => {
  const opts = { shiftFor: shiftForOf(NIGHT) };
  const times = ['Mon 17:55', 'Mon 22:00', 'Mon 22:30', 'Tue 03:02', 'Tue 17:56', 'Wed 03:01', 'Wed 17:58', 'Wed 23:00', 'Wed 23:20', 'Thu 03:04'];
  const key = rows => rows.map(r => `${r.id} ${r.log_date} ${r.event_type}`);
  const batch = key(A.assignDays(times.map(t => punch(t)), opts));
  assert.deepEqual(key(A.assignDays(times.slice().reverse().map(t => punch(t)), opts)), batch);
  assert.deepEqual(live(times, opts).final.map(x => x.split(' ').pop()), batch.map(x => x.split(' ').pop()));
  // Starting the read at Tue 00:00 (a recompute from Tuesday) leaves Tuesday's own day as it was.
  const cut = key(A.assignDays(times.slice(3).map(t => punch(t)), opts));
  assert.deepEqual(cut.slice(1), batch.slice(4));
});

test('selfie punches keep their own event and land on the night they belong to', () => {
  const rows = A.assignDays([
    { id: 'a', log_datetime: at('Mon 18:00'), source: 'selfie', event_type: 'LOGIN', direction: 'IN' },
    { id: 'b', log_datetime: at('Tue 03:05'), source: 'selfie', event_type: 'LOGOUT', direction: 'OUT' },
  ], { shiftFor: shiftForOf(NIGHT) });
  assert.deepEqual(rows.map(r => [r.log_date, r.event_type]), [['2026-09-14', 'LOGIN'], ['2026-09-14', 'LOGOUT']]);
});

test('the calendar Out is the last punch only when it is an OUT, or the shift end once nobody closed the day', () => {
  const opts = { shiftFor: shiftForOf(GENERAL) };
  const punches = A.assignDays([punch('Tue 09:28'), punch('Tue 13:00'), punch('Tue 13:45')], opts);
  const midday = A.classifyDay({ date: '2026-09-15', shift: GENERAL, punches, today: '2026-09-15', now: at('Tue 15:00') });
  assert.equal(midday.lastOut, null);                     // back from the break: still on the clock
  assert.equal(midday.workedMinutes, null);
  const evening = A.classifyDay({ date: '2026-09-15', shift: GENERAL, punches, today: '2026-09-15', now: at('Tue 19:00') });
  assert.equal(evening.lastOut, at('Tue 18:30'));
  assert.equal(evening.autoLogout, true);
  // Only the logout punched: no In, not hours late.
  const lone = A.classifyDay({ date: '2026-09-14', shift: NOVA, punches: A.assignDays([punch('Mon 17:58')], { shiftFor: shiftForOf(NOVA) }), today: '2026-09-15' });
  assert.equal(lone.firstIn, null);
  assert.equal(lone.missingLogin, true);
  assert.equal(lone.status, 'present');
  assert.equal(lone.lastOut, at('Mon 17:58'));
});

test('a break started after the shift ended is overtime, not a missed return', () => {
  const opts = { shiftFor: shiftForOf(NOVA) };
  const rows = A.assignDays([punch('Mon 09:00'), punch('Mon 18:05'), punch('Mon 18:25')], opts);
  assert.equal(A.autoLogoutFor({ date: '2026-09-14', shift: NOVA, punches: rows.slice(0, 2), now: at('Mon 19:00') }), null);
  const before = A.assignDays([punch('Mon 09:00'), punch('Mon 16:30')], opts);
  assert.equal(A.autoLogoutFor({ date: '2026-09-14', shift: NOVA, punches: before, now: at('Mon 19:00') }).kind, 'break_not_returned');
});

test('shiftDayFor picks the window a punch falls in', () => {
  const onDate = () => NIGHT;
  assert.equal(A.shiftDayFor(Date.parse(at('Tue 10:29')), onDate).date, '2026-09-14');
  assert.equal(A.shiftDayFor(Date.parse(at('Tue 10:31')), onDate).date, '2026-09-15');
  const w = A.shiftWindow('2026-09-14', NOVA);
  assert.equal(new Date(w.from).toISOString(), at('Mon 01:30'));
  assert.equal(new Date(w.to).toISOString(), at('Tue 01:30'));
});

// ---- A wrong or changed shift must not move days that were worked ----
const JOBWAYS_DEFAULT = require('../company-config').resolveShift({ company: 'Jobways Point LLP' }, [GENERAL]);

test('a day worker left on the night-shift company default keeps calendar days', () => {
  const r = live(['Mon 09:28', 'Mon 13:00', 'Mon 13:45', 'Mon 18:32', 'Tue 09:31', 'Tue 13:40', 'Tue 18:30'], { shiftFor: () => JOBWAYS_DEFAULT });
  assert.deepEqual(r.final.map(x => x.split(' ').slice(2).join(' ')),
    ['09-14 LOGIN', '09-14 BREAK_OUT', '09-14 BREAK_IN', '09-14 LOGOUT', '09-15 LOGIN', '09-15 BREAK_OUT', '09-15 BREAK_IN']);
});

test('changing someone\'s shift does not re-date or relabel the days they already worked', () => {
  const days = ['Mon 09:00', 'Mon 13:00', 'Mon 13:40', 'Mon 18:02', 'Tue 09:05', 'Tue 13:00', 'Tue 13:40', 'Tue 18:05', 'Wed 09:01', 'Wed 13:00', 'Wed 13:40', 'Wed 18:01'];
  const key = rows => rows.map(r => `${r.id} ${r.log_date} ${r.event_type}`);
  // The first punch on the new shift closes the last day worked on the old one.
  const before = key(A.assignDays(days.concat('Thu 17:57').map(t => punch(t)), { shiftFor: shiftForOf(NOVA) })).slice(0, -1);
  assert.deepEqual(key(A.assignDays(days.concat('Thu 17:57').map(t => punch(t)), { shiftFor: shiftForOf(NIGHT) })).slice(0, -1), before, 'moved to nights');
  const nights = ['Mon 17:59', 'Mon 22:00', 'Mon 22:30', 'Tue 03:00', 'Tue 18:01', 'Tue 22:00', 'Tue 22:30', 'Wed 03:02', 'Thu 09:00'];
  const asNight = key(A.assignDays(nights.map(t => punch(t)), { shiftFor: shiftForOf(NIGHT) })).slice(0, -1);
  assert.deepEqual(key(A.assignDays(nights.map(t => punch(t)), { shiftFor: shiftForOf(NOVA) })).slice(0, -1), asNight, 'moved to days');
});

test('a night worker still on a day shift, arriving after its end, keeps Login first and Logout last', () => {
  assert.deepEqual(live(['Mon 18:25', 'Mon 22:00', 'Mon 22:30', 'Tue 03:00'], { shiftFor: shiftForOf(GENERAL) }).final,
    ['Mon 18:25 09-14 LOGIN', 'Mon 22:00 09-14 BREAK_OUT', 'Mon 22:30 09-14 BREAK_IN', 'Tue 03:00 09-14 LOGOUT']);
});

test('a guess at the shift end is taken back when the day would end on an IN', () => {
  // Came in at the end of the day (no morning punch) and stayed on.
  assert.deepEqual(live(['Mon 18:22', 'Mon 19:40'], { shiftFor: shiftForOf(GENERAL) }).final,
    ['Mon 18:22 09-14 LOGIN', 'Mon 19:40 09-14 LOGOUT']);
  // A long errand that looked like a missed return.
  assert.deepEqual(live(['Mon 09:00', 'Mon 15:45', 'Mon 17:55', 'Mon 18:40'], { shiftFor: shiftForOf(NOVA) }).final,
    ['Mon 09:00 09-14 LOGIN', 'Mon 15:45 09-14 BREAK_OUT', 'Mon 17:55 09-14 BREAK_IN', 'Mon 18:40 09-14 LOGOUT']);
});

test('Friday overtime past the next window\'s start stays on Friday', () => {
  const r = live(['Fri 09:58', 'Fri 13:00', 'Fri 13:40', 'Fri 22:00', 'Fri 22:20', 'Sat 01:45', 'Sat 09:58', 'Sat 13:00', 'Sat 13:40', 'Sat 17:02'], { shiftFor: shiftForOf(DAY10, EVE) });
  assert.deepEqual(r.final.slice(5), ['Sat 01:45 09-18 LOGOUT', 'Sat 09:58 09-19 LOGIN', 'Sat 13:00 09-19 BREAK_OUT', 'Sat 13:40 09-19 BREAK_IN', 'Sat 17:02 09-19 LOGOUT']);
  const SAT = { id: 3, name: 'Sat', start_time: '10:00', end_time: '14:00', grace_minutes: 10, early_out_grace_minutes: 10, working_days: [6] };
  const nightSat = shiftForOf({ ...NIGHT, id: 4 }, SAT);
  assert.deepEqual(live(['Fri 17:58', 'Sat 03:01', 'Sat 09:58', 'Sat 14:02'], { shiftFor: nightSat }).final,
    ['Fri 17:58 09-18 LOGIN', 'Sat 03:01 09-18 LOGOUT', 'Sat 09:58 09-19 LOGIN', 'Sat 14:02 09-19 LOGOUT']);
});

test('the calendar ignores repeat taps, waits half an hour after the shift end, and closes a silent overtime day', () => {
  const opts = { shiftFor: shiftForOf(GENERAL) };
  const withRepeat = A.assignDays([punch('Mon 09:30'), punch('Mon 18:32:00'), punch('Mon 18:33:10')], opts);
  const day = A.classifyDay({ date: '2026-09-14', shift: GENERAL, punches: withRepeat, today: '2026-09-15' });
  assert.deepEqual([day.lastOut, day.punchCount], [at('Mon 18:32'), 2]);
  // The same repeat as the webhook stores it (no duplicate flag, the email marker instead).
  const stored = withRepeat.map(({ duplicate, ...r }) => (duplicate ? { ...r, email_status: 'skipped', email_error: 'Repeat tap within 2 minutes' } : r));
  assert.equal(A.classifyDay({ date: '2026-09-14', shift: GENERAL, punches: stored, today: '2026-09-15' }).lastOut, at('Mon 18:32'));

  const open = A.assignDays([punch('Mon 09:31')], opts);
  assert.equal(A.classifyDay({ date: '2026-09-14', shift: GENERAL, punches: open, now: at('Mon 18:50') }).lastOut, null, 'still inside the half hour');
  assert.equal(A.classifyDay({ date: '2026-09-14', shift: GENERAL, punches: open, now: at('Mon 19:00') }).lastOut, at('Mon 18:30'));

  const overtime = A.assignDays([punch('Mon 09:30'), punch('Mon 17:00'), punch('Mon 18:45')], opts);
  assert.equal(A.classifyDay({ date: '2026-09-14', shift: GENERAL, punches: overtime, now: at('Mon 20:00') }).lastOut, null, 'back after the end: still there');
  const done = A.classifyDay({ date: '2026-09-14', shift: GENERAL, punches: overtime, now: at('Tue 03:00') });
  assert.deepEqual([done.lastOut, done.outIsLastPunch], [at('Mon 18:45'), true]);
});

test('someone back from an early break is still at work late in the shift, not closed at that return', () => {
  const opts = { shiftFor: shiftForOf(GENERAL) };
  const rows = A.assignDays([punch('Mon 09:31'), punch('Mon 10:00'), punch('Mon 10:15')], opts);
  const d = A.classifyDay({ date: '2026-09-14', shift: GENERAL, punches: rows, now: at('Mon 18:20') });
  assert.equal(d.lastOut, null);
  assert.equal(A.classifyDay({ date: '2026-09-14', shift: GENERAL, punches: rows, now: at('Mon 19:00') }).lastOut, at('Mon 18:30'));
});

test('a night worker on a day shift: the arrival reads as a Login once the next punch comes, whatever the count', () => {
  const opts = { shiftFor: shiftForOf(GENERAL) };
  const odd = live(['Mon 18:25', 'Mon 22:00', 'Mon 22:30'], opts);
  assert.deepEqual(odd.final, ['Mon 18:25 09-14 LOGIN', 'Mon 22:00 09-14 BREAK_OUT', 'Mon 22:30 09-14 BREAK_IN']);
  assert.equal(odd.posted[2], 'Mon 22:30 BREAK_IN', 'the return from tea is not posted as a Logout');
  const day = A.classifyDay({ date: '2026-09-14', shift: GENERAL, punches: A.assignDays(['Mon 18:25', 'Mon 22:00', 'Mon 22:30'].map(t => punch(t)), opts), now: at('Tue 12:00') });
  assert.equal(day.firstIn, at('Mon 18:25'));
});
