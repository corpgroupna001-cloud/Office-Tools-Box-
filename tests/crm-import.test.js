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

/* ======================= as the admin page sends it ======================= */

/** Headers as an earlier admin page sent them: lower-cased, words joined with _ ("deal_name"). */
const asPage = row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase().replace(/\s+/g, '_'), v]));

test('deal_name, deal name and Deal Name are the same column', () => {
  // source_row keeps whatever the headers were called, so it is left out of the comparison.
  const bare = out => out.rows.map(r => { const o = { ...r }; delete o.source_row; return o; });
  const raw = I.mapDeals([dealRow()], ctx());
  const sent = I.mapDeals([asPage(dealRow())], ctx());
  assert.equal(sent.skipped.length, 0, 'deal_name is Deal Name');
  assert.deepEqual(bare(sent), bare(raw));

  const lead = { 'ID': '2951', 'Stage': 'Good Lead', 'Lead Name': 'GL-EBS-USA-BGC-20260911001', 'Responsible': 'GL-PIS-CSM-IC-001', 'Total': '400.00', 'Currency': 'US Dollar' };
  const statuses = [{ key: 'new', label: 'New' }, { key: 'good_lead', label: 'Good Lead' }];
  // A fixed clock: a lead without a Created column is stamped with ctx.now.
  const leadsOf = rows => bare(I.mapLeads(rows, { statuses, profiles: PROFILES, now: '2026-09-15T08:00:00.000Z' }));
  assert.deepEqual(leadsOf([asPage(lead)]), leadsOf([lead]));
});

test('the responsible person is matched on Employee ID before the biometric ID', () => {
  const profiles = [
    { id: 'u-bio', employee_code: 'GL-EBS-ESM-SLE-001', full_name: 'Biometric Match' },
    { id: 'u-emp', employee_id: 'GL-EBS-ESM-SLE-001', employee_code: '00000123', full_name: 'Employee ID Match' },
  ];
  const d = I.mapDeals([dealRow({ Responsible: 'GL-EBS-ESM-SLE-001' })], { ...ctx(), profiles }).rows[0];
  assert.equal(d.owner_id, 'u-emp');
  const [cells] = I.exportCells('deals', [{ ...d, id: 'x', stage_id: 's-won' }], ['Responsible'], { people: new Map(profiles.map(p => [p.id, p])) });
  assert.deepEqual(cells, ['GL-EBS-ESM-SLE-001'], 'and exported as that Employee ID');
});

test('a Bitrix lead keeps its value, referrer and the person\'s details', () => {
  const row = asPage({
    'ID': '2937', 'Stage': 'Good Lead', 'Lead Name': 'GL-PIS-IS-20260903008', 'Source': 'Referral',
    'Total': '50.00', 'Currency': 'US Dollar', 'Referrer': 'Abdu School', 'Position': 'Share Point Developer',
    'First Name': 'Robel', 'Last Name': 'Geleta', 'Work Experience': '7.5', 'VISA': 'US Citizen',
    'Commnuication Skills': '6-8', 'Gender': 'Male', 'Comment': '[p]\n// looking for interview support\n[/p]',
  });
  const l = I.mapLeads([row], { statuses: [{ key: 'new', label: 'New' }, { key: 'good_lead', label: 'Good Lead' }], profiles: [] }).rows[0];
  assert.equal(l.estimated_value, 50, 'from Total');
  assert.equal(l.source_detail, 'Abdu School');
  assert.equal(l.status, 'good_lead');
  assert.equal(l.notes, '// looking for interview support\n\nName: Robel Geleta\nPosition: Share Point Developer\nWork experience: 7.5\nVisa: US Citizen\nCommunication skills: 6-8');
});

test('lead stages: ours by key, label or synonym, and the rest named for creation', () => {
  const statuses = [{ key: 'new', label: 'New' }, { key: 'unqualified', label: 'Unqualified' }, { key: 'need_to_explain', label: 'Explain' }];
  assert.equal(I.leadStatusFor('Junk Lead', statuses), 'unqualified');
  assert.equal(I.leadStatusFor('Need to Explain', statuses), 'need_to_explain');
  assert.equal(I.leadStatusFor('new', statuses), 'new');
  assert.equal(I.leadStatusFor('Long Hold', statuses), null);
  assert.equal(I.leadStatusFor('In process', statuses), null, 'a synonym for a status this workspace lacks');
  assert.equal(I.statusKey('Follow Up '), 'follow_up');
  assert.deepEqual(I.scanLeads([{ Stage: 'Good Lead' }, { stage: 'good lead' }, { Stage: 'Hold' }, { Stage: '' }]), ['Good Lead', 'Hold']);
});

/* ======================= the endpoint ======================= */

test('the endpoint creates missing lead stages and finds contacts past the first 1,000', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const sessions = require('../lib/admin-session');
  const env = { ADMIN_PASSWORD: 'pw', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_URL: 'https://db.example.test' };
  const db = {
    profiles: PROFILES,
    crm_lead_statuses: [{ key: 'new', label: 'New', sort_order: 1 }, { key: 'unqualified', label: 'Unqualified', sort_order: 2 }],
    crm_pipelines: [], crm_pipeline_stages: [], crm_deals: [], crm_leads: [], crm_import_layouts: [],
    crm_contacts: Array.from({ length: 1500 }, (_, i) => ({ id: 'c' + i, email: `c${i}@example.test`, phone: null, full_name: 'C ' + i })),
  };
  let n = 0;
  const fakeFetch = async (url, opts = {}) => {
    const u = new URL(url), rows = db[u.pathname.split('/').pop()], h = opts.headers || {};
    if (!opts.method) {                              // reads stop at 1,000 rows, as Supabase's do
      const eq = [...u.searchParams].filter(([k, v]) => /^eq\./.test(v)).map(([k, v]) => [k, v.slice(3)]);
      const found = rows.filter(r => eq.every(([k, v]) => String(r[k]) === v));
      const [from, to] = (h.Range || '0-999').split('-').map(Number);
      return new Response(JSON.stringify(found.slice(from, Math.min(to, from + 999) + 1)), { status: 200, headers: { 'content-range': `${from}-${to}/${found.length}` } });
    }
    const key = u.searchParams.get('on_conflict');
    const back = [];
    const sent = [].concat(JSON.parse(opts.body));
    const shape = o => Object.keys(o).sort().join(',');
    if (sent.some(o => shape(o) !== shape(sent[0]))) {                 // as PostgREST does
      return new Response(JSON.stringify({ code: 'PGRST102', message: 'All object keys must match' }), { status: 400 });
    }
    [].concat(JSON.parse(opts.body)).forEach(b => {
      const had = key && rows.find(r => r[key] != null && r[key] === b[key]);
      if (had) { if (!/ignore-duplicates/.test(h.Prefer)) back.push(Object.assign(had, b)); return; }
      const row = { id: 'n' + n++, ...b };
      rows.push(row); back.push(row);
    });
    return new Response(JSON.stringify(back), { status: 201 });
  };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/admin.js'), 'utf8'), {
    module: mod, process: { env }, console, URL, Date, setTimeout: cb => cb(), fetch: fakeFetch,
    require(name) {
      if (name === '../lib/request-auth') return require('../lib/request-auth');
      if (name === '../lib/admin-session') return sessions;
      if (name === '../lib/admin-audit') return { auditWrap: r => r };
      if (name === '../lib/crm-import' || name === '../company-config') return require(name);
      return {};
    },
  });
  const call = async (body, cookie = '') => {
    const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await mod.exports({ method: 'POST', headers: { host: 'x.example.test', cookie }, body }, res);
    return res;
  };
  const cookie = (await call({ action: 'login', password: 'pw' })).headers['Set-Cookie'].split(';')[0];

  const leads = [{ ID: '1', Stage: 'Good Lead', 'Lead Name': 'A' }, { ID: '2', Stage: 'Junk Lead', 'Lead Name': 'B' }, { ID: '3', Stage: 'Long Hold', 'Lead Name': 'C' }].map(asPage);
  for (let i = 0; i < 2; i++) {
    const r = await call({ action: 'import_crm', kind: 'leads', rows: leads }, cookie);
    assert.equal(r.code, 200);
    assert.equal(r.body.statuses_created, i === 0 ? 2 : 0, 'Good Lead and Long Hold; Junk Lead is Unqualified');
  }
  assert.deepEqual(db.crm_leads.map(l => l.status), ['good_lead', 'unqualified', 'long_hold']);
  assert.equal(db.crm_lead_statuses.find(s => s.key === 'long_hold').label, 'Long Hold');

  // A batch where one deal names a contact and the next names nobody.
  const noContact = dealRow({ ID: '17640', 'Contact': '', 'Contact: First name': '', 'Contact: Mobile': '', 'Contact: Work E-mail': '' });
  const mixed = await call({ action: 'import_crm', kind: 'deals', rows: [dealRow({ ID: '17641', 'Contact: Work E-mail': 'c1401@example.test' }), noContact] }, cookie);
  assert.equal(mixed.code, 200, JSON.stringify(mixed.body));
  assert.equal(mixed.body.matched, 2);
  assert.deepEqual(db.crm_deals.map(d => d.contact_id), ['c1401', null]);
  db.crm_deals.length = 0;

  const deal = dealRow({ 'Contact: Work E-mail': 'c1400@example.test' });
  const r = await call({ action: 'import_crm', kind: 'deals', rows: [deal] }, cookie);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.contacts_created, 0, 'contact 1,400 is found, not made again');
  assert.equal(db.crm_deals[0].contact_id, 'c1400');
  assert.equal(db.crm_deals[0].source_row['Contact: Work E-mail'], 'c1400@example.test', 'the row as the file had it');

  // The file's columns are kept once, in order, however many batches repeat them.
  const cols = ['ID', 'Pipeline', 'Stage', 'Deal Name', 'Weekday'];
  await call({ action: 'import_crm', kind: 'deals', rows: [deal], headers: cols }, cookie);
  await call({ action: 'import_crm', kind: 'deals', rows: [deal], headers: cols.concat('Duration') }, cookie);
  assert.deepEqual(db.crm_import_layouts, [{ id: db.crm_import_layouts[0].id, entity: 'deal', headers: cols.concat('Duration'), updated_at: db.crm_import_layouts[0].updated_at }]);

  // And the console reads the deal back in those columns.
  const list = await call({ action: 'crm_records', kind: 'deals', lookups: true }, cookie);
  assert.equal(list.code, 200);
  assert.deepEqual(list.body.headers, cols.concat('Duration'));
  assert.deepEqual(list.body.rows[0].cells, ['17639', 'Proxy Interview Supports', 'Semi Deal', 'JW-RMS-IS-202609011001', '', '']);
  assert.equal(list.body.total, 1);
  assert.ok(list.body.lookups.stages.some(x => x.name === 'Semi Deal'));
});

/* ======================= back out, in the file's format ======================= */

const exportCtx = () => ({
  pipelines: new Map([PIPE_A, PIPE_D].map(p => [p.id, p])),
  stages: new Map(STAGES.map(s => [s.id, s])),
  statuses: new Map([['new', { key: 'new', label: 'New' }], ['good_lead', { key: 'good_lead', label: 'Good Lead' }]]),
  people: new Map(PROFILES.map(p => [p.id, p])),
});
const HEADERS = ['ID', 'Pipeline', 'Stage', 'Responsible', 'Deal Name', 'Income', 'Currency', 'Probability', 'Created', 'Assumed close date', 'Comment', 'Contact: Mobile', 'Weekday'];

test('an imported deal exports exactly as its row was written', () => {
  const row = dealRow({ Weekday: 'Monday' });
  const d = I.mapDeals([row], ctx()).rows[0];
  const record = { ...d, id: 'uuid-1', created_at: '2026-09-11T21:41:57+00:00' };
  const [cells] = I.exportCells('deals', [record], HEADERS, exportCtx());
  assert.deepEqual(cells, HEADERS.map(h => row[h] || ''), 'blank stays blank: no probability or comment is invented');
});

test('a deal changed in WorkSuite exports as it is now', () => {
  const d = I.mapDeals([dealRow()], ctx()).rows[0];
  const moved = { ...d, id: 'uuid-1', stage_id: 's-won', value: 250, owner_id: 'u-ic', title: 'Renamed', expected_close_date: '2026-10-01', currency: 'INR' };
  const [cells] = I.exportCells('deals', [moved], HEADERS, exportCtx());
  const at = h => cells[HEADERS.indexOf(h)];
  assert.deepEqual([at('Stage'), at('Income'), at('Responsible'), at('Deal Name'), at('Assumed close date'), at('Currency')],
    ['Deal won', '250.00', 'GL-PIS-CSM-IC-001', 'Renamed', '01.10.2026', 'Indian Rupee']);
  assert.equal(at('Contact: Mobile'), '+13144719534', 'the rest of the row is untouched');
});

test('a deal made in WorkSuite fills the export\'s columns from its own fields', () => {
  const native = { id: 'uuid-2', title: 'Gym kit', pipeline_id: 'p-acc', stage_id: 'a-adv', value: 90000, currency: 'INR', owner_id: 'u-om',
    probability: 20, created_at: '2026-09-15T04:48:00Z', expected_close_date: null, description: 'Ten sets', source_row: null };
  const [cells] = I.exportCells('deals', [native], HEADERS, exportCtx());
  assert.deepEqual(cells, ['uuid-2', 'Accounts', 'Receive Advance Payments', 'JW-RMS-OM-OM-001', 'Gym kit', '90000.00', 'Indian Rupee', '20',
    '15.09.2026 10:18:00 am', '', 'Ten sets', '', '']);
});

test('a lead exports with its stage label and the file\'s own cells', () => {
  const row = { 'ID': '2951', 'Stage': 'Good Lead', 'Lead Name': 'GL-EBS-USA-BGC-20260911001', 'Created': '12.09.2026 12:41:48 am', 'Total': '400.00', 'Currency': 'US Dollar', 'Referrer': 'Sandeep Velocity', 'Comment': '[p]\n// He is looking for USA BGC\n[/p]' };
  const l = I.mapLeads([row], { statuses: [...exportCtx().statuses.values()], profiles: [] }).rows[0];
  const headers = ['ID', 'Stage', 'Lead Name', 'Created', 'Total', 'Currency', 'Comment', 'Referrer', 'Gender'];
  const [cells] = I.exportCells('leads', [{ ...l, id: 'uuid-3' }], headers, exportCtx());
  assert.deepEqual(cells, headers.map(h => row[h] || ''));
  const [moved] = I.exportCells('leads', [{ ...l, id: 'uuid-3', status: 'new' }], headers, exportCtx());
  assert.equal(moved[1], 'New');
});

test('export dates read like the file: day first, India time, am/pm', () => {
  assert.equal(I.isoDateTime('12.09.2026 12:41:48 am'), '2026-09-12T00:41:48+05:30');
  assert.equal(I.isoDateTime('10.09.2026 08:59:34 pm'), '2026-09-10T20:59:34+05:30');
  assert.equal(I.isoDateTime('12.09.2026'), '2026-09-12T00:00:00+05:30');
  assert.equal(I.isoDateTime('31.02.2026 13:00:00 pm'), null);
  assert.equal(I.exportDateTime('2026-09-11T19:11:48+00:00'), '12.09.2026 12:41:48 am');
  assert.equal(I.exportDateTime(I.isoDateTime('10.09.2026 12:05:00 pm')), '10.09.2026 12:05:00 pm');
  assert.equal(I.exportDate('2026-09-19'), '19.09.2026');
});

test('columns are merged in file order, each once', () => {
  assert.deepEqual(I.mergeHeaders(['ID', 'Stage'], ['\uFEFFID', 'Stage', 'Expert ', 'stage', '']), ['ID', 'Stage', 'Expert']);
  assert.deepEqual(I.sourceRow({ ' ID ': '1', Blank: '  ', Note: ' spaced ' }), { ID: '1', Note: ' spaced ' });
  assert.equal(I.sourceRow({ A: '' }), null);
});

test('a record whose responsible person is unknown takes the company chosen for the import', () => {
  const unknown = dealRow({ Responsible: 'NOBODY-001' });
  const known = dealRow({ ID: '2', Responsible: 'JW-RMS-OM-OM-001' });
  const out = I.mapDeals([unknown, known], { ...ctx(), company: 'Genie Lamp Private Limited' });
  assert.deepEqual(out.rows.map(r => r.company), ['Genie Lamp Private Limited', 'Jobways Point LLP'], "the responsible employee's company wins");
  assert.equal(out.contacts[0].company, 'Genie Lamp Private Limited');
  const lead = I.mapLeads([{ 'Lead Name': 'X', Responsible: 'NOBODY-001' }], { profiles: PROFILES, company: 'Jobways Point LLP' }).rows[0];
  assert.equal(lead.company, 'Jobways Point LLP');
});

test('the console counts CRM records nobody can see and gives them to a company', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const sessions = require('../lib/admin-session');
  const env = { ADMIN_PASSWORD: 'pw', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_URL: 'https://db.example.test' };
  const db = {
    crm_deals: [{ id: 'd1', company: null }, { id: 'd2', company: 'Jobways Point LLP' }, { id: 'd3', company: null }],
    crm_leads: [{ id: 'l1', company: null }],
    crm_contacts: [{ id: 'c1', company: 'Jobways Point LLP' }],
  };
  const fakeFetch = async (url, opts = {}) => {
    const u = new URL(url), rows = db[u.pathname.split('/').pop()];
    const hit = rows.filter(r => u.searchParams.get('company') !== 'is.null' || r.company == null);
    if (opts.method === 'PATCH') hit.forEach(r => Object.assign(r, JSON.parse(opts.body)));
    return new Response('[]', { status: 200, headers: { 'content-range': `0-0/${hit.length}` } });
  };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/admin.js'), 'utf8'), {
    module: mod, process: { env }, console, URL, Date, setTimeout: cb => cb(), fetch: fakeFetch,
    require(name) {
      if (name === '../lib/request-auth') return require('../lib/request-auth');
      if (name === '../lib/admin-session') return sessions;
      if (name === '../lib/admin-audit') return { auditWrap: r => r };
      if (name === '../lib/crm-import' || name === '../company-config') return require(name);
      return {};
    },
  });
  const call = async (body, cookie = '') => {
    const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await mod.exports({ method: 'POST', headers: { host: 'x.example.test', cookie }, body }, res);
    return res;
  };
  const cookie = (await call({ action: 'login', password: 'pw' })).headers['Set-Cookie'].split(';')[0];

  assert.deepEqual(JSON.parse(JSON.stringify((await call({ action: 'crm_unowned' }, cookie)).body)), { deals: 2, leads: 1, contacts: 0 });
  assert.equal((await call({ action: 'crm_fill_company', company: 'Made Up Ltd' }, cookie)).code, 400);
  const done = await call({ action: 'crm_fill_company', company: 'Genie Lamp Private Limited' }, cookie);
  assert.equal(done.code, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(done.body.updated)), { deals: 2, leads: 1, contacts: 0 });
  assert.deepEqual(db.crm_deals.map(d => d.company), ['Genie Lamp Private Limited', 'Jobways Point LLP', 'Genie Lamp Private Limited'], 'records that had a company keep it');
});
