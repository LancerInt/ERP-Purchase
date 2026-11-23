import { useState, useEffect, useCallback } from 'react';
import apiClient from '../utils/api.js';

/**
 * Hook to fetch paginated list data from the API.
 *
 * Includes a small module-level stale-while-revalidate cache keyed by
 * endpoint, so navigating back to a list renders instantly from cache
 * instead of flashing a skeleton on every mount:
 *   • cache hit  → render cached rows immediately (no spinner)
 *   • < 5s old   → skip the network entirely (kills rapid back-and-forth refetch)
 *   • >= 5s old  → revalidate in the background and swap in fresh data
 *   • refetch()  → always forces a network fetch and refreshes the cache
 * A background revalidation failure keeps the cached data (no error wipe).
 * Only base requests (no extra query params) are cached.
 *
 * @param {string} endpoint - API endpoint (e.g., '/api/companies/')
 * @param {object} options - { autoFetch: true }
 * @returns {{ data, isLoading, error, refetch, totalCount }}
 */
const _cache = new Map(); // endpoint -> { results, total, ts }
const FRESH_MS = 5000;

export default function useApiData(endpoint, options = {}) {
  const { autoFetch = true } = options;
  const cachedInit = endpoint ? _cache.get(endpoint) : null;
  const [data, setData] = useState(cachedInit ? cachedInit.results : []);
  // Start in the loading state when we'll auto-fetch AND have nothing cached,
  // so list pages show their skeleton immediately instead of flashing empty.
  const [isLoading, setIsLoading] = useState(autoFetch && !cachedInit);
  const [error, setError] = useState(null);
  const [totalCount, setTotalCount] = useState(cachedInit ? cachedInit.total : 0);

  const fetchData = useCallback(async (params = {}, { force = false } = {}) => {
    // A falsy endpoint means "don't fetch yet" — conditional lookups pass
    // null until a dependency is chosen.
    if (!endpoint) { setIsLoading(false); return; }

    const cacheable = Object.keys(params).length === 0;
    const cached = cacheable ? _cache.get(endpoint) : null;
    if (cached) {
      // Render cached rows immediately — no spinner on revisit.
      setData(cached.results);
      setTotalCount(cached.total);
      setError(null);
      setIsLoading(false);
      // Still fresh and not forced → skip the network entirely.
      if (!force && Date.now() - cached.ts < FRESH_MS) return;
    } else {
      setIsLoading(true);
    }
    setError(null);

    try {
      const fetchParams = { page_size: 500, ...params };
      const response = await apiClient.get(endpoint, { params: fetchParams });
      let results = [];
      let total = 0;
      if (response.data && Array.isArray(response.data.results)) {
        let allResults = [...response.data.results];
        total = response.data.count || 0;
        if (total > allResults.length && response.data.next) {
          const pageSize = allResults.length || 500;
          const totalPages = Math.ceil(total / pageSize);
          const failedPages = [];
          for (let batch = 2; batch <= totalPages; batch += 5) {
            const pages = [];
            for (let p = batch; p <= Math.min(batch + 4, totalPages); p++) pages.push(p);
            const settled = await Promise.allSettled(
              pages.map((p) => apiClient.get(endpoint, { params: { ...fetchParams, page: p } }))
            );
            settled.forEach((res, i) => {
              if (res.status === 'fulfilled' && res.value?.data?.results) {
                allResults = allResults.concat(res.value.data.results);
              } else if (res.status === 'rejected') {
                failedPages.push(pages[i]);
                console.warn(`[useApiData] page ${pages[i]} of ${endpoint} failed:`, res.reason?.message || res.reason);
              }
            });
          }
          for (const p of failedPages) {
            try {
              const r = await apiClient.get(endpoint, { params: { ...fetchParams, page: p } });
              if (r.data?.results) allResults = allResults.concat(r.data.results);
            } catch (retryErr) {
              console.warn(`[useApiData] retry of page ${p} of ${endpoint} also failed:`, retryErr?.message);
            }
          }
        }
        results = allResults;
        total = total || allResults.length;
      } else if (Array.isArray(response.data)) {
        results = response.data;
        total = response.data.length;
      }
      setData(results);
      setTotalCount(total);
      if (cacheable) _cache.set(endpoint, { results, total, ts: Date.now() });
    } catch (err) {
      console.error(`[useApiData] Failed to fetch ${endpoint}:`, err);
      // A background revalidation that fails must NOT wipe good cached data.
      if (!cached) {
        setError(err.response?.data || err.message);
        setData([]);
      }
    } finally {
      setIsLoading(false);
    }
  }, [endpoint]);

  // refetch() forces a fresh network fetch (e.g. after a mutation, or Retry).
  //
  // The argument is checked because `onClick={refetch}` and `onRetry={refetch}`
  // are the natural way to wire a Retry button, and React then passes its
  // SYNTHETIC EVENT as `params`. fetchData spreads params into the query
  // string, so the request went out as
  //   /api/purchase/orders/?page_size=500&reactName=onClick&type=click...
  // That is not cosmetic: the junk made every retry a distinct URL, so nothing
  // could be served from cache, and each click re-fetched the whole list. A
  // real waterfall showed the same endpoint pulled four times, 14–30s apiece.
  // Guarding here fixes every call site at once rather than relying on each
  // one remembering to write `() => refetch()`.
  const refetch = useCallback((params) => {
    const isEvent = params && typeof params === 'object'
      && ('nativeEvent' in params || 'target' in params || '_reactName' in params);
    const safe = (!params || isEvent || typeof params !== 'object') ? {} : params;
    return fetchData(safe, { force: true });
  }, [fetchData]);

  useEffect(() => {
    if (autoFetch) {
      fetchData();
    }
  }, [autoFetch, fetchData]);

  return { data, isLoading, error, refetch, totalCount };
}
