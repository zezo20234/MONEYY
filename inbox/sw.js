// inbox/sw.js - lets the SMS inbox page open with no internet.
const CACHE = 'sms-inbox-v6';

self.addEventListener('install', (e) => {
    self.skipWaiting();
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./index.html', './manifest.json', './icon-192.png', './icon-512.png', './icon-180.png'])));
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Only the page itself is handled. API calls (/api/log-sms) go straight to the network.
self.addEventListener('fetch', (e) => {
    const r = e.request;
    if (r.method !== 'GET' || r.mode !== 'navigate') return;
    e.respondWith(
        fetch(r)
            .then((res) => {
                const copy = res.clone();
                caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
                return res;
            })
            .catch(() => caches.match('./index.html'))
    );
});
