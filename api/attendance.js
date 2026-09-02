// ============================================================
// Admin API for biometric attendance. Password-gated exactly like
// /api/admin.js, and uses the service_role key to bypass RLS.
//
// Actions (POST { password, action, ... }):
//   daily_report   { date }            per-employee first-in / last-out / hours
//   logs           { date?, limit? }   raw punch feed
//   unmapped                           device codes with no profile + free profiles
//   map_code       { user_id, employee_code }    bind a code to a person
//   unmap_code     { user_id }                   unbind
//   resend         { id } | { date }   re-send failed/pending notifications
//
// Env: ADMIN_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SMTP_*
// ============================================================

const { sendMail } = require('../lib/mailer');
const { istParts, istToday, buildPunchEmail } = require('../lib/attendance');

const RESEND_DEADLINE_MS = 7500;

module.exports = async function handler(req, res) {
  const startedAt = Date.now();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const password = String(body.password || '');
  const action   = String(body.action || 'daily_report');

  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const SUPABASE_URL   = process.env.SUPABASE_URL;
  const SERVICE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD not configured on server.' });
  if (!password || password !== ADMIN_PASSWORD) {
    await new Promise(r => setTimeout(r, 500));
    return res.status(401).json({ error: 'Invalid password' });
  }
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Supabase server config missing.' });

  const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
  const sb = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });

  const loadProfiles = async () => {
    const r = await sb('profiles?select=id,email,full_name,company,employee_code&limit=2000');
    if (!r.ok) throw new Error('profiles fetch failed: ' + (await r.text()).slice(0, 160));
    return r.json();
  };

  try {
    // ------------------------------------------------------------------
    // Daily report — the sheet an admin actually wants each morning.
    // ------------------------------------------------------------------
    if (action === 'daily_report') {
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
    if (action === 'logs') {
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
    if (action === 'unmapped') {
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

    if (action === 'map_code' || action === 'unmap_code') {
      const userId = String(body.user_id || '');
      if (!userId) return res.status(400).json({ error: 'user_id required' });
      const code = action === 'map_code' ? String(body.employee_code || '').trim() : null;
      if (action === 'map_code' && !code) return res.status(400).json({ error: 'employee_code required' });

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
    if (action === 'resend') {
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
      const deadlineAt = startedAt + RESEND_DEADLINE_MS;

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

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('[attendance-admin] error', e);
    return res.status(500).json({ error: 'server error', detail: String(e && e.message || e).slice(0, 300) });
  }
};
