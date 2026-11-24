// Global, sticky Company filter shared across every page/tab/subpage.
//
// One company id is kept in localStorage and broadcast to all mounted
// components via a custom event, so picking a company on ANY page scopes the
// whole app until it's changed. '' = All companies.
//
//   const { company, setCompany, companies } = useGlobalCompany();
//   // then pass `company` into your API calls as ?company=<id>
import { useState, useEffect, useCallback } from 'react';
import apiClient from '../utils/api.js';

const KEY = 'erp.globalCompany';
const EVT = 'erp:globalCompany';

export const getGlobalCompany = () => {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
};

export const setGlobalCompany = (id) => {
  try { localStorage.setItem(KEY, id || ''); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(EVT, { detail: id || '' }));
};

// Cached company list so every consumer doesn't refetch.
let _companiesCache = null;
let _companiesPromise = null;
// Apply the SS-Biochem default only once per app session.
let _defaultApplied = false;
const loadCompanies = () => {
  if (_companiesCache) return Promise.resolve(_companiesCache);
  if (!_companiesPromise) {
    _companiesPromise = apiClient.get('/api/companies/')
      .then((r) => { _companiesCache = r.data?.results || r.data || []; return _companiesCache; })
      .catch(() => { _companiesCache = []; return []; });
  }
  return _companiesPromise;
};

export function useGlobalCompany() {
  const [company, setCompanyState] = useState(getGlobalCompany());
  const [companies, setCompanies] = useState(_companiesCache || []);

  useEffect(() => {
    loadCompanies().then((list) => {
      setCompanies(list);
      // Default to SS Biochem on first load (no company chosen yet), so every
      // page opens scoped to SS until the user picks another or toggles it off.
      if (!getGlobalCompany() && !_defaultApplied) {
        _defaultApplied = true;
        const ss = (list || []).find((c) => /biochem/i.test(c.trade_name || c.legal_name || ''));
        if (ss) setGlobalCompany(String(ss.id));
      }
    });
    const onChange = (e) => setCompanyState(e.detail ?? getGlobalCompany());
    const onStorage = (e) => { if (e.key === KEY) setCompanyState(e.newValue || ''); };
    window.addEventListener(EVT, onChange);
    window.addEventListener('storage', onStorage);  // cross-tab sync
    return () => { window.removeEventListener(EVT, onChange); window.removeEventListener('storage', onStorage); };
  }, []);

  const setCompany = useCallback((id) => { setGlobalCompany(id); setCompanyState(id || ''); }, []);

  return { company, setCompany, companies };
}
