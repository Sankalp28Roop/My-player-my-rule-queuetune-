// StrictQueue Lightweight App Shell Service Worker
const CACHE_NAME = 'strictqueue-v2';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/manifest.json',
  '/icon.svg',
  '/logo.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('Pre-caching non-critical static assets encountered warning:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // 1. Only handle GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);

  // 2. Restrict caching strictly to same-origin requests
  if (url.origin !== self.location.origin) {
    return;
  }

  // 3. Explicitly bypass dynamic endpoints, search, and APIs
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/search') ||
    url.hostname.includes('youtube') ||
    url.hostname.includes('googlevideo') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('pipedapi') ||
    url.hostname.includes('nadeko') ||
    url.hostname.includes('puffyan') ||
    url.hostname.includes('lrclib')
  ) {
    return;
  }

  // 4. Network-first with cache fallback for same-origin static app shell assets
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (
          networkResponse &&
          networkResponse.status === 200 &&
          networkResponse.type === 'basic'
        ) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          if (event.request.mode === 'navigate') {
            return caches.match('/');
          }
        });
      })
  );
});
