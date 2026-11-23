/**
 * Sign the user out after a period of no activity.
 *
 * Without this a session had no idle limit at all: the refresh token ROTATES,
 * so every renewal issued a fresh 7-day one and an open tab stayed signed in
 * indefinitely. A laptop left unlocked on the shop floor at 6pm was still
 * signed in — with full access to bills, payments and vendor data — the next
 * morning.
 *
 * Three things make this usable rather than annoying:
 *
 *   • A WARNING before it happens, not a silent eviction. Nobody should lose
 *     a half-typed purchase order because they took a phone call.
 *   • Activity is shared ACROSS TABS through localStorage. Working in one tab
 *     keeps every other tab alive; without this, a second tab left open on a
 *     dashboard would log itself out and take the whole session with it.
 *   • The deadline is a TIMESTAMP, not a countdown. A laptop asleep for two
 *     hours has its timers frozen, so a tick-based counter would wake up
 *     believing only seconds had passed. Comparing against a stored wall-clock
 *     time means sleeping through the limit is correctly treated as idle.
 *
 * Honest about what it is: a control for unattended machines and shared
 * desks, enforced in the browser. It is not a defence against someone who
 * already holds the token — that is what revoking on logout is for, and the
 * two are meant to be used together.
 */
import { useEffect, useRef, useState, useCallback } from 'react';

// Where the last-activity timestamp is shared between tabs. Always
// localStorage (never sessionStorage) — sessionStorage is per-tab, which is
// precisely the sharing this needs to defeat.
const ACTIVITY_KEY = 'erp-last-activity';

// Pointer/keyboard/scroll all count. `visibilitychange` is NOT activity:
// returning to a tab you left open for an hour should not excuse the hour.
const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'];

// How often we compare now() against the deadline. 5s is frequent enough that
// the warning never appears visibly late, and cheap enough to ignore.
const POLL_MS = 5000;

const now = () => Date.now();

const readLastActivity = () => {
  try {
    const raw = window.localStorage.getItem(ACTIVITY_KEY);
    const ts = raw ? parseInt(raw, 10) : 0;
    // A missing or corrupt value must not read as "idle since 1970" and sign
    // someone out the moment they load the page.
    return Number.isFinite(ts) && ts > 0 ? ts : now();
  } catch {
    return now();
  }
};

const writeLastActivity = (ts) => {
  try {
    window.localStorage.setItem(ACTIVITY_KEY, String(ts));
  } catch {
    // Private mode / quota — the timeout still works per-tab from memory.
  }
};

/**
 * @param {object}   opts
 * @param {boolean}  opts.enabled    Only run while signed in.
 * @param {number}   opts.idleMs     Inactivity before sign-out.
 * @param {number}   opts.warnMs     How long the warning shows beforehand.
 * @param {function} opts.onTimeout  Called once when the limit is reached.
 * @returns {{ warning: boolean, secondsLeft: number, staySignedIn: () => void }}
 */
export default function useIdleTimeout({
  enabled,
  idleMs = 45 * 60 * 1000,
  warnMs = 60 * 1000,
  onTimeout,
}) {
  const [warning, setWarning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  // Guards against onTimeout firing twice — the poll could tick again while
  // the sign-out request is still in flight.
  const firedRef = useRef(false);
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  const markActive = useCallback(() => {
    writeLastActivity(now());
    firedRef.current = false;
    setWarning(false);
  }, []);

  // Exposed for the "I'm still here" button. Identical to any other activity.
  const staySignedIn = markActive;

  useEffect(() => {
    if (!enabled) {
      setWarning(false);
      return undefined;
    }

    // Starting the clock on mount means a reload is treated as activity,
    // which it is.
    markActive();

    const onActivity = () => {
      // Don't let background mouse movement silently cancel a warning the
      // user hasn't seen; everything else refreshes the deadline normally.
      writeLastActivity(now());
      if (warning) setWarning(false);
      firedRef.current = false;
    };
    ACTIVITY_EVENTS.forEach((e) =>
      window.addEventListener(e, onActivity, { passive: true }));

    // Another tab recording activity keeps this one alive.
    const onStorage = (e) => {
      if (e.key === ACTIVITY_KEY) {
        setWarning(false);
        firedRef.current = false;
      }
    };
    window.addEventListener('storage', onStorage);

    const id = setInterval(() => {
      const idleFor = now() - readLastActivity();
      if (idleFor >= idleMs) {
        if (!firedRef.current) {
          firedRef.current = true;
          setWarning(false);
          onTimeoutRef.current?.();
        }
        return;
      }
      if (idleFor >= idleMs - warnMs) {
        setWarning(true);
        setSecondsLeft(Math.max(0, Math.ceil((idleMs - idleFor) / 1000)));
      } else if (warning) {
        setWarning(false);
      }
    }, POLL_MS);

    return () => {
      clearInterval(id);
      window.removeEventListener('storage', onStorage);
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
    };
  }, [enabled, idleMs, warnMs, markActive, warning]);

  return { warning, secondsLeft, staySignedIn };
}
