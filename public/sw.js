/* injoy service worker — shell cache only. API traffic always goes to the network. */
const VERSION = 'injoy-v48';
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/api.js',
  '/js/state.js',
  '/js/ui.js',
  // player.js, dash.js and hls.js are loaded on the first play and cached by
  // the fetch handler below. Prefetching them here made the first visit pay for
  // a player most visitors have not opened yet.
  '/manifest.webmanifest',
  '/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);

      // The shell is versioned: a release bumps VERSION, activation deletes the
      // previous cache, and these files cannot change underneath a live cache.
      // Serving them from disk makes a repeat visit instant; HTML stays
      // network-first so a deploy is still picked up immediately.
      const isStatic = /^\/(?:js|css)\//.test(url.pathname) || /\.(?:svg|webmanifest)$/.test(url.pathname);
      if (isStatic) {
        const hit = await cache.match(request, { ignoreSearch: true });
        if (hit) return hit;
      }

      try {
        // Network-first for documents and anything not pinned above.
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      } catch {
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const shell = await cache.match('/index.html');
          if (shell) return shell;
        }
        throw new Error('offline');
      }
    })(),
  );
});
