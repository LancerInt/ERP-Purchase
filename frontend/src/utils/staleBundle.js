/**
 * Recovery from a stale frontend bundle — the "page keeps refreshing" bug.
 *
 * WHAT GOES WRONG
 * ---------------
 * Every page under a lazy route is its own hashed chunk (bills-a3f9c1.js). A
 * deploy renames them all and deletes the old ones. A browser still holding the
 * PREVIOUS index.html then asks for a chunk that no longer exists, the dynamic
 * import rejects, and React throws.
 *
 * The old recovery called window.location.reload(). That re-requests the SAME
 * url, so the browser is free to serve the SAME cached index.html, pointing at
 * the SAME dead chunk — and it loops. From the outside: the page refreshes,
 * comes back, and refreshes again. It hit every lazy-loaded page, which is why
 * a whole module could appear to break at once.
 *
 * THE FIX
 * -------
 * Reload through a url the cache has never seen, by adding a one-shot
 * cache-busting parameter. A different url cannot hit the stale cache entry, so
 * the fresh index.html arrives and the new chunk names come with it.
 *
 * WHY A COOLDOWN AND NOT A ONE-SHOT FLAG
 * --------------------------------------
 * The obvious guard — set a flag, clear it once the app mounts — does not hold.
 * Reaching main.jsx only proves the ENTRY bundle loaded; a lazy chunk can still
 * be missing, so the flag would be cleared moments before the next failure and
 * the loop would continue, just more slowly.
 *
 * So the guard is time, not a boolean: one recovery per COOLDOWN_MS. A genuine
 * refresh loop is stopped after a single attempt (the caller shows a card with
 * a manual Reload). A real deploy an hour later is still recovered from
 * automatically, because by then the cooldown has expired.
 */

const KEY = 'staleBundleRecoveredAt';
const PARAM = '_v';
const COOLDOWN_MS = 60_000;

/** True when the error is a failed dynamic import rather than an app bug. */
export function isStaleBundleError(error) {
  if (!error) return false;
  if (error.name === 'ChunkLoadError') return true;
  const msg = error.message || String(error);
  return /(Loading chunk [\w-]+ failed|ChunkLoadError|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|dynamically imported module)/i.test(msg);
}

/**
 * Reload once onto a fresh bundle.
 * @returns {boolean} true when a reload was started; false when one was already
 *   attempted inside the cooldown, and the caller should show the error card
 *   instead of waiting for a navigation that will not come.
 */
export function recoverFromStaleBundle() {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(KEY) || 0);
  } catch {
    // Storage blocked (private window, site data off). Without a guard a reload
    // could spin forever, so decline and let the manual card show.
    return false;
  }
  if (Date.now() - last < COOLDOWN_MS) return false;

  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false;
  }

  try {
    const url = new URL(window.location.href);
    url.searchParams.set(PARAM, String(Date.now()));
    window.location.replace(url.toString());   // replace: no junk history entry
  } catch {
    window.location.reload();                  // last resort
  }
  return true;
}

/**
 * Tidy the cache-busting parameter out of the address bar once the app is
 * running, so the url stays clean and shareable. Uses replaceState, so Back is
 * unaffected.
 *
 * Deliberately does NOT clear the cooldown — see the note above.
 */
export function tidyStaleBundleParam() {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has(PARAM)) {
      url.searchParams.delete(PARAM);
      window.history.replaceState(window.history.state, '', url.toString());
    }
  } catch {
    /* malformed url — leaving the parameter is harmless */
  }
}
