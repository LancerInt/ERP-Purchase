/**
 * "You're about to be signed out" — shown by useIdleTimeout shortly before an
 * idle session ends.
 *
 * The point is to never take work away without notice. Any mouse or key press
 * anywhere already counts as activity and dismisses this, so the button is a
 * reassurance rather than the only way out.
 *
 * Deliberately NOT a focus-trapping modal: trapping focus would swallow the
 * very keystrokes that prove the user is still there, and a person returning
 * to their desk should be able to carry straight on typing.
 */
import { Clock } from 'lucide-react';

export default function IdleWarningDialog({ open, secondsLeft, onStay }) {
  if (!open) return null;

  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label="Session about to expire"
      className="fixed bottom-4 right-4 z-[1000] w-[min(22rem,calc(100vw-2rem))]
                 rounded-xl border border-amber-300 bg-white shadow-xl
                 ring-1 ring-black/5 p-4"
    >
      <div className="flex items-start gap-3">
        <span className="shrink-0 grid place-items-center w-9 h-9 rounded-lg bg-amber-50 text-amber-600">
          <Clock size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">Still there?</p>
          <p className="mt-0.5 text-xs text-slate-600">
            You&apos;ll be signed out in{' '}
            {/* tabular-nums so the box doesn't twitch as the count changes */}
            <span className="font-semibold text-slate-900 tabular-nums">{secondsLeft}s</span>
            {' '}due to inactivity. Any key or click keeps you signed in.
          </p>
          <button
            type="button"
            onClick={onStay}
            className="mt-2.5 h-8 px-3 rounded-lg bg-blue-600 text-white text-xs font-medium
                       hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500
                       focus:ring-offset-1"
          >
            Stay signed in
          </button>
        </div>
      </div>
    </div>
  );
}
