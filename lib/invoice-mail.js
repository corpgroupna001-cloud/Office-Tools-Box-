// Email an invoice to its customer.
//
// Called from /api/mail with the signed-in manager's own Supabase token (no new
// serverless function: the Hobby plan is at its 12-function cap). Everything
// that ends up in the email — recipient, subject and body — is built here from
// the database row. Nothing the browser sends is used except the invoice id and
// the "send me a copy" flag, so this path cannot be used as an open relay.
//
// The money columns come straight from the invoices / invoice_items rows: they
// are computed by database triggers and are the authoritative figures.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const EMAILABLE = ['sent', 'partially_paid', 'overdue', 'paid'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(amount, currency) {
  const cur = currency || 'INR';
  const n = Number(amount) || 0;
  try {
    return new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  } catch { return `${cur} ${n.toFixed(2)}`; }
}

/** '25 Sep 2026' for a YYYY-MM-DD date column; '' for nothing. */
function fmtDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m) return '';
  return `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

function pct(value) { const n = Number(value) || 0; return n ? `${n}%` : '—'; }

/**
 * Pure: the email for one invoice. Uses the stored totals as they are.
 * Returns { subject, html, text }.
 */
function buildInvoiceEmail(invoice, items, contact) {
  const cur = invoice.currency || 'INR';
  const company = invoice.company || 'WorkSuite';
  const number = invoice.invoice_number || '';
  const paid = invoice.status === 'paid';
  const subject = paid ? `Receipt for invoice ${number}` : `Invoice ${number} from ${company}`;
  const billName = invoice.bill_to_name || (contact && contact.full_name) || '';
  const balance = Number(invoice.balance) || 0;
  const statusLine = paid || balance <= 0
    ? 'Paid in full — thank you.'
    : invoice.status === 'overdue'
      ? `Balance of ${money(balance, cur)} is overdue${invoice.due_date ? ` (was due ${fmtDate(invoice.due_date)})` : ''}.`
      : `Balance of ${money(balance, cur)} due${invoice.due_date ? ` by ${fmtDate(invoice.due_date)}` : ''}.`;

  const rows = (items || []).map((it, i) => ({
    n: i + 1,
    description: it.description || '',
    quantity: Number(it.quantity) || 0,
    unit: money(it.unit_price, cur),
    discount: pct(it.discount_pct),
    tax: pct(it.tax_rate),
    total: money(it.line_total, cur),
  }));

  const totals = [
    ['Subtotal', money(invoice.subtotal, cur)],
    ...(Number(invoice.discount_total) ? [['Discount', `− ${money(invoice.discount_total, cur)}`]] : []),
    ['Tax', money(invoice.tax_total, cur)],
    ['Total', money(invoice.total, cur), true],
    ...(Number(invoice.amount_paid) ? [['Paid', `− ${money(invoice.amount_paid, cur)}`], ['Balance due', money(balance, cur), true]] : []),
  ];

  const td = 'padding:8px 6px;border-bottom:1px solid #dfe5ed;vertical-align:top;font-size:13px;color:#172b44';
  const th = 'padding:8px 6px;border-bottom:2px solid #c5cfdb;text-align:left;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:#607086';
  const num = 'text-align:right;white-space:nowrap';
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f3f5f8">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f8;padding:24px 0"><tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border:1px solid #dfe5ed;border-radius:8px;font-family:Arial,Helvetica,sans-serif;color:#172b44">
<tr><td style="padding:28px 28px 8px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="font-size:18px;font-weight:bold;color:#172b44">${esc(company)}</td>
    <td style="text-align:right;font-size:13px;color:#607086">${paid ? 'Receipt' : 'Invoice'}<br><span style="font-size:20px;font-weight:bold;color:#172b44">${esc(number)}</span></td>
  </tr></table>
</td></tr>
<tr><td style="padding:12px 28px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="font-size:13px;vertical-align:top;width:55%"><div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#607086;margin-bottom:4px">Bill to</div><b>${esc(billName || '—')}</b>${invoice.bill_to_address ? `<div style="white-space:pre-wrap">${esc(invoice.bill_to_address)}</div>` : ''}</td>
    <td style="font-size:13px;vertical-align:top;text-align:right">Invoice date: <b>${esc(fmtDate(invoice.invoice_date))}</b>${invoice.due_date ? `<br>Due date: <b>${esc(fmtDate(invoice.due_date))}</b>` : ''}<br>Currency: <b>${esc(cur)}</b></td>
  </tr></table>
</td></tr>
<tr><td style="padding:8px 28px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
    <tr><th style="${th}">#</th><th style="${th}">Description</th><th style="${th};${num}">Qty</th><th style="${th};${num}">Unit price</th><th style="${th};${num}">Disc</th><th style="${th};${num}">Tax</th><th style="${th};${num}">Amount</th></tr>
    ${rows.map(r => `<tr><td style="${td};color:#607086">${r.n}</td><td style="${td}">${esc(r.description)}</td><td style="${td};${num}">${esc(r.quantity)}</td><td style="${td};${num}">${esc(r.unit)}</td><td style="${td};${num}">${esc(r.discount)}</td><td style="${td};${num}">${esc(r.tax)}</td><td style="${td};${num}">${esc(r.total)}</td></tr>`).join('')}
  </table>
</td></tr>
<tr><td style="padding:8px 28px">
  <table role="presentation" cellpadding="0" cellspacing="0" align="right" style="min-width:260px">
    ${totals.map(([label, value, strong]) => `<tr><td style="padding:4px 6px;font-size:${strong ? 15 : 13}px;${strong ? 'font-weight:bold;border-top:2px solid #c5cfdb' : ''}">${esc(label)}</td><td style="padding:4px 6px;font-size:${strong ? 15 : 13}px;${num};${strong ? 'font-weight:bold;border-top:2px solid #c5cfdb' : ''}">${esc(value)}</td></tr>`).join('')}
  </table>
</td></tr>
<tr><td style="padding:12px 28px"><div style="padding:12px 14px;border-radius:6px;background:${paid || balance <= 0 ? '#e8f6ed;color:#166534' : invoice.status === 'overdue' ? '#fdecec;color:#b91c1c' : '#eaf1fb;color:#18457f'};font-size:14px;font-weight:bold">${esc(statusLine)}</div></td></tr>
${invoice.notes ? `<tr><td style="padding:6px 28px;font-size:13px;color:#354a62"><b>Notes</b><div style="white-space:pre-wrap">${esc(invoice.notes)}</div></td></tr>` : ''}
${invoice.terms ? `<tr><td style="padding:6px 28px;font-size:13px;color:#354a62"><b>Terms</b><div style="white-space:pre-wrap">${esc(invoice.terms)}</div></td></tr>` : ''}
<tr><td style="padding:18px 28px 26px;font-size:12px;color:#607086">Sent by ${esc(company)}. Reply to this email with any questions about this invoice.</td></tr>
</table></td></tr></table></body></html>`;

  const lines = [
    `${paid ? 'Receipt for invoice' : 'Invoice'} ${number} — ${company}`,
    '',
    `Bill to: ${billName || '—'}`,
    ...(invoice.bill_to_address ? [String(invoice.bill_to_address)] : []),
    `Invoice date: ${fmtDate(invoice.invoice_date)}`,
    ...(invoice.due_date ? [`Due date: ${fmtDate(invoice.due_date)}`] : []),
    '',
    ...rows.map(r => `${r.n}. ${r.description} — ${r.quantity} × ${r.unit}${r.discount !== '—' ? `, disc ${r.discount}` : ''}${r.tax !== '—' ? `, tax ${r.tax}` : ''} = ${r.total}`),
    '',
    ...totals.map(([label, value]) => `${label}: ${value}`),
    '',
    statusLine,
    ...(invoice.notes ? ['', 'Notes:', String(invoice.notes)] : []),
    ...(invoice.terms ? ['', 'Terms:', String(invoice.terms)] : []),
  ];
  return { subject, html, text: lines.join('\n') };
}

/**
 * emailInvoice({ invoice_id, cc_me }, { url, key, token, request, sendMail, recordMail })
 * -> { success, to: [addresses], messageId }
 */
async function emailInvoice(body, { url, key, token, request = fetch, sendMail, recordMail }) {
  if (!token) fail('Sign in again to email invoices', 401);
  const invoiceId = String((body && body.invoice_id) || '');
  if (!UUID.test(invoiceId)) fail('Invalid invoice');

  const service = { apikey: key, Authorization: `Bearer ${key}` };
  const call = (path, options = {}) => request(url + path, { ...options, headers: { ...service, 'Content-Type': 'application/json', ...options.headers } });
  const rows = async (path, what) => {
    const r = await call(path);
    if (!r.ok) fail(`Unable to load ${what}`, 502);
    return r.json();
  };

  // 1) Who is asking: their own token, checked by Supabase Auth.
  let user = null;
  try {
    const r = await request(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
    if (r.ok) user = await r.json();
  } catch { /* treated as unauthenticated */ }
  if (!user || !user.id) fail('Your session has expired. Sign in again.', 401);

  const [caller] = await rows(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,full_name,email,company,company2,app_role`, 'your profile');
  if (!caller || !['manager', 'admin'].includes(caller.app_role)) fail('Only managers can email invoices', 403);

  // 2) The invoice, and whether this manager may act on it.
  const [invoice] = await rows(`/rest/v1/invoices?id=eq.${invoiceId}&select=*`, 'the invoice');
  if (!invoice) fail('Invoice not found', 404);
  if (caller.app_role !== 'admin' && ![caller.company, caller.company2].filter(Boolean).includes(invoice.company)) {
    fail('Only managers can email invoices', 403);
  }
  if (!EMAILABLE.includes(invoice.status)) {
    fail(invoice.status === 'draft'
      ? 'Mark the invoice as sent before emailing it.'
      : 'A cancelled invoice cannot be emailed.', 409);
  }

  const items = await rows(`/rest/v1/invoice_items?invoice_id=eq.${invoiceId}&order=position`, 'the invoice lines');
  let contact = null;
  if (invoice.contact_id) {
    const found = await rows(`/rest/v1/crm_contacts?id=eq.${encodeURIComponent(invoice.contact_id)}&select=email,full_name`, 'the contact');
    contact = found[0] || null;
  }

  // 3) Recipient comes from the record, never the request.
  const recipient = String(invoice.bill_to_email || (contact && contact.email) || '').trim().toLowerCase();
  if (!recipient) fail('This invoice has no billing email', 400);
  if (!EMAIL.test(recipient)) fail('The billing email on this invoice is not a valid address', 400);
  const to = [recipient];
  const ccMe = body.cc_me === true && caller.email && EMAIL.test(caller.email) && caller.email.toLowerCase() !== recipient;
  if (ccMe) to.push(caller.email.toLowerCase());

  const mail = buildInvoiceEmail(invoice, items, contact);
  const result = await sendMail({ company: invoice.company, to: to.join(', '), subject: mail.subject, html: mail.html, text: mail.text, replyTo: caller.email || undefined });
  try { await recordMail({ company: invoice.company, to: to.join(', '), category: 'invoice' }, result); } catch { /* audit is best effort */ }

  if (!result || !result.ok) {
    const reason = result && result.reason;
    if (reason === 'email_coming_soon') fail(`Email for ${invoice.company} is not available yet. Download or print the invoice and send it another way.`, 503);
    if (reason === 'unknown_company' || reason === 'smtp_not_configured') fail(`Email is not configured for ${invoice.company || 'this company'}`, 502);
    fail('The mail server did not accept the message. Try again in a few minutes.', 502);
  }

  // 4) The timeline records that it went out — the domain only, not the address.
  try {
    await call('/rest/v1/crm_activities', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        company: invoice.company, actor_id: user.id, action: 'invoice.emailed', entity_type: 'invoice',
        entity_id: invoice.id, entity_label: invoice.invoice_number,
        meta: { to_domain: recipient.split('@')[1], cc_me: !!ccMe },
        contact_id: invoice.contact_id || null, deal_id: invoice.deal_id || null, project_id: invoice.project_id || null,
      }),
    });
  } catch { /* the email went out; a missing timeline entry must not undo that */ }

  return { success: true, to, messageId: result.messageId || null };
}

module.exports = { emailInvoice, buildInvoiceEmail };
