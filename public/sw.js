const CACHE_NAME = 'notion-pwa-v1';

// Hanya cache file lokal/internal saja (Bebas dari error CORS)
const assetsToCache = [
  '/',
  '/style.css'
];

// 1. Install Service Worker & Cache Aset Lokal
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(assetsToCache);
    })
  );
  self.skipWaiting();
});

// 2. Aktifkan Service Worker & Hapus Cache Lama
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// 3. Tangani Permintaan Jaringan (Fetch)
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // Gunakan cache jika ada, jika tidak ambil dari internet secara normal
      return cachedResponse || fetch(event.request).catch(() => {
        // Fallback opsional jika offline total
        if (event.request.mode === 'navigate') {
          return caches.match('/');
        }
      });
    })
  );
});
