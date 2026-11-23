import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Page number that lives in the URL (?page=N) instead of local state.
 *
 * Why: these list pages load the whole data set and paginate client-side, so
 * the page number was plain useState(1). Opening a record and pressing Back
 * remounts the list with that state reset — you were on page 52, you land on
 * page 1. Keeping the page in the query string means Back restores it, exactly
 * like the search term and sort already do (see DataTable's persistKey and the
 * debit-notes page, which do this by hand).
 *
 * `resetDeps` is the filter/search signature: when it changes the page number
 * is no longer meaningful (you can't be on page 52 of a three-page result), so
 * it resets to 1 — but never on the first render, which is where a page
 * restored from the URL on Back must be left intact.
 *
 * Drop-in for `const [page, setPage] = useState(1)`: returns [page, setPage],
 * and setPage takes a number or an updater, matching DataTable's onPageChange.
 */
export default function useUrlPage(resetDeps = []) {
  const [sp, setSp] = useSearchParams();
  const page = Math.max(1, parseInt(sp.get('page'), 10) || 1);

  const setPage = (val) => {
    const v = typeof val === 'function' ? val(page) : val;
    const next = new URLSearchParams(sp);
    if (v > 1) next.set('page', String(v)); else next.delete('page');
    if (next.toString() !== sp.toString()) setSp(next, { replace: true });
  };

  const sig = JSON.stringify(resetDeps);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  return [page, setPage];
}
