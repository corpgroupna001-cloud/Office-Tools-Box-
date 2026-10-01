// ============================================================
// WorkSuite — step 1 of sign-up: validate + email an OTP.
// NO auth user is created here. The account only comes into
// existence in /api/signup-complete after the code checks out.
//
// The code is bound to the email AND the company chosen here: completing
// uses the company stored with the code, never one sent later. Issuing is
// one database call (ws_signup_code_issue) under a row lock, so parallel
// requests cannot slip past "one code a minute, five an hour"; each address
// is also limited per IP. Storage errors refuse rather than guess.
//
// Whether the new account is active straight away depends on an invitation
// (ws_invitations, from Employees → Invite or the admin console); without
// one it waits for an administrator. `invited` in the reply tells the page.
//
// POST { email, company, full_name }
//   → 200 { success, expires_at, invited }
//   → 409 email already registered
//   → 429 too soon / too many codes / too many sign-ups from this network
//   → 503 company email coming soon (Navyug Raise A Player) / storage unavailable
// ============================================================

const crypto = require('crypto');
const { readJson, clientIp } = require('../lib/request-auth');
const { rpc } = require('../lib/service-rpc');
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function sixDigits() { return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); }

const ALLOWED_COMPANIES = [
  'Nova Sportsmart Private Limited',
  'Protathlitis Sportsmart LLP',
  'Jobways Point LLP',
  'Genie Lamp Private Limited',
];
const COMING_SOON = ['Navyug Raise A Player Foundation', 'Raise a Player'];
// Codes asked for from one network address in an hour (shared offices sit behind one).
const PER_IP_PER_HOUR = 30;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const body = readJson(req);
  if (!body) return res.status(400).json({ error: 'Invalid JSON' });
  const email     = String(body.email || '').trim().toLowerCase();
  const company   = String(body.company || '');
  const full_name = String(body.full_name || '').trim().slice(0, 150);

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'invalid_email', message: 'Please enter a valid email address.' });
  if (COMING_SOON.includes(company)) {
    return res.status(503).json({ error: 'company_coming_soon', message: 'Sign-ups for this company are not open yet. Please choose a different company.' });
  }
  if (!ALLOWED_COMPANIES.includes(company)) {
    return res.status(400).json({ error: 'invalid_company', message: 'Please select a valid company.' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const MAIL_KEY     = process.env.MAIL_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Supabase server config missing.' });
  if (!MAIL_KEY)                     return res.status(500).json({ error: 'MAIL_API_KEY not configured.' });

  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
  const db = { url: SUPABASE_URL, key: SERVICE_KEY, request: fetch };
  const unavailable = () => res.status(503).json({ error: 'unavailable', message: 'Sign-up is unavailable right now. Please try again in a few minutes.' });

  // Per network address, so one machine cannot walk through many mailboxes.
  const ip = await rpc('ws_rate_hit', { p_key: `signup-start:ip:${clientIp(req)}`, p_window_seconds: 3600, p_max: PER_IP_PER_HOUR }, db);
  if (!ip.ok) return unavailable();
  if (!ip.data.allowed) {
    res.setHeader('Retry-After', String(ip.data.retry_after || 3600));
    return res.status(429).json({ error: 'too_many_requests', message: 'Too many sign-ups from this network. Try again later.' });
  }

  // Already registered? (profiles carries every account's email)
  let taken;
  try {
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id&email=eq.${encodeURIComponent(email)}&limit=1`, { headers: H });
    if (!pr.ok) return unavailable();
    taken = (await pr.json()).length > 0;
  } catch { return unavailable(); }
  if (taken) return res.status(409).json({ error: 'already_registered', message: 'An account with this email already exists. Try logging in instead.' });

  // Store the code with its company — one database call, under a row lock.
  const code = sixDigits();
  const codeHash = sha256(code);
  const issued = await rpc('ws_signup_code_issue', { p_email: email, p_company: company, p_full_name: full_name, p_code_hash: codeHash }, db);
  if (!issued.ok) return unavailable();
  if (!issued.data.ok) {
    res.setHeader('Retry-After', String(issued.data.retry_after || 60));
    return res.status(429).json(issued.data.reason === 'too_soon'
      ? { error: 'too_soon', message: 'A code was sent less than a minute ago. Check your inbox, or try again in a minute.' }
      : { error: 'too_many_codes', message: 'Too many codes were sent to this address. Try again in an hour.' });
  }
  const invited = await rpc('ws_invite_open', { p_email: email, p_company: company }, db);

  // Email the code through the company-routed sender.
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const name = full_name || email.split('@')[0];
  let mailRes = null;
  try {
    mailRes = await fetch(`${proto}://${req.headers.host}/api/mail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worksuite-mail-key': MAIL_KEY },
      body: JSON.stringify({
        company, to: email,
        subject: `Your WorkSuite verification code: ${code}`,
        html: renderOtpEmail({ name, code, company }),
      })
    });
  } catch { mailRes = null; }
  if (!mailRes || !mailRes.ok) {
    const detail = mailRes ? await mailRes.json().catch(() => ({})) : {};
    // The code never arrived: take it back so asking again is not "too soon".
    await rpc('ws_signup_code_withdraw', { p_email: email, p_code_hash: codeHash }, db);
    return res.status(502).json({ error: 'mail_failed', message: 'Could not send the verification email. Please try again.', detail });
  }
  return res.status(200).json({ success: true, expires_at: issued.data.expires_at, invited: !!(invited.ok && invited.data === true) });
};

function renderOtpEmail({ name, code, company }) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#0b1120;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b1120;padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#111827;border:1px solid #1f2937;border-radius:20px;overflow:hidden;">
        <tr><td style="padding:32px 32px 8px;">
          <div style="font-size:12px;font-weight:800;letter-spacing:2px;color:#94a3b8;text-transform:uppercase;">WorkSuite</div>
          <h1 style="margin:12px 0 8px;font-size:22px;font-weight:900;color:#f8fafc;">Confirm your email to finish signing up</h1>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.55;color:#cbd5e1;">
            Hi ${esc(name)}, use the code below to create your ${esc(company)} account. The code expires in 15 minutes.
            Your account is <b>not created</b> until you enter this code.
          </p>
        </td></tr>
        <tr><td style="padding:0 32px 20px;" align="center">
          <div style="display:inline-block;padding:16px 28px;border-radius:14px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);letter-spacing:8px;font-size:32px;font-weight:900;color:#fff;">
            ${code}
          </div>
        </td></tr>
        <tr><td style="padding:12px 32px 32px;">
          <p style="margin:0;font-size:12px;line-height:1.55;color:#64748b;">
            Didn't ask for this? Ignore this email — no account will be created.
          </p>
        </td></tr>
      </table>
      <div style="margin-top:14px;font-size:11px;color:#475569;">Sent by WorkSuite on behalf of ${esc(company)}</div>
    </td></tr>
  </table>
</body></html>`;
}

module.exports.ALLOWED_COMPANIES = ALLOWED_COMPANIES;
