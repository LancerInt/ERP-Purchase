/**
 * Auth token storage that honours the login "Remember me" choice.
 *
 *   Remember me ON  → localStorage: the session survives a browser restart
 *                     (and is shared across tabs).
 *   Remember me OFF → sessionStorage: tab-isolated, cleared when the tab/
 *                     browser closes (the original default behaviour).
 *
 * There is a single source of truth at a time — writing to one storage clears
 * the other. Reads prefer a remembered (localStorage) session, then fall back
 * to sessionStorage.
 */
const KEYS = ['accessToken', 'refreshToken', 'user'];

// One-time session inheritance for in-app "open in new tab" links.
// A tab opened via target="_blank" from another tab of THIS app starts with
// empty sessionStorage, so a "remember me OFF" session (which lives only in
// sessionStorage) would bounce it to login. If this tab has no session of its
// own but its opener (same origin) does, copy the opener's sessionStorage
// session across. A hand-typed / bookmarked new tab has no opener, so the
// tab-isolated behaviour of a non-remembered session is preserved.
let _inheritTried = false;
const _inheritFromOpener = () => {
  if (_inheritTried) return;
  _inheritTried = true;
  try {
    if (typeof window === 'undefined') return;
    if (localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken')) return;
    const op = window.opener;
    if (!op || op.closed) return;
    const os = op.sessionStorage;             // throws if cross-origin — caught below
    if (!os || !os.getItem('accessToken')) return;
    KEYS.forEach((k) => {
      const v = os.getItem(k);
      if (v != null) sessionStorage.setItem(k, v);
    });
  } catch { /* cross-origin / blocked opener — fall through to login */ }
};

export const authGet = (key) => {
  if (typeof window === 'undefined') return null;
  _inheritFromOpener();
  const v = localStorage.getItem(key);
  return v != null ? v : sessionStorage.getItem(key);
};

// Where the current session lives — localStorage if a remembered session
// exists, otherwise sessionStorage.
const activeStore = () =>
  (typeof window !== 'undefined' && localStorage.getItem('accessToken'))
    ? localStorage
    : sessionStorage;

// Persist a whole session to the chosen storage and clear the other one.
export const authSetSession = ({ access, refresh, user, remember }) => {
  if (typeof window === 'undefined') return;
  const store = remember ? localStorage : sessionStorage;
  const other = remember ? sessionStorage : localStorage;
  KEYS.forEach((k) => other.removeItem(k));
  if (access != null) store.setItem('accessToken', access);
  if (refresh != null) store.setItem('refreshToken', refresh);
  if (user != null) store.setItem('user', typeof user === 'string' ? user : JSON.stringify(user));
};

// Replace just the access token (token refresh) in whichever storage holds
// the current session.
export const authSetAccess = (access) => {
  if (typeof window === 'undefined' || access == null) return;
  activeStore().setItem('accessToken', access);
};

// Replace just the refresh token. ROTATE_REFRESH_TOKENS is on, so every
// refresh hands back a new one and the token just spent must not be kept —
// once the blacklist app is enabled, re-using a spent token 401s and the user
// lands back on the login screen.
export const authSetRefresh = (refresh) => {
  if (typeof window === 'undefined' || refresh == null) return;
  activeStore().setItem('refreshToken', refresh);
};

export const authClear = () => {
  if (typeof window === 'undefined') return;
  KEYS.forEach((k) => { localStorage.removeItem(k); sessionStorage.removeItem(k); });
};
