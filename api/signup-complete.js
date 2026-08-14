// ============================================================
// WorkSuite — step 2 of sign-up: verify the OTP, THEN create
// the account. If this endpoint is never called with the right
// code, the account simply never exists.
//
// POST { email, code, password, full_name, company, avatar_url }
//   → 200 { success }             account created + verified
//   → 401 wrong code              (attempts capped at 6)
//   → 410 expired / no code      → client offers "resend"
//   → 409 already registered
// ============================================================

const crypto = require('crypto');
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const email      = String(body.email || '').trim().toLowerCase();
  const code       = String(body.code || '');
  const password   = String(body.password || '');
  const full_name  = String(body.full_name || '').trim();
  const company    = String(body.company || '');
  const avatar_url = typeof body.avatar_url === 'string' ? body.avatar_url : null;

  if (!email || !code)            return res.status(400).json({ error: 'email and code are required' });
  if (!/^\d{6}$/.test(code))      return res.status(400).json({ error: 'bad_code', message: 'Code must be 6 digits.' });
  if (password.length < 6)        return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 6 characters.' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Supabase server config missing.' });
  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

  // ---- 1) Look up + validate the pending code ----
  const pr = await fetch(`${SUPABASE_URL}/rest/v1/pending_signups?select=*&email=eq.${encodeURIComponent(email)}&limit=1`, { headers: H });
  if (!pr.ok) return res.status(502).json({ error: 'lookup_failed', detail: (await pr.text()).slice(0, 300) });
  const row = (await pr.json())[0];
  if (!row) return res.status(410).json({ error: 'no_code', message: 'No pending code for this email — request a new one.' });
  if (new Date(row.expires_at) < new Date()) {
    return res.status(410).json({ error: 'expired', message: 'Code expired — request a new one.' });
  }
  if ((row.attempts || 0) >= 6) {
    return res.status(429).json({ error: 'too_many_attempts', message: 'Too many wrong codes — request a new one.' });
  }
  if (sha256(code) !== row.code_hash) {
    await fetch(`${SUPABASE_URL}/rest/v1/pending_signups?email=eq.${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ attempts: (row.attempts || 0) + 1 })
    });
    return res.status(401).json({ error: 'wrong_code', message: 'That code is not right. Try again.' });
  }

  // ---- 2) Code is good — NOW create the account (pre-confirmed) ----
  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true, // verified via our OTP — no Supabase confirmation email
      // IMPORTANT: never put avatar_url (a base64 data URL) in user_metadata —
      // Supabase embeds user_metadata inside every JWT, and a ~30KB avatar
      // makes the Authorization header exceed nginx's limit → HTML 400s on
      // Storage uploads. Avatars live in public.profiles only.
      user_metadata: { full_name, company },
    })
  });
  const created = await createRes.json().catch(() => ({}));
  if (!createRes.ok) {
    const msg = (created.msg || created.message || created.error_description || '').toLowerCase();
    if (createRes.status === 422 || msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
      return res.status(409).json({ error: 'already_registered', message: 'An account with this email already exists. Try logging in instead.' });
    }
    return res.status(502).json({ error: 'create_failed', detail: JSON.stringify(created).slice(0, 300) });
  }
  const userId = created.id || created.user?.id;

  // ---- 3) Stamp the profile (row is auto-created by the DB trigger) ----
  if (userId) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          id: userId, email, full_name: full_name || null,
          company, email_verified: true,
          ...(avatar_url ? { avatar_url } : {}),
        })
      });
    } catch {}
  }

  // ---- 4) Burn the code ----
  await fetch(`${SUPABASE_URL}/rest/v1/pending_signups?email=eq.${encodeURIComponent(email)}`, { method: 'DELETE', headers: H });

  return res.status(200).json({ success: true });
};
