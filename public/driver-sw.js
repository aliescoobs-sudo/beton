// Service worker of the driver and pump phone app (R4). It keeps the app shell readable offline. It caches only the driver page and the
// framework's own static files: NEVER the day (F02: the day names clients; the app keeps its own copy, tied to the account and limited
// in age, and erases it on sign-out, refusal or account switch). Taps are never cached here: the app queues them itself.
const CACHE = 'bb-field-v2';
const SHELL = /^\/(fr|ar)\/driver\/?$/;
const STATIC = /^\/_next\/static\//;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const networkFirst = SHELL.test(url.pathname);
  if (!networkFirst && !STATIC.test(url.pathname)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (networkFirst) {
        try {
          const fresh = await fetch(req);
          if (fresh.ok) await cache.put(req, fresh.clone());
          return fresh;
        } catch {
          const hit = await cache.match(req, { ignoreSearch: false });
          if (hit) return hit;
          throw new Error('offline');
        }
      }
      const hit = await cache.match(req);
      if (hit) return hit;
      const fresh = await fetch(req);
      if (fresh.ok) await cache.put(req, fresh.clone());
      return fresh;
    })(),
  );
});

// R5: a push is a bare wake-up (no content); tapping it opens the driver app.
self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('BELGOBETON', {
      body: 'لديك تنبيه جديد',
      tag: 'bb-driver-alert',
      renotify: true,
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      if (wins[0]) return wins[0].focus();
      return self.clients.openWindow('/ar/driver');
    }),
  );
});
