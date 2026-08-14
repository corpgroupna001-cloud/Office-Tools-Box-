// WorkSuite Web Push client. Include with <script src="/push.js"></script>,
// then call WSPush.init(supabaseClient) after login.
//
//   WSPush.init(sb)              → registers /sw.js; silently subscribes if
//                                  permission already granted, otherwise shows
//                                  a small "🔔 Enable notifications" pill.
//   WSPush.notify(sb, {to, title, body, url, tag})
//                                → fire-and-forget push to another user's
//                                  devices (works when their page is closed).

(function () {
    function supported() {
        return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    }

    function urlB64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(base64);
        const arr = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
        return arr;
    }

    async function subscribe(sb) {
        const reg = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            const cfg = await fetch('/api/push').then(r => r.json());
            if (!cfg.publicKey) throw new Error('push not configured');
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlB64ToUint8Array(cfg.publicKey)
            });
        }
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return;
        await fetch('/api/push', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + session.access_token
            },
            body: JSON.stringify({
                action: 'subscribe',
                subscription: sub.toJSON(),
                user_agent: navigator.userAgent
            })
        });
    }

    function showPill(sb) {
        if (document.getElementById('ws-push-pill')) return;
        const pill = document.createElement('button');
        pill.id = 'ws-push-pill';
        pill.type = 'button';
        pill.innerHTML = '🔔 Enable notifications';
        pill.style.cssText = [
            'position:fixed', 'right:18px', 'bottom:18px', 'z-index:120',
            'display:inline-flex', 'align-items:center', 'gap:8px',
            'padding:11px 18px', 'border-radius:999px', 'cursor:pointer',
            'background:linear-gradient(135deg,#3b82f6,#6366f1)', 'color:#fff',
            'border:none', 'font-family:inherit', 'font-size:13px', 'font-weight:800',
            'box-shadow:0 12px 30px rgba(59,130,246,0.5)'
        ].join(';');
        pill.title = 'Get message & call alerts even when this page is closed';
        pill.addEventListener('click', async () => {
            try {
                const perm = await Notification.requestPermission();
                if (perm === 'granted') {
                    await subscribe(sb);
                    pill.innerHTML = '✅ Notifications on';
                    setTimeout(() => pill.remove(), 2000);
                } else if (perm === 'denied') {
                    pill.remove();
                }
            } catch (e) { console.error('[push] subscribe failed', e); }
        });
        document.body.appendChild(pill);
    }

    window.WSPush = {
        async init(sb) {
            if (!supported() || !sb) return;
            try {
                if (Notification.permission === 'granted') {
                    await subscribe(sb);
                } else if (Notification.permission === 'default') {
                    showPill(sb);
                }
            } catch (e) { console.error('[push] init failed', e); }
        },

        async notify(sb, payload) {
            // Fire-and-forget — never block or break the caller's flow.
            try {
                if (!sb) return;
                const { data: { session } } = await sb.auth.getSession();
                if (!session) return;
                fetch('/api/push', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + session.access_token
                    },
                    body: JSON.stringify({ action: 'notify', ...payload })
                }).catch(() => {});
            } catch {}
        }
    };
})();
