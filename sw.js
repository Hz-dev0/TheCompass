/* =====================================================
   sw.js — 收集冊 PWA Service Worker
   版本號由 GitHub Actions 自動注入（BUILD_VERSION）
   每次 push 觸發新版本 → 舊快取失效 → 自動更新
   ===================================================== */

const VERSION = '__BUILD_VERSION__';   // ← GitHub Actions 會替換這行
const CACHE   = `shoucezhe-${VERSION}`;

// 需要預先快取的靜態資源（不含 Firebase CDN，那些走網路）
const PRECACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// ── Install：預快取靜態資源 ──
self.addEventListener('install', event => {
  console.log(`[SW] install v${VERSION}`);
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(PRECACHE))
  );
  // 跳過 waiting，立即激活新版 SW
  self.skipWaiting();
});

// ── Activate：清除舊版快取 ──
self.addEventListener('activate', event => {
  console.log(`[SW] activate v${VERSION}`);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE)
          .map(key => {
            console.log(`[SW] deleting old cache: ${key}`);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())   // 立即接管所有頁面
  );
});

// ── Fetch：Cache-First（靜態） / Network-First（動態） ──
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Firebase / Google APIs 直接走網路，不攔截
  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('firebaseapp.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) {
    return; // 瀏覽器預設處理
  }

  // 同源靜態資源：Cache-First，fallback 到網路
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          // 快取成功的 GET 回應
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

// ── 接收主頁面的 skipWaiting 指令（用於手動更新提示） ──
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
