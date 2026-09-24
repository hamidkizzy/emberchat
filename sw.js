// Ember service worker
// --------------------------------------------------------
// The app is still under active development, so shell files (html/css/js)
// are NEVER cached here — only pass-through to the network. This removes
// an entire class of "I fixed it but the phone won't show it" bugs.
// (A service worker with no caching still satisfies installability
// requirements for "Add to Home Screen" on Android/Chrome.)

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', () => {
  // Intentionally not calling event.respondWith() — every request just
  // falls through to the network as if there were no service worker.
});
