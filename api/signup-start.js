// ============================================================
// WorkSuite — step 1 of sign-up: validate + email an OTP.
// NO auth user is created here. The account only comes into
// existence in /api/signup-complete after the code checks out.
//
// POST { email, company, full_name }
//   → 200 { success, expires_at }
//   → 409 email already registered
//   → 503 company email coming soon (Navyug Raise A Player)
// ============================================================

const crypto = require('crypto');
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function sixDigits() { return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); }

const ALLOWED_COMPANIES = [
  'Nova Sportsmart Private Limited',
  'CORPGROUP',
  'Protathlitis Sportsmart LLP',
  'Jobways Point LLP',
  'Genie Lamp Private Limited',
];
const COMING_SOON = ['Navyug Raise A Player Foundation', 'Raise a Player'];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const email     = String(body.email || '').trim().toLowerCase();
  const company   = String(body.company || '');
  const full_name = String(body.full_name || '').trim();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'invalid_email', message: 'Please enter a valid email address.' });
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

  // Already registered? (profiles carries every account's email)
  try {
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id&email=eq.${encodeURIComponent(email)}&limit=1`, { headers: H });
    if (pr.ok) {
      const rows = await pr.json();
      if (rows.length) return res.status(409).json({ error: 'already_registered', message: 'An account with this email already exists. Try logging in instead.' });
    }
  } catch {}

  // Store (or replace) the pending code — 15 minute window.
  const code = sixDigits();
  const up = await fetch(`${SUPABASE_URL}/rest/v1/pending_signups`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      email,
      code_hash: sha256(code),
      attempts: 0,
      sent_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    })
  });
  if (!up.ok) return res.status(502).json({ error: 'store_code_failed', detail: (await up.text()).slice(0, 300) });

  // Email the code through the company-routed sender.
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const name = full_name || email.split('@')[0];
  const mailRes = await fetch(`${proto}://${req.headers.host}/api/mail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worksuite-mail-key': MAIL_KEY },
    body: JSON.stringify({
      company, to: email,
      subject: `Your WorkSuite verification code: ${code}`,
      html: renderOtpEmail({ name, code, company }),
    })
  });
  if (!mailRes.ok) {
    const detail = await mailRes.json().catch(() => ({}));
    return res.status(502).json({ error: 'mail_failed', message: 'Could not send the verification email. Please try again.', detail });
  }
  return res.status(200).json({ success: true, expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
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
