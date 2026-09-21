// supabase-crm-sales-migration.sql on a real Postgres engine (PGlite): lost
// reasons, sales targets, quotes (DB-owned money, status rules, quote ->
// invoice) and public web-to-lead forms. Every check runs through RLS as a
// signed-in person, or as the anonymous role a public page uses.
//
// Skips itself when the dev dependency is missing: npm i -D @electric-sql/pglite
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, as, makeUser, pglite } = require('./fixtures/load-db');

const skip = pglite() ? false : 'PGlite is not installed (npm i -D @electric-sql/pglite)';
const NOVA = 'Nova Sportsmart Private Limited';
const JOBWAYS = 'Jobways Point LLP';
const RLS = /row-level security/;

let db, M, A, C, B;        // M Nova manager; A, C Nova employees; B Jobways employee
let pipe;                  // default pipeline: { id, open, won, lost }

const q = async (uid, sql, params) => (await as(db, uid, () => db.query(sql, params))).rows;
const svc = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (uid, sql, params) => (await q(uid, sql, params))[0];
const json = v => (typeof v === 'string' ? JSON.parse(v) : v);
async function anon(sql, params) {
  await db.exec('set role anon');
  try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); }
}
async function newDeal(uid, title, value = 0) {
  return one(uid, `insert into crm_deals (title, owner_id, pipeline_id, stage_id, value) values ($1, $2, $3, $4, $5) returning id, company`,
    [title, uid, pipe.id, pipe.open, value]);
}

test.before(async () => {
  if (skip) return;
  db = await freshDb({ twice: true });
  M = await makeUser(db, { email: 'maya@nova.test', name: 'Maya Manager', company: NOVA, role: 'manager' });
  A = await makeUser(db, { email: 'anil@nova.test', name: 'Anil Kumar', company: NOVA });
  C = await makeUser(db, { email: 'chitra@nova.test', name: 'Chitra Rao', company: NOVA });
  B = await makeUser(db, { email: 'bala@jobways.test', name: 'Bala J', company: JOBWAYS });
  const p = (await svc(`select id from crm_pipelines where is_default limit 1`))[0];
  const st = await svc(`select id, is_won, is_lost from crm_pipeline_stages where pipeline_id = $1 order by position`, [p.id]);
  pipe = { id: p.id, open: st.find(s => !s.is_won && !s.is_lost).id, won: st.find(s => s.is_won).id, lost: st.find(s => s.is_lost).id };
});

test('every table the file adds has RLS, and re-running it seeds the reasons once', { skip }, async () => {
  const noRls = await svc(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                            where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
  assert.deepEqual(noRls, []);
  const reasons = await q(A, `select label from crm_lost_reasons where company is null order by sort`);
  assert.equal(reasons.length, 8, 'the defaults, once, although the file ran twice');
  assert.equal(reasons[0].label, 'Price too high');
});

test('lost reasons: a settings permission to manage; kept on a lost deal, cleared when it reopens', { skip }, async () => {
  await assert.rejects(q(A, `insert into crm_lost_reasons (company, label) values ($1, 'Too slow')`, [NOVA]), RLS, 'employees have no CRM settings access');
  await q(M, `insert into crm_lost_reasons (company, label) values ($1, 'Went with in-house team')`, [NOVA]);
  assert.equal((await q(B, `select 1 from crm_lost_reasons where company = $1`, [NOVA])).length, 0, 'another company does not see it');

  const d = await newDeal(A, 'Stadium turf', 50000);
  const lost = await one(A, `update crm_deals set stage_id = $2, lost_reason = ' Price too high ', lost_reason_note = 'Asked for 20% off'
                               where id = $1 returning status, lost_reason, lost_reason_note`, [d.id, pipe.lost]);
  assert.deepEqual(lost, { status: 'lost', lost_reason: 'Price too high', lost_reason_note: 'Asked for 20% off' });
  const reopened = await one(A, `update crm_deals set stage_id = $2 where id = $1 returning status, lost_reason, lost_reason_note`, [d.id, pipe.open]);
  assert.deepEqual(reopened, { status: 'open', lost_reason: null, lost_reason_note: null });
  const open = await one(A, `update crm_deals set lost_reason = 'Other' where id = $1 returning lost_reason`, [d.id]);
  assert.equal(open.lost_reason, null, 'an open deal has no lost reason');
});

test('sales targets: managers set them, everyone in the company reads them', { skip }, async () => {
  const t = await one(M, `insert into crm_sales_targets (owner_id, period_start, amount) values ($1, '2026-09-01', 250000) returning company, created_by`, [A]);
  assert.deepEqual(t, { company: NOVA, created_by: M });
  await one(M, `insert into crm_sales_targets (period_start, amount) values ('2026-09-01', 1000000) returning id`);
  assert.equal((await q(A, `select amount from crm_sales_targets order by amount`)).length, 2);
  assert.equal((await q(B, `select 1 from crm_sales_targets`)).length, 0);
  await assert.rejects(q(A, `insert into crm_sales_targets (owner_id, period_start, amount) values ($1, '2026-10-01', 1)`, [A]), RLS);
  assert.equal((await q(A, `update crm_sales_targets set amount = 1 returning id`)).length, 0);
  await assert.rejects(q(M, `insert into crm_sales_targets (period_start, amount) values ('2026-09-15', 1)`), /crm_sales_targets_ck/, 'a month starts on the 1st');
  await assert.rejects(q(M, `insert into crm_sales_targets (owner_id, period_start, amount) values ($1, '2026-09-01', 5)`, [A]), /duplicate key/, 'one target per person per month');
});

test('quotes: made from a deal, numbered per company, totals computed by the database', { skip }, async () => {
  const d = await newDeal(A, 'Academy kit', 12000);
  const id = (await one(A, `select public.crm_quote_from_deal($1) id`, [d.id])).id;
  const qt = await one(A, `select quote_number, company, status, currency, total, responsible_id, bill_to_name, valid_until - quote_date days from crm_quotes where id = $1`, [id]);
  assert.match(qt.quote_number, /^Q-\d{4}-0001$/);
  assert.equal(qt.company, NOVA);
  assert.equal(qt.status, 'draft');
  assert.equal(Number(qt.total), 12000, 'a deal without products becomes one line for its amount');
  assert.equal(qt.responsible_id, A);
  assert.equal(qt.bill_to_name, 'Academy kit');
  assert.equal(qt.days, 30);

  await q(A, `delete from crm_quote_items where quote_id = $1`, [id]);
  await q(A, `insert into crm_quote_items (quote_id, position, description, quantity, unit_price, discount_pct, tax_rate, line_total)
              values ($1, 1, 'Jerseys', 2, 100, 10, 18, 999999)`, [id]);
  const tot = await one(A, `select subtotal, discount_total, tax_total, total from crm_quotes where id = $1`, [id]);
  assert.deepEqual(Object.values(tot).map(Number), [200, 20, 32.4, 212.4], 'client line totals are ignored');
  const forged = await one(A, `update crm_quotes set total = 1, quote_number = 'X', company = $2 where id = $1 returning total, quote_number, company`, [id, JOBWAYS]);
  assert.equal(Number(forged.total), 212.4);
  assert.match(forged.quote_number, /^Q-/);
  assert.equal(forged.company, NOVA);

  // C may read the deal but not edit it (Employee: edit own), so not its quotes either.
  assert.equal((await q(C, `select 1 from crm_quotes where id = $1`, [id])).length, 1);
  assert.equal((await q(C, `update crm_quotes set subject = 'mine' where id = $1 returning id`, [id])).length, 0);
  await assert.rejects(q(C, `insert into crm_quote_items (quote_id, description) values ($1, 'Sneak')`, [id]), RLS);
  await assert.rejects(q(C, `select public.crm_quote_from_deal($1)`, [d.id]), /may not create quotes/);
  assert.equal((await q(B, `select 1 from crm_quotes where id = $1`, [id])).length, 0, 'another company sees nothing');
  assert.equal((await q(B, `select 1 from crm_quote_items where quote_id = $1`, [id])).length, 0);

  const second = await newDeal(A, 'Second deal');
  const q2 = (await one(A, `select public.crm_quote_from_deal($1) id`, [second.id])).id;
  assert.match((await one(A, `select quote_number n from crm_quotes where id = $1`, [q2])).n, /-0002$/);
  await assert.rejects(q(A, `update crm_quotes set status = 'sent' where id = $1`, [q2]), /at least one line/, 'an empty quote cannot be sent');
  assert.equal((await q(A, `delete from crm_quotes where id = $1 returning id`, [q2])).length, 1, 'drafts can be deleted');
});

test('quotes: sent locks the lines; accepted becomes one invoice, for people who may raise invoices', { skip }, async () => {
  const d = await newDeal(A, 'Gym fit-out');
  await q(A, `insert into crm_deal_products (deal_id, name, price, quantity, tax_rate, position) values ($1, 'Treadmill', 50000, 2, 18, 1), ($1, 'Install', 5000, 1, 0, 2)`, [d.id]);
  const id = (await one(A, `select public.crm_quote_from_deal($1) id`, [d.id])).id;
  const lines = await q(A, `select description, line_total from crm_quote_items where quote_id = $1 order by position`, [id]);
  assert.deepEqual(lines.map(l => [l.description, Number(l.line_total)]), [['Treadmill', 118000], ['Install', 5000]], 'deal products become the lines');

  const sent = await one(A, `update crm_quotes set status = 'sent' where id = $1 returning status, sent_at`, [id]);
  assert.equal(sent.status, 'sent'); assert.ok(sent.sent_at);
  await assert.rejects(q(A, `update crm_quote_items set quantity = 3 where quote_id = $1`, [id]), /only be changed while the quote is a draft/);
  await assert.rejects(q(A, `delete from crm_quote_items where quote_id = $1`, [id]), /only be removed while the quote is a draft/);
  assert.equal((await q(A, `delete from crm_quotes where id = $1 returning id`, [id])).length, 0, 'a sent quote is not deleted');
  await assert.rejects(q(A, `select public.crm_quote_to_invoice($1)`, [id]), /Only an accepted quote/);

  const acc = await one(A, `update crm_quotes set status = 'accepted' where id = $1 returning status, accepted_at`, [id]);
  assert.equal(acc.status, 'accepted'); assert.ok(acc.accepted_at);
  await assert.rejects(q(A, `select public.crm_quote_to_invoice($1)`, [id]), /may not create invoices/, 'employees cannot raise invoices by default');

  // The manager can edit every deal in the company and raise invoices.
  const inv = (await one(M, `select public.crm_quote_to_invoice($1) id`, [id])).id;
  const row = await one(M, `select status, total, deal_id, company, responsible_id from invoices where id = $1`, [inv]);
  assert.deepEqual({ ...row, total: Number(row.total) }, { status: 'draft', total: 123000, deal_id: d.id, company: NOVA, responsible_id: A });
  assert.equal((await one(M, `select public.crm_quote_to_invoice($1) id`, [id])).id, inv, 'a second call returns the same invoice');
  assert.equal((await one(M, `select count(*)::int n from invoices where deal_id = $1`, [d.id])).n, 1);
  await assert.rejects(q(M, `update crm_quotes set status = 'draft' where id = $1`, [id]), /has been invoiced/);
  const acts = (await q(A, `select action from crm_activities where entity_type = 'quote' and entity_id = $1 order by created_at`, [id])).map(r => r.action);
  assert.deepEqual(acts, ['quote.created', 'quote.sent', 'quote.accepted', 'quote.invoiced']);
});

test('quotes: declined can be revised as a draft; impossible jumps are refused', { skip }, async () => {
  const d = await newDeal(A, 'Balls', 900);
  const id = (await one(A, `select public.crm_quote_from_deal($1) id`, [d.id])).id;
  await q(A, `update crm_quotes set status = 'declined' where id = $1`, [id]);
  await assert.rejects(q(A, `update crm_quotes set status = 'accepted' where id = $1`, [id]), /cannot go from declined to accepted/);
  const back = await one(A, `update crm_quotes set status = 'draft' where id = $1 returning status, sent_at, declined_at`, [id]);
  assert.deepEqual(back, { status: 'draft', sent_at: null, declined_at: null });
});

test('the quote and invoice helpers are not open to anonymous callers', { skip }, async () => {
  const d = await newDeal(A, 'Anon target');
  await assert.rejects(anon(`select public.crm_quote_from_deal($1)`, [d.id]), /permission denied/);
  await assert.rejects(anon(`select public.crm_quote_to_invoice($1)`, [d.id]), /permission denied/);
  await assert.rejects(anon(`select public.next_quote_number('x')`), /permission denied/);
});

test('web forms: settings people build them; a visitor submission becomes a lead for the owner', { skip }, async () => {
  await assert.rejects(q(A, `insert into crm_web_forms (company, name) values ($1, 'Mine')`, [NOVA]), RLS);
  await assert.rejects(q(M, `insert into crm_web_forms (company, name, redirect_url) values ($1, 'Bad', 'javascript:alert(1)')`, [NOVA]), /crm_web_forms_ck/);
  await assert.rejects(q(M, `insert into crm_web_forms (company, name, fields) values ($1, 'Bad', array['name','salary'])`, [NOVA]), /crm_web_forms_ck/);
  const f = await one(M, `insert into crm_web_forms (company, name, title, owner_id, source, required) values ($1, 'Website contact', 'Talk to sales', $2, 'Website', array['name','email'])
                          returning id, public_token`, [NOVA, A]);
  assert.ok(f.public_token.length >= 24);

  assert.equal((await anon(`select public.crm_web_form_public('short') f`))[0].f, null, 'guessable tokens are refused');
  const pub = json((await anon(`select public.crm_web_form_public($1) f`, [f.public_token]))[0].f);
  assert.equal(pub.title, 'Talk to sales');
  assert.deepEqual(pub.required, ['name', 'email']);
  assert.equal(pub.owner_id, undefined, 'the public view carries no internal ids');
  assert.equal((await anon(`select * from crm_web_forms`)).length, 0, 'the table itself stays closed to visitors');
  assert.equal((await anon(`select * from crm_leads`)).length, 0);

  const ok = json((await anon(`select public.crm_web_form_submit($1, $2) r`,
    [f.public_token, { name: '  Ravi  Shah ', email: 'Ravi@Example.com', phone: '+91 98-7654 3210<script>', organization: 'Shah Sports', message: 'Need 40 kits', salary: 'x' }]))[0].r);
  assert.equal(ok.ok, true);
  const lead = await one(A, `select name, email, phone, organization, notes, source, source_detail, owner_id, status, company from crm_leads where email = 'ravi@example.com'`);
  assert.deepEqual(lead, { name: 'Ravi  Shah', email: 'ravi@example.com', phone: '+91 98-7654 3210', organization: 'Shah Sports', notes: 'Need 40 kits',
    source: 'Website', source_detail: 'Website contact', owner_id: A, status: 'new', company: NOVA });
  assert.equal((await one(A, `select count(*)::int n from notifications where user_id = $1 and kind = 'lead.assigned'`, [A])).n >= 1, true, 'the owner hears about it');
  assert.equal((await one(M, `select submissions from crm_web_forms where id = $1`, [f.id])).submissions, 1);

  await assert.rejects(anon(`select public.crm_web_form_submit($1, $2)`, [f.public_token, { name: 'No mail' }]), /Enter your email/);
  await assert.rejects(anon(`select public.crm_web_form_submit($1, $2)`, [f.public_token, { name: 'X', email: 'not-an-email' }]), /valid email/);
  await assert.rejects(anon(`select public.crm_web_form_submit($1, $2)`, [f.public_token, { email: 'a@b.co' }]), /Enter your name/);
  const bot = json((await anon(`select public.crm_web_form_submit($1, $2) r`, [f.public_token, { name: 'Bot', email: 'bot@spam.co', website: 'http://spam' }]))[0].r);
  assert.equal(bot.ok, true, 'bots get the thank-you');
  assert.equal((await one(M, `select count(*)::int n from crm_leads where email = 'bot@spam.co'`)).n, 0, 'and store nothing');

  for (let i = 0; i < 4; i++) await anon(`select public.crm_web_form_submit($1, $2)`, [f.public_token, { name: 'Lead ' + i, email: `l${i}@x.co` }]);
  await assert.rejects(anon(`select public.crm_web_form_submit($1, $2)`, [f.public_token, { name: 'Sixth', email: 'six@x.co' }]), /Too many submissions/);

  await q(M, `update crm_web_forms set active = false where id = $1`, [f.id]);
  await assert.rejects(anon(`select public.crm_web_form_submit($1, $2)`, [f.public_token, { name: 'Late', email: 'late@x.co' }]), /not available/);
  assert.equal((await anon(`select public.crm_web_form_public($1) f`, [f.public_token]))[0].f, null);
  assert.equal((await q(B, `select 1 from crm_web_forms`)).length, 0, 'another company does not see the form');
});
