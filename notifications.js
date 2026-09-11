// ============================================================
// WorkSuite — Global notifications (messages, bell items, calls)
// Include on any authenticated page AFTER supabase-js and presence.js:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="/presence.js"></script>
//   <script src="/notifications.js"></script>
//
// Provides:
//   - Toast + browser Notification for new direct messages arriving on any page.
//     Click the toast → jump to /chat/#thread=<sender_id>.
//   - Toast for in-app notifications (task assigned, mention, missed call…).
//   - Incoming calls: loads /calls.js, which rings on this page and opens the
//     call in its own window (so answering never navigates away from your work).
//   - Online status: joins the shared presence channel, and
//     window.wsRenderOnlineDot(el, lastSeenISO) for pages that show dots.
//   - A "Home" button on old tool pages that are not inside the app shell.
// Messenger (/chat/) has its own richer UI and does not load this file.
// ============================================================
(function () {
    if (window.__WS_NOTIF__) return;
    window.__WS_NOTIF__ = true;

    const isChatPage = /\/(chat|messenger)\/?($|[?#])/.test(location.pathname);
    const isHomePage = /^\/(index\.html)?$/.test(location.pathname);

    let sb = null;
    let currentUserId = null;
    let currentUserName = 'You';

    // ---------- Styles (injected once) ----------
    function injectStyles() {
        if (document.getElementById('ws-notif-styles')) return;
        const s = document.createElement('style');
        s.id = 'ws-notif-styles';
        s.textContent = `
            #ws-notif-root { position: fixed; top: 20px; right: 20px; z-index: 2147483000;
                display: flex; flex-direction: column; gap: 12px; pointer-events: none; }
            .ws-toast { pointer-events: auto; min-width: 280px; max-width: 360px;
                background: rgba(15,23,42,0.96); color: #fff; padding: 14px 16px;
                border-radius: 16px; box-shadow: 0 20px 50px rgba(0,0,0,.45);
                border: 1px solid rgba(255,255,255,.08);
                backdrop-filter: blur(20px);
                display: flex; gap: 12px; cursor: pointer;
                animation: ws-slide-in .25s ease-out; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
            .ws-toast:hover { background: rgba(30,41,59,0.98); transform: translateY(-1px); }
            .ws-toast .ws-toast-ic { width: 44px; height: 44px; border-radius: 50%;
                display:flex; align-items:center; justify-content:center;
                background: linear-gradient(135deg,#3b82f6,#6366f1); font-weight: 800; font-size: 18px; color: #fff; flex-shrink: 0; overflow: hidden; }
            .ws-toast .ws-toast-ic img { width:100%; height:100%; object-fit:cover; }
            .ws-toast .ws-toast-body { flex: 1; min-width: 0; }
            .ws-toast .ws-toast-title { font-weight: 800; font-size: 14px; margin-bottom: 2px;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .ws-toast .ws-toast-msg { font-size: 13px; color: #cbd5e1;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .ws-toast .ws-toast-close { padding: 4px; opacity: .6; cursor: pointer; }
            .ws-toast .ws-toast-close:hover { opacity: 1; }
            @keyframes ws-slide-in { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: none; } }

            .ws-online-dot { position: absolute; bottom: 0; right: 0;
                width: 12px; height: 12px; border-radius: 50%;
                background: #10b981; border: 2px solid #0b1120;
                box-shadow: 0 0 0 1px rgba(16,185,129,.4); }
            .ws-online-dot.offline { background: #64748b; box-shadow: none; }

            /* Universal back-to-home button */
            .ws-back-btn {
                position: fixed; top: 14px; left: 14px; z-index: 2147482000;
                display: inline-flex; align-items: center; gap: 8px;
                padding: 9px 14px 9px 12px; border-radius: 999px;
                background: rgba(15,23,42,0.85); color: #fff;
                border: 1px solid rgba(255,255,255,.12);
                font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
                font-weight: 700; font-size: 13px; text-decoration: none;
                backdrop-filter: blur(14px);
                box-shadow: 0 6px 20px rgba(0,0,0,.35);
                transition: transform .15s ease, background .15s ease; }
            .ws-back-btn:hover { background: rgba(30,41,59,0.95); transform: translateY(-1px); }
            .ws-back-btn svg { width: 16px; height: 16px; }
        `;
        document.head.appendChild(s);
    }

    function ensureRoot() {
        let r = document.getElementById('ws-notif-root');
        if (!r) {
            r = document.createElement('div');
            r.id = 'ws-notif-root';
            document.body.appendChild(r);
        }
        return r;
    }

    function pickColor(name) {
        const colors = ['#3b82f6','#6366f1','#8b5cf6','#ec4899','#f43f5e','#f97316','#eab308','#22c55e','#14b8a6','#0ea5e9'];
        let h = 0;
        for (let i = 0; i < (name||'').length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
        return colors[Math.abs(h) % colors.length];
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function showToast({ icon, title, message, avatarUrl, onClick, ttl = 6000 }) {
        injectStyles();
        const root = ensureRoot();
        const t = document.createElement('div');
        t.className = 'ws-toast';
        const initial = (title || '?').charAt(0).toUpperCase();
        const bg = pickColor(title || '');
        const iconInner = avatarUrl
            ? `<img src="${escapeHtml(avatarUrl)}" alt="">`
            : escapeHtml(icon ? icon : initial);
        t.innerHTML = `
            <div class="ws-toast-ic" style="background:${bg};">${iconInner}</div>
            <div class="ws-toast-body">
                <div class="ws-toast-title">${escapeHtml(title || '')}</div>
                <div class="ws-toast-msg">${escapeHtml(message || '')}</div>
            </div>
            <div class="ws-toast-close" aria-label="Dismiss">✕</div>`;
        t.addEventListener('click', (e) => {
            if (e.target.classList.contains('ws-toast-close')) { t.remove(); return; }
            if (typeof onClick === 'function') onClick();
            t.remove();
        });
        root.appendChild(t);
        setTimeout(() => { try { t.remove(); } catch {} }, ttl);
    }

    // One line for a message body, the way Messenger shows it (never the raw
    // __FILE__ / __CALL__ markers). null = not worth a toast (call logs: the
    // missed-call bell already covers them).
    function previewOf(body) {
        const b = String(body == null ? '' : body);
        if (b.startsWith('__CALL__::')) return null;
        if (b === '__DELETED__') return null;
        if (b.startsWith('__FILE__::')) {
            const parts = b.split('::');
            const mime = parts[2] || '', name = parts.slice(4).join('::') || 'a file';
            if (mime.startsWith('image/')) return '📷 Photo';
            if (mime.startsWith('audio/')) return '🎤 Voice message';
            if (mime.startsWith('video/')) return '🎬 Video';
            return '📎 ' + name;
        }
        return b.replace(/\s+/g, ' ').trim().slice(0, 120) || 'New message';
    }

    // ---------- Browser Notification ----------
    function askBrowserPermission() {
        try {
            if (!('Notification' in window)) return;
            if (Notification.permission === 'default') Notification.requestPermission().catch(() => {});
        } catch {}
    }
    function browserNotify(title, body, tag, url) {
        try {
            if (!('Notification' in window)) return;
            if (Notification.permission !== 'granted') return;
            if (document.visibilityState === 'visible') return; // don't nag when tab is active
            const n = new Notification(title, { body, tag, icon: '/icon-192.png' });
            n.onclick = () => { window.focus(); if (url) location.href = url; n.close(); };
        } catch {}
    }

    function playPing() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.setValueAtTime(1200, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.15);
            gain.gain.setValueAtTime(0.15, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
            osc.connect(gain); gain.connect(ctx.destination);
            osc.start(); osc.stop(ctx.currentTime + 0.4);
            setTimeout(() => ctx.close(), 500);
        } catch {}
    }

    // ---------- Calls: the global ringer lives in /calls.js ----------
    function loadCalls() {
        if (window.WSCalls || document.querySelector('script[src$="/calls.js"]')) return;
        const s = document.createElement('script');
        s.src = '/calls.js';
        s.async = true;
        document.head.appendChild(s);
    }

    // ---------- Universal back-to-home button ----------
    function injectBackButton() {
        if (isHomePage) return;
        // Pages in the app shell have Home in the sidebar already.
        if (document.body && document.body.classList.contains('ws-app')) return;
        if (document.querySelector('.ws-back-btn')) return;
        const a = document.createElement('a');
        a.className = 'ws-back-btn';
        a.href = '/';
        a.title = 'Back to WorkSuite home';
        a.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
            <span>Home</span>`;
        (document.body || document.documentElement).appendChild(a);
    }

    // ---------- Online-dot helper ----------
    window.wsRenderOnlineDot = function (el, lastSeenISO) {
        if (!el) return;
        let dot = el.querySelector(':scope > .ws-online-dot');
        if (!dot) {
            dot = document.createElement('span');
            dot.className = 'ws-online-dot';
            // The parent needs relative positioning
            const cs = getComputedStyle(el);
            if (cs.position === 'static') el.style.position = 'relative';
            el.appendChild(dot);
        }
        const online = window.wsIsOnlineByLastSeen && window.wsIsOnlineByLastSeen(lastSeenISO);
        dot.classList.toggle('offline', !online);
        dot.title = online ? 'Online' : (lastSeenISO ? ('Last seen ' + new Date(lastSeenISO).toLocaleString()) : 'Offline');
    };

    // ---------- Init ----------
    async function waitForSupabase() {
        for (let i = 0; i < 100; i++) {
            if (window.supabase && typeof window.supabase.createClient === 'function') return true;
            await new Promise(r => setTimeout(r, 100));
        }
        return false;
    }

    async function init() {
        // Back button and styles apply to every non-home page, even if not logged in
        injectStyles();
        injectBackButton();
        if (isChatPage) return; // Messenger has its own UI
        try {
            if (!(await waitForSupabase())) return;
            // Reuse a client that the page or presence.js already created
            if (window.__WS_SB__?.auth?.getSession) sb = window.__WS_SB__;
            else if (window.__WS_PRESENCE_SB__?.auth?.getSession) sb = window.__WS_PRESENCE_SB__;
            else {
                const r = await fetch('/api/config');
                const cfg = await r.json();
                if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) return;
                sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
                    auth: { persistSession: true, autoRefreshToken: true }
                });
                window.__WS_SB__ = window.__WS_SB__ || sb;
            }

            const { data: { session } } = await sb.auth.getSession();
            if (!session) return; // not logged in — nothing to notify about
            currentUserId = session.user.id;
            loadCalls();

            // Load our own display name for presence
            try {
                const { data: me } = await sb.from('profiles').select('full_name,email').eq('id', currentUserId).single();
                currentUserName = me?.full_name || me?.email || 'Someone';
            } catch {}

            askBrowserPermission();
            ensureRoot();

            // New direct messages
            sb.channel(`notif:msgs:${currentUserId}`)
                .on('postgres_changes',
                    { event: 'INSERT', schema: 'public', table: 'messages', filter: `recipient_id=eq.${currentUserId}` },
                    async ({ new: m }) => {
                        if (window.WSShell && WSShell.refreshUnread) WSShell.refreshUnread();
                        const preview = previewOf(m.body);
                        if (!preview) return;
                        let name = 'Someone', avatar = null;
                        try {
                            const { data: p } = await sb.from('profiles').select('full_name,email,avatar_url').eq('id', m.sender_id).single();
                            if (p) { name = p.full_name || p.email || 'Someone'; avatar = p.avatar_url; }
                        } catch {}
                        const url = `/chat/#thread=${encodeURIComponent(m.sender_id)}`;
                        showToast({ title: name, message: preview, avatarUrl: avatar, onClick: () => { location.href = url; } });
                        playPing();
                        // Same tag as the Web Push for this conversation, so only one notification shows.
                        browserNotify(name, preview, `dm-${m.sender_id}`, url);
                    })
                .subscribe();

            // In-app notifications (task assigned, mention, meeting invite, missed call…) written
            // by database triggers. The shell keeps the bell count; this shows the toast.
            try {
                sb.channel(`notif:inbox:${currentUserId}`)
                    .on('postgres_changes',
                        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${currentUserId}` },
                        ({ new: n }) => {
                            if (!n || !n.title) return;
                            const icon = /^call/.test(n.kind) ? '📞' : /task/.test(n.kind) ? '✅' : /mention/.test(n.kind) ? '💬' : /event/.test(n.kind) ? '📅' : /deal|lead|contact/.test(n.kind) ? '🎯' : /project/.test(n.kind) ? '📁' : '🔔';
                            showToast({ icon, title: n.title, message: n.body || '', onClick: () => { if (n.url) location.href = n.url; } });
                            playPing();
                            browserNotify(n.title, n.body || '', `ws-notif-${n.kind}`, n.url);
                        })
                    .subscribe();
            } catch (e) { /* the notifications table is optional until the CRM migration runs */ }

            // Online status: the same presence channel Messenger reads.
            const presence = sb.channel('presence:global', { config: { presence: { key: currentUserId } } });
            presence.subscribe(async (status) => {
                if (status === 'SUBSCRIBED') {
                    try { await presence.track({ user: currentUserId, name: currentUserName }); } catch {}
                }
            });
        } catch (e) { console.warn('[ws-notif] init failed', e); }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
