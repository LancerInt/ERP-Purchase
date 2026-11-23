import { Component } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { isStaleBundleError, recoverFromStaleBundle } from '../../utils/staleBundle.js';
import { captureError } from '../../utils/sentry.js';

/**
 * App-wide error boundary. A render-time exception anywhere below it
 * (a bad API payload, a lazy chunk error) is caught and degraded to a
 * friendly recoverable card instead of white-screening the whole app.
 *
 * Special-cases the common "stale chunk" failure: after a new frontend
 * deploy, a tab that's been open across the deploy still references the
 * OLD hashed chunk filenames. Navigating to a lazy-loaded route then fails
 * to fetch its JS (404) and React throws. We detect that and reload ONCE
 * to pull the fresh bundle, so the user isn't stranded on the error card.
 */
// Detector + recovery live in utils/staleBundle.js so the ErrorBoundary and the
// window-level vite:preloadError listener cannot drift apart on what counts as
// a stale bundle or how many times a tab is allowed to reload.
const isChunkError = isStaleBundleError;

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, isChunk: false, recoveryFailed: false };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, isChunk: isChunkError(error) };
  }

  componentDidUpdate(prevProps) {
    // Self-heal a transient render crash: when the route or filters change
    // (resetKey), clear a prior non-chunk error so a one-off glitch (e.g. a
    // fast double-click racing a drill's data) doesn't strand the user on the
    // card — they just navigate and it recovers. Stale-bundle errors are left
    // alone (only a cache-busting reload fixes those).
    if (this.state.hasError && !this.state.isChunk
        && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, isChunk: false, recoveryFailed: false });
    }
  }

  componentDidCatch(error, info) {
    if (import.meta.env.DEV) console.error('ErrorBoundary caught:', error, info);
    // Stale-bundle auto-recovery. The old version called location.reload(),
    // which re-requests the SAME url and so can be served the SAME cached
    // index.html pointing at the SAME dead chunk - that is the refresh loop.
    // recoverFromStaleBundle() reloads through a cache-busting url instead, and
    // returns false once this tab has already tried, so the card below shows
    // rather than the page spinning.
    if (isChunkError(error)) {
      const reloading = recoverFromStaleBundle();
      if (!reloading) this.setState({ recoveryFailed: true });
      return; // stale-bundle is expected post-deploy noise, not a bug to report
    }
    // Forward the real render-time crash to error tracking. No-op unless the
    // build was given VITE_SENTRY_DSN; pairs with the server-side Sentry init.
    captureError(error, { componentStack: info?.componentStack });
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    const chunk = this.state.isChunk;
    // Recovery already used its one attempt: show a spinner-free card with a
    // manual button instead of pretending a reload is still coming.
    const stuck = chunk && this.state.recoveryFailed;
    return (
      <div className="min-h-[60dvh] flex items-center justify-center p-4 sm:p-5">
        <div className="max-w-md w-full text-center bg-white border border-slate-200 rounded-xl shadow-sm p-8">
          <div className={`mx-auto mb-4 h-12 w-12 rounded-full flex items-center justify-center ${chunk ? 'bg-blue-50' : 'bg-red-50'}`}>
            {chunk
              ? <RefreshCw className={`text-blue-500 ${stuck ? '' : 'animate-spin'}`} size={24} />
              : <AlertTriangle className="text-red-500" size={24} />}
          </div>
          <h1 className="text-lg font-semibold text-slate-800">
            {chunk
              ? (stuck ? 'A new version is ready' : 'Updating to the latest version…')
              : 'Something went wrong'}
          </h1>
          <p className="mt-1.5 text-sm text-slate-500">
            {chunk
              ? (stuck
                ? 'This tab is still on the old version. Click Reload — if it persists, press Ctrl+Shift+R once.'
                : 'A newer version was deployed. Fetching it now…')
              : 'An unexpected error interrupted this page. Your data is safe — try reloading.'}
          </p>
          <div className="mt-4 flex justify-center gap-3">
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700"
            >
              Reload
            </button>
            <button
              onClick={() => { window.location.href = '/home'; }}
              className="px-4 py-2 text-sm border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50"
            >
              Back to home
            </button>
          </div>
        </div>
      </div>
    );
  }
}
