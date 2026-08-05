// ============================================================
// WorkSuite — Site-wide presence heartbeat
// Include on any authenticated page:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="/presence.js"></script>
// Updates profiles.last_seen_at every 30s while the tab is visible.
// A user is treated as ONLINE if their last_seen_at is within 60s.
// ============================================================
(function () {
    if (window.__WS_PRESENCE__) return;
    window.__WS_PRESENCE__ = true;

    const HEARTBEAT_MS = 30000; // 30s
    const IDLE_MS      = 60000; // don't tick when tab hidden longer than this
    let sb = null;
    let lastVisibleAt = Date.now();

    async function waitForSupabase() {
        for (let i = 0; i < 100; i++) {
            if (window.supabase && typeof window.supabase.createClient === 'function') return true;
            await new Promise(r => setTimeout(r, 100));
        }
        return false;
    }

    async function init() {
        try {
            if (!(await waitForSupabase())) return;

            // Reuse an existing shared client if one is already exposed by the page.
            if (window.__WS_SB__ && typeof window.__WS_SB__.auth?.getSession === 'function') {
                sb = window.__WS_SB__;
            } else {
                const r = await fetch('/api/config');
                const cfg = await r.json();
                if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) return;
                sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
                    auth: { persistSession: true, autoRefreshToken: true }
                });
                window.__WS_PRESENCE_SB__ = sb;
            }

            tick(); // fire immediately
            setInterval(() => {
                if (document.visibilityState !== 'visible') return;
                if (Date.now() - lastVisibleAt > IDLE_MS) return;
                tick();
            }, HEARTBEAT_MS);

            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    lastVisibleAt = Date.now();
                    tick();
                }
            });
            window.addEventListener('focus', () => { lastVisibleAt = Date.now(); tick(); });
            window.addEventListener('beforeunload', () => { try { tick(); } catch {} });
            // Any user activity refreshes the idle timer
            ['mousemove','keydown','click','touchstart','scroll'].forEach(evt =>
                window.addEventListener(evt, () => { lastVisibleAt = Date.now(); }, { passive: true }));
        } catch {}
    }

    async function tick() {
        if (!sb) return;
        try {
            const { data: { session } } = await sb.auth.getSession();
            if (!session) return;
            await sb.from('profiles')
                .update({ last_seen_at: new Date().toISOString() })
                .eq('id', session.user.id);
        } catch {}
    }

    // Expose a helper for pages that want to check if someone is online right now.
    window.wsIsOnlineByLastSeen = function (lastSeenISO, thresholdMs = 60000) {
        if (!lastSeenISO) return false;
        const t = new Date(lastSeenISO).getTime();
        if (isNaN(t)) return false;
        return (Date.now() - t) < thresholdMs;
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
