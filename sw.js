// WorkSuite service worker — receives Web Push notifications so messages
// and incoming calls reach employees even when the tab (or the whole
// browser window) is closed.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data.json(); }
    catch { data = { title: 'WorkSuite', body: event.data ? event.data.text() : '' }; }

    const isCall = data.tag === 'call';
    const options = {
        body: data.body || '',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: data.tag || 'worksuite',
        renotify: true,
        vibrate: isCall ? [300, 100, 300, 100, 300] : [200, 100, 200],
        requireInteraction: isCall, // ringing call stays on screen until acted on
        data: { url: data.url || '/chat/' }
    };
    event.waitUntil(self.registration.showNotification(data.title || 'WorkSuite', options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || '/chat/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
            // Prefer a tab already on the target page, then any WorkSuite tab; open a new one otherwise.
            const target = new URL(url, self.location.origin);
            const same = list.find(c => new URL(c.url).pathname === target.pathname && 'focus' in c);
            const any = list.find(c => 'focus' in c);
            const win = same || any;
            if (win) { if (!same && 'navigate' in win) win.navigate(url); return win.focus(); }
            return self.clients.openWindow(url);
        })
    );
});
