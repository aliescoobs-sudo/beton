// Service worker of the installed app (R5). It does one thing: show a bare wake-up when a push arrives and open the notification
// centre when it is tapped. A push carries no content: the line below is generic, and the person reads the alert inside the app.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('BELGOBETON', {
      body: 'لديك تنبيه · Vous avez une alerte',
      tag: 'bb-alert',
      renotify: true,
      data: { url: '/notifications' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const target = wins[0];
      if (target) return target.focus();
      return self.clients.openWindow('/');
    }),
  );
});
