/* Lancer Bank service worker — scoped to /bank/.
 *
 * Separate from the app-wide push-only /sw.js so the Bank module can be an
 * installable, offline-capable PWA WITHOUT turning on asset caching for the
 * whole ERP. Registered with { scope: '/bank/' }, so it only controls the
 * Bank pages and their requests.
 *
 * Strategy:
 *   - navigations  -> network-first, fall back to the cached SPA shell (offline)
 *   - static assets-> stale-while-revalidate (fast repeat loads)
 *   - /api/*       -> never cached (always live, auth-gated)
 */
const CACHE = 'lancer-bank-v1';
const SHELL = ['/', '/index.html', '/bank.webmanifest', '/pwa-192.png', '/pwa-512.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // cross-origin → passthrough
  if (url.pathname.startsWith('/api/')) return;         // live data, never cache

  // App navigations: try the network, fall back to the cached shell offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch (_e) {
        return (await caches.match('/index.html')) || (await caches.match('/')) || Response.error();
      }
    })());
    return;
  }

  // Only cache real build output + static files. This deliberately EXCLUDES
  // Vite dev/HMR requests (/@vite, /@react-refresh, /src/…, ?t= reloads) so the
  // dev server keeps hot-reloading normally.
  const cacheable = url.pathname.startsWith('/assets/')
    || /\.(?:png|jpg|jpeg|svg|ico|gif|webp|woff2?|ttf|otf|webmanifest)$/.test(url.pathname);
  if (!cacheable) return;

  // Static assets: serve cached, refresh in the background (stale-while-revalidate).
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(req, clone));
      }
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});
