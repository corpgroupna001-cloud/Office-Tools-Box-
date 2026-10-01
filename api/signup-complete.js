// ============================================================
// WorkSuite — step 2 of sign-up: verify the OTP, THEN create
// the account. If this endpoint is never called with the right
// code, the account simply never exists.
//
// The code is checked by one database call (ws_signup_code_check) under a
// row lock: every guess counts, even twenty sent at once, and a right code
// holds the sign-up so two parallel completions cannot both go ahead. The
// company is the one the code was issued for (step 1), not one sent now.
//
// Finishing is retryable. The login account is created, remembered against
// the code (ws_signup_mark_created), and the profile is stamped, the
// invitation claimed and the code used up in one transaction
// (ws_signup_finish). If any step fails, the code still works: entering it
// again finishes the same account instead of making another. The reply only
// says success once all of that is saved.
//
// POST { email, code, password, full_name, company, avatar_url }
//   → 200 { success, status }      status: 'active' (invited) | 'pending' (waits for approval)
//   → 401 wrong code               (attempts capped at 6)
//   → 410 expired / no code      → client offers "resend"
//   → 409 already registered / a completion already in progress
//   → 429 too many attempts
//   → 502/503 could not finish   → the same code can be entered again
// ============================================================

const crypto = require('crypto');
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

const { readJson, clientIp } = require('../lib/request-auth');
const { rpc } = require('../lib/service-rpc');
const { ALLOWED_COMPANIES } = require('./signup-start');

// An avatar is a small compressed data URL (index.html makes ~400px JPEGs).
const MAX_AVATAR = 300 * 1024;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const body = readJson(req);
  if (!body) return res.status(400).json({ error: 'Invalid JSON' });
  const email      = String(body.email || '').trim().toLowerCase();
  const code       = String(body.code || '');
  const password   = String(body.password || '');
  const company    = String(body.company || '');
  const avatar_url = typeof body.avatar_url === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(body.avatar_url)
    && body.avatar_url.length <= MAX_AVATAR ? body.avatar_url : null;

  if (!email || !code)            return res.status(400).json({ error: 'email and code are required' });
  if (!/^\d{6}$/.test(code))      return res.status(400).json({ error: 'bad_code', message: 'Code must be 6 digits.' });
  if (password.length < 6 || password.length > 72) return res.status(400).json({ error: 'weak_password', message: 'Password must be 6 to 72 characters.' });
  if (company && !ALLOWED_COMPANIES.includes(company)) return res.status(400).json({ error: 'invalid_company', message: 'Please select a valid company.' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Supabase server config missing.' });
  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
  const db = { url: SUPABASE_URL, key: SERVICE_KEY, request: fetch };
  const unavailable = () => res.status(503).json({ error: 'unavailable', message: 'Sign-up is unavailable right now. Please try again in a few minutes.' });

  // Guesses from one network address, across every mailbox.
  const ip = await rpc('ws_rate_hit', { p_key: `signup-complete:ip:${clientIp(req)}`, p_window_seconds: 3600, p_max: 60 }, db);
  if (!ip.ok) return unavailable();
  if (!ip.data.allowed) {
    res.setHeader('Retry-After', String(ip.data.retry_after || 3600));
    return res.status(429).json({ error: 'too_many_requests', message: 'Too many attempts from this network. Try again later.' });
  }

  // ---- 1) Check the code: one locked database call ----
  const checked = await rpc('ws_signup_code_check', { p_email: email, p_code_hash: sha256(code) }, db);
  if (!checked.ok) return unavailable();
  const c = checked.data || {};
  if (!c.ok) {
    switch (c.reason) {
      case 'no_code': return res.status(410).json({ error: 'no_code', message: 'No pending code for this email — request a new one.' });
      case 'expired': return res.status(410).json({ error: 'expired', message: 'Code expired — request a new one.' });
      case 'too_many_attempts': return res.status(429).json({ error: 'too_many_attempts', message: 'Too many wrong codes — request a new one.' });
      case 'in_progress': return res.status(409).json({ error: 'in_progress', message: 'This sign-up is already being completed. Wait a moment, then sign in.' });
      default: return res.status(401).json({ error: 'wrong_code', message: 'That code is not right. Try again.', attempts_left: c.attempts_left });
    }
  }
  const release = () => rpc('ws_signup_release', { p_email: email }, db);
  // The company was fixed when the code was sent.
  if (company && company !== c.company) {
    await release();
    return res.status(400).json({ error: 'company_changed', message: 'The company changed after the code was sent. Request a new code.' });
  }
  const notFinished = () => res.status(502).json({ error: 'not_finished',
    message: 'Your account could not be finished just now. Enter the same code again in a moment to finish it.' });

  // ---- 2) The login account: create it, or find the one an earlier try created ----
  let userId = c.created_user_id || null;
  try {
    if (userId) {
      // A retry: the account exists; the password typed now is the one they will use.
      const up = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
        method: 'PUT', headers: H, body: JSON.stringify({ password }),
      });
      if (!up.ok) { await release(); return notFinished(); }
    } else {
      const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST', headers: H,
        body: JSON.stringify({
          email,
          password,
          email_confirm: true, // verified via our OTP — no Supabase confirmation email
          // IMPORTANT: never put avatar_url (a base64 data URL) in user_metadata —
          // Supabase embeds user_metadata inside every JWT, and a ~30KB avatar
          // makes the Authorization header exceed nginx's limit → HTML 400s on
          // Storage uploads. Avatars live in public.profiles only.
          // signup_ref ties the account to this code, so a retry can recognise it.
          user_metadata: { full_name: c.full_name || '', company: c.company, signup_ref: c.signup_ref },
        })
      });
      const created = await createRes.json().catch(() => ({}));
      if (createRes.ok) {
        userId = created.id || (created.user && created.user.id) || null;
      } else {
        const msg = String(created.msg || created.message || created.error_description || '').toLowerCase();
        if (createRes.status === 422 || msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
          userId = await ourEarlierAccount(email, c.signup_ref, { SUPABASE_URL, H });
          if (!userId) {
            await release();
            return res.status(409).json({ error: 'already_registered', message: 'An account with this email already exists. Try logging in instead.' });
          }
        } else {
          await release();
          return res.status(502).json({ error: 'create_failed', message: 'Could not create your account. Please try again.' });
        }
      }
      if (!userId) { await release(); return notFinished(); }
      const marked = await rpc('ws_signup_mark_created', { p_email: email, p_user: userId }, db);
      if (!marked.ok || marked.data !== true) { await release(); return notFinished(); }
    }
  } catch {
    await release();
    return notFinished();
  }

  // ---- 3) Profile, invitation and code: one transaction ----
  const finished = await rpc('ws_signup_finish', { p_email: email, p_user: userId, p_avatar_url: avatar_url }, db);
  if (!finished.ok || !finished.data || !finished.data.status) { await release(); return notFinished(); }
  return res.status(200).json({ success: true, status: finished.data.status });
};

/**
 * The account an earlier try of this same sign-up created, recognised by the
 * signup_ref only this server and that code know; null for anyone else's.
 */
async function ourEarlierAccount(email, ref, { SUPABASE_URL, H }) {
  if (!ref) return null;
  try {
    const pr = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id&email=eq.${encodeURIComponent(email)}&limit=1`, { headers: H });
    const [p] = pr.ok ? await pr.json() : [];
    if (!p) return null;
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(p.id)}`, { headers: H });
    const u = ur.ok ? await ur.json() : null;
    const meta = (u && (u.user_metadata || (u.user && u.user.user_metadata))) || {};
    return meta.signup_ref && meta.signup_ref === ref ? p.id : null;
  } catch { return null; }
}
