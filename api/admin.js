// Password-gated admin API. Uses the Supabase service_role key to bypass RLS
// and return every employee's test results for the dashboard.
//
// Env vars required in Vercel:
//   SUPABASE_URL              (also used by /api/config)
//   SUPABASE_SERVICE_ROLE_KEY (server-only, keep secret)
//   ADMIN_PASSWORD            (the shared admin password)

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

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Unknown error' });
  }
};
