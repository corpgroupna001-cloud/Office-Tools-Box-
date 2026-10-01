// @ts-check
// Whether a push may go to someone now, from their notification settings
// (supabase-notification-prefs-migration.sql; the policy is described there).
// Pure: callers fetch the settings and apply the answer. Only pushes are
// affected — the in-app notification is always kept.
'use strict';

const CATEGORIES = ['messages', 'tasks', 'crm', 'calendar', 'projects', 'documents', 'reminders', 'other'];
const REMINDER_KINDS = new Set(['task.reminder', 'task.digest', 'event.reminder', 'lead.follow_up', 'invoice.overdue']);

/** The category of a notification kind (task.assigned), a push type (message, call) or a notify tag (task, document). */
function categoryOf(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'call' || k === 'call-end' || k.startsWith('call-')) return 'calls';
  if (REMINDER_KINDS.has(k)) return 'reminders';
  if (k === 'message' || k === 'mention' || k.startsWith('conversation') || k.startsWith('dm-') || k.startsWith('grp-') || k === 'comment' || k.startsWith('comment.')) return 'messages';
  const head = k.split(/[.:-]/)[0];
  if (head === 'task') return 'tasks';
  if (['deal', 'lead', 'contact', 'company', 'quote', 'invoice', 'crm'].includes(head)) return 'crm';
  if (head === 'event' || head === 'calendar') return 'calendar';
  if (head === 'project' || head === 'board') return 'projects';
  if (head === 'document' || head === 'whiteboard') return 'documents';
  return 'other';
}

/** Minutes after midnight of `now` in time zone tz (falls back to India time for an unknown zone). */
function minutesIn(tz, now) {
  const fmt = zone => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  let parts;
  try { parts = fmt(tz || 'Asia/Kolkata'); } catch { parts = fmt('Asia/Kolkata'); }
  const get = t => Number((parts.find(p => p.type === t) || {}).value || 0);
  return get('hour') * 60 + get('minute');
}
const toMinutes = t => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** Is it quiet for these settings at `now`? Start > end runs across midnight; start = end is no quiet time. */
function inQuietHours(prefs, now = new Date()) {
  if (!prefs || !prefs.quiet_enabled) return false;
  const start = toMinutes(prefs.quiet_start), end = toMinutes(prefs.quiet_end);
  if (start == null || end == null || start === end) return false;
  const t = minutesIn(prefs.timezone, now);
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/**
 * May this push go now?
 * -> { allowed: true } | { allowed: false, reason: 'off' | 'muted' | 'quiet', retry: boolean }
 * `retry` is true only for quiet hours: the push may be sent once they end.
 */
function pushDecision(prefs, kind, now = new Date()) {
  if (!prefs) return { allowed: true };                 // no settings saved: as before, every push
  const cat = categoryOf(kind);
  if (String(kind) === 'call-end') return { allowed: true };   // only clears a ringing notification
  if (prefs.push_enabled === false) return { allowed: false, reason: 'off', retry: false };
  if (cat !== 'calls' && Array.isArray(prefs.muted_categories) && prefs.muted_categories.includes(cat)) return { allowed: false, reason: 'muted', retry: false };
  if (inQuietHours(prefs, now) && !(cat === 'calls' && prefs.calls_in_quiet !== false)) return { allowed: false, reason: 'quiet', retry: true };
  return { allowed: true };
}

/**
 * Everyone's settings, by user id, read with the service key.
 * An empty map when the table does not exist yet (before migration 22): nothing is held back.
 */
async function loadPrefs(userIds, { url, key, request = fetch }) {
  const ids = [...new Set(userIds)].filter(Boolean);
  const out = new Map();
  if (!ids.length) return out;
  try {
    const r = await request(`${url}/rest/v1/notification_prefs?user_id=in.(${ids.join(',')})&select=*`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!r.ok) return out;
    for (const p of /** @type {any[]} */ (await r.json())) out.set(p.user_id, p);
  } catch { /* settings unavailable: send as before */ }
  return out;
}

module.exports = { CATEGORIES, categoryOf, inQuietHours, pushDecision, loadPrefs, minutesIn };
