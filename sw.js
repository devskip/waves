// Service worker: rende l'app installabile e riceve le notifiche push anche con l'app chiusa.
// Non salva niente in memoria: l'app carica sempre l'ultima versione dal sito.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

// Arriva un avviso dal server: lo mostra nel blocca schermo e accende il badge sull'icona
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = {body: e.data ? e.data.text() : ''}; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Sinis Waves', {
      body: d.body || '',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      tag: d.tag || 'onde',          // un nuovo avviso sostituisce il precedente invece di accumularsi
      renotify: true,
      data: {url: d.url || './'}
    });
    try {
      const n = (await self.registration.getNotifications()).length;
      if (self.navigator.setAppBadge) await self.navigator.setAppBadge(n || 1);
    } catch (x) { /* il badge è facoltativo */ }
  })());
});

// Tocco sulla notifica: apre (o riporta in primo piano) l'app e spegne il badge
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    try { if (self.navigator.clearAppBadge) await self.navigator.clearAppBadge(); } catch (x) {}
    const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
    const all = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    for (const c of all) { if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  })());
});
