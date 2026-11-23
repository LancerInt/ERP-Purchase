import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * useState-like state backed by a URL query param, so Back / refresh / paste
 * restore it. A value change REPLACES the history entry (a filter tweak is not
 * a new page in history); opening a record/drill from the filtered list should
 * still be a normal `navigate(...)` (a push), so Back returns to the filtered
 * list — and a drill that itself sets more params keeps nesting, because every
 * level's filters live in the URL.
 *
 *   const [status, setStatus] = useUrlState('status', '');   // drop-in for useState('')
 *
 * The value is always a string. When it equals the default (or is empty) the
 * param is removed, keeping the URL clean. setStatus accepts a value or an
 * updater function, like useState.
 */
export function useUrlState(key, defaultValue = '') {
  const [sp, setSp] = useSearchParams();
  const value = sp.get(key) ?? defaultValue;
  const setValue = useCallback((next) => {
    setSp((prev) => {
      const p = new URLSearchParams(prev);
      const cur = p.get(key) ?? defaultValue;
      const v = typeof next === 'function' ? next(cur) : next;
      if (v === undefined || v === null || v === '' || v === defaultValue) p.delete(key);
      else p.set(key, String(v));
      return p;
    }, { replace: true });
  }, [key, defaultValue, setSp]);
  return [value, setValue];
}

/**
 * A whole map of filters in the URL — the drop-in for the masters/list template
 * that holds a `filterValues` object in useState. Pass the defaults (keys +
 * their empty values); reads come from the URL, writes replace history.
 *
 *   const { values, setValue, reset } = useUrlFilters({ status: '', company: '' });
 *   <Select value={values.status} onChange={e => setValue('status', e.target.value)} />
 *
 * `prefix` namespaces the params (e.g. 'f_') when a page already uses plain
 * names like `company`/`status` for something else; default is no prefix.
 */
export function useUrlFilters(defaults = {}, prefix = '') {
  const [sp, setSp] = useSearchParams();
  const k = (name) => `${prefix}${name}`;
  const values = {};
  for (const name of Object.keys(defaults)) {
    values[name] = sp.get(k(name)) ?? defaults[name] ?? '';
  }
  const setValue = useCallback((name, v) => {
    setSp((prev) => {
      const p = new URLSearchParams(prev);
      const def = defaults[name] ?? '';
      if (v === undefined || v === null || v === '' || v === def) p.delete(k(name));
      else p.set(k(name), String(v));
      return p;
    }, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSp, prefix, JSON.stringify(defaults)]);
  const reset = useCallback(() => {
    setSp((prev) => {
      const p = new URLSearchParams(prev);
      for (const name of Object.keys(defaults)) p.delete(k(name));
      return p;
    }, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSp, prefix, JSON.stringify(defaults)]);
  const anyActive = Object.keys(defaults).some((name) => values[name] && values[name] !== (defaults[name] ?? ''));
  return { values, setValue, reset, anyActive };
}

/**
 * The advanced rule-builder (FilterPanel advanced mode) backed by the URL.
 * Rules are an array of {field, operator, value, value2}; logic is 'AND'|'OR'.
 * The applied set is READ from the URL (so it survives Back/refresh/share even
 * while the panel is closed) and written on Apply/Reset (replace history).
 *
 *   const { rules: advancedRules, logic: advancedLogic, setAdvanced } = useUrlAdvancedRules();
 *   <FilterPanel ... onAdvancedFilter={(r,l)=>setAdvanced(r,l)} initialRules={advancedRules} initialLogic={advancedLogic} />
 *   // apply: applyAdvancedFilters(data, advancedRules, advancedLogic)
 */
export function useUrlAdvancedRules(urlKey = 'adv') {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get(urlKey);
  let rules = [];
  let logic = 'AND';
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (p && Array.isArray(p.rules)) { rules = p.rules; logic = p.logic === 'OR' ? 'OR' : 'AND'; }
    } catch { /* malformed — treat as no advanced filter */ }
  }
  const setAdvanced = useCallback((nextRules, nextLogic = 'AND') => {
    setSp((prev) => {
      const p = new URLSearchParams(prev);
      const active = Array.isArray(nextRules) && nextRules.some((r) => r.field && (
        (Array.isArray(r.value) ? r.value.length : r.value) || ['is_empty', 'is_not_empty'].includes(r.operator)
      ));
      if (active) p.set(urlKey, JSON.stringify({ rules: nextRules, logic: nextLogic }));
      else p.delete(urlKey);
      return p;
    }, { replace: true });
  }, [setSp, urlKey]);
  return { rules, logic, setAdvanced };
}

export default useUrlState;
