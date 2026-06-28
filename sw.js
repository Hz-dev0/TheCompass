/* =====================================================
   sw.js — 收集冊 PWA Service Worker
   版本號由 GitHub Actions 自動注入（BUILD_VERSION）
   每次 push 觸發新版本 → 舊快取失效 → 自動更新
   ===================================================== */

const VERSION = '__BUILD_VERSION__';   // ← GitHub Actions 會替換這行
// 如果不是透過 GitHub Actions 部署（例如直接上傳檔案到別的主機），
// 上面這行不會被取代成真正的版本號，快取名稱永遠相同，瀏覽器會一直
// 沿用第一次安裝時快取的舊 app.js，之後怎麼更新檔案都吃不到。
// 手動部署時，請把下面這個數字改掉（隨便改，只要跟上次不同即可），
// 確保使用者能拿到最新版本。
const MANUAL_VERSION = '3';
const CACHE = `shoucezhe-${VERSION === '__BUILD_VERSION__' ? MANUAL_VERSION : VERSION}`;

// 需要預先快取的靜態資源（不含 Firebase CDN，那些走網路）
const PRECACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// ── Install：預快取靜態資源 ──
self.addEventListener('install', event => {
  console.log(`[SW] install v${VERSION}`);
  event.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.allSettled(
        PRECACHE.map(url =>
          cache.add(url).catch(err => console.warn(`[SW] precache 失敗: ${url}`, err))
        )
      )
    )
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

// ── Fetch 策略 ──
// app.js / index.html / style.css 是會隨部署改變的「程式碼」，一律 Network-First：
// 每次都先試著從網路拿最新版本，只有在離線/網路失敗時才退回快取。這樣即使忘了
// 改版本號，使用者也一定會拿到最新部署的程式碼，不會卡在舊版本。
// manifest.json / icon 圖檔幾乎不會變，維持 Cache-First 比較省流量。
const NETWORK_FIRST = ['/index.html', '/app.js', '/style.css', '/'];

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Firebase / Google APIs 直接走網路，不攔截
  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('firebaseapp.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) {
    return; // 瀏覽器預設處理
  }

  if (url.origin !== location.origin) return;

  const isNetworkFirst = NETWORK_FIRST.some(p => url.pathname === p || url.pathname.endsWith(p));

  if (isNetworkFirst) {
    event.respondWith(
      fetch(request, { cache: 'no-store' }).then(response => {
        if (response.ok && request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() =>
        // 離線時才退回快取，確保至少能打開上次成功載入的版本
        caches.match(request)
      )
    );
    return;
  }

  // 其他同源靜態資源（icon、manifest）：Cache-First，fallback 到網路
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
});

// ── 接收主頁面的 skipWaiting 指令（用於手動更新提示） ──
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
