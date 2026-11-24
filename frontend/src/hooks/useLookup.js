import { useState, useEffect, useRef } from 'react';
import apiClient from '../utils/api.js';

/**
 * Cache for lookup data to avoid redundant API calls across components.
 */
const cache = {};

/*
 * Keeping the cache FRESH without re-downloading it.
 *
 * The cache above lives as long as the browser tab and was never revalidated,
 * so a vendor created by someone else did not appear in anybody's dropdown
 * until they reloaded the page - in a tab left open all day, possibly never.
 *
 * Re-fetching on a timer would fix that and cost a fortune: 132 KB of vendors
 * on 28 pages, 531 KB of products on 21.
 *
 * So we ask a much smaller question instead. /api/lookups/version/ returns one
 * short token per list, and only the lists whose token CHANGED are fetched
 * again. One poll covers every cached list at once, so the cost does not grow
 * with the number of dropdowns on the page.
 *
 * The poll pauses while the tab is hidden - a background tab has nobody
 * looking at its dropdowns - and resumes with an immediate check when the tab
 * comes back, so returning to a tab shows current data straight away.
 *
 * The interval comes from the SERVER (LOOKUP_VERSION_INTERVAL), so it can be
 * tuned on a live service without rebuilding the frontend.
 */
/**
 * Fetch every page of a lookup endpoint. Returns the rows, or null when the
 * request failed - null means "keep what you already have", which matters for
 * the background poller: a dropped network must never blank a dropdown.
 *
 * Lifted out of the hook so the poller can reuse the exact same paging, rather
 * than a second copy of it that could drift.
 */
async function fetchAll(endpoint) {
  try {

      // Walk DRF pagination until exhausted. Previously this hook
      // requested a single page with page_size=500, which silently
      // clipped master tables that have grown past that — e.g. the
      // Product master is over 500 rows, and dropdowns were missing
      // entries like "Amino Acid Powder" on Quote / PR / Receipt forms.
      // Backend caps page_size at 1000, so 1000-per-page is the max.
      // Page 1 first — its `count` tells us how many more there are, so the
      // REST GO OUT TOGETHER instead of one-after-another. The old loop
      // awaited inside a for, which on the Product master (4 pages) meant
      // four sequential round trips: a real waterfall showed page 3 at
      // 11.1s and page 4 at 8.8s, ~40s of serial waiting to populate one
      // dropdown. Concurrent, the whole thing costs about one page.
      const PAGE = 1000;
      const MAX_PAGES = 20;   // 20k-row ceiling, as before
      const first = await apiClient.get(endpoint, {
        params: { page_size: PAGE, page: 1 },
      });
      const firstData = first.data;
      const firstRows = firstData?.results || (Array.isArray(firstData) ? firstData : []);
      const all = [...firstRows];
      if (firstData?.next && firstRows.length > 0) {
        const count = firstData?.count || 0;
        const totalPages = Math.min(MAX_PAGES, Math.ceil(count / firstRows.length));
        const rest = [];
        for (let p = 2; p <= totalPages; p++) rest.push(p);
        // allSettled, not all: one failed page must not throw away the
        // pages that did arrive — a partly-filled dropdown beats an empty one.
        const settled = await Promise.allSettled(
          rest.map((p) => apiClient.get(endpoint, { params: { page_size: PAGE, page: p } })),
        );
        settled.forEach((r) => {
          if (r.status === 'fulfilled') all.push(...(r.value?.data?.results || []));
        });
      }
      if (import.meta.env.DEV) {
        console.log(`[useLookup] ${endpoint}: fetched ${all.length} items`);
      }
    return all;
  } catch (err) {
    console.error(`[useLookup] Failed to fetch ${endpoint}:`, err?.response?.status, err?.response?.data || err.message);
    return null;
  }
}

const versions = {};            // endpoint -> last token seen
const subscribers = {};         // endpoint -> Set<fn>, so views re-render
let pollTimer = null;
let pollSeconds = 10;
let pollInFlight = false;

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function subscribe(endpoint, fn) {
  (subscribers[endpoint] || (subscribers[endpoint] = new Set())).add(fn);
  startPolling();
  return () => {
    const set = subscribers[endpoint];
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) delete subscribers[endpoint];
    if (watchedEndpoints().length === 0) stopPolling();
  };
}

function watchedEndpoints() {
  // Only lists something on screen is actually using.
  return Object.keys(subscribers).filter((e) => subscribers[e].size > 0);
}

async function refill(endpoint) {
  const rows = await fetchAll(endpoint);
  if (rows === null) return;            // failed - keep what we have
  cache[endpoint] = rows;
  (subscribers[endpoint] || []).forEach((fn) => fn(rows));
}

async function checkVersions() {
  if (pollInFlight || document.visibilityState === 'hidden') return;
  const list = watchedEndpoints();
  if (list.length === 0) return;
  pollInFlight = true;
  try {
    // The query string is built by hand on purpose. Passing { e: [...] } to
    // axios serialises it as e[]=…&e[]=… by default, which Django's
    // getlist('e') does not see at all - the poll would have run forever and
    // silently done nothing. Spelling it out removes the dependency on a
    // library default that nothing here pins.
    const qs = list.map((e) => `e=${encodeURIComponent(e)}`).join('&');
    const { data } = await apiClient.get(`/api/lookups/version/?${qs}`);
    if (data?.interval > 0 && data.interval !== pollSeconds) {
      pollSeconds = data.interval;
      startPolling(true);               // adopt the server's interval
    }
    const got = data?.versions || {};
    await Promise.all(Object.keys(got).map(async (endpoint) => {
      const token = got[endpoint];
      if (token == null) return;        // server could not place it - leave alone
      const known = versions[endpoint];
      versions[endpoint] = token;
      // No token yet means this is the first look; nothing has changed since.
      if (known !== undefined && known !== token) await refill(endpoint);
    }));
  } catch {
    // A failed poll changes nothing. The next one tries again.
  } finally {
    pollInFlight = false;
  }
}

function startPolling(restart = false) {
  if (pollTimer && !restart) return;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(checkVersions, Math.max(3, pollSeconds) * 1000);
}

if (typeof document !== 'undefined') {
  // Coming back to a tab should show current data at once, not after a wait.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkVersions();
  });
}

/**
 * Hook to fetch lookup/dropdown data from API endpoints.
 * Caches results so multiple forms on the same page don't re-fetch.
 *
 * @param {string} endpoint - API endpoint (e.g., '/api/companies/')
 * @param {object} options - { labelField, valueField, autoFetch }
 * @returns {{ options: [{value, label}], isLoading, raw }}
 */
export default function useLookup(endpoint, options = {}) {
  const {
    labelField = 'name',
    valueField = 'id',
    autoFetch = true,
    // `fresh: true` bypasses the module cache on mount and always refetches.
    // Use for volatile/transactional lists (POs, job-work orders) whose rows
    // change during a session — master data (vendors, products) can stay
    // cached. The fetched result still updates the shared cache for others.
    fresh = false,
  } = options;

  const [items, setItems] = useState(cache[endpoint] || []);
  const [isLoading, setIsLoading] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!autoFetch || !endpoint) return;

    // Use cache if available and non-empty — unless `fresh` forces a refetch
    // (the form needs the current list, e.g. POs created since first load).
    if (!fresh && cache[endpoint] && cache[endpoint].length > 0) {
      setItems(cache[endpoint]);
      return;
    }

    const fetchData = async () => {
      setIsLoading(true);
      const rows = await fetchAll(endpoint);
      if (rows !== null) {
        cache[endpoint] = rows;
        // Tell every OTHER instance of this list (e.g. a second Tally modal on
        // the same page) that fresh rows arrived. Without this, two modals each
        // fire their own fetch; if one fails while the other succeeds, the
        // failed one would sit empty forever — the "Revert" modal's company
        // dropdown coming up blank while "Import" is fine.
        (subscribers[endpoint] || []).forEach((fn) => fn(rows));
      }
      if (mounted.current) {
        // On failure, fall back to whatever another instance already cached
        // rather than blanking the dropdown.
        setItems(rows !== null ? rows : (cache[endpoint] || []));
        setIsLoading(false);
      }
    };

    fetchData();
  }, [endpoint, autoFetch, fresh]);

  // Re-render when the background version check refills this list. Without
  // this the cache would update and the dropdown on screen would not.
  useEffect(() => {
    if (!endpoint || !autoFetch) return undefined;
    return subscribe(endpoint, (rows) => {
      if (mounted.current) setItems(rows);
    });
  }, [endpoint, autoFetch]);

  // Build options array for <select> elements
  const selectOptions = items.map(item => ({
    value: item[valueField],
    label: typeof labelField === 'function'
      ? labelField(item)
      : (item[labelField]
        || item.name
        || item.product_name
        || item.godown_name
        || item.legal_name
        || item.vendor_name
        || item.vendor_code
        || item.customer_name
        || item.customer_code
        || item.transporter_code
        || item.staff_id
        || item.first_name
        || item.sku_code
        || item.template_id
        || item.shift_code
        || item.role_name
        || item.pr_no
        || item.rfq_no
        || item.po_no
        || item.so_no
        || item.warehouse_code
        || item.godown_code
        || item[valueField]
      ),
  }));

  return { options: selectOptions, isLoading, raw: items };
}

/**
 * Clear the lookup cache (e.g., after creating a new record).
 */
export function clearLookupCache(endpoint) {
  if (endpoint) {
    delete cache[endpoint];
  } else {
    Object.keys(cache).forEach(k => delete cache[k]);
  }
}
