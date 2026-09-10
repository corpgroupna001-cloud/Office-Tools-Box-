const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../ui/crm-logic');

/* ====== Dates (IST) ====== */

test('IST date and time are read off an Indian wall clock, not the machine clock', () => {
  // 2026-09-10 23:30 UTC is 05:00 on 11 Sep in IST
  assert.equal(L.istDate('2026-09-10T23:30:00Z'), '2026-09-11');
  assert.equal(L.istTime('2026-09-10T23:30:00Z'), '05:00');
  assert.equal(L.isoAtIST('2026-09-11', '05:00'), '2026-09-10T23:30:00.000Z');
  assert.equal(L.isoAtIST('2026-09-11'), '2026-09-10T18:30:00.000Z');
});

test('day arithmetic is timezone-free and knows weekdays', () => {
  assert.equal(L.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(L.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(L.daysBetween('2026-09-01', '2026-09-10'), 9);
  assert.equal(L.isoWeekday('2026-09-10'), 4, 'Thursday');
  assert.equal(L.isoWeekday('2026-09-13'), 7, 'Sunday');
  assert.equal(L.isoWeekday('2026-09-14'), 1, 'Monday');
  assert.equal(L.dayNumber('nonsense'), null);
});

test('date-range presets are inclusive and anchored on the IST day', () => {
  const now = new Date('2026-09-10T22:00:00Z');        // 11 Sep 03:30 IST, a Friday
  assert.deepEqual(L.dateRange('today', now), { from: '2026-09-11', to: '2026-09-11' });
  assert.deepEqual(L.dateRange('week', now), { from: '2026-09-07', to: '2026-09-13' });
  assert.deepEqual(L.dateRange('month', now), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(L.dateRange('quarter', now), { from: '2026-07-01', to: '2026-09-30' });
  assert.deepEqual(L.dateRange('year', now), { from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(L.dateRange('last7', now), { from: '2026-09-05', to: '2026-09-11' });
  assert.deepEqual(L.dateRange('custom', now, { from: '2026-09-20', to: '2026-09-01' }), { from: '2026-09-01', to: '2026-09-20' }, 'reversed custom bounds are swapped');
  assert.equal(L.dateRange('custom', now, { from: 'x', to: '2026-09-01' }), null);
  assert.equal(L.dateRange('bogus', now), null);
  const q1 = L.dateRange('quarter', new Date('2026-02-14T06:00:00Z'));
  assert.deepEqual(q1, { from: '2026-01-01', to: '2026-03-31' });
});

test('a date range converts to half-open ISO bounds for timestamptz filters', () => {
  const iso = L.rangeToIso({ from: '2026-09-01', to: '2026-09-30' });
  assert.equal(iso.from, '2026-08-31T18:30:00.000Z');
  assert.equal(iso.to, '2026-09-30T18:30:00.000Z', 'exclusive end is the start of the next IST day');
});

test('formatting helpers never throw on empty or bad input', () => {
  assert.equal(L.fmtDate(null), '');
  assert.equal(L.fmtDate('not a date'), '');
  assert.equal(L.fmtDate('2026-09-05'), '05 Sep 2026');
  assert.equal(L.fmtDate('2026-09-05', { short: true }), '05 Sep');
  assert.equal(L.fmtDateTime('2026-09-10T18:30:00Z'), '11 Sep 2026, 12:00 am');
  assert.equal(L.fmtTime('2026-09-10T09:05:00Z'), '2:35 pm');
  assert.equal(L.fmtRelative('2026-09-10T10:00:00Z', '2026-09-10T10:00:20Z'), 'just now');
  assert.equal(L.fmtRelative('2026-09-10T10:00:00Z', '2026-09-10T10:05:00Z'), '5m ago');
  assert.equal(L.fmtRelative('2026-09-10T10:00:00Z', '2026-09-10T13:00:00Z'), '3h ago');
  assert.equal(L.fmtRelative('2026-09-09T10:00:00Z', '2026-09-10T13:00:00Z'), 'yesterday');
  assert.equal(L.fmtRelative('2026-09-06T10:00:00Z', '2026-09-10T13:00:00Z'), '4d ago');
});

/* ====== Money & invoices ====== */

test('rounding is half-up to 2 places without binary drift', () => {
  assert.equal(L.round2(0.125), 0.13);
  assert.equal(L.round2(1.005), 1.01);
  assert.equal(L.round2(2.675), 2.68);
  assert.equal(L.round2(-1.005), -1.01);
  assert.equal(L.round2('abc'), 0);
});

test('an invoice line is computed the way the database trigger computes it', () => {
  const line = L.invoiceLine({ quantity: 3, unit_price: 1999.99, discount_pct: 10, tax_rate: 18 });
  assert.equal(line.line_subtotal, 5999.97);
  assert.equal(line.line_discount, 600.00);
  assert.equal(line.line_tax, 971.99, 'tax applies after the discount');
  assert.equal(line.line_total, 6371.96);
  const clamped = L.invoiceLine({ quantity: -2, unit_price: 100, discount_pct: 150, tax_rate: -5 });
  assert.deepEqual(clamped, { line_subtotal: 0, line_discount: 0, line_tax: 0, line_total: 0 });
});

test('invoice totals are sums of the lines and payments, and the balance follows', () => {
  const items = [
    { quantity: 2, unit_price: 500, discount_pct: 0, tax_rate: 18 },
    { quantity: 1, unit_price: 1000, discount_pct: 50, tax_rate: 0 },
    { quantity: 0.5, unit_price: 99.99, discount_pct: 0, tax_rate: 5 },
  ];
  const t = L.invoiceTotals(items, [{ amount: 500 }, { amount: 250.25 }]);
  assert.equal(t.subtotal, 2050, '49.995 rounds half-up to 50.00');
  assert.equal(t.discount_total, 500);
  assert.equal(t.tax_total, 182.5);
  assert.equal(t.total, 1732.5);
  assert.equal(t.amount_paid, 750.25);
  assert.equal(t.balance, 982.25);
  assert.deepEqual(L.invoiceTotals([], []), { subtotal: 0, discount_total: 0, tax_total: 0, total: 0, amount_paid: 0, balance: 0 });
});

test('the invoice status a reader sees depends on payments and the calendar', () => {
  const today = '2026-09-10';
  assert.equal(L.invoiceStatus({ status: 'draft' }, today), 'draft');
  assert.equal(L.invoiceStatus({ status: 'cancelled', total: 10, amount_paid: 10 }, today), 'cancelled');
  assert.equal(L.invoiceStatus({ status: 'sent', total: 100, amount_paid: 100 }, today), 'paid');
  assert.equal(L.invoiceStatus({ status: 'sent', total: 100, amount_paid: 40 }, today), 'partially_paid');
  assert.equal(L.invoiceStatus({ status: 'sent', total: 100, amount_paid: 0, due_date: '2026-09-09' }, today), 'overdue');
  assert.equal(L.invoiceStatus({ status: 'sent', total: 100, amount_paid: 0, due_date: '2026-09-10' }, today), 'sent', 'due today is not overdue');
  assert.equal(L.invoiceStatus({ status: 'overdue', total: 100, amount_paid: 0, due_date: '2026-09-30' }, today), 'sent', 'a moved due date clears overdue');
});

test('invoice actions follow the status', () => {
  assert.equal(L.invoiceActions('draft').edit, true);
  assert.equal(L.invoiceActions('sent').edit, false);
  assert.equal(L.invoiceActions('sent').pay, true);
  assert.equal(L.invoiceActions('paid').cancel, false);
  assert.equal(L.invoiceActions('cancelled').cancel, false);
  assert.equal(L.invoiceActions('overdue').revertToDraft, true);
});

test('money formats INR in lakhs and crores', () => {
  assert.equal(L.moneyShort(1250000), '₹12.5L');
  assert.equal(L.moneyShort(25000000), '₹2.5Cr');
  assert.equal(L.moneyShort(950), '₹950');
  assert.equal(L.moneyShort(4500), '₹4.5k');
  assert.equal(L.moneyShort(1500000, 'USD'), '$1.5M');
  assert.match(L.money(1234.5), /1,234\.50/);
});

/* ====== Deals & pipeline ====== */

test('pipeline value is the sum of open deals; weighted uses value x probability', () => {
  const deals = [
    { status: 'open', value: 1000, probability: 50, stage_id: 'a' },
    { status: 'open', value: 3000, probability: 25, stage_id: 'b' },
    { status: 'won', value: 800, probability: 100 },
    { status: 'lost', value: 200, probability: 0 },
    { status: 'open', value: 999, probability: 90, archived_at: '2026-01-01' },
  ];
  const m = L.pipelineMetrics(deals);
  assert.equal(m.open_count, 2);
  assert.equal(m.pipeline_value, 4000);
  assert.equal(m.weighted_value, 1250);
  assert.equal(m.won_count, 1); assert.equal(m.won_value, 800);
  assert.equal(m.lost_count, 1); assert.equal(m.lost_value, 200);
  assert.equal(m.win_rate, 50);
  assert.deepEqual(m.by_stage.a, { count: 1, value: 1000 });
  assert.equal(L.pipelineMetrics([]).win_rate, null, 'no closed deals means no rate, not 0%');
});

test('stages sort by position and the first open stage skips won/lost', () => {
  const stages = [
    { id: 'w', pipeline_id: 'p', position: 5, is_won: true }, { id: 'q', pipeline_id: 'p', position: 2 },
    { id: 'n', pipeline_id: 'p', position: 1 }, { id: 'x', pipeline_id: 'other', position: 0 },
  ];
  assert.deepEqual(L.stagesOf(stages, 'p').map(s => s.id), ['n', 'q', 'w']);
  assert.equal(L.firstOpenStage(stages, 'p').id, 'n');
  assert.equal(L.firstOpenStage([{ id: 'w', pipeline_id: 'p', position: 1, is_won: true }], 'p'), null);
});

test('drag-and-drop positions land between neighbours', () => {
  assert.equal(L.positionBetween(null, null), 1000);
  assert.equal(L.positionBetween(1000, null), 2000);
  assert.equal(L.positionBetween(null, 1000), 0);
  assert.equal(L.positionBetween(1000, 2000), 1500);
});

/* ====== Leads & contacts ====== */

test('lead metrics count open, qualified, converted and the conversion rate', () => {
  const statuses = [{ key: 'new' }, { key: 'contacted' }, { key: 'qualified' }, { key: 'unqualified', is_closed: true }, { key: 'converted', is_closed: true, is_converted: true }];
  const leads = [
    { status: 'new' }, { status: 'contacted' }, { status: 'qualified' }, { status: 'unqualified' },
    { status: 'converted', converted_at: 'x' }, { status: 'new', archived_at: 'x' },
  ];
  const m = L.leadMetrics(leads, statuses);
  assert.equal(m.total, 5);
  assert.equal(m.open, 3);
  assert.equal(m.qualified, 1);
  assert.equal(m.converted, 1);
  assert.equal(m.unqualified, 1);
  assert.equal(m.conversion_rate, 20);
});

test('phone and email normalisation make duplicate detection forgiving', () => {
  assert.equal(L.normalizePhone('+91 98765 43210'), '9876543210');
  assert.equal(L.normalizePhone('098765-43210'), '9876543210');
  assert.equal(L.normalizePhone('9876543210'), '9876543210');
  assert.equal(L.normalizePhone('+1 (415) 555-0100'), '14155550100');
  assert.equal(L.normalizePhone(''), null);
  assert.equal(L.normalizeEmail('  Ravi@Example.COM '), 'ravi@example.com');
});

test('duplicate contacts are found by email or phone, ignoring archived ones and self', () => {
  const contacts = [
    { id: '1', email: 'ravi@example.com', phone: '+91 98765 43210' },
    { id: '2', email: 'other@example.com', phone: '111', status: 'archived' },
    { id: '3', email2: 'x@example.com', phone2: '9876543210' },
  ];
  const d = L.findDuplicateContacts({ email: 'RAVI@example.com' }, contacts);
  assert.deepEqual(d.map(c => c.id), ['1']);
  const p = L.findDuplicateContacts({ phone: '098765-43210' }, contacts);
  assert.deepEqual(p.map(c => c.id), ['1', '3']);
  assert.deepEqual(L.findDuplicateContacts({ phone: '098765-43210' }, contacts, '1').map(c => c.id), ['3']);
  assert.deepEqual(L.findDuplicateContacts({ phone: '111' }, contacts), [], 'archived contacts are not duplicates');
  assert.deepEqual(L.findDuplicateContacts({}, contacts), []);
});

test('lead conversion links an existing contact rather than duplicating it, and keeps the value', () => {
  const contacts = [{ id: 'c1', email: 'lead@example.com' }];
  const lead = { name: 'Priya Sharma', email: 'lead@example.com', organization: 'Acme', estimated_value: 50000 };
  const plan = L.planLeadConversion(lead, contacts);
  assert.deepEqual(plan.contact, { action: 'link', id: 'c1' });
  assert.equal(plan.deal.title, 'Priya Sharma deal');
  assert.equal(plan.deal.value, 50000);
  assert.equal(plan.duplicates.length, 1);

  const fresh = L.planLeadConversion({ name: 'Solo', phone: '123' }, contacts, { createDeal: false });
  assert.equal(fresh.contact.action, 'create');
  assert.equal(fresh.contact.first_name, 'Solo');
  assert.equal(fresh.contact.last_name, '');
  assert.equal(fresh.deal, null);
  assert.deepEqual(L.splitName('  Anita   Rao Kumar '), { first_name: 'Anita', last_name: 'Rao Kumar' });
});

/* ====== Tasks & projects ====== */

test('task due state distinguishes overdue, today, soon and upcoming, and completed wins', () => {
  const today = '2026-09-10';
  assert.equal(L.taskDueState({ due_date: '2026-09-09' }, today), 'overdue');
  assert.equal(L.taskDueState({ due_date: '2026-09-10' }, today), 'today');
  assert.equal(L.taskDueState({ due_date: '2026-09-12' }, today), 'soon');
  assert.equal(L.taskDueState({ due_date: '2026-09-30' }, today), 'upcoming');
  assert.equal(L.taskDueState({ due_date: '2026-09-01', completed_at: 'x' }, today), 'completed');
  assert.equal(L.taskDueState({}, today), 'none');
});

test('the tasks badge counts overdue plus due today, open tasks only', () => {
  const today = '2026-09-10';
  const tasks = [
    { due_date: '2026-09-01' }, { due_date: '2026-09-10' }, { due_date: '2026-09-10', completed_at: 'x' },
    { due_date: '2026-09-11' }, { due_date: '2026-09-01', archived_at: 'x' }, { status: 'blocked' },
  ];
  assert.equal(L.taskBadgeCount(tasks, today), 2);
  const c = L.taskCounts(tasks, today);
  assert.equal(c.total, 5); assert.equal(c.open, 4); assert.equal(c.completed, 1);
  assert.equal(c.overdue, 1); assert.equal(c.due_today, 1); assert.equal(c.due_soon, 1); assert.equal(c.blocked, 1);
});

test('project progress is derived from completed tasks', () => {
  assert.deepEqual(L.projectProgress([]), { total: 0, done: 0, pct: 0 });
  assert.deepEqual(L.projectProgress([{ completed_at: 'x' }, {}, {}, { completed_at: 'x', archived_at: 'x' }]), { total: 3, done: 1, pct: 33 });
});

/* ====== Permissions ====== */

test('edit rights follow ownership, assignment and membership; managers edit everything', () => {
  const me = { id: 'u1', role: 'employee' };
  assert.equal(L.canEdit({ owner_id: 'u1' }, me), true);
  assert.equal(L.canEdit({ created_by: 'u1' }, me), true);
  assert.equal(L.canEdit({ assignee_id: 'u1' }, me), true);
  assert.equal(L.canEdit({ member_ids: ['u9', 'u1'] }, me), true);
  assert.equal(L.canEdit({ owner_id: 'u2' }, me), false);
  assert.equal(L.canEdit({ owner_id: 'u2' }, { id: 'u1', role: 'manager' }), true);
  assert.equal(L.canEdit(null, me), false);
  assert.equal(L.canDelete({ created_by: 'u2' }, me), false);
  assert.equal(L.canDelete({ created_by: 'u1' }, me), true);
  assert.equal(L.canFinance(me), false);
  assert.equal(L.canFinance({ id: 'x', role: 'manager' }), true);
});

test('private HR data is visible to yourself, your manager, company managers and admins only', () => {
  const target = { id: 't', company: 'Nova Sportsmart Private Limited', manager_id: 'boss' };
  assert.equal(L.canSeePrivate({ id: 't', role: 'employee' }, target), true);
  assert.equal(L.canSeePrivate({ id: 'boss', role: 'employee' }, target), true);
  assert.equal(L.canSeePrivate({ id: 'peer', role: 'employee', company: target.company }, target), false);
  assert.equal(L.canSeePrivate({ id: 'm', role: 'manager', company: target.company }, target), true);
  assert.equal(L.canSeePrivate({ id: 'm', role: 'manager', company: 'Jobways Point LLP' }, target), false);
  assert.equal(L.canSeePrivate({ id: 'm', role: 'manager', company: 'Jobways Point LLP', company2: target.company }, target), true);
  assert.equal(L.canSeePrivate({ id: 'a', role: 'admin' }, target), true);
});

/* ====== Search, files, activity ====== */

test('fuzzy scoring ranks exact, prefix, substring and subsequence in that order', () => {
  assert.equal(L.fuzzyScore('', 'anything'), 1);
  assert.equal(L.fuzzyScore('acme', 'Acme'), 100);
  assert.equal(L.fuzzyScore('ac', 'Acme Corp'), 80);
  assert.equal(L.fuzzyScore('corp', 'Acme Corp'), 50);
  assert.ok(L.fuzzyScore('acp', 'Acme Corp') > 10);
  assert.equal(L.fuzzyScore('zzz', 'Acme Corp'), 0);
  assert.equal(L.initials('Priya Sharma'), 'PS');
  assert.equal(L.initials('Solo'), 'S');
  assert.deepEqual(L.parseTags('vip, retail ,, vip\nnorth'), ['vip', 'retail', 'north']);
});

test('upload validation trusts sniffed content over the declared type and caps size', () => {
  assert.equal(L.safeFileName('../../My Report (final).PDF'), 'My-Report-final-.PDF');
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
  assert.equal(L.sniffMime(pdfBytes), 'application/pdf');
  assert.equal(L.sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 'image/png');
  const ok = L.validateUpload({ name: 'a.pdf', size: 1000, type: 'application/pdf' }, 'application/pdf');
  assert.equal(ok.ok, true); assert.equal(ok.mime, 'application/pdf');
  const spoof = L.validateUpload({ name: 'a.pdf', size: 1000, type: 'application/pdf' }, 'image/png');
  assert.equal(spoof.ok, false, 'a PNG renamed to .pdf is refused');
  const exe = L.validateUpload({ name: 'run.exe', size: 1000, type: 'application/x-msdownload' }, null);
  assert.equal(exe.ok, false);
  const big = L.validateUpload({ name: 'a.pdf', size: 60 * 1024 * 1024, type: 'application/pdf' }, 'application/pdf');
  assert.equal(big.ok, false);
  const docx = L.validateUpload({ name: 'a.docx', size: 10, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, 'application/zip');
  assert.equal(docx.ok, true, 'Office files are zip containers');
  assert.equal(L.fmtBytes(1536), '1.5 KB');
});

test('activity rows read as a sentence with the meaningful detail', () => {
  assert.deepEqual(L.describeActivity({ action: 'deal.stage_changed', meta: { from: 'Proposal', to: 'Negotiation' } }), { verb: 'moved the deal', detail: 'Proposal → Negotiation' });
  assert.equal(L.describeActivity({ action: 'invoice.payment_recorded', meta: { amount: 500, currency: 'INR', method: 'UPI' } }).detail.includes('via UPI'), true);
  assert.equal(L.describeActivity({ action: 'something.new', meta: {} }).verb, 'something new');
});
