import { useEffect, useState } from 'react';
import apiClient from '../../../utils/api.js';

// Shared cache so multiple purchase forms on the same SPA session don't
// each re-fetch the master. Mirrors the cache strategy of the global
// useLookup hook but is scoped to the purchase module.
const cache = { items: null, inflight: null };

// Hook used across every purchase form (PR, RFQ, Quote, PO, Receipt,
// Rejection, Bill, Vendor Credit, Freight). Walks DRF pagination until
// exhausted so the Product dropdown always reflects the full active
// Product master — the global useLookup hook caps at one page of 500
// rows, which silently hides products past that boundary.
//
// Returns the same shape as useLookup for drop-in replacement:
//   { options: [{ value, label }], raw: Product[], isLoading }
export default function useAllProducts() {
  const [raw, setRaw] = useState(cache.items || []);
  const [isLoading, setIsLoading] = useState(!cache.items);

  useEffect(() => {
    let cancelled = false;

    if (cache.items) {
      setRaw(cache.items);
      setIsLoading(false);
      return undefined;
    }

    const fetchAll = async () => {
      // Page 1 first — its `count` tells us how many more pages exist, so
      // the rest can be requested concurrently instead of one-after-another
      // (see useLookup.js, which fixed the same waterfall for other masters).
      const PAGE = 1000;
      const MAX_PAGES = 20; // 20k row safety cap.
      const first = await apiClient.get('/api/products/', {
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
          rest.map((p) => apiClient.get('/api/products/', { params: { page_size: PAGE, page: p } })),
        );
        settled.forEach((r) => {
          if (r.status === 'fulfilled') all.push(...(r.value?.data?.results || []));
        });
      }
      return all;
    };

    if (!cache.inflight) {
      cache.inflight = fetchAll()
        .then((all) => {
          cache.items = all;
          if (import.meta.env.DEV) {
            console.log(`[useAllProducts] loaded ${all.length} products`);
          }
          return all;
        })
        .catch((err) => {
          console.error('[useAllProducts] fetch failed:', err?.response?.status, err?.message);
          return [];
        })
        .finally(() => {
          cache.inflight = null;
        });
    }

    cache.inflight.then((all) => {
      if (cancelled) return;
      setRaw(all);
      setIsLoading(false);
    });

    return () => { cancelled = true; };
  }, []);

  const options = raw.map((p) => ({
    value: p.id,
    label: p.product_name + (p.sku_code ? ` (${p.sku_code})` : ''),
  }));

  return { options, raw, isLoading };
}

// Clear the cache — call after creating a new product in the master so
// subsequent dropdown opens pick up the new row without a full reload.
export function clearAllProductsCache() {
  cache.items = null;
}
