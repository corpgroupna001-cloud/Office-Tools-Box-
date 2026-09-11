/* ============================================================================
   WorkSuite — iCalendar (.ics) export and import (browser + node tests)

       WSIcs.toIcs(events, { name, now, url(ev) }) -> text/calendar
       WSIcs.parseIcs(text) -> [{ title, description, location, url, recurring, cancelled,
                                  all_day: false, starts_at, ends_at }          (instants, ISO)
                               | { …, all_day: true, start_date, end_date }]   (IST days, inclusive)

   Timed events are written in UTC; all-day events as IST dates (DTEND is
   the day after, as the standard wants). When importing, times in a named
   zone (standard names, and Outlook's common Windows names) are converted
   through Intl; times with no zone are read as IST (the company's zone), and
   so are times in a zone this browser does not know (reported as
   unknownZone). Repeating events come in once, on their first date.
   ============================================================================ */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WSIcs = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const IST_MS = 330 * 60000;
    const pad = n => String(n).padStart(2, '0');
    function utcStamp(iso) {
        const d = new Date(iso);
        if (isNaN(d)) throw new Error('Not a date: ' + iso);
        return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
    }
    const istDay = iso => new Date(Date.parse(iso) + IST_MS).toISOString().slice(0, 10);
    const addDay = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const compact = day => day.replace(/-/g, '');
    const escText = s => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
    const unescText = s => String(s || '').replace(/\\([nN,;\\])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
    const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const bytes = s => (enc ? enc.encode(s).length : unescape(encodeURIComponent(s)).length);
    /** Lines longer than 75 bytes continue on the next line after a space (never splitting a character). */
    function fold(line) {
        if (bytes(line) <= 75) return line;
        const out = []; let cur = '', n = 0;
        for (const ch of line) {
            const b = bytes(ch);
            if (n + b > 75) { out.push(cur); cur = ' ' + ch; n = 1 + b; } else { cur += ch; n += b; }
        }
        out.push(cur);
        return out.join('\r\n');
    }

    function toIcs(events, o) {
        o = o || {};
        const now = utcStamp(o.now || new Date().toISOString());
        const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//WorkSuite//Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
            `X-WR-CALNAME:${escText(o.name || 'WorkSuite')}`, 'X-WR-TIMEZONE:Asia/Kolkata'];
        (events || []).forEach(ev => {
            if (!ev || !ev.starts_at || !ev.ends_at || isNaN(Date.parse(ev.starts_at)) || isNaN(Date.parse(ev.ends_at))) return;
            lines.push('BEGIN:VEVENT', `UID:${String(ev.id || utcStamp(ev.starts_at)).replace(/[^A-Za-z0-9._-]/g, '')}@worksuite`, `DTSTAMP:${now}`);
            if (ev.all_day) {
                const s = istDay(ev.starts_at), e = istDay(ev.ends_at);
                lines.push(`DTSTART;VALUE=DATE:${compact(s)}`, `DTEND;VALUE=DATE:${compact(addDay(e < s ? s : e, 1))}`);
            } else lines.push(`DTSTART:${utcStamp(ev.starts_at)}`, `DTEND:${utcStamp(ev.ends_at)}`);
            lines.push(`SUMMARY:${escText(ev.title || '')}`);
            if (ev.description) lines.push(`DESCRIPTION:${escText(ev.description)}`);
            if (ev.location) lines.push(`LOCATION:${escText(ev.location)}`);
            const url = ev.meeting_link || (o.url ? o.url(ev) : null);
            if (url && /^https?:\/\//i.test(url)) lines.push(`URL:${String(url).replace(/[\r\n]/g, '')}`);
            lines.push(`STATUS:${ev.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT');
        });
        lines.push('END:VCALENDAR');
        return lines.map(fold).join('\r\n') + '\r\n';
    }

    /** NAME;PARAM=x;PARAM="y:z":value -> { name, params, value } (a colon inside quotes is not the separator). */
    function parseLine(line) {
        let i = 0, quoted = false;
        for (; i < line.length; i++) { const c = line[i]; if (c === '"') quoted = !quoted; else if (c === ':' && !quoted) break; }
        if (i >= line.length) return null;
        const parts = line.slice(0, i).split(';');
        const params = {};
        parts.slice(1).forEach(p => { const k = p.indexOf('='); if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, ''); });
        return { name: parts[0].toUpperCase(), params, value: line.slice(i + 1) };
    }
    const UTC_ZONES = /^(utc|etc\/utc|gmt|etc\/gmt|z|zulu)$/i;
    // Outlook writes Windows zone names; the common ones map to the standard (IANA) names.
    const WINDOWS_ZONES = {
        'india standard time': 'Asia/Kolkata', 'gmt standard time': 'Europe/London', 'greenwich standard time': 'Atlantic/Reykjavik',
        'w. europe standard time': 'Europe/Berlin', 'romance standard time': 'Europe/Paris', 'central europe standard time': 'Europe/Budapest',
        'central european standard time': 'Europe/Warsaw', 'e. europe standard time': 'Europe/Chisinau', 'fle standard time': 'Europe/Kiev',
        'russian standard time': 'Europe/Moscow', 'arabian standard time': 'Asia/Dubai', 'arab standard time': 'Asia/Riyadh',
        'pakistan standard time': 'Asia/Karachi', 'bangladesh standard time': 'Asia/Dhaka', 'nepal standard time': 'Asia/Kathmandu',
        'sri lanka standard time': 'Asia/Colombo', 'se asia standard time': 'Asia/Bangkok', 'singapore standard time': 'Asia/Singapore',
        'china standard time': 'Asia/Shanghai', 'tokyo standard time': 'Asia/Tokyo', 'korea standard time': 'Asia/Seoul',
        'aus eastern standard time': 'Australia/Sydney', 'new zealand standard time': 'Pacific/Auckland',
        'eastern standard time': 'America/New_York', 'central standard time': 'America/Chicago', 'mountain standard time': 'America/Denver',
        'pacific standard time': 'America/Los_Angeles', 'e. south america standard time': 'America/Sao_Paulo', 'south africa standard time': 'Africa/Johannesburg',
        'e. africa standard time': 'Africa/Nairobi', 'egypt standard time': 'Africa/Cairo', 'utc': 'UTC',
    };
    /** A wall-clock time in a named zone -> UTC milliseconds; null when the zone is unknown. */
    function zonedMs(y, mo, d, hh, mi, ss, zone) {
        const tz = WINDOWS_ZONES[String(zone).toLowerCase()] || zone;
        let fmt;
        try { fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); }
        catch (e) { return null; }
        const want = Date.UTC(y, mo - 1, d, hh, mi, ss);
        let guess = want;
        for (let i = 0; i < 3; i++) {                 // the zone's offset at that moment, refined for daylight-saving edges
            const p = {}; fmt.formatToParts(new Date(guess)).forEach(x => { p[x.type] = x.value; });
            const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
            const diff = shown - want; if (!diff) break;
            guess -= diff;
        }
        return guess;
    }
    function parseWhen(p) {
        const v = String(p.value || '').trim();
        let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
        if (m || String(p.params.VALUE || '').toUpperCase() === 'DATE') return m ? { date: `${m[1]}-${m[2]}-${m[3]}` } : null;
        m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
        if (!m) return null;
        const [, y, mo, d, hh, mi, ss, z] = m, tzid = String(p.params.TZID || '').trim();
        let ms, unknownZone = null;
        if (z || UTC_ZONES.test(tzid)) ms = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +(ss || 0));
        else if (tzid) {
            ms = zonedMs(+y, +mo, +d, +hh, +mi, +(ss || 0), tzid);
            if (ms == null) { unknownZone = tzid; ms = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +(ss || 0)) - IST_MS; }
        } else ms = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +(ss || 0)) - IST_MS;          // no zone at all: the company's (IST)
        return isNaN(ms) ? null : { iso: new Date(ms).toISOString(), unknownZone };
    }
    function durationMs(v) {
        const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v || '').trim());
        if (!m) return null;
        const ms = (((+(m[2] || 0) * 7 + +(m[3] || 0)) * 24 + +(m[4] || 0)) * 60 + +(m[5] || 0)) * 60000 + +(m[6] || 0) * 1000;
        return m[1] === '-' ? -ms : ms;
    }
    function finish(c) {
        if (!c.DTSTART) return null;
        const s = parseWhen(c.DTSTART); if (!s) return null;
        const e = c.DTEND ? parseWhen(c.DTEND) : null;
        const dur = c.DURATION ? durationMs(c.DURATION.value) : null;
        const base = {
            uid: c.UID ? c.UID.value.trim() : null,
            title: unescText(c.SUMMARY ? c.SUMMARY.value : '').trim() || '(No title)',
            description: c.DESCRIPTION ? unescText(c.DESCRIPTION.value) : null,
            location: c.LOCATION ? unescText(c.LOCATION.value) : null,
            url: c.URL ? c.URL.value.trim() : null,
            recurring: !!c.RRULE,
            cancelled: !!(c.STATUS && /^cancelled$/i.test(c.STATUS.value.trim())),
        };
        if (s.date) {
            let endEx = e && e.date ? e.date : null;                                  // DTEND of a date is the day after
            if (!endEx && dur != null && dur > 0) endEx = addDay(s.date, Math.max(1, Math.round(dur / 864e5)));
            return { ...base, all_day: true, start_date: s.date, end_date: endEx && endEx > s.date ? addDay(endEx, -1) : s.date };
        }
        let end = e && e.iso ? e.iso : null;
        if (!end && dur != null) end = new Date(Date.parse(s.iso) + dur).toISOString();
        if (!end || Date.parse(end) < Date.parse(s.iso)) end = s.iso;             // no end: an instant
        return { ...base, all_day: false, starts_at: s.iso, ends_at: end, unknownZone: s.unknownZone || (e && e.unknownZone) || null };
    }
    function parseIcs(text) {
        const lines = String(text || '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
        const out = [];
        let cur = null, depth = 0;
        for (const line of lines) {
            if (!line) continue;
            const p = parseLine(line); if (!p) continue;
            if (p.name === 'BEGIN') { if (cur) depth++; else if (p.value.trim().toUpperCase() === 'VEVENT') { cur = {}; depth = 0; } continue; }
            if (p.name === 'END') {
                if (cur && depth > 0) { depth--; continue; }
                if (cur && p.value.trim().toUpperCase() === 'VEVENT') { const ev = finish(cur); if (ev) out.push(ev); cur = null; if (out.length >= 5000) break; }
                continue;
            }
            if (cur && depth === 0 && !(p.name in cur)) cur[p.name] = p;          // alarms and other nested parts are skipped
        }
        return out;
    }

    return { toIcs, parseIcs, utcStamp, fold };
});
