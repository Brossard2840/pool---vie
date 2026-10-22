// Service worker : rend l'application installable et garde la coquille en cache.
// Les données (/api) ne sont jamais mises en cache : on veut toujours les stats à jour.
const CACHE = 'pav-v14';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192-v2.png', '/logo.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => fetch(u, { cache: 'no-store' }).then(res => {
    if (!res.ok || !res.headers.get('X-Pool-App')) throw new Error('Serveur pas prêt');
    return c.put(u, res);
  })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api')) return;
  // Cache d'abord : l'application s'ouvre tout de suite, même si le serveur gratuit dort encore.
  // La nouvelle version est téléchargée en arrière-plan et sert à la prochaine ouverture.
  const key = e.request.mode === 'navigate' ? '/' : e.request;
  const update = fetch(e.request).then(res => {
    if (res.ok && res.headers.get('X-Pool-App')) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return res;
  });
  e.respondWith(caches.match(key).then(hit => {
    if (hit) { e.waitUntil(update.catch(() => {})); return hit; }
    return update.catch(() => caches.match('/'));
  }));
});

// Notifications reçues même quand l'application est fermée.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'Pool à vie', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Pool à vie', {
    body: d.body || '', icon: '/icons/icon-192-v2.png', badge: '/icons/icon-192-v2.png', tag: d.tag, data: { url: d.url || '/' },
    vibrate: d.kind === 'trade' ? [300, 120, 300, 120, 600] : [200], requireInteraction: d.kind === 'trade'
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url || '/', self.location.origin).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.location.origin)) { c.navigate(url); return c.focus(); }
    return clients.openWindow(url);
  }));
});
