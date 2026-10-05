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
const MANUAL_VERSION = '4';
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

// Firebase SDK（ES module，app.js 一開始就 import）。離線時若抓不到，整個 app 都不會啟動，
// 所以必須快取。版本號固定在網址裡，內容不會變，用 Cache-First 即可。
const FIREBASE_SDK = [
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js',
];

// ── Install：預快取靜態資源 ──
self.addEventListener('install', event => {
  console.log(`[SW] install v${VERSION}`);
  event.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.allSettled([
        ...PRECACHE.map(url =>
          cache.add(url).catch(err => console.warn(`[SW] precache 失敗: ${url}`, err))
        ),
        // 必須用 cors 模式抓，才能被 <script type=module> 的 import 使用（no-cors 會得到 opaque 回應）
        ...FIREBASE_SDK.map(url =>
          fetch(url, { mode: 'cors' })
            .then(r => { if (r.ok) return cache.put(url, r); })
            .catch(err => console.warn(`[SW] SDK precache 失敗: ${url}`, err))
        ),
      ])
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

  // Firebase SDK 模組（含它 import 的分段檔案）：Cache-First，抓到就存起來，離線也能載入
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
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
    return;
  }

  // Google Fonts（CSS 與字型檔）：Stale-While-Revalidate，離線時用舊的，字型缺失也不會壞版
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.match(request).then(cached => {
        const network = fetch(request).then(response => {
          if (response && (response.ok || response.type === 'opaque') && request.method === 'GET') {
            const clone = response.clone();
            caches.open(CACHE).then(cache => cache.put(request, clone));
          }
          return response;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Firestore / Auth / 其他 Google API 直接走網路，不攔截（離線資料由 Firestore 自己的 IndexedDB 快取處理）
  if (
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('firebaseapp.com')
  ) {
    return;
  }

  if (url.origin !== location.origin) return;

  const isNetworkFirst = NETWORK_FIRST.some(p => url.pathname === p || url.pathname.endsWith(p));

  if (isNetworkFirst) {
    event.respondWith((async () => {
      const fallback = async () =>
        (await caches.match(request, { ignoreSearch: true })) ||
        (request.mode === 'navigate'
          ? (await caches.match('./index.html')) || (await caches.match('./'))
          : undefined) ||
        Response.error();
      try {
        // 網路時好時壞（連上 Wi-Fi 但沒網路）時，4 秒沒回應就改用快取，避免一直轉圈
        const response = await Promise.race([
          fetch(request, { cache: 'no-store' }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
        ]);
        if (response.ok && request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, clone));
        }
        return response;
      } catch (e) {
        return fallback();
      }
    })());
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
      }).catch(() => (request.mode === 'navigate' ? caches.match('./index.html') : Response.error()));
    })
  );
});

// ── 接收主頁面的 skipWaiting 指令（用於手動更新提示） ──
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
