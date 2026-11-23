/**
 * The ONE filter vocabulary shared by the three Purchase report pages:
 *
 *   Purchase Dashboard  /purchase/overview
 *   Purchase Analytics  /purchase/dashboard
 *   Vendor Insights     /purchase/vendor-insights
 *
 * Pick a company / period / vendor on any of them and the next one opens on the
 * SAME window instead of resetting to its own default. Press Back and you land
 * on the page you came from, still filtered.
 *
 * WHY TWO STORES, URL *AND* SESSION
 * ---------------------------------
 * The URL is the source of truth: it makes Back, Forward, refresh and a pasted
 * link all reproduce one exact view, and it is what the drill-downs already
 * read. But nothing links these three pages to each other -- you move between
 * them through the SIDEBAR, and a sidebar link is a bare path with no query. So
 * a URL-only design would carry the filter through drill-downs and lose it on
 * the one navigation people actually use.
 *
 * Mirroring into sessionStorage fixes that without touching the sidebar (which
 * is shared by every module and must not learn about purchase filters). Arriving
 * with no params, a page restores the last filter and rewrites its own URL with
 * `replace`, so history still holds a complete, re-openable address.
 *
 * Session, not local: this follows one working session and dies with the tab,
 * which is the behaviour you want from a filter -- reopening the ERP tomorrow
 * should not silently hide half the data behind last week's company pick.
 *
 * Clearing a filter writes the cleared state through, so nothing resurrects.
 */
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/** Every key the three pages share. Anything else in the URL is left alone. */
export const FILTER_KEYS = [
  'period', 'anchor', 'from', 'to',
  'company', 'warehouse', 'vendor', 'product', 'transfers',
];

const STORE = 'purchase.reportFilter';

/** `?period=month&company=…` for a link, or '' when nothing is set. */
export const filterQuery = (params) => {
  const p = new URLSearchParams();
  FILTER_KEYS.forEach((k) => {
    const v = params.get(k);
    if (v) p.set(k, v);
  });
  const s = p.toString();
  return s ? `?${s}` : '';
};

const readStore = () => {
  try {
    const raw = sessionStorage.getItem(STORE);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;   // private window, storage disabled — behave as if empty
  }
};

const writeStore = (params) => {
  try {
    const o = {};
    FILTER_KEYS.forEach((k) => {
      const v = params.get(k);
      if (v) o[k] = v;
    });
    sessionStorage.setItem(STORE, JSON.stringify(o));
  } catch {
    /* storage unavailable — the URL still works, so this is a no-op */
  }
};

/**
 * Filter state for one of the three report pages.
 *
 *   const f = usePurchaseFilter({ period: 'month' });
 *   f.get('company')            // current value
 *   f.setFilter({ company: id })// writes URL + session
 *   f.query                     // '?…' to hang on a link to a sibling page
 *
 * `defaults` seeds ONLY a first visit with an empty URL and empty session, so a
 * page keeps its own sensible opening window (Analytics 'month', Vendor Insights
 * 'fy') until someone actually chooses something.
 */
export function usePurchaseFilter(defaults = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const seeded = useRef(false);

  const hasAny = FILTER_KEYS.some((k) => searchParams.get(k));

  // Arrived with a bare URL (sidebar click): re-apply what was last chosen.
  // `replace` on purpose — restoring is not a destination, and pushing here
  // would make Back bounce between the bare and the restored address.
  useEffect(() => {
    if (seeded.current || hasAny) {
      seeded.current = true;
      return;
    }
    seeded.current = true;
    const saved = readStore() || {};
    const merged = { ...defaults, ...saved };
    const keys = Object.keys(merged).filter((k) => merged[k]);
    if (!keys.length) return;
    const p = new URLSearchParams(searchParams);
    keys.forEach((k) => p.set(k, merged[k]));
    setSearchParams(p, { replace: true });
    // defaults is a fresh literal each render; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAny]);

  // Keep the session copy in step with whatever the address says.
  useEffect(() => {
    if (hasAny) writeStore(searchParams);
  }, [searchParams, hasAny]);

  const get = (key, fallback = '') => searchParams.get(key) || fallback;

  // `replace` by default: picking a filter is not a destination, and one
  // history entry per click would make Back walk you through every pick.
  //
  // `{ push: true }` is for the exception -- a change that IS a destination,
  // like opening one vendor's 360 view. Without a history entry there, Back
  // skips the whole page and lands on whatever you were looking at before it,
  // instead of returning to the list you drilled in from.
  const setFilter = (patch, { push = false } = {}) => setSearchParams((prev) => {
    const p = new URLSearchParams(prev);
    Object.entries(patch).forEach(([k, v]) => { if (v) p.set(k, v); else p.delete(k); });
    return p;
  }, { replace: !push });

  return { searchParams, get, setFilter, query: filterQuery(searchParams) };
}
