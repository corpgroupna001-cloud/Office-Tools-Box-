// ============================================================
// WorkSuite — issue a signup verification code.
//
// Flow:
//   1) Client signs the user up via supabase-js (existing signup form).
//      Because "Confirm email" is OFF in Supabase Auth, the user is
//      immediately logged in, but profiles.email_verified is false.
//   2) Client POSTs { user_id, email, company, full_name } to this endpoint.
//   3) Server generates a 6-digit code, sha256-hashes it, upserts into
//      public.signup_verifications with a 15-minute expiry, then calls
//      /api/mail with the company-mapped sender.
//   4) Client shows an "Enter the 6-digit code" step and POSTs to
//      /api/verify-code — which flips profiles.email_verified = true.
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MAIL_API_KEY.
// ============================================================

const crypto = require('crypto');

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function sixDigits() {
  // crypto.randomInt is uniformly distributed; padStart guards leading zeros.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { user_id, email, company, full_name } = body;
  if (!user_id || !email || !company) {
    return res.status(400).json({ error: 'user_id, email, and company are required' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const MAIL_KEY     = process.env.MAIL_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Supabase server config missing.' });
  if (!MAIL_KEY)                     return res.status(500).json({ error: 'MAIL_API_KEY not configured.' });

  // Navyug Raise A Player Foundation — email is not wired up yet. Auto-verify so
  // signup isn't blocked, but tell the client so the UI can show a friendly
  // "coming soon" note instead of pretending an email was sent.
  const COMING_SOON = new Set(['Navyug Raise A Player Foundation', 'Raise a Player']);
  if (COMING_SOON.has(company)) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user_id}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email_verified: true, company })
      });
    } catch {}
    return res.status(200).json({ success: true, skipped: 'email_coming_soon', message: 'Verification email is coming soon for Raise a Player. Your account is active.' });
  }

  const code = sixDigits();
  const codeHash = sha256(code);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  // Upsert the code (one active code per user; re-requests overwrite).
  const upRes = await fetch(`${SUPABASE_URL}/rest/v1/signup_verifications`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      user_id, code_hash: codeHash, attempts: 0,
      sent_at: new Date().toISOString(), expires_at: expiresAt,
    })
  });
  if (!upRes.ok) {
    const detail = (await upRes.text()).slice(0, 300);
    return res.status(502).json({ error: 'store_code_failed', detail });
  }

  // Also stamp the chosen company on the profile so admin dashboards + future
  // routing decisions have it.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user_id}`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ company })
    });
  } catch {}

  // Send the code via the company-routed mail endpoint.
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const mailUrl = `${proto}://${req.headers.host}/api/mail`;
  const displayName = full_name || (email || '').split('@')[0] || 'there';
  const html = renderVerificationEmail({ name: displayName, code, company });
  const mailRes = await fetch(mailUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worksuite-mail-key': MAIL_KEY },
    body: JSON.stringify({
      company, to: email,
      subject: `Your WorkSuite verification code: ${code}`,
      html,
    })
  });
  if (!mailRes.ok) {
    const detail = await mailRes.json().catch(() => ({}));
    return res.status(502).json({ error: 'mail_failed', detail });
  }
  return res.status(200).json({ success: true, expires_at: expiresAt });
};

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
