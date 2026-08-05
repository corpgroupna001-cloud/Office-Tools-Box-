// ============================================================
// WorkSuite — Global notifications (messages + incoming calls)
// Include on any authenticated page AFTER supabase-js and presence.js:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="/presence.js"></script>
//   <script src="/notifications.js"></script>
//
// Provides:
//   - Toast + browser Notification for new chat messages arriving on any page.
//     Click the toast → jump to /chat/#thread=<sender_id>.
//   - Full-screen incoming-call banner. Accept → /chat/#answer=<caller_id>&video=<0|1>
//     Chat page auto-accepts the next offer broadcast from that caller.
//   - Realtime online-status via presence.js's last_seen_at + a helper
//     window.wsRenderOnlineDot(el, lastSeenISO)
// Suppressed automatically on the /chat/ page itself (chat has its own UI).
// ============================================================
(function () {
    if (window.__WS_NOTIF__) return;
    window.__WS_NOTIF__ = true;

    // Chat page suppresses this — it has its own richer UI.
    const isChatPage = /\/chat\/?($|[?#])/.test(location.pathname);
    // Home page — no back button needed
    const isHomePage = /^\/(index\.html)?$/.test(location.pathname);

    let sb = null;
    let currentUserId = null;
    let currentUserName = 'You';
    let callChannel = null;
    let inflightCall = null;
    let ringAudio = null;

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

            #ws-call-banner { position: fixed; inset: 0; z-index: 2147483001;
                display: none; align-items: center; justify-content: center;
                background: radial-gradient(circle at center, rgba(59,130,246,0.35), rgba(15,23,42,0.95));
                backdrop-filter: blur(30px);
                font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; }
            #ws-call-banner.show { display: flex; animation: ws-fade-in .25s ease-out; }
            @keyframes ws-fade-in { from { opacity: 0; } to { opacity: 1; } }
            #ws-call-banner .ws-cb-card { text-align: center; padding: 40px 32px; max-width: 420px; }
            #ws-call-banner .ws-cb-type { font-size: 12px; font-weight: 800; text-transform: uppercase;
                letter-spacing: 2px; color: rgba(255,255,255,.75); margin-bottom: 8px; }
            #ws-call-banner .ws-cb-avatar { width: 128px; height: 128px; border-radius: 50%;
                margin: 20px auto; background: linear-gradient(135deg,#3b82f6,#6366f1);
                display:flex; align-items:center; justify-content:center;
                font-size: 52px; font-weight: 900; color: #fff; overflow: hidden;
                box-shadow: 0 20px 60px rgba(59,130,246,.55);
                animation: ws-pulse 1.8s ease-in-out infinite; }
            #ws-call-banner .ws-cb-avatar img { width:100%; height:100%; object-fit:cover; }
            @keyframes ws-pulse {
                0%,100% { box-shadow: 0 20px 60px rgba(59,130,246,.55); transform: scale(1); }
                50%     { box-shadow: 0 20px 90px rgba(59,130,246,.85); transform: scale(1.03); }
            }
            #ws-call-banner .ws-cb-name { font-size: 28px; font-weight: 900; }
            #ws-call-banner .ws-cb-sub  { font-size: 14px; color: rgba(255,255,255,.7); margin-top: 4px; }
            #ws-call-banner .ws-cb-actions { display: flex; gap: 32px; justify-content: center; margin-top: 32px; }
            #ws-call-banner .ws-cb-btn { display: flex; flex-direction: column; align-items: center; gap: 8px;
                cursor: pointer; background: none; border: none; color: #fff;
                font-weight: 800; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; }
            #ws-call-banner .ws-cb-btn .ws-cb-btn-circle { width: 68px; height: 68px; border-radius: 50%;
                display:flex; align-items:center; justify-content:center;
                transition: transform .15s ease; box-shadow: 0 12px 30px rgba(0,0,0,.4); }
            #ws-call-banner .ws-cb-btn:hover .ws-cb-btn-circle { transform: scale(1.08); }
            #ws-call-banner .ws-cb-btn.decline .ws-cb-btn-circle {
                background: linear-gradient(135deg,#f43f5e,#dc2626); }
            #ws-call-banner .ws-cb-btn.accept  .ws-cb-btn-circle {
                background: linear-gradient(135deg,#10b981,#059669); }

            .ws-online-dot { position: absolute; bottom: 0; right: 0;
                width: 12px; height: 12px; border-radius: 50%;
                background: #10b981; border: 2px solid #0b1120;
                box-shadow: 0 0 0 1px rgba(16,185,129,.4); }
            .ws-online-dot.offline { background: #64748b; box-shadow: none; }

            /* Pause overlay while a call is incoming/in-progress */
            #ws-pause-overlay { position: fixed; inset: 0; z-index: 2147483000;
                display: none; align-items: flex-end; justify-content: center;
                background: rgba(15,23,42,0.35);
                backdrop-filter: blur(6px);
                pointer-events: auto;
                animation: ws-fade-in .3s ease-out;
                font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
            #ws-pause-overlay.show { display: flex; }
            #ws-pause-overlay .ws-pause-card {
                max-width: 520px; width: calc(100% - 32px);
                background: linear-gradient(180deg, rgba(15,23,42,0.97), rgba(11,17,32,0.98));
                border: 1px solid rgba(255,255,255,.08);
                border-radius: 24px 24px 0 0;
                padding: 24px 24px 32px; color: #fff;
                box-shadow: 0 -24px 60px rgba(0,0,0,.5);
                animation: ws-slide-up .35s cubic-bezier(.2,.9,.3,1); }
            @keyframes ws-slide-up { from { transform: translateY(80px); opacity: 0; } to { transform: none; opacity: 1; } }
            #ws-pause-overlay .ws-pause-title {
                display: flex; align-items: center; gap: 10px;
                font-size: 20px; font-weight: 900; margin-bottom: 6px; }
            #ws-pause-overlay .ws-pause-sub { font-size: 13px; color: rgba(255,255,255,.75); margin-bottom: 16px; }
            #ws-pause-overlay .ws-pause-rules {
                background: rgba(255,255,255,.05); border-radius: 14px; padding: 14px 16px;
                font-size: 12.5px; color: rgba(255,255,255,.85); line-height: 1.55; }
            #ws-pause-overlay .ws-pause-rules strong { color: #fff; }
            #ws-pause-overlay .ws-pause-rules ul { margin: 8px 0 0; padding-left: 20px; }
            #ws-pause-overlay .ws-pause-rules li { margin: 3px 0; }
            #ws-pause-overlay .ws-pause-actions { display: flex; gap: 10px; margin-top: 16px; justify-content: flex-end; }
            #ws-pause-overlay .ws-pause-btn {
                border: none; padding: 10px 18px; border-radius: 12px;
                font-size: 13px; font-weight: 800; cursor: pointer;
                background: rgba(255,255,255,.1); color: #fff; }
            #ws-pause-overlay .ws-pause-btn.primary { background: linear-gradient(135deg,#10b981,#059669); }

            /* Resume-session toast (shown after a call ends) */
            #ws-resume-banner {
                position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
                z-index: 2147483000; display: none;
                background: linear-gradient(135deg,#10b981,#059669);
                color: #fff; padding: 14px 24px; border-radius: 999px;
                font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
                font-weight: 800; font-size: 14px; cursor: pointer;
                box-shadow: 0 20px 50px rgba(16,185,129,.4);
                display: none; align-items: center; gap: 10px;
                animation: ws-slide-up .3s ease-out; }
            #ws-resume-banner.show { display: inline-flex; }
            #ws-resume-banner:hover { transform: translateX(-50%) translateY(-2px); }

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

    function showToast({ icon, title, message, avatarUrl, onClick, ttl = 6000 }) {
        injectStyles();
        const root = ensureRoot();
        const t = document.createElement('div');
        t.className = 'ws-toast';
        const initial = (title || '?').charAt(0).toUpperCase();
        const bg = pickColor(title || '');
        const iconInner = avatarUrl
            ? `<img src="${avatarUrl}">`
            : (icon ? icon : initial);
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

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    // ---------- Browser Notification ----------
    function askBrowserPermission() {
        try {
            if (!('Notification' in window)) return;
            if (Notification.permission === 'default') Notification.requestPermission().catch(() => {});
        } catch {}
    }
    function browserNotify(title, body, tag) {
        try {
            if (!('Notification' in window)) return;
            if (Notification.permission !== 'granted') return;
            if (document.visibilityState === 'visible') return; // don't nag when tab is active
            const n = new Notification(title, { body, tag, icon: '/favicon.ico' });
            n.onclick = () => { window.focus(); n.close(); };
        } catch {}
    }

    // ---------- Sounds ----------
    function playRingtone() {
        stopRingtone();
        try {
            const url = 'data:audio/wav;base64,UklGRoQGAABXQVZFZm10IBAAAAABAAEAgLsAAADuAAACABAAZGF0YWAGAAAAAP//AAAAAP//AAAAAP//';
            ringAudio = new Audio();
            // Use Web Audio API for a real ringtone tone
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            ringAudio._ctx = ctx;
            const play = () => {
                if (!ringAudio) return;
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.frequency.setValueAtTime(880, ctx.currentTime);
                osc.frequency.setValueAtTime(660, ctx.currentTime + 0.3);
                gain.gain.setValueAtTime(0.15, ctx.currentTime);
                gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
                osc.connect(gain); gain.connect(ctx.destination);
                osc.start(); osc.stop(ctx.currentTime + 0.6);
            };
            play();
            ringAudio._iv = setInterval(play, 1200);
        } catch (e) { /* audio init blocked, ignore */ }
    }
    function stopRingtone() {
        if (ringAudio) {
            try { if (ringAudio._iv) clearInterval(ringAudio._iv); } catch {}
            try { if (ringAudio._ctx) ringAudio._ctx.close(); } catch {}
            ringAudio = null;
        }
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

    // ---------- Incoming call banner ----------
    function ensureCallBanner() {
        let b = document.getElementById('ws-call-banner');
        if (b) return b;
        b = document.createElement('div');
        b.id = 'ws-call-banner';
        b.innerHTML = `
            <div class="ws-cb-card">
                <div class="ws-cb-type" id="ws-cb-type">Incoming call</div>
                <div class="ws-cb-avatar" id="ws-cb-avatar">?</div>
                <div class="ws-cb-name" id="ws-cb-name">Someone</div>
                <div class="ws-cb-sub"  id="ws-cb-sub">Ringing…</div>
                <div class="ws-cb-actions">
                    <button class="ws-cb-btn decline" id="ws-cb-decline">
                        <div class="ws-cb-btn-circle">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="23" y1="1" x2="1" y2="23"/></svg>
                        </div>
                        <span>Decline</span>
                    </button>
                    <button class="ws-cb-btn accept" id="ws-cb-accept">
                        <div class="ws-cb-btn-circle">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                        </div>
                        <span>Answer</span>
                    </button>
                </div>
            </div>`;
        document.body.appendChild(b);
        b.querySelector('#ws-cb-decline').addEventListener('click', declineCurrentCall);
        b.querySelector('#ws-cb-accept').addEventListener('click', acceptCurrentCall);
        return b;
    }

    function hideCallBanner() {
        const b = document.getElementById('ws-call-banner');
        if (b) b.classList.remove('show');
        stopRingtone();
    }

    function showIncomingCall(payload) {
        injectStyles();
        const b = ensureCallBanner();
        b.querySelector('#ws-cb-type').textContent = payload.isVideo ? 'Incoming video call' : 'Incoming voice call';
        b.querySelector('#ws-cb-name').textContent = payload.name || 'Someone';
        const av = b.querySelector('#ws-cb-avatar');
        if (payload.avatar_url) {
            av.innerHTML = `<img src="${escapeHtml(payload.avatar_url)}">`;
        } else {
            av.textContent = (payload.name || '?').charAt(0).toUpperCase();
            av.style.background = `linear-gradient(135deg, ${pickColor(payload.name)}, #6366f1)`;
        }
        b.classList.add('show');
        playRingtone();
        browserNotify(payload.name || 'Incoming call',
            payload.isVideo ? 'Video call — tap to answer' : 'Voice call — tap to answer',
            'ws-call');
        showPauseOverlay(payload);
        // Notify the host page so it can pause its own timer/activity
        window.dispatchEvent(new CustomEvent('ws:call-incoming', { detail: payload }));
        // Auto-dismiss after 30s
        clearTimeout(showIncomingCall._t);
        showIncomingCall._t = setTimeout(() => {
            if (inflightCall && inflightCall.from === payload.from) {
                hideCallBanner();
                inflightCall = null;
                onCallEnded('timeout');
            }
        }, 30000);
    }

    // ---------- Pause overlay (blocks host activity while call is incoming) ----------
    function ensurePauseOverlay() {
        let o = document.getElementById('ws-pause-overlay');
        if (o) return o;
        o = document.createElement('div');
        o.id = 'ws-pause-overlay';
        o.innerHTML = `
            <div class="ws-pause-card">
                <div class="ws-pause-title">⏸️ <span id="ws-pause-title-text">Session paused for incoming call</span></div>
                <div class="ws-pause-sub" id="ws-pause-sub">Your current activity has been paused. Please respond to the caller.</div>
                <div class="ws-pause-rules">
                    <strong>Rules & regulations while a call is active</strong>
                    <ul>
                        <li>Your ongoing task (typing test, quiz, etc.) is <strong>paused automatically</strong> — timers and progress are preserved.</li>
                        <li>Please decline or answer the call before continuing. Ignoring a call will not resume your session automatically.</li>
                        <li>You may not switch tabs or windows during a live call — your host organization may log tab-switching events.</li>
                        <li>All calls are peer-to-peer over WebRTC and are <strong>not recorded</strong> or stored by WorkSuite.</li>
                        <li>After the call ends, tap <em>Resume session</em> at the bottom of the screen to continue where you left off.</li>
                    </ul>
                </div>
            </div>`;
        document.body.appendChild(o);
        return o;
    }
    function showPauseOverlay(payload) {
        const o = ensurePauseOverlay();
        const t = document.getElementById('ws-pause-title-text');
        const s = document.getElementById('ws-pause-sub');
        if (t) t.textContent = `Session paused — ${payload.isVideo ? 'video' : 'voice'} call from ${payload.name || 'someone'}`;
        if (s) s.textContent = `Your current activity has been paused. Answer or decline the call above to continue.`;
        o.classList.add('show');
    }
    function hidePauseOverlay() {
        const o = document.getElementById('ws-pause-overlay');
        if (o) o.classList.remove('show');
    }

    function ensureResumeBanner() {
        let r = document.getElementById('ws-resume-banner');
        if (r) return r;
        r = document.createElement('div');
        r.id = 'ws-resume-banner';
        r.innerHTML = `<span>▶</span><span>Resume session</span>`;
        r.addEventListener('click', () => {
            r.classList.remove('show');
            window.dispatchEvent(new CustomEvent('ws:call-resume'));
        });
        document.body.appendChild(r);
        return r;
    }
    function showResumeBanner() {
        const r = ensureResumeBanner();
        r.classList.add('show');
        // Auto-dismiss after 60s
        clearTimeout(showResumeBanner._t);
        showResumeBanner._t = setTimeout(() => { r.classList.remove('show'); }, 60000);
    }

    function onCallEnded(reason) {
        hidePauseOverlay();
        // If the user declined or timed out — offer to resume immediately
        if (reason === 'decline' || reason === 'timeout') {
            showResumeBanner();
            window.dispatchEvent(new CustomEvent('ws:call-ended', { detail: { reason } }));
        } else {
            // For any other termination, still let host know
            window.dispatchEvent(new CustomEvent('ws:call-ended', { detail: { reason } }));
        }
    }

    function acceptCurrentCall() {
        if (!inflightCall) return;
        const { from, isVideo } = inflightCall;
        hideCallBanner();
        hidePauseOverlay();
        // Signal caller we're switching pages (they should keep rebroadcasting the offer)
        try {
            if (callChannel) {
                callChannel.send({
                    type: 'broadcast', event: 'call-hold',
                    payload: { from: currentUserId, to: from }
                });
            }
        } catch {}
        // Remember where the user was, so chat can offer to send them back
        try { sessionStorage.setItem('ws:returnFrom', location.href); } catch {}
        inflightCall = null;
        window.dispatchEvent(new CustomEvent('ws:call-ended', { detail: { reason: 'accepted' } }));
        // Navigate to chat with an auto-accept hash. Chat page will auto-answer next offer from this caller.
        location.href = `/chat/#answer=${encodeURIComponent(from)}&video=${isVideo ? 1 : 0}`;
    }

    function declineCurrentCall() {
        if (!inflightCall) return;
        try {
            if (callChannel) {
                callChannel.send({
                    type: 'broadcast', event: 'call-decline',
                    payload: { from: currentUserId, to: inflightCall.from }
                });
            }
        } catch {}
        inflightCall = null;
        hideCallBanner();
        onCallEnded('decline');
    }

    // ---------- Universal back-to-home button ----------
    function injectBackButton() {
        if (isHomePage) return;
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
        if (isChatPage) return; // chat has its own UI
        try {
            if (!(await waitForSupabase())) return;
            // Reuse a client that presence.js may have created
            if (window.__WS_SB__?.auth?.getSession) sb = window.__WS_SB__;
            else if (window.__WS_PRESENCE_SB__?.auth?.getSession) sb = window.__WS_PRESENCE_SB__;
            else {
                const r = await fetch('/api/config');
                const cfg = await r.json();
                if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) return;
                sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
                    auth: { persistSession: true, autoRefreshToken: true }
                });
            }

            const { data: { session } } = await sb.auth.getSession();
            if (!session) return; // not logged in — nothing to notify about
            currentUserId = session.user.id;

            // Load our own display name for signaling
            try {
                const { data: me } = await sb.from('profiles').select('full_name,email').eq('id', currentUserId).single();
                currentUserName = me?.full_name || me?.email || 'Someone';
            } catch {}

            askBrowserPermission();

            injectStyles();
            ensureRoot();

            // Subscribe to incoming messages
            const msgChan = sb.channel(`notif:msgs:${currentUserId}`)
                .on('postgres_changes',
                    { event: 'INSERT', schema: 'public', table: 'messages', filter: `recipient_id=eq.${currentUserId}` },
                    async ({ new: m }) => {
                        // Skip call-event messages (chat renders them; toasting them would be noise)
                        if (typeof m.body === 'string' && m.body.startsWith('__CALL__::')) return;
                        // Skip if same tab is chat (handled there) — cross-tab we still want to notify others.
                        // Fetch sender name/avatar
                        let name = 'Someone', avatar = null;
                        try {
                            const { data: p } = await sb.from('profiles').select('full_name,email,avatar_url').eq('id', m.sender_id).single();
                            if (p) { name = p.full_name || p.email || 'Someone'; avatar = p.avatar_url; }
                        } catch {}
                        const bodyPreview = (m.body || '').replace(/\s+/g, ' ').slice(0, 120) || 'Sent an attachment';
                        showToast({
                            title: name,
                            message: bodyPreview,
                            avatarUrl: avatar,
                            onClick: () => { location.href = `/chat/#thread=${encodeURIComponent(m.sender_id)}`; }
                        });
                        playPing();
                        browserNotify(name, bodyPreview, `ws-msg-${m.sender_id}`);
                    })
                .subscribe();

            // Presence + call channel — same channel chat uses
            callChannel = sb.channel('presence:global', { config: { presence: { key: currentUserId } } })
                .on('broadcast', { event: 'call-offer' }, ({ payload }) => {
                    if (!payload || payload.to !== currentUserId) return;
                    if (inflightCall && inflightCall.from === payload.from) return; // already showing
                    // Load avatar for the caller if we don't have one in payload
                    inflightCall = { from: payload.from, isVideo: !!payload.isVideo, name: payload.name };
                    (async () => {
                        let avatar_url = payload.avatar_url;
                        if (!avatar_url) {
                            try {
                                const { data: p } = await sb.from('profiles').select('avatar_url').eq('id', payload.from).single();
                                avatar_url = p?.avatar_url;
                            } catch {}
                        }
                        showIncomingCall({ ...payload, avatar_url });
                    })();
                })
                .on('broadcast', { event: 'call-end' }, ({ payload }) => {
                    if (!inflightCall || payload.from !== inflightCall.from) return;
                    inflightCall = null; hideCallBanner(); onCallEnded('remote-hangup');
                })
                .on('broadcast', { event: 'call-cancel' }, ({ payload }) => {
                    if (!inflightCall || payload.from !== inflightCall.from) return;
                    inflightCall = null; hideCallBanner(); onCallEnded('remote-cancel');
                })
                .subscribe(async (status) => {
                    if (status === 'SUBSCRIBED') {
                        try { await callChannel.track({ user: currentUserId, name: currentUserName }); } catch {}
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
