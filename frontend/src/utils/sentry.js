import * as Sentry from '@sentry/react';

// Error tracking, OFF by default. Nothing is sent anywhere unless the build was
// given a VITE_SENTRY_DSN (set only on the deployed frontend). So local dev, a
// plain `vite build`, and any environment without the key stay completely
// silent — initSentry() and captureError() become no-ops. Switch it on by
// setting VITE_SENTRY_DSN in the frontend's Render env (works with Sentry SaaS
// and with a self-hosted GlitchTip, which speak the same protocol).
const DSN = import.meta.env.VITE_SENTRY_DSN;

export function initSentry() {
  if (!DSN) return;
  Sentry.init({
    dsn: DSN,
    environment: import.meta.env.MODE,
    // Error tracking only — no performance tracing, no session replay. Keeps
    // the payload small and avoids spending the free-tier quota on anything
    // but real errors.
    tracesSampleRate: 0,
    sendDefaultPii: false,
    // The app already DETECTS and RECOVERS from stale-chunk errors after a
    // deploy (see main.jsx + utils/staleBundle.js), so they are expected noise,
    // not bugs. Drop them here so they never crowd out real errors.
    ignoreErrors: [
      /Failed to fetch dynamically imported module/i,
      /Importing a module script failed/i,
      /Loading chunk .* failed/i,
      /error loading dynamically imported module/i,
    ],
  });
}

// Forward a caught exception. No-op unless a DSN was configured.
export function captureError(error, extra) {
  if (!DSN) return;
  Sentry.captureException(error, extra ? { extra } : undefined);
}
