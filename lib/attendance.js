// ============================================================
// Shared helpers for the biometric attendance feature.
//
// Used by /api/attendance-webhook.js (ingest + notify) and
// /api/attendance.js (admin report, remap, resend) so the two can never
// disagree about how a timestamp is parsed or how an email looks.
// ============================================================

const IST_TZ = 'Asia/Kolkata';

// ------------------------------------------------------------------
// Timestamps
// ------------------------------------------------------------------

/**
 * Parse a timestamp coming off the biometric cloud.
 *
 * The device sends naive wall-clock strings with no zone ("2026-09-02
 * 08:45:00"). Those are IST — the machines sit in the office. A string that
 * DOES carry a zone (…Z or …+05:30) is trusted as-is.
 *
 * Accepts: "YYYY-MM-DD HH:mm:ss", "YYYY-MM-DDTHH:mm:ss", "DD-MM-YYYY HH:mm:ss",
 *          "DD/MM/YYYY HH:mm:ss", with optional seconds and optional AM/PM.
 * @returns {Date|null}
 */
function parseDeviceDateTime(input) {
  if (input == null) return null;
  if (input instanceof Date) return isNaN(input.getTime()) ? null : input;

  const s = String(input).trim();
  if (!s) return null;

  // Already zoned — trust it.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  const ampm = /\b(am|pm)\b/i.exec(s);
  const bare = s.replace(/\b(am|pm)\b/i, '').trim();

  let y, mo, da, h = 0, mi = 0, se = 0;

  // YYYY-MM-DD (or YYYY/MM/DD) first — unambiguous.
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(bare);
  if (m) {
    [, y, mo, da, h = 0, mi = 0, se = 0] = m;
  } else {
    // DD-MM-YYYY / DD/MM/YYYY — Indian convention, day first.
    m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(bare);
    if (!m) {
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }
    [, da, mo, y, h = 0, mi = 0, se = 0] = m;
  }

  let hour = Number(h) || 0;
  if (ampm) {
    const isPm = /pm/i.test(ampm[1]);
    if (isPm && hour < 12) hour += 12;
    if (!isPm && hour === 12) hour = 0;
  }

  const pad = n => String(n).padStart(2, '0');
  // Pin to +05:30 so the naive wall-clock reading is interpreted as IST
  // regardless of what timezone the serverless function happens to run in.
  const iso = `${y}-${pad(mo)}-${pad(da)}T${pad(hour)}:${pad(Number(mi) || 0)}:${pad(Number(se) || 0)}+05:30`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

const _fmt = (opts) => new Intl.DateTimeFormat(opts.locale || 'en-GB', { timeZone: IST_TZ, ...opts.o });

/** IST calendar date + wall-clock time for a Date, plus display strings. */
function istParts(date) {
  const isoDate = _fmt({ locale: 'en-CA', o: { year: 'numeric', month: '2-digit', day: '2-digit' } }).format(date);
  const isoTime = _fmt({ locale: 'en-GB', o: { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false } }).format(date);
  const prettyTime = _fmt({ locale: 'en-US', o: { hour: 'numeric', minute: '2-digit', hour12: true } }).format(date);
  const prettyDate = _fmt({ locale: 'en-GB', o: { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' } }).format(date);
  return { isoDate, isoTime, prettyTime, prettyDate };
}

/** Today's date in IST as YYYY-MM-DD. */
function istToday() {
  return istParts(new Date()).isoDate;
}

// ------------------------------------------------------------------
// Punch direction
// ------------------------------------------------------------------

const IN_TOKENS  = new Set(['in', 'i', '1', 'checkin', 'check-in', 'check_in', 'entry', 'e', 'true']);
const OUT_TOKENS = new Set(['out', 'o', '0', 'checkout', 'check-out', 'check_out', 'exit', 'x', 'false']);

/** Normalise whatever the device sends into 'IN' | 'OUT' | 'UNKNOWN'. */
function normalizeDirection(value) {
  if (value == null || value === '') return 'UNKNOWN';
  const v = String(value).trim().toLowerCase();
  if (IN_TOKENS.has(v)) return 'IN';
  if (OUT_TOKENS.has(v)) return 'OUT';
  return 'UNKNOWN';
}

// ------------------------------------------------------------------
// Name matching (auto-linking employee codes)
// ------------------------------------------------------------------

/**
 * Squash a human name to a comparable key: lowercase, no punctuation,
 * single spaces. "Sirimilla  Vinay." and "sirimilla vinay" both become
 * "sirimilla vinay".
 */
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Same words in any order — catches "Vinay Sirimilla" vs "Sirimilla Vinay". */
function nameTokenKey(name) {
  return normalizeName(name).split(' ').filter(Boolean).sort().join(' ');
}

/**
 * Find the single profile a device-supplied name refers to.
 * Deliberately conservative: if two people share a name we return no match
 * and let an admin decide, rather than emailing the wrong person.
 *
 * @returns {{ profile: object|null, reason: string }}
 */
function matchProfileByName(deviceName, profiles) {
  const key = normalizeName(deviceName);
  if (!key) return { profile: null, reason: 'no_name_from_device' };

  const exact = profiles.filter(p => normalizeName(p.full_name) === key);
  if (exact.length === 1) return { profile: exact[0], reason: 'exact_name' };
  if (exact.length > 1)   return { profile: null, reason: 'ambiguous_name' };

  const tKey = nameTokenKey(deviceName);
  const reordered = profiles.filter(p => nameTokenKey(p.full_name) === tKey);
  if (reordered.length === 1) return { profile: reordered[0], reason: 'reordered_name' };
  if (reordered.length > 1)   return { profile: null, reason: 'ambiguous_name' };

  return { profile: null, reason: 'no_name_match' };
}

// ------------------------------------------------------------------
// Email
// ------------------------------------------------------------------

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Build the punch notification email.
 * Table-based and inline-styled — Outlook and the Gmail app both mangle
 * modern CSS, and this has to look right on a phone.
 */
function buildPunchEmail({ fullName, direction, when, deviceName, employeeCode, shift, eventType }) {
  const t = istParts(when);
  const isIn = direction === 'IN';
  const isOut = direction === 'OUT';

  // The event is what the reader cares about; direction is the fallback for
  // rows that predate the derivation or that arrived with no direction at all.
  const ev = eventType && PUNCH_EVENT[eventType] ? PUNCH_EVENT[eventType] : null;
  const accent     = ev ? ev.accent     : isIn ? '#10b981' : isOut ? '#f43f5e' : '#64748b';
  const accentDark = ev ? ev.accentDark : isIn ? '#059669' : isOut ? '#e11d48' : '#475569';
  const icon  = ev ? ev.icon  : isIn ? '&#8594;' : isOut ? '&#8592;' : '&#8226;';
  const emoji = ev ? ev.emoji : isIn ? '\u2705' : isOut ? '\u{1F44B}' : '\u{1F551}';
  const word  = ev ? ev.label : isIn ? 'Checked In' : isOut ? 'Checked Out' : 'Punch';
  const title = ev ? ev.title : isIn ? 'Checked In' : isOut ? 'Checked Out' : 'Punch Recorded';
  const verb  = ev ? ev.verb  : isIn ? 'checked in' : isOut ? 'checked out' : 'recorded a punch';

  const firstName = String(fullName || '').trim().split(/\s+/)[0] || 'there';

  // Shift context only where it means something. Lateness belongs to a Login
  // and leaving early to a Logout; neither says anything useful about a break,
  // and "3h before your shift ends" on a lunch break was actively misleading.
  const isLoginish  = eventType ? eventType === 'LOGIN'  : isIn;
  const isLogoutish = eventType ? eventType === 'LOGOUT' : isOut;

  let note = null;      // { text, tone: 'ok' | 'warn' }
  if (shift && shift.hasShift) {
    if (isLoginish && shift.lateMinutes != null) {
      note = shift.isLate
        ? { text: `${humanMinutes(shift.lateMinutes)} after your ${shift.window} shift start`, tone: 'warn' }
        : { text: `On time for your ${shift.window} shift`, tone: 'ok' };
    } else if (isLogoutish && shift.earlyOutMinutes != null) {
      note = shift.isEarlyOut
        ? { text: `${humanMinutes(shift.earlyOutMinutes)} before your ${shift.window} shift ends`, tone: 'warn' }
        : { text: `Full ${shift.window} shift completed`, tone: 'ok' };
    }
  }

  const lateTag = note && note.tone === 'warn'
    ? ` (${note.text.split(' after ')[0].split(' before ')[0]} ${isLoginish ? 'late' : 'early'})`
    : '';
  const subject = `${emoji} ${word} at ${t.prettyTime}${lateTag} \u2014 ${t.prettyDate}`;

  // What comes next, so the mail answers "and now what?" without being asked.
  const nextStep = {
    LOGIN:     'Punch again when you step away for a break.',
    BREAK_OUT: 'Punch again when you are back at your desk.',
    BREAK_IN:  'Punch once more at the end of your shift.',
    LOGOUT:    'That closes out your day. Nothing else to do.',
  }[eventType] || null;

  const text = [
    `Hi ${firstName},`,
    ``,
    `You ${verb} at ${t.prettyTime} on ${t.prettyDate}.`,
    ``,
    `Event   : ${word}`,
    `Time    : ${t.prettyTime} (IST)`,
    `Date    : ${t.prettyDate}`,
    note ? `Shift   : ${note.text}` : null,
    deviceName ? `Device  : ${deviceName}` : null,
    employeeCode ? `Emp Code: ${employeeCode}` : null,
    nextStep ? `` : null,
    nextStep ? nextStep : null,
    ``,
    `This is an automatic notification from WorkSuite. If this wasn't you,`,
    `please tell your admin straight away.`,
  ].filter(v => v !== null).join('\n');

  const row = (label, value) => value ? `
      <tr>
        <td style="padding:9px 0;border-bottom:1px solid #eef2f7;color:#64748b;font-size:13px;font-weight:600;">${escapeHtml(label)}</td>
        <td style="padding:9px 0;border-bottom:1px solid #eef2f7;color:#0f172a;font-size:13px;font-weight:700;text-align:right;">${escapeHtml(value)}</td>
      </tr>` : '';

  // The four steps of a day, with the current one lit. Gives the reader the
  // shape of the day at a glance instead of four near-identical emails.
  const STEPS = [['LOGIN', 'Login'], ['BREAK_OUT', 'Break out'], ['BREAK_IN', 'Break in'], ['LOGOUT', 'Logout']];
  const stepper = eventType ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;">
        <tr>${STEPS.map(([key, name]) => {
          const on = key === eventType;
          return `<td align="center" style="padding:0 2px;">
            <div style="height:4px;border-radius:2px;background:${on ? accent : '#e2e8f0'};"></div>
            <div style="margin-top:6px;font-size:10.5px;font-weight:${on ? '800' : '600'};letter-spacing:.3px;color:${on ? accent : '#94a3b8'};">${escapeHtml(name)}</div>
          </td>`;
        }).join('')}</tr>
      </table>` : '';

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;">
<span style="display:none;font-size:0;line-height:0;max-height:0;opacity:0;overflow:hidden;">${escapeHtml(word)} at ${escapeHtml(t.prettyTime)} on ${escapeHtml(t.prettyDate)}${note ? ' \u2014 ' + escapeHtml(note.text) : ''}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:28px 12px;">
 <tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;box-shadow:0 2px 12px rgba(15,23,42,0.08);">

    <tr><td style="background:linear-gradient(135deg,${accent},${accentDark});padding:26px 28px;">
      <div style="color:rgba(255,255,255,0.82);font-size:11px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;">WorkSuite Attendance</div>
      <div style="color:#ffffff;font-size:25px;font-weight:800;margin-top:5px;">${icon}&nbsp;${escapeHtml(title)}</div>
    </td></tr>

    <tr><td style="padding:26px 28px 6px 28px;">
      <p style="margin:0 0 18px 0;color:#334155;font-size:15px;line-height:1.55;">
        Hi <strong style="color:#0f172a;">${escapeHtml(firstName)}</strong>, you ${escapeHtml(verb)} at
      </p>
      <div style="text-align:center;padding:18px 12px;background:#f8fafc;border-radius:12px;border:1px solid #e8edf3;">
        <div style="color:${accent};font-size:36px;font-weight:800;letter-spacing:-0.5px;line-height:1.1;">${escapeHtml(t.prettyTime)}</div>
        <div style="color:#64748b;font-size:13px;font-weight:600;margin-top:5px;">${escapeHtml(t.prettyDate)}</div>
        ${note ? `<div style="margin-top:11px;display:inline-block;padding:5px 12px;border-radius:999px;font-size:12px;font-weight:700;background:${note.tone === 'warn' ? '#fef3c7' : '#dcfce7'};color:${note.tone === 'warn' ? '#92400e' : '#166534'};">${escapeHtml(note.text)}</div>` : ''}
        ${stepper}
      </div>
    </td></tr>

    ${nextStep ? `<tr><td style="padding:16px 28px 0 28px;">
      <div style="padding:12px 14px;background:${accent}12;border-left:3px solid ${accent};border-radius:8px;color:#334155;font-size:13px;font-weight:600;line-height:1.5;">${escapeHtml(nextStep)}</div>
    </td></tr>` : ''}

    <tr><td style="padding:20px 28px 4px 28px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${row('Event', word)}
        ${row('Time (IST)', t.prettyTime)}
        ${row('Date', t.prettyDate)}
        ${note ? row('Shift', note.text) : ''}
        ${row('Device', deviceName)}
        ${row('Employee Code', employeeCode)}
      </table>
    </td></tr>

    <tr><td style="padding:20px 28px 28px 28px;">
      <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">
        Automatic notification from the WorkSuite attendance system.
        If this wasn't you, tell your admin straight away.
      </p>
    </td></tr>

  </table>
 </td></tr>
</table>
</body></html>`;

  return { subject, html, text };
}


// ------------------------------------------------------------------
// Shifts
// ------------------------------------------------------------------

/** "09:30" / "09:30:00" -> minutes since midnight. */
function timeToMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 480 -> "08:00". */
function minutesToTime(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Human 95 -> "1h 35m", 24 -> "24m". */
function humanMinutes(mins) {
  const n = Math.abs(Math.round(mins));
  if (n < 60) return `${n}m`;
  return `${Math.floor(n / 60)}h ${String(n % 60).padStart(2, '0')}m`;
}

/**
 * Signed offset of a clock time from a shift boundary, in minutes.
 *
 * Both are times-of-day, so a night shift (22:00 → 07:00) would otherwise
 * produce nonsense: a 01:00 punch looks 21 hours "early" for a 22:00 start.
 * Rotating the difference onto (-720, +720] treats the nearer side of the
 * clock as the real one, so 01:00 vs 22:00 reads as 3 hours late, not 21
 * hours early — which is what actually happened.
 *
 * Positive = after the boundary (late in / stayed on).
 * Negative = before it (early in / left early).
 */
function offsetFromBoundary(clockMinutes, boundaryMinutes) {
  const rel = (((clockMinutes - boundaryMinutes) % 1440) + 1440) % 1440;
  return rel <= 720 ? rel : rel - 1440;
}

/** ISO weekday for a Date, in IST. 1 = Monday … 7 = Sunday. */
function istIsoWeekday(date) {
  const name = new Intl.DateTimeFormat('en-GB', { timeZone: IST_TZ, weekday: 'short' }).format(date);
  return ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 })[name] || null;
}

const DAY_LABEL = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };

/** "Mon–Sat" where the run is contiguous, else "Mon, Wed, Fri". */
function describeWorkingDays(days) {
  const list = [...new Set((days || []).map(Number))].filter(d => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (!list.length) return '—';
  if (list.length === 7) return 'All days';
  const contiguous = list.every((d, i) => i === 0 || d === list[i - 1] + 1);
  return contiguous && list.length > 2
    ? `${DAY_LABEL[list[0]]}–${DAY_LABEL[list[list.length - 1]]}`
    : list.map(d => DAY_LABEL[d]).join(', ');
}

/* ==========================================================================
 * Which of the four events a punch actually is
 *
 * The reader only ever sends a timestamp and (sometimes) a direction, so
 * "IN" and "OUT" were all the emails could say. What people want to read is
 * the event: they logged in, stepped out for a break, came back, went home.
 *
 * IN is easy - the first of the day is a Login, any later one is a Break in.
 * OUT is the hard one, because at the moment of the punch nobody knows
 * whether another punch is coming. So there are two derivations:
 *
 *   deriveEventType  - what we can tell AT THE TIME, used for the email that
 *                      goes out seconds later. An OUT at or after the shift
 *                      end (less the early-out grace) is a Logout; earlier
 *                      than that it is a Break out.
 *   deriveDayEvents  - exact, once the day is over or at least further along:
 *                      the LAST out of the day is the Logout, every earlier
 *                      one is a break. Used for the screens and the backfill.
 *
 * They can disagree for one person on one day - somebody who leaves two hours
 * early gets a "Break out" email and then reads "Logout" on the calendar.
 * That is the honest outcome: the email cannot see the future, the calendar can.
 * ========================================================================== */

const PUNCH_EVENT = {
  LOGIN:     { label: 'Login',      title: 'Login recorded',    verb: 'logged in',
               icon: '\u2192', emoji: '\u2705', accent: '#10b981', accentDark: '#059669' },
  BREAK_OUT: { label: 'Break out',  title: 'Break started',     verb: 'started a break',
               icon: '\u2615', emoji: '\u2615', accent: '#f59e0b', accentDark: '#d97706' },
  BREAK_IN:  { label: 'Break in',   title: 'Back from break',   verb: 'came back from a break',
               icon: '\u21A9', emoji: '\u{1F504}', accent: '#3b82f6', accentDark: '#2563eb' },
  LOGOUT:    { label: 'Logout',     title: 'Logout recorded',   verb: 'logged out',
               icon: '\u2190', emoji: '\u{1F44B}', accent: '#f43f5e', accentDark: '#e11d48' },
};

/**
 * Best call at punch time.
 *
 * @param priorsToday how many punches this person already has today
 * @param isFinalOut  pass true/false when the day is known; leave undefined
 *                    at punch time and the shift end decides
 */
function deriveEventType({ priorsToday, direction, when, shift, isFinalOut }) {
  const priors = Number(priorsToday) || 0;
  if (direction === 'IN')  return priors === 0 ? 'LOGIN' : 'BREAK_IN';
  if (direction !== 'OUT') return null;          // UNKNOWN stays unknown

  if (isFinalOut === true)  return 'LOGOUT';
  if (isFinalOut === false) return 'BREAK_OUT';

  // Unknown: is this punch at the end of the shift?
  const end = shift ? timeToMinutes(shift.end_time) : null;
  if (end == null || !when) return 'BREAK_OUT';
  const grace = Number(shift.early_out_grace_minutes || 0);
  const clock = timeToMinutes(istParts(new Date(when)).isoTime);
  // offsetFromBoundary rotates onto (-720,+720], so an 02:00 punch against a
  // 03:00 overnight end reads as 60 minutes early, not 22 hours late.
  return offsetFromBoundary(clock, end) >= -grace ? 'LOGOUT' : 'BREAK_OUT';
}

/**
 * Exact labelling for a whole day, once the punches are all in hand.
 * Returns a Map of punch id -> event type.
 */
function deriveDayEvents(punches) {
  const list = (punches || []).slice()
    .sort((a, b) => new Date(a.log_datetime) - new Date(b.log_datetime));
  const out = new Map();
  let seenIn = false;
  let lastOutId = null;
  list.forEach(p => { if (p.direction === 'OUT') lastOutId = p.id; });
  list.forEach(p => {
    if (p.direction === 'IN') {
      out.set(p.id, seenIn ? 'BREAK_IN' : 'LOGIN');
      seenIn = true;
    } else if (p.direction === 'OUT') {
      out.set(p.id, p.id === lastOutId ? 'LOGOUT' : 'BREAK_OUT');
    } else {
      out.set(p.id, null);
    }
  });
  return out;
}

/** Human label for an event, falling back to the bare direction. */
function eventLabel(eventType, direction) {
  if (eventType && PUNCH_EVENT[eventType]) return PUNCH_EVENT[eventType].label;
  return direction === 'IN' ? 'In' : direction === 'OUT' ? 'Out' : 'Punch';
}

/**
 * Compare a day's first IN / last OUT against the employee's shift.
 * Returns nulls rather than guessing when there is no shift assigned.
 */
function evaluateShift({ shift, firstIn, lastOut, date }) {
  if (!shift) {
    return { hasShift: false, isWorkingDay: null, lateMinutes: null, earlyOutMinutes: null,
             isLate: false, isEarlyOut: false, window: null };
  }

  const start = timeToMinutes(shift.start_time);
  const end   = timeToMinutes(shift.end_time);
  const window = `${minutesToTime(start)}–${minutesToTime(end)}`;

  const weekday = date ? istIsoWeekday(date) : null;
  const days = (shift.working_days || []).map(Number);
  const isWorkingDay = weekday == null ? null : days.includes(weekday);

  const grace      = Number(shift.grace_minutes || 0);
  const outGrace   = Number(shift.early_out_grace_minutes || 0);

  let lateMinutes = null, earlyOutMinutes = null;

  if (firstIn) {
    const t = timeToMinutes(istParts(new Date(firstIn)).isoTime);
    const off = offsetFromBoundary(t, start);
    lateMinutes = off > 0 ? off : 0;          // arriving early is not a number anyone needs
  }
  if (lastOut) {
    const t = timeToMinutes(istParts(new Date(lastOut)).isoTime);
    const off = offsetFromBoundary(t, end);
    earlyOutMinutes = off < 0 ? -off : 0;     // staying late is not "early out"
  }

  return {
    hasShift: true,
    name: shift.name,
    window,
    isWorkingDay,
    lateMinutes,
    earlyOutMinutes,
    isLate:     lateMinutes     != null && lateMinutes     > grace,
    isEarlyOut: earlyOutMinutes != null && earlyOutMinutes > outGrace,
    graceMinutes: grace,
    earlyOutGraceMinutes: outGrace,
  };
}

/* ==========================================================================
 * Bitrix24 chat lines
 *
 * A group gets one line per punch, so these are written to be SCANNED, not
 * read: the same shape every time, name in bold, event, time, and a tail
 * only when something is off. Four employees punching over a minute should
 * stack into something you can take in at a glance.
 *
 * Bitrix chat takes BB-code, not HTML or Markdown - [B]bold[/B].
 * ========================================================================== */

const BITRIX_EVENT_DOT = {
  LOGIN:     '\u{1F7E2}',
  BREAK_OUT: '\u2615',
  BREAK_IN:  '\u{1F504}',
  LOGOUT:    '\u{1F44B}',
};

/** "🟢 [B]Vinay Sirimilla[/B] · Login 09:31 · 25m late" */
function buildPunchChatLine({ fullName, eventType, direction, when, shift, source }) {
  const t = istParts(when);
  const dot = BITRIX_EVENT_DOT[eventType]
    || (direction === 'IN' ? '\u2192' : direction === 'OUT' ? '\u2190' : '\u2022');
  const what = eventLabel(eventType, direction);

  // Only the tail that is actually true, and only where it means something:
  // lateness belongs to a Login, leaving early to a Logout.
  const tail = [];
  if (shift && shift.hasShift) {
    if (eventType === 'LOGIN' && shift.isLate && shift.lateMinutes) {
      tail.push(`${humanMinutes(shift.lateMinutes)} late`);
    } else if (eventType === 'LOGOUT' && shift.isEarlyOut && shift.earlyOutMinutes) {
      tail.push(`${humanMinutes(shift.earlyOutMinutes)} early`);
    }
  }
  if (source === 'selfie') tail.push('from home');

  return `${dot} [B]${fullName || 'Employee'}[/B] \u00b7 ${what} ${t.prettyTime}` +
         (tail.length ? ` \u00b7 ${tail.join(' \u00b7 ')}` : '');
}

/** Inclusive day count, where a half day counts as a half. */
function leaveDayCount(startDate, endDate, dayPart) {
  const a = new Date(`${startDate}T12:00:00+05:30`);
  const b = new Date(`${endDate}T12:00:00+05:30`);
  const days = Math.round((b - a) / 86400000) + 1;
  if (!isFinite(days) || days < 1) return 1;
  return dayPart && dayPart !== 'full' && days === 1 ? 0.5 : days;
}

/** "10 Sept" or "10–12 Sept" — the range as a person would say it. */
function prettyRange(startDate, endDate) {
  const f = d => new Intl.DateTimeFormat('en-GB', { timeZone: IST_TZ, day: 'numeric', month: 'short' })
    .format(new Date(`${d}T12:00:00+05:30`));
  return startDate === endDate ? f(startDate) : `${f(startDate)} \u2013 ${f(endDate)}`;
}

/**
 * Leave, for the group. `kind` is 'filed' | 'approved' | 'rejected'.
 * Filed carries the reason, because that is the message somebody has to act
 * on; a decision carries the note only if there is one.
 */
function buildLeaveChatLine({ kind, fullName, typeName, startDate, endDate, dayPart, reason, note, decidedBy }) {
  const dot = kind === 'approved' ? '\u2705' : kind === 'rejected' ? '\u274C' : '\u{1F334}';
  const n = leaveDayCount(startDate, endDate, dayPart);
  const span = `${prettyRange(startDate, endDate)} (${n} day${n === 1 ? '' : 's'}` +
               `${dayPart && dayPart !== 'full' ? ', half' : ''})`;
  const head = kind === 'filed'
    ? `${dot} [B]${fullName}[/B] requested leave`
    : `${dot} Leave ${kind} \u00b7 [B]${fullName}[/B]`;
  const parts = [`${head}`, `${typeName || 'Leave'} \u00b7 ${span}`];
  if (kind === 'filed' && reason) parts.push(`Reason: ${reason}`);
  if (kind !== 'filed' && note)   parts.push(`Note: ${note}`);
  if (kind !== 'filed' && decidedBy) parts.push(`by ${decidedBy}`);
  return parts.join('\n');
}

/* ==========================================================================
 * Weekly offs, day classification, and pay
 *
 * The month calendar, the admin team grid, the daily report, the chat status
 * badges and the pay sheet all answer the same question — "what was this
 * person doing on this date?" — so they all answer it HERE. Five screens
 * disagreeing about whether the 12th was a holiday or an absence is the kind
 * of bug nobody reports and everybody stops trusting.
 * ========================================================================== */

// Sunday only, for a company with no policy row of its own.
const DEFAULT_WEEK_OFFS = [7];

/**
 * The weekdays a company treats as a weekly off. 1 = Mon … 7 = Sun.
 *
 * An EMPTY array on an existing row is meaningful — it means "this company
 * works every day" — so only a missing row falls back to the default.
 */
function weekOffsFor(company, policies) {
  const hit = (policies || []).find(p => p && p.company === company);
  if (hit && Array.isArray(hit.week_offs)) {
    return hit.week_offs.map(Number).filter(d => d >= 1 && d <= 7);
  }
  return DEFAULT_WEEK_OFFS.slice();
}

/**
 * A day is off if the company calls it a weekly off, OR if it falls outside
 * the shift's own working days. Either one is enough: Jobways is Sat+Sun off
 * even though the shift template it shares with everyone says Mon–Sat.
 */
function isOffDay({ weekday, weekOffs, shift }) {
  if (weekday == null) return false;
  if ((weekOffs || []).map(Number).includes(weekday)) return true;
  const days = shift && Array.isArray(shift.working_days) ? shift.working_days.map(Number) : null;
  if (days && days.length && !days.includes(weekday)) return true;
  return false;
}

const DAY_STATUS = {
  present: { label: 'Present',  icon: '\u{1F7E2}', color: '#10b981' },
  late:    { label: 'Late',     icon: '\u{1F7E1}', color: '#f59e0b' },
  absent:  { label: 'Absent',   icon: '\u{1F534}', color: '#ef4444' },
  leave:   { label: 'Leave',    icon: '\u{1F334}', color: '#8b5cf6' },
  holiday: { label: 'Holiday',  icon: '\u{1F389}', color: '#ec4899' },
  weekoff: { label: 'Week off', icon: '\u{2B1C}',  color: '#94a3b8' },
  pending: { label: 'Today',    icon: '\u{23F3}',  color: '#3b82f6' },
  future:  { label: '',         icon: '\u{00B7}',  color: '#cbd5e1' },
};

/** Every YYYY-MM-DD in a YYYY-MM month. */
function monthDates(ym) {
  const [y, m] = String(ym || '').split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return [];
  // Day 0 of the NEXT month is the last day of this one.
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out = [];
  for (let d = 1; d <= count; d++) {
    out.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return out;
}

/**
 * What one person was doing on one date.
 *
 * Order matters and is deliberate:
 *   punches first  — if someone actually worked, that is the truth, even on
 *                    a holiday or a week off. Never erase real work.
 *   holiday next   — a public holiday beats booked leave, so nobody burns a
 *                    leave day on a day the office was shut anyway.
 *   week off       — before leave, for the same reason.
 *   leave          — an approved absence.
 *   future/pending — do not brand a day "absent" before it has happened, or
 *                    at 10am on the day itself.
 */
function classifyDay({ date, shift, weekOffs, holiday, leave, punches, today }) {
  const noon = new Date(`${date}T12:00:00+05:30`);   // midday: no DST or rounding edge
  const weekday = istIsoWeekday(noon);
  const list = (punches || []).slice()
    .sort((a, b) => new Date(a.log_datetime) - new Date(b.log_datetime));

  const base = {
    date, weekday,
    holidayName: holiday ? holiday.name : null,
    leaveType:   leave ? (leave.type_name || 'Leave') : null,
    dayPart:     leave ? leave.day_part : null,
    punchCount:  list.length,
    firstIn: null, lastOut: null,
    isLate: false, lateMinutes: null, workedMinutes: null,
    worked: false,
  };

  if (list.length) {
    const ins  = list.filter(r => r.direction === 'IN');
    const outs = list.filter(r => r.direction === 'OUT');
    base.firstIn = (ins[0] || list[0]).log_datetime;
    base.lastOut = outs.length ? outs[outs.length - 1].log_datetime : null;
    const ev = evaluateShift({ shift, firstIn: base.firstIn, lastOut: base.lastOut, date: noon });
    base.isLate = !!ev.isLate;
    base.lateMinutes = ev.lateMinutes;
    if (base.firstIn && base.lastOut) {
      base.workedMinutes = Math.max(0,
        Math.round((new Date(base.lastOut) - new Date(base.firstIn)) / 60000));
    }
    base.worked = true;
    return { ...base, status: base.isLate ? 'late' : 'present' };
  }

  if (holiday) return { ...base, status: 'holiday' };
  if (isOffDay({ weekday, weekOffs, shift })) return { ...base, status: 'weekoff' };
  if (leave)   return { ...base, status: 'leave' };
  if (today && date >  today) return { ...base, status: 'future' };
  if (today && date === today) return { ...base, status: 'pending' };
  return { ...base, status: 'absent' };
}

/** True if an approved leave row covers this date. */
function leaveOn(date, leaves) {
  return (leaves || []).find(l => l && l.start_date <= date && date <= l.end_date) || null;
}

/** The holiday for this date, preferring a company-specific row over a global one. */
function holidayOn(date, holidays, company) {
  const sameDay = (holidays || []).filter(h => h && h.holiday_date === date);
  return sameDay.find(h => h.company === company) || sameDay.find(h => !h.company) || null;
}

/**
 * A whole month for one person: one entry per date, plus the totals the
 * calendar header and the pay sheet both print.
 */
function buildMonth({ ym, company, shift, weekOffs, holidays, leaves, punches, today }) {
  const byDate = new Map();
  (punches || []).forEach(r => {
    const d = r.log_date || istParts(new Date(r.log_datetime)).isoDate;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  });

  const days = monthDates(ym).map(date => classifyDay({
    date, shift, weekOffs,
    holiday: holidayOn(date, holidays, company),
    leave:   leaveOn(date, leaves),
    punches: byDate.get(date) || [],
    today,
  }));

  // Total working days in the month: the days this person was SCHEDULED to
  // work — their shift's weekdays, minus company week-offs, minus holidays.
  // This is the divisor for a monthly salary (salary ÷ working days = per-day),
  // so it is computed from the calendar, not from whether they actually turned
  // up. A holiday is a paid day off elsewhere; here it simply is not a working
  // day, so it never inflates the divisor. Worked-on-a-holiday still counts as
  // a present day for pay, but not as a working day for the divisor.
  const workingDays = monthDates(ym).reduce((n, date) => {
    const weekday = istIsoWeekday(new Date(`${date}T12:00:00+05:30`));
    if (holidayOn(date, holidays, company)) return n;
    if (isOffDay({ weekday, weekOffs, shift })) return n;
    return n + 1;
  }, 0);

  const count = s => days.filter(d => d.status === s).length;
  const totals = {
    present: count('present'), late: count('late'), absent: count('absent'),
    leave: count('leave'), holiday: count('holiday'), weekoff: count('weekoff'),
    // Days actually worked — what a per-day rate multiplies, and what the
    // monthly per-day rate multiplies too.
    daysPresent: days.filter(d => d.worked).length,
    // Scheduled working days in the month — the monthly-salary divisor.
    workingDays,
    lateMinutes: days.reduce((a, d) => a + (d.lateMinutes || 0), 0),
    workedMinutes: days.reduce((a, d) => a + (d.workedMinutes || 0), 0),
  };
  return { ym, days, totals };
}

/**
 * Pay for a month: a flat per-day rate for every day actually worked.
 *
 * Leave and holidays are NOT paid under this model — that was the deliberate
 * choice, not an oversight. Switching to fixed-monthly-minus-LOP means
 * changing this one function.
 */
function computePay({ perDayRate, daysPresent, currency }) {
  // Number(null), Number(undefined ?? '') and Number('') are 0 or NaN in ways
  // that would quietly print a real-looking wage of zero for somebody whose
  // rate was simply never entered. Reject the blanks before coercing.
  const blank = v => v === null || v === undefined || v === '';
  const rate = blank(perDayRate) ? NaN : Number(perDayRate);
  const days = Number(daysPresent) || 0;
  if (!isFinite(rate) || rate < 0) {
    return { hasRate: false, perDayRate: null, daysPresent: days, gross: null, currency: currency || 'INR' };
  }
  // Round to paise once, at the end, so a sheet of employees always sums to
  // the same number the individual rows show.
  const gross = Math.round(rate * days * 100) / 100;
  return { hasRate: true, perDayRate: rate, daysPresent: days, gross, currency: currency || 'INR' };
}

/**
 * Pay for a month from a FIXED MONTHLY SALARY, prorated by attendance.
 *
 *   per-day = monthly salary ÷ total working days that month
 *   gross   = per-day × days present (days actually worked)
 *
 * "Total working days" is the scheduled working days for the month (see
 * buildMonth.totals.workingDays): the shift's weekdays minus company week-offs
 * minus holidays. So the per-day rate floats with the calendar — a month with
 * a public holiday has fewer working days, so each present day is worth a
 * little more, and a full salary is only ever reached by being present every
 * working day. Leave is unpaid under this model (a leave day is not a present
 * day); holidays are simply removed from the divisor rather than paid.
 */
function computeMonthlyPay({ monthlySalary, workingDays, daysPresent, currency }) {
  const blank = v => v === null || v === undefined || v === '';
  const salary = blank(monthlySalary) ? NaN : Number(monthlySalary);
  const wd = Number(workingDays) || 0;
  const dp = Number(daysPresent) || 0;
  // No salary entered, or a month with zero working days (nothing to divide
  // by): report "no rate" rather than a real-looking ₹0 or a divide-by-zero.
  if (!isFinite(salary) || salary < 0 || wd <= 0) {
    return {
      hasRate: false,
      monthlySalary: isFinite(salary) && salary >= 0 ? salary : null,
      perDay: null, workingDays: wd, daysPresent: dp,
      gross: null, currency: currency || 'INR',
    };
  }
  const perDayExact = salary / wd;
  // Round the gross once, at the end, off the exact per-day — so a sheet always
  // sums to the number the rows show. The displayed per-day is rounded too, but
  // only for showing; the gross does not compound that rounding.
  const gross = Math.round(perDayExact * dp * 100) / 100;
  return {
    hasRate: true,
    monthlySalary: salary,
    perDay: Math.round(perDayExact * 100) / 100,
    workingDays: wd, daysPresent: dp,
    gross, currency: currency || 'INR',
  };
}

/** 28500 -> "28,500.00" in Indian digit grouping. */
function formatMoney(amount, currency) {
  if (amount == null || !isFinite(Number(amount))) return '—';
  const n = Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (currency === 'INR' || !currency) ? `\u20B9${n}` : `${n} ${currency}`;
}

module.exports = {
  IST_TZ,
  parseDeviceDateTime,
  istParts,
  istToday,
  normalizeDirection,
  normalizeName,
  nameTokenKey,
  matchProfileByName,
  buildPunchEmail,
  escapeHtml,
  timeToMinutes,
  minutesToTime,
  humanMinutes,
  offsetFromBoundary,
  istIsoWeekday,
  describeWorkingDays,
  evaluateShift,
  PUNCH_EVENT,
  deriveEventType,
  deriveDayEvents,
  eventLabel,
  buildPunchChatLine,
  buildLeaveChatLine,
  leaveDayCount,
  DEFAULT_WEEK_OFFS,
  weekOffsFor,
  isOffDay,
  DAY_STATUS,
  monthDates,
  classifyDay,
  leaveOn,
  holidayOn,
  buildMonth,
  computePay,
  computeMonthlyPay,
  formatMoney,
};
