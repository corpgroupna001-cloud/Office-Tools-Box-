// Audit non-attendance mail only. Attendance already records each attempt on
// attendance_logs; keeping that path unchanged preserves its response deadline.
async function recordMail({ company, to, category }, result) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return false;
  try {
    const r = await fetch(url + '/rest/v1/mail_events', {
      method: 'POST', signal: AbortSignal.timeout(800),
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ company, recipient: String(to || '').slice(0, 254),
        category: ['verification','test','system','invoice'].includes(category) ? category : 'system',
        status: result.ok ? 'accepted' : 'failed', sender: result.from || null,
        message_id: result.messageId || null, reason: result.reason || null })
    });
    if (!r.ok) console.warn('Mail audit unavailable:', r.status);
    return r.ok;
  } catch { console.warn('Mail audit unavailable'); return false; }
}
module.exports = { recordMail };
