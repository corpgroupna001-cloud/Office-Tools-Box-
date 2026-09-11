// CSV import / export helpers (ui/crm-logic.js), used by Contacts and Companies.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../ui/crm-logic.js');

test('CSV parsing: quotes, embedded commas and newlines, blank lines, BOM', () => {
  const text = '﻿Name,Email,Notes\r\n"Shah, Ravi",ravi@example.com,"Said ""call me""\nnext week"\r\n\r\nPriya,priya@example.com,\n';
  assert.deepEqual(L.csvParse(text), [
    ['Name', 'Email', 'Notes'],
    ['Shah, Ravi', 'ravi@example.com', 'Said "call me"\nnext week'],
    ['Priya', 'priya@example.com', ''],
  ]);
});

test('CSV parsing: semicolon files from spreadsheets in other locales', () => {
  assert.deepEqual(L.csvParse('Name;City\nAnil;Pune\n'), [['Name', 'City'], ['Anil', 'Pune']]);
  assert.deepEqual(L.csvParse('Name,Note\nAnil,a;b\n'), [['Name', 'Note'], ['Anil', 'a;b']], 'a comma header keeps semicolons as text');
});

test('CSV writing round-trips and never exports a live formula', () => {
  const rows = [['Name', 'Amount', 'Tags', 'Note'], ['Shah, Ravi', -500, ['vip', 'north'], '=HYPERLINK("x")'], [null, 12.5, [], '+91 98765']];
  const text = L.csvStringify(rows);
  assert.equal(text.split('\r\n')[1], '"Shah, Ravi",-500,"vip, north","\'=HYPERLINK(""x"")"');
  assert.deepEqual(L.csvParse(text), [
    ['Name', 'Amount', 'Tags', 'Note'],
    ['Shah, Ravi', '-500', 'vip, north', '\'=HYPERLINK("x")'],
    ['', '12.5', '', '\'+91 98765'],
  ]);
});
