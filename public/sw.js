const APP_CACHE = 'cordistube-app-v1';
const VIDEO_CACHE = 'cordistube-videos';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then(cache => cache.addAll(['/', '/index.html', '/manifest.json', '/icon.svg']))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== APP_CACHE && k !== VIDEO_CACHE).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Serve cached video/audio proxy streams for offline playback
  if (url.pathname.startsWith('/api/proxy/')) {
    event.respondWith(
      caches.open(VIDEO_CACHE).then(async (cache) => {
        const cached = await cache.match(url.pathname);
        if (cached) return cached;
        return fetch(event.request);
      }).catch(() => fetch(event.request))
    );
    return;
  }

  // App shell — network first, cache fallback
  if (url.pathname === '/' || url.pathname === '/index.html' ||
      url.pathname === '/manifest.json' || url.pathname === '/icon.svg') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(APP_CACHE).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
