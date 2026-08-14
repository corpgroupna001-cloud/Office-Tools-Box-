// Friday WFH Check-in reminder pop-up.
// Include with <script defer src="/wfh-reminder.js"></script> on any page.
// On Fridays, every WFH employee who hasn't finished uploading their
// assigned device videos gets a pop-up telling them to record & upload —
// and, if they're on a desktop/tab, to LOG IN ON THEIR PERSONAL MOBILE.

(function () {
    const DEVICES = [
        { key: 'mobile', label: 'Mobile phone', icon: '📱' },
        { key: 'laptop', label: 'Laptop', icon: '💻' },
        { key: 'tab', label: 'Tab (tablet)', icon: '📲' },
    ];
    const SNOOZE_KEY = 'ws-wfh-popup-snooze';
    const SNOOZE_MS = 60 * 60 * 1000; // "Later" hides it for 1 hour

    function isFriday() { return new Date().getDay() === 5; }
    function ymd(d) { return d.toISOString().slice(0, 10); }
    function isPhone() {
        return /iPhone|iPod|Android.+Mobile/i.test(navigator.userAgent);
    }

    async function getSb() {
        for (let i = 0; i < 50 && !window.supabase; i++) await new Promise(r => setTimeout(r, 100));
        if (!window.supabase) return null;
        if (window.__WS_SB__) return window.__WS_SB__;
        if (window.__WS_PRESENCE_SB__) return window.__WS_PRESENCE_SB__;
        try {
            const cfg = await fetch('/api/config').then(r => r.json());
            if (!cfg?.supabaseUrl) return null;
            return window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
                auth: { persistSession: true, autoRefreshToken: true }
            });
        } catch { return null; }
    }

    function showPopup({ pending, rejected, note, onMobile }) {
        if (document.getElementById('wfh-reminder-overlay')) return;
        const deviceChips = pending.map(d =>
            `<span style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:999px;background:rgba(59,130,246,0.18);border:1px solid rgba(59,130,246,0.4);color:#bfdbfe;font-weight:800;font-size:12.5px;">${d.icon} ${d.label}</span>`
        ).join(' ');

        const mobileWarn = onMobile ? '' : `
            <div style="background:rgba(234,179,8,0.12);border:1px solid rgba(234,179,8,0.4);border-radius:14px;padding:12px 16px;margin:14px 0;color:#fde68a;font-size:13px;font-weight:800;line-height:1.5;">
                📱 You're on a ${/iPad|Tablet|Android(?!.*Mobile)/i.test(navigator.userAgent) ? 'tab' : 'desktop'} —
                <span style="color:#fff;">please log in on your PERSONAL MOBILE</span> and record from there.
                The mobile back camera gives the high-quality video required for approval.
            </div>`;

        const rejectedBlock = rejected ? `
            <div style="background:rgba(244,63,94,0.12);border:1px solid rgba(244,63,94,0.4);border-radius:14px;padding:12px 16px;margin:14px 0;color:#fecdd3;font-size:13px;font-weight:800;line-height:1.5;">
                ❌ Your last submission <span style="color:#fff;">failed quality check</span>${note ? ' — <span style="color:#fff;">' + note.replace(/</g, '&lt;') + '</span>' : ''}. Please re-record all your videos.
            </div>` : '';

        const overlay = document.createElement('div');
        overlay.id = 'wfh-reminder-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(11,17,32,0.88);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);';
        overlay.innerHTML = `
            <div style="width:100%;max-width:460px;max-height:92vh;overflow-y:auto;background:rgba(23,30,48,0.98);border:1px solid rgba(255,255,255,0.14);border-radius:26px;padding:26px;text-align:center;box-shadow:0 30px 90px rgba(0,0,0,0.6);font-family:inherit;color:#e2e8f0;">
                <div style="width:64px;height:64px;border-radius:20px;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;font-size:30px;background:linear-gradient(135deg,#f43f5e,#a855f7);box-shadow:0 15px 40px rgba(168,85,247,0.5);">📷</div>
                <h3 style="font-size:21px;font-weight:900;color:#fff;margin:0 0 6px;">Friday WFH Check-in</h3>
                <p style="font-size:13.5px;color:#cbd5e1;margin:0 0 12px;font-weight:600;">Today is video check-in day. Record &amp; upload your assigned devices:</p>
                <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-bottom:4px;">${deviceChips}</div>
                ${rejectedBlock}
                ${mobileWarn}
                <div style="text-align:left;background:rgba(139,92,246,0.10);border:1px solid rgba(139,92,246,0.3);border-radius:14px;padding:12px 16px;margin:14px 0;font-size:12.5px;color:#ddd6fe;line-height:1.6;">
                    <b style="color:#fff;">For admin approval your videos must be:</b><br>
                    ✅ High quality (4K/2K) — bright, well-lit area, clean lens<br>
                    ✅ Slow 360° pan — <b>every side, edge and corner</b>, screen ON<br>
                    ✅ Exactly 30 seconds each, steady hands, no pause<br>
                    ❌ Blurry or dark video = QC fail = re-record everything
                </div>
                <div style="display:flex;gap:10px;">
                    <button id="wfh-reminder-later" type="button" style="flex:1;padding:13px;border-radius:14px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.07);color:#fff;font-weight:800;font-size:13px;cursor:pointer;font-family:inherit;">Later</button>
                    <button id="wfh-reminder-go" type="button" style="flex:2;padding:13px;border-radius:14px;border:none;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;font-weight:900;font-size:13px;cursor:pointer;box-shadow:0 10px 28px rgba(59,130,246,0.5);font-family:inherit;">📷 Open Check-in</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        document.getElementById('wfh-reminder-go').addEventListener('click', () => {
            location.href = '/recordings/';
        });
        document.getElementById('wfh-reminder-later').addEventListener('click', () => {
            try { sessionStorage.setItem(SNOOZE_KEY, String(Date.now())); } catch {}
            overlay.remove();
        });
    }

    async function init() {
        if (!isFriday()) return;
        if (location.pathname.startsWith('/recordings') || location.pathname.startsWith('/admin')) return;
        try {
            const snoozed = parseInt(sessionStorage.getItem(SNOOZE_KEY) || '0', 10);
            if (snoozed && Date.now() - snoozed < SNOOZE_MS) return;
        } catch {}

        const sb = await getSb();
        if (!sb) return;
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return;

        const { data: profile } = await sb.from('profiles')
            .select('is_wfh, req_mobile, req_laptop, req_tab')
            .eq('id', session.user.id).maybeSingle();
        if (!profile?.is_wfh) return;

        const required = DEVICES.filter(d => profile[`req_${d.key}`] !== false);
        if (!required.length) return;

        const { data: row } = await sb.from('wfh_recordings')
            .select('mobile_path, laptop_path, tab_path, status, review_note')
            .eq('user_id', session.user.id).eq('week_of', ymd(new Date())).maybeSingle();

        const rejected = row?.status === 'rejected';
        const pending = rejected
            ? required // QC failed → everything must be re-recorded
            : required.filter(d => !row || !row[`${d.key}_path`]);
        if (!pending.length) return; // all uploaded & not rejected — no popup

        showPopup({ pending, rejected, note: row?.review_note || '', onMobile: isPhone() });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
