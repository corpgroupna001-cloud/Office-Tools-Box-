// Password-gated admin API. Uses the Supabase service_role key to bypass RLS
// and return every employee's test results for the dashboard.
//
// Env vars required in Vercel:
//   SUPABASE_URL              (also used by /api/config)
//   SUPABASE_SERVICE_ROLE_KEY (server-only, keep secret)
//   ADMIN_PASSWORD            (the shared admin password)
//   SMTP_* (see lib/mailer.js) — used by the attendance resend action

const { sendMail } = require('../lib/mailer');
const { istParts, istToday, buildPunchEmail } = require('../lib/attendance');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const password = String(body.password || '');
  const action   = String(body.action || 'results');

  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD not configured on server.' });
  }
  if (!password || password !== ADMIN_PASSWORD) {
    // Small delay to slow brute-force. Not a defense on its own — pick a strong password.
    await new Promise(r => setTimeout(r, 500));
    return res.status(401).json({ error: 'Invalid password' });
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase server config missing (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).' });
  }

  try {
    if (action === 'results') {
      // Fetch every result, most recent first. Cap at 1000 for now.
      const r = await fetch(`${SUPABASE_URL}/rest/v1/test_results?select=*&order=created_at.desc&limit=1000`, {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`
        }
      });
      if (!r.ok) {
        const msg = (await r.text()).slice(0, 300);
        return res.status(502).json({ error: 'Supabase fetch failed', detail: msg });
      }
      const results = await r.json();
      return res.status(200).json({ results });
    }

    if (action === 'quiz_results') {
      // Fetch quiz_results. If the table doesn't exist yet, fall back to test_results marked as MCQ Quiz.
      let r = await fetch(`${SUPABASE_URL}/rest/v1/quiz_results?select=*&order=created_at.desc&limit=2000`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      if (r.ok) {
        const results = await r.json();
        return res.status(200).json({ results, source: 'quiz_results' });
      }
      // Fallback: pull MCQ rows from test_results
      const alt = await fetch(`${SUPABASE_URL}/rest/v1/test_results?select=*&category=eq.MCQ%20Quiz&order=created_at.desc&limit=2000`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      if (!alt.ok) {
        const msg = (await alt.text()).slice(0, 200);
        return res.status(502).json({ error: 'Fetch failed', detail: msg });
      }
      const raw = await alt.json();
      // Map test_results shape to quiz_results shape for a uniform client
      const results = raw.map(r => {
        const parts = (r.theme || '').split('_');
        return {
          id: r.id,
          user_id: r.user_id,
          full_name: r.full_name,
          email: r.email,
          category: parts[1] || null,
          category_label: r.theme_label || null,
          score: r.wpm,
          total: r.cpm || 10,
          accuracy: r.accuracy,
          time_sec: r.duration,
          difficulty: parts[2] || null,
          violations: 0,
          auto_submitted: false,
          ai_generated: false,
          ai_topic: null,
          created_at: r.created_at
        };
      });
      return res.status(200).json({ results, source: 'test_results_fallback' });
    }

    if (action === 'employees') {
      // Fetch profiles + typing results + quiz results in parallel; aggregate per-user stats.
      const [pRes, tRes, qRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/profiles?select=*&order=created_at.desc&limit=2000`, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
        }),
        fetch(`${SUPABASE_URL}/rest/v1/test_results?select=user_id,wpm,accuracy,category,created_at&limit=10000`, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
        }),
        // quiz_results may not exist yet — best-effort fetch, ignore errors
        fetch(`${SUPABASE_URL}/rest/v1/quiz_results?select=user_id,score,total,accuracy,violations,created_at&limit=10000`, {
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
        })
      ]);
      if (!pRes.ok) return res.status(502).json({ error: 'Profiles fetch failed' });
      if (!tRes.ok) return res.status(502).json({ error: 'Results fetch failed' });
      const profiles = await pRes.json();
      const results = await tRes.json();
      // Separate typing results from MCQ-in-test_results (fallback)
      const typing = results.filter(r => r.category !== 'MCQ Quiz');
      const stats = {};
      typing.forEach(r => {
        const s = stats[r.user_id] || { tests: 0, best_wpm: 0, best_accuracy: 0, last_test_at: null };
        s.tests++;
        if ((r.wpm || 0) > s.best_wpm) s.best_wpm = r.wpm || 0;
        if ((r.accuracy || 0) > s.best_accuracy) s.best_accuracy = r.accuracy || 0;
        if (!s.last_test_at || new Date(r.created_at) > new Date(s.last_test_at)) s.last_test_at = r.created_at;
        stats[r.user_id] = s;
      });
      // Quiz stats (from quiz_results if available, else from test_results MCQ entries)
      let quizRows = [];
      if (qRes.ok) {
        quizRows = await qRes.json();
      } else {
        // Fallback: use test_results MCQ entries — wpm=score, cpm=total
        quizRows = results.filter(r => r.category === 'MCQ Quiz').map(r => ({
          user_id: r.user_id, score: r.wpm, total: r.cpm || 10,
          accuracy: r.accuracy, violations: 0, created_at: r.created_at
        }));
      }
      const quizStats = {};
      quizRows.forEach(r => {
        const s = quizStats[r.user_id] || { quiz_attempts: 0, best_quiz_score: 0, quiz_violations: 0 };
        s.quiz_attempts++;
        if ((r.score || 0) > s.best_quiz_score) s.best_quiz_score = r.score || 0;
        s.quiz_violations += r.violations || 0;
        quizStats[r.user_id] = s;
      });
      const employees = profiles.map(p => ({
        ...p,
        tests: stats[p.id]?.tests || 0,
        best_wpm: stats[p.id]?.best_wpm || 0,
        best_accuracy: stats[p.id]?.best_accuracy || 0,
        last_test_at: stats[p.id]?.last_test_at || null,
        quiz_attempts: quizStats[p.id]?.quiz_attempts || 0,
        best_quiz_score: quizStats[p.id]?.best_quiz_score || 0,
        quiz_violations: quizStats[p.id]?.quiz_violations || 0
      }));
      return res.status(200).json({ employees });
    }

    if (action === 'update_employee') {
      const id = String(body.id || '');
      const full_name = String(body.full_name || '').trim();
      if (!id || !full_name) return res.status(400).json({ error: 'id and full_name required' });
      // Update profiles + auth.users user_metadata + all test_results so displays stay in sync
      const p = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${id}`, {
        method: 'PATCH',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify({ full_name })
      });
      if (!p.ok) {
        const err = (await p.text()).slice(0, 200);
        return res.status(502).json({ error: 'Profile update failed', detail: err });
      }
      // Best-effort auth metadata update
      try {
        await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
          method: 'PUT',
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ user_metadata: { full_name } })
        });
      } catch {}
      // Best-effort denormalized test_results.full_name update
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/test_results?user_id=eq.${id}`, {
          method: 'PATCH',
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ full_name })
        });
      } catch {}
      return res.status(200).json({ success: true });
    }

    if (action === 'set_wfh') {
      const id = String(body.id || '');
      const is_wfh = body.is_wfh === true;
      if (!id) return res.status(400).json({ error: 'id required' });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${id}`, {
        method: 'PATCH',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify({ is_wfh })
      });
      if (!r.ok) return res.status(502).json({ error: 'WFH flag update failed', detail: (await r.text()).slice(0, 200) });
      return res.status(200).json({ success: true, is_wfh });
    }

    if (action === 'set_device') {
      // Toggle which devices a WFH employee must record (mobile/laptop/tab).
      const id = String(body.id || '');
      const device = String(body.device || '');
      const on = body.on === true;
      if (!id) return res.status(400).json({ error: 'id required' });
      if (!['mobile', 'laptop', 'tab'].includes(device)) {
        return res.status(400).json({ error: 'device must be mobile|laptop|tab' });
      }
      const patch = {}; patch[`req_${device}`] = on;
      const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify(patch)
      });
      if (!r.ok) return res.status(502).json({ error: 'Device flag update failed', detail: (await r.text()).slice(0, 200) });
      return res.status(200).json({ success: true, device, on });
    }

    if (action === 'wfh_recordings') {
      // Admin view — list all recordings, joined with a signed URL PER device clip.
      const week = body.week ? `&week_of=eq.${encodeURIComponent(String(body.week))}` : '';
      const r = await fetch(`${SUPABASE_URL}/rest/v1/wfh_recordings?select=*${week}&order=created_at.desc&limit=1000`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      if (!r.ok) return res.status(502).json({ error: 'Recordings fetch failed' });
      const rows = await r.json();

      async function signOne(path) {
        if (!path) return null;
        try {
          const sr = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/wfh-recordings/${path}`, {
            method: 'POST',
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ expiresIn: 3600 })
          });
          if (sr.ok) {
            const j = await sr.json();
            return `${SUPABASE_URL}/storage/v1${j.signedURL || j.signedUrl || ''}`;
          }
        } catch {}
        return null;
      }

      // Which devices does each employee actually need? (admin toggles)
      const userIds = [...new Set(rows.map(x => x.user_id).filter(Boolean))];
      const reqMap = {};
      if (userIds.length) {
        try {
          const pr = await fetch(
            `${SUPABASE_URL}/rest/v1/profiles?id=in.(${userIds.join(',')})&select=id,req_mobile,req_laptop,req_tab`,
            { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
          );
          if (pr.ok) (await pr.json()).forEach(p => { reqMap[p.id] = p; });
        } catch {}
      }

      const signed = await Promise.all(rows.map(async row => {
        const [mobile_url, laptop_url, tab_url, video_url] = await Promise.all([
          signOne(row.mobile_path),
          signOne(row.laptop_path),
          signOne(row.tab_path),
          signOne(row.video_path), // v2 back-compat
        ]);
        const p = reqMap[row.user_id];
        const required = p
          ? ['mobile', 'laptop', 'tab'].filter(d => p[`req_${d}`] !== false)
          : ['mobile', 'laptop', 'tab'];
        return { ...row, mobile_url, laptop_url, tab_url, video_url, required };
      }));
      return res.status(200).json({ recordings: signed });
    }

    if (action === 'wfh_delete') {
      // Delete one device clip (device: mobile|laptop|tab) or the whole
      // submission (device: 'all') — removes Storage files + row/columns.
      const id = String(body.id || '');
      const device = String(body.device || 'all');
      if (!id) return res.status(400).json({ error: 'id required' });
      if (!['mobile', 'laptop', 'tab', 'all'].includes(device)) {
        return res.status(400).json({ error: 'device must be mobile|laptop|tab|all' });
      }
      const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
      const rowRes = await fetch(`${SUPABASE_URL}/rest/v1/wfh_recordings?id=eq.${encodeURIComponent(id)}&select=*&limit=1`, { headers: H });
      if (!rowRes.ok) return res.status(502).json({ error: 'row fetch failed' });
      const row = (await rowRes.json())[0];
      if (!row) return res.status(404).json({ error: 'not_found' });

      const devices = device === 'all' ? ['mobile', 'laptop', 'tab'] : [device];
      const paths = devices.map(d => row[`${d}_path`]).filter(Boolean);
      if (device === 'all' && row.video_path) paths.push(row.video_path); // v2 legacy single-clip

      // Remove the files from Storage (bulk delete endpoint).
      if (paths.length) {
        const del = await fetch(`${SUPABASE_URL}/storage/v1/object/wfh-recordings`, {
          method: 'DELETE',
          headers: { ...H, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefixes: paths })
        });
        if (!del.ok) {
          const msg = (await del.text()).slice(0, 200);
          return res.status(502).json({ error: 'storage_delete_failed', detail: msg });
        }
      }

      if (device === 'all') {
        const dr = await fetch(`${SUPABASE_URL}/rest/v1/wfh_recordings?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: H });
        if (!dr.ok) return res.status(502).json({ error: 'row_delete_failed' });
      } else {
        const patch = {};
        patch[`${device}_path`] = null;
        patch[`${device}_bytes`] = null;
        patch[`${device}_secs`] = null;
        patch[`${device}_device`] = null;
        const pr = await fetch(`${SUPABASE_URL}/rest/v1/wfh_recordings?id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { ...H, 'Content-Type': 'application/json' },
          body: JSON.stringify(patch)
        });
        if (!pr.ok) return res.status(502).json({ error: 'row_update_failed' });
      }
      return res.status(200).json({ success: true, deleted_files: paths.length, device });
    }

    if (action === 'wfh_review') {
      // QC verdict on a submission: approved (all good) or rejected
      // (QC failed — employee must re-record and re-upload live videos).
      const id = String(body.id || '');
      const status = String(body.status || '');
      const note = String(body.note || '').slice(0, 500);
      if (!id) return res.status(400).json({ error: 'id required' });
      if (!['approved', 'rejected', 'pending'].includes(status)) {
        return res.status(400).json({ error: 'status must be approved|rejected|pending' });
      }
      const pr = await fetch(`${SUPABASE_URL}/rest/v1/wfh_recordings?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify({
          status,
          review_note: status === 'rejected' ? (note || 'Quality check failed — please re-record all three videos.') : null,
          reviewed_at: new Date().toISOString()
        })
      });
      if (!pr.ok) return res.status(502).json({ error: 'review_update_failed', detail: (await pr.text()).slice(0, 200) });
      const updated = (await pr.json())[0] || null;
      return res.status(200).json({ success: true, status, row: updated });
    }

    if (action === 'friday_report') {
      // Per-Friday compliance report for every WFH employee:
      //  - Typing test: submitted in the Friday window 5:00 PM – 8:00 PM IST or not
      //  - WFH device videos: uploaded per required device + QC status
      //  - Violations: anything missing/QC-failed => 1-day salary cut policy
      let week = String(body.week || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) {
        const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
        ist.setUTCDate(ist.getUTCDate() - ((ist.getUTCDay() - 5 + 7) % 7)); // most recent Friday
        week = ist.toISOString().slice(0, 10);
      }
      // Friday typing test window: 5:00 PM – 8:00 PM IST, expressed in UTC
      const dayStart = new Date(`${week}T17:00:00+05:30`).toISOString();
      const dayEnd = new Date(`${week}T20:00:00+05:30`).toISOString();
      const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

      const [pRes2, rRes2, tRes2] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/profiles?is_wfh=eq.true&select=id,full_name,email,company,req_mobile,req_laptop,req_tab`, { headers: H }),
        fetch(`${SUPABASE_URL}/rest/v1/wfh_recordings?week_of=eq.${week}&select=user_id,mobile_path,laptop_path,tab_path,status,review_note`, { headers: H }),
        fetch(`${SUPABASE_URL}/rest/v1/test_results?created_at=gte.${encodeURIComponent(dayStart)}&created_at=lte.${encodeURIComponent(dayEnd)}&select=user_id,wpm,accuracy,category,duration,created_at&limit=5000`, { headers: H }),
      ]);
      if (!pRes2.ok) return res.status(502).json({ error: 'profiles fetch failed' });
      const employees = await pRes2.json();
      const recRows = rRes2.ok ? await rRes2.json() : [];
      const testRows = (tRes2.ok ? await tRes2.json() : []).filter(t => t.category !== 'MCQ Quiz');

      const recByUser = new Map(recRows.map(r => [r.user_id, r]));
      const testsByUser = new Map();
      testRows.forEach(t => {
        if (!testsByUser.has(t.user_id)) testsByUser.set(t.user_id, []);
        testsByUser.get(t.user_id).push(t);
      });

      const rows = employees.map(emp => {
        const required = ['mobile', 'laptop', 'tab'].filter(d => emp[`req_${d}`] !== false);
        const rec = recByUser.get(emp.id);
        const uploaded = required.filter(d => rec && rec[`${d}_path`]);
        const missing = required.filter(d => !uploaded.includes(d));
        const qcStatus = rec ? (rec.status || 'pending') : null;
        const videosOk = required.length > 0 && missing.length === 0 && qcStatus !== 'rejected';

        const tests = testsByUser.get(emp.id) || [];
        const typingOk = tests.length > 0;
        const bestWpm = typingOk ? Math.max(...tests.map(t => Number(t.wpm) || 0)) : null;
        const bestAcc = typingOk ? Math.max(...tests.map(t => Number(t.accuracy) || 0)) : null;

        const violations = [];
        if (!typingOk) violations.push('Typing test not submitted');
        if (required.length && missing.length) violations.push(`Videos missing: ${missing.join(', ')}`);
        if (qcStatus === 'rejected') violations.push('Videos QC failed');

        return {
          id: emp.id,
          name: emp.full_name || '',
          email: emp.email || '',
          company: emp.company || '',
          typing: { submitted: typingOk, tests: tests.length, best_wpm: bestWpm, best_acc: bestAcc },
          videos: { required, uploaded, missing, qc: qcStatus, note: rec?.review_note || null, ok: videosOk },
          violations,
          penalty: violations.length ? '1 day salary cut' : null
        };
      });

      const summary = {
        wfh_total: rows.length,
        typing_submitted: rows.filter(r => r.typing.submitted).length,
        typing_missing: rows.filter(r => !r.typing.submitted).length,
        videos_ok: rows.filter(r => r.videos.ok).length,
        videos_missing: rows.filter(r => !r.videos.ok).length,
        violations: rows.filter(r => r.violations.length).length
      };
      return res.status(200).json({ week, rows, summary });
    }

    if (action === 'delete_employee') {
      const id = String(body.id || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      // Delete the auth user; cascades to profiles + test_results via FK ON DELETE CASCADE
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
        method: 'DELETE',
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
      });
      if (!r.ok) {
        const err = (await r.text()).slice(0, 200);
        return res.status(502).json({ error: 'Delete failed', detail: err });
      }
      return res.status(200).json({ success: true });
    }

    if (action === 'reset_password') {
      const id = String(body.id || '');
      const email = String(body.email || '').trim();
      if (!email) return res.status(400).json({ error: 'email required' });
      // Trigger a password recovery email via GoTrue admin API
      const r = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
        method: 'POST',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email })
      });
      if (!r.ok) {
        const err = (await r.text()).slice(0, 200);
        return res.status(502).json({ error: 'Reset failed', detail: err });
      }
      return res.status(200).json({ success: true });
    }

    // ================= BIOMETRIC ATTENDANCE =================
    // Folded in here rather than living in its own api/attendance.js: Vercel's
    // Hobby plan caps a deployment at 12 serverless functions and we were
    // already at the cap. This file is the password-gated admin action router,
    // so the attendance admin actions belong here anyway. Actions are prefixed
    // att_ so they can't collide with the ones above.
    if (String(action).startsWith('att_')) {
      const attStartedAt = Date.now();
      const RESEND_DEADLINE_MS = 7500;
      const AH = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
      const sb = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...AH, ...(opts.headers || {}) } });
      const loadProfiles = async () => {
        const r = await sb('profiles?select=id,email,full_name,company,employee_code&limit=2000');
        if (!r.ok) throw new Error('profiles fetch failed: ' + (await r.text()).slice(0, 160));
        return r.json();
      };

    // ------------------------------------------------------------------
    // Daily report — the sheet an admin actually wants each morning.
    // ------------------------------------------------------------------
    if (action === 'att_daily_report') {
      const date = String(body.date || istToday()).slice(0, 10);

      const [profiles, logsRes] = await Promise.all([
        loadProfiles(),
        sb(`attendance_logs?log_date=eq.${date}&select=*&order=log_datetime.asc&limit=5000`),
      ]);
      if (!logsRes.ok) return res.status(502).json({ error: 'logs fetch failed', detail: (await logsRes.text()).slice(0, 200) });
      const logs = await logsRes.json();

      const byUser = new Map();     // user_id -> punches
      const orphans = new Map();    // employee_code -> punches (no profile)

      for (const l of logs) {
        const bucket = l.user_id ? byUser : orphans;
        const key = l.user_id || l.employee_code;
        if (!bucket.has(key)) bucket.set(key, []);
        bucket.get(key).push(l);
      }

      const summarize = (punches) => {
        const ins  = punches.filter(p => p.direction === 'IN');
        const outs = punches.filter(p => p.direction === 'OUT');
        // If the device never told us the direction, fall back to
        // first-punch / last-punch for the day.
        const firstIn  = ins.length  ? ins[0]                 : (punches.length > 1 ? punches[0] : null);
        const lastOut  = outs.length ? outs[outs.length - 1]  : (punches.length > 1 ? punches[punches.length - 1] : null);

        let minutes = null;
        if (firstIn && lastOut) {
          const diff = new Date(lastOut.log_datetime) - new Date(firstIn.log_datetime);
          if (diff > 0) minutes = Math.round(diff / 60000);
        }

        return {
          first_in:      firstIn ? firstIn.log_datetime : null,
          first_in_time: firstIn ? istParts(new Date(firstIn.log_datetime)).prettyTime : null,
          last_out:      lastOut ? lastOut.log_datetime : null,
          last_out_time: lastOut ? istParts(new Date(lastOut.log_datetime)).prettyTime : null,
          punches:       punches.length,
          minutes,
          duration:      minutes == null ? null : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`,
          mail_sent:     punches.filter(p => p.email_status === 'sent').length,
          mail_problem:  punches.filter(p => ['failed', 'pending', 'unmapped'].includes(p.email_status)).length,
          devices:       [...new Set(punches.map(p => p.device_name || p.device_sn).filter(Boolean))],
        };
      };

      const rows = profiles
        .map(p => {
          const punches = byUser.get(p.id) || [];
          const s = summarize(punches);
          let status = 'Absent';
          if (punches.length) status = (s.first_in && !s.last_out) ? 'No check-out' : 'Present';
          return {
            user_id: p.id, full_name: p.full_name, email: p.email,
            company: p.company, employee_code: p.employee_code || null,
            status, ...s,
          };
        })
        .sort((a, b) => {
          const rank = v => v === 'Present' ? 0 : v === 'No check-out' ? 1 : 2;
          return rank(a.status) - rank(b.status)
            || String(a.full_name || '').localeCompare(String(b.full_name || ''));
        });

      const unknown = [...orphans.entries()].map(([code, punches]) => ({
        employee_code: code,
        employee_name: punches[0]?.employee_name || null,
        status: 'Unmapped',
        ...summarize(punches),
      }));

      return res.status(200).json({
        date,
        rows,
        unknown,
        totals: {
          employees:  rows.length,
          present:    rows.filter(r => r.status === 'Present').length,
          no_checkout: rows.filter(r => r.status === 'No check-out').length,
          absent:     rows.filter(r => r.status === 'Absent').length,
          punches:    logs.length,
          mail_sent:  logs.filter(l => l.email_status === 'sent').length,
          mail_problem: logs.filter(l => ['failed', 'pending', 'unmapped'].includes(l.email_status)).length,
          unmapped_codes: unknown.length,
        },
      });
    }

    // ------------------------------------------------------------------
    // Raw punch feed
    // ------------------------------------------------------------------
    if (action === 'att_logs') {
      const limit = Math.min(Number(body.limit) || 300, 2000);
      const date  = body.date ? String(body.date).slice(0, 10) : null;
      const q = `attendance_logs?select=*&order=log_datetime.desc&limit=${limit}` + (date ? `&log_date=eq.${date}` : '');

      const [profiles, r] = await Promise.all([loadProfiles(), sb(q)]);
      if (!r.ok) return res.status(502).json({ error: 'logs fetch failed', detail: (await r.text()).slice(0, 200) });
      const logs = await r.json();
      const nameById = new Map(profiles.map(p => [p.id, p]));

      return res.status(200).json({
        logs: logs.map(l => {
          const p = l.user_id ? nameById.get(l.user_id) : null;
          const d = new Date(l.log_datetime);
          const t = istParts(d);
          return {
            ...l,
            full_name: p ? p.full_name : (l.employee_name || null),
            company:   p ? p.company : null,
            pretty_time: t.prettyTime,
            pretty_date: t.prettyDate,
          };
        }),
      });
    }

    // ------------------------------------------------------------------
    // Mapping queue
    // ------------------------------------------------------------------
    if (action === 'att_unmapped') {
      const [profiles, r] = await Promise.all([
        loadProfiles(),
        sb('attendance_logs?user_id=is.null&select=employee_code,employee_name,log_datetime&order=log_datetime.desc&limit=2000'),
      ]);
      const orphanLogs = r.ok ? await r.json() : [];

      const codes = new Map();
      for (const l of orphanLogs) {
        if (!codes.has(l.employee_code)) {
          codes.set(l.employee_code, { employee_code: l.employee_code, employee_name: l.employee_name, punches: 0, last_seen: l.log_datetime });
        }
        codes.get(l.employee_code).punches++;
      }

      return res.status(200).json({
        unmapped_codes: [...codes.values()],
        // Every profile, not just unbound ones — auto-linking matches on the
        // name the device sends, so an admin must be able to re-point a code
        // that landed on the wrong person.
        free_profiles: profiles
          .map(p => ({ id: p.id, full_name: p.full_name, email: p.email, company: p.company, employee_code: p.employee_code || null }))
          .sort((a, b) => String(a.full_name || '').localeCompare(String(b.full_name || ''))),
        mapped: profiles
          .filter(p => p.employee_code)
          .map(p => ({ id: p.id, full_name: p.full_name, email: p.email, employee_code: p.employee_code }))
          .sort((a, b) => String(a.full_name || '').localeCompare(String(b.full_name || ''))),
      });
    }

    if (action === 'att_map_code' || action === 'att_unmap_code') {
      const userId = String(body.user_id || '');
      if (!userId) return res.status(400).json({ error: 'user_id required' });
      const code = action === 'att_map_code' ? String(body.employee_code || '').trim() : null;
      if (action === 'att_map_code' && !code) return res.status(400).json({ error: 'employee_code required' });

      // The code is unique across profiles. If somebody else holds it (a bad
      // auto-link, or a re-issued device code), release it first so the bind
      // below can't fail on the unique index.
      if (code) {
        await sb(`profiles?employee_code=eq.${encodeURIComponent(code)}&id=neq.${encodeURIComponent(userId)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ employee_code: null }),
        }).catch(() => {});
      }

      const up = await sb(`profiles?id=eq.${encodeURIComponent(userId)}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ employee_code: code }),
      });
      if (!up.ok) {
        const detail = (await up.text()).slice(0, 250);
        // 23505 = another profile already owns this code.
        return res.status(409).json({ error: 'map failed', detail });
      }

      // Adopt every past punch that was parked as unmapped under this code.
      let adopted = 0;
      if (code) {
        const back = await sb(`attendance_logs?employee_code=eq.${encodeURIComponent(code)}`, {
          method: 'PATCH', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ user_id: userId, email_status: 'skipped', email_error: 'Mapped after the fact — historical punch, not emailed.' }),
        });
        if (back.ok) adopted = (await back.json()).length;
      }

      return res.status(200).json({ success: true, employee_code: code, backfilled_logs: adopted });
    }

    // ------------------------------------------------------------------
    // Resend notifications that never made it out
    // ------------------------------------------------------------------
    if (action === 'att_resend') {
      const profiles = await loadProfiles();
      const byId = new Map(profiles.map(p => [p.id, p]));

      let q;
      if (body.id) {
        q = `attendance_logs?id=eq.${encodeURIComponent(String(body.id))}&select=*`;
      } else {
        const date = String(body.date || istToday()).slice(0, 10);
        q = `attendance_logs?log_date=eq.${date}&email_status=in.(failed,pending)&user_id=not.is.null&select=*&order=log_datetime.asc&limit=200`;
      }
      const r = await sb(q);
      if (!r.ok) return res.status(502).json({ error: 'logs fetch failed', detail: (await r.text()).slice(0, 200) });
      const logs = await r.json();

      let sent = 0, failed = 0, skipped = 0;
      const deadlineAt = attStartedAt + RESEND_DEADLINE_MS;

      for (const l of logs) {
        if (Date.now() > deadlineAt) { skipped++; continue; }
        const p = l.user_id ? byId.get(l.user_id) : null;
        if (!p || !p.email) { skipped++; continue; }

        const when = new Date(l.log_datetime);
        const { subject, html, text } = buildPunchEmail({
          fullName: p.full_name, direction: l.direction, when,
          deviceName: l.device_name, employeeCode: l.employee_code,
        });
        const result = await sendMail({ company: p.company, to: p.email, subject, html, text });
        if (result.ok) sent++; else failed++;

        await sb(`attendance_logs?id=eq.${l.id}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            email_status: result.ok ? 'sent' : 'failed',
            email_to: p.email,
            emailed_at: result.ok ? new Date().toISOString() : null,
            email_error: result.ok ? null : `${result.reason}: ${result.detail}`.slice(0, 400),
          }),
        }).catch(() => {});
      }

      return res.status(200).json({ success: true, candidates: logs.length, sent, failed, skipped });
    }

      return res.status(400).json({ error: 'Unknown attendance action' });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Unknown error' });
  }
};
