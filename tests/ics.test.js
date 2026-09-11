'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../calendar/ics.js');

test('toIcs writes timed events in UTC and all-day events as IST dates', () => {
  const ics = I.toIcs([
    { id: 'e1', title: 'Budget, Q4; review', description: 'Line 1\nLine 2', location: 'Room 2', starts_at: '2026-09-14T04:30:00.000Z', ends_at: '2026-09-14T05:30:00.000Z', meeting_link: 'https://meet.example/x' },
    { id: 'e2', title: 'Offsite', all_day: true, starts_at: '2026-09-15T18:30:00.000Z', ends_at: '2026-09-17T18:29:59.999Z', status: 'cancelled' },
  ], { now: '2026-09-11T00:00:00Z' });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20260914T043000Z\r\nDTEND:20260914T053000Z/);
  assert.match(ics, /SUMMARY:Budget\\, Q4\\; review/);
  assert.match(ics, /DESCRIPTION:Line 1\\nLine 2/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260916\r\nDTEND;VALUE=DATE:20260918/, '16–17 Sep IST, end is the day after');
  assert.match(ics, /URL:https:\/\/meet\.example\/x/);
  assert.match(ics, /STATUS:CANCELLED/);
  assert.match(ics, /DTSTAMP:20260911T000000Z/);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});

test('long lines fold at 75 bytes without splitting a character', () => {
  const ics = I.toIcs([{ id: 'x', title: 'é'.repeat(80), starts_at: '2026-09-14T04:30:00Z', ends_at: '2026-09-14T05:00:00Z' }]);
  ics.split('\r\n').forEach(l => assert.ok(Buffer.byteLength(l) <= 75, l));
  assert.equal(I.parseIcs(ics)[0].title, 'é'.repeat(80));
});

test('parseIcs reads back what toIcs writes', () => {
  const back = I.parseIcs(I.toIcs([
    { id: 'e1', title: 'A, b; c\\d', description: 'x\ny', starts_at: '2026-09-14T04:30:00.000Z', ends_at: '2026-09-14T05:30:00.000Z' },
    { id: 'e2', title: 'Holiday', all_day: true, starts_at: '2026-09-15T18:30:00.000Z', ends_at: '2026-09-16T18:29:59.999Z' },
  ]));
  assert.equal(back.length, 2);
  assert.equal(back[0].title, 'A, b; c\\d');
  assert.equal(back[0].description, 'x\ny');
  assert.equal(back[0].starts_at, '2026-09-14T04:30:00.000Z');
  assert.equal(back[0].ends_at, '2026-09-14T05:30:00.000Z');
  assert.deepEqual([back[1].all_day, back[1].start_date, back[1].end_date], [true, '2026-09-16', '2026-09-16']);
});

test('parseIcs handles other calendars: folding, zones, durations, alarms, repeats, junk', () => {
  const text = ['BEGIN:VCALENDAR', 'BEGIN:VTIMEZONE', 'TZID:Asia/Kolkata', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:1', 'SUMMARY:Weekly sync with a long title that the producer ', ' folded', 'DTSTART;TZID=Asia/Kolkata:20260914T100000', 'DURATION:PT1H30M',
    'RRULE:FREQ=WEEKLY', 'BEGIN:VALARM', 'TRIGGER:-PT15M', 'SUMMARY:alarm text', 'END:VALARM', 'LOCATION:Board room', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:UTC one', 'DTSTART;TZID="UTC":20260914T100000', 'DTEND;TZID=UTC:20260914T110000', 'STATUS:CANCELLED', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261002', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:Two days', 'DTSTART;VALUE=DATE:20261010', 'DTEND;VALUE=DATE:20261012', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:No start', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:Instant', 'DTSTART:20260914T100000Z', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
  const ev = I.parseIcs(text);
  assert.equal(ev.length, 5);
  assert.equal(ev[0].title, 'Weekly sync with a long title that the producer folded');
  assert.equal(ev[0].starts_at, '2026-09-14T04:30:00.000Z', '10:00 IST');
  assert.equal(ev[0].ends_at, '2026-09-14T06:00:00.000Z');
  assert.equal(ev[0].recurring, true);
  assert.equal(ev[0].location, 'Board room', 'properties after an alarm still count');
  assert.equal(ev[1].starts_at, '2026-09-14T10:00:00.000Z');
  assert.equal(ev[1].cancelled, true);
  assert.deepEqual([ev[2].title, ev[2].all_day, ev[2].start_date, ev[2].end_date], ['(No title)', true, '2026-10-02', '2026-10-02']);
  assert.deepEqual([ev[3].start_date, ev[3].end_date], ['2026-10-10', '2026-10-11']);
  assert.equal(ev[4].ends_at, ev[4].starts_at, 'no end means an instant');
  assert.deepEqual(I.parseIcs('not a calendar'), []);
  assert.deepEqual(I.parseIcs(null), []);
});
