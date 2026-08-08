// ============================================================
// WorkSuite — verify the 6-digit signup code the user typed.
// On success: profiles.email_verified := true, delete the code row.
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
  const { user_id, code } = body;
  if (!user_id || !code) return res.status(400).json({ error: 'user_id and code are required' });
  if (!/^\d{6}$/.test(String(code))) return res.status(400).json({ error: 'Code must be 6 digits.' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Supabase server config missing.' });

  // Fetch the stored code row for this user
  const svRes = await fetch(`${SUPABASE_URL}/rest/v1/signup_verifications?select=*&user_id=eq.${user_id}&limit=1`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  });
  if (!svRes.ok) return res.status(502).json({ error: 'lookup_failed', detail: (await svRes.text()).slice(0, 300) });
  const rows = await svRes.json();
  const row = rows[0];
  if (!row) return res.status(410).json({ error: 'no_code', message: 'No pending code — request a new one.' });

  if (new Date(row.expires_at) < new Date()) {
    return res.status(410).json({ error: 'expired', message: 'Code expired — request a new one.' });
  }
  if ((row.attempts || 0) >= 6) {
    return res.status(429).json({ error: 'too_many_attempts', message: 'Too many wrong codes — request a new one.' });
  }
  if (sha256(String(code)) !== row.code_hash) {
    // bump attempts
    await fetch(`${SUPABASE_URL}/rest/v1/signup_verifications?user_id=eq.${user_id}`, {
      method: 'PATCH',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ attempts: (row.attempts || 0) + 1 })
    });
    return res.status(401).json({ error: 'wrong_code', message: 'That code is not right. Try again.' });
  }

  // Mark verified + delete the code (single-use)
  await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user_id}`, {
    method: 'PATCH',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email_verified: true })
  });
  await fetch(`${SUPABASE_URL}/rest/v1/signup_verifications?user_id=eq.${user_id}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  });

  return res.status(200).json({ success: true });
};
