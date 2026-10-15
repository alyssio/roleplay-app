const CACHE = 'roleplay-v82';

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

  // Page navigation: always fetch fresh, bypass all caches
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(new Request(e.request, { cache: 'no-store' }))
        .catch(() => caches.match(e.request))
    );
    return;
  }

  const requestUrl = new URL(e.request.url);
  const isStaticAsset = requestUrl.origin === self.location.origin
    && ['script', 'style', 'image', 'font'].includes(e.request.destination);
  if (!isStaticAsset) return;

  // Serve cached static assets immediately while refreshing them in the background.
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(e.request);
      const refresh = fetch(e.request).then(async response => {
        if (response.ok) await cache.put(e.request, response.clone());
        return response;
      });
      if (cached) {
        e.waitUntil(refresh.then(() => undefined).catch(() => undefined));
        return cached;
      }
      return refresh;
    })()
  );
});
