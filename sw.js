const CACHE = 'roleplay-v4';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  // Page navigation: bypass ALL caches so index.html is always fresh
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(new Request(e.request, { cache: 'no-store' }))
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // JS / CSS / images: network first, cache as fallback
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
