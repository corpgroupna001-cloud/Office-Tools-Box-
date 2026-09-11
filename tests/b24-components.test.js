// Pure parts of the list grid and the filter bar (ui/b24-grid.js, ui/b24-filter.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../ui/b24-grid.js');
const F = require('../ui/b24-filter.js');

const COLS = [
  { key: 'name', title: 'Name' },
  { key: 'email', title: 'Email' },
  { key: 'notes', title: 'Notes', default: false },
  { key: 'actions', title: '', sortable: false },
];

test('grid settings: defaults, saved choices, and columns added later', () => {
  assert.deepEqual(G.normaliseSettings(COLS, null).visible, ['name', 'email', 'actions'], 'off-by-default columns stay hidden');
  const s = G.normaliseSettings(COLS, { visible: ['email', 'gone', 'name'], known: ['name', 'email', 'notes'], widths: { name: 250, email: 5, gone: 90 }, sort: { key: 'email', dir: 'asc' }, perPage: 50 });
  assert.deepEqual(s.visible, ['email', 'name', 'actions'], 'unknown keys drop out; a column new since saving appears');
  assert.deepEqual(s.widths, { name: 250 }, 'widths are bounded');
  assert.deepEqual(s.sort, { key: 'email', dir: 'asc' });
  assert.equal(s.perPage, 50);
  assert.equal(G.normaliseSettings(COLS, { sort: { key: 'actions', dir: 'asc' } }).sort, null, 'unsortable columns cannot be the sort');
  assert.equal(G.normaliseSettings(COLS, { perPage: 7 }).perPage, null);
  assert.deepEqual(G.normaliseSettings(COLS, { visible: [] }).visible, ['name', 'email', 'actions'], 'an empty choice falls back to the defaults');
});

test('filter dates: calendar ranges in IST, weeks from Monday', () => {
  const fri = '2026-09-11';   // a Friday
  assert.deepEqual(F.dateRange({ kind: 'today' }, fri), { from: fri, to: fri });
  assert.deepEqual(F.dateRange({ kind: 'this_week' }, fri), { from: '2026-09-07', to: '2026-09-13' });
  assert.deepEqual(F.dateRange({ kind: 'last_week' }, fri), { from: '2026-08-31', to: '2026-09-06' });
  assert.deepEqual(F.dateRange({ kind: 'next_week' }, fri), { from: '2026-09-14', to: '2026-09-20' });
  assert.deepEqual(F.dateRange({ kind: 'this_week' }, '2026-09-07'), { from: '2026-09-07', to: '2026-09-13' }, 'a Monday starts its own week');
  assert.deepEqual(F.dateRange({ kind: 'last_month' }, '2026-03-15'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(F.dateRange({ kind: 'this_month' }, '2024-02-10'), { from: '2024-02-01', to: '2024-02-29' }, 'leap years');
  assert.deepEqual(F.dateRange({ kind: 'last_7' }, fri), { from: '2026-09-05', to: fri });
  assert.deepEqual(F.dateRange({ kind: 'before_today' }, fri), { from: null, to: '2026-09-10' });
  assert.deepEqual(F.dateRange({ kind: 'range', from: '2026-01-01' }, fri), { from: '2026-01-01', to: null });
  assert.equal(F.dateRange({ kind: 'range' }, fri), null);
  assert.equal(F.dateRange({}, fri), null);
});

test('filter values become query operations', () => {
  const fields = [
    { key: 'name', title: 'Name', type: 'text' },
    { key: 'status', title: 'Stage', type: 'multiselect', options: [{ value: 'new', label: 'New' }, { value: 'won', label: 'Won' }] },
    { key: 'owner', title: 'Responsible', type: 'user', column: 'owner_id' },
    { key: 'value', title: 'Amount', type: 'number' },
    { key: 'created', title: 'Created', type: 'date', column: 'created_at', datetime: true },
    { key: 'due', title: 'Deadline', type: 'date', column: 'due_date' },
    { key: 'mine', title: 'Mine', type: 'check', column: 'is_mine' },
    { key: 'custom', title: 'Custom', type: 'text', apply: b => b },
  ];
  const ops = F.toOps(fields, {
    name: 'Acme, 100%', status: ['new'], owner: 'me', value: { from: '10', to: '' },
    created: { kind: 'today' }, due: { kind: 'before_today' }, mine: true, custom: 'x',
  }, { me: 'U1', today: '2026-09-11' });
  assert.deepEqual(ops, [
    { column: 'name', op: 'ilike', value: '%Acme  100%' },
    { column: 'status', op: 'in', value: ['new'] },
    { column: 'owner_id', op: 'eq', value: 'U1' },
    { column: 'value', op: 'gte', value: 10 },
    { column: 'created_at', op: 'gte', value: '2026-09-11T00:00:00+05:30' },
    { column: 'created_at', op: 'lt', value: '2026-09-12T00:00:00+05:30' },
    { column: 'due_date', op: 'lte', value: '2026-09-10' },
    { column: 'is_mine', op: 'eq', value: true },
  ]);
  assert.deepEqual(F.toOps(fields, { owner: 'none' }), [{ column: 'owner_id', op: 'is', value: null }]);
  assert.deepEqual(F.toOps(fields, { name: '', status: [], value: { from: '', to: '' }, created: { kind: '' } }), [], 'empty values add nothing');
});

test('filter chips read like the values', () => {
  const fields = [
    { key: 'status', title: 'Stage', type: 'multiselect', options: [{ value: 'new', label: 'New' }, { value: 'won', label: 'Won' }] },
    { key: 'owner', title: 'Responsible', type: 'user', options: [{ value: 'U2', label: 'Chitra' }] },
    { key: 'created', title: 'Created', type: 'date' },
  ];
  assert.deepEqual(F.chips(fields, { status: ['new', 'won'], owner: 'U2', created: { kind: 'this_week' } }).map(c => c.label),
    ['Stage: New, Won', 'Responsible: Chitra', 'Created: This week']);
  assert.deepEqual(F.chips(fields, { owner: 'me' }).map(c => c.label), ['Responsible: Me']);
});
