/* =====================================================
   sw.js — 收集冊 PWA Service Worker
   版本號由 GitHub Actions 自動注入（BUILD_VERSION）
   ===================================================== */

const VERSION = '__BUILD_VERSION__';
const CACHE   = `shoucezhe-${VERSION}`;

const PRECACHE = [
  '/TheCompass/',
  '/TheCompass/index.html',
  '/TheCompass/style.css',
  '/TheCompass/app.js',
  '/TheCompass/manifest.json',
  '/TheCompass/icon-192.png',
  '/TheCompass/icon-512.png',
];

self.addEventListener('install', event => {
  console.log(`[SW] install v${VERSION}`);
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  console.log(`[SW] activate v${VERSION}`);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE).map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('firebaseapp.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) return;

  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok && request.method === 'GET') {
            const clone = response.clone();
            caches.open(CACHE).then(cache => cache.put(request, clone));
          }
          return response;
        });
      })
    );
  }
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
