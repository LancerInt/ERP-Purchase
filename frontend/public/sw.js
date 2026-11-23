/* Lancer ERP service worker — Web Push ONLY.
 *
 * It intentionally registers NO `fetch` handler, so it never caches app
 * assets. That keeps deploys instant (no stale-bundle surprises) while still
 * enabling native push notifications that fire when the app is closed.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Lancer ERP';
  const options = {
    body: data.body || '',
    icon: '/pwa-192.png',
    badge: '/pwa-192.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || '/';
  // Absolute form for openWindow; the in-app listener routes the relative path.
  const absolute = new URL(raw, self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Prefer an already-open window: focus it and ask the SPA to route there.
    // (client.navigate() is unreliable on mobile — it throws when the window
    // isn't controlled, leaving the app on its current page; postMessage +
    // react-router navigation works everywhere with no reload.)
    let chosen = all.find((c) => c.focused) || all.find((c) => c.visibilityState === 'visible') || all[0];
    if (chosen && 'focus' in chosen) {
      try { await chosen.focus(); } catch (_e) { /* focus may be disallowed */ }
      chosen.postMessage({ type: 'NOTIFICATION_CLICK', url: raw });
      return;
    }
    if (self.clients.openWindow) return self.clients.openWindow(absolute);
    return undefined;
  })());
});
