// Ember service worker — caches the app shell so it launches instantly
// from the home screen icon, even on a flaky connection. Chat data itself
// always goes to the network (Supabase), never cached here.
//
// Strategy: network-first for the app shell. Always try the network so
// updates show up immediately; only fall back to the cache when offline.
// (Bump CACHE's version suffix any time the shell files change, so the
// browser detects this file as different and installs a fresh worker —
// otherwise it keeps running whatever it first installed, forever.)

const CACHE = 'ember-shell-v2';
const SHELL_FILES = [
  'index.html',
  'app.html',
  'css/style.css',
  'js/db.js',
  'js/auth.js',
  'js/chat.js',
  'js/supabase-config.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache Supabase API/storage/realtime calls — always go live.
  if (url.hostname.endsWith('supabase.co')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.status === 200 && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
