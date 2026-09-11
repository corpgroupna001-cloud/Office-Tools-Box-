/* ============================================================================
   WorkSuite Messenger — the page.

   Direct messages and groups on the existing `messages` table (Supabase,
   Row Level Security decides who sees what), files in the private
   `chat-files` bucket, live updates over Supabase Realtime, and calls handed
   to /calls.js (WSCalls). Pure helpers live in chat-logic.js.

   Reliability rules this page is built around:
   - A thread opens on its NEWEST messages and pages back on scroll.
   - Every message is shown before the database confirms it (client_id links
     the optimistic copy to the saved row); unsent ones wait in an outbox that
     retries when the connection returns, and failures can be retried.
   - Realtime drops messages while a laptop sleeps or the network blips, so the
     inbox and the open thread are re-fetched whenever the connection comes
     back, the browser goes online, or the tab returns after 30 seconds.
   - A message counts as read only while the tab is visible and scrolled to it.

   Sections: state · utilities · boot · people · groups · inbox · sidebar ·
   thread · loading · rendering · realtime · read state · sending · files ·
   voice notes · composer · menus · pins & search · dialogs · calls ·
   overlays · connection · wiring.
   ============================================================================ */
(function () {
    'use strict';
    var L = window.WSChatLogic;
    if (!L) { console.error('[messenger] chat-logic.js did not load'); return; }

    // ------------------------------------------------------------------ state
    const PAGE = 50;
    const MAX_FILE_BYTES = 25 * 1024 * 1024;
    const MAX_FILES = 10;
    const VOICE_MAX_S = 300;
    const CACHE_MAX = 8;
    const ONLINE_MS = 75 * 1000;
    const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
    const EMOJI = ['😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎', '🤔', '😅', '😉', '🙂', '🙃', '😴', '😢', '😭',
        '😡', '🤯', '🥳', '😇', '🤝', '👍', '👎', '👏', '🙌', '🙏', '💪', '👀', '✌️', '👌', '🤞', '👋',
        '❤️', '🧡', '💛', '💚', '💙', '💜', '🔥', '✨', '🎉', '🎂', '✅', '❌', '⚠️', '📌', '📎', '💯'];
    const SCHEMA_MISSING = ['42P01', 'PGRST205', '42703', 'PGRST204', 'PGRST202', '42883', 'PGRST200'];
    const INSERT_TIMEOUT_MS = 20000;

    const S = {
        sb: null, cfg: null, me: null,
        people: new Map(), peopleError: false, lastSeen: new Map(), online: new Set(), dayStatus: new Map(),
        groups: new Map(), members: new Map(),
        threads: new Map(), activeKey: null, view: null, cache: new Map(), drafts: new Map(), parents: new Map(),
        reactions: new Map(), reactionMsg: new Map(), counted: new Set(),
        outbox: [], flushing: false, retryTimer: null, retryStep: 0, unsent: new Map(), currentJob: null, uploadXhr: null, recStarting: false,
        features: { inbox: null, clientId: null, groups: null, calls: null, pins: null },
        typing: new Map(), typingTimer: null, lastTypingSent: 0,
        replyTo: null, editing: null, mention: null, emojiFor: null, menuPick: null, suppressClick: false,
        pins: [], searchQ: '', searchSeq: 0, searchTimer: null,
        tab: 'chats', calls: [], callsLoaded: false,
        conn: 'connecting', connTimer: null, wasLive: null, lastSync: 0, syncing: false, syncAgain: false,
        ch: { main: null, groups: null, groupSig: null, presence: null, thread: null, threadTopic: null },
        threadChannels: new Map(), gen: 0,
        rec: null, sideRaf: 0, callBarTimer: null, stickBottom: true, dragDepth: 0, restoreFocus: null, audioCtx: null,
    };

    // -------------------------------------------------------------- utilities
    const $ = (id) => document.getElementById(id);
    const esc = L.escapeHtml;
    function uuid() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        const b = new Uint8Array(16); crypto.getRandomValues(b);
        b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
        const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    }
    function isSchemaMissing(err) { return !!err && (SCHEMA_MISSING.includes(String(err.code)) || L.isMissingColumn(err)); }
    function isTransient(err) { return L.isTransientError(err, navigator.onLine); }
    // A request that never answers would hold the outbox forever: abort it (the retry is safe, see insertMessage).
    function timed(q, ms) {
        if (!q || typeof q.abortSignal !== 'function') return q;
        let signal;
        if (window.AbortSignal && typeof AbortSignal.timeout === 'function') signal = AbortSignal.timeout(ms);
        else { const c = new AbortController(); setTimeout(() => c.abort(), ms); signal = c.signal; }
        return q.abortSignal(signal);
    }
    function friendly(err) {
        const msg = String((err && (err.message || err.error_description || err.error)) || 'Something went wrong');
        if (/row-level security|42501|permission denied/i.test(msg)) return 'You are not allowed to do that here.';
        return msg.slice(0, 160);
    }
    function debounce(fn, ms) { let t; return function () { const a = arguments; clearTimeout(t); t = setTimeout(() => fn.apply(null, a), ms); }; }
    function toast(msg, kind) { try { if (window.WSShell && WSShell.toast) return WSShell.toast(msg, kind || ''); } catch (e) { /* fall through */ } console.log('[messenger]', msg); }
    function isPhone() { return window.matchMedia('(max-width: 768px)').matches; }
    function isCoarse() { return window.matchMedia('(pointer: coarse)').matches; }
    function sid(x) { return x == null ? '' : String(x); }
    function timeOf(iso) { const t = iso ? new Date(iso).getTime() : 0; return isNaN(t) ? 0 : t; }

    function person(id) { return S.people.get(id) || null; }
    function fullName(id) {
        if (S.me && id === S.me.id) return S.me.name;
        const p = person(id);
        return p ? (p.full_name || p.email || '') : '';
    }
    function nameOf(id) { if (S.me && id === S.me.id) return 'You'; return fullName(id) || 'Someone'; }
    function firstName(id) { return nameOf(id).split(/\s+/)[0]; }
    function isOnline(id) {
        if (S.online.has(id)) return true;
        const iso = S.lastSeen.get(id);
        return !!iso && Date.now() - timeOf(iso) < ONLINE_MS;
    }
    function isInactive(p) { return !!(p && p.status && /exit|inactive|disabled|offboard|left/i.test(p.status)); }

    function avatarHtml(o) {
        const name = o.name || '?';
        const cls = 'mx-av' + (o.cls ? ' ' + o.cls : '');
        const inner = o.url
            ? `<img src="${esc(o.url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">${esc(L.initials(name))}`
            : esc(L.initials(name));
        const dot = o.dot == null ? '' : `<i class="mx-dot${o.dot ? ' on' : ''}"></i>`;
        const bg = o.group ? 'var(--mx-mine)' : L.colorFor(o.seed || name);
        return `<span class="${cls}" style="--av:${bg}" aria-hidden="true">${inner}${dot}</span>`;
    }
    function personAvatar(id, cls, withDot) {
        const p = person(id) || {};
        return avatarHtml({ name: p.full_name || p.email || '?', url: p.avatar_url, seed: id, cls, dot: withDot ? isOnline(id) : null });
    }

    // Threads are keyed "dm:<peer id>" or "g:<conversation id>".
    function threadFor(key) {
        let t = S.threads.get(key);
        if (!t) {
            const g = key.indexOf('g:') === 0;
            t = { key, kind: g ? 'group' : 'dm', id: key.slice(g ? 2 : 3), last: null, localLast: null, unread: 0 };
            S.threads.set(key, t);
        }
        return t;
    }
    function activeThread() { return S.activeKey ? S.threads.get(S.activeKey) || null : null; }
    function groupOf(t) { return t && t.kind === 'group' ? S.groups.get(t.id) || null : null; }
    function isMuted(t) { const g = groupOf(t); return !!(g && g.member && g.member.muted); }
    function threadName(t) {
        if (t.kind === 'group') { const g = groupOf(t); return g ? g.name : 'Group'; }
        return fullName(t.id) || 'Unknown';
    }
    function threadAvatar(t, cls) {
        if (t.kind === 'group') return avatarHtml({ name: threadName(t), group: true, cls: 'group' + (cls ? ' ' + cls : '') });
        return personAvatar(t.id, cls, true);
    }
    function memberCount(convId) { return (S.members.get(convId) || []).length; }
    function keyOfMessage(m) { return m.conversation_id ? 'g:' + m.conversation_id : 'dm:' + (m.sender_id === S.me.id ? m.recipient_id : m.sender_id); }
    function belongsTo(t, m) {
        if (!t || !m) return false;
        if (t.kind === 'group') return m.conversation_id === t.id;
        if (m.conversation_id) return false;
        return (m.sender_id === S.me.id && m.recipient_id === t.id) || (m.sender_id === t.id && m.recipient_id === S.me.id);
    }
    function mKey(m) { return m.client_id ? 'c' + m.client_id : 'i' + m.id; }
    function threadQuery(t, cols) {
        const q = S.sb.from('messages').select(cols || '*');
        if (t.kind === 'group') return q.eq('conversation_id', t.id);
        const me = S.me.id, p = t.id;
        return q.or(`and(sender_id.eq.${me},recipient_id.eq.${p}),and(sender_id.eq.${p},recipient_id.eq.${me})`);
    }

    // ------------------------------------------------------------------- boot
    async function boot() {
        setConn('connecting');
        let cfg = null;
        try { const r = await fetch('/api/config'); cfg = await r.json(); } catch (e) { /* offline or blocked */ }
        if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) {
            return fatal('Messenger could not reach the server. Check your connection and reload the page.');
        }
        S.cfg = cfg;
        S.sb = window.__WS_SB__ && window.__WS_SB__.auth ? window.__WS_SB__
            : window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
        window.__WS_SB__ = S.sb;                      // presence.js, shell.js and calls.js reuse it
        let session = null;
        try { session = (await S.sb.auth.getSession()).data.session; } catch (e) { /* treated as signed out */ }
        if (!session) return fatal('You are signed out. Sign in from the WorkSuite home page to use Messenger.', true);
        const meta = session.user.user_metadata || {};
        S.me = { id: session.user.id, email: session.user.email || '', name: meta.full_name || (session.user.email || 'You').split('@')[0], avatar: meta.avatar_url || '' };
        S.sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') location.replace('/'); });

        await loadPeople();
        await loadGroups();
        await loadInbox();
        paintSidebar();
        subscribeMain();
        subscribePresence();
        S.lastSync = Date.now();
        handleHash();
        loadTeamStatus();
        setInterval(loadTeamStatus, 15 * 60 * 1000);   // leave and holidays change rarely
        setInterval(pollLastSeen, 60 * 1000);
        setInterval(() => { renderSidebar(); if (activeThread()) paintHeader(); }, 60 * 1000);
        setTimeout(loadCalls, 1200);
        try { if (window.WSPush) WSPush.init(S.sb); } catch (e) { /* push is optional */ }
        maybeShowRules();
    }

    function fatal(text, signIn) {
        setConn('live');
        $('mx-list').innerHTML = `<div class="mx-list-empty">${esc(text)}${signIn ? '<br><br><a class="mx-btn primary" href="/">Sign in</a>' : ''}</div>`;
        $('mx-empty-text').textContent = text;
        $('mx-empty-new').hidden = true;
    }

    // ----------------------------------------------------------------- people
    async function loadPeople() {
        let r = await S.sb.from('profiles').select('id, email, full_name, avatar_url, last_seen_at, company, job_title, department, status').order('full_name');
        if (r.error && L.isMissingColumn(r.error)) r = await S.sb.from('profiles').select('id, email, full_name, avatar_url, last_seen_at, company').order('full_name');
        if (r.error) { S.peopleError = true; console.warn('[messenger] people', r.error); return; }
        (r.data || []).forEach(p => { S.people.set(p.id, p); if (p.last_seen_at) S.lastSeen.set(p.id, p.last_seen_at); });
        const me = person(S.me.id);
        if (me) { S.me.name = me.full_name || S.me.name; S.me.avatar = me.avatar_url || S.me.avatar; }
    }
    async function ensurePerson(id) {
        if (!id || S.people.has(id)) return;
        const { data } = await S.sb.from('profiles').select('id, email, full_name, avatar_url, last_seen_at, company').eq('id', id).maybeSingle();
        if (data) { S.people.set(data.id, data); if (data.last_seen_at) S.lastSeen.set(data.id, data.last_seen_at); }
    }
    async function pollLastSeen() {
        if (!S.me || document.visibilityState !== 'visible') return;
        try {
            const { data } = await S.sb.from('profiles').select('id, last_seen_at').neq('id', S.me.id).limit(1000);
            (data || []).forEach(r => { if (r.last_seen_at) S.lastSeen.set(r.id, r.last_seen_at); });
            renderSidebar();
            if (activeThread()) paintHeader();
        } catch (e) { /* next poll */ }
    }
    function subscribePresence() {
        try {
            const ch = S.sb.channel('presence:global', { config: { presence: { key: S.me.id } } });
            ch.on('presence', { event: 'sync' }, () => {
                S.online = new Set(Object.keys(ch.presenceState() || {}));
                renderSidebar();
                if (activeThread()) paintHeader();
            }).subscribe(async (status) => {
                if (status === 'SUBSCRIBED') { try { await ch.track({ user: S.me.id, name: S.me.name }); } catch (e) { /* presence is a nicety */ } }
            });
            S.ch.presence = ch;
        } catch (e) { /* realtime unavailable */ }
    }

    // Leave, holidays and weekly offs come from the server: leave_requests is
    // RLS'd to "your own rows". Names and status only — never present/absent.
    const SHOW_STATUS = new Set(['leave', 'holiday', 'weekoff']);
    async function loadTeamStatus() {
        try {
            const { data: { session } } = await S.sb.auth.getSession();
            if (!session) return;
            const r = await fetch('/api/attendance-webhook', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
                body: JSON.stringify({ mode: 'team_status' }),
            });
            if (!r.ok) return;
            const data = await r.json();
            S.dayStatus = new Map((data.people || []).map(p => [p.id, p]));
            renderSidebar();
        } catch (e) { /* badges are optional */ }
    }
    function statusChip(id) {
        const p = S.dayStatus.get(id);
        if (!p) return '';
        if (SHOW_STATUS.has(p.status)) {
            const c = /^#[0-9a-f]{3,8}$/i.test(p.color || '') ? p.color : '#64748b';
            return `<span class="mx-chip" style="background:${c}1f;color:${c};border-color:${c}55">${esc(p.icon || '')} ${esc(p.label || '')}</span>`;
        }
        return p.is_wfh ? '<span class="mx-chip wfh">WFH</span>' : '';
    }

    // ----------------------------------------------------------------- groups
    async function loadGroups() {
        if (S.features.groups === false || !S.me) return;
        let r;
        try {
            r = await S.sb.from('conversation_members')
                .select('conversation_id, role, last_read_at, muted, conversation:conversations(*)').eq('user_id', S.me.id);
        } catch (e) { return; }
        if (r.error) {
            if (isSchemaMissing(r.error)) { S.features.groups = false; paintNewButtonState(); }
            else console.warn('[messenger] groups', r.error);
            return;
        }
        S.features.groups = true;
        const rows = (r.data || []).filter(x => x.conversation && !x.conversation.archived_at);
        S.groups = new Map(rows.map(x => [x.conversation_id, Object.assign({}, x.conversation, { member: { role: x.role, last_read_at: x.last_read_at, muted: !!x.muted } })]));
        const ids = [...S.groups.keys()];
        const members = new Map(ids.map(id => [id, []]));
        if (ids.length) {
            const m = await S.sb.from('conversation_members').select('conversation_id, user_id, role, last_read_at, muted').in('conversation_id', ids);
            (m.data || []).forEach(x => { if (members.has(x.conversation_id)) members.get(x.conversation_id).push(x); });
        }
        S.members = members;
        ids.forEach(id => threadFor('g:' + id));
        [...S.threads.values()].forEach(t => {
            if (t.kind !== 'group' || S.groups.has(t.id)) return;
            S.threads.delete(t.key); S.cache.delete(t.key);
            if (S.activeKey === t.key) { closeThread(); toast('You are no longer in that group.'); }
        });
        subscribeGroups();
        if (activeThread() && activeThread().kind === 'group') { paintHeader(); if (S.view) renderView({ keep: true }); }
        renderSidebar();
        paintNewButtonState();
    }
    const loadGroupsSoon = debounce(() => { loadGroups().then(loadInbox); }, 500);
    function isGroupAdmin(g) {
        if (!g) return false;
        const role = window.WSShell && WSShell.role;
        return g.created_by === S.me.id || (g.member && g.member.role === 'admin') || role === 'manager' || role === 'admin';
    }
    function paintNewButtonState() { $('mx-new').title = S.features.groups ? 'New chat or group' : 'New chat'; }

    // ------------------------------------------------------------------ inbox
    async function loadInbox() {
        if (!S.me) return;
        let rows = null;
        if (S.features.inbox !== false) {
            try {
                const r = await S.sb.rpc('ws_chat_inbox');
                if (r.error) { if (isSchemaMissing(r.error)) S.features.inbox = false; else console.warn('[messenger] inbox', r.error); }
                else if (Array.isArray(r.data)) { rows = r.data; S.features.inbox = true; }
            } catch (e) { /* fall back */ }
        }
        if (!rows) rows = await inboxFallback();
        if (!rows) return;
        const seen = new Set();
        rows.forEach(r => {
            if (r.kind === 'group') { if (!r.conversation_id || (S.features.groups && !S.groups.has(r.conversation_id))) return; }
            else if (!r.peer_id || r.peer_id === S.me.id) return;
            const key = r.kind === 'group' ? 'g:' + r.conversation_id : 'dm:' + r.peer_id;
            const t = threadFor(key);
            seen.add(key);
            t.last = r.last_id != null ? { id: r.last_id, sender_id: r.last_sender, body: r.last_body, created_at: r.last_at } : null;
            t.unread = Math.max(0, Number(r.unread) || 0);
        });
        // A direct thread missing from the inbox has been cleared.
        S.threads.forEach(t => { if (t.kind === 'dm' && !seen.has(t.key)) { t.last = null; t.unread = 0; } });
        const at = activeThread();
        if (at && isReadingNow()) { at.unread = 0; scheduleMarkRead(); }
        const missing = [...seen].filter(k => k.indexOf('dm:') === 0 && !S.people.has(k.slice(3)));
        if (missing.length) await Promise.all(missing.slice(0, 20).map(k => ensurePerson(k.slice(3))));
        recomputeUnread();
        renderSidebar();
    }

    // Before the messenger & calls migration: work it out from recent rows.
    async function inboxFallback() {
        const me = S.me.id, out = [];
        try {
            const [dm, unread] = await Promise.all([
                S.sb.from('messages').select('id, sender_id, recipient_id, conversation_id, body, created_at')
                    .or(`sender_id.eq.${me},recipient_id.eq.${me}`).order('id', { ascending: false }).limit(1000),
                S.sb.from('messages').select('id, sender_id, body').eq('recipient_id', me).is('read_at', null).limit(2000),
            ]);
            const unreadBy = new Map();
            (unread.data || []).forEach(m => { if (m.body !== L.DELETED) unreadBy.set(m.sender_id, (unreadBy.get(m.sender_id) || 0) + 1); });
            const lastBy = new Map();
            (dm.data || []).forEach(m => {
                if (m.conversation_id || (m.sender_id !== me && m.recipient_id !== me)) return;
                const peer = m.sender_id === me ? m.recipient_id : m.sender_id;
                if (peer && !lastBy.has(peer)) lastBy.set(peer, m);
            });
            lastBy.forEach((m, peer) => out.push({ kind: 'dm', peer_id: peer, last_id: m.id, last_sender: m.sender_id, last_body: m.body, last_at: m.created_at, unread: unreadBy.get(peer) || 0 }));
            const ids = [...S.groups.keys()];
            if (ids.length) {
                const g = await S.sb.from('messages').select('id, sender_id, conversation_id, body, created_at')
                    .in('conversation_id', ids).order('id', { ascending: false }).limit(800);
                const lastG = new Map(), unreadG = new Map();
                (g.data || []).forEach(m => {
                    const grp = S.groups.get(m.conversation_id);
                    if (!grp) return;
                    if (!lastG.has(m.conversation_id)) lastG.set(m.conversation_id, m);
                    const readAt = grp.member.last_read_at ? timeOf(grp.member.last_read_at) : 0;
                    if (m.sender_id !== me && m.body !== L.DELETED && timeOf(m.created_at) > readAt) unreadG.set(m.conversation_id, (unreadG.get(m.conversation_id) || 0) + 1);
                });
                ids.forEach(id => {
                    const m = lastG.get(id);
                    out.push({ kind: 'group', conversation_id: id, last_id: m ? m.id : null, last_sender: m ? m.sender_id : null, last_body: m ? m.body : null, last_at: m ? m.created_at : null, unread: unreadG.get(id) || 0 });
                });
            }
            return out;
        } catch (e) { console.warn('[messenger] inbox fallback', e); return null; }
    }

    // ---------------------------------------------------------------- sidebar
    function renderSidebar() {
        if (S.sideRaf) return;
        S.sideRaf = requestAnimationFrame(() => { S.sideRaf = 0; paintSidebar(); });
    }
    function lastOf(t) {
        const a = t.localLast, b = t.last;
        if (a && (!b || timeOf(a.created_at) >= timeOf(b.created_at))) return a;
        return b;
    }
    function sortTime(t) {
        const l = lastOf(t);
        if (l) return timeOf(l.created_at);
        const g = groupOf(t);
        return g ? timeOf(g.created_at) : 0;
    }
    function paintSidebar() {
        if (!S.me || S.tab !== 'chats') return;
        const q = $('mx-search').value.trim().toLowerCase();
        const match = (s) => !q || String(s || '').toLowerCase().indexOf(q) !== -1;
        const all = [...S.threads.values()];
        const chats = all.filter(t => t.kind === 'group' ? S.groups.has(t.id) : (lastOf(t) || t.key === S.activeKey))
            .filter(t => match(threadName(t)) || (t.kind === 'dm' && match((person(t.id) || {}).email)))
            .sort((a, b) => sortTime(b) - sortTime(a));
        const hasThread = new Set(all.filter(t => t.kind === 'dm' && (lastOf(t) || t.key === S.activeKey)).map(t => t.id));
        const people = [...S.people.values()]
            .filter(p => p.id !== S.me.id && !hasThread.has(p.id) && !isInactive(p) && (match(p.full_name) || match(p.email)))
            .sort((a, b) => (isOnline(b.id) - isOnline(a.id)) || String(a.full_name || a.email).localeCompare(String(b.full_name || b.email)));
        let html = '';
        if (chats.length) html += section('Chats', chats.length) + chats.map(threadRowHtml).join('');
        if (people.length) html += section(q ? 'People' : 'Colleagues', people.length) + people.map(personRowHtml).join('');
        if (!html) {
            html = `<div class="mx-list-empty">${q ? `Nobody matches “${esc(q)}”.`
                : S.peopleError ? 'Colleagues could not be listed right now. Reload the page to try again.' : 'No colleagues to chat with yet.'}</div>`;
        }
        const list = $('mx-list'), top = list.scrollTop;
        list.innerHTML = html;
        list.scrollTop = top;
    }
    function section(label, n) { return `<div class="mx-section"><span>${esc(label)}</span><span class="n">${n}</span></div>`; }
    function threadRowHtml(t) {
        const name = threadName(t), last = lastOf(t), muted = isMuted(t);
        let prev = '', prevCls = '';
        if (t.localLast && t.localLast._state === 'failed') { prev = '⚠ Not sent — open to retry'; prevCls = ' fail'; }
        else if (last) {
            const sp = L.parseSpecial(last.body);
            const who = sp.kind === 'call' ? '' : last.sender_id === S.me.id ? 'You: ' : t.kind === 'group' ? firstName(last.sender_id) + ': ' : '';
            prev = (who ? `<span class="who">${esc(who)}</span>` : '') + esc(L.previewText(last.body));
        } else if (t.kind === 'group') {
            const g = groupOf(t);
            prev = esc((g && g.description) || `${memberCount(t.id)} members`);
        }
        const time = last ? L.fmtListTime(last.created_at) : '';
        const unread = t.unread > 0;
        return `<div class="mx-item${t.key === S.activeKey ? ' active' : ''}${unread ? ' unread' : ''}${muted ? ' muted' : ''}" role="listitem" tabindex="0" data-key="${esc(t.key)}" aria-label="${esc(name + (unread ? `, ${t.unread} unread` : ''))}">
            ${threadAvatar(t)}
            <div class="mx-item-body">
                <div class="mx-item-top"><span class="mx-item-name">${esc(name)}${t.kind === 'dm' ? statusChip(t.id) : ''}</span><span class="mx-item-time">${esc(time)}</span></div>
                <div class="mx-item-bottom"><span class="mx-item-prev${prevCls}">${prev}</span>${muted ? '<span class="mx-mute-ic" title="Muted">🔕</span>' : ''}${unread ? `<span class="mx-badge">${t.unread > 99 ? '99+' : t.unread}</span>` : ''}</div>
            </div></div>`;
    }
    function personRowHtml(p) {
        const on = isOnline(p.id);
        const sub = on ? 'online' : (p.job_title || p.department || p.email || '');
        return `<div class="mx-item" role="listitem" tabindex="0" data-person="${esc(p.id)}" aria-label="${esc('Message ' + (p.full_name || p.email || ''))}">
            ${personAvatar(p.id, '', true)}
            <div class="mx-item-body">
                <div class="mx-item-top"><span class="mx-item-name">${esc(p.full_name || p.email || 'Unknown')}${statusChip(p.id)}</span></div>
                <div class="mx-item-bottom"><span class="mx-item-prev"${on ? ' style="color:var(--mx-ok)"' : ''}>${esc(sub)}</span></div>
            </div></div>`;
    }
    function setTab(tab) {
        S.tab = tab;
        ['chats', 'calls'].forEach(x => $('mx-tab-' + x).setAttribute('aria-selected', String(x === tab)));
        $('mx-list').hidden = tab !== 'chats';
        $('mx-calls').hidden = tab !== 'calls';
        $('mx-search').placeholder = tab === 'calls' ? 'Search calls' : 'Search people and groups';
        if (tab === 'calls') { paintCalls(); loadCalls(); markCallsSeen(); } else paintSidebar();
    }

    // ----------------------------------------------------------------- thread
    async function openThread(key, opts) {
        opts = opts || {};
        if (!S.me) return;
        const t = threadFor(key);
        if (t.kind === 'dm') {
            if (t.id === S.me.id) { S.threads.delete(key); return; }
            if (!person(t.id)) {
                await ensurePerson(t.id);
                if (!person(t.id)) { S.threads.delete(key); toast('That person could not be found.', 'bad'); return; }
            }
        } else if (!S.groups.has(t.id)) return;
        $('mx').classList.add('thread-open');
        if (S.activeKey === key && !opts.force) { if (!isPhone()) focusComposer(); return; }
        // On a phone a conversation is a screen of its own: give the back gesture something to undo.
        if (isPhone() && !opts.fromPop) {
            try { if (history.state && history.state.mxThread) history.replaceState({ mxThread: key }, ''); else history.pushState({ mxThread: key }, ''); }
            catch (e) { /* sandboxed frame */ }
        }

        if (S.activeKey) S.drafts.set(S.activeKey, S.editing ? '' : $('mx-input').value);
        if (S.rec) stopRecording(false);
        closeFloating(); resetCompose(); closeSearch();
        S.typing.clear();
        S.activeKey = key;
        $('mx-empty').hidden = true;
        $('mx-thread').hidden = false;
        $('mx-pinned').hidden = true; $('mx-callbar').hidden = true; $('mx-newpill').hidden = true;
        $('mx-input').value = S.drafts.get(key) || '';
        autosize(); updateSendButton();
        paintHeader();

        let view = S.cache.get(key);
        if (view) {
            S.cache.delete(key); S.cache.set(key, view);          // most recently used last
            S.view = view; view.unseen = 0;
            if (view.detached) loadLatest(view);
            else { renderView({ toBottom: true }); fetchLatest(view); }
        } else {
            view = newView(key);
            S.cache.set(key, view); trimCache();
            S.view = view;
            $('mx-msgs').innerHTML = '<div class="mx-thread-empty">Loading messages…</div>';
            loadLatest(view);
        }
        joinThreadChannel(t);
        loadPinned();
        refreshCallBar(); startCallBarPolling();
        renderSidebar();
        scheduleMarkRead();
        if (!isPhone()) focusComposer();
    }
    function closeThread() {
        if (S.activeKey) S.drafts.set(S.activeKey, S.editing ? '' : $('mx-input').value);
        if (S.rec) stopRecording(false);
        closeFloating(); resetCompose(); closeSearch();
        S.typing.clear();
        S.activeKey = null; S.view = null; S.ch.thread = null; S.ch.threadTopic = null;
        stopCallBarPolling();
        $('mx-thread').hidden = true;
        $('mx-empty').hidden = false;
        $('mx').classList.remove('thread-open');
        renderSidebar();
    }
    function trimCache() {
        while (S.cache.size > CACHE_MAX) {
            const oldest = [...S.cache.keys()].find(k => k !== S.activeKey);
            if (!oldest) break;
            S.cache.delete(oldest);
        }
    }
    function focusComposer() { try { $('mx-input').focus({ preventScroll: true }); } catch (e) { /* hidden */ } }

    function activeTypers() {
        const now = Date.now();
        return [...S.typing].filter(([, exp]) => exp > now).map(([id]) => id);
    }
    function paintHeader() {
        const t = activeThread();
        if (!t) return;
        $('mx-head-av').innerHTML = threadAvatar(t);
        $('mx-head-name').textContent = threadName(t);
        const typers = activeTypers();
        let sub, cls = '';
        if (typers.length) {
            cls = 'typing';
            sub = t.kind === 'group'
                ? typers.slice(0, 2).map(firstName).join(', ') + (typers.length > 1 ? ' are typing…' : ' is typing…')
                : 'typing…';
        } else if (t.kind === 'dm') {
            const p = person(t.id);
            if (p && isInactive(p)) sub = 'no longer active in WorkSuite';
            else if (isOnline(t.id)) { sub = 'online'; cls = 'online'; }
            else sub = L.fmtLastSeen(S.lastSeen.get(t.id));
            const st = S.dayStatus.get(t.id);
            if (st && SHOW_STATUS.has(st.status) && !typers.length) sub += ' · ' + (st.label || 'away today');
        } else {
            const n = memberCount(t.id), g = groupOf(t);
            sub = `${n} member${n === 1 ? '' : 's'}${g && g.description ? ' · ' + g.description : ''}`;
        }
        const s = $('mx-head-sub');
        s.textContent = sub;
        s.className = cls;
        $('mx-head-who').setAttribute('aria-label', t.kind === 'group' ? 'Group info' : 'View profile');
    }

    // Per-thread channel: typing (broadcast) and, for groups, members' read markers.
    function joinThreadChannel(t) {
        const topic = 'typing:' + (t.kind === 'dm' ? L.dmTopicKey(S.me.id, t.id) : 'g:' + t.id);
        S.ch.threadTopic = topic;
        let ch = S.threadChannels.get(topic);
        if (ch) { S.threadChannels.delete(topic); S.threadChannels.set(topic, ch); S.ch.thread = ch; return; }
        try {
            ch = S.sb.channel(topic, { config: { broadcast: { self: false } } });
            ch.on('broadcast', { event: 'typing' }, ({ payload }) => onTyping(topic, payload));
            if (t.kind === 'group') {
                ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversation_members', filter: `conversation_id=eq.${t.id}` },
                    (p) => onMemberRow(p.new));
            }
            ch.subscribe();
            S.threadChannels.set(topic, ch);
            S.ch.thread = ch;
        } catch (e) { S.ch.thread = null; }
        while (S.threadChannels.size > 4) {
            const [k, old] = S.threadChannels.entries().next().value;
            if (k === topic) break;
            S.threadChannels.delete(k);
            try { S.sb.removeChannel(old); } catch (e) { /* already gone */ }
        }
    }
    function onTyping(topic, p) {
        if (topic !== S.ch.threadTopic || !p || !p.from || p.from === S.me.id) return;
        S.typing.set(p.from, Date.now() + 4500);
        paintHeader();
        clearTimeout(S.typingTimer);
        S.typingTimer = setTimeout(paintHeader, 4700);
    }
    function sendTyping() {
        if (!S.ch.thread || Date.now() - S.lastTypingSent < 2500) return;
        S.lastTypingSent = Date.now();
        try { const r = S.ch.thread.send({ type: 'broadcast', event: 'typing', payload: { from: S.me.id } }); if (r && r.catch) r.catch(() => {}); } catch (e) { /* typing is best effort */ }
    }
    function onMemberRow(row) {
        if (!row || !row.conversation_id) return;
        const list = S.members.get(row.conversation_id);
        if (!list) return;
        const i = list.findIndex(x => x.user_id === row.user_id);
        if (i >= 0) list[i] = Object.assign({}, list[i], row); else list.push(row);
        if (row.user_id === S.me.id) { const g = S.groups.get(row.conversation_id); if (g) Object.assign(g.member, { last_read_at: row.last_read_at, muted: !!row.muted, role: row.role }); }
        const t = activeThread();
        if (t && t.kind === 'group' && t.id === row.conversation_id && S.view) renderView({ keep: true });
    }

    // ---------------------------------------------------------------- loading
    function newView(key) {
        return { key, list: [], byId: new Map(), byClient: new Map(), els: new Map(), hasOlder: false, loading: false, detached: false, ready: false, unseen: 0 };
    }
    function resetView(view) { view.list = []; view.byId.clear(); view.byClient.clear(); }
    function sortView(view) { view.list.sort(L.compareMessages); }
    // Adds a row or merges it into the copy already shown (by id, or by client_id for my own).
    function upsertMessage(view, row) {
        let m = row.id != null ? view.byId.get(sid(row.id)) : null;
        if (!m && row.client_id) m = view.byClient.get(row.client_id);
        if (!m && row.id != null && S.me && row.sender_id === S.me.id && !row.client_id) {
            // Without the client_id column my echo can only be matched by text, and only to the send in flight;
            // the same words sent from another device are a message of their own.
            m = L.findEchoTarget(view.list, row);
        }
        if (m) {
            Object.assign(m, row);
            if (row.id != null) { delete m._state; delete m._err; view.byId.set(sid(row.id), m); forgetUnsent(m); }
            if (m.client_id) view.byClient.set(m.client_id, m);
            return 'updated';
        }
        if (row._addedAt == null) row._addedAt = Date.now();
        view.list.push(row);
        if (row.id != null) view.byId.set(sid(row.id), row);
        if (row.client_id) view.byClient.set(row.client_id, row);
        return 'added';
    }
    // Unsent and failed messages outlive the thread view they were written in (views are evicted and reloaded).
    function rememberUnsent(key, m) { if (!S.unsent.has(key)) S.unsent.set(key, new Set()); S.unsent.get(key).add(m); }
    function forgetUnsent(m) { S.unsent.forEach(set => set.delete(m)); }
    function unsentIn(view) { return [...new Set([...(S.unsent.get(view.key) || [])].concat(view.list.filter(m => m.id == null)))]; }
    function findMessage(id) {
        const k = sid(id);
        return (S.view && S.view.byId.get(k)) || S.parents.get(k) || null;
    }

    async function loadLatest(view) {
        const t = S.threads.get(view.key);
        if (!t) return;
        let r;
        try { r = await threadQuery(t).order('id', { ascending: false }).limit(PAGE); } catch (e) { r = { error: e }; }
        if (S.cache.get(view.key) !== view) return;
        if (r.error) {
            if (S.view === view && !view.list.length) $('mx-msgs').innerHTML = '<div class="mx-thread-empty"><b>Messages are unavailable right now</b>They will load when the connection is back.</div>';
            return;
        }
        const rows = (r.data || []).filter(m => belongsTo(t, m)).reverse();
        const pending = unsentIn(view);
        resetView(view);
        rows.forEach(m => upsertMessage(view, m));
        pending.forEach(m => upsertMessage(view, m));
        view.hasOlder = (r.data || []).length >= PAGE;
        view.detached = false; view.unseen = 0;
        sortView(view);
        if (S.view === view) { renderView({ toBottom: true }); scheduleMarkRead(); }
        loadReactions(rows.map(m => m.id));
    }
    // Merge the latest page into a thread already on screen (resync, reopen).
    async function fetchLatest(view) {
        if (view.detached) return;
        const t = S.threads.get(view.key);
        if (!t) return;
        const known = view.list.filter(m => m.id != null).map(m => Number(m.id));
        const snap = { maxId: known.length ? Math.max(...known) : 0, at: Date.now() };
        let r;
        try { r = await threadQuery(t).order('id', { ascending: false }).limit(PAGE); } catch (e) { return; }
        if (r.error || S.cache.get(view.key) !== view || view.detached) return;
        const rows = (r.data || []).filter(m => belongsTo(t, m));
        const oldestGot = rows.length ? Math.min(...rows.map(m => Number(m.id))) : Infinity;
        if (rows.length >= PAGE && snap.maxId && oldestGot > snap.maxId) return loadLatest(view);   // too much was missed: start over
        const before = view.list.length;
        // What the server no longer has was deleted (a cleared chat); rows that arrived while this fetch was out stay.
        view.list = L.keepAfterRefetch(view.list, rows, snap);
        if (view.list.length !== before) { view.byId.clear(); view.byClient.clear(); view.list.forEach(m => { if (m.id != null) view.byId.set(sid(m.id), m); if (m.client_id) view.byClient.set(m.client_id, m); }); }
        rows.forEach(m => upsertMessage(view, m));
        sortView(view);
        if (S.view === view) { renderView({ keep: !S.stickBottom }); scheduleMarkRead(); }
        loadReactions(rows.map(m => m.id));
    }
    async function loadOlder() {
        const view = S.view;
        if (!view || view.loading || !view.hasOlder) return;
        const oldest = view.list.find(m => m.id != null);
        if (!oldest) { view.hasOlder = false; return; }
        const t = activeThread();
        view.loading = true;
        $('mx-older').hidden = false;
        let r;
        try { r = await threadQuery(t).lt('id', oldest.id).order('id', { ascending: false }).limit(PAGE); } catch (e) { r = { error: e }; }
        view.loading = false;
        $('mx-older').hidden = true;
        if (S.view !== view || r.error) return;
        const rows = (r.data || []).filter(m => belongsTo(t, m));
        view.hasOlder = (r.data || []).length >= PAGE;
        rows.forEach(m => upsertMessage(view, m));
        sortView(view);
        renderView({ prepend: true });
        loadReactions(rows.map(m => m.id));
    }
    // Search results and quotes can point anywhere: load a window around that message.
    async function jumpTo(id) {
        const view = S.view, t = activeThread();
        if (!view || !t || id == null) return;
        if (view.byId.has(sid(id))) return flashMessage(id);
        const [older, newer] = await Promise.all([
            threadQuery(t).lte('id', id).order('id', { ascending: false }).limit(25),
            threadQuery(t).gt('id', id).order('id', { ascending: true }).limit(25),
        ]);
        if (S.view !== view) return;
        if (older.error || !(older.data || []).some(m => sid(m.id) === sid(id))) { toast('That message is no longer available.', 'bad'); return; }
        const rows = [].concat((older.data || []).slice().reverse(), newer.data || []).filter(m => belongsTo(t, m));
        const pending = unsentIn(view);
        resetView(view);
        rows.forEach(m => upsertMessage(view, m));
        view.detached = (newer.data || []).length >= 25;
        if (!view.detached) pending.forEach(m => upsertMessage(view, m));
        view.hasOlder = (older.data || []).length >= 25;
        sortView(view);
        renderView({ keep: true });
        loadReactions(rows.map(m => m.id));
        requestAnimationFrame(() => flashMessage(id));
    }
    function flashMessage(id) {
        const m = S.view && S.view.byId.get(sid(id));
        const hit = m && S.view.els.get(mKey(m));
        if (!hit) return;
        hit.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        hit.el.classList.remove('flash'); void hit.el.offsetWidth; hit.el.classList.add('flash');
        setTimeout(() => hit.el.classList.remove('flash'), 1700);
    }

    async function loadReactions(ids) {
        ids = ids.filter(x => x != null).map(sid);
        for (let i = 0; i < ids.length; i += 100) {
            const chunk = ids.slice(i, i + 100);
            let r;
            try { r = await S.sb.from('message_reactions').select('id, message_id, user_id, emoji').in('message_id', chunk); } catch (e) { return; }
            if (r.error) return;
            const by = new Map(chunk.map(id => [id, []]));
            (r.data || []).forEach(x => {
                const k = sid(x.message_id);
                if (!by.has(k)) return;
                by.get(k).push(x);
                S.reactionMsg.set(sid(x.id), k);
            });
            by.forEach((list, id) => { S.reactions.set(id, list); paintReactions(id); });
        }
    }
    async function fetchParent(id) {
        const k = sid(id);
        if (S.parents.has(k) || fetchParent.busy.has(k)) return;
        fetchParent.busy.add(k);
        try {
            const { data } = await S.sb.from('messages').select('id, sender_id, recipient_id, conversation_id, body, created_at').eq('id', id).maybeSingle();
            S.parents.set(k, data || { id, sender_id: null, body: 'Original message unavailable', created_at: null, _missing: true });
            if (S.view) renderView({ keep: true });
        } catch (e) { /* the quote keeps its placeholder */ } finally { fetchParent.busy.delete(k); }
    }
    fetchParent.busy = new Set();

    // -------------------------------------------------------------- rendering
    function isNearBottom() { const sc = $('mx-scroll'); return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 140; }
    function renderView(opt) {
        opt = opt || {};
        const view = S.view;
        if (!view) return;
        const box = $('mx-msgs'), sc = $('mx-scroll');
        const near = isNearBottom();
        const prevH = sc.scrollHeight, prevTop = sc.scrollTop;
        const list = view.list, nodes = [];
        if (!list.length) nodes.push(emptyThreadNode());
        const seen = seenInfo(view);
        for (let i = 0; i < list.length; i++) {
            const m = list[i], f = L.groupFlags(list, i);
            if (f.newDay) nodes.push(dayNode(view, m.created_at));
            nodes.push(rowNode(view, m, f));
            if (seen && seen.key === mKey(m)) nodes.push(seen.el);
        }
        box.replaceChildren.apply(box, nodes);
        view.ready = true;
        if (opt.toBottom || (near && !opt.prepend && !opt.keep)) sc.scrollTop = sc.scrollHeight;
        else if (opt.prepend) sc.scrollTop = prevTop + (sc.scrollHeight - prevH);
        S.stickBottom = isNearBottom();
        if (S.stickBottom) view.unseen = 0;
        updateNewPill();
        if (S.searchQ) applyLocalSearch();
        requestAnimationFrame(checkSentinel);
    }
    function emptyThreadNode() {
        const t = activeThread(), el = document.createElement('div');
        el.className = 'mx-thread-empty';
        el.innerHTML = t && t.kind === 'dm'
            ? `<b>No messages yet</b>Say hello to ${esc(firstName(t.id))} 👋`
            : '<b>No messages yet</b>Start the conversation.';
        return el;
    }
    function dayNode(view, iso) {
        const k = 'd' + L.dayKey(iso), label = L.dayLabel(iso);
        const hit = view.els.get(k);
        if (hit && hit.sig === label) return hit.el;
        const el = document.createElement('div');
        el.className = 'mx-day';
        el.innerHTML = `<span>${esc(label)}</span>`;
        view.els.set(k, { el, sig: label });
        return el;
    }
    function rowNode(view, m, f) {
        const parent = m.reply_to_id != null ? findMessage(m.reply_to_id) : null;
        const sig = [m.id, m.body, m.edited_at || '', m.pinned_at ? 1 : 0, m.read_at ? 1 : 0, m._state || '', m._err || '',
            f.first ? 1 : 0, f.last ? 1 : 0, parent ? sid(parent.id) + (parent.body || '') : '', S.me.name].join('|');
        const k = mKey(m), hit = view.els.get(k);
        if (hit && hit.sig === sig) return hit.el;
        const el = buildRow(m, f, parent);
        view.els.set(k, { el, sig });
        return el;
    }
    function receiptHtml(m) {
        if (m._state === 'pending' || m._state === 'uploading') return '<span class="mx-rcpt" title="Sending" aria-label="Sending">🕓</span>';
        if (m._state === 'failed') return '<span class="mx-rcpt fail" title="Not sent" aria-label="Not sent">⚠</span>';
        if (!m.conversation_id && m.read_at) return '<span class="mx-rcpt read" title="Read" aria-label="Read">✓✓</span>';
        return '<span class="mx-rcpt" title="Sent" aria-label="Sent">✓</span>';
    }
    function buildRow(m, f, parent) {
        const sp = L.parseSpecial(m.body);
        const mine = m.sender_id === S.me.id;
        const el = document.createElement('div');
        el.dataset.key = mKey(m);
        if (m.id != null) el.dataset.id = sid(m.id);

        if (sp.kind === 'call') {
            const c = L.callLabel(sp, mine);
            const dm = !m.conversation_id;
            el.className = 'mx-callrow';
            el.innerHTML = `<span class="mx-callpill${c.missed ? ' miss' : ''}"><span aria-hidden="true">${c.icon}</span><span>${esc(c.text)}</span><time>${esc(L.fmtTime(m.created_at))}</time>${dm ? `<button type="button" data-act="callback" data-media="${sp.media}">Call back</button>` : ''}</span>`;
            return el;
        }

        const group = !!m.conversation_id;
        el.className = `mx-msg ${mine ? 'mine' : 'theirs'}${f.first ? ' first' : ''}${f.last ? ' last' : ''}${m._state ? ' pending' : ''}`;
        const bubbleCls = ['mx-bubble'];
        let content;
        if (sp.kind === 'deleted') { bubbleCls.push('deleted'); content = '<span class="mx-text">🚫 This message was deleted</span>'; }
        else if (sp.kind === 'file') { if (sp.isImage || sp.isAudio || sp.isVideo) bubbleCls.push('media'); content = fileHtml(m, sp); }
        else {
            if (L.isEmojiOnly(sp.text) && !m.reply_to_id) bubbleCls.push('emoji');
            content = `<div class="mx-text">${L.formatBody(sp.text, { names: mentionNames(), meName: S.me.name })}</div>`;
        }
        const live = sp.kind !== 'deleted';
        const meta = `<span class="mx-meta">${m.pinned_at && live ? '<span class="mx-pin-mark" title="Pinned">📌</span>' : ''}${m.edited_at && live ? '<span class="mx-edited">edited</span>' : ''}<time datetime="${esc(m.created_at || '')}" title="${esc(fullDate(m.created_at))}">${esc(L.fmtTime(m.created_at))}</time>${mine ? receiptHtml(m) : ''}</span>`;
        let html = '';
        if (group && !mine && f.first) html += `<div class="mx-sender" style="color:${L.colorFor(m.sender_id)}">${esc(nameOf(m.sender_id))}</div>`;
        html += `<div class="mx-line"><div class="${bubbleCls.join(' ')}" tabindex="0">${quoteHtml(m, parent)}${content}${meta}</div>` +
            `<button type="button" class="mx-more" data-act="menu" aria-label="Message actions" data-icon="chev"></button></div>`;
        if (m._state === 'failed') html += `<div class="mx-failed">Not sent${m._err ? ' — ' + esc(m._err) : ''} · <button type="button" data-act="retry">Retry</button> · <button type="button" data-act="discard">Delete</button></div>`;
        else if (m._state === 'uploading' && m._job) html += '<div class="mx-failed mx-up">Uploading… · <button type="button" data-act="cancel">Cancel</button></div>';
        html += '<div class="mx-reacts" hidden></div>';
        el.innerHTML = html;

        paintReactionsInto(el, m);
        if (sp.kind === 'file') hydrateFile(el, m, sp);
        else if (sp.kind === 'text' && m.id != null) { const u = L.firstUrl(sp.text); if (u) attachPreview(el.querySelector('.mx-bubble'), u); }
        return el;
    }
    function fullDate(iso) {
        try { return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }); }
        catch (e) { return ''; }
    }
    function quoteHtml(m, parent) {
        if (m.reply_to_id == null) return '';
        if (!parent) fetchParent(m.reply_to_id);
        const who = parent ? (parent._missing ? '' : nameOf(parent.sender_id)) : '…';
        const txt = parent ? L.previewText(parent.body) : 'Loading…';
        return `<button type="button" class="mx-quote" data-act="quote" data-target="${esc(sid(m.reply_to_id))}" title="Go to the original message"><b>${esc(who)}</b><span>${esc(txt)}</span></button>`;
    }
    function progressHtml(m) {
        if (m._state !== 'uploading') return '';
        return `<div class="mx-progress" role="progressbar" aria-label="Uploading"><i style="width:${Math.round((m._progress || 0) * 100)}%"></i></div>`;
    }
    function fileHtml(m, sp) {
        const local = m._localUrl ? ` src="${esc(m._localUrl)}"` : '';
        if (sp.isImage) return `<button type="button" class="mx-img" data-act="view" aria-label="${esc('Open image ' + sp.name)}"><img alt="${esc(sp.name)}"${local}></button>${progressHtml(m)}`;
        if (sp.isAudio) return `<div class="mx-audio"><audio controls preload="metadata"${local} aria-label="Voice message"></audio></div>${progressHtml(m)}`;
        if (sp.isVideo) return `<video class="mx-video" controls preload="metadata" playsinline${local}></video>${progressHtml(m)}`;
        const dot = sp.name.lastIndexOf('.');
        const ext = dot > 0 ? sp.name.slice(dot + 1, dot + 5) : 'file';
        return `<button type="button" class="mx-file" data-act="download" aria-label="${esc('Download ' + sp.name)}"><span class="ext">${esc(ext)}</span><span><span class="nm">${esc(sp.name)}</span><span class="sz">${esc(L.fmtBytes(sp.size) || 'File')}${m.id != null ? ' · Download' : ''}</span></span></button>${progressHtml(m)}`;
    }
    function hydrateFile(el, m, sp) {
        if (m._localUrl) {
            const img = el.querySelector('.mx-img img');
            if (img) img.addEventListener('load', keepBottom, { once: true });
            if (m.id != null) swapToStored(el, m, sp);
            return;
        }
        if (m.id == null) return;
        const media = el.querySelector('.mx-img img, audio, video');
        if (!media) return;
        getFileUrl(sp.path).then(u => {
            if (media.tagName === 'IMG') media.addEventListener('load', keepBottom, { once: true });
            media.src = u;
        }).catch(() => {
            const b = el.querySelector('.mx-img');
            if (b) { b.classList.add('broken'); b.textContent = 'Image unavailable'; b.removeAttribute('data-act'); }
        });
    }
    // Once sent, show the stored copy and let the browser free the local one.
    function swapToStored(el, m, sp) {
        const media = el.querySelector('.mx-img img, audio, video');
        getFileUrl(sp.path).then(u => {
            const release = () => { if (m._localUrl) { URL.revokeObjectURL(m._localUrl); delete m._localUrl; } };
            if (!media) return release();
            if (media.tagName === 'IMG') { const pre = new Image(); pre.onload = () => { media.src = u; release(); }; pre.src = u; }
            else if (media.paused && !media.currentTime) { media.src = u; release(); }   // never cut off playback
        }).catch(() => { /* keep showing the local copy */ });
    }
    function keepBottom() { if (S.stickBottom) { const sc = $('mx-scroll'); sc.scrollTop = sc.scrollHeight; } }
    const signed = new Map();
    async function getFileUrl(path, download) {
        const k = path + (download ? '#dl' : '');
        const hit = signed.get(k);
        if (hit && Date.now() - hit.at < 45 * 60 * 1000) return hit.url;
        const { data, error } = await S.sb.storage.from('chat-files').createSignedUrl(path, 3600, download ? { download } : undefined);
        if (error || !data || !data.signedUrl) throw error || new Error('Could not sign the file');
        signed.set(k, { at: Date.now(), url: data.signedUrl });
        return data.signedUrl;
    }
    const previews = new Map();
    function attachPreview(bubble, url) {
        if (!bubble) return;
        let p = previews.get(url);
        if (!p) {
            p = fetch('/api/linkpreview?url=' + encodeURIComponent(url)).then(r => (r.ok ? r.json() : null)).catch(() => null);
            previews.set(url, p);
        }
        p.then(d => {
            if (!d || (!d.title && !d.description) || !bubble.isConnected || bubble.querySelector('.mx-lp')) return;
            const a = document.createElement('a');
            a.className = 'mx-lp';
            a.href = /^https?:\/\//i.test(d.url || '') ? d.url : url;
            a.target = '_blank'; a.rel = 'noopener noreferrer';
            if (d.image && /^https?:\/\//i.test(d.image)) {
                const img = document.createElement('img');
                img.src = d.image; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
                img.onerror = () => img.remove();
                a.appendChild(img);
            }
            const s = document.createElement('span');
            const b = document.createElement('b'); b.textContent = d.title || d.host || url; s.appendChild(b);
            if (d.description) { const sm = document.createElement('small'); sm.textContent = d.description; s.appendChild(sm); }
            const em = document.createElement('em'); em.textContent = d.host || ''; s.appendChild(em);
            a.appendChild(s);
            bubble.insertBefore(a, bubble.querySelector('.mx-meta'));
            keepBottom();
        });
    }
    function paintReactions(msgId) {
        const view = S.view;
        if (!view) return;
        const m = view.byId.get(sid(msgId));
        const hit = m && view.els.get(mKey(m));
        if (hit) paintReactionsInto(hit.el, m);
    }
    function paintReactionsInto(el, m) {
        const box = el.querySelector('.mx-reacts');
        if (!box) return;
        const list = m.id != null ? (S.reactions.get(sid(m.id)) || []) : [];
        if (!list.length || L.parseSpecial(m.body).kind === 'deleted') { box.hidden = true; box.innerHTML = ''; return; }
        const by = new Map();
        list.forEach(r => { if (!by.has(r.emoji)) by.set(r.emoji, []); by.get(r.emoji).push(r.user_id); });
        box.innerHTML = [...by].map(([emoji, users]) => `<button type="button" class="mx-react${users.indexOf(S.me.id) !== -1 ? ' mine' : ''}" data-act="react" data-emoji="${esc(emoji)}" title="${esc(users.map(u => (u === S.me.id ? 'You' : fullName(u) || 'Someone')).join(', '))}" aria-label="${esc(emoji + ' ' + users.length)}">${esc(emoji)}<b>${users.length}</b></button>`).join('');
        box.hidden = false;
    }
    function seenInfo(view) {
        const t = S.threads.get(view.key);
        if (!t || t.kind !== 'group') return null;
        let m = null;
        for (let i = view.list.length - 1; i >= 0; i--) {
            const x = view.list[i];
            if (x.sender_id === S.me.id && x.id != null && L.parseSpecial(x.body).kind !== 'call') { m = x; break; }
        }
        if (!m) return null;
        const members = S.members.get(t.id) || [];
        const seen = L.seenBy(members, S.me.id, m.created_at);
        if (!seen.length) return null;
        const others = members.filter(x => x.user_id !== S.me.id).length;
        const el = document.createElement('div');
        el.className = 'mx-seen';
        el.textContent = seen.length >= others ? 'Seen by everyone' : `Seen by ${seen.length}`;
        el.title = seen.map(id => fullName(id) || 'Someone').join(', ');
        return { key: mKey(m), el };
    }
    function mentionNames() {
        if (!mentionNames.cache || mentionNames.size !== S.people.size) {
            mentionNames.cache = [...S.people.values()].map(p => p.full_name).filter(Boolean);
            mentionNames.size = S.people.size;
        }
        return mentionNames.cache;
    }
    function updateNewPill() {
        const view = S.view, pill = $('mx-newpill');
        if (!view) { pill.hidden = true; return; }
        const sc = $('mx-scroll');
        const far = sc.scrollHeight - sc.scrollTop - sc.clientHeight > 700;
        if (view.detached) { pill.textContent = 'Jump to latest ↓'; pill.hidden = false; }
        else if (view.unseen > 0 && !isNearBottom()) { pill.textContent = `↓ ${view.unseen} new message${view.unseen === 1 ? '' : 's'}`; pill.hidden = false; }
        else if (far) { pill.textContent = 'Latest ↓'; pill.hidden = false; }
        else pill.hidden = true;
    }
    function checkSentinel() {
        const view = S.view;
        if (!view || !view.ready || !view.hasOlder || view.loading) return;
        const r = $('mx-sentinel').getBoundingClientRect(), root = $('mx-scroll').getBoundingClientRect();
        if (r.bottom >= root.top - 300) loadOlder();
    }

    // --------------------------------------------------------------- realtime
    function subscribeMain() {
        const me = S.me.id;
        try {
            const ch = S.sb.channel('mx:' + me + ':' + (++S.gen))
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `recipient_id=eq.${me}` }, p => onInsert(p.new))
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `sender_id=eq.${me}` }, p => onInsert(p.new))   // my other devices
                .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `recipient_id=eq.${me}` }, p => onUpdate(p.new))
                .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `sender_id=eq.${me}` }, p => onUpdate(p.new))
                .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, p => onDelete(p.old))
                .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, p => onReaction(p))
                .subscribe(onMainStatus);
            S.ch.main = ch;
        } catch (e) { setConn('reconnecting'); }
    }
    // Groups, membership and group messages. Created only once the messenger
    // tables are known to exist, so a missing table never breaks direct messages.
    function subscribeGroups() {
        if (S.features.groups !== true) return;
        const ids = [...S.groups.keys()].sort();
        const sig = ids.join(',');
        if (S.ch.groups && S.ch.groupSig === sig) return;
        if (S.ch.groups) { try { S.sb.removeChannel(S.ch.groups); } catch (e) { /* gone */ } }
        S.ch.groupSig = sig;
        const me = S.me.id;
        try {
            const ch = S.sb.channel('mx-g:' + me + ':' + (++S.gen))
                .on('postgres_changes', { event: '*', schema: 'public', table: 'conversation_members', filter: `user_id=eq.${me}` }, onMyMembership)
                .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, p => onConversation(p.new));
            if (ids.length) {
                const filter = ids.length <= 100 ? { filter: `conversation_id=in.(${ids.join(',')})` } : {};
                ch.on('postgres_changes', Object.assign({ event: 'INSERT', schema: 'public', table: 'messages' }, filter), p => { if (p.new && p.new.conversation_id) onInsert(p.new); })
                  .on('postgres_changes', Object.assign({ event: 'UPDATE', schema: 'public', table: 'messages' }, filter), p => { if (p.new && p.new.conversation_id) onUpdate(p.new); });
            }
            ch.subscribe((status) => { if (status === 'SUBSCRIBED' && ch.__wasDown) resync(); if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') ch.__wasDown = true; });
            S.ch.groups = ch;
        } catch (e) { S.ch.groups = null; }
    }
    function onMyMembership(p) {
        // My own read marker and mute switch come back here too; only a real membership change reloads.
        if (p.eventType === 'UPDATE') {
            const n = p.new || {}, o = p.old || {};
            const g = S.groups.get(n.conversation_id);
            if (g) {
                const roleChanged = n.role && g.member.role !== n.role;
                Object.assign(g.member, { last_read_at: n.last_read_at, muted: !!n.muted, role: n.role || g.member.role });
                recomputeUnread(); renderSidebar();
                if (!roleChanged && o.conversation_id) return;
                if (!roleChanged) return;
            }
        }
        loadGroupsSoon();
    }
    function onConversation(c) {
        if (!c || !S.groups.has(c.id)) return;
        if (c.archived_at) { loadGroupsSoon(); return; }
        const g = S.groups.get(c.id);
        Object.assign(g, c, { member: g.member });
        renderSidebar();
        if (activeThread() && activeThread().id === c.id) paintHeader();
    }
    function onInsert(m) {
        if (!m || m.id == null || !S.me) return;
        if (m.conversation_id && !S.groups.has(m.conversation_id)) { loadGroupsSoon(); return; }
        if (!m.conversation_id && m.sender_id !== S.me.id && m.recipient_id !== S.me.id) return;
        const key = keyOfMessage(m);
        const t = threadFor(key);
        if (t.kind === 'dm' && !person(t.id)) ensurePerson(t.id).then(renderSidebar);
        const view = S.cache.get(key);
        let added = true;
        if (view && !view.detached) {
            added = upsertMessage(view, m) === 'added';
            sortView(view);
            if (view === S.view) {
                const stick = S.stickBottom || m.sender_id === S.me.id;
                if (added && !stick) view.unseen++;
                renderView(stick ? { toBottom: true } : { keep: true });
            }
        } else if (view && view.detached && view === S.view) updateNewPill();
        if (!t.last || Number(m.id) >= Number(t.last.id || 0)) t.last = { id: m.id, sender_id: m.sender_id, body: m.body, created_at: m.created_at };
        if (t.localLast && t.localLast.client_id && t.localLast.client_id === m.client_id) t.localLast = null;
        const sp = L.parseSpecial(m.body);
        if (sp.kind === 'call') { loadCallsSoon(); if (key === S.activeKey) refreshCallBar(); }
        if (m.sender_id !== S.me.id) {
            S.typing.delete(m.sender_id);
            if (key === S.activeKey) paintHeader();
            const reading = key === S.activeKey && isReadingNow();
            const counts = !m.read_at && m.body !== L.DELETED && !S.counted.has(sid(m.id));
            if (reading) scheduleMarkRead();
            else if (counts && added) {
                S.counted.add(sid(m.id));
                if (S.counted.size > 5000) S.counted.clear();
                t.unread = (t.unread || 0) + 1;
                if (sp.kind !== 'call') notifyIncoming(t, m);
            }
        }
        recomputeUnread();
        renderSidebar();
    }
    function onUpdate(row) {
        if (!row || row.id == null || !S.me) return;
        const key = keyOfMessage(row);
        const view = S.cache.get(key);
        if (view) {
            const m = view.byId.get(sid(row.id));
            if (m) {
                const pinChanged = !!m.pinned_at !== !!row.pinned_at;
                Object.assign(m, row);
                if (view === S.view) { renderView({ keep: true }); if (pinChanged || row.body === L.DELETED) loadPinned(); }
            }
        }
        const t = S.threads.get(key);
        if (t && t.last && sid(t.last.id) === sid(row.id)) { t.last = Object.assign({}, t.last, { body: row.body }); renderSidebar(); }
        if (S.parents.has(sid(row.id))) S.parents.set(sid(row.id), row);
    }
    function onDelete(old) {
        if (!old || old.id == null) return;
        const id = sid(old.id);
        S.cache.forEach((view, key) => {
            const m = view.byId.get(id);
            if (!m) return;
            view.list = view.list.filter(x => x !== m);
            view.byId.delete(id);
            if (m.client_id) view.byClient.delete(m.client_id);
            view.els.delete(mKey(m));
            if (view === S.view) renderView({ keep: true });
            const t = S.threads.get(key);
            if (t && t.last && sid(t.last.id) === id) reloadInboxSoon();
        });
    }
    const reloadInboxSoon = debounce(() => loadInbox(), 800);
    function onReaction(p) {
        if (p.eventType === 'INSERT' && p.new) {
            const r = p.new, k = sid(r.message_id);
            S.reactionMsg.set(sid(r.id), k);
            const list = (S.reactions.get(k) || []).filter(x => sid(x.id) !== sid(r.id)
                && !(String(x.id).indexOf('tmp') === 0 && x.user_id === r.user_id && x.emoji === r.emoji));
            list.push(r);
            S.reactions.set(k, list);
            paintReactions(k);
        } else if (p.eventType === 'DELETE' && p.old) {
            // Deletes carry only the reaction id: find its message from what was loaded.
            const rid = sid(p.old.id), k = p.old.message_id != null ? sid(p.old.message_id) : S.reactionMsg.get(rid);
            if (!k) return;
            S.reactions.set(k, (S.reactions.get(k) || []).filter(x => sid(x.id) !== rid));
            S.reactionMsg.delete(rid);
            paintReactions(k);
        }
    }
    function onMainStatus(status) {
        if (status === 'SUBSCRIBED') {
            if (S.wasLive === false) resync();
            S.wasLive = true;
            setConn(navigator.onLine === false ? 'offline' : 'live');
            flushOutbox();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            S.wasLive = false;                           // the next SUBSCRIBED re-syncs what was missed
            setConn(navigator.onLine === false ? 'offline' : 'reconnecting');
        }
    }

    // ------------------------------------------------------------- read state
    function isReadingNow() {
        return document.visibilityState === 'visible' && !!S.view && S.view.ready && !S.view.detached && isNearBottom();
    }
    const scheduleMarkRead = debounce(markReadNow, 350);
    async function markReadNow() {
        const t = activeThread();
        if (!t || !S.view || !isReadingNow()) return;
        const now = new Date().toISOString();
        if (t.kind === 'dm') {
            const unreadHere = S.view.list.some(m => m.sender_id === t.id && !m.read_at && m.id != null);
            if (!unreadHere && !t.unread) return;
            S.view.list.forEach(m => { if (m.sender_id === t.id && !m.read_at) m.read_at = now; });
            t.unread = 0;
            recomputeUnread(); renderSidebar();
            try { await S.sb.from('messages').update({ read_at: now }).eq('recipient_id', S.me.id).eq('sender_id', t.id).is('read_at', null); }
            catch (e) { /* retried on the next visit */ }
        } else {
            const g = groupOf(t);
            if (!g) return;
            // The server counts unread by comparing this marker with its own created_at: use its clock, not this one.
            const at = L.readMarker(S.view.list, now);
            const cur = g.member.last_read_at ? timeOf(g.member.last_read_at) : 0;
            if (!t.unread && cur >= timeOf(at)) return;
            t.unread = 0;
            recomputeUnread(); renderSidebar();
            if (cur >= timeOf(at)) return;                        // already at or past it: never move the marker back
            g.member.last_read_at = at;
            const mine = (S.members.get(t.id) || []).find(x => x.user_id === S.me.id);
            if (mine) mine.last_read_at = at;
            try { await S.sb.from('conversation_members').update({ last_read_at: at }).eq('conversation_id', t.id).eq('user_id', S.me.id); }
            catch (e) { /* retried on the next visit */ }
        }
    }
    function recomputeUnread() {
        let total = 0, chats = 0;
        S.threads.forEach(t => { if (t.unread > 0 && !isMuted(t)) { total += t.unread; chats++; } });
        const n = $('mx-tab-chats-n');
        n.hidden = !chats;
        n.textContent = chats > 99 ? '99+' : String(chats);
        document.title = (total ? `(${total > 99 ? '99+' : total}) ` : '') + 'Messenger · WorkSuite';
        try { if (window.WSShell && WSShell.setUnread) WSShell.setUnread(total); } catch (e) { /* shell optional */ }
    }
    function notifyIncoming(t, m) {
        if (isMuted(t)) return;
        const title = t.kind === 'group' ? `${threadName(t)} · ${firstName(m.sender_id)}` : nameOf(m.sender_id);
        const body = L.previewText(m.body);
        const tag = t.kind === 'group' ? 'grp-' + t.id : 'dm-' + m.sender_id;
        if (document.visibilityState === 'visible') {
            toastCard({ avatar: t.kind === 'group' ? threadAvatar(t) : personAvatar(m.sender_id), title, text: body, onClick: () => openThread(t.key) });
            ping();
        } else if ('Notification' in window && Notification.permission === 'granted') {
            try {
                const n = new Notification(title, { body, tag, icon: '/icon-192.png', renotify: true });
                n.onclick = () => { window.focus(); openThread(t.key); n.close(); };
            } catch (e) { /* some browsers only allow service-worker notifications */ }
        }
    }
    function ping() {
        const ctx = S.audioCtx;
        if (!ctx || ctx.state !== 'running') return;
        try {
            const o = ctx.createOscillator(), g = ctx.createGain(), t0 = ctx.currentTime;
            o.type = 'sine';
            o.frequency.setValueAtTime(880, t0);
            o.frequency.exponentialRampToValueAtTime(1320, t0 + 0.08);
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(0.1, t0 + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26);
            o.connect(g).connect(ctx.destination);
            o.start(t0); o.stop(t0 + 0.28);
        } catch (e) { /* sound is optional */ }
    }
    // Browsers only allow audio after the person has interacted with the page.
    function unlockAudio() {
        if (S.audioCtx) { if (S.audioCtx.state === 'suspended') S.audioCtx.resume().catch(() => {}); return; }
        try { const C = window.AudioContext || window.webkitAudioContext; if (C) S.audioCtx = new C(); } catch (e) { /* no audio */ }
    }

    // ---------------------------------------------------------------- sending
    function newLocalMessage(t, body, extra) {
        return Object.assign({
            id: null, client_id: uuid(), sender_id: S.me.id, body, created_at: new Date().toISOString(), read_at: null, _state: 'pending',
            recipient_id: t.kind === 'dm' ? t.id : null, conversation_id: t.kind === 'group' ? t.id : null,
        }, extra || {});
    }
    function addLocal(t, m) {
        const view = S.cache.get(t.key);
        if (view) {
            if (view.detached && view === S.view) { loadLatest(view).then(() => { upsertMessage(view, m); sortView(view); renderView({ toBottom: true }); }); }
            else { upsertMessage(view, m); sortView(view); if (view === S.view) renderView({ toBottom: true }); }
        }
        t.localLast = m;
        rememberUnsent(t.key, m);
        renderSidebar();
    }
    function sendFromComposer() {
        const t = activeThread();
        if (!t) return;
        const input = $('mx-input');
        const text = input.value.trim();
        if (!text) return;
        closeMentions(); closeEmoji();
        if (S.editing) {
            const m = S.editing;
            resetCompose(); input.value = ''; autosize(); updateSendButton();
            saveEdit(m, text);
            return;
        }
        const extra = {};
        if (S.replyTo && S.replyTo.id != null) extra.reply_to_id = S.replyTo.id;
        const mentions = L.mentionIdsIn(text, mentionCandidates(t));
        if (mentions.length) extra.mentions = mentions;
        const m = newLocalMessage(t, text, extra);
        resetCompose(); input.value = ''; autosize(); updateSendButton();
        S.drafts.delete(t.key);
        addLocal(t, m);
        enqueue({ m, key: t.key });
    }
    function enqueue(job) { job.m._job = job; S.outbox.push(job); flushOutbox(); }
    async function flushOutbox() {
        if (S.flushing || !S.outbox.length) return;
        S.flushing = true;
        clearTimeout(S.retryTimer);
        try {
            while (S.outbox.length) {
                const job = S.outbox[0];
                const res = await runJob(job);
                if (res === 'later') { scheduleRetry(); break; }
                S.outbox.shift();
                S.retryStep = 0;
            }
        } finally { S.flushing = false; }
    }
    function scheduleRetry() {
        const waits = [2000, 5000, 10000, 20000, 30000];
        const ms = waits[Math.min(S.retryStep++, waits.length - 1)];
        clearTimeout(S.retryTimer);
        S.retryTimer = setTimeout(flushOutbox, ms);
    }
    async function runJob(job) {
        const m = job.m;
        S.currentJob = job;
        try {
            if (job.file && !job.uploaded) {
                m._state = 'uploading'; m._progress = 0; repaintMessage(m);
                await xhrUpload(job, (p) => { m._progress = p; paintProgress(m); });
                job.uploaded = true;
            }
            if (job.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });
            m._state = 'pending'; repaintMessage(m);
            let saved;
            m._inFlight = true;
            try { saved = await insertMessage(m); } finally { m._inFlight = false; }
            reconcile(job, saved);
            return 'ok';
        } catch (err) {
            if ((err && err.cancelled) || job.cancelled) { removeLocal(m); return 'cancelled'; }
            if (isTransient(err)) { m._state = 'pending'; repaintMessage(m); return 'later'; }
            console.warn('[messenger] send failed', err);
            m._state = 'failed'; m._err = friendly(err);
            repaintMessage(m);
            return 'failed';
        } finally { S.currentJob = null; }
    }
    async function insertMessage(m) {
        const row = { sender_id: m.sender_id, body: m.body };
        if (m.conversation_id) row.conversation_id = m.conversation_id; else row.recipient_id = m.recipient_id;
        if (m.reply_to_id != null) row.reply_to_id = m.reply_to_id;
        if (m.mentions && m.mentions.length) row.mentions = m.mentions;
        if (S.features.clientId !== false) row.client_id = m.client_id;
        const send = () => timed(S.sb.from('messages').insert(row).select('*').single(), INSERT_TIMEOUT_MS);
        let r = await send();
        if (r.error && L.isMissingColumn(r.error)) {
            // Older schema (PGRST204 or 42703): first drop client_id, then the messenger columns.
            if (row.client_id) { S.features.clientId = false; delete row.client_id; r = await send(); }
            if (r.error && L.isMissingColumn(r.error) && (row.reply_to_id != null || row.mentions)) {
                delete row.reply_to_id; delete row.mentions;
                r = await send();
            }
        }
        if (r.error && String(r.error.code) === '23505' && row.client_id) {
            // An earlier (timed-out or dropped) attempt reached the database: use that row.
            const got = await timed(S.sb.from('messages').select('*').eq('sender_id', S.me.id).eq('client_id', row.client_id).maybeSingle(), INSERT_TIMEOUT_MS);
            if (got.data) return got.data;
        }
        if (r.error) throw r.error;
        if (r.data && S.features.clientId === null) S.features.clientId = 'client_id' in r.data;
        return r.data;
    }
    function reconcile(job, saved) {
        const m = job.m;
        const row = Object.assign({}, saved);
        if (!row.client_id) row.client_id = m.client_id;
        const view = S.cache.get(job.key);
        if (view && view.byClient.get(m.client_id)) {
            upsertMessage(view, row);
            sortView(view);
            if (view === S.view) renderView({ keep: !S.stickBottom });
        } else { Object.assign(m, row); delete m._state; delete m._err; }
        forgetUnsent(m);
        job.file = null;                                   // the bytes are in Storage now; do not hold them
        const t = S.threads.get(job.key);
        if (t) {
            if (t.localLast === m) t.localLast = null;
            if (!t.last || Number(saved.id) >= Number(t.last.id || 0)) t.last = { id: saved.id, sender_id: saved.sender_id, body: saved.body, created_at: saved.created_at };
        }
        renderSidebar();
        try { if (window.WSPush && typeof WSPush.send === 'function') WSPush.send(S.sb, { action: 'message', message_id: saved.id }); } catch (e) { /* push is best effort */ }
    }
    function repaintMessage(m) {
        if (S.view && S.view.byClient.get(m.client_id) === m) renderView({ keep: true });
        renderSidebar();
    }
    function paintProgress(m) {
        const hit = S.view && S.view.els.get(mKey(m));
        const bar = hit && hit.el.querySelector('.mx-progress i');
        if (bar) bar.style.width = Math.round((m._progress || 0) * 100) + '%';
    }
    function retryMessage(m) {
        if (!m || !m._job || m._state !== 'failed') return;
        m._state = 'pending'; m._err = null;
        repaintMessage(m);
        S.outbox.push(m._job);
        flushOutbox();
    }
    function discardMessage(m) {
        if (!m || m.id != null) return;
        S.outbox = S.outbox.filter(j => j !== m._job);
        removeLocal(m);
    }
    // Stop a file that has not been sent yet: queued, or uploading right now.
    function cancelUpload(m) {
        const job = m && m._job;
        if (!job || m.id != null || m._state !== 'uploading') return;
        if (S.currentJob === job) { job.cancelled = true; if (S.uploadXhr) S.uploadXhr.abort(); return; }
        S.outbox = S.outbox.filter(j => j !== job);
        removeLocal(m);
    }
    function removeLocal(m) {
        const job = m._job;
        S.cache.forEach(view => {
            if (view.byClient.get(m.client_id) !== m) return;
            view.list = view.list.filter(x => x !== m);
            view.byClient.delete(m.client_id);
            view.els.delete(mKey(m));
            if (view === S.view) renderView({ keep: true });
        });
        S.threads.forEach(t => { if (t.localLast === m) t.localLast = null; });
        forgetUnsent(m);
        if (job && job.uploaded && job.path) S.sb.storage.from('chat-files').remove([job.path]).catch(() => {});
        if (m._localUrl) URL.revokeObjectURL(m._localUrl);
        renderSidebar();
    }
    async function saveEdit(m, text) {
        if (!m || m.id == null || text === m.body) return;
        const prev = { body: m.body, edited_at: m.edited_at };
        m.body = text; m.edited_at = new Date().toISOString();
        renderView({ keep: true });
        const { error } = await S.sb.from('messages').update({ body: text }).eq('id', m.id);
        if (error) { Object.assign(m, prev); renderView({ keep: true }); toast('Could not edit: ' + friendly(error), 'bad'); return; }
        const t = S.threads.get(keyOfMessage(m));
        if (t && t.last && sid(t.last.id) === sid(m.id)) { t.last.body = text; renderSidebar(); }
    }
    async function deleteMessage(m) {
        const ok = await confirmBox({ title: 'Delete this message?', message: 'It will be removed for everyone in this chat.', ok: 'Delete', danger: true });
        if (!ok) return;
        const sp = L.parseSpecial(m.body);
        const prev = m.body;
        m.body = L.DELETED;
        renderView({ keep: true });
        const { error } = await S.sb.from('messages').update({ body: L.DELETED }).eq('id', m.id);
        if (error) { m.body = prev; renderView({ keep: true }); toast('Could not delete: ' + friendly(error), 'bad'); return; }
        if (sp.kind === 'file' && m.sender_id === S.me.id) S.sb.storage.from('chat-files').remove([sp.path]).catch(() => {});
        const t = S.threads.get(keyOfMessage(m));
        if (t && t.last && sid(t.last.id) === sid(m.id)) { t.last.body = L.DELETED; renderSidebar(); }
        if (m.pinned_at) loadPinned();
    }
    async function togglePin(m) {
        const pin = !m.pinned_at;
        const at = pin ? new Date().toISOString() : null;
        const { error } = await S.sb.from('messages').update({ pinned_at: at }).eq('id', m.id);
        if (error) {
            if (L.isMissingColumn(error)) { S.features.pins = false; toast('Pinning needs the messenger migration.', 'bad'); }
            else toast((pin ? 'Could not pin: ' : 'Could not unpin: ') + friendly(error), 'bad');
            return;
        }
        m.pinned_at = at;
        renderView({ keep: true });
        loadPinned();
        toast(pin ? 'Pinned for everyone in this chat.' : 'Unpinned.', 'ok');
    }
    async function clearChat() {
        const t = activeThread();
        if (!t || t.kind !== 'dm') return;
        const who = threadName(t);
        const ok = await confirmBox({ title: 'Clear this chat?', message: `Every message, photo and file between you and ${who} will be deleted for both of you. This cannot be undone.`, ok: 'Clear chat', danger: true });
        if (!ok) return;
        try {
            const { data: files } = await threadQuery(t, 'body, sender_id, recipient_id, conversation_id').like('body', '\\_\\_FILE\\_\\_::%');
            const mine = (files || []).filter(r => r.sender_id === S.me.id && belongsTo(t, r)).map(r => L.parseSpecial(r.body)).filter(x => x.kind === 'file').map(x => x.path);
            if (mine.length) await S.sb.storage.from('chat-files').remove(mine);
        } catch (e) { /* the messages still go */ }
        const { error } = await S.sb.from('messages').delete()
            .or(`and(sender_id.eq.${S.me.id},recipient_id.eq.${t.id}),and(sender_id.eq.${t.id},recipient_id.eq.${S.me.id})`);
        if (error) { toast('Could not clear the chat: ' + friendly(error), 'bad'); return; }
        const view = S.cache.get(t.key);
        if (view) { resetView(view); view.els.clear(); view.hasOlder = false; renderView({ toBottom: true }); }
        t.last = null; t.localLast = null; t.unread = 0;
        recomputeUnread(); renderSidebar(); loadPinned();
        toast(`Chat with ${who} cleared for both of you.`, 'ok');
    }

    // ------------------------------------------------------------------ files
    const EXT_MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
        heic: 'image/heic', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav',
        doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        csv: 'text/csv', txt: 'text/plain', zip: 'application/zip' };
    function mimeOf(file) {
        if (file.type) return file.type.split(';')[0];
        const ext = String(file.name || '').split('.').pop().toLowerCase();
        return EXT_MIME[ext] || 'application/octet-stream';
    }
    function queueFiles(files, key) {
        const t = key ? S.threads.get(key) : activeThread();
        if (!t) return toast('Open a conversation first, then attach files.');
        let list = Array.from(files || []).filter(Boolean);
        if (!list.length) return;
        if (list.length > MAX_FILES) { toast(`Up to ${MAX_FILES} files at a time — sending the first ${MAX_FILES}.`); list = list.slice(0, MAX_FILES); }
        const reply = S.replyTo && S.replyTo.id != null ? S.replyTo.id : null;
        list.forEach((file, i) => {
            if (file.size > MAX_FILE_BYTES) return toast(`${file.name} is over 25 MB and was not sent.`, 'bad');
            if (!file.size) return toast(`${file.name} is empty and was not sent.`, 'bad');
            const mime = mimeOf(file), name = file.name || 'file';
            const path = L.storagePath(S.me.id, name);
            const m = newLocalMessage(t, L.fileBody(path, mime, file.size, name), reply && i === 0 ? { reply_to_id: reply } : {});
            m._state = 'uploading'; m._progress = 0;
            if (/^(image|audio|video)\//.test(mime) && mime !== 'image/heic') m._localUrl = URL.createObjectURL(file);
            const job = { m, key: t.key, file, path, mime };
            m._job = job;                                     // before the first paint, so Cancel shows at once
            addLocal(t, m);
            enqueue(job);
        });
        if (reply) resetCompose();
    }
    async function xhrUpload(job, onProgress) {
        const { data } = await S.sb.auth.getSession();
        const token = data && data.session && data.session.access_token;
        if (!token) throw Object.assign(new Error('Your session expired — reload the page'), { transient: false });
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const url = `${S.cfg.supabaseUrl}/storage/v1/object/chat-files/${job.path.split('/').map(encodeURIComponent).join('/')}`;
            xhr.open('POST', url);
            xhr.setRequestHeader('Authorization', 'Bearer ' + token);
            xhr.setRequestHeader('apikey', S.cfg.supabaseAnonKey);
            xhr.setRequestHeader('x-upsert', 'false');
            xhr.setRequestHeader('Content-Type', job.mime || 'application/octet-stream');
            xhr.setRequestHeader('cache-control', 'max-age=3600');
            xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) return resolve();
                const text = xhr.responseText || '';
                if (xhr.status === 409 || /duplicate|already exists/i.test(text)) return resolve();   // an earlier attempt got there
                let msg = 'Upload failed';
                try { const j = JSON.parse(text); msg = j.message || j.error || msg; } catch (e) { /* plain text */ }
                if (xhr.status === 413 || /too large|exceeded/i.test(msg)) msg = 'The file is too large';
                reject(Object.assign(new Error(msg), { status: xhr.status, transient: xhr.status >= 500 || xhr.status === 429 || xhr.status === 401 }));
            };
            xhr.onerror = () => reject(Object.assign(new Error('Network error while uploading'), { transient: true }));
            xhr.ontimeout = () => reject(Object.assign(new Error('Upload timed out'), { transient: true }));
            xhr.onabort = () => reject(job.cancelled ? Object.assign(new Error('Cancelled'), { cancelled: true })
                : Object.assign(new Error('Upload interrupted'), { transient: true }));        // went offline: try again later
            xhr.onloadend = () => { if (S.uploadXhr === xhr) S.uploadXhr = null; };
            xhr.timeout = L.uploadTimeoutMs(job.file.size);
            S.uploadXhr = xhr;
            xhr.send(job.file);
        });
    }
    async function downloadFile(m) {
        const sp = L.parseSpecial(m.body);
        if (sp.kind !== 'file') return;
        if (m.id == null && m._localUrl) return window.open(m._localUrl, '_blank', 'noopener');
        try {
            const u = await getFileUrl(sp.path, sp.name);
            const a = document.createElement('a');
            a.href = u; a.target = '_blank'; a.rel = 'noopener'; a.download = sp.name;
            document.body.appendChild(a); a.click(); a.remove();
        } catch (e) { toast('Could not download that file.', 'bad'); }
    }
    async function openImage(m) {
        const sp = L.parseSpecial(m.body);
        if (sp.kind !== 'file') return;
        let src = m._localUrl, dl = m._localUrl;
        try { if (!src) { src = await getFileUrl(sp.path); dl = await getFileUrl(sp.path, sp.name); } }
        catch (e) { return toast('Could not open that image.', 'bad'); }
        $('mx-lb-img').src = src;
        $('mx-lb-img').alt = sp.name;
        $('mx-lb-name').textContent = sp.name;
        $('mx-lb-dl').href = dl;
        $('mx-lb-dl').setAttribute('download', sp.name);
        S.restoreFocus = document.activeElement;
        $('mx-lightbox').hidden = false;
        $('mx-lb-x').focus();
    }
    function closeLightbox() {
        $('mx-lightbox').hidden = true;
        $('mx-lb-img').removeAttribute('src');
        restoreFocus();
    }

    // ------------------------------------------------------------ voice notes
    function voiceSupported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder); }
    async function startRecording() {
        const t = activeThread();
        if (!t || S.rec || S.recStarting) return;
        if (!voiceSupported()) return toast('Voice messages are not supported in this browser.', 'bad');
        S.recStarting = true;                 // a second click during the permission prompt must not open a second microphone
        let stream;
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
        catch (e) { S.recStarting = false; return toast(e && e.name === 'NotAllowedError' ? 'Allow microphone access to record a voice message.' : 'No microphone was found.', 'bad'); }
        S.recStarting = false;
        const stopTracks = () => stream.getTracks().forEach(x => x.stop());
        if (S.activeKey !== t.key || S.rec) { stopTracks(); return; }   // they moved to another chat while the browser asked
        const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
        const type = types.find(x => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(x)) || '';
        let rec;
        try { rec = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 48000 } : undefined); }
        catch (e) { stopTracks(); return toast('Could not start recording.', 'bad'); }
        const chunks = [];
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        S.rec = { rec, stream, chunks, key: t.key, started: Date.now(), send: false, type: (rec.mimeType || type || 'audio/webm') };
        rec.onstop = finishRecording;
        try { rec.start(1000); }
        catch (e) { S.rec = null; stopTracks(); return toast('Could not start recording.', 'bad'); }
        $('mx-compose-row').hidden = true;
        $('mx-rec').hidden = false;
        $('mx-rec-time').textContent = '0:00';
        S.rec.timer = setInterval(() => {
            const r = S.rec;
            if (!r) return;
            const s = (Date.now() - r.started) / 1000;
            $('mx-rec-time').textContent = L.fmtClock(s);
            if (s >= VOICE_MAX_S) stopRecording(true);
        }, 250);
        $('mx-rec-send').focus();
    }
    function stopRecording(send) {
        if (!S.rec) return;
        S.rec.send = !!send;
        clearInterval(S.rec.timer);
        try { if (S.rec.rec.state !== 'inactive') S.rec.rec.stop(); else finishRecording(); } catch (e) { finishRecording(); }
    }
    function finishRecording() {
        const r = S.rec;
        if (!r) return;
        S.rec = null;
        clearInterval(r.timer);
        r.stream.getTracks().forEach(x => x.stop());
        $('mx-rec').hidden = true;
        $('mx-compose-row').hidden = false;
        const secs = (Date.now() - r.started) / 1000;
        if (!r.send) return;
        if (secs < 1 || !r.chunks.length) return toast('Hold on a little longer — that recording was too short.');
        const base = r.type.split(';')[0] || 'audio/webm';
        const ext = /ogg/.test(base) ? 'ogg' : /mp4|aac|m4a/.test(base) ? 'm4a' : 'webm';
        const file = new File(r.chunks, `voice-note-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`, { type: base });
        queueFiles([file], r.key);
    }

    // --------------------------------------------------------------- composer
    function autosize() {
        const el = $('mx-input');
        el.style.height = 'auto';
        el.style.height = Math.min(160, el.scrollHeight) + 'px';
    }
    function updateSendButton() {
        const has = !!$('mx-input').value.trim() || !!S.editing;
        $('mx-send').hidden = !has && voiceSupported();
        $('mx-mic').hidden = has || !voiceSupported();
    }
    function resetCompose() {
        const wasEdit = !!S.editing;
        S.replyTo = null; S.editing = null;
        $('mx-ctx').hidden = true;
        if (wasEdit) { $('mx-input').value = ''; autosize(); }
        updateSendButton();
    }
    function showCtx(title, text) {
        $('mx-ctx-title').textContent = title;
        $('mx-ctx-text').textContent = text;
        $('mx-ctx').hidden = false;
    }
    function startReply(m) {
        S.editing = null; S.replyTo = m;
        showCtx('Replying to ' + (m.sender_id === S.me.id ? 'yourself' : fullName(m.sender_id) || 'message'), L.previewText(m.body));
        updateSendButton(); focusComposer();
    }
    function startEdit(m) {
        S.replyTo = null; S.editing = m;
        showCtx('Editing message', 'Press Esc to cancel');
        const input = $('mx-input');
        input.value = m.body;
        autosize(); updateSendButton();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }
    function editLastOwn() {
        const view = S.view;
        if (!view) return false;
        for (let i = view.list.length - 1; i >= 0; i--) {
            const m = view.list[i];
            if (m.sender_id === S.me.id && m.id != null) {
                if (L.parseSpecial(m.body).kind !== 'text') return false;
                startEdit(m);
                return true;
            }
        }
        return false;
    }
    function insertAtCaret(text) {
        const el = $('mx-input');
        const s = el.selectionStart == null ? el.value.length : el.selectionStart, e = el.selectionEnd == null ? s : el.selectionEnd;
        el.value = el.value.slice(0, s) + text + el.value.slice(e);
        const p = s + text.length;
        el.focus(); el.setSelectionRange(p, p);
        autosize(); updateSendButton();
    }

    function mentionCandidates(t) {
        t = t || activeThread();
        if (!t) return [];
        if (t.kind === 'group') return (S.members.get(t.id) || []).map(x => x.user_id).filter(id => id !== S.me.id).map(id => ({ id, name: fullName(id) })).filter(x => x.name);
        return [{ id: t.id, name: fullName(t.id) }].filter(x => x.name);
    }
    function updateMentions() {
        const el = $('mx-input');
        const q = L.mentionQuery(el.value, el.selectionStart);
        if (!q) return closeMentions();
        const term = q.term.toLowerCase();
        const items = mentionCandidates().filter(c => c.name.toLowerCase().indexOf(term) !== -1).slice(0, 8);
        if (!items.length) return closeMentions();
        S.mention = { start: q.start, items, on: Math.min(S.mention ? S.mention.on : 0, items.length - 1) };
        paintMentions();
    }
    function paintMentions() {
        const box = $('mx-mentions');
        box.innerHTML = S.mention.items.map((c, i) => `<button type="button" role="option" data-i="${i}" class="${i === S.mention.on ? 'on' : ''}" aria-selected="${i === S.mention.on}">${personAvatar(c.id, 'sm')}<span>${esc(c.name)}</span></button>`).join('');
        box.hidden = false;
    }
    function closeMentions() { S.mention = null; $('mx-mentions').hidden = true; }
    function pickMention(i) {
        if (!S.mention) return;
        const c = S.mention.items[i];
        if (!c) return;
        const el = $('mx-input');
        const before = el.value.slice(0, S.mention.start), after = el.value.slice(el.selectionStart);
        el.value = `${before}@${c.name} ${after}`;
        const p = before.length + c.name.length + 2;
        el.setSelectionRange(p, p); el.focus();
        closeMentions(); autosize(); updateSendButton();
    }

    function openEmoji(forMessage) {
        S.emojiFor = forMessage || null;
        const box = $('mx-emoji');
        if (!box.childElementCount) box.innerHTML = EMOJI.map(e => `<button type="button" data-emoji="${e}" aria-label="${e}">${e}</button>`).join('');
        box.hidden = false;
        const first = box.querySelector('button');
        if (first && forMessage) first.focus();
    }
    function closeEmoji() { $('mx-emoji').hidden = true; S.emojiFor = null; }

    // ------------------------------------------------------------------ menus
    // One floating menu for message actions, the header ⋮ and "new".
    function openMenu(html, x, y, onPick) {
        const menu = $('mx-menu');
        menu.innerHTML = html;
        S.menuPick = onPick;
        S.restoreFocus = document.activeElement;
        menu.hidden = false;
        const w = menu.offsetWidth, h = menu.offsetHeight;
        menu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, x)) + 'px';
        menu.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, y)) + 'px';
        const first = menu.querySelector('button');
        if (first) first.focus({ preventScroll: true });
    }
    function closeMenu(restore) {
        const menu = $('mx-menu');
        if (menu.hidden) return;
        menu.hidden = true;
        S.menuPick = null;
        document.querySelectorAll('.mx-more[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
        if (restore) restoreFocus();
    }
    function menuItems(items) {
        return items.map(([act, e, label, danger]) => `<button type="button" role="menuitem" data-act="${act}"${danger ? ' class="danger"' : ''}><span class="e" aria-hidden="true">${e}</span>${esc(label)}</button>`).join('');
    }
    function openMessageMenu(m, x, y) {
        if (!m) return;
        const sp = L.parseSpecial(m.body), mine = m.sender_id === S.me.id, stored = m.id != null, deleted = sp.kind === 'deleted';
        let quick = '';
        if (stored && !deleted) {
            const my = new Set((S.reactions.get(sid(m.id)) || []).filter(r => r.user_id === S.me.id).map(r => r.emoji));
            quick = `<div class="quick" role="group" aria-label="React">${QUICK.map(e => `<button type="button" data-react="${e}" class="${my.has(e) ? 'on' : ''}" aria-label="React ${e}">${e}</button>`).join('')}<button type="button" data-react="+" aria-label="More reactions">＋</button></div>`;
        }
        const items = [];
        if (m._state === 'failed') items.push(['retry', '↻', 'Retry sending'], ['discard', '🗑️', 'Delete', true]);
        if (m._state === 'uploading' && m._job) items.push(['cancel', '✕', 'Cancel upload', true]);
        if (stored && !deleted) items.push(['reply', '↩️', 'Reply']);
        if (sp.kind === 'text') items.push(['copy', '📋', 'Copy text']);
        if (stored && sp.kind === 'file') items.push(['download', '⬇️', 'Download']);
        if (stored && mine && sp.kind === 'text') items.push(['edit', '✏️', 'Edit']);
        if (stored && !deleted && S.features.pins !== false) items.push(['pin', '📌', m.pinned_at ? 'Unpin' : 'Pin for everyone']);
        if (stored && mine && !deleted) items.push(['delete', '🗑️', 'Delete for everyone', true]);
        if (!quick && !items.length) return;
        openMenu(quick + menuItems(items), x, y, (act, btn) => {
            if (btn && btn.dataset.react) {
                if (btn.dataset.react === '+') { openEmoji(m); return; }
                toggleReaction(m, btn.dataset.react);
                return;
            }
            if (act === 'retry') retryMessage(m);
            else if (act === 'discard') discardMessage(m);
            else if (act === 'cancel') cancelUpload(m);
            else if (act === 'reply') startReply(m);
            else if (act === 'copy') { const text = sp.text || ''; (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('Copied.', 'ok')).catch(() => toast('Copy is not available here.', 'bad')); }
            else if (act === 'download') downloadFile(m);
            else if (act === 'edit') startEdit(m);
            else if (act === 'pin') togglePin(m);
            else if (act === 'delete') deleteMessage(m);
        });
    }
    function messageForRow(row) {
        if (!row || !S.view) return null;
        const k = row.dataset.key;
        return S.view.list.find(m => mKey(m) === k) || null;
    }
    async function toggleReaction(m, emoji) {
        if (!m || m.id == null || !emoji) return;
        const k = sid(m.id), list = S.reactions.get(k) || [];
        const mine = list.find(r => r.user_id === S.me.id && r.emoji === emoji);
        if (mine) {
            S.reactions.set(k, list.filter(r => r !== mine));
            paintReactions(k);
            const q = S.sb.from('message_reactions').delete();
            const { error } = String(mine.id).indexOf('tmp') === 0
                ? await q.eq('message_id', m.id).eq('user_id', S.me.id).eq('emoji', emoji)
                : await q.eq('id', mine.id);
            if (error) { S.reactions.set(k, (S.reactions.get(k) || []).concat(mine)); paintReactions(k); toast('Could not remove the reaction.', 'bad'); }
            return;
        }
        const tmp = { id: 'tmp' + uuid(), message_id: m.id, user_id: S.me.id, emoji };
        S.reactions.set(k, list.concat(tmp));
        paintReactions(k);
        const { data, error } = await S.sb.from('message_reactions').insert({ message_id: m.id, user_id: S.me.id, emoji }).select('id, message_id, user_id, emoji').single();
        const now = S.reactions.get(k) || [];
        if (error && String(error.code) !== '23505') {
            S.reactions.set(k, now.filter(r => r !== tmp)); paintReactions(k);
            toast('Could not add the reaction.', 'bad');
            return;
        }
        const rest = now.filter(r => r !== tmp && !(data && sid(r.id) === sid(data.id)));
        S.reactions.set(k, data ? rest.concat(data) : rest.concat(tmp));
        if (data) S.reactionMsg.set(sid(data.id), k);
        paintReactions(k);
    }

    // ------------------------------------------------------------ pins & search
    async function loadPinned() {
        const t = activeThread(), bar = $('mx-pinned');
        if (!t || S.features.pins === false) { bar.hidden = true; return; }
        let r;
        try { r = await threadQuery(t, 'id, sender_id, recipient_id, conversation_id, body, created_at, pinned_at').not('pinned_at', 'is', null).order('pinned_at', { ascending: false }).limit(20); }
        catch (e) { return; }
        if (activeThread() !== t) return;
        if (r.error) { if (isSchemaMissing(r.error)) S.features.pins = false; bar.hidden = true; return; }
        S.pins = (r.data || []).filter(m => belongsTo(t, m) && m.pinned_at && m.body !== L.DELETED);
        if (!S.pins.length) { bar.hidden = true; return; }
        const top = S.pins[0];
        bar.innerHTML = `<span aria-hidden="true">📌</span><span class="txt"><b>${esc(firstName(top.sender_id))}:</b> ${esc(L.previewText(top.body))}</span><span class="n">${S.pins.length === 1 ? 'Pinned' : S.pins.length + ' pinned'}</span>`;
        bar.hidden = false;
    }
    function openPins() {
        if (!S.pins.length) return;
        openModal(`<h3>Pinned messages<button type="button" class="mx-icon-btn sm" data-close aria-label="Close" data-icon="x"></button></h3>
            <div role="list">${S.pins.map(p => `<button type="button" class="mx-hit" data-jump="${esc(sid(p.id))}"><span class="who">${esc(nameOf(p.sender_id))}</span><span class="txt">${esc(L.previewText(p.body))}</span><span class="when">${esc(L.fmtListTime(p.created_at))}</span></button>`).join('')}</div>`);
        $('mx-card').querySelectorAll('[data-jump]').forEach(b => b.addEventListener('click', () => { closeModal(); jumpTo(b.dataset.jump); }));
    }
    function openSearch() {
        if (!activeThread()) return;
        $('mx-searchbar').hidden = false;
        $('mx-msearch').focus();
    }
    function closeSearch() {
        clearTimeout(S.searchTimer);
        S.searchQ = ''; S.searchSeq++;
        $('mx-searchbar').hidden = true;
        $('mx-msearch').value = '';
        $('mx-msearch-info').textContent = '';
        $('mx-msearch-results').innerHTML = '';
        document.querySelectorAll('#mx-msgs .mx-msg.dim').forEach(el => el.classList.remove('dim'));
    }
    function onSearchInput() {
        const q = $('mx-msearch').value.trim();
        S.searchQ = q;
        applyLocalSearch();
        clearTimeout(S.searchTimer);
        $('mx-msearch-results').innerHTML = '';
        if (q.length >= 2) { $('mx-msearch-info').textContent = 'Searching…'; S.searchTimer = setTimeout(() => serverSearch(q), 300); }
        else $('mx-msearch-info').textContent = q ? 'Type one more letter to search older messages' : '';
    }
    function applyLocalSearch() {
        const q = S.searchQ.toLowerCase(), view = S.view;
        if (!view) return;
        const byKey = new Map(view.list.map(m => [mKey(m), m]));
        document.querySelectorAll('#mx-msgs .mx-msg').forEach(el => {
            if (!q) { el.classList.remove('dim'); return; }
            const m = byKey.get(el.dataset.key), sp = m ? L.parseSpecial(m.body) : null;
            const text = sp && sp.kind === 'text' ? sp.text : sp && sp.kind === 'file' ? sp.name : '';
            el.classList.toggle('dim', text.toLowerCase().indexOf(q) === -1);
        });
    }
    async function serverSearch(q) {
        const t = activeThread();
        if (!t) return;
        const seq = ++S.searchSeq, term = L.searchTerm(q);
        if (!term) { $('mx-msearch-info').textContent = ''; return; }
        let r;
        try { r = await threadQuery(t, 'id, sender_id, recipient_id, conversation_id, body, created_at').ilike('body', `%${term}%`).neq('body', L.DELETED).order('id', { ascending: false }).limit(30); }
        catch (e) { r = { error: e }; }
        if (seq !== S.searchSeq) return;
        if (r.error) { $('mx-msearch-info').textContent = 'Search is unavailable right now.'; return; }
        const hits = (r.data || []).filter(m => belongsTo(t, m) && !L.isSpecial(m.body) && String(m.body).toLowerCase().indexOf(term.toLowerCase()) !== -1);
        $('mx-msearch-info').textContent = hits.length ? `${hits.length} result${hits.length === 1 ? '' : 's'}${hits.length === 30 ? ' (newest 30)' : ''}` : 'No messages found';
        $('mx-msearch-results').innerHTML = hits.map(m => `<button type="button" class="mx-hit" role="listitem" data-jump="${esc(sid(m.id))}"><span class="who">${esc(nameOf(m.sender_id))}</span><span class="txt">${esc(String(m.body).replace(/\s+/g, ' ').slice(0, 140))}</span><span class="when">${esc(L.fmtListTime(m.created_at))}</span></button>`).join('');
    }

    // ---------------------------------------------------------------- dialogs
    function openModal(html) {
        S.restoreFocus = S.restoreFocus && !$('mx-modal').hidden ? S.restoreFocus : document.activeElement;
        $('mx-card').innerHTML = html;
        $('mx-modal').hidden = false;
        $('mx-card').querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
        setTimeout(() => { const f = $('mx-card').querySelector('input:not([type=checkbox]), button:not([data-close])') || $('mx-card').querySelector('button'); if (f) f.focus(); }, 30);
    }
    function closeModal() {
        if ($('mx-modal').hidden) return;
        $('mx-modal').hidden = true;
        $('mx-card').innerHTML = '';
        restoreFocus();
    }
    function restoreFocus() {
        const el = S.restoreFocus;
        S.restoreFocus = null;
        if (el && el.isConnected && typeof el.focus === 'function') { try { el.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
    }
    let confirmResolve = null;
    function confirmBox(o) {
        return new Promise(resolve => {
            if (confirmResolve) confirmResolve(false);
            confirmResolve = resolve;
            $('mx-confirm-title').textContent = o.title || 'Are you sure?';
            $('mx-confirm-msg').textContent = o.message || '';
            const ok = $('mx-confirm-ok');
            ok.textContent = o.ok || 'OK';
            ok.className = 'mx-btn primary' + (o.danger ? ' danger' : '');
            confirmBox.focus = document.activeElement;
            $('mx-confirm').hidden = false;
            $('mx-confirm-no').focus();
        });
    }
    function confirmDone(v) {
        $('mx-confirm').hidden = true;
        const r = confirmResolve;
        confirmResolve = null;
        if (confirmBox.focus && confirmBox.focus.isConnected) try { confirmBox.focus.focus({ preventScroll: true }); } catch (e) { /* gone */ }
        if (r) r(v);
    }

    function peopleButtons(list) {
        return list.map(p => `<div class="mx-item" role="listitem" tabindex="0" data-person="${esc(p.id)}">${personAvatar(p.id, 'sm', true)}<div class="mx-item-body"><div class="mx-item-top"><span class="mx-item-name">${esc(p.full_name || p.email || 'Unknown')}</span></div><div class="mx-item-bottom"><span class="mx-item-prev">${esc(isOnline(p.id) ? 'online' : (p.job_title || p.email || ''))}</span></div></div></div>`).join('')
            || '<div class="mx-list-empty">Nobody matches.</div>';
    }
    function colleagues(q) {
        q = String(q || '').toLowerCase();
        return [...S.people.values()].filter(p => p.id !== S.me.id && !isInactive(p) && (!q || String(p.full_name || '').toLowerCase().indexOf(q) !== -1 || String(p.email || '').toLowerCase().indexOf(q) !== -1))
            .sort((a, b) => (isOnline(b.id) - isOnline(a.id)) || String(a.full_name || a.email).localeCompare(String(b.full_name || b.email)));
    }
    function openNewChat() {
        if (!S.me) return;
        openModal(`<h3>New conversation<button type="button" class="mx-icon-btn sm" data-close aria-label="Close" data-icon="x"></button></h3>
            ${S.features.groups ? '<button type="button" class="mx-btn primary" id="nc-group" data-icon="users" style="width:100%">New group</button>' : ''}
            <label class="f" for="nc-q">Message a colleague</label>
            <input id="nc-q" type="search" placeholder="Search by name or email" autocomplete="off">
            <div class="mx-people" id="nc-list" role="list">${peopleButtons(colleagues(''))}</div>`);
        const list = $('nc-list');
        $('nc-q').addEventListener('input', () => { list.innerHTML = peopleButtons(colleagues($('nc-q').value.trim())); });
        const go = (e) => { const it = e.target.closest('[data-person]'); if (!it) return; closeModal(); openThread('dm:' + it.dataset.person); };
        list.addEventListener('click', go);
        list.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); } });
        const g = $('nc-group');
        if (g) g.addEventListener('click', openNewGroup);
    }
    function pickHtml(exclude, q) {
        const ex = new Set(exclude || []);
        const list = colleagues(q).filter(p => !ex.has(p.id));
        return list.map(p => `<label><input type="checkbox" value="${esc(p.id)}">${personAvatar(p.id, 'sm')}<span>${esc(p.full_name || p.email)}</span></label>`).join('')
            || '<div class="mx-list-empty">Nobody else to add.</div>';
    }
    // Keep ticks when the search filter re-renders the list.
    function wirePicker(boxId, inputId, exclude) {
        const box = $(boxId), picked = new Set();
        box.addEventListener('change', (e) => { if (e.target.type === 'checkbox') { if (e.target.checked) picked.add(e.target.value); else picked.delete(e.target.value); } });
        $(inputId).addEventListener('input', () => {
            box.innerHTML = pickHtml(exclude, $(inputId).value.trim());
            box.querySelectorAll('input[type=checkbox]').forEach(c => { c.checked = picked.has(c.value); });
        });
        return picked;
    }
    function openNewGroup() {
        openModal(`<h3>New group<button type="button" class="mx-icon-btn sm" data-close aria-label="Close" data-icon="x"></button></h3>
            <label class="f" for="ng-name">Group name</label><input id="ng-name" type="text" maxlength="80" placeholder="e.g. Sales team">
            <label class="f" for="ng-desc">Description (optional)</label><input id="ng-desc" type="text" maxlength="200" placeholder="What is this group for?">
            <label class="f" for="ng-q">Members</label><input id="ng-q" type="search" placeholder="Search colleagues" autocomplete="off">
            <div class="mx-pick" id="ng-pick">${pickHtml([], '')}</div>
            <p class="mx-err" id="ng-err"></p>
            <div class="mx-actions"><button type="button" class="mx-btn" data-close>Cancel</button><button type="button" class="mx-btn primary" id="ng-create">Create group</button></div>`);
        const picked = wirePicker('ng-pick', 'ng-q', []);
        $('ng-create').addEventListener('click', async () => {
            const name = $('ng-name').value.trim(), err = $('ng-err'), btn = $('ng-create');
            if (!name) { err.textContent = 'Give the group a name.'; $('ng-name').focus(); return; }
            btn.disabled = true; err.textContent = '';
            try {
                const { data: conv, error } = await S.sb.from('conversations').insert({ name, description: $('ng-desc').value.trim() || null, created_by: S.me.id }).select('*').single();
                if (error) throw error;
                if (picked.size) {
                    const r = await S.sb.from('conversation_members').insert([...picked].map(id => ({ conversation_id: conv.id, user_id: id, added_by: S.me.id })));
                    if (r.error) throw r.error;
                }
                closeModal();
                await loadGroups();
                if (!S.groups.has(conv.id)) S.groups.set(conv.id, Object.assign({}, conv, { member: { role: 'admin', last_read_at: new Date().toISOString(), muted: false } }));
                openThread('g:' + conv.id);
                toast('Group created.', 'ok');
            } catch (e) { err.textContent = friendly(e); btn.disabled = false; }
        });
    }
    // An update or delete that Row Level Security quietly skips returns no rows: say so instead of claiming success.
    async function affect(q) {
        const { data, error } = await q.select();
        if (error) return error;
        if (!data || !data.length) return new Error('You can’t do that in this group.');
        return null;
    }
    function openGroupInfo() {
        const t = activeThread(), g = groupOf(t);
        if (!g) return;
        const admin = isGroupAdmin(g);
        const members = (S.members.get(g.id) || []).slice().sort((a, b) => ((a.role === 'admin' ? 0 : 1) - (b.role === 'admin' ? 0 : 1)) || fullName(a.user_id).localeCompare(fullName(b.user_id)));
        openModal(`<button type="button" class="mx-icon-btn sm mx-x" data-close aria-label="Close" data-icon="x"></button>
            <div class="mx-profile">${avatarHtml({ name: g.name, group: true, cls: 'group lg' })}<h3>${esc(g.name)}</h3>
                ${g.description ? `<p style="margin:0">${esc(g.description)}</p>` : ''}
                <p class="mx-muted" style="margin:0">Created by ${esc(nameOf(g.created_by))} · ${esc(fullDate(g.created_at))}</p>
                <div class="mx-actions stretch" style="width:100%"><button type="button" class="mx-btn" data-icon="phone" id="gi-voice">Voice</button><button type="button" class="mx-btn" data-icon="video" id="gi-video">Video</button></div>
            </div>
            ${admin ? `<label class="f" for="gi-name">Name</label><div style="display:flex;gap:6px"><input id="gi-name" type="text" maxlength="80" value="${esc(g.name)}"><button type="button" class="mx-btn sm" id="gi-save-name">Save</button></div>
            <label class="f" for="gi-desc">Description</label><div style="display:flex;gap:6px"><input id="gi-desc" type="text" maxlength="200" value="${esc(g.description || '')}"><button type="button" class="mx-btn sm" id="gi-save-desc">Save</button></div>` : ''}
            <h4>${members.length} member${members.length === 1 ? '' : 's'}</h4>
            <div>${members.map(m => `<div class="mx-member">${personAvatar(m.user_id, 'sm', true)}<span class="nm">${esc(m.user_id === S.me.id ? 'You' : fullName(m.user_id) || 'Former colleague')}</span>${m.user_id === g.created_by ? '<span class="role">Creator</span>' : m.role === 'admin' ? '<span class="role">Admin</span>' : ''}
                ${admin && m.user_id !== S.me.id ? `${m.user_id === g.created_by ? '' : `<button type="button" class="mx-btn sm" data-role="${esc(m.user_id)}" data-to="${m.role === 'admin' ? 'member' : 'admin'}">${m.role === 'admin' ? 'Remove admin' : 'Make admin'}</button>`}<button type="button" class="mx-btn sm danger" data-remove="${esc(m.user_id)}" aria-label="Remove ${esc(fullName(m.user_id))}">Remove</button>` : ''}</div>`).join('')}</div>
            ${admin ? `<h4>Add members</h4><input id="gi-q" type="search" placeholder="Search colleagues" autocomplete="off"><div class="mx-pick" id="gi-pick">${pickHtml(members.map(m => m.user_id), '')}</div><div class="mx-actions"><button type="button" class="mx-btn" id="gi-add">Add selected</button></div>` : ''}
            <p class="mx-err" id="gi-err"></p>
            <div class="mx-actions">
                <button type="button" class="mx-btn" id="gi-mute">${g.member.muted ? '🔔 Unmute' : '🔕 Mute'}</button>
                <button type="button" class="mx-btn danger" id="gi-leave">Leave group</button>
                ${admin ? '<button type="button" class="mx-btn danger" id="gi-archive">Archive group</button>' : ''}
            </div>`);
        const card = $('mx-card'), err = $('gi-err');
        const fail = (e) => { err.textContent = friendly(e); };
        const refresh = async () => { await loadGroups(); if (S.groups.has(g.id) && !$('mx-modal').hidden) openGroupInfo(); };
        $('gi-voice').addEventListener('click', () => { closeModal(); startCall(t, false); });
        $('gi-video').addEventListener('click', () => { closeModal(); startCall(t, true); });
        if (admin) {
            $('gi-save-name').addEventListener('click', async () => {
                const name = $('gi-name').value.trim(); if (!name) return;
                const e = await affect(S.sb.from('conversations').update({ name }).eq('id', g.id));
                if (e) return fail(e);
                toast('Group renamed.', 'ok'); refresh();
            });
            $('gi-save-desc').addEventListener('click', async () => {
                const e = await affect(S.sb.from('conversations').update({ description: $('gi-desc').value.trim() || null }).eq('id', g.id));
                if (e) return fail(e);
                refresh();
            });
            const picked = wirePicker('gi-pick', 'gi-q', members.map(m => m.user_id));
            $('gi-add').addEventListener('click', async () => {
                if (!picked.size) return;
                const { error } = await S.sb.from('conversation_members').insert([...picked].map(id => ({ conversation_id: g.id, user_id: id, added_by: S.me.id })));
                if (error) return fail(error);
                toast(`${picked.size} added.`, 'ok'); refresh();
            });
            card.querySelectorAll('[data-role]').forEach(b => b.addEventListener('click', async () => {
                const e = await affect(S.sb.from('conversation_members').update({ role: b.dataset.to }).eq('conversation_id', g.id).eq('user_id', b.dataset.role));
                if (e) return fail(e);
                refresh();
            }));
            card.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', async () => {
                const ok = await confirmBox({ title: 'Remove this member?', message: `${fullName(b.dataset.remove) || 'They'} will no longer see this group.`, ok: 'Remove', danger: true });
                if (!ok) return;
                const e = await affect(S.sb.from('conversation_members').delete().eq('conversation_id', g.id).eq('user_id', b.dataset.remove));
                if (e) return fail(e);
                refresh();
            }));
            $('gi-archive').addEventListener('click', async () => {
                const ok = await confirmBox({ title: 'Archive this group?', message: 'It disappears from everyone’s list. Messages are kept.', ok: 'Archive', danger: true });
                if (!ok) return;
                const e = await affect(S.sb.from('conversations').update({ archived_at: new Date().toISOString() }).eq('id', g.id));
                if (e) return fail(e);
                closeModal(); closeThread(); loadGroups();
            });
        }
        $('gi-mute').addEventListener('click', async () => {
            const muted = !g.member.muted;
            const e = await affect(S.sb.from('conversation_members').update({ muted }).eq('conversation_id', g.id).eq('user_id', S.me.id));
            if (e) return fail(e);
            g.member.muted = muted; recomputeUnread(); renderSidebar(); refresh();
        });
        $('gi-leave').addEventListener('click', async () => {
            const ok = await confirmBox({ title: 'Leave this group?', message: 'You will stop receiving its messages. An admin can add you back.', ok: 'Leave', danger: true });
            if (!ok) return;
            const e = await affect(S.sb.from('conversation_members').delete().eq('conversation_id', g.id).eq('user_id', S.me.id));
            if (e) return fail(e);
            closeModal(); closeThread(); loadGroups();
        });
    }
    function openProfile(id) {
        const p = person(id) || {}, on = isOnline(id), st = S.dayStatus.get(id);
        const role = [p.job_title, p.department].filter(Boolean).join(' · ');
        const t = threadFor('dm:' + id);
        openModal(`<button type="button" class="mx-icon-btn sm mx-x" data-close aria-label="Close" data-icon="x"></button>
            <div class="mx-profile">${personAvatar(id, 'lg', true)}<h3>${esc(p.full_name || p.email || 'Unknown')}</h3>
                <span class="mx-muted"${on ? ' style="color:var(--mx-ok);font-weight:600"' : ''}>${esc(on ? 'Online now' : L.fmtLastSeen(S.lastSeen.get(id)))}</span>
                <div class="mx-facts">
                    ${p.email ? `<div><small>Email</small><span><a class="mx-link" href="mailto:${esc(p.email)}">${esc(p.email)}</a></span></div>` : ''}
                    ${role ? `<div><small>Role</small><span>${esc(role)}</span></div>` : ''}
                    ${p.company ? `<div><small>Company</small><span>${esc(p.company)}</span></div>` : ''}
                    ${st ? `<div><small>Today</small><span>${esc(`${st.icon || ''} ${st.label || ''}`.trim() + (st.is_wfh ? ' · working from home' : ''))}</span></div>` : ''}
                </div>
                <div class="mx-actions stretch" style="width:100%">
                    <button type="button" class="mx-btn primary" data-icon="phone" id="pf-voice">Voice call</button>
                    <button type="button" class="mx-btn primary" data-icon="video" id="pf-video">Video call</button>
                </div>
                <div class="mx-actions stretch" style="width:100%;margin-top:0">
                    ${S.activeKey !== t.key ? '<button type="button" class="mx-btn" id="pf-msg">Message</button>' : ''}
                    <a class="mx-btn" href="/employees/?id=${encodeURIComponent(id)}">Full profile</a>
                </div>
            </div>`);
        $('pf-voice').addEventListener('click', () => { closeModal(); startCall(t, false); });
        $('pf-video').addEventListener('click', () => { closeModal(); startCall(t, true); });
        const msg = $('pf-msg');
        if (msg) msg.addEventListener('click', () => { closeModal(); openThread(t.key); });
    }
    function openHeaderMore(anchor) {
        const t = activeThread();
        if (!t) return;
        const items = [['search', '🔍', 'Search in chat']];
        if (t.kind === 'dm') items.push(['profile', '👤', 'View profile'], ['clear', '🧹', 'Clear chat', true]);
        else {
            const g = groupOf(t);
            items.push(['info', '👥', 'Group info'], ['mute', g && g.member.muted ? '🔔' : '🔕', g && g.member.muted ? 'Unmute' : 'Mute notifications']);
        }
        if (S.pins.length) items.push(['pins', '📌', 'Pinned messages']);
        const r = anchor.getBoundingClientRect();
        openMenu(menuItems(items), r.right - 220, r.bottom + 6, async (act) => {
            if (act === 'search') openSearch();
            else if (act === 'profile') openProfile(t.id);
            else if (act === 'clear') clearChat();
            else if (act === 'info') openGroupInfo();
            else if (act === 'pins') openPins();
            else if (act === 'mute') {
                const g = groupOf(t);
                if (!g) return;
                const muted = !g.member.muted;
                const e = await affect(S.sb.from('conversation_members').update({ muted }).eq('conversation_id', g.id).eq('user_id', S.me.id));
                if (e) return toast(friendly(e), 'bad');
                g.member.muted = muted; recomputeUnread(); renderSidebar();
                toast(muted ? 'Group muted.' : 'Group unmuted.', 'ok');
            }
        });
        anchor.setAttribute('aria-expanded', 'true');
    }

    // ------------------------------------------------------------------ calls
    function startCall(t, video) {
        if (!t) return;
        if (!window.WSCalls || typeof WSCalls.start !== 'function') { toast('Calling is unavailable right now — reload the page and try again.', 'bad'); return; }
        try {
            if (t.kind === 'group') WSCalls.start({ conversationId: t.id, video: !!video });
            else WSCalls.start({ userIds: [t.id], video: !!video });
        } catch (e) { toast('Could not start the call.', 'bad'); }
    }
    function joinCall(id) {
        if (!window.WSCalls || typeof WSCalls.join !== 'function') { toast('Calling is unavailable right now — reload the page and try again.', 'bad'); return; }
        try { WSCalls.join(id); } catch (e) { toast('Could not join the call.', 'bad'); }
    }
    async function refreshCallBar() {
        const t = activeThread(), bar = $('mx-callbar');
        if (!t || t.kind !== 'group' || S.features.calls === false) { bar.hidden = true; return; }
        let r;
        try {
            r = await S.sb.from('calls').select('id, media, status, created_by, created_at, call_participants(user_id, state)')
                .eq('conversation_id', t.id).in('status', ['ringing', 'active']).order('created_at', { ascending: false }).limit(1);
        } catch (e) { return; }
        if (activeThread() !== t) return;
        if (r.error) { if (isSchemaMissing(r.error)) S.features.calls = false; bar.hidden = true; return; }
        const c = (r.data || [])[0];
        if (!c) { bar.hidden = true; return; }
        const parts = c.call_participants || [];
        const inCall = parts.filter(p => p.state === 'joined').length;
        const mine = parts.some(p => p.user_id === S.me.id && p.state === 'joined');
        bar.innerHTML = `<span aria-hidden="true">${c.media === 'video' ? '📹' : '📞'}</span><span class="txt">${c.media === 'video' ? 'Video' : 'Voice'} call in progress · ${inCall} in the call</span><button type="button" class="mx-btn sm" data-call="${esc(c.id)}">${mine ? 'Return to call' : 'Join'}</button>`;
        bar.hidden = false;
    }
    function startCallBarPolling() {
        stopCallBarPolling();
        const t = activeThread();
        if (t && t.kind === 'group') S.callBarTimer = setInterval(() => { if (document.visibilityState === 'visible') refreshCallBar(); }, 15000);
    }
    function stopCallBarPolling() { clearInterval(S.callBarTimer); S.callBarTimer = null; }

    async function loadCalls() {
        if (!S.me || S.features.calls === false) { paintCalls(); return; }
        let r;
        try {
            r = await S.sb.from('calls').select('id, media, status, created_by, conversation_id, created_at, answered_at, ended_at, call_participants(user_id, role, state, joined_at)')
                .order('created_at', { ascending: false }).limit(60);
        } catch (e) { return; }
        if (r.error) {
            if (isSchemaMissing(r.error)) S.features.calls = false;
            else S.callsError = true;
            paintCalls();
            return;
        }
        S.features.calls = true; S.callsError = false;
        S.calls = r.data || [];
        S.callsLoaded = true;
        paintCalls();
    }
    const loadCallsSoon = debounce(loadCalls, 1500);
    function callInfo(c) {
        const parts = c.call_participants || [];
        const mine = c.created_by === S.me.id;
        const me = parts.find(p => p.user_id === S.me.id);
        let key = null, name, avatar;
        if (c.conversation_id) {
            key = S.groups.has(c.conversation_id) ? 'g:' + c.conversation_id : null;
            const g = S.groups.get(c.conversation_id);
            name = g ? g.name : 'Group call';
            avatar = avatarHtml({ name, group: true, cls: 'group' });
        } else {
            const other = mine ? (parts.find(p => p.user_id !== S.me.id) || {}).user_id : c.created_by;
            key = other ? 'dm:' + other : null;
            name = other ? fullName(other) || 'Former colleague' : 'Unknown';
            avatar = other ? personAvatar(other) : avatarHtml({ name });
        }
        const live = c.status === 'ringing' || c.status === 'active';
        const secs = c.answered_at && c.ended_at ? Math.max(0, (timeOf(c.ended_at) - timeOf(c.answered_at)) / 1000) : 0;
        let text, miss = false;
        if (live) text = 'Ongoing call';
        else if (mine) text = 'Outgoing · ' + (c.answered_at ? L.fmtDuration(secs) : ({ missed: 'No answer', declined: 'Declined', busy: 'Busy' }[c.status] || 'Not answered'));
        else if (me && me.joined_at) text = 'Incoming · ' + L.fmtDuration(secs);
        else if (me && me.state === 'declined') text = 'Declined';
        else { text = 'Missed call'; miss = true; }
        return { key, name, avatar, live, text, miss, mine, dir: mine ? '↗' : '↙' };
    }
    function paintCalls() {
        const box = $('mx-calls');
        if (S.tab !== 'calls') { paintCallsBadge(); return; }
        if (S.features.calls === false) {
            box.innerHTML = '<div class="mx-list-empty"><b>Call history is not set up yet.</b><br>An administrator needs to run <code>supabase-messenger-calls-migration.sql</code> in Supabase.</div>';
            return;
        }
        if (!S.callsLoaded) {
            box.innerHTML = S.callsError ? '<div class="mx-list-empty">Recent calls are unavailable right now. Try again in a moment.</div>' : '<div class="mx-skel" aria-hidden="true"><i></i><i></i><i></i></div>';
            return;
        }
        const q = $('mx-search').value.trim().toLowerCase();
        const rows = S.calls.map(c => Object.assign({ c }, callInfo(c))).filter(x => !q || x.name.toLowerCase().indexOf(q) !== -1);
        if (!rows.length) { box.innerHTML = `<div class="mx-list-empty">${q ? 'No calls match.' : 'No calls yet. Start one from any chat with the phone or camera button.'}</div>`; return; }
        box.innerHTML = rows.map(x => `<div class="mx-item mx-call-item${x.miss ? ' miss' : ''}" role="listitem" tabindex="0"${x.key ? ` data-key="${esc(x.key)}"` : ''}>
            ${x.avatar}
            <div class="mx-item-body">
                <div class="mx-item-top"><span class="mx-item-name">${esc(x.name)}</span><span class="mx-item-time">${esc(L.fmtListTime(x.c.created_at))}</span></div>
                <div class="mx-item-bottom"><span class="mx-item-prev"><span class="dir" aria-hidden="true">${x.dir}</span> ${x.c.media === 'video' ? '📹' : '📞'} ${esc(x.text)}</span></div>
            </div>
            <div class="mx-call-actions">${x.live && x.c.conversation_id ? `<button type="button" class="mx-btn sm" data-join="${esc(x.c.id)}">Join</button>`
                : x.key ? `<button type="button" class="mx-icon-btn" data-icon="phone" data-callkey="${esc(x.key)}" data-media="audio" aria-label="${esc('Voice call ' + x.name)}"></button><button type="button" class="mx-icon-btn" data-icon="video" data-callkey="${esc(x.key)}" data-media="video" aria-label="${esc('Video call ' + x.name)}"></button>` : ''}</div>
        </div>`).join('');
        paintCallsBadge();
    }
    function callsSeenAt() { try { return Number(localStorage.getItem('mx-calls-seen') || 0); } catch (e) { return 0; } }
    function markCallsSeen() { try { localStorage.setItem('mx-calls-seen', String(Date.now())); } catch (e) { /* private mode */ } paintCallsBadge(); }
    function paintCallsBadge() {
        const seen = callsSeenAt();
        const n = S.tab === 'calls' ? 0 : S.calls.filter(c => timeOf(c.created_at) > seen && callInfo(c).miss).length;
        const b = $('mx-tab-calls-n');
        b.hidden = !n;
        b.textContent = String(n);
    }

    // --------------------------------------------------------------- overlays
    function toastCard(o) {
        const box = $('mx-toasts');
        if (!box) return;
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'mx-toast';
        el.innerHTML = `${o.avatar || ''}<span class="t"><b></b><span class="s"></span></span>`;
        el.querySelector('b').textContent = o.title;
        el.querySelector('.s').textContent = o.text;
        el.addEventListener('click', () => { el.remove(); if (o.onClick) o.onClick(); });
        box.prepend(el);
        while (box.children.length > 3) box.lastChild.remove();
        setTimeout(() => el.remove(), 5500);
    }
    function maybeShowRules() {
        try { if (!localStorage.getItem('ws-rules-seen-chat')) { openRules(); localStorage.setItem('ws-rules-seen-chat', '1'); } } catch (e) { /* private mode */ }
    }
    function openRules() { S.restoreFocus = document.activeElement; $('mx-rules').hidden = false; $('mx-rules-ok').focus(); }
    function closeRules() { $('mx-rules').hidden = true; restoreFocus(); }
    function closeFloating() { closeMenu(); closeEmoji(); closeMentions(); }

    // ------------------------------------------------------------- connection
    function setConn(state) {
        S.conn = state;
        const el = $('mx-conn');
        clearTimeout(S.connTimer);
        if (state === 'live') { el.hidden = true; return; }
        const text = {
            connecting: 'Connecting…',
            reconnecting: 'Reconnecting… new messages will appear as soon as the connection is back.',
            offline: 'You are offline. Messages you send will go out when you are back online.',
        }[state];
        const show = () => { el.textContent = text; el.className = 'mx-conn' + (state === 'offline' ? ' offline' : ''); el.hidden = false; };
        if (state === 'offline') show();
        else S.connTimer = setTimeout(show, state === 'connecting' ? 3000 : 2000);   // brief blips stay quiet
    }
    async function resync() {
        if (!S.me) return;
        if (S.syncing) { S.syncAgain = true; return; }
        S.syncing = true;
        try {
            S.lastSync = Date.now();
            await loadGroups();
            await loadInbox();
            if (S.view) await fetchLatest(S.view);
            loadPinned();
            refreshCallBar();
            loadCalls();
            pollLastSeen();
            flushOutbox();
        } catch (e) { console.warn('[messenger] resync', e); }
        finally {
            S.syncing = false;
            if (S.syncAgain) { S.syncAgain = false; resync(); }
        }
    }

    // ------------------------------------------------------------- deep links
    function handleHash() {
        if (!S.me) return;
        const h = new URLSearchParams((location.hash || '').replace(/^#/, ''));
        const dm = h.get('thread') || h.get('answer'), group = h.get('group'), call = h.get('call');
        if (!dm && !group && !call) return;
        history.replaceState(null, '', location.pathname + location.search);
        if (dm && dm !== S.me.id) openThread('dm:' + dm);
        else if (group) {
            if (S.groups.has(group)) openThread('g:' + group);
            else loadGroups().then(() => { if (S.groups.has(group)) openThread('g:' + group); else toast('That group is not available to you.', 'bad'); });
        }
        if (call) {
            // Opening the call window needs a click (pop-up blockers), so ask first.
            confirmBox({ title: 'Join the call?', message: 'You were invited to a call. Join it now?', ok: 'Join call' }).then(ok => { if (ok) joinCall(call); });
        }
    }

    // ----------------------------------------------------------------- wiring
    function wire() {
        // Sidebar
        $('mx-tab-chats').addEventListener('click', () => setTab('chats'));
        $('mx-tab-calls').addEventListener('click', () => setTab('calls'));
        $('mx-new').addEventListener('click', openNewChat);
        $('mx-empty-new').addEventListener('click', openNewChat);
        $('mx-search').addEventListener('input', () => { if (S.tab === 'calls') paintCalls(); else paintSidebar(); });
        const openFromList = (e) => {
            const it = e.target.closest('[data-key], [data-person]');
            if (!it) return;
            if (it.dataset.person) openThread('dm:' + it.dataset.person); else openThread(it.dataset.key);
        };
        $('mx-list').addEventListener('click', openFromList);
        $('mx-list').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFromList(e); } });
        $('mx-calls').addEventListener('click', (e) => {
            const call = e.target.closest('[data-callkey]'), join = e.target.closest('[data-join]');
            if (call) { e.stopPropagation(); const t = threadFor(call.dataset.callkey); return startCall(t, call.dataset.media === 'video'); }
            if (join) { e.stopPropagation(); return joinCall(join.dataset.join); }
            const row = e.target.closest('[data-key]');
            if (row) { openThread(row.dataset.key); if (isPhone()) setTab('chats'); }
        });
        $('mx-calls').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-key]')) { e.preventDefault(); openThread(e.target.dataset.key); } });

        // Header
        // On a phone the thread has its own history entry (openThread): going back pops it, and popstate closes the thread.
        $('mx-back').addEventListener('click', () => { if (isPhone() && history.state && history.state.mxThread) history.back(); else closeThread(); });
        $('mx-head-who').addEventListener('click', () => { const t = activeThread(); if (!t) return; if (t.kind === 'group') openGroupInfo(); else openProfile(t.id); });
        $('mx-h-search').addEventListener('click', () => { if ($('mx-searchbar').hidden) openSearch(); else closeSearch(); });
        $('mx-h-voice').addEventListener('click', () => startCall(activeThread(), false));
        $('mx-h-video').addEventListener('click', () => startCall(activeThread(), true));
        $('mx-h-more').addEventListener('click', (e) => { e.stopPropagation(); openHeaderMore(e.currentTarget); });
        $('mx-msearch').addEventListener('input', onSearchInput);
        $('mx-msearch-x').addEventListener('click', closeSearch);
        $('mx-msearch-results').addEventListener('click', (e) => { const b = e.target.closest('[data-jump]'); if (b) jumpTo(b.dataset.jump); });
        $('mx-pinned').addEventListener('click', openPins);
        $('mx-pinned').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPins(); } });
        $('mx-callbar').addEventListener('click', (e) => { const b = e.target.closest('[data-call]'); if (b) joinCall(b.dataset.call); });

        // Messages
        const sc = $('mx-scroll');
        sc.addEventListener('scroll', () => {
            S.stickBottom = isNearBottom();
            if (S.stickBottom && S.view) { S.view.unseen = 0; scheduleMarkRead(); }
            updateNewPill();
        }, { passive: true });
        if ('IntersectionObserver' in window) {
            new IntersectionObserver((entries) => { if (entries.some(x => x.isIntersecting)) checkSentinel(); }, { root: sc, rootMargin: '300px 0px 0px 0px' }).observe($('mx-sentinel'));
        }
        $('mx-newpill').addEventListener('click', () => {
            const view = S.view;
            if (!view) return;
            if (view.detached) loadLatest(view);
            else { sc.scrollTop = sc.scrollHeight; view.unseen = 0; updateNewPill(); scheduleMarkRead(); }
        });
        const msgs = $('mx-msgs');
        msgs.addEventListener('click', (e) => {
            if (S.suppressClick) { S.suppressClick = false; e.preventDefault(); return; }
            const a = e.target.closest('[data-act]');
            if (!a || !msgs.contains(a)) return;
            const row = a.closest('.mx-msg, .mx-callrow'), m = messageForRow(row);
            const act = a.dataset.act;
            if (act === 'menu') { const r = a.getBoundingClientRect(); a.setAttribute('aria-expanded', 'true'); openMessageMenu(m, r.left - 180, r.bottom + 4); }
            else if (act === 'view') openImage(m);
            else if (act === 'download') downloadFile(m);
            else if (act === 'retry') retryMessage(m);
            else if (act === 'discard') discardMessage(m);
            else if (act === 'cancel') cancelUpload(m);
            else if (act === 'quote') jumpTo(a.dataset.target);
            else if (act === 'react') toggleReaction(m, a.dataset.emoji);
            else if (act === 'callback') startCall(activeThread(), a.dataset.media === 'video');
        });
        msgs.addEventListener('contextmenu', (e) => {
            const b = e.target.closest('.mx-bubble');
            if (!b || e.target.closest('a')) return;
            e.preventDefault();
            openMessageMenu(messageForRow(b.closest('.mx-msg')), e.clientX, e.clientY);
        });
        msgs.addEventListener('keydown', (e) => {
            const b = e.target.closest && e.target.closest('.mx-bubble');
            if (!b || e.target !== b || !(e.key === 'Enter' || e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return;
            e.preventDefault();
            const r = b.getBoundingClientRect();
            openMessageMenu(messageForRow(b.closest('.mx-msg')), r.left, r.bottom + 4);
        });
        // Long press on touch screens
        let press = null;
        msgs.addEventListener('pointerdown', (e) => {
            if (e.pointerType !== 'touch') return;
            const b = e.target.closest('.mx-bubble');
            if (!b) return;
            const x = e.clientX, y = e.clientY;
            press = { x, y, t: setTimeout(() => { press = null; S.suppressClick = true; if (navigator.vibrate) navigator.vibrate(12); openMessageMenu(messageForRow(b.closest('.mx-msg')), x, y); }, 480) };
        });
        const cancelPress = (e) => { if (!press) return; if (e.type === 'pointermove' && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 10) return; clearTimeout(press.t); press = null; };
        ['pointerup', 'pointercancel', 'pointermove'].forEach(ev => msgs.addEventListener(ev, cancelPress, { passive: true }));

        // Composer
        const input = $('mx-input');
        input.addEventListener('input', () => {
            autosize(); updateSendButton(); updateMentions();
            if (input.value.trim() && !S.editing) sendTyping();
        });
        input.addEventListener('click', updateMentions);
        input.addEventListener('keydown', (e) => {
            if (S.mention) {
                if (e.key === 'ArrowDown') { e.preventDefault(); S.mention.on = Math.min(S.mention.items.length - 1, S.mention.on + 1); paintMentions(); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); S.mention.on = Math.max(0, S.mention.on - 1); paintMentions(); return; }
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(S.mention.on); return; }
                if (e.key === 'Escape') { e.preventDefault(); closeMentions(); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !(isCoarse() && isPhone())) { e.preventDefault(); sendFromComposer(); return; }
            if (e.key === 'ArrowUp' && !input.value && !e.shiftKey) { if (editLastOwn()) e.preventDefault(); return; }
            if (e.key === 'Escape' && (S.replyTo || S.editing)) { e.preventDefault(); resetCompose(); }
        });
        input.addEventListener('blur', () => setTimeout(closeMentions, 150));
        input.addEventListener('paste', (e) => {
            const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
            if (files.length) { e.preventDefault(); queueFiles(files); }
        });
        $('mx-mentions').addEventListener('mousedown', (e) => { const b = e.target.closest('[data-i]'); if (b) { e.preventDefault(); pickMention(Number(b.dataset.i)); } });
        $('mx-send').addEventListener('click', sendFromComposer);
        $('mx-mic').addEventListener('click', startRecording);
        $('mx-rec-cancel').addEventListener('click', () => stopRecording(false));
        $('mx-rec-send').addEventListener('click', () => stopRecording(true));
        $('mx-attach').addEventListener('click', () => { if (!activeThread()) return; $('mx-file').click(); });
        $('mx-file').addEventListener('change', (e) => { const files = Array.from(e.target.files || []); e.target.value = ''; queueFiles(files); });
        $('mx-ctx-x').addEventListener('click', () => { resetCompose(); focusComposer(); });
        $('mx-emoji-btn').addEventListener('click', (e) => { e.stopPropagation(); if ($('mx-emoji').hidden) openEmoji(null); else closeEmoji(); });
        $('mx-emoji').addEventListener('click', (e) => {
            const b = e.target.closest('[data-emoji]');
            if (!b) return;
            if (S.emojiFor) { const m = S.emojiFor; closeEmoji(); toggleReaction(m, b.dataset.emoji); return; }
            insertAtCaret(b.dataset.emoji);
        });

        // Drag and drop files onto the conversation
        const thread = $('mx-thread');
        const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') !== -1;
        thread.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); S.dragDepth++; $('mx-drop').hidden = false; });
        thread.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
        thread.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; S.dragDepth = Math.max(0, S.dragDepth - 1); if (!S.dragDepth) $('mx-drop').hidden = true; });
        thread.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); S.dragDepth = 0; $('mx-drop').hidden = true; queueFiles(e.dataTransfer.files); });

        // Overlays
        $('mx-menu').addEventListener('click', (e) => {
            const b = e.target.closest('button');
            if (!b) return;
            const pick = S.menuPick;
            closeMenu();
            if (pick) pick(b.dataset.act, b);
        });
        $('mx-modal').addEventListener('click', (e) => { if (e.target === $('mx-modal')) closeModal(); });
        $('mx-confirm-ok').addEventListener('click', () => confirmDone(true));
        $('mx-confirm-no').addEventListener('click', () => confirmDone(false));
        $('mx-confirm').addEventListener('click', (e) => { if (e.target === $('mx-confirm')) confirmDone(false); });
        $('mx-lb-x').addEventListener('click', closeLightbox);
        $('mx-lightbox').addEventListener('click', (e) => { if (e.target === $('mx-lightbox')) closeLightbox(); });
        $('mx-rules-ok').addEventListener('click', closeRules);
        $('mx-rules').addEventListener('click', (e) => { if (e.target === $('mx-rules')) closeRules(); });
        const rulesBtn = $('mx-rules-btn');
        if (rulesBtn) rulesBtn.addEventListener('click', openRules);

        document.addEventListener('click', (e) => {
            if (!$('mx-menu').hidden && !$('mx-menu').contains(e.target)) closeMenu();
            if (!$('mx-emoji').hidden && !$('mx-emoji').contains(e.target) && e.target !== $('mx-emoji-btn')) closeEmoji();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (!$('mx-lightbox').hidden) return closeLightbox();
            if (!$('mx-confirm').hidden) return confirmDone(false);
            if (!$('mx-menu').hidden) return closeMenu(true);
            if (!$('mx-emoji').hidden) { closeEmoji(); return focusComposer(); }
            if (!$('mx-modal').hidden) return closeModal();
            if (!$('mx-rules').hidden) return closeRules();
            if (!$('mx-searchbar').hidden && $('mx-searchbar').contains(document.activeElement)) { closeSearch(); return focusComposer(); }
        });
        ['pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, unlockAudio, { passive: true }));

        // Connection, visibility and links
        window.addEventListener('online', () => { setConn(S.wasLive === false ? 'reconnecting' : 'live'); resync(); });
        window.addEventListener('offline', () => { setConn('offline'); if (S.uploadXhr) S.uploadXhr.abort(); });   // the outbox retries it
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible' || !S.me) return;
            scheduleMarkRead();
            if (Date.now() - S.lastSync > 30000) resync();
        });
        window.addEventListener('hashchange', handleHash);
        // The shell's own popstate handler only closes its sliders (state.wsSlider); thread entries are ours.
        window.addEventListener('popstate', (e) => {
            const key = e.state && e.state.mxThread;
            if (key) { if (key !== S.activeKey && S.threads.has(key)) openThread(key, { fromPop: true }); return; }
            if (S.activeKey && isPhone()) closeThread();
        });
        window.addEventListener('beforeunload', (e) => {
            if (S.outbox.length || S.rec) { e.preventDefault(); e.returnValue = 'Messages are still sending.'; return e.returnValue; }
        });
        window.addEventListener('pagehide', () => { if (S.rec) stopRecording(false); });
    }

    wire();
    updateSendButton();
    boot().catch(e => { console.error('[messenger] start', e); fatal('Messenger could not start. Reload the page to try again.'); });
})();
