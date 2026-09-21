// Quote status and the forecast / win-loss arithmetic in ui/crm-logic.js,
// the same functions the Quotes and Forecast pages render with.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../ui/crm-logic');

test('a sent quote past its valid-until date reads as expired; nothing else does', () => {
  assert.equal(L.quoteStatus({ status: 'sent', valid_until: '2026-09-20' }, '2026-09-21'), 'expired');
  assert.equal(L.quoteStatus({ status: 'sent', valid_until: '2026-09-21' }, '2026-09-21'), 'sent', 'valid through the last day');
  assert.equal(L.quoteStatus({ status: 'accepted', valid_until: '2026-01-01' }, '2026-09-21'), 'accepted');
  assert.equal(L.quoteStatus({ status: 'draft', valid_until: '2026-01-01' }, '2026-09-21'), 'draft');
  assert.equal(L.quoteStatus(null), 'draft');
  for (const k of ['draft', 'sent', 'accepted', 'declined', 'expired']) assert.ok(L.QUOTE_STATUS[k].label);
});

test('quote actions follow the transitions the database allows', () => {
  const a = s => L.quoteActions(s, '2026-09-21');
  assert.deepEqual(Object.entries(a({ status: 'draft' })).filter(([, v]) => v).map(([k]) => k).sort(), ['accept', 'decline', 'edit', 'remove', 'send']);
  assert.equal(a({ status: 'sent' }).edit, false);
  assert.equal(a({ status: 'sent' }).revise, true);
  assert.equal(a({ status: 'accepted' }).invoice, true);
  assert.equal(a({ status: 'accepted', invoice_id: 'x' }).invoice, false, 'invoiced once');
  assert.equal(a({ status: 'accepted', invoice_id: 'x' }).revise, false);
  assert.equal(a({ status: 'declined' }).accept, false);
  assert.equal(a({ status: 'sent', valid_until: '2026-01-01' }).expired, true);
});

test('months roll over the year', () => {
  assert.deepEqual(L.monthKeys('2026-11-30', 4), ['2026-11', '2026-12', '2027-01', '2027-02']);
  assert.equal(L.monthKey('2026-09-21'), '2026-09');
  assert.equal(L.monthKey(null), null);
});

test('forecast buckets: closed, commit (>= 70%), best case and weighted pipeline per month', () => {
  const months = L.monthKeys('2026-09-01', 3);
  const deals = [
    { status: 'won', value: 1000, actual_close_date: '2026-09-05' },
    { status: 'won', value: 500, actual_close_date: '2026-08-31' },                   // before the window: ignored
    { status: 'open', value: 2000, probability: 80, expected_close_date: '2026-09-28' },
    { status: 'open', value: 3000, probability: 30, expected_close_date: '2026-10-02' },
    { status: 'open', value: 400, probability: 70, expected_close_date: '2026-10-15' },
    { status: 'open', value: 700, probability: 50, expected_close_date: '2026-06-01' }, // slipped: overdue
    { status: 'open', value: 100, probability: 50 },                                    // no date: overdue
    { status: 'open', value: 9999, probability: 90, expected_close_date: '2026-09-10', currency: 'USD' }, // other currency
    { status: 'open', value: 5000, probability: 90, expected_close_date: '2026-09-10', archived_at: '2026-09-01' },
    { status: 'lost', value: 800, actual_close_date: '2026-09-02' },
  ];
  const f = L.forecast(deals, months);
  assert.deepEqual(f.months.map(m => [m.month, m.closed, m.commit, m.bestCase, m.pipeline]), [
    ['2026-09', 1000, 2000, 2000, 1600],
    ['2026-10', 0, 400, 3400, 1180],
    ['2026-11', 0, 0, 0, 0],
  ]);
  assert.deepEqual(f.totals, { closed: 1000, commit: 2400, bestCase: 5400, pipeline: 2780 });
  assert.deepEqual(f.overdue, { count: 2, value: 800 });
  assert.equal(L.forecast(deals, months, { currency: 'USD' }).totals.commit, 9999);
});

test('win/loss: rate, lost reasons ranked, and the average days to win', () => {
  const w = L.winLoss([
    { status: 'won', value: 100, created_at: '2026-09-01T04:00:00Z', actual_close_date: '2026-09-11' },
    { status: 'won', value: 300, created_at: '2026-09-01T20:00:00Z', actual_close_date: '2026-09-21' },   // 02 Sep IST -> 19 days
    { status: 'lost', value: 50, lost_reason: 'Price too high' },
    { status: 'lost', value: 70, lost_reason: 'Price too high' },
    { status: 'lost', value: 90 },
    { status: 'open', value: 999 },
  ]);
  assert.equal(w.won, 2); assert.equal(w.lost, 3);
  assert.equal(w.win_rate, 40);
  assert.equal(w.avg_cycle_days, 15);             // (10 + 19) / 2, rounded
  assert.deepEqual(w.reasons.map(r => [r.reason, r.count, r.value, r.share]), [['Price too high', 2, 120, 67], ['No reason given', 1, 90, 33]]);
  assert.equal(L.winLoss([]).win_rate, null);
});

test('attainment is a whole percent, or null with no target', () => {
  assert.equal(L.attainment(75, 100), 75);
  assert.equal(L.attainment(1, 3), 33);
  assert.equal(L.attainment(10, 0), null);
});

test('quote activity reads as a sentence', () => {
  assert.equal(L.describeActivity({ action: 'quote.accepted', meta: {} }).verb, 'marked the quote accepted');
  assert.equal(L.describeActivity({ action: 'quote.invoiced', meta: {} }).verb, 'invoiced the quote');
});
