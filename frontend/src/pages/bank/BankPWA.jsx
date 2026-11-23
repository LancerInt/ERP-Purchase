// Makes the Bank module an installable PWA. Mounted only while a /bank/* route
// is active (see App.jsx), it:
//   1. swaps the page manifest to /bank.webmanifest so the browser's own install
//      button offers "Lancer Bank" (opens standalone at /bank/dashboard),
//   2. registers the /bank/-scoped service worker (installability + offline shell).
// No in-app install button — installation is via the browser's native install
// option (address-bar icon / menu). The app-wide push worker (/sw.js) is untouched.
import { useEffect } from 'react';

const MAIN_MANIFEST = '/manifest.webmanifest';
const BANK_MANIFEST = '/bank.webmanifest';

export default function BankPWA() {
  // (1) Point the page manifest at the Bank one while the module is active.
  useEffect(() => {
    const link = document.querySelector('link[rel="manifest"]');
    const prevHref = link ? link.getAttribute('href') : MAIN_MANIFEST;
    if (link) link.setAttribute('href', BANK_MANIFEST);
    const titleMeta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    const prevTitle = titleMeta ? titleMeta.getAttribute('content') : null;
    if (titleMeta) titleMeta.setAttribute('content', 'Lancer Bank');
    return () => {
      if (link) link.setAttribute('href', prevHref || MAIN_MANIFEST);
      if (titleMeta && prevTitle != null) titleMeta.setAttribute('content', prevTitle);
    };
  }, []);

  // (2) Register the bank service worker (scoped to /bank/).
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/bank-sw.js', { scope: '/bank/' }).catch(() => {});
  }, []);

  return null;
}
