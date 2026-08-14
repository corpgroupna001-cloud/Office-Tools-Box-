// Web Push API — subscribe devices + send notifications that arrive even
// when the WorkSuite tab (or the whole browser window) is closed.
//
// Env vars required in Vercel:
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY  (web-push VAPID keypair)
//   VAPID_SUBJECT                          (mailto: contact, e.g. mailto:network.admin@sportsmart.com)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
//
// Auth model: every POST must carry the CALLER'S OWN Supabase access token
// (Authorization: Bearer <jwt>). We verify it against Supabase Auth, so only
// logged-in employees can subscribe themselves or notify colleagues.

const webpush = require('web-push');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
  const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:network.admin@sportsmart.com';

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.status(500).json({ error: 'VAPID keys not configured' });
  }

  // Public key for the browser's pushManager.subscribe()
  if (req.method === 'GET') {
    return res.status(200).json({ publicKey: VAPID_PUBLIC_KEY });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase server config missing' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const action = String(body.action || '');

  // ---- Verify the caller's Supabase session token ----
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization token' });
  let caller = null;
  try {
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
    });
    if (!ur.ok) return res.status(401).json({ error: 'Invalid session' });
    caller = await ur.json();
  } catch {
    return res.status(401).json({ error: 'Auth check failed' });
  }
  if (!caller?.id) return res.status(401).json({ error: 'Invalid session' });

  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };

  try {
    if (action === 'subscribe') {
      const sub = body.subscription || {};
      const endpoint = String(sub.endpoint || '');
      const p256dh = String(sub.keys?.p256dh || '');
      const auth = String(sub.keys?.auth || '');
      if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: 'Invalid subscription' });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?on_conflict=endpoint`, {
        method: 'POST',
        headers: { ...H, Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          user_id: caller.id,
          endpoint, p256dh, auth,
          user_agent: String(body.user_agent || '').slice(0, 300)
        })
      });
      if (!r.ok) return res.status(502).json({ error: 'subscribe_failed', detail: (await r.text()).slice(0, 200) });
      return res.status(200).json({ success: true });
    }

    if (action === 'unsubscribe') {
      const endpoint = String(body.endpoint || '');
      if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
      await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}&user_id=eq.${caller.id}`, {
        method: 'DELETE', headers: H
      });
      return res.status(200).json({ success: true });
    }

    if (action === 'notify') {
      // Push a notification to another employee's subscribed devices.
      const to = String(body.to || '');
      if (!to) return res.status(400).json({ error: 'to (user id) required' });
      const title = String(body.title || 'WorkSuite').slice(0, 100);
      const msg = String(body.body || '').slice(0, 300);
      const url = String(body.url || '/chat/').slice(0, 200);
      const tag = String(body.tag || 'worksuite').slice(0, 60);

      const sr = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?user_id=eq.${encodeURIComponent(to)}&select=*`, { headers: H });
      if (!sr.ok) return res.status(502).json({ error: 'subscriptions_fetch_failed' });
      const subs = await sr.json();
      if (!subs.length) return res.status(200).json({ success: true, sent: 0, reason: 'no_subscriptions' });

      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
      const payload = JSON.stringify({ title, body: msg, url, tag, from: caller.id });

      let sent = 0, cleaned = 0;
      await Promise.all(subs.map(async s => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
            { TTL: tag === 'call' ? 40 : 3600, urgency: tag === 'call' ? 'high' : 'normal' }
          );
          sent++;
        } catch (e) {
          const code = e?.statusCode;
          if (code === 404 || code === 410) {
            cleaned++;
            try {
              await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, {
                method: 'DELETE', headers: H
              });
            } catch {}
          }
        }
      }));
      return res.status(200).json({ success: true, sent, cleaned });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e.message || e).slice(0, 200) });
  }
};
