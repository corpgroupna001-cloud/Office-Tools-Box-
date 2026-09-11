// WorkSuite service worker — receives Web Push notifications so messages
// and incoming calls reach employees even when the tab (or the whole
// browser window) is closed.
//
// Push payloads (built by api/push.js):
//   { type: 'message', title, body, url, tag }            tag dm-<sender> / grp-<group>
//   { type: 'call', call_id, title, body, url, tag }      tag call-<id>: rings until acted on
//   { type: 'call-end', call_id, title, body, url, tag, close? }
//        replaces the ringing notification: "Missed call", or (close) nothing at all
//   anything else (reminders, CRM): title, body, url, tag

const ICON = '/icon-192.png';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

async function closeTag(tag) {
    if (!tag) return;
    const list = await self.registration.getNotifications({ tag });
    list.forEach(n => n.close());
}

async function onPush(data) {
    const tag = data.tag || 'worksuite';
    if (data.type === 'call-end') {
        await closeTag(tag);
        if (data.close) {
            // Every push has to show something, so show it silently and take it straight away.
            await self.registration.showNotification(data.title || 'Call ended', { tag, silent: true, icon: ICON, badge: ICON });
            await closeTag(tag);
            return;
        }
        return self.registration.showNotification(data.title || 'Missed call', {
            body: data.body || '', icon: ICON, badge: ICON, tag, renotify: true,
            data: { url: data.url || '/chat/' },
        });
    }
    const isCall = data.type === 'call' || data.tag === 'call';
    const options = {
        body: data.body || '',
        icon: ICON,
        badge: ICON,
        tag,
        renotify: true,
        vibrate: isCall ? [400, 200, 400, 200, 400, 200, 400] : [200, 100, 200],
        requireInteraction: isCall, // a ringing call stays on screen until acted on
        data: { url: data.url || '/chat/', type: data.type || '', callId: data.call_id || '' },
    };
    if (data.type === 'call' && data.call_id) {
        options.actions = [{ action: 'answer', title: 'Answer' }, { action: 'decline', title: 'Decline' }];
    }
    return self.registration.showNotification(data.title || 'WorkSuite', options);
}

self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data.json() || {}; }
    catch { data = { title: 'WorkSuite', body: event.data ? event.data.text() : '' }; }
    event.waitUntil(onPush(data));
});

// A call opens its own window (the call page), focusing one that is already
// showing that call. Answer / Decline act straight away on that page.
async function openCall(callId, action) {
    const base = `/call/?id=${encodeURIComponent(callId)}`;
    const url = action === 'answer' ? base + '&answer=1' : action === 'decline' ? base + '&decline=1' : base;
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = list.find(c => {
        try { const u = new URL(c.url); return u.pathname.replace(/\/+$/, '') === '/call' && u.searchParams.get('id') === callId; }
        catch { return false; }
    });
    if (open) {
        if (action && 'navigate' in open) await open.navigate(url);
        return open.focus();
    }
    return self.clients.openWindow(url);
}

self.addEventListener('notificationclick', (event) => {
    const data = event.notification.data || {};
    event.notification.close();
    if (data.type === 'call' && data.callId) {
        event.waitUntil(openCall(data.callId, event.action));
        return;
    }
    const url = data.url || '/chat/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
            // Prefer a tab already on the target page, then any WorkSuite tab (not a call window); open a new one otherwise.
            const target = new URL(url, self.location.origin);
            const isCallWindow = c => { try { return new URL(c.url).pathname.startsWith('/call'); } catch { return false; } };
            const same = list.find(c => new URL(c.url).pathname === target.pathname && 'focus' in c);
            const any = list.find(c => 'focus' in c && !isCallWindow(c));
            const win = same || any;
            if (win) {
                // Same page: navigate too, so the hash (#thread=, #group=) opens the right conversation.
                if ('navigate' in win && win.url !== target.href) win.navigate(url);
                return win.focus();
            }
            return self.clients.openWindow(url);
        })
    );
});
