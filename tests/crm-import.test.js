// Importing deals and leads: the mapping from a spreadsheet to rows
// WorkSuite can store. The rows below are shaped like a real Bitrix24
// export — its column names, "US Dollar", 12.09.2026 dates, an employee
// code for the responsible person and [p] tags in comments.
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../lib/crm-import');

const PIPE_A = { id: 'p-proxy', name: 'Proxy Interview Supports', is_default: false };
const PIPE_D = { id: 'p-acc', name: 'Accounts', is_default: true };
const STAGES = [
  { id: 's-semi', pipeline_id: 'p-proxy', name: 'Semi Deal', position: 1, probability: 40, is_won: false, is_lost: false },
  { id: 's-won', pipeline_id: 'p-proxy', name: 'Deal won', position: 2, probability: 100, is_won: true, is_lost: false },
  { id: 's-lost', pipeline_id: 'p-proxy', name: 'Deal lost', position: 3, probability: 0, is_won: false, is_lost: true },
  { id: 'a-adv', pipeline_id: 'p-acc', name: 'Receive Advance Payments', position: 1, probability: 20, is_won: false, is_lost: false },
];
const PROFILES = [
  { id: 'u-om', email: 'om@jobways.test', full_name: 'Vinay Sirimilla', employee_code: 'JW-RMS-OM-OM-001', company: 'Jobways Point LLP' },
  { id: 'u-ic', email: 'ic@genie.test', full_name: 'Kemi Ade', employee_code: 'GL-PIS-CSM-IC-001', company: 'Genie Lamp Private Limited' },
];
const ctx = () => ({ pipelines: [PIPE_A, PIPE_D], stages: STAGES, profiles: PROFILES, defaultCurrency: 'INR', source: 'bitrix' });

/** One row as the export gives it. */
const dealRow = (extra = {}) => ({
  'ID': '17639',
  'Pipeline': 'Proxy Interview Supports',
  'Stage': 'Semi Deal',
  'Deal Name': 'JW-RMS-IS-202609011001',
  'Type': 'Resume Marketing Service - Interview Support',
  'Income': '1.00',
  'Currency': 'US Dollar',
  'Responsible': 'JW-RMS-OM-OM-001',
  'Contact': 'Robel Geleta',
  'Closed': 'no',
  'Created': '12.09.2026 03:11:57 am',
  'Start date': '12.09.2026',
  'Assumed close date': '19.09.2026',
  'Comment': '[p]\n// Initial interview completed\n[/p]',
  'Contact: First name': 'Robel Geleta',
  'Contact: Mobile': '+13144719534',
  'Contact: Work E-mail': 'geletarobel@gmail.com',
  ...extra,
});

/* ======================= the pieces ======================= */

test('dates come out as the day they name, whichever way they are written', () => {
  assert.equal(I.isoDate('12.09.2026'), '2026-09-12');
  assert.equal(I.isoDate('12.09.2026 03:11:57 am'), '2026-09-12');
  assert.equal(I.isoDate('2026-09-12'), '2026-09-12');
  assert.equal(I.isoDate('01/02/2026'), '2026-02-01', 'day first, as the export writes it');
  assert.equal(I.isoDate(''), null);
  assert.equal(I.isoDate('not a date'), null);
});

test('money survives currency signs and both decimal styles', () => {
  assert.equal(I.money('1.00'), 1);
  assert.equal(I.money('50.00'), 50);
  assert.equal(I.money('$1,234.56'), 1234.56);
  assert.equal(I.money('1.234,56'), 1234.56);
  assert.equal(I.money(''), null);
});

test('currency words become codes; a code stays; anything else falls back', () => {
  assert.equal(I.currencyCode('US Dollar', 'INR'), 'USD');
  assert.equal(I.currencyCode('Indian Rupee', 'USD'), 'INR');
  assert.equal(I.currencyCode('eur', 'INR'), 'EUR');
  assert.equal(I.currencyCode('Martian Credit', 'INR'), 'INR');
  assert.equal(I.currencyCode('', 'INR'), 'INR');
});

test('comments lose their [p] tags but keep their lines', () => {
  assert.equal(I.stripTags('[p]\n// Initial interview completed\n[/p]'), '// Initial interview completed');
  assert.equal(I.stripTags('one[br]two'), 'one\ntwo');
  assert.equal(I.stripTags(''), null);
});

test('a single name field is split into first and last', () => {
  assert.deepEqual(I.splitName('Robel Geleta'), { first_name: 'Robel', last_name: 'Geleta' });
  assert.deepEqual(I.splitName('Onaopemipo Kemi Ade'), { first_name: 'Onaopemipo Kemi', last_name: 'Ade' });
  assert.deepEqual(I.splitName('Madonna'), { first_name: 'Madonna', last_name: null });
});

/* ======================= deals ======================= */

test('a Bitrix deal row becomes a WorkSuite deal', () => {
  const out = I.mapDeals([dealRow()], ctx());
  assert.equal(out.skipped.length, 0);
  assert.equal(out.rows.length, 1);
  const d = out.rows[0];
  assert.equal(d.title, 'JW-RMS-IS-202609011001');
  assert.equal(d.value, 1);
  assert.equal(d.currency, 'USD');
  assert.equal(d.pipeline_id, 'p-proxy');
  assert.equal(d.stage_id, 's-semi');
  assert.equal(d.status, 'open');
  assert.equal(d.probability, 40, 'taken from the stage when the file does not say');
  assert.equal(d.expected_close_date, '2026-09-19', 'from "Assumed close date"');
  assert.equal(d.owner_id, 'u-om', 'matched by employee code');
  assert.equal(d.company, 'Jobways Point LLP', 'the owner\'s company, when the file does not name one');
  assert.equal(d.external_ref, 'bitrix:deal:17639');
  assert.match(d.description, /Initial interview completed/);
  assert.match(d.description, /Type: Resume Marketing Service/);
});

test('won and lost stages set the deal\'s status', () => {
  const won = I.mapDeals([dealRow({ Stage: 'Deal won' })], ctx()).rows[0];
  assert.deepEqual({ s: won.status, p: won.probability }, { s: 'won', p: 100 });
  const lost = I.mapDeals([dealRow({ Stage: 'Deal lost' })], ctx()).rows[0];
  assert.equal(lost.status, 'lost');
});

test('the contact on the row comes back to be created or linked', () => {
  const out = I.mapDeals([dealRow()], ctx());
  assert.equal(out.contacts.length, 1);
  assert.deepEqual(
    { f: out.contacts[0].first_name, l: out.contacts[0].last_name, e: out.contacts[0].email, p: out.contacts[0].phone },
    { f: 'Robel', l: 'Geleta', e: 'geletarobel@gmail.com', p: '+13144719534' },
  );
  // Explicit first / last columns win over the display name.
  const named = I.mapDeals([dealRow({ 'Contact: First name': 'Onaopemipo', 'Contact: Last name': 'Kemi' })], ctx());
  assert.deepEqual({ f: named.contacts[0].first_name, l: named.contacts[0].last_name }, { f: 'Onaopemipo', l: 'Kemi' });
  // Nothing about a contact: nothing to create.
  const bare = I.mapDeals([dealRow({ 'Contact': '', 'Contact: First name': '', 'Contact: Mobile': '', 'Contact: Work E-mail': '' })], ctx());
  assert.equal(bare.contacts.length, 0);
});

test('an unknown pipeline or stage lands somewhere sensible and says so', () => {
  const out = I.mapDeals([dealRow({ Pipeline: 'Nowhere Ltd', Stage: 'Mystery' })], ctx());
  assert.equal(out.rows[0].pipeline_id, 'p-acc', 'the default pipeline');
  assert.equal(out.rows[0].stage_id, 'a-adv', 'its first stage');
  assert.equal(out.warnings.length, 2);
  assert.match(out.warnings.join(' '), /Nowhere Ltd/);
  assert.match(out.warnings.join(' '), /Mystery/);
});

test('the same remark about thousands of rows is reported once', () => {
  const many = Array.from({ length: 500 }, () => dealRow({ Pipeline: 'Nowhere Ltd', Stage: 'Mystery' }));
  const out = I.mapDeals(many, ctx());
  assert.equal(out.rows.length, 500);
  assert.equal(out.warnings.length, 2, 'one about the pipeline, one about the stage');
  assert.equal(new Set(out.warnings).size, out.warnings.length);

  const leads = I.mapLeads(Array.from({ length: 200 }, (_, i) => ({ name: 'L' + i, status: 'Some Custom Stage' })), { statuses: ['new'], profiles: [] });
  assert.equal(leads.warnings.length, 1);
});

test('a row with no deal name is skipped, with its line number', () => {
  const out = I.mapDeals([dealRow(), dealRow({ 'Deal Name': '' })], ctx());
  assert.equal(out.rows.length, 1);
  assert.deepEqual(out.skipped, [{ row: 3, why: 'no deal name' }]);
});

test('plain headers work as well as the export\'s own', () => {
  const out = I.mapDeals([{ title: 'Gym kit', value: '90000', currency: 'INR', pipeline: 'Accounts', stage: 'Receive Advance Payments', owner_email: 'ic@genie.test', 'close date': '2026-10-15' }], ctx());
  const d = out.rows[0];
  assert.deepEqual(
    { t: d.title, v: d.value, c: d.currency, p: d.pipeline_id, s: d.stage_id, o: d.owner_id, dt: d.expected_close_date },
    { t: 'Gym kit', v: 90000, c: 'INR', p: 'p-acc', s: 'a-adv', o: 'u-ic', dt: '2026-10-15' },
  );
});

test('a file says which pipelines and stages it needs', () => {
  const found = I.scanDeals([dealRow(), dealRow({ Stage: 'Deal won' }), dealRow({ Pipeline: 'Accounts', Stage: 'Payroll' })]);
  const proxy = found.find(p => p.name === 'Proxy Interview Supports');
  assert.deepEqual(proxy.stages.sort(), ['Deal won', 'Semi Deal']);
  assert.deepEqual(found.find(p => p.name === 'Accounts').stages, ['Payroll']);
});

test('a stage called won or lost is recognised when one has to be created', () => {
  assert.deepEqual(I.wonLost('Deal won'), { is_won: true, is_lost: false });
  assert.deepEqual(I.wonLost('Deal lost'), { is_won: false, is_lost: true });
  assert.deepEqual(I.wonLost('Semi Deal'), { is_won: false, is_lost: false });
});

/* ======================= leads ======================= */

test('a lead row becomes a WorkSuite lead, with its status translated', () => {
  const rows = [
    { 'ID': '901', 'Lead Name': 'Priya Nair', 'Status': 'In process', 'Responsible': 'GL-PIS-CSM-IC-001', 'E-mail': 'priya@example.com', 'Mobile': '+91 90000 00000', 'Company': 'Bluewave Fitness', 'Income': '50000', 'Currency': 'Indian Rupee', 'Source': 'Website', 'Comment': '[p]Asked for a quote[/p]' },
    { 'Lead Name': 'Junk one', 'Status': 'Junk' },
    { 'Status': 'New' },
  ];
  const out = I.mapLeads(rows, { statuses: ['new', 'contacted', 'qualified', 'unqualified', 'converted'], profiles: PROFILES, source: 'bitrix' });
  assert.deepEqual(out.skipped, [{ row: 4, why: 'no name' }]);
  const a = out.rows[0];
  assert.deepEqual(
    { n: a.name, s: a.status, o: a.owner_id, e: a.email, v: a.estimated_value, c: a.currency, org: a.organization, notes: a.notes, ref: a.external_ref },
    { n: 'Priya Nair', s: 'contacted', o: 'u-ic', e: 'priya@example.com', v: 50000, c: 'INR', org: 'Bluewave Fitness', notes: 'Asked for a quote', ref: 'bitrix:lead:901' },
  );
  assert.equal(out.rows[1].status, 'unqualified');
});

test('a lead status this workspace does not have falls back to new', () => {
  const out = I.mapLeads([{ name: 'X', status: 'Some Custom Stage' }], { statuses: ['new', 'contacted'], profiles: [] });
  assert.equal(out.rows[0].status, 'new');
  assert.match(out.warnings.join(' '), /Some Custom Stage/);
});
