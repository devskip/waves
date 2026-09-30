// Service worker minimo: serve solo a far riconoscere l'app come installabile su Android.
// Non salva niente in memoria: l'app carica sempre l'ultima versione dal sito.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
