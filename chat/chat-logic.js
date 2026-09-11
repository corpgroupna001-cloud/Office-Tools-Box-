/* ============================================================================
   WorkSuite Messenger — pure helpers shared by the page and the server.

   No DOM, no network, no dependencies: the browser gets window.WSChatLogic,
   node gets module.exports (lib/comms-push.js builds push text with
   previewText, and tests/chat-logic.test.js covers everything here).

   Message bodies carry a few special forms, kept for compatibility with every
   message already stored:
     __DELETED__                                      deleted for everyone
     __FILE__::<storage path>::<mime>::<bytes>::<name> a file in chat-files (the name may contain "::")
     __CALL__::<audio|video>::<status>::<seconds>      call log, written by the database
   ============================================================================ */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.WSChatLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var DELETED = '__DELETED__';
    var TZ = 'Asia/Kolkata';
    // Deliberately conservative: http(s) only, stops at whitespace and angle brackets.
    var URL_RE = /https?:\/\/[^\s<>"']+/g;

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ------------------------------------------------------------ bodies
    function parseSpecial(body) {
        var b = typeof body === 'string' ? body : String(body == null ? '' : body);
        if (b === DELETED) return { kind: 'deleted' };
        if (b.indexOf('__FILE__::') === 0) {
            var p = b.split('::');
            if (p.length >= 5) {
                var mime = (p[2] || 'application/octet-stream').toLowerCase();
                var name = p.slice(4).join('::') || 'file';
                return {
                    kind: 'file', path: p[1], mime: mime, size: parseInt(p[3] || '0', 10) || 0, name: name,
                    isImage: /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/.test(mime) || (mime.indexOf('image/') === 0 && mime !== 'image/heic'),
                    isAudio: mime.indexOf('audio/') === 0,
                    isVideo: mime.indexOf('video/') === 0,
                };
            }
            return { kind: 'text', text: b };
        }
        if (b.indexOf('__CALL__::') === 0) {
            var c = b.split('::');
            return { kind: 'call', media: c[1] === 'video' ? 'video' : 'audio', status: c[2] || 'completed', seconds: Math.max(0, parseInt(c[3] || '0', 10) || 0) };
        }
        return { kind: 'text', text: b };
    }

    function isSpecial(body) {
        return typeof body === 'string' && (body === DELETED || body.indexOf('__FILE__::') === 0 || body.indexOf('__CALL__::') === 0);
    }

    // ------------------------------------------------------------ formats
    function fmtBytes(n) {
        n = Number(n) || 0;
        if (n <= 0) return '';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    /** 125 -> "2m 5s"; 45 -> "45s"; 3720 -> "1h 2m". */
    function fmtDuration(sec) {
        sec = Math.max(0, Math.round(Number(sec) || 0));
        var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        if (h) return h + 'h ' + m + 'm';
        if (m) return m + 'm ' + s + 's';
        return s + 's';
    }

    /** 72 -> "1:12" (voice notes, call timers). */
    function fmtClock(sec) {
        sec = Math.max(0, Math.floor(Number(sec) || 0));
        var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        var mm = h ? String(m).padStart(2, '0') : String(m);
        return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
    }

    /**
     * The text of a call log line. `mine` means the reader placed the call.
     * missed is true only for the person who did not pick up (shown in red).
     */
    function callLabel(call, mine) {
        var kind = call.media === 'video' ? 'Video' : 'Voice';
        var icon = call.media === 'video' ? '📹' : '📞';
        var s = call.status, text, missed = false;
        if (s === 'completed') text = kind + ' call · ' + fmtDuration(call.seconds);
        else if (s === 'missed') { text = mine ? kind + ' call · No answer' : 'Missed ' + kind.toLowerCase() + ' call'; missed = !mine; }
        else if (s === 'declined') text = mine ? kind + ' call · Declined' : 'You declined a ' + kind.toLowerCase() + ' call';
        else if (s === 'busy') { text = mine ? kind + ' call · Busy' : 'Missed ' + kind.toLowerCase() + ' call (you were on another call)'; missed = !mine; }
        else if (s === 'offline') { text = mine ? kind + ' call · Unavailable' : 'Missed ' + kind.toLowerCase() + ' call'; missed = !mine; }
        else text = kind + ' call';
        return { icon: icon, text: text, missed: missed };
    }

    /** One short line for lists, toasts and pushes. */
    function previewText(body) {
        var sp = parseSpecial(body);
        if (sp.kind === 'deleted') return '🗑️ Message deleted';
        if (sp.kind === 'file') {
            if (sp.isImage) return '📷 Photo';
            if (sp.isAudio) return '🎤 Voice message';
            if (sp.isVideo) return '🎬 Video';
            return '📎 ' + sp.name;
        }
        if (sp.kind === 'call') {
            if (sp.status === 'completed') return (sp.media === 'video' ? '📹 Video call · ' : '📞 Voice call · ') + fmtDuration(sp.seconds);
            if (sp.status === 'declined') return sp.media === 'video' ? '📹 Declined video call' : '📞 Declined voice call';
            return sp.media === 'video' ? '📹 Missed video call' : '📞 Missed voice call';
        }
        var t = String(sp.text || '').replace(/\s+/g, ' ').trim();
        return t.length > 120 ? t.slice(0, 119) + '…' : t;
    }

    // ------------------------------------------------------------ dates (IST)
    var dayFmt = null;
    function dayKey(iso) {
        var d = new Date(iso);
        if (isNaN(d)) return '';
        try {
            dayFmt = dayFmt || new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
            return dayFmt.format(d);
        } catch (e) { return d.toISOString().slice(0, 10); }
    }
    function daysBetween(aKey, bKey) {
        return Math.round((Date.parse(bKey + 'T00:00:00Z') - Date.parse(aKey + 'T00:00:00Z')) / 86400000);
    }
    /** "Today" / "Yesterday" / "Monday" (within a week) / "3 September 2026". */
    function dayLabel(iso, now) {
        var k = dayKey(iso), today = dayKey(now || new Date());
        if (!k) return '';
        var diff = daysBetween(k, today);
        if (diff === 0) return 'Today';
        if (diff === 1) return 'Yesterday';
        var d = new Date(iso);
        if (diff > 1 && diff < 7) return d.toLocaleDateString('en-IN', { timeZone: TZ, weekday: 'long' });
        return d.toLocaleDateString('en-IN', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });
    }
    function fmtTime(iso) {
        var d = new Date(iso);
        if (isNaN(d)) return '';
        return d.toLocaleTimeString('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase().replace(/\s+/g, ' ');
    }
    /** Chat-list time: "now", "5m", "10:19 am", "Yesterday", "Mon", "3 Sep". */
    function fmtListTime(iso, now) {
        var d = new Date(iso), n = now ? new Date(now) : new Date();
        if (isNaN(d)) return '';
        var diff = n - d;
        if (diff < 60000 && diff > -60000) return 'now';
        if (diff < 3600000 && diff > 0) return Math.floor(diff / 60000) + 'm';
        var days = daysBetween(dayKey(d), dayKey(n));
        if (days <= 0) return fmtTime(iso);
        if (days === 1) return 'Yesterday';
        if (days < 7) return d.toLocaleDateString('en-IN', { timeZone: TZ, weekday: 'short' });
        return d.toLocaleDateString('en-IN', { timeZone: TZ, day: 'numeric', month: 'short' });
    }
    function fmtLastSeen(iso, now) {
        var d = new Date(iso);
        if (!iso || isNaN(d)) return 'last seen recently';
        var mins = Math.floor(((now ? +new Date(now) : Date.now()) - d) / 60000);
        if (mins < 1) return 'last seen just now';
        if (mins < 60) return 'last seen ' + mins + ' min ago';
        var hrs = Math.floor(mins / 60);
        if (hrs < 24) return 'last seen ' + hrs + ' hr ago';
        var days = Math.floor(hrs / 24);
        if (days < 7) return 'last seen ' + days + ' day' + (days > 1 ? 's' : '') + ' ago';
        return 'last seen on ' + d.toLocaleDateString('en-IN', { timeZone: TZ, day: 'numeric', month: 'short' });
    }

    // ------------------------------------------------------------ grouping
    var BURST_MS = 3 * 60 * 1000;
    /** Two messages sit in one visual burst: same sender, same day, close in time, neither is a call log. */
    function sameBurst(a, b) {
        if (!a || !b) return false;
        if (a.sender_id !== b.sender_id) return false;
        if (parseSpecial(a.body).kind === 'call' || parseSpecial(b.body).kind === 'call') return false;
        if (dayKey(a.created_at) !== dayKey(b.created_at)) return false;
        return Math.abs(new Date(b.created_at) - new Date(a.created_at)) < BURST_MS;
    }
    /** Layout flags for message i of a sorted list. */
    function groupFlags(list, i) {
        var m = list[i], prev = list[i - 1], next = list[i + 1];
        return {
            newDay: !prev || dayKey(prev.created_at) !== dayKey(m.created_at),
            first: !sameBurst(prev, m),
            last: !sameBurst(m, next),
        };
    }

    /** Sort key: stored messages by id, unsent ones after them in the order they were written. */
    function compareMessages(a, b) {
        var ai = a.id != null, bi = b.id != null;
        if (ai && bi) return Number(a.id) - Number(b.id);
        if (ai) return -1;
        if (bi) return 1;
        return String(a.created_at).localeCompare(String(b.created_at));
    }

    // ------------------------------------------------------------ text
    function firstUrl(text) {
        var m = String(text || '').match(URL_RE);
        if (!m) return null;
        return trimUrl(m[0]);
    }
    function trimUrl(u) { return u.replace(/[.,!?;:)\]}'"]+$/, ''); }

    /** One or up to eight emoji and nothing else: shown large, like the phone apps. */
    function isEmojiOnly(text) {
        var t = String(text || '').trim();
        if (!t || t.length > 32) return false;
        try {
            return /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(t) && /\p{Extended_Pictographic}/u.test(t)
                && !/[0-9#*]/.test(t);
        } catch (e) { return false; }
    }

    /**
     * Safe HTML for a text message: everything escaped, links made clickable,
     * @mentions of known names highlighted, newlines kept.
     *   opts.names   display names that can be mentioned
     *   opts.meName  the reader's own name (highlighted differently)
     */
    function formatBody(text, opts) {
        opts = opts || {};
        var names = (opts.names || []).filter(Boolean).slice().sort(function (a, b) { return b.length - a.length; });
        var src = String(text == null ? '' : text), out = [], last = 0, m;
        URL_RE.lastIndex = 0;
        while ((m = URL_RE.exec(src))) {
            var url = trimUrl(m[0]);
            if (!url) continue;
            out.push(formatPlain(src.slice(last, m.index), names, opts.meName));
            out.push('<a class="mx-link" href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(url) + '</a>');
            last = m.index + url.length;
            URL_RE.lastIndex = last;
        }
        out.push(formatPlain(src.slice(last), names, opts.meName));
        return out.join('');
    }
    function formatPlain(s, names, meName) {
        var html = escapeHtml(s);
        if (html.indexOf('@') !== -1 && names.length) {
            // One pass, longest names first, so "@Anil Kumar" is wrapped once and never again as "@Anil".
            var escRe = function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
            var meKey = meName ? escapeHtml(meName) : null;
            var re = new RegExp('@(' + names.map(function (n) { return escRe(escapeHtml(n)); }).join('|') + ')(?![\\w])', 'g');
            html = html.replace(re, function (all, n) {
                return '<span class="' + (meKey && n === meKey ? 'mx-mention me' : 'mx-mention') + '">' + all + '</span>';
            });
        }
        return html.replace(/\r?\n/g, '<br>');
    }

    /** The ids of candidates mentioned as "@Full Name" in body (longest names first, whole words). */
    function mentionIdsIn(body, candidates) {
        var ids = [], text = String(body || '');
        var esc = function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
        (candidates || []).slice().sort(function (a, b) { return (b.name || '').length - (a.name || '').length; }).forEach(function (c) {
            if (!c || !c.name || ids.indexOf(c.id) !== -1) return;
            var re = new RegExp('(^|[^\\w])@' + esc(c.name) + '(?![\\w])', 'g');
            if (!re.test(text)) return;
            ids.push(c.id);
            // "@Anil Kumar" must not also count as "@Anil": blank out what matched.
            text = text.replace(re, function (all, lead) { return lead + ' '.repeat(all.length - lead.length); });
        });
        return ids;
    }

    /** While typing: the "@term" right before the caret, or null. */
    function mentionQuery(text, caret) {
        var before = String(text || '').slice(0, caret == null ? String(text || '').length : caret);
        var at = before.lastIndexOf('@');
        if (at < 0) return null;
        if (at > 0 && !/\s/.test(before[at - 1])) return null;
        var term = before.slice(at + 1);
        if (term.length > 30 || /\n/.test(term) || /\s{2,}/.test(term)) return null;
        return { start: at, term: term };
    }

    // ------------------------------------------------------------ files
    function safeFileName(name) {
        var s = String(name || '').normalize ? String(name || '').normalize('NFKD') : String(name || '');
        s = s.replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').replace(/^[._]+/, '');
        if (s.length > 80) {
            var dot = s.lastIndexOf('.');
            var ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : '';
            s = s.slice(0, 80 - ext.length) + ext;
        }
        return s || 'file';
    }
    function storagePath(userId, fileName, now, rand) {
        return userId + '/' + (now || Date.now()) + '-' + (rand || Math.random().toString(36).slice(2, 8)) + '-' + safeFileName(fileName);
    }
    function fileBody(path, mime, size, name) {
        return '__FILE__::' + path + '::' + (mime || 'application/octet-stream') + '::' + (Number(size) || 0) + '::' + (name || 'file');
    }

    // ------------------------------------------------------------ threads
    /** Topic for a direct conversation that both people compute the same way. */
    function dmTopicKey(a, b) { return 'dm:' + [String(a), String(b)].sort().join(':'); }

    /** Group members (not me) whose read marker is at or after the message. */
    function seenBy(members, meId, createdAt) {
        var t = new Date(createdAt).getTime();
        return (members || []).filter(function (m) {
            return m.user_id !== meId && m.last_read_at && new Date(m.last_read_at).getTime() >= t;
        }).map(function (m) { return m.user_id; });
    }

    /** A PostgREST ilike-safe search term (no wildcards or filter syntax). */
    function searchTerm(q) { return String(q || '').replace(/[%_,()*\\]/g, ' ').replace(/\s+/g, ' ').trim(); }

    // ------------------------------------------------------------ errors & sync
    /** An unknown column comes back two ways: 42703 from Postgres, PGRST204 from PostgREST's schema cache. */
    function isMissingColumn(err) {
        if (!err) return false;
        var code = String(err.code || '');
        return code === '42703' || code === 'PGRST204' || /could not find the '[^']+' column/i.test(String(err.message || ''));
    }
    /** Worth retrying later (network, timeout, expired session, busy server) — not a rule the database refused. */
    function isTransientError(err, online) {
        if (!err || err.cancelled) return false;
        if (err.transient) return true;
        if (online === false) return true;
        var msg = String(err.message || err), code = String(err.code || '');
        // An aborted fetch reports code "20" (the DOMException code), so match the text first.
        if (/AbortError|TimeoutError|aborted|timed? ?out|failed to fetch|networkerror|load failed|network request failed/i.test(msg)) return true;
        if (code === 'PGRST301' || code === '57014') return true;          // expired session, statement timeout
        var status = Number(err.status) || 0;
        if (status >= 500 || status === 429 || status === 408) return true;
        return !code && /fetch|network|connection/i.test(msg);
    }
    /** How long an upload may take: 30 s plus room for 25 KB/s, never more than 10 minutes. */
    function uploadTimeoutMs(bytes) { return Math.min(600000, 30000 + Math.ceil((Number(bytes) || 0) / 25600) * 1000); }
    /**
     * After re-fetching a thread's newest page: the rows on screen to keep.
     * snap = { maxId, at } is the newest stored id and the time when the fetch started.
     * A stored row missing from the result was deleted only if it was already there when the fetch started
     * and sits inside the fetched range (or the thread came back empty). Rows that arrived meanwhile stay.
     */
    function keepAfterRefetch(list, rows, snap) {
        var got = {}, oldest = Infinity;
        rows.forEach(function (r) { got[String(r.id)] = true; if (Number(r.id) < oldest) oldest = Number(r.id); });
        return list.filter(function (m) {
            if (m.id == null || got[String(m.id)]) return true;
            if (m._addedAt && m._addedAt >= snap.at) return true;
            var id = Number(m.id);
            if (id > snap.maxId) return true;
            return rows.length > 0 && id < oldest;
        });
    }
    /** A group read marker in the server's clock: created_at of the newest stored message on screen. */
    function readMarker(list, fallback) {
        for (var i = list.length - 1; i >= 0; i--) if (list[i].id != null && list[i].created_at) return list[i].created_at;
        return fallback;
    }
    /** Without client_id, my own realtime echo may only be matched to a same-text send whose insert is in flight. */
    function findEchoTarget(list, row) {
        for (var i = 0; i < list.length; i++) {
            var x = list[i];
            if (x.id == null && x._state === 'pending' && x._inFlight && x.body === row.body) return x;
        }
        return null;
    }

    var COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#059669', '#0d9488', '#b45309', '#dc2626', '#4f46e5', '#0891b2'];
    function colorFor(seed) {
        var s = String(seed || ''), h = 0;
        for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        return COLORS[Math.abs(h) % COLORS.length];
    }
    function initials(name) {
        var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return '?';
        if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
        return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    }

    return {
        DELETED: DELETED, escapeHtml: escapeHtml, parseSpecial: parseSpecial, isSpecial: isSpecial,
        fmtBytes: fmtBytes, fmtDuration: fmtDuration, fmtClock: fmtClock, callLabel: callLabel, previewText: previewText,
        dayKey: dayKey, dayLabel: dayLabel, fmtTime: fmtTime, fmtListTime: fmtListTime, fmtLastSeen: fmtLastSeen,
        sameBurst: sameBurst, groupFlags: groupFlags, compareMessages: compareMessages,
        firstUrl: firstUrl, isEmojiOnly: isEmojiOnly, formatBody: formatBody, mentionIdsIn: mentionIdsIn, mentionQuery: mentionQuery,
        safeFileName: safeFileName, storagePath: storagePath, fileBody: fileBody,
        dmTopicKey: dmTopicKey, seenBy: seenBy, searchTerm: searchTerm, colorFor: colorFor, initials: initials,
        isMissingColumn: isMissingColumn, isTransientError: isTransientError, uploadTimeoutMs: uploadTimeoutMs,
        keepAfterRefetch: keepAfterRefetch, readMarker: readMarker, findEchoTarget: findEchoTarget,
    };
});
