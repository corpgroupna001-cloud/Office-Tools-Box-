// The employee attendance page (attendance/index.html) mirrors a few rules of
// lib/attendance in browser code: the day's effective shift, when its shift
// ends, which punch is the In and the Out, which rows are "today", and what
// the WFH card says. This runs that block of the page (between `const IST`
// and "end of shift maths") and checks it against the server's own answers
// for the same punches.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('../lib/attendance');

const html = fs.readFileSync(path.join(__dirname, '../attendance/index.html'), 'utf8');
const start = html.indexOf("        const IST = 'Asia/Kolkata';");
const end = html.indexOf('        // ---- end of shift maths ----', start);
assert.ok(start >= 0 && end > start, 'the shift maths block is where the test expects it');
const P = vm.runInNewContext(html.slice(start, end) +
  ';({ shiftForDay, shiftEndAt, dayStats, currentDayRows, cardDayRows, wfhState, shiftTag, calendarTimes, isRepeat,' +
  '    NEW_DAY_GAP_MS, AUTO_LOGOUT_GRACE_MS })', {});
// Objects made inside the page's context have that context's prototypes.
const plain = v => JSON.parse(JSON.stringify(v));

const NOVA = { name: 'Nova', start_time: '09:00:00', end_time: '18:00:00', grace_minutes: 10, early_out_grace_minutes: 10, working_days: [1, 2, 3, 4, 5, 6] };
const GENERAL = { name: 'General', start_time: '09:30:00', end_time: '18:30:00', grace_minutes: 10, early_out_grace_minutes: 10, working_days: [1, 2, 3, 4, 5, 6] };
const NIGHT = { name: 'Jobways', start_time: '18:00:00', end_time: '03:00:00', grace_minutes: 10, early_out_grace_minutes: 10, working_days: [1, 2, 3, 4, 5] };
const DAY10 = { id: 1, name: 'SportsMart 10-5', start_time: '10:00', end_time: '17:00', grace_minutes: 10, early_out_grace_minutes: 10, working_days: [1, 2, 3, 4, 5, 6] };
const EVE = { id: 2, name: 'Jobways Evening', start_time: '17:00', end_time: '19:00', grace_minutes: 5, early_out_grace_minutes: 15, working_days: [1, 2, 3, 4, 5] };

// 2026-09-14 is a Monday. "Mon 18:00" -> an IST instant.
const DAYS = { Sun: '2026-09-13', Mon: '2026-09-14', Tue: '2026-09-15', Wed: '2026-09-16', Thu: '2026-09-17', Fri: '2026-09-18', Sat: '2026-09-19' };
const at = s => { const [d, t] = s.split(' '); return new Date(`${DAYS[d]}T${t.length === 5 ? t + ':00' : t}+05:30`).toISOString(); };
const shiftForOf = (s1, s2) => p => (s2 ? A.effectiveShift(s1, s2, A.istIsoWeekday(new Date(p.log_datetime))) : s1);

// What the webhook writes on a repeat tap (api/attendance-webhook.js).
const REPEAT_NOTE = 'Repeat tap within 2 minutes of the previous punch: stored, not announced.';

/**
 * Stored biometric rows as the webhook leaves them in attendance_logs:
 * labelled by lib/attendance, and a repeat tap marked only the way the table
 * can hold it (email_status / email_error - there is no duplicate column).
 */
function stored(times, s1, s2) {
  return A.assignDays(times.map(s => ({ id: s, log_datetime: at(s), direction: 'UNKNOWN', source: 'biometric' })), { shiftFor: shiftForOf(s1, s2) })
    .map(({ duplicate, ...r }) => ({ ...r, email_status: duplicate ? 'skipped' : 'sent', email_error: duplicate ? REPEAT_NOTE : null }));
}

/** WFH selfie rows: the event the person chose, dated by lib/attendance as the selfie route dates them. */
const EVENT_DIRECTION = { LOGIN: 'IN', BREAK_IN: 'IN', BREAK_OUT: 'OUT', LOGOUT: 'OUT' };
function selfies(punches, s1) {
  const rows = punches.map(([s, ev]) => ({ id: s, log_datetime: at(s), source: 'selfie', event_type: ev, direction: EVENT_DIRECTION[ev], email_status: 'sent', email_error: null }));
  const dated = A.assignDays(rows, { shiftFor: shiftForOf(s1) });
  return rows.map(r => ({ ...r, log_date: dated.find(d => d.id === r.id).log_date }));
}

const pageStats = (rows, date, s1, s2, now) =>
  P.dayStats(rows.filter(r => r.log_date === date), { date, shift: P.shiftForDay(s1, s2 || null, date, rows.find(r => r.log_date === date).log_datetime), now });
// The server as the calendar route runs it: every stored row of the day,
// repeats included - lib/attendance leaves those out itself.
const serverDay = (rows, date, s1, s2, now) =>
  A.classifyDay({ date, shift: s1, shift2: s2 || null, punches: rows.filter(r => r.log_date === date), today: date, now });

/** The page's In, Out and minutes for a day are the calendar's. */
function agree(rows, date, s1, s2, now, msg) {
  const mine = pageStats(rows, date, s1, s2, now), theirs = serverDay(rows, date, s1, s2, now);
  const iso = r => (r ? r.log_datetime : null);
  assert.deepEqual(
    [iso(mine.firstIn), iso(mine.lastOut), mine.mins, !!(mine.lastOut && mine.lastOut.auto), mine.outIsLastPunch, mine.missingLogin],
    [theirs.firstIn, theirs.lastOut, theirs.workedMinutes, !!theirs.autoLogout, !!theirs.outIsLastPunch, !!theirs.missingLogin],
    `${msg || date} at ${now}`);
  return mine;
}

/** The Today card as renderToday builds it at `now`: its rows, the day's figures, the WFH card state. */
function card(rows, s1, now) {
  const mine = P.cardDayRows(rows, { shift: s1, now }).slice().sort((a, b) => new Date(a.log_datetime) - new Date(b.log_datetime));
  const date = mine.length ? mine[0].log_date : null;
  const shift = date ? P.shiftForDay(s1, null, date, mine[0].log_datetime) : null;
  const end = P.shiftEndAt(date, shift);
  return {
    ids: plain(mine).map(r => r.id), date,
    stats: P.dayStats(mine, { date, shift, now }),
    wfh: P.wfhState(mine, end != null && new Date(now).getTime() >= end).state,
  };
}

test('the day\'s shift and its end match the server, dual shifts included', () => {
  const cases = [
    [DAY10, EVE, '2026-09-14', at('Mon 09:58')],   // both cover Monday: 10:00-19:00
    [DAY10, EVE, '2026-09-14', at('Mon 17:04')],   // came only for the evening: 17:00-19:00
    [DAY10, EVE, '2026-09-19', at('Sat 09:58')],   // Saturday: the first shift alone
    [NIGHT, null, '2026-09-14', at('Mon 17:55')],
    [GENERAL, null, '2026-09-14', null],
  ];
  for (const [s1, s2, date, first] of cases) {
    const mine = P.shiftForDay(s1, s2, date, first), theirs = A.shiftForDay(s1, s2, date, first);
    const pick = s => [s.start_time, s.end_time, s.grace_minutes, s.early_out_grace_minutes, !!s.secondOnly];
    assert.deepEqual(pick(plain(mine)), pick(theirs), `${date} ${first}`);
    assert.equal(P.shiftEndAt(date, mine), A.shiftEndAt(date, theirs).getTime());
  }
  assert.deepEqual(plain(P.shiftForDay(DAY10, EVE, '2026-09-14', at('Mon 09:58'))).start_time, '10:00');
  assert.deepEqual(plain(P.shiftForDay(DAY10, EVE, '2026-09-14', at('Mon 09:58'))).end_time, '19:00');
  assert.equal(new Date(P.shiftEndAt('2026-09-14', NIGHT)).toISOString(), at('Tue 03:00'), 'an overnight shift ends the next morning');
});

test('the Out is the last punch only when it is an OUT; back from a break is still on the clock', () => {
  const rows = stored(['Tue 09:28', 'Tue 13:00', 'Tue 13:45'], GENERAL);
  const mid = pageStats(rows, '2026-09-15', GENERAL, null, at('Tue 15:00'));
  assert.equal(mid.lastOut, null);
  assert.equal(mid.onClock, true);
  assert.equal(mid.firstIn.log_datetime, at('Tue 09:28'));
  assert.equal(serverDay(rows, '2026-09-15', GENERAL, null, at('Tue 15:00')).lastOut, null);

  // Once the shift is over with nobody punched out: logged out at the shift end, like the calendar.
  const eve = pageStats(rows, '2026-09-15', GENERAL, null, at('Tue 19:00'));
  const server = serverDay(rows, '2026-09-15', GENERAL, null, at('Tue 19:00'));
  assert.equal(eve.lastOut.log_datetime, server.lastOut);
  assert.equal(eve.lastOut.auto, true);
  assert.equal(eve.mins, server.workedMinutes);
  assert.equal(eve.onClock, false);

  // On a break: the break-out is the last punch, and it is never "early".
  const onBreak = pageStats(rows.slice(0, 2), '2026-09-15', GENERAL, null, at('Tue 13:30'));
  assert.equal(onBreak.lastOut.event_type, 'BREAK_OUT');
  assert.equal(P.shiftTag(onBreak.lastOut, GENERAL, 'out'), null);
  const gone = pageStats(rows.slice(0, 2), '2026-09-15', GENERAL, null, at('Tue 19:00'));
  assert.equal(gone.auto, 'break_not_returned');
  assert.equal(gone.lastOut.log_datetime, at('Tue 13:00'));
});

test('a logout is the Out and is measured against the shift end', () => {
  // Left at 17:30 for an 18:00 end. On the day that reads as a break (the
  // server cannot know yet); once the next day starts it is the Logout.
  const rows = stored(['Mon 09:00', 'Mon 13:00', 'Mon 14:00', 'Mon 17:30', 'Tue 09:00'], NOVA);
  const s = pageStats(rows, '2026-09-14', NOVA, null, at('Tue 09:05'));
  assert.equal(s.lastOut.event_type, 'LOGOUT');
  assert.equal(s.lastOut.log_datetime, serverDay(rows, '2026-09-14', NOVA, null, at('Tue 09:05')).lastOut);
  assert.deepEqual(plain(P.shiftTag(s.lastOut, NOVA, 'out')), { cls: 'early', text: '30m early' });
  assert.deepEqual(plain(P.shiftTag(s.firstIn, NOVA, 'in')), { cls: 'ontime', text: 'On time' });
});

test('only the logout punched: no In, a "login not punched" day, not hours late', () => {
  const rows = stored(['Mon 17:58'], NOVA);
  const s = pageStats(rows, '2026-09-14', NOVA, null, at('Tue 09:00'));
  const server = serverDay(rows, '2026-09-14', NOVA, null, at('Tue 09:00'));
  assert.equal(s.firstIn, null);
  assert.equal(server.firstIn, null);
  assert.equal(s.missingLogin, true);
  assert.equal(s.lastOut.log_datetime, server.lastOut);
});

test('a repeat tap counts for nothing', () => {
  const rows = stored(['Mon 09:00:00', 'Mon 09:00:04', 'Mon 13:00', 'Mon 14:00', 'Mon 18:00'], NOVA);
  assert.equal(rows.filter(r => P.isRepeat(r)).length, 1);
  const s = agree(rows, '2026-09-14', NOVA, null, at('Mon 18:05'));
  assert.equal(s.count, 4);
  assert.equal(s.lastOut.event_type, 'LOGOUT');
  assert.equal(P.isRepeat({ email_status: 'skipped', email_error: 'Mapped after the fact - historical punch, not emailed.' }), false);
});

test('repeat taps: the page skips exactly the rows the server skips', () => {
  const samples = [
    { duplicate: true },                                            // assignDays' own flag
    { duplicate: true, email_status: 'sent', email_error: null },
    { email_status: 'skipped', email_error: REPEAT_NOTE },          // as stored
    { email_status: 'skipped', email_error: 'REPEAT TAP - same punch as 09:00' },
    { email_status: 'skipped', email_error: '  Repeat tap' },       // not at the start
    { email_status: 'sent', email_error: REPEAT_NOTE },
    { email_status: 'failed', email_error: REPEAT_NOTE },
    { email_status: 'skipped', email_error: 'Mapped after the fact - historical punch, not emailed.' },
    { email_status: 'skipped', email_error: null },
    { duplicate: 'yes' }, { duplicate: false }, {}, null,
  ];
  for (const r of samples) assert.equal(P.isRepeat(r), A.isRepeatRow(r), JSON.stringify(r));

  // A repeat as the day's last punch: the Out is the Logout, not the second touch.
  const late = stored(['Mon 09:00:00', 'Mon 09:00:40', 'Mon 13:00', 'Mon 14:00', 'Mon 18:02:00', 'Mon 18:03:10'], NOVA);
  assert.equal(late.filter(r => A.isRepeatRow(r)).length, 2);
  const s = agree(late, '2026-09-14', NOVA, null, at('Mon 18:40'));
  assert.equal(s.lastOut.log_datetime, at('Mon 18:02:00'));
  assert.equal(s.mins, 542);
  assert.equal(s.count, 4);

  // A return at 17:59:30 repeated at 18:00:40: the repeat is not overtime,
  // so the day still closes automatically at the shift end.
  const straddle = stored(['Mon 09:00', 'Mon 17:30', 'Mon 17:59:30', 'Mon 18:00:40'], NOVA);
  assert.equal(straddle[3].email_error, REPEAT_NOTE);
  for (const now of ['Mon 18:10', 'Mon 18:29', 'Mon 18:30', 'Tue 08:00']) agree(straddle, '2026-09-14', NOVA, null, at(now), 'straddle');
  const closed = agree(straddle, '2026-09-14', NOVA, null, at('Mon 18:30'));
  assert.equal(closed.lastOut.auto, true);
  assert.equal(closed.mins, 540);
});

test('the automatic Out waits half an hour past the shift end, as the server does', () => {
  assert.equal(P.AUTO_LOGOUT_GRACE_MS, A.AUTO_LOGOUT_GRACE_MS);
  assert.equal(P.NEW_DAY_GAP_MS, A.NEW_DAY_GAP_MS);
  const day = stored(['Mon 09:00'], NOVA);
  // 18:10: the shift is over but plenty of people leave late - still on the
  // clock, not "Auto · no punch-out" with the count frozen at 9h 00m.
  for (const now of ['Mon 18:00', 'Mon 18:10', 'Mon 18:29:59']) {
    const s = agree(day, '2026-09-14', NOVA, null, at(now));
    assert.equal(s.lastOut, null, now);
    assert.equal(s.onClock, true, now);
    assert.equal(s.auto, null, now);
  }
  const s = agree(day, '2026-09-14', NOVA, null, at('Mon 18:30'));
  assert.equal(s.lastOut.log_datetime, at('Mon 18:00'));
  assert.equal(s.lastOut.auto, true);
  assert.equal(s.auto, 'no_punch_out');
  assert.equal(s.mins, 540);
  assert.equal(s.onClock, false);
  // Logged out at 18:15, inside the half hour: that is the Out, no automatic one.
  const left = stored(['Mon 09:00', 'Mon 18:15'], NOVA);
  assert.equal(agree(left, '2026-09-14', NOVA, null, at('Mon 19:00')).lastOut.log_datetime, at('Mon 18:15'));

  // Gone on a break and never back: the break-out is the Out either way; it
  // is "not back from break" only from the same half hour on.
  const brk = stored(['Mon 09:00', 'Mon 17:00'], NOVA);
  const auto = now => A.autoLogoutFor({ date: '2026-09-14', shift: NOVA, punches: brk, now: at(now) });
  assert.equal(agree(brk, '2026-09-14', NOVA, null, at('Mon 18:20')).auto, null);
  assert.equal(auto('Mon 18:20'), null);
  assert.equal(agree(brk, '2026-09-14', NOVA, null, at('Mon 18:30')).auto, 'break_not_returned');
  assert.equal(auto('Mon 18:30').kind, 'break_not_returned');

  // Overnight: the 18:00-03:00 shift closes at 3:00, counted from 3:30.
  const night = stored(['Mon 17:55', 'Mon 22:00', 'Mon 22:30'], NIGHT);
  for (const now of ['Tue 01:00', 'Tue 03:00', 'Tue 03:29', 'Tue 03:30', 'Tue 09:00']) agree(night, '2026-09-14', NIGHT, null, at(now), 'night');
  assert.equal(pageStats(night, '2026-09-14', NIGHT, null, at('Tue 03:29')).lastOut, null);
  assert.equal(pageStats(night, '2026-09-14', NIGHT, null, at('Tue 03:30')).lastOut.log_datetime, at('Tue 03:00'));
});

test('overtime never punched out: after eight hours of silence the last punch is the Out', () => {
  // Back from a break at 18:40, after an 18:00 end: overtime, so no automatic
  // Logout; the server takes the last punch as the Out once 8 hours pass.
  const rows = stored(['Mon 09:00', 'Mon 17:30', 'Mon 18:40'], NOVA);
  assert.equal(rows[2].event_type, 'BREAK_IN');
  const before = agree(rows, '2026-09-14', NOVA, null, at('Tue 02:39'));
  assert.equal(before.lastOut, null);
  assert.equal(before.onClock, true);
  const after = agree(rows, '2026-09-14', NOVA, null, at('Tue 02:40'));
  assert.equal(after.outIsLastPunch, true);
  assert.equal(after.lastOut.log_datetime, at('Mon 18:40'));
  assert.equal(after.lastOut.auto, undefined);
  assert.equal(after.mins, 580);
  assert.equal(after.onClock, false);
  // A lone login after the end is not a day with an Out, however long ago.
  const lone = selfies([['Mon 19:00', 'LOGIN']], NOVA);
  assert.equal(agree(lone, '2026-09-14', NOVA, null, at('Tue 09:00')).lastOut, null);
});

test('page and server agree on In, Out and minutes through a whole day and night', () => {
  const days = [
    [stored(['Mon 09:00:00', 'Mon 09:00:40', 'Mon 13:00', 'Mon 14:00', 'Mon 18:02:00', 'Mon 18:03:10'], NOVA), NOVA],
    [stored(['Mon 09:00', 'Mon 13:00', 'Mon 14:00'], NOVA), NOVA],
    [stored(['Mon 09:00', 'Mon 13:00'], NOVA), NOVA],
    [stored(['Mon 09:00', 'Mon 17:30', 'Mon 17:59:30', 'Mon 18:00:40'], NOVA), NOVA],
    [stored(['Mon 09:00', 'Mon 17:30', 'Mon 18:40'], NOVA), NOVA],
    [stored(['Mon 17:58'], NOVA), NOVA],
    [stored(['Mon 17:55', 'Mon 17:55:30', 'Mon 22:00', 'Mon 22:30'], NIGHT), NIGHT],
    [stored(['Mon 17:55', 'Mon 22:00', 'Mon 22:30', 'Tue 03:05', 'Tue 03:06'], NIGHT), NIGHT],
    [selfies([['Mon 18:00', 'LOGIN'], ['Mon 22:00', 'BREAK_OUT'], ['Mon 22:30', 'BREAK_IN']], NIGHT), NIGHT],
  ];
  const t0 = new Date(at('Mon 09:30')).getTime();
  for (const [rows, shift] of days) {
    const date = rows[0].log_date;
    for (let m = 0; m <= 26 * 60; m += 7) agree(rows, date, shift, null, new Date(t0 + m * 60000).toISOString(), rows.map(r => r.id).join(','));
  }
});

test('dual shift: the tags use the day\'s own window', () => {
  // Both shifts cover Monday: 10:00-19:00, so leaving at 17:05 is early.
  const both = stored(['Mon 09:58', 'Mon 13:00', 'Mon 13:40', 'Mon 17:05', 'Tue 09:59'], DAY10, EVE);
  const s = pageStats(both, '2026-09-14', DAY10, EVE, at('Tue 10:00'));
  const shift = P.shiftForDay(DAY10, EVE, '2026-09-14', at('Mon 09:58'));
  assert.equal(s.lastOut.event_type, 'LOGOUT');
  assert.deepEqual(plain(P.shiftTag(s.lastOut, shift, 'out')), { cls: 'early', text: '1h 55m early' });
  assert.deepEqual(plain(P.shiftTag(s.lastOut, DAY10, 'out')), { cls: 'ontime', text: 'Full shift' }, 'the first shift alone would have missed it');
  // Only the evening: late is from 17:00 (5 min grace), not 7 hours from 10:00.
  const eve = stored(['Mon 17:04', 'Mon 19:01'], DAY10, EVE);
  const eveShift = P.shiftForDay(DAY10, EVE, '2026-09-14', at('Mon 17:04'));
  assert.deepEqual(plain(P.shiftTag(eve[0], eveShift, 'in')), { cls: 'ontime', text: 'On time' });
  assert.deepEqual(plain(P.shiftTag(eve[1], eveShift, 'out')), { cls: 'ontime', text: 'Full shift' });
  assert.deepEqual(plain(P.shiftTag({ log_datetime: at('Mon 17:20') }, eveShift, 'in')), { cls: 'late', text: '20m late' });
});

test('today: a night shift stays today until it is closed or half an hour past its end', () => {
  const rows = stored(['Mon 17:55', 'Mon 22:00', 'Mon 22:30'], NIGHT);
  const ids = list => plain(list).map(r => r.id);
  assert.deepEqual(ids(P.currentDayRows(rows, { shift: NIGHT, now: at('Tue 01:00') })), ['Mon 17:55', 'Mon 22:00', 'Mon 22:30']);
  assert.deepEqual(ids(P.currentDayRows(rows, { shift: NIGHT, now: at('Tue 03:20') })), ['Mon 17:55', 'Mon 22:00', 'Mon 22:30']);
  // The shift ended at 3:00 and nobody punched out: by 3:30 it is over, not "today" all morning.
  assert.deepEqual(ids(P.currentDayRows(rows, { shift: NIGHT, now: at('Tue 03:31') })), []);
  // A logout at 3:05 closes the day there and then.
  const closed = stored(['Mon 17:55', 'Mon 22:00', 'Mon 22:30', 'Tue 03:05'], NIGHT);
  assert.equal(closed[3].event_type, 'LOGOUT');
  assert.deepEqual(ids(P.currentDayRows(closed, { shift: NIGHT, now: at('Tue 03:10') })), []);
  // Overtime punched past the end keeps it open half an hour past that punch.
  const ot = stored(['Mon 17:55', 'Mon 22:00', 'Mon 22:30', 'Tue 03:30', 'Tue 03:45'], NIGHT);
  assert.equal(ot[4].event_type, 'BREAK_IN');
  assert.equal(P.currentDayRows(ot, { shift: NIGHT, now: at('Tue 04:10') }).length, 5);
  // Today's own date always counts.
  const day = stored(['Mon 09:00', 'Mon 13:00', 'Mon 14:00', 'Mon 18:02', 'Tue 09:01'], NOVA);
  assert.deepEqual(ids(P.currentDayRows(day, { shift: NOVA, now: at('Tue 09:30') })), ['Tue 09:01']);
  assert.deepEqual(ids(P.currentDayRows(day.slice(0, 4), { shift: NOVA, now: at('Tue 08:00') })), []);
});

test('today without a shift: the old eight-hour rule', () => {
  const rows = stored(['Mon 18:00', 'Mon 22:00'], NIGHT).map(r => ({ ...r, log_date: '2026-09-14' }));
  assert.equal(P.currentDayRows(rows, { now: at('Tue 05:59') }).length, 2);
  assert.equal(P.currentDayRows(rows, { now: at('Tue 06:01') }).length, 0);
});

test('calendar days: automatic Out, login not punched, still on the clock, and old responses as before', () => {
  const t = (day, open) => plain(P.calendarTimes(day, '2026-09-18', open));
  assert.deepEqual(t({ date: '2026-09-15', in: '09:31', out: '18:30' }),
    { in: '09:31', out: '18:30', auto: false, missingLogin: false, onClock: false });
  assert.deepEqual(t({ date: '2026-09-15', in: '09:31', out: '18:30', auto: true }).auto, true);
  assert.deepEqual(t({ date: '2026-09-14', in: null, out: '17:58', missing_login: true }),
    { in: null, out: '17:58', auto: false, missingLogin: true, onClock: false });
  assert.equal(t({ date: '2026-09-18', in: '09:31', out: null }).onClock, true);
  assert.equal(t({ date: '2026-09-17', in: '18:01', out: null }, '2026-09-17').onClock, true, 'a night still under way at 1am');
  assert.equal(t({ date: '2026-09-16', in: '09:31', out: null }).onClock, false, 'an old day with no Out is not "on the clock"');
  assert.equal(t({ date: '2026-09-16', in: null, out: null }).missingLogin, false);
});

test('WFH night: after a 3:05 logout the card shows the night as complete, not "Login now"', () => {
  const night = selfies([['Mon 18:00', 'LOGIN'], ['Mon 22:00', 'BREAK_OUT'], ['Mon 22:30', 'BREAK_IN'], ['Tue 03:05', 'LOGOUT']], NIGHT);
  assert.deepEqual(night.map(r => r.log_date), Array(4).fill('2026-09-14'), 'one night, dated by its evening');
  for (const now of ['Tue 03:10', 'Tue 09:00']) {
    const c = card(night, NIGHT, at(now));
    assert.deepEqual(c.ids, ['Mon 18:00', 'Mon 22:00', 'Mon 22:30', 'Tue 03:05'], now);
    assert.equal(c.wfh, 'done', now);
    assert.equal(c.stats.firstIn.log_datetime, at('Mon 18:00'));
    assert.equal(c.stats.lastOut.log_datetime, at('Tue 03:05'));
    assert.equal(c.stats.mins, 545);
    // It is not the day under way: the calendar, pay and day list do not
    // call it "on the clock".
    assert.deepEqual(plain(P.currentDayRows(night, { shift: NIGHT, now: at(now) })), [], now);
  }
  // Eight hours after the logout it is a new day with nothing in it yet.
  const next = card(night, NIGHT, at('Tue 11:10'));
  assert.deepEqual(next.ids, []);
  assert.equal(next.wfh, 'login');
  assert.equal(next.stats.count, 0);
});

test('WFH night: still working past the shift end, the card offers Logout, and it lands on the night', () => {
  const punches = [['Mon 18:00', 'LOGIN'], ['Mon 22:00', 'BREAK_OUT'], ['Mon 22:30', 'BREAK_IN']];
  const night = selfies(punches, NIGHT);
  assert.equal(card(night, NIGHT, at('Tue 01:00')).wfh, 'live');
  // 3:10: the shift is over, the automatic Out not yet - still on the clock.
  const early = card(night, NIGHT, at('Tue 03:10'));
  assert.equal(early.wfh, 'late');
  assert.equal(early.stats.lastOut, null);
  assert.equal(early.stats.onClock, true);
  // 3:45: the day counts as closed at 3:00 (as on the calendar), but the
  // card still shows the night and offers Logout, not Login.
  const c = card(night, NIGHT, at('Tue 03:45'));
  assert.deepEqual(c.ids, ['Mon 18:00', 'Mon 22:00', 'Mon 22:30']);
  assert.equal(c.wfh, 'late');
  assert.equal(c.stats.auto, 'no_punch_out');
  assert.equal(c.stats.lastOut.log_datetime, at('Tue 03:00'));
  const server = serverDay(night, '2026-09-14', NIGHT, null, at('Tue 03:45'));
  assert.equal(server.lastOut, at('Tue 03:00'));
  assert.equal(c.stats.mins, server.workedMinutes);
  assert.deepEqual(plain(P.currentDayRows(night, { shift: NIGHT, now: at('Tue 03:45') })), []);
  // The Logout tapped there is the night's real Out.
  const out = selfies(punches.concat([['Tue 03:45', 'LOGOUT']]), NIGHT);
  assert.equal(out[3].log_date, '2026-09-14');
  const closed = serverDay(out, '2026-09-14', NIGHT, null, at('Tue 03:50'));
  assert.equal(closed.lastOut, at('Tue 03:45'));
  assert.equal(closed.workedMinutes, 585);
  const after = card(out, NIGHT, at('Tue 03:50'));
  assert.equal(after.wfh, 'done');
  assert.equal(after.stats.lastOut.log_datetime, at('Tue 03:45'));
  // Until four hours after the shift end - as long as the server would still
  // file a punch on that night - the card keeps it; then it lets it go.
  assert.equal(card(night, NIGHT, at('Tue 06:59')).wfh, 'late');
  assert.deepEqual(card(night, NIGHT, at('Tue 07:01')).ids, []);
  // A night with only the login, nothing since: the same, although the last
  // punch is more than eight hours old by 3:45.
  const lone = selfies([['Mon 17:58', 'LOGIN']], NIGHT);
  const l = card(lone, NIGHT, at('Tue 03:45'));
  assert.deepEqual([l.wfh, l.stats.auto], ['late', 'no_punch_out']);
  assert.deepEqual(card(lone, NIGHT, at('Tue 07:01')).ids, []);
});

test('the Today card: a day worker\'s closed day, today\'s punches, and a login dated ahead', () => {
  const day = stored(['Mon 09:00', 'Mon 13:00', 'Mon 14:00', 'Mon 18:02', 'Tue 09:01'], NOVA);
  // Today's punches are today's day, whatever came before.
  assert.deepEqual(card(day, NOVA, at('Tue 09:30')).ids, ['Tue 09:01']);
  // Just past midnight, the evening's closed day is still on the card...
  const late = card(day.slice(0, 4), NOVA, at('Tue 01:00'));
  assert.equal(late.ids.length, 4);
  assert.equal(late.stats.lastOut.event_type, 'LOGOUT');
  // ...and by the morning it is gone.
  assert.deepEqual(card(day.slice(0, 4), NOVA, at('Tue 08:00')).ids, []);
  // A login at 23:45 for a 00:30 shift is dated the next day: it is still
  // the card's day, so the card does not ask for a second login.
  const EARLY = { name: 'Late night', start_time: '00:30:00', end_time: '09:00:00', grace_minutes: 10, early_out_grace_minutes: 10, working_days: [1, 2, 3, 4, 5, 6, 7] };
  const ahead = selfies([['Mon 23:45', 'LOGIN']], EARLY);
  assert.equal(ahead[0].log_date, '2026-09-15');
  const c = card(ahead, EARLY, at('Mon 23:50'));
  assert.deepEqual(c.ids, ['Mon 23:45']);
  assert.equal(c.wfh, 'live');
  assert.equal(c.stats.onClock, true);
});

test('the WFH card: selfie events only, first login, last logout, the last break decides', () => {
  const sf = (s, ev) => ({ id: s, log_datetime: at(s), source: 'selfie', event_type: ev });
  assert.equal(P.wfhState([], false).state, 'login');
  assert.equal(P.wfhState([{ ...sf('Mon 09:00', 'LOGIN'), source: 'biometric' }], false).state, 'login', 'an office punch does not log a WFH day in');
  assert.equal(P.wfhState([sf('Mon 09:00', 'LOGIN')], false).state, 'live');
  assert.equal(P.wfhState([sf('Mon 09:00', 'LOGIN')], true).state, 'late');
  assert.equal(P.wfhState([sf('Mon 13:00', 'BREAK_OUT'), sf('Mon 09:00', 'LOGIN')], true).state, 'break');
  assert.equal(P.wfhState([sf('Mon 09:00', 'LOGIN'), sf('Mon 13:00', 'BREAK_OUT'), sf('Mon 13:30', 'BREAK_IN')], false).state, 'live');
  const done = P.wfhState([sf('Mon 09:00', 'LOGIN'), sf('Mon 17:45', 'LOGIN'), sf('Mon 13:00', 'LOGOUT'), sf('Mon 18:05', 'LOGOUT')], false);
  assert.equal(done.state, 'done');
  assert.equal(done.login.log_datetime, at('Mon 09:00'));
  assert.equal(done.logout.log_datetime, at('Mon 18:05'));
  // A repeat of a Logout does not close a day on its own.
  assert.equal(P.wfhState([sf('Mon 09:00', 'LOGIN'), { ...sf('Mon 09:00:30', 'LOGOUT'), email_status: 'skipped', email_error: REPEAT_NOTE }], false).state, 'live');
});
