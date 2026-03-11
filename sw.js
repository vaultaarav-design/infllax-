// ISI Terminal v6.02 — Service Worker
const CACHE_NAME = 'isi-terminal-v6-02';
const STATIC_ASSETS = [
  '/index.html',
  '/preentry.html',
  '/monitoring.html',
  '/algo.html',
  '/Settings.html',
  '/multicluster.html',
  '/knowledge.html',
  '/index.js',
  '/preentry.js',
  '/monitoring.js',
  '/settings.js',
  '/gemini.js',
  '/knowledge.js',
  '/order-tracker.js',
  '/style.css',
  '/logo-icon.png',
  '/logo-wide.png',
  '/logo-text.png',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
  '/favicon.ico'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network first for Firebase/API calls
  if (e.request.url.includes('firebase') || e.request.url.includes('googleapis') || 
      e.request.url.includes('yahoo') || e.request.url.includes('corsproxy')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
