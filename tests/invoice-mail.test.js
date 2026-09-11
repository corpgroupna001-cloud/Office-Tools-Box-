// Emailing an invoice: who may do it, what is sent, and that nothing the
// browser sends decides where it goes. No network: Supabase, SMTP and the
// audit log are stand-ins.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { emailInvoice, buildInvoiceEmail } = require('../lib/invoice-mail');

const URL_BASE = 'https://db.example.test';
const KEY = 'test-service-key';
const TOKEN = 'user-access-token';
const NOVA = 'Nova Sportsmart Private Limited';
const JOBWAYS = 'Jobways Point LLP';
const INVOICE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CONTACT_ID = '33333333-3333-4333-8333-333333333333';

function invoiceRow(extra = {}) {
  return {
    id: INVOICE_ID, company: NOVA, invoice_number: 'INV-2026-0007', status: 'sent', currency: 'INR',
    invoice_date: '2026-09-10', due_date: '2026-09-25', bill_to_name: 'Demo Academy', bill_to_address: 'Hyderabad',
    bill_to_email: 'Accounts@Customer.example', contact_id: CONTACT_ID, deal_id: null, project_id: null,
    subtotal: 1000, discount_total: 0, tax_total: 180, total: 1180, amount_paid: 0, balance: 1180,
    notes: 'Thank you', terms: 'Net 15', ...extra,
  };
}

/**
 * A stand-in Supabase. Every call is recorded; `state` decides what comes back.
 */
function backend(state = {}) {
  const calls = [];
  const s = {
    user: { id: USER_ID }, userStatus: 200,
    profile: { id: USER_ID, full_name: 'Manager One', email: 'manager@nova.example', company: NOVA, company2: null, app_role: 'manager' },
    invoice: invoiceRow(), items: [{ description: 'Kit <script>alert(1)</script>', quantity: 2, unit_price: 500, discount_pct: 0, tax_rate: 18, line_total: 1180 }],
    contact: { email: 'contact@customer.example', full_name: 'Demo Contact' }, activityStatus: 201,
    ...state,
  };
  const reply = (status, body) => new Response(JSON.stringify(body ?? null), { status });
  const request = async (url, options = {}) => {
    const method = options.method || 'GET';
    const p = url.slice(URL_BASE.length);
    calls.push({ method, path: p, headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null });
    if (p === '/auth/v1/user') return s.userStatus === 200 ? reply(200, s.user) : reply(s.userStatus, { msg: 'invalid' });
    if (p.startsWith('/rest/v1/profiles')) return reply(200, s.profile ? [s.profile] : []);
    if (p.startsWith('/rest/v1/invoices')) return reply(200, s.invoice ? [s.invoice] : []);
    if (p.startsWith('/rest/v1/invoice_items')) return reply(200, s.items);
    if (p.startsWith('/rest/v1/crm_contacts')) return reply(200, s.contact ? [s.contact] : []);
    if (p.startsWith('/rest/v1/crm_activities')) return reply(s.activityStatus, s.activityStatus < 300 ? null : { message: 'boom' });
    return reply(404, { message: 'unexpected ' + p });
  };
  const mails = [], audits = [];
  const deps = {
    url: URL_BASE, key: KEY, token: TOKEN, request,
    sendMail: async mail => { mails.push(mail); return state.mailResult || { ok: true, messageId: '<m1@test>', from: 'sender@nova.example' }; },
    recordMail: async (meta, result) => { audits.push({ meta, result }); return true; },
  };
  return { deps, calls, mails, audits, activities: () => calls.filter(c => c.method === 'POST' && c.path.startsWith('/rest/v1/crm_activities')) };
}

const run = (b, body = { invoice_id: INVOICE_ID }) => emailInvoice(body, b.deps);
const rejectsWith = (promise, status, pattern) => assert.rejects(promise, e => e.status === status && (!pattern || pattern.test(e.message)));

/* ============================ Who may send ============================ */

test('no token, or a token Supabase does not accept, is a 401 and nothing is sent', async () => {
  const b = backend();
  await rejectsWith(emailInvoice({ invoice_id: INVOICE_ID }, { ...b.deps, token: '' }), 401);
  const bad = backend({ userStatus: 401 });
  await rejectsWith(run(bad), 401, /Sign in again/);
  assert.equal(b.mails.length + bad.mails.length, 0);
  assert.equal(bad.calls[0].headers.Authorization, `Bearer ${TOKEN}`, 'the caller is identified by their own token');
});

test('an ordinary employee cannot email invoices', async () => {
  const b = backend({ profile: { id: USER_ID, email: 'e@nova.example', company: NOVA, app_role: 'employee' } });
  await rejectsWith(run(b), 403, /Only managers/);
  assert.equal(b.mails.length, 0);
});

test('a manager of another company cannot email this company\'s invoice; a secondary company counts', async () => {
  const other = backend({ profile: { id: USER_ID, email: 'm@jobways.example', company: JOBWAYS, company2: null, app_role: 'manager' } });
  await rejectsWith(run(other), 403);
  assert.equal(other.mails.length, 0);
  const dual = backend({ profile: { id: USER_ID, email: 'm@jobways.example', company: JOBWAYS, company2: NOVA, app_role: 'manager' } });
  assert.equal((await run(dual)).success, true);
});

test('an admin may email any company\'s invoice', async () => {
  const b = backend({ profile: { id: USER_ID, email: 'admin@group.example', company: JOBWAYS, app_role: 'admin' } });
  const out = await run(b);
  assert.equal(out.success, true);
  assert.equal(b.mails.length, 1);
});

/* ============================ What may be sent ============================ */

test('drafts and cancelled invoices are refused with a clear message', async () => {
  await rejectsWith(run(backend({ invoice: invoiceRow({ status: 'draft' }) })), 409, /Mark the invoice as sent/);
  await rejectsWith(run(backend({ invoice: invoiceRow({ status: 'cancelled' }) })), 409, /cancelled/);
});

test('an unknown invoice is a 404 and a malformed id is refused before any lookup', async () => {
  await rejectsWith(run(backend({ invoice: null })), 404);
  const b = backend();
  await rejectsWith(run(b, { invoice_id: 'not-a-uuid' }), 400);
  assert.equal(b.calls.length, 0);
});

test('no billing email on the invoice or its contact is a 400', async () => {
  const b = backend({ invoice: invoiceRow({ bill_to_email: null }), contact: { email: null, full_name: 'X' } });
  await rejectsWith(run(b), 400, /no billing email/);
  assert.equal(b.mails.length, 0);
});

test('the contact\'s email is used when the bill-to snapshot has none', async () => {
  const b = backend({ invoice: invoiceRow({ bill_to_email: null }) });
  const out = await run(b);
  assert.deepEqual(out.to, ['contact@customer.example']);
});

/* ============================ The happy path ============================ */

test('one email goes to the billing address, built from the database row', async () => {
  const b = backend();
  const out = await run(b, { invoice_id: INVOICE_ID, to: 'attacker@evil.example', subject: 'x', html: '<b>x</b>' });
  assert.equal(out.success, true);
  assert.deepEqual(out.to, ['accounts@customer.example']);
  assert.equal(b.mails.length, 1);
  const mail = b.mails[0];
  assert.equal(mail.to, 'accounts@customer.example', 'the client cannot choose the recipient');
  assert.equal(mail.company, NOVA, 'the company picks the sender mailbox');
  assert.equal(mail.replyTo, 'manager@nova.example');
  assert.match(mail.subject, /INV-2026-0007/);
  assert.doesNotMatch(mail.subject, /^x$/);
  assert.ok(!mail.html.includes('<script>alert(1)</script>'), 'item text is escaped in the HTML');
  assert.ok(mail.html.includes('&lt;script&gt;'));
  assert.match(mail.text, /1,180\.00/, 'the text body carries the stored total');
  assert.equal(b.audits.length, 1);
  assert.equal(b.audits[0].meta.category, 'invoice');
  const act = b.activities();
  assert.equal(act.length, 1);
  assert.equal(act[0].body.action, 'invoice.emailed');
  assert.equal(act[0].body.actor_id, USER_ID);
  assert.equal(act[0].body.meta.to_domain, 'customer.example');
  assert.ok(!JSON.stringify(act[0].body).includes('accounts@'), 'the timeline keeps the domain, not the address');
  assert.equal(act[0].headers.Authorization, `Bearer ${KEY}`, 'the activity row is written with the service key');
});

test('"send me a copy" adds the caller as a second recipient', async () => {
  const b = backend();
  const out = await run(b, { invoice_id: INVOICE_ID, cc_me: true });
  assert.deepEqual(out.to, ['accounts@customer.example', 'manager@nova.example']);
  assert.equal(b.mails[0].to, 'accounts@customer.example, manager@nova.example');
  assert.equal(b.activities()[0].body.meta.cc_me, true);
});

test('a paid invoice goes out as a receipt', async () => {
  const b = backend({ invoice: invoiceRow({ status: 'paid', amount_paid: 1180, balance: 0 }) });
  await run(b);
  assert.match(b.mails[0].subject, /^Receipt for invoice INV-2026-0007/);
  assert.match(b.mails[0].text, /Paid in full/);
});

/* ============================ Failures ============================ */

test('a mailbox that is not live yet is a 503 and no timeline entry is written', async () => {
  const b = backend({ mailResult: { ok: false, reason: 'email_coming_soon' } });
  await rejectsWith(run(b), 503, /not available yet/);
  assert.equal(b.activities().length, 0);
  assert.equal(b.audits.length, 1, 'the failed attempt is still audited');
});

test('unconfigured SMTP and a refused send are 502s', async () => {
  await rejectsWith(run(backend({ mailResult: { ok: false, reason: 'smtp_not_configured' } })), 502, /not configured for Nova/);
  await rejectsWith(run(backend({ mailResult: { ok: false, reason: 'smtp_send_failed' } })), 502);
});

test('a failed timeline insert does not turn a sent email into an error', async () => {
  const b = backend({ activityStatus: 500 });
  const out = await run(b);
  assert.equal(out.success, true);
  assert.equal(b.mails.length, 1);
});

test('the email body is built from stored totals and marks overdue balances', () => {
  const mail = buildInvoiceEmail(invoiceRow({ status: 'overdue', amount_paid: 180, balance: 1000 }), [], null);
  assert.match(mail.text, /Balance due: ₹1,000\.00/);
  assert.match(mail.text, /overdue \(was due 25 Sep 2026\)/);
  assert.match(mail.subject, /^Invoice INV-2026-0007 from Nova/);
});

/* ============================ The /api/mail handler ============================ */

function mailHandler(env, invoiceMail) {
  const module = { exports: {} };
  const sent = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/mail.js'), 'utf8'), {
    module, process: { env }, console,
    require(name) {
      if (name === '../lib/mailer') return { sendMail: async m => { sent.push(m); return { ok: true, messageId: 'x' }; } };
      if (name === '../lib/mail-audit') return { recordMail: async () => true };
      if (name === '../lib/invoice-mail') return invoiceMail || { emailInvoice: async () => { throw new Error('should not be called'); } };
      throw new Error('Unexpected dependency: ' + name);
    },
  });
  return async (body, headers = {}) => {
    const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
    await module.exports({ method: 'POST', headers, body }, res);
    return { res, sent };
  };
}

test('the mail-key path is unchanged: missing key config is 500, a wrong key is 401', async () => {
  const unset = await mailHandler({})({ company: NOVA, to: 'a@b.example', subject: 's', text: 't' }, { 'x-worksuite-mail-key': 'k' });
  assert.equal(unset.res.code, 500);
  const wrong = await mailHandler({ MAIL_API_KEY: 'right' })({ company: NOVA, to: 'a@b.example', subject: 's', text: 't' }, { 'x-worksuite-mail-key': 'wrong' });
  assert.equal(wrong.res.code, 401);
  assert.equal(wrong.sent.length, 0);
  const ok = await mailHandler({ MAIL_API_KEY: 'right' })({ company: NOVA, to: 'a@b.example', subject: 's', text: 't' }, { 'x-worksuite-mail-key': 'right' });
  assert.equal(ok.res.code, 200);
  assert.equal(ok.sent.length, 1);
});

test('a bearer token without action:"invoice" cannot use the relay path', async () => {
  const out = await mailHandler({ MAIL_API_KEY: 'right', SUPABASE_URL: URL_BASE, SUPABASE_SERVICE_ROLE_KEY: KEY })(
    { company: NOVA, to: 'victim@x.example', subject: 's', text: 't' }, { authorization: 'Bearer anything' });
  assert.equal(out.res.code, 401);
  assert.equal(out.sent.length, 0);
});

test('a bearer token with action:"invoice" is routed to lib/invoice-mail with the caller\'s token', async () => {
  const seen = [];
  const handler = mailHandler({ SUPABASE_URL: URL_BASE, SUPABASE_SERVICE_ROLE_KEY: KEY }, {
    emailInvoice: async (body, opts) => { seen.push({ body, opts }); return { success: true, to: ['a@b.example'] }; },
  });
  const out = await handler(JSON.stringify({ action: 'invoice', invoice_id: INVOICE_ID }), { authorization: 'Bearer user-jwt' });
  assert.equal(out.res.code, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].opts.token, 'user-jwt');
  assert.equal(seen[0].opts.key, KEY);
  assert.equal(seen[0].body.invoice_id, INVOICE_ID);

  const failing = mailHandler({ SUPABASE_URL: URL_BASE, SUPABASE_SERVICE_ROLE_KEY: KEY }, {
    emailInvoice: async () => { const e = new Error('Only managers can email invoices'); e.status = 403; throw e; },
  });
  const denied = await failing({ action: 'invoice', invoice_id: INVOICE_ID }, { authorization: 'Bearer user-jwt' });
  assert.equal(denied.res.code, 403);
  assert.equal(denied.res.body.error, 'Only managers can email invoices');

  const noConfig = await mailHandler({})({ action: 'invoice', invoice_id: INVOICE_ID }, { authorization: 'Bearer user-jwt' });
  assert.equal(noConfig.res.code, 500);
});
