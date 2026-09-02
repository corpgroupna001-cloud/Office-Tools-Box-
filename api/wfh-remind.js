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

  // Retention sweep runs on every invocation, before the day guard below.
  const purged = await purgeOldSelfies(SUPABASE_URL, SERVICE_KEY);

  // Daily WFH attendance nudge. Both cron slots now fire every day (Hobby
  // allows 2 crons at daily granularity); the Friday-only WFH video and
  // typing reminders below keep their own guard, so nothing there changed.
  const nudged = await nudgeWfhAttendance({
    SUPABASE_URL, SERVICE_KEY,
    VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
  });
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return res.status(500).json({ error: 'vapid config missing' });

  // ---- Friday (IST) guard — ?force=1 with admin key overrides ----
  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const isFriday = istNow.getUTCDay() === 5;
  const force = keyOk && String(req.query?.force || '') === '1';
  if (!isFriday && !force) {
    return res.status(200).json({ success: true, skipped: 'not_friday_ist' });
  }
  const weekOf = istNow.toISOString().slice(0, 10);

  // Two reminder modes, auto-picked by IST time of day:
  //   'videos' — morning cron (9 AM IST): upload your WFH device videos
  //   'typing' — evening cron (7 PM IST): finish your Friday typing test
  // Override with ?mode=videos|typing when triggering manually.
  const qMode = String(req.query?.mode || '');
  const mode = ['videos', 'typing'].includes(qMode)
    ? qMode
    : (istNow.getUTCHours() >= 16 ? 'typing' : 'videos');

  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
  try {
    // Friday typing test window: 5:00 PM – 8:00 PM IST, in UTC — for typing-test lookups
    const dayStart = new Date(`${weekOf}T17:00:00+05:30`).toISOString();
    const dayEnd = new Date(`${weekOf}T20:00:00+05:30`).toISOString();

    const [pRes, rRes, sRes, tRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/profiles?is_wfh=eq.true&select=id,full_name,req_mobile,req_laptop,req_tab`, { headers: H }),
      fetch(`${SUPABASE_URL}/rest/v1/wfh_recordings?week_of=eq.${weekOf}&select=user_id,mobile_path,laptop_path,tab_path,status`, { headers: H }),
      fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth`, { headers: H }),
      mode === 'typing'
        ? fetch(`${SUPABASE_URL}/rest/v1/test_results?created_at=gte.${encodeURIComponent(dayStart)}&created_at=lte.${encodeURIComponent(dayEnd)}&select=user_id,category&limit=5000`, { headers: H })
        : Promise.resolve(null),
    ]);
    if (!pRes.ok) return res.status(502).json({ error: 'profiles fetch failed' });
    const wfhEmployees = await pRes.json();
    const rows = rRes.ok ? await rRes.json() : [];
    const subs = sRes.ok ? await sRes.json() : [];
    const typedToday = new Set(
      tRes && tRes.ok ? (await tRes.json()).filter(t => t.category !== 'MCQ Quiz').map(t => t.user_id) : []
    );

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
      let missing = [];
      let payload = null;

      if (mode === 'typing') {
        // 7 PM prompt: WFH employees who haven't done today's typing test
        if (typedToday.has(emp.id)) { alreadyDone++; continue; }
        missing = ['typing test'];
        payload = JSON.stringify({
          title: '⌨️ Friday Typing Test — window closes at 8:00 PM',
          body: 'Friday typing test timings: 5:00 PM – 8:00 PM. You have not submitted yet — finish before 8 PM. Not submitting is a violation (1 day salary cut policy).',
          url: '/typingtest/',
          tag: 'typing-reminder'
        });
      } else {
        const required = ['mobile', 'laptop', 'tab'].filter(d => emp[`req_${d}`] !== false);
        if (!required.length) continue;
        const row = rowByUser.get(emp.id);
        const rejected = row?.status === 'rejected';
        missing = rejected ? required : required.filter(d => !row || !row[`${d}_path`]);
        if (!missing.length) { alreadyDone++; continue; }

        const deviceList = missing.map(d => d === 'mobile' ? '📱 Mobile' : d === 'laptop' ? '💻 Laptop' : '📲 Tab').join(', ');
        payload = JSON.stringify({
          title: rejected ? '📷 QC failed — re-record your WFH videos' : '📷 Friday WFH Check-in — upload your videos',
          body: `Record on your PERSONAL MOBILE: ${deviceList}. High quality, all sides & corners — admin approval required. Not submitting = 1 day salary cut.`,
          url: '/recordings/',
          tag: 'wfh-reminder'
        });
      }

      const empSubs = subsByUser.get(emp.id) || [];
      if (!empSubs.length) { noSubscription++; details.push({ name: emp.full_name, missing, pushed: false }); continue; }

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

    return res.status(200).json({ success: true, mode, week_of: weekOf, wfh_total: wfhEmployees.length, notified, alreadyDone, noSubscription, cleaned, details });
  } catch (e) {
    return res.status(500).json({ error: 'server error', detail: String(e.message || e).slice(0, 200) });
  }
};

// ============================================================
// Selfie retention: delete photos older than the retention window and clear
// the path on the row. The attendance record itself is KEPT — only the image
// goes, so historic reports stay intact while storage stays inside the 1GB
// free tier.
// ============================================================
const SELFIE_RETENTION_DAYS = Number(process.env.SELFIE_RETENTION_DAYS || 90);

async function purgeOldSelfies(SUPABASE_URL, SERVICE_KEY) {
  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
  const cutoff = new Date(Date.now() - SELFIE_RETENTION_DAYS * 86400 * 1000).toISOString().slice(0, 10);

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/attendance_logs?source=eq.selfie&selfie_path=not.is.null` +
      `&log_date=lt.${cutoff}&select=id,selfie_path&limit=500`,
      { headers: H }
    );
    if (!r.ok) return { error: 'lookup failed' };
    const rows = await r.json();
    if (!rows.length) return { deleted: 0, cutoff };

    const del = await fetch(`${SUPABASE_URL}/storage/v1/object/selfies`, {
      method: 'DELETE', headers: H,
      body: JSON.stringify({ prefixes: rows.map(x => x.selfie_path) }),
    });

    // Only clear the paths once the files are actually gone, otherwise a
    // failed delete would orphan the objects with nothing left pointing at
    // them — invisible storage that never gets reclaimed.
    if (!del.ok) return { deleted: 0, cutoff, error: 'storage delete failed' };

    await fetch(`${SUPABASE_URL}/rest/v1/attendance_logs?id=in.(${rows.map(x => x.id).join(',')})`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
      body: JSON.stringify({ selfie_path: null, review_note: `Photo purged after ${SELFIE_RETENTION_DAYS} days` }),
    });

    return { deleted: rows.length, cutoff };
  } catch (e) {
    return { error: String(e && e.message || e).slice(0, 120) };
  }
}

// ============================================================
// Daily attendance nudge for work-from-home staff.
//
// Morning run  : anyone WFH with no LOGIN yet today.
// Evening run  : anyone WFH who logged in but never logged out.
//
// Deliberately quiet otherwise — a reminder that fires when there is nothing
// to do is one people learn to swipe away.
// ============================================================
async function nudgeWfhAttendance({ SUPABASE_URL, SERVICE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT }) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return { skipped: 'no_vapid' };
  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

  const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
  const today  = istNow.toISOString().slice(0, 10);
  const evening = istNow.getUTCHours() >= 12;   // the 7 PM IST run

  try {
    const [pRes, lRes, sRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/profiles?is_wfh=eq.true&select=id,full_name`, { headers: H }),
      fetch(`${SUPABASE_URL}/rest/v1/attendance_logs?log_date=eq.${today}&select=user_id,event_type&limit=2000`, { headers: H }),
      fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth`, { headers: H }),
    ]);
    if (!pRes.ok) return { error: 'profiles fetch failed' };
    const wfh  = await pRes.json();
    const logs = lRes.ok ? await lRes.json() : [];
    const subs = sRes.ok ? await sRes.json() : [];

    const byUser = new Map();
    logs.forEach(l => {
      if (!byUser.has(l.user_id)) byUser.set(l.user_id, new Set());
      byUser.get(l.user_id).add(l.event_type);
    });
    const subsByUser = new Map();
    subs.forEach(s => {
      if (!subsByUser.has(s.user_id)) subsByUser.set(s.user_id, []);
      subsByUser.get(s.user_id).push(s);
    });

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

    let notified = 0, nothingToDo = 0, noSubscription = 0;
    for (const emp of wfh) {
      const events = byUser.get(emp.id) || new Set();
      let payload = null;

      if (!evening && !events.has('LOGIN')) {
        payload = JSON.stringify({
          title: '📸 Daily attendance — selfie login',
          body: 'Work-from-home attendance needs a selfie login with your location. Tap to record it.',
          url: '/attendance/', tag: 'wfh-attendance-in',
        });
      } else if (evening && events.has('LOGIN') && !events.has('LOGOUT')) {
        payload = JSON.stringify({
          title: '⏰ Remember to log out',
          body: 'You logged in today but have not logged out — today will show no check-out.',
          url: '/attendance/', tag: 'wfh-attendance-out',
        });
      } else if (evening && !events.has('LOGIN')) {
        payload = JSON.stringify({
          title: '📸 No attendance recorded today',
          body: 'There is no selfie login for you today. Record it now if you worked.',
          url: '/attendance/', tag: 'wfh-attendance-in',
        });
      }

      if (!payload) { nothingToDo++; continue; }

      const empSubs = subsByUser.get(emp.id) || [];
      if (!empSubs.length) { noSubscription++; continue; }

      let sent = false;
      await Promise.all(empSubs.map(async s => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 6 * 3600 }
          );
          sent = true;
        } catch (e) {
          if (e?.statusCode === 404 || e?.statusCode === 410) {
            try {
              await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`,
                { method: 'DELETE', headers: H });
            } catch {}
          }
        }
      }));
      if (sent) notified++;
    }
    return { run: evening ? 'evening' : 'morning', wfh_total: wfh.length, notified, nothingToDo, noSubscription };
  } catch (e) {
    return { error: String(e && e.message || e).slice(0, 120) };
  }
}
