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
function buildPunchEmail({ fullName, direction, when, deviceName, employeeCode, shift }) {
  const t = istParts(when);
  const isIn = direction === 'IN';
  const isOut = direction === 'OUT';

  const accent = isIn ? '#10b981' : isOut ? '#f43f5e' : '#64748b';
  const accentDark = isIn ? '#059669' : isOut ? '#e11d48' : '#475569';
  const icon = isIn ? '&#8594;' : isOut ? '&#8592;' : '&#8226;';
  const word = isIn ? 'Checked In' : isOut ? 'Checked Out' : 'Punch Recorded';
  const verb = isIn ? 'checked in' : isOut ? 'checked out' : 'recorded a punch';

  const firstName = String(fullName || '').trim().split(/\s+/)[0] || 'there';

  // Shift context, when the employee has one. Only shown for the boundary it
  // actually relates to: lateness on the way in, leaving early on the way out.
  let note = null;      // { text, tone: 'ok' | 'warn' }
  if (shift && shift.hasShift) {
    if (isIn && shift.lateMinutes != null) {
      note = shift.isLate
        ? { text: `${humanMinutes(shift.lateMinutes)} after your ${shift.window} shift start`, tone: 'warn' }
        : { text: `On time for your ${shift.window} shift`, tone: 'ok' };
    } else if (isOut && shift.earlyOutMinutes != null) {
      note = shift.isEarlyOut
        ? { text: `${humanMinutes(shift.earlyOutMinutes)} before your ${shift.window} shift ends`, tone: 'warn' }
        : { text: `Full ${shift.window} shift completed`, tone: 'ok' };
    }
  }

  const lateTag = note && note.tone === 'warn' ? ` (${note.text.split(' after ')[0].split(' before ')[0]} ${isIn ? 'late' : 'early'})` : '';
  const subject = `${isIn ? '✅' : isOut ? '\u{1F44B}' : '\u{1F551}'} ${word} at ${t.prettyTime}${lateTag} — ${t.prettyDate}`;

  const text = [
    `Hi ${firstName},`,
    ``,
    `You ${verb} at ${t.prettyTime} on ${t.prettyDate}.`,
    ``,
    `Time    : ${t.prettyTime} (IST)`,
    `Date    : ${t.prettyDate}`,
    `Type    : ${word}`,
    note ? `Shift   : ${note.text}` : null,
    deviceName ? `Device  : ${deviceName}` : null,
    employeeCode ? `Emp Code: ${employeeCode}` : null,
    ``,
    `This is an automatic notification from WorkSuite. If this wasn't you,`,
    `please tell your admin straight away.`,
  ].filter(Boolean).join('\n');

  const row = (label, value) => value ? `
      <tr>
        <td style="padding:9px 0;border-bottom:1px solid #eef2f7;color:#64748b;font-size:13px;font-weight:600;">${escapeHtml(label)}</td>
        <td style="padding:9px 0;border-bottom:1px solid #eef2f7;color:#0f172a;font-size:13px;font-weight:700;text-align:right;">${escapeHtml(value)}</td>
      </tr>` : '';

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(word)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:28px 12px;">
 <tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;box-shadow:0 2px 12px rgba(15,23,42,0.08);">

    <tr><td style="background:linear-gradient(135deg,${accent},${accentDark});padding:26px 28px;">
      <div style="color:rgba(255,255,255,0.82);font-size:11px;font-weight:800;letter-spacing:1.6px;text-transform:uppercase;">WorkSuite Attendance</div>
      <div style="color:#ffffff;font-size:25px;font-weight:800;margin-top:5px;">${icon}&nbsp;${escapeHtml(word)}</div>
    </td></tr>

    <tr><td style="padding:26px 28px 6px 28px;">
      <p style="margin:0 0 18px 0;color:#334155;font-size:15px;line-height:1.55;">
        Hi <strong style="color:#0f172a;">${escapeHtml(firstName)}</strong>, you ${escapeHtml(verb)} at
      </p>
      <div style="text-align:center;padding:18px 12px;background:#f8fafc;border-radius:12px;border:1px solid #e8edf3;">
        <div style="color:${accent};font-size:36px;font-weight:800;letter-spacing:-0.5px;line-height:1.1;">${escapeHtml(t.prettyTime)}</div>
        <div style="color:#64748b;font-size:13px;font-weight:600;margin-top:5px;">${escapeHtml(t.prettyDate)}</div>
        ${note ? `<div style="margin-top:11px;display:inline-block;padding:5px 12px;border-radius:999px;font-size:12px;font-weight:700;background:${note.tone === 'warn' ? '#fef3c7' : '#dcfce7'};color:${note.tone === 'warn' ? '#92400e' : '#166534'};">${escapeHtml(note.text)}</div>` : ''}
      </div>
    </td></tr>

    <tr><td style="padding:20px 28px 4px 28px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${row('Time (IST)', t.prettyTime)}
        ${row('Date', t.prettyDate)}
        ${row('Type', word)}
        ${note ? row('Shift', note.text) : ''}
        ${row('Device', deviceName)}
        ${row('Employee Code', employeeCode)}
      </table>
    </td></tr>

    <tr><td style="padding:20px 28px 28px 28px;">
      <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.6;">
        Automatic notification from the biometric attendance system.
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
};
