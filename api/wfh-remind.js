// Friday WFH reminder blast — pushes a notification to every WFH employee
// who hasn't finished uploading their assigned check-in videos this week.
// Reaches them even when the site is closed (Web Push).
//
// Triggered by:
//   - Vercel Cron every Friday morning (Authorization: Bearer CRON_SECRET)
//   - Manually by admin tooling (x-worksuite-mail-key: MAIL_API_KEY, ?force=1
//     skips the Friday check)

const webpush = require('web-push');

module.exports = async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
  const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:network.admin@sportsmart.com';

  // ---- Auth: Vercel cron OR admin shared key ----
  const authz = String(req.headers.authorization || '');
  const cronOk = process.env.CRON_SECRET && authz === `Bearer ${process.env.CRON_SECRET}`;
  const keyOk = process.env.MAIL_API_KEY && req.headers['x-worksuite-mail-key'] === process.env.MAIL_API_KEY;
  if (!cronOk && !keyOk) return res.status(401).json({ error: 'unauthorized' });

  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'supabase config missing' });
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return res.status(500).json({ error: 'vapid config missing' });

  // ---- Friday (IST) guard — ?force=1 with admin key overrides ----
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const isFriday = istNow.getUTCDay() === 5;
  const force = keyOk && String(req.query?.force || '') === '1';
  if (!isFriday && !force) {
    return res.status(200).json({ success: true, skipped: 'not_friday_ist' });
  }
  const weekOf = istNow.toISOString().slice(0, 10);

  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
  try {
    const [pRes, rRes, sRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/profiles?is_wfh=eq.true&select=id,full_name,req_mobile,req_laptop,req_tab`, { headers: H }),
      fetch(`${SUPABASE_URL}/rest/v1/wfh_recordings?week_of=eq.${weekOf}&select=user_id,mobile_path,laptop_path,tab_path,status`, { headers: H }),
      fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth`, { headers: H }),
    ]);
    if (!pRes.ok) return res.status(502).json({ error: 'profiles fetch failed' });
    const wfhEmployees = await pRes.json();
    const rows = rRes.ok ? await rRes.json() : [];
    const subs = sRes.ok ? await sRes.json() : [];

    const rowByUser = new Map(rows.map(r => [r.user_id, r]));
    const subsByUser = new Map();
    subs.forEach(s => {
      if (!subsByUser.has(s.user_id)) subsByUser.set(s.user_id, []);
      subsByUser.get(s.user_id).push(s);
    });

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

    let notified = 0, alreadyDone = 0, noSubscription = 0, cleaned = 0;
    const details = [];

    for (const emp of wfhEmployees) {
      const required = ['mobile', 'laptop', 'tab'].filter(d => emp[`req_${d}`] !== false);
      if (!required.length) continue;
      const row = rowByUser.get(emp.id);
      const rejected = row?.status === 'rejected';
      const missing = rejected ? required : required.filter(d => !row || !row[`${d}_path`]);
      if (!missing.length) { alreadyDone++; continue; }

      const empSubs = subsByUser.get(emp.id) || [];
      if (!empSubs.length) { noSubscription++; details.push({ name: emp.full_name, missing, pushed: false }); continue; }

      const deviceList = missing.map(d => d === 'mobile' ? '📱 Mobile' : d === 'laptop' ? '💻 Laptop' : '📲 Tab').join(', ');
      const payload = JSON.stringify({
        title: rejected ? '📷 QC failed — re-record your WFH videos' : '📷 Friday WFH Check-in — upload your videos',
        body: `Record on your PERSONAL MOBILE: ${deviceList}. High quality, all sides & corners — admin approval required.`,
        url: '/recordings/',
        tag: 'wfh-reminder'
      });

      let sent = false;
      await Promise.all(empSubs.map(async s => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload, { TTL: 6 * 3600 }
          );
          sent = true;
        } catch (e) {
          if (e?.statusCode === 404 || e?.statusCode === 410) {
            cleaned++;
            try {
              await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, {
                method: 'DELETE', headers: H
              });
            } catch {}
          }
        }
      }));
      if (sent) notified++;
      details.push({ name: emp.full_name, missing, pushed: sent });
    }

    return res.status(200).json({ success: true, week_of: weekOf, wfh_total: wfhEmployees.length, notified, alreadyDone, noSubscription, cleaned, details });
  } catch (e) {
    return res.status(500).json({ error: 'server error', detail: String(e.message || e).slice(0, 200) });
  }
};
