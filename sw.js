const CACHE_NAME = 'biblioteca-v19';
const ASSETS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
    self.clients.claim();
});

self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    e.respondWith(
        fetch(e.request)
            .then(response => {
                const clone = response.clone();
                if (response.ok) {
                    caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
                }
                return response;
            })
            .catch(() => caches.match(e.request))
    );
});
