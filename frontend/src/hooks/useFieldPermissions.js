import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import apiClient from '../utils/api.js';

// In-flight + result caches keyed by `${token}::${module}`. Multiple
// components rendering the same form (header section, line section,
// preview pane) end up needing the same field-perm map; we de-dupe
// the request so the user's create page doesn't fire 5 identical
// GETs on mount.
const RESULT_CACHE = new Map();
const INFLIGHT = new Map();

/**
 * Returns the requesting user's field-level access map for a single
 * module — e.g. `{ payment_due_date: 'HIDDEN', discount: 'READ_ONLY' }`.
 *
 * Forms can use it to skip rendering HIDDEN inputs entirely and mark
 * READ_ONLY ones as `disabled`. The backend GET endpoints already
 * strip HIDDEN fields from list/detail responses, but create/edit
 * forms have no response to inspect — they need this preflight.
 *
 * Returns:
 *   { fields, isLoading, isHidden, isReadOnly }
 *
 *   fields     — { fieldKey: 'HIDDEN' | 'READ_ONLY' } (only restricted
 *                fields appear; VIEW / unrestricted keys are absent)
 *   isHidden   — helper: fieldKey => boolean
 *   isReadOnly — helper: fieldKey => boolean
 *   isLoading  — initial fetch only; false on cache hit
 */
export default function useFieldPermissions(moduleName) {
  const token = useSelector(state => state.auth?.token);
  const [fields, setFields] = useState({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!token || !moduleName) {
      setFields({});
      setIsLoading(false);
      return;
    }
    const cacheKey = `${token}::${moduleName}`;

    // Cache hit — render synchronously.
    if (RESULT_CACHE.has(cacheKey)) {
      setFields(RESULT_CACHE.get(cacheKey));
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    // Coalesce in-flight requests so 5 components on the same form
    // share one HTTP round-trip.
    let promise = INFLIGHT.get(cacheKey);
    if (!promise) {
      promise = apiClient
        .get('/api/rbac/my-field-permissions/', { params: { module: moduleName } })
        .then((res) => {
          const data = res?.data?.fields || {};
          RESULT_CACHE.set(cacheKey, data);
          return data;
        })
        .catch(() => ({})) // fail-open: empty map = no restrictions
        .finally(() => INFLIGHT.delete(cacheKey));
      INFLIGHT.set(cacheKey, promise);
    }

    let cancelled = false;
    promise.then((data) => {
      if (cancelled) return;
      setFields(data);
      setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, [token, moduleName]);

  const isHidden   = (key) => fields[key] === 'HIDDEN';
  const isReadOnly = (key) => fields[key] === 'READ_ONLY';

  return { fields, isLoading, isHidden, isReadOnly };
}

/** Clear after the admin updates field perms — same pattern as
 *  clearPermissionsCache() in usePermissions.js. */
export function clearFieldPermissionsCache() {
  RESULT_CACHE.clear();
  INFLIGHT.clear();
}
