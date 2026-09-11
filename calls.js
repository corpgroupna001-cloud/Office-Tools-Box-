/* ============================================================================
   WorkSuite calls — the part that lives on every page (window.WSCalls).

   Loaded by the Messenger and injected on every other signed-in page by
   notifications.js / ui/shell.js. It does three things:

   1. Rings. An invitation is a call_participants row for me; Realtime
      delivers it the moment a colleague calls (and ws_call_live() catches
      up on page load), so every open WorkSuite tab and device shows the
      incoming call. Only one tab per browser plays the ringtone. Accepting
      opens the call window; declining tells the database; answering on
      another device makes the card go away here.
   2. Starts calls: WSCalls.start({ userIds | conversationId, video }).
      Call it straight from a click — it opens the call window before it
      talks to the server, or the browser's popup blocker would stop it.
   3. Keeps a "Return to call" pill on screen while a call window is open
      (the window reports itself on BroadcastChannel 'ws-calls').

   The call itself runs in /call/ (a popup on desktop, the same tab on
   phones), so moving between pages never drops it.

   Window events: ws:call-incoming, ws:call-ended, ws:call-resume, ws:call-active.
   ============================================================================ */
(function () {
    'use strict';
    if (window.WSCalls) return;

    const FEATURES = 'popup,width=1040,height=720';
    const POLL_MS = 7000;             // re-check a ringing call in case Realtime missed its end
    const isCallPage = /^\/call(\/|$)/.test(location.pathname);
    const S = {
        sb: null, uid: null, session: null, skew: 0,
        incoming: new Map(),          // callId -> card entry
        people: new Map(),
        active: null, activeAt: 0,    // a call window open in this browser
        taken: new Set(),             // calls answered from this page (resume when they end)
        windows: new Map(),           // callId -> the call window this page opened
        channel: null, lastCheck: 0,
        bc: null,
    };

    /* ------------------------------------------------------------ helpers */
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    function emit(name, detail) { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (e) { /* old browser */ } }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function pickColor(name) {
        const colors = ['#3b82f6', '#a855f7', '#ec4899', '#f97316', '#10b981', '#14b8a6', '#f59e0b', '#ef4444', '#6366f1', '#06b6d4'];
        const i = String(name || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0) % colors.length;
        return colors[i];
    }
    function initials(name) {
        const parts = String(name || '?').trim().split(/\s+/);
        return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
    }
    function isPhone() {
        try {
            if (window.matchMedia('(display-mode: standalone)').matches) return true;   // an installed app has no popups
            return window.matchMedia('(pointer: coarse)').matches && Math.min(window.innerWidth, screen.width || 9999) <= 900;
        } catch (e) { return false; }
    }
    const isMissing = (e) => !!e && (['PGRST202', '42883', '42P01', 'PGRST205'].includes(String(e.code)) || /could not find the function/i.test(e.message || ''));
    function friendly(e) {
        const m = (e && e.message) || '';
        if (isMissing(e)) return 'Calls are not set up yet — ask your admin to run supabase-messenger-calls-migration.sql';
        if (/already in a call/i.test(m)) return 'You are already in a call';
        if (/at most 8/i.test(m)) return 'A call can have at most 8 people';
        if (/not in this group/i.test(m)) return 'You are not in this group';
        if (/nobody to call/i.test(m)) return 'There is nobody to call';
        if (/fetch|network|load failed|timeout/i.test(m)) return 'Could not start the call — check your connection';
        return 'Could not start the call';
    }
    async function rpc(name, args) {
        const { data, error } = await S.sb.rpc(name, args);
        if (error) throw error;
        return data;
    }

    function toast(msg, kind) {
        if (window.WSShell && typeof window.WSShell.toast === 'function' && document.getElementById('ws-toast-host')) return window.WSShell.toast(msg, kind || '');
        injectStyles();
        const t = document.createElement('div');
        t.className = 'wsc-toast' + (kind === 'bad' ? ' bad' : '');
        t.setAttribute('role', 'status');
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 4200);
    }

    function push(body) {
        try {
            if (window.WSPush && typeof window.WSPush.send === 'function') return window.WSPush.send(S.sb, body);
            const token = S.session && S.session.access_token;
            if (!token) return;
            fetch('/api/push', {
                method: 'POST', keepalive: true,
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
                body: JSON.stringify(body),
            }).catch(() => {});
        } catch (e) { /* push is a bonus, never a blocker */ }
    }

    /** The service worker shows ringing pushes with tag call-<id>. */
    function closeSwNotifications(callId) {
        try {
            if (!('serviceWorker' in navigator) || !navigator.serviceWorker.getRegistration) return;
            navigator.serviceWorker.getRegistration().then(reg => {
                if (!reg || !reg.getNotifications) return;
                return reg.getNotifications({ tag: 'call-' + callId }).then(list => list.forEach(n => n.close()));
            }).catch(() => {});
        } catch (e) { /* not supported */ }
    }

    async function profile(id) {
        if (!id) return null;
        if (S.people.has(id)) return S.people.get(id);
        try {
            const { data } = await S.sb.from('profiles').select('id, full_name, email, avatar_url').eq('id', id).maybeSingle();
            if (data) S.people.set(id, data);
            return data || null;
        } catch (e) { return null; }
    }
    async function groupName(id) {
        try {
            const { data } = await S.sb.from('conversations').select('name').eq('id', id).maybeSingle();
            return (data && data.name) || 'Group';
        } catch (e) { return 'Group'; }
    }

    /* ------------------------------------------------------------- styles */
    function injectStyles() {
        if (document.getElementById('wsc-styles')) return;
        const s = document.createElement('style');
        s.id = 'wsc-styles';
        s.textContent = `
#wsc-root { position: fixed; right: 20px; bottom: 20px; z-index: 2147483001; display: flex; flex-direction: column; gap: 12px;
    font: 14px/1.4 Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #eef3f9; }
.wsc-card { width: 340px; max-width: calc(100vw - 32px); background: #121a25; border: 1px solid rgba(255,255,255,.12); border-radius: 18px;
    padding: 16px; box-shadow: 0 24px 60px rgba(0,0,0,.45); animation: wsc-in .22s ease-out; }
@keyframes wsc-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
.wsc-top { display: flex; align-items: center; gap: 12px; }
.wsc-av { width: 52px; height: 52px; border-radius: 50%; flex: 0 0 auto; overflow: hidden; display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 19px; color: #fff; animation: wsc-ring 1.8s ease-out infinite; }
.wsc-av img { width: 100%; height: 100%; object-fit: cover; }
@keyframes wsc-ring { 0% { box-shadow: 0 0 0 0 rgba(34,197,94,.55); } 80%,100% { box-shadow: 0 0 0 16px rgba(34,197,94,0); } }
.wsc-kind { font-size: 11.5px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: #86efac; }
.wsc-name { font-size: 17px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 230px; }
.wsc-sub { font-size: 12.5px; color: #9fb0c3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 230px; }
.wsc-actions { display: flex; gap: 8px; margin-top: 14px; }
.wsc-actions button { flex: 1; min-height: 42px; border-radius: 999px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.08);
    color: #eef3f9; font: inherit; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.wsc-actions button:hover { background: rgba(255,255,255,.14); }
.wsc-actions button:focus-visible { outline: 2px solid #5b8def; outline-offset: 2px; }
.wsc-actions .wsc-accept { background: #22c55e; border-color: transparent; color: #04210f; }
.wsc-actions .wsc-accept:hover { background: #34d46c; }
.wsc-actions .wsc-decline { background: #e5484d; border-color: transparent; color: #fff; }
.wsc-actions .wsc-decline:hover { background: #f06368; }
.wsc-actions svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
@media (max-width: 600px) {
    #wsc-root { inset: 0; right: 0; bottom: 0; justify-content: center; align-items: stretch; padding: 16px; background: rgba(5,8,12,.82); }
    #wsc-root:empty { display: none; }
    .wsc-card { width: auto; max-width: none; padding: 28px 18px 20px; text-align: center; }
    .wsc-top { flex-direction: column; }
    .wsc-av { width: 96px; height: 96px; font-size: 34px; }
    .wsc-name, .wsc-sub { max-width: 100%; }
    .wsc-name { font-size: 22px; }
    .wsc-actions { margin-top: 26px; }
    .wsc-actions button { min-height: 52px; }
}
#wsc-pill { position: fixed; top: 78px; left: 50%; transform: translateX(-50%); z-index: 2147483000; display: inline-flex; align-items: center; gap: 8px;
    padding: 9px 16px; border-radius: 999px; border: 0; cursor: pointer; background: #16a34a; color: #fff; font: 700 13.5px/1 Inter, system-ui, sans-serif;
    box-shadow: 0 10px 28px rgba(22,163,74,.4); }
#wsc-pill:hover { background: #15803d; }
#wsc-pill .dot { width: 8px; height: 8px; border-radius: 50%; background: #fff; animation: wsc-blink 1.4s ease-in-out infinite; }
@keyframes wsc-blink { 50% { opacity: .35; } }
.wsc-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483002; max-width: calc(100vw - 32px);
    background: #121a25; color: #eef3f9; border: 1px solid rgba(255,255,255,.14); padding: 11px 16px; border-radius: 12px;
    font: 600 13.5px/1.4 Inter, system-ui, sans-serif; box-shadow: 0 16px 40px rgba(0,0,0,.4); }
.wsc-toast.bad { border-color: rgba(239,68,68,.6); }
@media (prefers-reduced-motion: reduce) { .wsc-card, .wsc-av, #wsc-pill .dot { animation: none !important; } }`;
        document.head.appendChild(s);
    }
    function root() {
        injectStyles();
        let r = document.getElementById('wsc-root');
        if (!r) { r = document.createElement('div'); r.id = 'wsc-root'; document.body.appendChild(r); }
        return r;
    }

    const ICON = {
        phone: '<svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/></svg>',
        video: '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/></svg>',
        end: '<svg viewBox="0 0 24 24"><path d="M21 15.5v2a2 2 0 0 1-2.2 2 16 16 0 0 1-3.8-1.1 2 2 0 0 1-1.1-2.2l.3-1.4a12 12 0 0 0-4.4 0l.3 1.4A2 2 0 0 1 9 18.4a16 16 0 0 1-3.8 1.1A2 2 0 0 1 3 17.5v-2c0-.6.3-1.2.8-1.5a14 14 0 0 1 16.4 0c.5.3.8.9.8 1.5Z"/></svg>',
    };

    /* ----------------------------------------------------------- ringtone */
    const Ring = (() => {
        let ctx = null, timer = null, later = [];
        function beep(f, dur) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            try {
                if (!ctx) ctx = new AC();
                if (ctx.state === 'suspended') ctx.resume().catch(() => {});
                const t0 = ctx.currentTime, g = ctx.createGain(), o = ctx.createOscillator();
                o.frequency.value = f;
                g.gain.setValueAtTime(0, t0);
                g.gain.linearRampToValueAtTime(0.08, t0 + 0.02);
                g.gain.setValueAtTime(0.08, t0 + dur - 0.03);
                g.gain.linearRampToValueAtTime(0, t0 + dur);
                o.connect(g).connect(ctx.destination);
                o.start(t0); o.stop(t0 + dur + 0.02);
            } catch (e) { /* audio blocked until the user interacts */ }
        }
        function pattern() {
            beep(880, 0.16); later.push(setTimeout(() => beep(1175, 0.16), 200));
            later.push(setTimeout(() => beep(880, 0.16), 650)); later.push(setTimeout(() => beep(1175, 0.16), 850));
            // Browsers refuse (and warn) until the person has touched the page.
            const active = !navigator.userActivation || navigator.userActivation.hasBeenActive;
            try { if (navigator.vibrate && active) navigator.vibrate([300, 150, 300]); } catch (e) { /* needs a gesture */ }
        }
        return {
            /** True when this tab can make a sound: a never-touched background tab usually cannot. */
            probe() {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return Promise.resolve(false);
                try { if (!ctx) ctx = new AC(); } catch (e) { return Promise.resolve(false); }
                if (ctx.state === 'running') return Promise.resolve(true);
                const c = ctx;
                return Promise.race([c.resume().then(() => c.state === 'running').catch(() => false), sleep(300).then(() => false)])
                    .then(ok => { if (!ok && !timer && ctx === c) { c.close().catch(() => {}); ctx = null; } return ok; });
            },
            start() { if (timer) return; pattern(); timer = setInterval(pattern, 2600); },
            stop() {
                if (timer) clearInterval(timer);
                timer = null;
                later.forEach(clearTimeout); later = [];
                try { if (navigator.vibrate) navigator.vibrate(0); } catch (e) { /* ignore */ }
                if (ctx) { ctx.close().catch(() => {}); ctx = null; }
            },
        };
    })();

    /* ----------------------------------------------------------- incoming */
    async function showIncoming(arg) {
        if (isCallPage) return;
        const id = typeof arg === 'string' ? arg : arg && arg.id;
        if (!id || S.incoming.has(id) || S.active === id) return;
        const entry = { id, el: null, timer: null, release: null, ringing: false, notif: null };
        S.incoming.set(id, entry);
        let c = typeof arg === 'object' && arg.participants ? arg : null;
        try { if (!c) c = await rpc('ws_call_get', { p_call: id }); }
        catch (e) { S.incoming.delete(id); return; }
        if (S.incoming.get(id) !== entry) return;            // dismissed while loading
        if (c.now) S.skew = Date.parse(c.now) - Date.now();
        const mine = (c.participants || []).find(p => p.user_id === S.uid);
        if (!mine || mine.role !== 'callee' || !['invited', 'ringing'].includes(mine.state) || !['ringing', 'active'].includes(c.status)) {
            S.incoming.delete(id);
            return;
        }
        const [caller, group] = await Promise.all([profile(c.created_by), c.conversation_id ? groupName(c.conversation_id) : Promise.resolve(null)]);
        if (S.incoming.get(id) !== entry) return;
        const callerName = (caller && (caller.full_name || (caller.email || '').split('@')[0])) || 'Someone';
        const video = c.media === 'video';
        entry.call = c;

        const card = document.createElement('div');
        card.className = 'wsc-card';
        card.setAttribute('role', 'alertdialog');
        card.setAttribute('aria-label', `${video ? 'Video' : 'Voice'} call from ${callerName}`);
        const av = caller && caller.avatar_url
            ? `<img src="${esc(caller.avatar_url)}" alt="">`
            : esc(initials(group || callerName));
        card.innerHTML = `
            <div class="wsc-top">
                <span class="wsc-av" style="background:${pickColor(group || callerName)}">${av}</span>
                <div style="min-width:0">
                    <div class="wsc-kind">${group ? 'Group ' + (video ? 'video' : 'voice') + ' call' : 'Incoming ' + (video ? 'video' : 'voice') + ' call'}</div>
                    <div class="wsc-name">${esc(group || callerName)}</div>
                    <div class="wsc-sub">${esc(group ? callerName + ' is calling' : 'WorkSuite')}</div>
                </div>
            </div>
            <div class="wsc-actions">
                <button type="button" class="wsc-decline" data-act="decline">${ICON.end}Decline</button>
                ${video ? '<button type="button" data-act="audio">Audio only</button>' : ''}
                <button type="button" class="wsc-accept" data-act="accept">${video ? ICON.video : ICON.phone}Accept</button>
            </div>`;
        const img = card.querySelector('.wsc-av img');
        if (img) img.onerror = () => { img.parentNode.textContent = initials(callerName); };
        card.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-act]');
            if (!b) return;
            const act = b.dataset.act;
            if (act === 'decline') return decline(id);
            accept(id, act === 'audio');
        });
        entry.el = card;
        root().appendChild(card);
        setTimeout(() => { const a = card.querySelector('.wsc-accept'); if (a && !isPhone()) { try { a.focus({ preventScroll: true }); } catch (x) { /* ignore */ } } }, 50);

        startRing(entry);
        if (mine.state === 'invited') rpc('ws_call_action', { p_call: id, p_action: 'ringing', p_device: null }).catch(() => {});
        if (document.hidden) pageNotification(entry, callerName, group, video);
        emit('ws:call-incoming', { callId: id, callerId: c.created_by, callerName, media: c.media });

        // Realtime normally ends the ringing; poll too, so a dropped connection cannot leave a
        // card ringing for a call that was answered elsewhere or given up.
        const recheck = () => {
            entry.timer = setTimeout(async () => {
                if (S.incoming.get(id) !== entry) return;
                try {
                    const st = await rpc('ws_call_get', { p_call: id });
                    const me = (st.participants || []).find(p => p.user_id === S.uid);
                    if (!me || !['invited', 'ringing'].includes(me.state) || !['ringing', 'active'].includes(st.status)) {
                        return dismiss(id, me && me.state === 'joined' ? 'answered-elsewhere' : (me && me.state) || 'missed');
                    }
                } catch (e) { return dismiss(id, 'missed'); }
                recheck();
            }, POLL_MS);
        };
        recheck();
    }

    /**
     * One tab per browser rings; the others just show the card. The ringing tab must be able to
     * make a sound — a background tab nobody has touched gets a silent AudioContext — so a tab
     * takes the lock only when it can play, lets go otherwise, and every tab keeps retrying in case
     * the ringing one goes away. Visible tabs get a head start.
     */
    function startRing(entry) {
        const live = () => S.incoming.get(entry.id) === entry;
        const retry = (ms) => { clearTimeout(entry.ringRetry); if (live() && !entry.ringing) entry.ringRetry = setTimeout(attempt, ms); };
        const take = async () => {
            if (!live() || entry.ringing) return false;
            const ua = navigator.userActivation;
            if (!(ua && ua.hasBeenActive) && !(await Ring.probe())) return false;
            if (!live()) return false;
            entry.ringing = true;
            Ring.start();
            return true;
        };
        async function attempt() {
            entry.ringRetry = null;
            if (!live() || entry.ringing) return;
            if (document.hidden && !entry.waited) { entry.waited = true; return retry(1500); }
            if (navigator.locks && navigator.locks.request) {
                navigator.locks.request('ws-ring-' + entry.id, { ifAvailable: true }, async (lock) => {
                    if (!lock) return retry(3000);                  // another tab rings; check again later
                    if (!(await take())) return retry(3000);        // can't play here: let go of the lock
                    return new Promise(res => { entry.release = res; });
                }).catch(() => take().then(ok => { if (!ok) retry(3000); }));
            } else if (!(await take())) retry(3000);
        }
        entry.retryRing = () => { if (live() && !entry.ringing) { clearTimeout(entry.ringRetry); attempt(); } };
        attempt();
    }
    function stopRing(entry) {
        clearTimeout(entry.ringRetry);
        entry.ringing = false;
        if (![...S.incoming.values()].some(x => x.ringing)) Ring.stop();
        if (entry.release) { entry.release(); entry.release = null; }
    }

    function pageNotification(entry, callerName, group, video) {
        try {
            if (!('Notification' in window) || Notification.permission !== 'granted') return;
            const n = new Notification(group ? `${group} · group call` : `${callerName}`, {
                body: group ? `${callerName} is calling the group` : `Incoming ${video ? 'video' : 'voice'} call`,
                tag: 'call-' + entry.id, requireInteraction: true, renotify: true, icon: '/icon-192.png',
            });
            n.onclick = () => { try { window.focus(); } catch (e) { /* ignore */ } n.close(); };
            entry.notif = n;
        } catch (e) { /* Android needs the service worker for this; the push covers it */ }
    }

    function dismiss(id, reason) {
        const entry = S.incoming.get(id);
        if (!entry) return;
        S.incoming.delete(id);
        clearTimeout(entry.timer);
        if (entry.el) entry.el.remove();
        stopRing(entry);
        if (entry.notif) { try { entry.notif.close(); } catch (e) { /* gone */ } }
        closeSwNotifications(id);
        emit('ws:call-ended', { callId: id, reason });
        if (reason !== 'answered') emit('ws:call-resume', { callId: id, reason });
        const r = document.getElementById('wsc-root');
        if (r && !r.children.length) r.remove();
    }

    function accept(id, audioOnly) {
        if (!window.RTCPeerConnection) { toast('This browser can’t make calls. Try Chrome, Edge, Firefox or Safari.', 'bad'); return; }
        S.taken.add(id);
        open(id, { answer: true, audioOnly });   // synchronous: we are inside the click
        dismiss(id, 'answered');
    }

    async function decline(id) {
        dismiss(id, 'declined');
        try {
            await rpc('ws_call_action', { p_call: id, p_action: 'decline', p_device: null });
            push({ action: 'call-end', call_id: id });          // stop it ringing on my other devices
        }
        catch (e) { /* the invitation times out by itself */ }
    }

    function onRow(row) {
        if (!row || !row.call_id || row.user_id !== S.uid) return;
        const pending = row.role === 'callee' && (row.state === 'invited' || row.state === 'ringing');
        if (pending) showIncoming(row.call_id);
        else if (S.incoming.has(row.call_id)) dismiss(row.call_id, row.state === 'joined' ? (S.taken.has(row.call_id) ? 'answered' : 'answered-elsewhere') : row.state);
    }

    async function checkLive() {
        if (!S.sb || !S.uid || isCallPage) return;
        S.lastCheck = Date.now();
        let list;
        try { list = await rpc('ws_call_live'); } catch (e) { return; }   // calls not set up yet: stay quiet
        if (!Array.isArray(list)) list = [];
        const live = new Set();
        list.forEach(c => {
            const mine = (c.participants || []).find(p => p.user_id === S.uid);
            if (mine && mine.role === 'callee' && ['invited', 'ringing'].includes(mine.state)) { live.add(c.id); showIncoming(c); }
        });
        [...S.incoming.keys()].forEach(id => { if (!live.has(id) && S.incoming.get(id).call) dismiss(id, 'missed'); });
    }

    /* -------------------------------------------------- starting / opening */
    function callUrl(id, o) {
        o = o || {};
        return '/call/?id=' + encodeURIComponent(id) + (o.answer ? '&answer=1' : '') + (o.audioOnly ? '&audio=1' : '');
    }
    function sameTab(url) {
        location.href = url + '&return=' + encodeURIComponent(location.pathname + location.search + location.hash);
        return null;
    }
    function open(id, o) {
        const url = callUrl(id, o);
        if (isPhone()) return sameTab(url);
        let w = null;
        try { w = window.open('', 'ws-call-' + id, FEATURES); } catch (e) { w = null; }
        if (!w) return sameTab(url);                          // popup blocked
        S.windows.set(id, w);
        let blank = true;
        try { blank = !w.location.href || w.location.href === 'about:blank'; } catch (e) { blank = false; }
        if (blank) w.location.replace(url);                  // an open call window keeps its call
        try { w.focus(); } catch (e) { /* ignore */ }
        return w;
    }
    function writeStarting(w, video) {
        try {
            w.document.open();
            w.document.write('<!DOCTYPE html><title>Starting call…</title><meta name="viewport" content="width=device-width,initial-scale=1">' +
                '<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1017;color:#eef3f9;font:600 16px system-ui,sans-serif">' +
                (video ? 'Starting video call…' : 'Starting call…') + '</body>');
            w.document.close();
        } catch (e) { /* cross-origin or closed */ }
    }

    function start(opts) {
        opts = opts || {};
        const video = !!opts.video;
        const conv = opts.conversationId || null;
        const ids = (opts.userIds || []).filter(Boolean);
        if (!window.RTCPeerConnection) { toast('This browser can’t make calls. Try Chrome, Edge, Firefox or Safari.', 'bad'); return Promise.resolve(null); }
        if (!S.sb || !S.uid) { toast('Calls are still starting up — try again in a moment', 'bad'); return Promise.resolve(null); }
        if (!conv && !ids.length) return Promise.resolve(null);
        if (S.active) { focusActive(); toast('You are already in a call'); return Promise.resolve(null); }
        // The window must open now, inside the click, or the popup blocker stops it.
        const phone = isPhone();
        let win = null;
        if (!phone) {
            try { win = window.open('', '', FEATURES); } catch (e) { win = null; }
            if (win) writeStarting(win, video);
        }
        return (async () => {
            try {
                const id = await rpc('ws_call_start', { p_callees: conv ? null : ids, p_media: video ? 'video' : 'audio', p_conversation: conv });
                if (!id) throw new Error('No call was created');
                if (win && win.closed) {
                    // The "Starting call…" window was closed before the server answered: that is a
                    // cancel, not a reason to pull this tab into the call.
                    rpc('ws_call_action', { p_call: id, p_action: 'leave', p_device: null }).catch(() => {});
                    return null;
                }
                push({ action: 'call', call_id: id });
                // A group may already have a call going: the page then simply joins it.
                const url = callUrl(id, { answer: !!conv });
                if (win) {
                    try { win.name = 'ws-call-' + id; } catch (e) { /* ignore */ }
                    S.windows.set(id, win);
                    win.location.replace(url);
                    try { win.focus(); } catch (e) { /* ignore */ }
                } else {
                    sameTab(url);                              // phones, or the popup was blocked
                }
                return id;
            } catch (e) {
                if (win) { try { win.close(); } catch (x) { /* ignore */ } }
                toast(friendly(e), 'bad');
                return null;
            }
        })();
    }

    function join(callId) { if (callId) open(callId, { answer: true }); }

    /* ------------------------------------------------ the open call window */
    function focusActive() {
        if (!S.active) return;
        // The window focuses itself on this message; a window this page opened can also be focused directly.
        try { if (S.bc) S.bc.postMessage({ type: 'call-focus', callId: S.active }); } catch (e) { /* closed */ }
        const w = S.windows.get(S.active);
        if (w && !w.closed) { try { w.focus(); } catch (e) { /* ignore */ } }
    }
    function showPill() {
        if (isCallPage) return;
        injectStyles();
        let p = document.getElementById('wsc-pill');
        if (!p) {
            p = document.createElement('button');
            p.type = 'button';
            p.id = 'wsc-pill';
            p.innerHTML = '<span class="dot"></span><span>Return to call</span>';
            p.addEventListener('click', focusActive);
            document.body.appendChild(p);
        }
    }
    function hidePill() { const p = document.getElementById('wsc-pill'); if (p) p.remove(); }
    function setActive(id) {
        const was = S.active;
        S.active = id;
        if (id) { S.activeAt = Date.now(); showPill(); } else hidePill();
        if (was !== id) emit('ws:call-active', { callId: id });
        if (!id && was && S.taken.has(was)) { S.taken.delete(was); emit('ws:call-resume', { callId: was, reason: 'ended' }); }
    }
    function setupBroadcast() {
        if (!('BroadcastChannel' in window)) return;
        try { S.bc = new BroadcastChannel('ws-calls'); } catch (e) { return; }
        S.bc.onmessage = (e) => {
            const m = e.data || {};
            if (m.type !== 'call-state' || !m.callId) return;
            // A call window showing Accept / Decline has not taken the call: keep ringing here.
            if (m.state === 'incoming') return;
            if (m.state === 'ended') {
                S.windows.delete(m.callId);
                if (S.active === m.callId || !S.active) setActive(null);
                if (S.taken.has(m.callId)) { S.taken.delete(m.callId); emit('ws:call-resume', { callId: m.callId, reason: 'ended' }); }
                return;
            }
            // Picked up in a call window (a notification can open one): resume this page when it ends.
            if (S.incoming.has(m.callId)) { S.taken.add(m.callId); dismiss(m.callId, 'answered'); }
            if (S.active !== m.callId) setActive(m.callId);
            else S.activeAt = Date.now();
        };
        // A window closed without saying goodbye (crash, killed) stops reporting.
        setInterval(() => { if (S.active && Date.now() - S.activeAt > 12000) setActive(null); }, 4000);
    }

    /* --------------------------------------------------------------- boot */
    function findClient() {
        const c = window.__WS_SB__ || window.__WS_PRESENCE_SB__;
        return c && c.auth && typeof c.rpc === 'function' ? c : null;
    }
    async function getClient() {
        for (let i = 0; i < 150; i++) {
            const c = findClient();
            if (c) return c;
            await sleep(100);
        }
        if (!window.supabase || !window.supabase.createClient) return null;
        try {
            const cfg = await (await fetch('/api/config')).json();
            if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey) return null;
            const c = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
            if (!window.__WS_SB__) window.__WS_SB__ = c;
            return c;
        } catch (e) { return null; }
    }

    function subscribe() {
        if (!S.sb || !S.uid || isCallPage) return;
        if (S.channel) { try { S.sb.removeChannel(S.channel); } catch (e) { /* closed */ } }
        const filter = 'user_id=eq.' + S.uid;
        S.channel = S.sb.channel('wscalls:' + S.uid + ':' + Math.random().toString(36).slice(2, 8))
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_participants', filter }, (p) => onRow(p && p.new))
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'call_participants', filter }, (p) => onRow(p && p.new))
            .subscribe((status) => {
                // Every (re)subscription can have missed an invite that landed just before it: catch up.
                if (status === 'SUBSCRIBED') checkLive();
            });
    }

    async function onSignedIn(session) {
        if (S.uid === session.user.id) { S.session = session; return; }
        S.uid = session.user.id;
        S.session = session;
        subscribe();
        checkLive();
    }
    function onSignedOut() {
        [...S.incoming.keys()].forEach(id => dismiss(id, 'signed-out'));
        if (S.channel) { try { S.sb.removeChannel(S.channel); } catch (e) { /* closed */ } }
        S.channel = null; S.uid = null; S.session = null;
    }

    let readyResolve;
    const ready = new Promise(r => { readyResolve = r; });
    async function init() {
        setupBroadcast();
        const sb = await getClient();
        if (!sb) return readyResolve(false);
        S.sb = sb;
        try {
            const { data } = await sb.auth.getSession();
            if (data && data.session) await onSignedIn(data.session);
            sb.auth.onAuthStateChange((ev, s) => {
                if (ev === 'SIGNED_OUT') return onSignedOut();
                if (s && s.user) onSignedIn(s);
            });
        } catch (e) { /* signed out */ }
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            S.incoming.forEach(e => e.retryRing && e.retryRing());
            if (Date.now() - S.lastCheck > 10000) checkLive();
        });
        // A tap makes this tab able to ring, if it could not before.
        document.addEventListener('pointerdown', () => S.incoming.forEach(e => e.retryRing && e.retryRing()), true);
        readyResolve(!!S.uid);
    }

    window.WSCalls = {
        start, join, open,
        get activeCall() { return S.active; },
        get supported() { return !!window.RTCPeerConnection; },
        ready,
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
