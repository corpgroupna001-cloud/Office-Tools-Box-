// ============================================================
// WorkSuite — global auth guard.
// Include on EVERY tool page (chat, typing test, quiz, signature,
// recordings…). If no Supabase session exists, the visitor is
// bounced to the home page login. The home page (/) and admin
// (/admin, which has its own password gate) are exempt.
//
// Self-contained: loads supabase-js from CDN if the page didn't.
// ============================================================
(function () {
    if (window.__WS_AUTHGUARD__) return;
    window.__WS_AUTHGUARD__ = true;

    const path = location.pathname.replace(/\/+$/, '') || '/';
    // Exempt pages: home hub (contains the login UI) and admin (password gate).
    if (path === '/' || path === '/index.html' || path.startsWith('/admin')) return;

    function toLogin() {
        // replace() so the guarded page doesn't linger in history.
        try { location.replace('/'); } catch { location.href = '/'; }
    }

    function loadSupabaseJs() {
        return new Promise((resolve) => {
            if (window.supabase && window.supabase.createClient) return resolve(true);
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
            s.onload = () => resolve(true);
            s.onerror = () => resolve(false);
            document.head.appendChild(s);
        });
    }

    async function run() {
        // Wait briefly in case the page is already loading supabase-js itself.
        for (let i = 0; i < 30 && !(window.supabase && window.supabase.createClient); i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        if (!(window.supabase && window.supabase.createClient)) {
            const ok = await loadSupabaseJs();
            if (!ok) return toLogin(); // can't verify → fail closed
        }
        try {
            let sb = window.__WS_SB__ || window.__WS_PRESENCE_SB__ || null;
            if (!sb) {
                const r = await fetch('/api/config');
                const cfg = await r.json();
                if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) return toLogin();
                sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
                    auth: { persistSession: true, autoRefreshToken: true }
                });
                window.__WS_SB__ = window.__WS_SB__ || sb;
            }
            const { data: { session } } = await sb.auth.getSession();
            if (!session) return toLogin();
            // Signed in — also bounce anyone who never finished email verification
            // (unless their company's email is still "coming soon").
            try {
                const { data: p } = await sb.from('profiles')
                    .select('email_verified, company')
                    .eq('id', session.user.id).maybeSingle();
                const COMING_SOON = ['Navyug Raise A Player Foundation', 'Raise a Player'];
                if (p && p.email_verified === false && !COMING_SOON.includes(p.company)) {
                    return toLogin(); // home page will run them through the OTP step
                }
            } catch { /* profile fetch failed — allow through rather than loop */ }
        } catch {
            toLogin();
        }
    }
    run();
})();
