import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { BrowserRouter } from 'react-router-dom';
import store from './store/index.js';
import { setStore } from './utils/api.js';
import App from './App.jsx';
import { isStaleBundleError, recoverFromStaleBundle, tidyStaleBundleParam } from './utils/staleBundle.js';
import { initSentry } from './utils/sentry.js';
import './styles/globals.css';

// Error tracking — a no-op unless this build was given VITE_SENTRY_DSN. Called
// first so it is in place before any app code can throw.
initSentry();

// Inject store into api client (breaks circular dependency)
setStore(store);

// -- Stale-bundle recovery, app-wide --------------------------------------
// Every lazy route is a hashed chunk, and a deploy deletes the old ones. A tab
// still holding the previous index.html asks for a chunk that is gone.
//
// Vite raises `vite:preloadError` for exactly that, BEFORE React sees it, so
// catching it here recovers the whole ERP - not only routes that sit under an
// ErrorBoundary - and without first painting an error card. preventDefault()
// stops Vite's own unhandled-rejection path.
//
// recoverFromStaleBundle() reloads through a cache-busting url. That is the
// part that matters: a plain reload re-requests the same address and can be
// handed the same stale index.html, which is what made this a refresh LOOP.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  recoverFromStaleBundle();
});

// The same failure can arrive as a plain rejected import - an older browser, or
// an import fired outside the router.
window.addEventListener('unhandledrejection', (event) => {
  if (isStaleBundleError(event.reason)) {
    event.preventDefault();
    recoverFromStaleBundle();
  }
});

// Stop mouse-wheel scrolling from silently changing the value of a focused
// <input type="number"> — a common browser annoyance. When the wheel fires
// over the focused number field, blur it so the page just scrolls instead of
// the value ticking up/down. Paired with the spinner-hiding CSS in globals.css.
document.addEventListener('wheel', (e) => {
  const el = document.activeElement;
  if (el && el.tagName === 'INPUT' && el.type === 'number' && el === e.target) {
    el.blur();
  }
}, { passive: true });

// Tidy the cache-busting parameter out of the address bar. The cooldown that
// guards against a reload loop is deliberately NOT cleared here: reaching this
// line only proves the ENTRY bundle loaded, and a lazy chunk can still be
// missing - clearing it now would re-arm the very loop this fixes.
tidyStaleBundleParam();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Provider store={store}>
      <BrowserRouter
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true,
        }}
      >
        <App />
      </BrowserRouter>
    </Provider>
  </React.StrictMode>
);
