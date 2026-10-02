'use strict';
const { resolveShift } = require('../company-config');
const { istParts, addDaysIso, shiftDays, holidayOn } = require('./attendance');
const delivery = require('./delivery');

const WINDOW_MS = 60 * 60 * 1000;

// Scheduled notices announce a timetable. They never manufacture attendance.
function scheduledJobs({ profiles, shifts, targets, holidays, leaves, now }) {
  const at = new Date(now).getTime();
  const today = istParts(new Date(at)).isoDate;
  const dates = [addDaysIso(today, -1), today];
  const byShift = new Map(shifts.map(s => [s.id, s]));
  const byCompany = new Map(targets.map(t => [t.company, t]));
  const jobs = [];
  for (const p of profiles) {
    if (p.status !== 'active' || !p.employee_code) continue;
    const parts = [[1, p.company, resolveShift(p, byShift)],
      [2, p.company2, byShift.get(p.shift2_id)]];
    for (const [part, company, shift] of parts) {
      const target = byCompany.get(company);
      if (!shift || !target || !target.enabled || !target.dialog_id) continue;
      for (const date of dates) {
        const weekday = new Date(date + 'T12:00:00Z').getUTCDay() || 7;
        if (!shiftDays(shift).includes(weekday) || holidayOn(date, holidays, company)) continue;
        // Any approved leave suppresses a timetable notice for that shift day.
        if (leaves.some(l => l.user_id === p.id && l.status === 'approved' && l.start_date <= date && l.end_date >= date)) continue;
        const start = Date.parse(`${date}T${shift.start_time}+05:30`);
        let end = Date.parse(`${date}T${shift.end_time}+05:30`);
        if (end <= start) end += 86400000;
        for (const [event, due] of [['login', start], ['logout', end]]) {
          if (!target[`auto_${event}`] || !Number.isFinite(due) || at < due || at >= due + WINDOW_MS) continue;
          // Include shift part and day, but not the edited time: changing a
          // schedule after it sent must not generate another notice that day.
          const when = istParts(new Date(due));
          const kind = `scheduled_${event}`;
          jobs.push({ key: `bitrix:shift:${p.id}:${date}:${part}:${event}`, channel: 'bitrix', kind,
            company, source_table: 'profiles', source_id: p.id,
            expires_at: new Date(due + WINDOW_MS).toISOString(),
            payload: { company, enroll: p.employee_code, user_id: p.id, kind,
              message: `${p.full_name || 'Employee'} · ${event === 'login' ? 'Login' : 'Logout'} · scheduled shift ${event === 'login' ? 'start' : 'end'}\n${when.prettyTime} IST · ${when.prettyDate}\nSchedule notice; biometric attendance is recorded separately.` } });
        }
      }
    }
  }
  return jobs;
}

async function queueScheduled({ sb, targets, db, now = Date.now(), deadlineAt = Infinity, clock = Date.now }) {
  const report = { queued: 0, existing: 0, notes: [] };
  if (!targets.some(t => t.enabled && t.dialog_id && (t.auto_login || t.auto_logout))) return report;
  const today = istParts(new Date(now)).isoDate;
  const yesterday = addDaysIso(today, -1);
  async function read(path) {
    const rows = [];
    for (let offset = 0; offset < 20000; offset += 1000) {
      if (clock() >= deadlineAt) throw new Error('schedule read reached its time budget');
      const r = await sb(`${path}&limit=1000&offset=${offset}`);
      if (!r.ok) throw new Error('schedule data could not be read');
      const page = await r.json();
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
    throw new Error('schedule data exceeds 20,000 rows');
  }
  try {
    const [profiles, shifts, holidays, leaves, existing] = await Promise.all([
      read('profiles?select=id,full_name,status,company,employee_code,shift_id,shift2_id,company2&status=eq.active&order=id.asc'),
      read('shifts?select=*&order=id.asc'),
      read(`holidays?select=*&holiday_date=gte.${yesterday}&holiday_date=lte.${today}&order=id.asc`),
      read(`leave_requests?select=user_id,status,start_date,end_date&status=eq.approved&start_date=lte.${today}&end_date=gte.${yesterday}&order=id.asc`),
      read(`delivery_jobs?select=idempotency_key&kind=in.(scheduled_login,scheduled_logout)&created_at=gte.${yesterday}T00:00:00Z&order=id.asc`),
    ]);
    const known = new Set(existing.map(j => j.idempotency_key));
    const jobs = scheduledJobs({ profiles, shifts, holidays, leaves, targets, now });
    for (const job of jobs) {
      if (known.has(job.key)) { report.existing++; continue; }
      if (clock() >= deadlineAt) { report.notes.push('schedule queue reached its time budget'); break; }
      const r = await delivery.enqueue(db, job);
      if (!r.ok) { report.notes.push('scheduled messages failed to queue; check the delivery queue migration'); break; }
      if (r.created) report.queued++; else report.existing++;
    }
  } catch (e) { report.notes.push(`scheduled messages failed: ${e.message}`); }
  return report;
}

module.exports = { scheduledJobs, queueScheduled, WINDOW_MS };
