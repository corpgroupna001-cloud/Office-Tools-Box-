// ============================================================
// WorkSuite — signup email verification (issue + check the 6-digit code).
//
// This one function serves BOTH original URLs; vercel.json rewrites
//   /api/send-verify  -> /api/verify?fn=send
//   /api/verify-code  -> /api/verify?fn=check
// so nothing on the front end changed. They were merged because Vercel's
// Hobby plan caps a deployment at 12 serverless functions and the biometric
// attendance webhook needed a slot. The two halves are one flow anyway:
//
//   1) Client signs the user up via supabase-js (existing signup form).
//      Because "Confirm email" is OFF in Supabase Auth, the user is
//      immediately logged in, but profiles.email_verified is false.
//   2) Client POSTs { full_name } to /api/send-verify with its session
//      (Authorization: Bearer <access token>). The user, their email and
//      their company come from that session and their profile, never from
//      the body. Server generates a 6-digit code, sha256-hashes it and
//      stores it with ws_verify_code_issue (15-minute expiry, one a minute,
//      five an hour), then calls /api/mail with the company-mapped sender.
//   3) Client shows an "Enter the 6-digit code" step and POSTs { code } to
//      /api/verify-code (same header). One database call
//      (ws_verify_code_check, migration 17) counts the guess and, for the
//      right code, flips profiles.email_verified = true and deletes the code
//      in the same transaction; parallel guesses all count.
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MAIL_API_KEY.
// ============================================================

const crypto = require('crypto');
const { readJson, sessionAccess, accessError } = require('../lib/request-auth');
const { rpc } = require('../lib/service-rpc');

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function sixDigits() {
  // crypto.randomInt is uniformly distributed; padStart guards leading zeros.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const parsed = readJson(req);
  if (!parsed) return res.status(400).json({ error: 'Invalid JSON' });
  // Whose code: the signed-in caller, never a user_id from the body.
  const access = await sessionAccess(req, process.env, fetch);
  if (access.reason) { const e = accessError(access.reason); return res.status(e.status).json(e.body); }
  const user = access.user;

  // Which half? The rewrite supplies ?fn=, but fall back to the payload shape
  // so a direct POST to /api/verify still does the right thing.
  const fn = String(req.query?.fn || '')
    || (parsed && parsed.code !== undefined ? 'check' : 'send');

  return fn === 'check' ? verifyCode(req, res, parsed, user) : sendCode(req, res, parsed, user);
};

const unavailable = res => res.status(503).json({ error: 'unavailable', message: 'Email verification is unavailable right now. Try again in a few minutes.' });

// ------------------------------------------------------------------
// Issue a code  (was /api/send-verify)
// ------------------------------------------------------------------
async function sendCode(req, res, body, user) {
  const user_id = encodeURIComponent(user.id);
  const email = user.email;
  const full_name = typeof body.full_name === 'string' ? body.full_name.slice(0, 150) : '';
  if (!email) return res.status(400).json({ error: 'This account has no email address.' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const MAIL_KEY     = process.env.MAIL_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Supabase server config missing.' });
  if (!MAIL_KEY)                     return res.status(500).json({ error: 'MAIL_API_KEY not configured.' });
  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
  const db = { url: SUPABASE_URL, key: SERVICE_KEY, request: fetch };

  // The company (which mailbox sends the code) is the one on the profile.
  let company = '';
  try {
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user_id}&select=company,email_verified&limit=1`, { headers: H });
    if (!pr.ok) return unavailable(res);
    const [p] = await pr.json();
    if (p && p.email_verified) return res.status(200).json({ success: true, skipped: 'already_verified' });
    company = (p && p.company) || '';
  } catch { return unavailable(res); }
  if (!company) return res.status(400).json({ error: 'Choose your company first.' });

  // Navyug Raise A Player Foundation — email is not wired up yet. Auto-verify so
  // signup isn't blocked, but tell the client so the UI can show a friendly
  // "coming soon" note instead of pretending an email was sent.
  const COMING_SOON = new Set(['Navyug Raise A Player Foundation', 'Raise a Player']);
  if (COMING_SOON.has(company)) {
    let ok = false;
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user_id}`, {
        method: 'PATCH', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify({ email_verified: true }),
      });
      ok = r.ok && (await r.json()).length === 1;
    } catch { ok = false; }
    if (!ok) return res.status(502).json({ error: 'verify_failed', message: 'Could not update your account. Try again in a moment.' });
    return res.status(200).json({ success: true, skipped: 'email_coming_soon', message: 'Verification email is coming soon for Raise a Player. Your account is active.' });
  }

  // One code a minute and five an hour, decided under a row lock.
  const code = sixDigits();
  const issued = await rpc('ws_verify_code_issue', { p_user: user.id, p_code_hash: sha256(code) }, db);
  if (!issued.ok) return unavailable(res);
  if (!issued.data.ok) {
    res.setHeader('Retry-After', String(issued.data.retry_after || 60));
    return res.status(429).json(issued.data.reason === 'too_soon'
      ? { error: 'too_soon', message: 'A code was sent less than a minute ago. Check your inbox.' }
      : { error: 'too_many_codes', message: 'Too many codes were sent. Try again in an hour.' });
  }

  // Send the code via the company-routed mail endpoint.
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const mailUrl = `${proto}://${req.headers.host}/api/mail`;
  const displayName = full_name || (email || '').split('@')[0] || 'there';
  const html = renderVerificationEmail({ name: displayName, code, company });
  let mailRes = null;
  try {
    mailRes = await fetch(mailUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-worksuite-mail-key': MAIL_KEY },
      body: JSON.stringify({ company, to: email, subject: `Your WorkSuite verification code: ${code}`, html }),
    });
  } catch { mailRes = null; }
  if (!mailRes || !mailRes.ok) {
    const detail = mailRes ? await mailRes.json().catch(() => ({})) : {};
    return res.status(502).json({ error: 'mail_failed', message: 'Could not send the code. Try again in a minute.', detail });
  }
  return res.status(200).json({ success: true, expires_at: issued.data.expires_at });
}

// ------------------------------------------------------------------
// Check a code  (was /api/verify-code)
// ------------------------------------------------------------------
// One database call: counts the guess, and for the right code marks the
// profile verified and uses the code up together — or, if the profile
// cannot be saved, neither, and says so.
async function verifyCode(req, res, body, user) {
  const code = body.code;
  if (!code) return res.status(400).json({ error: 'code is required' });
  if (!/^\d{6}$/.test(String(code))) return res.status(400).json({ error: 'Code must be 6 digits.' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Supabase server config missing.' });

  const checked = await rpc('ws_verify_code_check', { p_user: user.id, p_code_hash: sha256(String(code)) },
    { url: SUPABASE_URL, key: SERVICE_KEY, request: fetch });
  if (!checked.ok) {
    return res.status(checked.status === 0 || checked.status >= 500 ? 503 : 502)
      .json({ error: 'verify_failed', message: 'Your email could not be verified just now. Try the same code again in a moment.' });
  }
  const c = checked.data || {};
  if (c.ok) return res.status(200).json({ success: true });
  switch (c.reason) {
    case 'no_code': return res.status(410).json({ error: 'no_code', message: 'No pending code — request a new one.' });
    case 'expired': return res.status(410).json({ error: 'expired', message: 'Code expired — request a new one.' });
    case 'too_many_attempts': return res.status(429).json({ error: 'too_many_attempts', message: 'Too many wrong codes — request a new one.' });
    default: return res.status(401).json({ error: 'wrong_code', message: 'That code is not right. Try again.', attempts_left: c.attempts_left });
  }
}

function renderVerificationEmail({ name, code, company }) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#0b1120;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b1120;padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#111827;border:1px solid #1f2937;border-radius:20px;overflow:hidden;">
        <tr><td style="padding:32px 32px 8px;">
          <div style="font-size:12px;font-weight:800;letter-spacing:2px;color:#94a3b8;text-transform:uppercase;">WorkSuite</div>
          <h1 style="margin:12px 0 8px;font-size:22px;font-weight:900;color:#f8fafc;">Verify your email</h1>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.55;color:#cbd5e1;">
            Hi ${escapeHtml(name)}, use the code below to finish creating your ${escapeHtml(company)} account. The code expires in 15 minutes.
          </p>
        </td></tr>
        <tr><td style="padding:0 32px 20px;" align="center">
          <div style="display:inline-block;padding:16px 28px;border-radius:14px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);letter-spacing:8px;font-size:32px;font-weight:900;color:#fff;">
            ${code}
          </div>
        </td></tr>
        <tr><td style="padding:12px 32px 32px;">
          <p style="margin:0;font-size:12px;line-height:1.55;color:#64748b;">
            Didn't ask for this? Ignore this email — someone probably mistyped their address. Your account is safe.
          </p>
        </td></tr>
      </table>
      <div style="margin-top:14px;font-size:11px;color:#475569;">Sent by WorkSuite on behalf of ${escapeHtml(company)}</div>
    </td></tr>
  </table>
</body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
