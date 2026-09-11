// ============================================================
// Inviting people to WorkSuite by email (Employees → Invite).
//
// A signed-in manager asks for invitations; everything in the message is
// built here: a fixed text, the manager's name, the company and a sign-up
// link for this deployment. Only two things come from the request: the
// addresses (checked, at most MAX) and the company, which must be one of
// the manager's own. People who already have an account are skipped. The
// invitation does not create an account: the invitee signs up the usual
// way, choosing a password and confirming the address with a code.
//
// Lives outside /api (the deployment is at the Vercel Hobby function limit);
// /api/mail.js calls it for { action: 'invite' }.
// ============================================================
const { COMPANY_TO_USER } = require('./mailer');

const MAX = 10;
const PARALLEL = 5;
const EMAIL = /^[^\s@<>"',;()]+@[^\s@<>"',;()]+\.[^\s@<>"',;()]+$/;
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The sign-up link: the home page opens the sign-up form with these filled in. */
function inviteLink(origin, company, email) {
  const q = new URLSearchParams({ signup: '1', company });
  if (email) q.set('email', email);
  return `${origin}/?${q}`;
}

/** "a@x.com, b@y.com" or ['a@x.com', …] → { valid, invalid }, lower-cased, without repeats. */
function parseEmails(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/);
  const seen = new Set(), valid = [], invalid = [];
  for (const raw of list) {
    const e = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!e || seen.has(e)) continue;
    seen.add(e);
    (EMAIL.test(e) && e.length <= 254 ? valid : invalid).push(e);
  }
  return { valid, invalid };
}

function buildInviteEmail({ inviter, company, link }) {
  const who = inviter || 'A colleague';
  const subject = `${who} invited you to WorkSuite`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1f2937;line-height:1.5">
  <h2 style="margin:0 0 12px;font-size:20px">You're invited to WorkSuite</h2>
  <p style="margin:0 0 12px">${esc(who)} invited you to join <b>${esc(company)}</b> on WorkSuite, where the team keeps its tasks, projects, calendar, chat and CRM.</p>
  <p style="margin:24px 0"><a href="${esc(link)}" style="background:#2fc6f6;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold;display:inline-block">Join the team</a></p>
  <p style="margin:0 0 12px;font-size:13px;color:#6b7280">The link opens the sign-up page with your email filled in. Choose a password, then confirm your address with the code we send you.</p>
  <p style="margin:0;font-size:12px;color:#9ca3af">If you weren't expecting this invitation, you can ignore this email.</p>
</div>`;
  const text = [
    `${who} invited you to join ${company} on WorkSuite.`,
    '',
    `Sign up here: ${link}`,
    '',
    'Choose a password, then confirm your address with the code we send you.',
    "If you weren't expecting this invitation, you can ignore this email.",
  ].join('\n');
  return { subject, html, text };
}

/**
 * emailInvite({ company, emails }, { url, key, token, origin, request, sendMail, recordMail })
 * -> { success, sent: [addresses], existing: [addresses], failed: [addresses] }
 */
async function emailInvite(body, { url, key, token, origin, request = fetch, sendMail, recordMail }) {
  if (!token) fail('Sign in again to send invitations', 401);
  if (!ORIGIN.test(String(origin || ''))) fail('Invitations are not configured on this server', 500);
  const company = String((body && body.company) || '');
  if (!Object.prototype.hasOwnProperty.call(COMPANY_TO_USER, company)) fail('Choose a company that can send email');
  const { valid, invalid } = parseEmails(body && body.emails);
  if (invalid.length) fail(`${invalid.length === 1 ? 'This is not an email address' : 'These are not email addresses'}: ${invalid.slice(0, 3).join(', ')}${invalid.length > 3 ? '…' : ''}`);
  if (!valid.length) fail('Enter at least one email address');
  if (valid.length > MAX) fail(`Invite up to ${MAX} people at a time`);

  const service = { apikey: key, Authorization: `Bearer ${key}` };
  const rows = async (path, what) => {
    const r = await request(url + path, { headers: { ...service, 'Content-Type': 'application/json' } });
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
  if (!caller || !['manager', 'admin'].includes(caller.app_role)) fail('Only managers can invite people', 403);
  if (caller.app_role !== 'admin' && ![caller.company, caller.company2].filter(Boolean).includes(company)) {
    fail('You can invite people to your own company only', 403);
  }

  // 2) Addresses that already belong to someone get no invitation.
  const found = await rows(`/rest/v1/profiles?email=in.(${encodeURIComponent(valid.join(','))})&select=email`, 'existing accounts');
  const taken = new Set((found || []).map(p => String(p.email || '').toLowerCase()));
  const existing = valid.filter(e => taken.has(e));
  const fresh = valid.filter(e => !taken.has(e));

  // 3) One message per person, so nobody sees the other addresses.
  const inviter = caller.full_name || String(caller.email || '').split('@')[0];
  const replyTo = caller.email && EMAIL.test(String(caller.email).toLowerCase()) ? caller.email : undefined;
  const sent = [], failed = [], reasons = [];
  const one = async to => {
    const mail = buildInviteEmail({ inviter, company, link: inviteLink(origin, company, to) });
    let result;
    try { result = await sendMail({ company, to, subject: mail.subject, html: mail.html, text: mail.text, replyTo }); }
    catch { result = null; }
    if (!result) result = { ok: false, reason: 'send_failed' };
    try { await recordMail({ company, to, category: 'invite' }, result); } catch { /* audit is best effort */ }
    if (result.ok) sent.push(to); else { failed.push(to); reasons.push(result.reason); }
  };
  for (let i = 0; i < fresh.length; i += PARALLEL) await Promise.all(fresh.slice(i, i + PARALLEL).map(one));

  if (fresh.length && !sent.length) {
    if (reasons.some(r => r === 'unknown_company' || r === 'smtp_not_configured')) fail(`Email is not configured for ${company}`, 502);
    fail('The mail server did not accept the invitations. Try again in a few minutes.', 502);
  }
  const order = list => valid.filter(e => list.includes(e));
  return { success: true, sent: order(sent), existing, failed: order(failed) };
}

module.exports = { emailInvite, buildInviteEmail, inviteLink, parseEmails, MAX };
