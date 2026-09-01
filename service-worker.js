const CACHE_NAME = 'money-manager-v6';
const urlsToCache = [
    './',
    './index.html',
    './manifest.json',
    './icon-192.png',
    './icon-512.png'
];

// Install event - cache assets
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                return cache.addAll(urlsToCache);
            })
    );
});

// Fetch event - serve from cache, fall back to network
self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                if (response) {
                    return response;
                }
                return fetch(event.request);
            })
    );
});

// Push event - shows a system notification even if no tab is open.
// NOTE: this only fires if something actually sends a Web Push message to
// this device (e.g. a server-side Firebase Cloud Function). The in-app
// reminder scheduler in index.html does NOT go through this — it only runs
// while the app is open/backgrounded, since it has no server to push from.
self.addEventListener('push', event => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) {
        data = { title: 'Money Manager', body: event.data ? event.data.text() : '' };
    }
    const title = data.title || 'Money Manager';
    const options = {
        body: data.body || '',
        icon: data.icon || './money.jpeg',
        badge: data.badge || './money.jpeg'
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

// Clicking a notification focuses/opens the app instead of leaving it as a
// dead notification in the tray.
self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
            for (const client of clientList) {
                if ('focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow('./index.html');
        })
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});