/** Shared bits for the Zoho (imported) purchase pages. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { DownloadCloud, Loader2, X, Undo2, Scale, RefreshCw, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import { useUrlState } from '../../../hooks/useUrlState.js';
import CustomSelect from '../../../components/ui/CustomSelect';
import { Button } from '../../../components/ui';

// Rupee formatters (match the existing purchase dashboard).
export const fmtINR = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};
export const fmtINRfull = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtQty = (v) => (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
export const fmtInt = (v) => (Number(v) || 0).toLocaleString('en-IN');

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// Indian financial year start (1 April). Jan–Mar belongs to the previous FY.
export function fyStartISO() {
  const n = new Date();
  const y = n.getMonth() + 1 >= 4 ? n.getFullYear() : n.getFullYear() - 1;
  return `${y}-04-01`;
}
export const todayISO = () => iso(new Date());

/** Shared filter state: From (defaults to 1 April), To (today), Company, Factory. */
export function useZohoFilters() {
  // Filters in the URL so Back / refresh / sharing restore them.
  const [company, setCompany] = useUrlState('company', '');
  const [factory, setFactory] = useUrlState('factory', '');
  const [from, setFrom] = useUrlState('from', fyStartISO());
  const [to, setTo] = useUrlState('to', todayISO());
  const [companies, setCompanies] = useState([]);
  const [factories, setFactories] = useState([]);
  useEffect(() => {
    apiClient.get('/api/purchase/zoho/companies/', { params: company ? { company } : {} })
      .then((r) => { setCompanies(r.data?.companies || []); setFactories(r.data?.factories || []); })
      .catch(() => {});
  }, [company]);
  const params = {};
  if (company) params.company = company;
  if (factory) params.factory = factory;
  if (from) params.from = from;
  if (to) params.to = to;
  const query = new URLSearchParams(params).toString();
  return { company, setCompany, factory, setFactory, from, setFrom, to, setTo, companies, factories, params, query };
}

/** From / To / Company / Factory filter bar shown in the page header. */
export function FilterBar({ f }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-[150px]">
        <CustomSelect value={f.company} onChange={(e) => { f.setCompany(e.target.value); f.setFactory(''); }} title="Company">
          <option value="">All Companies</option>
          {f.companies.map((c) => <option key={c} value={c}>{c}</option>)}
        </CustomSelect>
      </div>
      <div className="min-w-[130px]">
        <CustomSelect value={f.factory} onChange={(e) => f.setFactory(e.target.value)} title="Factory">
          <option value="">All Factories</option>
          {f.factories.map((c) => <option key={c} value={c}>{c}</option>)}
        </CustomSelect>
      </div>
      <label className="text-xs text-gray-500 flex items-center gap-1">From
        <input type="date" value={f.from} onChange={(e) => f.setFrom(e.target.value)} className="border rounded px-2 py-1.5 text-sm" />
      </label>
      <label className="text-xs text-gray-500 flex items-center gap-1">To
        <input type="date" value={f.to} onChange={(e) => f.setTo(e.target.value)} className="border rounded px-2 py-1.5 text-sm" />
      </label>
    </div>
  );
}

const KIND_LABEL = { vendor: 'Vendors', product: 'Products', transporter: 'Transporters' };

// Short company tag for the resolve rows (SS Bio / UAI / first word).
const shortCo = (name) => {
  const n = (name || '').toLowerCase();
  if (n.includes('biochem')) return 'SS Bio';
  if (n.includes('united agro')) return 'UAI';
  return (name || '').split(' ')[0] || '—';
};
const coCls = (name) => {
  const n = (name || '').toLowerCase();
  if (n.includes('biochem')) return 'bg-indigo-100 text-indigo-700';
  if (n.includes('united agro')) return 'bg-emerald-100 text-emerald-700';
  return 'bg-slate-100 text-slate-600';
};

/** Per-name "map to existing / create new / skip" picker (like the Tally one). */
export function MapControl({ dec, onSet, kind, options, companyId, companyName }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  useEffect(() => {
    if (!open || !q.trim()) { setResults([]); return undefined; }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await apiClient.post('/api/purchase/zoho/import/', { action: 'search', kind, q: q.trim(), company_id: companyId });
        setResults(r.data?.results || []);
      } catch { setResults([]); } finally { setSearching(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [q, open, kind, companyId]);
  const action = dec?.action;   // undefined = you haven't decided yet (manual)
  const label = action === 'skip' ? 'Skip' : action === 'map' ? `↳ ${dec.name || 'Mapped'}` : action === 'create' ? 'Create new' : '— choose —';
  const cls = action === 'map' ? 'border-blue-400 text-blue-700 bg-blue-50'
    : action ? 'border-slate-300 text-slate-700' : 'border-amber-400 text-amber-700 bg-amber-50';
  const list = q.trim() ? results : (options || []);
  return (
    <div className="relative shrink-0 w-[52%]" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        className={`border rounded px-1.5 py-0.5 text-xs w-full text-left truncate ${cls}`}>
        {label} ▾
      </button>
      {open && (
        <div className="absolute z-20 right-0 mt-1 w-72 bg-white border border-slate-200 rounded-lg shadow-lg">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search existing master…"
            className="w-full border-b border-slate-200 px-2 py-1.5 text-xs outline-none" />
          <div className="max-h-56 overflow-auto py-1 text-xs">
            <button type="button" onClick={() => { onSet({ action: 'create' }); setOpen(false); }} className="block w-full text-left px-2 py-1 hover:bg-slate-50 text-indigo-600">Create new</button>
            <button type="button" onClick={() => { onSet({ action: 'skip' }); setOpen(false); }} className="block w-full text-left px-2 py-1 hover:bg-slate-50 text-slate-500">Skip</button>
            {list.length > 0 && <div className="px-2 py-0.5 text-[10px] uppercase text-slate-400">{q.trim() ? 'Master results' : 'Suggested matches'}</div>}
            {searching && <div className="px-2 py-1 text-slate-400">Searching…</div>}
            {list.map((o) => {
              const tag = o.company || companyName;   // vendor: master's company; product/transporter: row's company
              return (
                <button type="button" key={o.id} onClick={() => { onSet({ action: 'map', id: o.id, name: o.name }); setOpen(false); }}
                  className="flex items-center gap-1.5 w-full text-left px-2 py-1 hover:bg-blue-50">
                  {tag && <span className={`shrink-0 text-[8px] font-semibold uppercase rounded px-1 py-0.5 ${coCls(tag)}`}>{shortCo(tag)}</span>}
                  <span className="truncate">↳ {o.name}</span>
                </button>
              );
            })}
            {q.trim() && !searching && list.length === 0 && <div className="px-2 py-1 text-slate-400">No match — use Create new.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * "Reconcile with Tally" — compares imported Zoho bills to LIVE Tally by supplier
 * invoice no. Two tabs: amount differences (read-only), and bills that are in
 * Tally but NOT in Zoho (farmer / RM) which you tag RM1/RM2 and create as real
 * bills. Needs Tally open on the gateway (local / connector only).
 */
export function ReconcileButton({ f, label, onDone }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState(null);
  const [company, setCompany] = useState('');       // Tally company to target
  const [from, setFrom] = useState(f?.from || '');  // date window (defaults from the page filter)
  const [to, setTo] = useState(f?.to || '');
  const [companies, setCompanies] = useState(null); // exact names loaded in Tally
  const [loadingCos, setLoadingCos] = useState(false);
  const [rm, setRm] = useState({});                 // tally_only key -> 'NORMAL' | 'RM1' | 'RM2'
  const [keep, setKeep] = useState({});             // zoho_id -> 'zoho' | 'tally' (amount)
  const [keepDate, setKeepDate] = useState({});     // zoho_id -> 'zoho' | 'tally' (date)
  const [doneDates, setDoneDates] = useState(() => new Set());  // zoho_ids resolved this session (hidden after Apply)
  const [vmap, setVmap] = useState({});             // vendor name -> {action,id,name}
  const [pmap, setPmap] = useState({});             // product name -> {action,id,name}
  const [q, setQ] = useState('');                   // filter for the Tally-only list
  const [coFilter, setCoFilter] = useState('');     // company filter for the list
  const [tab, setTab] = useState('missing');        // 'diff' | 'date' | 'missing'
  const [photo, setPhoto] = useState(null);         // { billId, kind, url, loading, error }
  const openPhoto = async (billId, kind) => {
    setPhoto({ billId, kind, url: null, loading: true, error: null });
    try {
      const res = await apiClient.get(`/api/purchase/bills/${billId}/zoho-photo/?kind=${kind || 'invoice'}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      setPhoto((p) => (p && p.billId === billId ? { ...p, url, loading: false } : p));
    } catch (e) {
      // The response is a blob (even for errors) — read the backend's real reason.
      let msg = 'Could not load the photo from Zoho.';
      try {
        const blob = e?.response?.data;
        if (blob?.text) { const j = JSON.parse(await blob.text()); if (j?.detail) msg = j.detail; }
      } catch { /* keep the generic message */ }
      setPhoto((p) => (p && p.billId === billId ? { ...p, loading: false, error: msg } : p));
    }
  };
  const closePhoto = () => setPhoto((p) => { if (p?.url) URL.revokeObjectURL(p.url); return null; });
  // Remember in-progress picks per company in localStorage, so closing/reopening
  // the popup — or a page refresh — keeps every choice across all three tabs:
  //   rm            → In Tally, not in Zoho (Normal / RM1 / RM2 selection)
  //   vmap / pmap   → vendor & product map choices for those bills
  //   keep          → Amount differences (Zoho vs Tally amount pick)
  //   keepDate      → Date differences (Zoho vs Tally date pick)
  // Picks are pruned once applied (Create / Apply) so applied rows don't linger.
  const picksKey = `reconcile-picks:${(company || '').trim().toLowerCase() || 'default'}`;
  useEffect(() => {
    if (!open || !data) return;
    try { localStorage.setItem(picksKey, JSON.stringify({ rm, vmap, pmap, keep, keepDate })); } catch { /* quota / private mode */ }
  }, [rm, vmap, pmap, keep, keepDate, open, data, picksKey]);
  // In production Tally is reached via the on-prem connector: the backend queues
  // the read and replies {pending:true} until someone runs "Sync Tally Now" on the
  // office PC. Poll the same request until it comes back (or time out). Locally it
  // returns first try.
  const postRelay = async (body, { tries = 40, delay = 3000 } = {}) => {
    for (let i = 0; i < tries; i++) {
      const r = await apiClient.post('/api/purchase/zoho/import/', body, { timeout: 600000 });
      if (!r.data?.pending) return r;
      await new Promise((res) => setTimeout(res, delay));
    }
    throw new Error('The Tally connector did not answer in time — run "Sync Tally Now" on the office PC (with Tally open), then try again.');
  };
  const loadCompanies = async () => {
    setLoadingCos(true);
    try {
      const r = await postRelay({ action: 'tally_companies' });
      const names = r.data?.companies || [];
      setCompanies(names);
      if (!r.data?.tally_available) toast.error('Tally not reachable — open Tally with the gateway on (port 9000).');
      else if (!names.length) toast('No open companies returned by Tally.', { icon: 'ℹ️' });
      else { toast.success(`Loaded ${names.length} open compan${names.length === 1 ? 'y' : 'ies'}.`); if (names.length === 1) setCompany(names[0]); }
    } catch (e) { toast.error(e?.response?.data?.detail || e.message || 'Could not load companies from Tally.'); }
    finally { setLoadingCos(false); }
  };
  const run = async () => {
    setBusy(true); setData(null); setDoneDates(new Set());   // fresh check re-evaluates everything
    try {
      const r = await postRelay({
        action: 'mismatch', what: 'bills',
        from: from || undefined, to: to || undefined,
        tally_company: company || undefined,
      });
      setData(r.data); setQ(''); setCoFilter('');
      // Restore any saved picks for this company (so you can resume).
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(picksKey) || '{}'); } catch { saved = {}; }
      setRm(saved.rm || {}); setVmap(saved.vmap || {}); setPmap(saved.pmap || {});
      const _ms = r.data?.mismatches || []; const _to = r.data?.tally_only || [];
      const _dm = r.data?.date_mismatches || [];
      // AMOUNT defaults to Tally: the books are reconciled against Tally, so a
      // figure that disagrees with it is the one that has to move. DATE defaults
      // to Zoho: Zoho is keyed from the supplier's bill (there's a Bill Photo on
      // every row), so it holds the date printed on the document, while Tally's
      // is when the voucher was posted. Saved picks for this company still win,
      // so a close-reopen or refresh doesn't lose your choices.
      const _k = {}; _ms.forEach((m) => { _k[m.zoho_id] = saved.keep?.[m.zoho_id] || 'tally'; }); setKeep(_k);
      const _kd = {}; _dm.forEach((m) => { _kd[m.zoho_id] = saved.keepDate?.[m.zoho_id] || 'zoho'; }); setKeepDate(_kd);
      setTab(_to.length > 0 || (_ms.length === 0 && _dm.length === 0) ? 'missing' : (_ms.length ? 'diff' : 'date'));
    } catch (e) {
      setData({ tally_available: false, mismatches: [], tally_only: [], detail: e?.response?.data?.detail || e.message });
    } finally { setBusy(false); }
  };
  const ms = data?.mismatches || [];
  // Hide rows already resolved via Apply this session. A "Keep Zoho" pick writes
  // the date the bill already has, so a fresh Tally re-check would still report it
  // as a difference (Zoho date ≠ Tally date) — dismissing it locally is what makes
  // the count drop to 0 after Apply, as expected. Cleared on a new Check with Tally.
  const dms = (data?.date_mismatches || []).filter((m) => !doneDates.has(m.zoho_id));
  const tonly = data?.tally_only || [];
  // Search + company filter for the Tally-only list.
  const qn = q.trim().toLowerCase();
  const coOptions = [...new Set(tonly.map((t) => t.company_label).filter(Boolean))];
  const shown = tonly.filter((t) =>
    (!coFilter || t.company_label === coFilter)
    && (!qn || `${t.vendor_name} ${t.invoice_no}`.toLowerCase().includes(qn)));
  const setAllShown = (v) => setRm((p) => { const n = { ...p }; shown.forEach((t) => { n[t.key] = v; }); return n; });
  // Rows still needing a vendor decision float to the top. With 156 cards and
  // only ten new vendors among them, the ones that actually want a person were
  // scattered through the list and easy to miss - and only the first 200 render,
  // so a late one could not be reached at all.
  //
  // A STABLE partition: everything keeps its relative order, so the moment a row
  // is mapped it drops back exactly where it came from and the top of the list
  // always shows what is left to do.
  const orderedShown = useMemo(() => {
    const needs = [], done = [];
    for (const t of shown) {
      (!t.vendor_matched && !vmap[t.vendor_name]?.action ? needs : done).push(t);
    }
    return needs.length ? [...needs, ...done] : shown;
  }, [shown, vmap]);
  const pendingCount = orderedShown.filter(
    (t) => !t.vendor_matched && !vmap[t.vendor_name]?.action).length;
  // Distinct unmatched vendors across EVERY matching row, not just the 200
  // rendered. vmap is keyed by name, so one decision covers every bill from
  // that vendor.
  //
  // Leaving one unset does NOT lose the bill: create_from_tally calls
  // get_or_create_vendor, which auto-creates the master (reusing any existing
  // one with the same GSTIN from the Tally ledger first). The risk is the other
  // way round — a vendor already in the master under a different spelling, with
  // no GSTIN in Tally to catch it, quietly becomes a second master.
  const newVendors = useMemo(() => {
    const m = new Map();
    for (const t of shown) {
      if (t.vendor_matched || !t.vendor_name) continue;
      const e = m.get(t.vendor_name) || { name: t.vendor_name, options: [], bills: 0 };
      e.bills += 1;
      if (!e.options.length && (t.vendor_options || []).length) e.options = t.vendor_options;
      m.set(t.vendor_name, e);
    }
    return [...m.values()];
  }, [shown]);
  const vNoMatch = newVendors.filter((v) => !v.options.length);
  const vMaybe = newVendors.filter((v) => v.options.length);
  const vUnset = newVendors.filter((v) => !vmap[v.name]?.action);
  const nCreate = tonly.filter((t) => rm[t.key]).length;
  const nTally = ms.filter((m) => keep[m.zoho_id] === 'tally').length;
  // Every date-diff row has a choice (defaults to Zoho); Apply writes whichever
  // date the operator picked for each bill — Zoho OR Tally.
  const applyDates = async () => {
    const overrides = {};
    dms.forEach((m) => { overrides[m.zoho_id] = keepDate[m.zoho_id] === 'tally' ? m.tally_date : m.zoho_date; });
    if (!Object.keys(overrides).length) { toast('Nothing to apply.', { icon: 'ℹ️' }); return; }
    setBusy(true);
    const t = toast.loading('Updating bill dates…');
    try {
      const r = await apiClient.post('/api/purchase/zoho/import/', { action: 'apply_date_overrides', overrides });
      toast.success(r.data?.detail || 'Updated.', { id: t });
      onDone?.();
      // Mark every applied row resolved so the list drops to 0 — including the
      // "Keep Zoho" picks, which a Tally re-check would otherwise re-report.
      const ids = Object.keys(overrides);
      setDoneDates((prev) => new Set([...prev, ...ids]));
      // Applied → drop those picks from the cache so they don't linger.
      setKeepDate((prev) => { const n = { ...prev }; ids.forEach((id) => delete n[id]); return n; });
      setBusy(false);
    } catch (e) { toast.error(e?.response?.data?.detail || 'Update failed.', { id: t }); setBusy(false); }
  };
  const applyChosen = async () => {
    const overrides = {};
    ms.forEach((m) => { if (keep[m.zoho_id] === 'tally') overrides[m.zoho_id] = m.tally.amount; });
    if (!Object.keys(overrides).length) { toast('No bill set to Tally — nothing to change.', { icon: 'ℹ️' }); return; }
    setBusy(true);
    const t = toast.loading('Updating bill amounts…');
    try {
      const r = await apiClient.post('/api/purchase/zoho/import/', { action: 'apply_overrides', overrides });
      toast.success(r.data?.detail || 'Updated.', { id: t });
      onDone?.();
      await run();   // refresh — the applied bills now agree and drop off
    } catch (e) { toast.error(e?.response?.data?.detail || 'Update failed.', { id: t }); setBusy(false); }
  };
  const createFromTally = async () => {
    const items = tonly.filter((t) => rm[t.key]).map((t) => ({ ...t, rm_tag: '' }));
    if (!items.length) { toast('Select a bill first.', { icon: 'ℹ️' }); return; }
    // Persist your map/skip decisions so creation reuses the right master. Product
    // "create new" is intentionally left out — those auto-create in create_from_tally
    // with the smart unit (NOS packing / MTS other) + GST/HSN from Tally.
    const decisions = [
      ...Object.entries(vmap).filter(([, d]) => d?.action)
        .map(([name, d]) => ({ name, kind: 'vendor', action: d.action, target_id: d.id, company_id: data?.company_id })),
      ...Object.entries(pmap).filter(([, d]) => d?.action && d.action !== 'create')
        .map(([name, d]) => ({ name, kind: 'product', action: d.action, target_id: d.id, company_id: data?.company_id })),
    ];
    setBusy(true);
    const t = toast.loading(`Creating ${items.length} bill(s) from Tally…`);
    try {
      if (decisions.length) {
        await apiClient.post('/api/purchase/zoho/import/', { action: 'resolve', decisions }, { timeout: 600000 });
      }
      // postRelay polls if the details fetch is queued via the connector (prod).
      const r = await postRelay({ action: 'create_from_tally', items, tally_company: company || undefined });
      toast.success(r.data?.detail || 'Created.', { id: t });
      try { localStorage.removeItem(picksKey); } catch { /* ignore */ }   // batch done
      onDone?.();
      await run();   // refresh the list
    } catch (e) { toast.error(e?.response?.data?.detail || 'Create failed.', { id: t }); setBusy(false); }
  };
  return (
    <>
      <Button variant="outline" icon={Scale} responsiveLabel onClick={() => { setOpen(true); setData(null); }}>
        {label || 'Reconcile with Tally'}
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl p-5 max-h-[90dvh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-bold text-slate-800">Reconcile with Tally</h3>
              <button onClick={() => setOpen(false)} className="p-1 text-slate-400 hover:text-slate-700"><X size={18} /></button>
            </div>
            <p className="text-xs text-slate-500 mb-3">Compares your bills to live Tally by supplier invoice no. Bills that are <b>in Tally but not in Zoho</b> (e.g. farmer / RM purchases) can be <b>selected</b> and created as real bills — products come from the Tally voucher.</p>
            <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-slate-600">Tally company</label>
                <button onClick={loadCompanies} disabled={loadingCos} type="button"
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50">
                  {loadingCos ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Load open companies from Tally
                </button>
              </div>
              <input list="zoho-tally-companies" value={company} onChange={(e) => setCompany(e.target.value)}
                placeholder="Pick the exact name — blank = the currently-open company"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
              <datalist id="zoho-tally-companies">
                {/* Exact TallyPrime company names (match core.Company.tally_company_name).
                    The SLM Br. company is the MAIN SS Biochem; the "P LTD." one is a
                    separate small company. "Load open companies from Tally" overrides
                    this list with the live names when the connector is reachable. */}
                {(companies && companies.length ? companies : [
                  'SS BIOCHEM (INDIA) PVT LTD., SLM Br. 26-27',
                  'UNITED AGRO INDUSTRIES - 26-27',
                  'SS BIOCHEM (INDIA) P LTD., - 26-27',
                ]).map((c) => <option key={c} value={c} />)}
              </datalist>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">From date</label>
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm" />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-0.5">To date</label>
                  <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm" />
                </div>
              </div>
              <div className="flex items-center justify-between mt-2">
                <span className="text-[11px] text-slate-400">That company must be <b>open</b> in Tally. Use <b>Load from Tally</b> for the exact name. Result is cached.</span>
                <button onClick={run} disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Scale size={14} />} Check with Tally
                </button>
              </div>
            </div>
            {busy && <div className="py-10 text-center text-slate-500"><Loader2 className="animate-spin inline mr-2" size={18} /> Checking against Tally… (first time for a company can take a minute)</div>}
            {!busy && data && !data.tally_available && (
              <div className="py-8 text-center text-amber-600 text-sm">
                Tally not reachable — open Tally with the gateway on (port 9000), the right company loaded, and try again.
                {data.detail && <div className="mt-2 text-[11px] text-slate-500 break-words">Details: {data.detail}</div>}
              </div>
            )}
            {!busy && data && data.tally_available && (ms.length > 0 || dms.length > 0 || tonly.length > 0) && (
              <div className="flex gap-0.5 mb-3 bg-slate-100 rounded-lg p-0.5">
                <button type="button" onClick={() => setTab('missing')}
                  className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${tab === 'missing' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                  In Tally, not in Zoho ({tonly.length})
                </button>
                <button type="button" onClick={() => setTab('diff')}
                  className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${tab === 'diff' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                  Amount differences ({ms.length})
                </button>
                <button type="button" onClick={() => setTab('date')}
                  className={`flex-1 rounded-md py-1.5 text-xs font-medium transition ${tab === 'date' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                  Date differences ({dms.length})
                </button>
              </div>
            )}
            {!busy && data && data.tally_available && tab === 'missing' && tonly.length === 0 && (
              <div className="py-4 sm:py-5 text-center text-slate-500 text-sm">No Tally-only bills — everything in Tally is already in Zoho.</div>
            )}
            {!busy && tab === 'missing' && tonly.length > 0 && (
              <>
                {/* Search + bulk-tag bar. "Set all" tags every row matching the search. */}
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search vendor / invoice…"
                    className="flex-1 min-w-[140px] border border-slate-300 rounded px-2 py-1 text-xs" />
                  {coOptions.length > 0 && (
                    <select value={coFilter} onChange={(e) => setCoFilter(e.target.value)}
                      className="border border-slate-300 rounded px-2 py-1 text-xs">
                      <option value="">All Companies</option>
                      {coOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  )}
                  <button type="button" onClick={() => setAllShown(true)}
                    className="text-[11px] rounded px-2 py-1 border bg-white text-slate-600 border-slate-200 hover:bg-emerald-50">Select all shown</button>
                  <button type="button" onClick={() => setRm({})}
                    className="text-[11px] rounded px-2 py-1 border bg-white text-slate-500 border-slate-200 hover:bg-slate-50">Clear</button>
                </div>
                {/* Vendor bulk bar. These are mostly farmer / RM suppliers that
                    never went through Zoho, so nearly all are genuinely new and
                    creating them is the right answer. Mapping matters only where
                    the vendor ALREADY exists under another spelling — leave that
                    one unset and you get a duplicate master.
                    Create deliberately passes over any name the matcher found a
                    candidate for; those stay amber so the ones needing a person
                    are exactly the ones still unset. */}
                {newVendors.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 mb-2 rounded-lg border border-amber-200 bg-amber-50/60 px-2 py-1.5">
                    <span className="text-[10px] uppercase text-amber-700 font-semibold">
                      {newVendors.length} new vendor{newVendors.length === 1 ? '' : 's'}
                    </span>
                    {vNoMatch.length > 0 && (
                      <button type="button"
                        onClick={() => setVmap((p) => ({
                          ...p,
                          ...Object.fromEntries(vNoMatch.map((v) => [v.name, { action: 'create' }])),
                        }))}
                        className="text-[11px] rounded px-2 py-0.5 border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100">
                        Create {vNoMatch.length} with no match
                      </button>
                    )}
                    <button type="button"
                      onClick={() => setVmap((p) => {
                        const n = { ...p };
                        newVendors.forEach((v) => delete n[v.name]);
                        return n;
                      })}
                      className="text-[11px] rounded px-2 py-0.5 border border-slate-200 bg-white text-slate-400 hover:bg-slate-50">
                      Clear vendor maps
                    </button>
                    {vMaybe.length > 0 && (
                      <span className="text-[11px] text-amber-700">
                        · {vMaybe.length} have a possible match — open those and check
                      </span>
                    )}
                    <span className={`text-[11px] ml-auto ${vUnset.length ? 'text-slate-500' : 'text-emerald-700'}`}>
                      {vUnset.length
                        ? `${vUnset.length} left unset — those get created automatically`
                        : 'every new vendor has a choice ✓'}
                    </span>
                  </div>
                )}
                <div className="text-[10px] text-slate-400 mb-1">
                  Showing {Math.min(shown.length, 200)} of {shown.length}{qn ? ` (filtered from ${tonly.length})` : ''}
                  {shown.length > 200 ? ' — refine the search to see the rest; “Set all shown” still applies to all matches.' : ''}
                  {pendingCount > 0 && (
                    <span className="text-amber-600 font-medium">
                      {' '}· {pendingCount} needing a vendor choice moved to the top; each drops back once you set it.
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  {orderedShown.slice(0, 200).map((t) => {
                    const tag = rm[t.key];
                    return (
                      <div key={t.key} className={`rounded-lg border p-2 text-[11px] ${tag ? 'border-emerald-300 bg-emerald-50/40' : 'border-slate-200'}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold text-emerald-700 mb-0.5 flex items-center gap-1.5 flex-wrap">Tally
                              {t.company_label && <span className="text-[9px] font-semibold rounded px-1 py-0.5 bg-slate-700 text-white">{t.company_label}</span>}
                              {tag && <span className="text-[10px] font-semibold rounded px-1 py-0.5 bg-emerald-600 text-white">✓ Selected</span>}</div>
                            <div className="text-slate-500">Invoice No: <span className="text-slate-800">{t.invoice_no}</span></div>
                            <div className="text-slate-500 flex items-center gap-1.5 flex-wrap">Vendor: <span className="text-slate-800">{t.vendor_name || '—'}</span>
                              {t.vendor_matched
                                ? <span className="text-[9px] font-semibold rounded px-1 py-0.5 bg-emerald-100 text-emerald-700">✓ in ERP</span>
                                : <span className="text-[9px] font-semibold rounded px-1 py-0.5 bg-amber-100 text-amber-700">new vendor</span>}
                            </div>
                            {/* Map an unmatched vendor to an existing ERP master (or create / skip). */}
                            {!t.vendor_matched && (
                              <div className="mt-1 flex items-center gap-1.5">
                                <span className="text-[10px] text-slate-400 shrink-0">Map vendor:</span>
                                <MapControl dec={vmap[t.vendor_name]} onSet={(obj) => setVmap((p) => ({ ...p, [t.vendor_name]: obj }))}
                                  kind="vendor" options={t.vendor_options || []} companyId={data?.company_id} companyName={data?.company_name} />
                              </div>
                            )}
                            <div className="text-slate-500 mt-0.5">Date: <span className="text-slate-800">{t.date || '—'}</span></div>
                            <div className="text-slate-500">Amount: <span className="font-semibold text-slate-800">{fmtINRfull(t.amount)}</span></div>
                            {/* Per-line products: show if already in ERP, else map / create / skip. */}
                            {t.lines?.length > 0 && (
                              <div className="mt-1 space-y-1">
                                {t.lines.map((l, li) => (
                                  <div key={li} className="text-[11px]">
                                    <span className="text-slate-400">Product:</span> <span className="text-slate-700">{l.name}</span>
                                    {l.kind === 'item' && (l.product_matched
                                      ? <span className="ml-1 text-[9px] font-semibold rounded px-1 py-0.5 bg-emerald-100 text-emerald-700">✓ in ERP</span>
                                      : <span className="ml-1 text-[9px] font-semibold rounded px-1 py-0.5 bg-amber-100 text-amber-700">new</span>)}
                                    {l.kind === 'item' && !l.product_matched && (
                                      <div className="mt-0.5 flex items-center gap-1.5">
                                        <span className="text-[10px] text-slate-400 shrink-0">Map product:</span>
                                        <MapControl dec={pmap[l.name]} onSet={(obj) => setPmap((p) => ({ ...p, [l.name]: obj }))}
                                          kind="product" options={l.product_options || []} companyId={data?.company_id} companyName={data?.company_name} />
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="shrink-0">
                            <button type="button"
                              onClick={() => setRm((p) => ({ ...p, [t.key]: p[t.key] ? undefined : true }))}
                              className={`text-[11px] rounded px-3 py-1 border ${tag ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>{tag ? '✓ Selected' : 'Select'}</button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {!busy && tab === 'diff' && ms.length === 0 && data?.tally_available && (
              <div className="py-4 sm:py-5 text-center text-emerald-700 text-sm">✓ {(data.matched || 0) > 0 ? `All ${data.matched} matched bill(s) agree with Tally.` : 'No amount differences.'}</div>
            )}
            {!busy && tab === 'diff' && ms.length > 0 && (
              <>
                <p className="text-sm font-semibold text-amber-800 mb-2"><AlertTriangle size={13} className="inline align-[-2px] mr-1 shrink-0" />{ms.length} amount difference(s) — pick which amount the bill keeps (products always stay from Zoho):</p>
                {/* Defaults to Tally, because the books are reconciled against
                    Tally — a figure that disagrees with it is the one that moves.
                    The switch is here for the exception, not the rule. */}
                <div className="flex flex-wrap items-center gap-2 mb-2 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5">
                  <span className="text-[10px] uppercase text-slate-400 font-semibold">Set all {ms.length}:</span>
                  <button type="button"
                    onClick={() => setKeep(Object.fromEntries(ms.map((m) => [m.zoho_id, 'tally'])))}
                    className="text-[11px] rounded px-2 py-0.5 border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100">
                    Use Tally amount
                  </button>
                  <button type="button"
                    onClick={() => setKeep(Object.fromEntries(ms.map((m) => [m.zoho_id, 'zoho'])))}
                    className="text-[11px] rounded px-2 py-0.5 border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100">
                    Keep Zoho amount
                  </button>
                  <span className="text-[11px] text-slate-500 ml-auto">
                    {ms.filter((m) => (keep[m.zoho_id] || 'tally') === 'tally').length} → Tally ·{' '}
                    {ms.filter((m) => keep[m.zoho_id] === 'zoho').length} → Zoho
                  </span>
                </div>
                <div className="space-y-2">
                  {ms.map((m) => {
                    const k = keep[m.zoho_id] || 'tally';   // matches the default set on load
                    return (
                      <div key={m.zoho_id} className="rounded-lg border border-slate-200 p-2">
                        {m.bill_id && (m.photos || []).length > 0 && (
                          <div className="mb-1 flex items-center gap-1.5 flex-wrap">
                            {(m.photos || []).map((ph) => (
                              <button key={ph.kind} type="button" onClick={() => openPhoto(m.bill_id, ph.kind)}
                                className="text-[10px] font-semibold rounded px-1.5 py-0.5 border border-indigo-300 text-indigo-700 hover:bg-indigo-50"> {ph.label}</button>
                            ))}
                          </div>
                        )}
                        <div className="grid grid-cols-2 gap-3 text-[11px]">
                          <div className={`rounded p-1.5 ${k === 'zoho' ? 'ring-2 ring-indigo-400 bg-indigo-50/40' : ''}`}>
                            <div className="font-semibold text-indigo-700 mb-0.5">Zoho</div>
                            <div className="text-slate-500">Bill No: <span className="text-slate-800">{m.zoho.bill_no}</span></div>
                            <div className="text-slate-500">Invoice No: <span className="text-slate-800">{m.zoho.invoice_no || '—'}</span></div>
                            <div className="text-slate-500">Amount: <span className="font-semibold text-slate-800">{fmtINRfull(m.zoho.amount)}</span></div>
                          </div>
                          <div className={`rounded p-1.5 ${k === 'tally' ? 'ring-2 ring-emerald-400 bg-emerald-50/40' : ''}`}>
                            <div className="font-semibold text-emerald-700 mb-0.5">Tally</div>
                            <div className="text-slate-500">Invoice No: <span className="text-slate-800">{m.tally.invoice_no}</span></div>
                            <div className="text-slate-500">Date: <span className="text-slate-800">{m.tally.date || '—'}</span></div>
                            <div className="text-slate-500">Amount: <span className="font-semibold text-slate-800">{fmtINRfull(m.tally.amount)}</span></div>
                          </div>
                        </div>
                        <div className="flex gap-1.5 mt-1.5">
                          {[['zoho', 'Keep Zoho amount'], ['tally', 'Use Tally amount']].map(([v, l]) => (
                            <button key={v} type="button" onClick={() => setKeep((p) => ({ ...p, [m.zoho_id]: v }))}
                              className={`text-[11px] rounded px-2 py-1 border ${k === v ? (v === 'tally' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-indigo-600 text-white border-indigo-600') : 'bg-white text-slate-600 border-slate-200'}`}>{l}</button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {!busy && tab === 'date' && dms.length === 0 && data?.tally_available && (
              <div className="py-4 sm:py-5 text-center text-emerald-700 text-sm">✓ {(data.matched || 0) > 0 ? `All ${data.matched} matched bill(s) have the same date as Tally.` : 'No date differences.'}</div>
            )}
            {!busy && tab === 'date' && dms.length > 0 && (
              <>
                <p className="text-sm font-semibold text-amber-800 mb-2"><AlertTriangle size={13} className="inline align-[-2px] mr-1 shrink-0" />{dms.length} date difference(s) — pick which date the bill keeps:</p>
                {/* Defaults to Zoho: it is keyed from the supplier's bill (open
                    the Bill Photo on any row), so it carries the date printed on
                    the document. Tally's is when the voucher was posted. */}
                <div className="flex flex-wrap items-center gap-2 mb-2 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5">
                  <span className="text-[10px] uppercase text-slate-400 font-semibold">Set all {dms.length}:</span>
                  <button type="button"
                    onClick={() => setKeepDate(Object.fromEntries(dms.map((m) => [m.zoho_id, 'zoho'])))}
                    className="text-[11px] rounded px-2 py-0.5 border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100">
                    Keep Zoho date (on the bill)
                  </button>
                  <button type="button"
                    onClick={() => setKeepDate(Object.fromEntries(dms.map((m) => [m.zoho_id, 'tally'])))}
                    className="text-[11px] rounded px-2 py-0.5 border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100">
                    Use Tally date
                  </button>
                  <span className="text-[11px] text-slate-500 ml-auto">
                    {dms.filter((m) => keepDate[m.zoho_id] === 'tally').length} → Tally ·{' '}
                    {dms.filter((m) => (keepDate[m.zoho_id] || 'zoho') === 'zoho').length} → Zoho
                  </span>
                </div>
                <div className="space-y-2">
                  {dms.map((m) => {
                    const k = keepDate[m.zoho_id] || 'zoho';
                    return (
                      <div key={m.zoho_id} className="rounded-lg border border-slate-200 p-2">
                        <div className="text-[11px] text-slate-500 mb-1 flex items-center gap-1.5 flex-wrap">
                          Bill: <span className="text-slate-800">{m.bill_no}</span> · Invoice: <span className="text-slate-800">{m.invoice_no || '—'}</span> · <span className="text-slate-800">{m.vendor_name || '—'}</span>
                          {m.bill_id && (m.photos || []).map((ph) => (
                            <button key={ph.kind} type="button" onClick={() => openPhoto(m.bill_id, ph.kind)}
                              className="text-[10px] font-semibold rounded px-1.5 py-0.5 border border-indigo-300 text-indigo-700 hover:bg-indigo-50"> {ph.label}</button>
                          ))}
                        </div>
                        <div className="grid grid-cols-2 gap-3 text-[11px]">
                          <div className={`rounded p-1.5 ${k === 'zoho' ? 'ring-2 ring-indigo-400 bg-indigo-50/40' : ''}`}>
                            <div className="font-semibold text-indigo-700 mb-0.5">Zoho date</div>
                            <div className="font-semibold text-slate-800">{m.zoho_date}</div>
                          </div>
                          <div className={`rounded p-1.5 ${k === 'tally' ? 'ring-2 ring-emerald-400 bg-emerald-50/40' : ''}`}>
                            <div className="font-semibold text-emerald-700 mb-0.5">Tally date</div>
                            <div className="font-semibold text-slate-800">{m.tally_date}</div>
                          </div>
                        </div>
                        <div className="flex gap-1.5 mt-1.5">
                          {[['zoho', 'Keep Zoho date'], ['tally', 'Use Tally date']].map(([v, l]) => (
                            <button key={v} type="button" onClick={() => setKeepDate((p) => ({ ...p, [m.zoho_id]: v }))}
                              className={`text-[11px] rounded px-2 py-1 border ${k === v ? (v === 'tally' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-indigo-600 text-white border-indigo-600') : 'bg-white text-slate-600 border-slate-200'}`}>{l}</button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            <div className="flex justify-between items-center mt-3">
              <span className="text-[11px] text-slate-400">
                {tab === 'missing' && tonly.length > 0 ? `${nCreate} selected to create · products from Tally voucher` : ''}
                {tab === 'diff' && ms.length > 0 ? `${nTally} set to Tally · products always kept from Zoho` : ''}
                {tab === 'date' && dms.length > 0 ? `${dms.filter((m) => keepDate[m.zoho_id] === 'tally').length} → Tally · ${dms.filter((m) => (keepDate[m.zoho_id] || 'zoho') === 'zoho').length} → keep Zoho` : ''}
              </span>
              <div className="flex gap-2">
                <button onClick={() => setOpen(false)} className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-300 text-slate-600 hover:bg-slate-50">Close</button>
                {tab === 'missing' && tonly.length > 0 && (
                  <button onClick={createFromTally} disabled={busy || nCreate === 0}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-slate-800 text-white hover:bg-slate-900 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : `Create ${nCreate} bill(s) from Tally`}
                  </button>
                )}
                {tab === 'diff' && ms.length > 0 && (
                  <button onClick={applyChosen} disabled={busy || nTally === 0}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : `Apply Tally amount to ${nTally} bill(s)`}
                  </button>
                )}
                {tab === 'date' && dms.length > 0 && (
                  <button onClick={applyDates} disabled={busy || dms.length === 0}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : `Apply to ${dms.length} bill(s)`}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Zoho bill photo — opens above the reconcile popup, click backdrop or to close. */}
      {photo && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={closePhoto}>
          <div className="relative bg-white rounded-lg shadow-2xl w-full max-w-2xl max-h-[92dvh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 sticky top-0 bg-white">
              <span className="text-sm font-semibold text-slate-700">Bill photo (from Zoho)</span>
              <div className="flex items-center gap-2">
                {photo.url && <a href={photo.url} download="bill-photo.jpg" className="text-xs text-indigo-600 hover:text-indigo-800">Download</a>}
                <button onClick={closePhoto} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Close photo"><X size={18} /></button>
              </div>
            </div>
            <div className="p-3 min-h-[220px] flex items-center justify-center">
              {photo.loading && <div className="text-slate-500 text-sm">Loading photo…</div>}
              {photo.error && <div className="text-amber-600 text-sm">{photo.error}</div>}
              {photo.url && <img src={photo.url} alt="Bill photo" className="max-w-full max-h-[78dvh] object-contain" />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** "Revert Zoho" — delete the imported Zoho bills + freight (re-importable). */
export function RevertButton({ label, onDone }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!window.confirm('Remove ALL imported Zoho bills & freight? You can re-import anytime.')) return;
    setBusy(true);
    const t = toast.loading('Reverting Zoho…');
    try {
      const r = await apiClient.post('/api/purchase/zoho/import/', { action: 'revert' });
      toast.success(r.data?.detail || 'Reverted.', { id: t });
      onDone?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Revert failed.', { id: t });
    } finally { setBusy(false); }
  };
  return (
    <Button variant="outline" icon={Undo2} responsiveLabel loading={busy} onClick={run}
      className="!text-rose-600 !border-rose-200 hover:!bg-rose-50">
      {label || 'Revert Zoho'}
    </Button>
  );
}

/**
 * "Import from Zoho" — Preview → resolve unmatched vendors/products (map / create
 * real ERP master / skip, remembered) → Import. Mirrors the Tally import flow.
 */
export function ImportButton({ what, label, f, onDone }) {
  const kinds = what === 'freight' ? ['transporter', 'vendor'] : ['vendor', 'product'];
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [decisions, setDecisions] = useState({});
  const [tab, setTab] = useState(kinds[0]);
  const [coFilter, setCoFilter] = useState('');   // filter resolve rows by company
  const [merge, setMerge] = useState(null);       // merge_preview result (bills)
  const [keepChoice, setKeepChoice] = useState({}); // zoho_id -> 'zoho' | 'existing'
  // Editable date range (defaults from the prop; operator can change it in the popup).
  const [from, setFrom] = useState(f?.from || '');
  const [to, setTo] = useState(f?.to || '');
  // Company scope — chosen right here in the popup (defaults from the page filter
  // if one was passed; blank = all companies). Preview AND Import both send this,
  // so picking a company restricts BOTH to that company only (backend _in_scope /
  // _scope_bills filter on the Zoho 'Company' name).
  const [company, setCompany] = useState(f?.company || '');
  const [companies, setCompanies] = useState([]);
  // Load the distinct Zoho company names once the popup opens.
  useEffect(() => {
    if (!open) return;
    apiClient.get('/api/purchase/zoho/companies/')
      .then((r) => setCompanies(r.data?.companies || []))
      .catch(() => {});
  }, [open]);

  const params = () => ({ what, from: from || undefined, to: to || undefined, company: company || undefined });
  const rowKey = (u) => `${u.kind}:${u.name}:${u.company_id}`;

  const fetchPreview = async () => {
    const r = await apiClient.post('/api/purchase/zoho/import/', { action: 'preview', ...params() }, { timeout: 600000 });
    setPreview(r.data); setDecisions({}); setTab(kinds[0]);
    return r.data;
  };
  const runPreview = async () => {
    setBusy(true);
    try { await fetchPreview(); }
    catch (e) { toast.error(e?.response?.data?.detail || 'Preview failed'); }
    finally { setBusy(false); }
  };
  // Apply the names YOU decided (map/create/skip), then re-preview.
  // Returns the new unmatched count. Nothing is auto-created.
  const applyDecisions = async () => {
    const decs = (preview?.unmatched || [])
      .filter((u) => decisions[rowKey(u)]?.action)
      .map((u) => {
        const dec = decisions[rowKey(u)];
        const base = { name: u.name, kind: u.kind, company_id: u.company_id };
        if (dec.action === 'skip') return { ...base, action: 'skip' };
        if (dec.action === 'map') return { ...base, action: 'map', target_id: dec.id };
        return { ...base, action: 'create' };
      });
    if (!decs.length) return preview?.unmatched_count || 0;
    await apiClient.post('/api/purchase/zoho/import/', { action: 'resolve', decisions: decs }, { timeout: 600000 });
    const p = await fetchPreview();
    return p.unmatched_count || 0;
  };
  const applyResolve = async () => {
    const anyDecided = (preview?.unmatched || []).some((u) => decisions[rowKey(u)]?.action);
    if (!anyDecided) { toast.error('Choose an action for at least one name first.'); return; }
    setBusy(true);
    try { await applyDecisions(); toast.success('Resolved'); }
    catch (e) { toast.error(e?.response?.data?.detail || 'Resolve failed'); }
    finally { setBusy(false); }
  };
  const finalImport = async (amountChoices) => {
    setBusy(true);
    const t = toast.loading('Importing from Zoho…');
    try {
      const r = await apiClient.post('/api/purchase/zoho/import/', { ...params(), amount_choices: amountChoices || {} }, { timeout: 600000 });
      toast.success(r.data?.detail || 'Imported.', { id: t });
      onDone?.(); close();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Import failed.', { id: t }); setBusy(false); }
  };
  // Bills: after vendors/products are mapped, show the MERGE review — how many
  // bills will be enriched (filled into an existing bill) vs created new, which
  // invoices are flagged (same invoice on 2+ bills), and any amount differences vs
  // the existing bill (pick which to keep). Then Import commits. Freight skips this.
  const doImport = async () => {
    // If names are still unmatched but YOU decided them all, apply first.
    if (preview && (preview.unmatched_count || 0) > 0) {
      if (!allDecided) { toast.error('Choose map / create / skip for every remaining name.'); return; }
      setBusy(true);
      const ta = toast.loading('Applying your choices…');
      let left = 0;
      try { left = await applyDecisions(); toast.dismiss(ta); }
      catch (e) { toast.error(e?.response?.data?.detail || 'Apply failed.', { id: ta }); setBusy(false); return; }
      setBusy(false);
      if (left > 0) { toast.error(`${left} still couldn't be resolved — check them.`); return; }
    }
    // Import straight away — no merge-review step. Matched bills are enriched,
    // unmatched are created; amounts keep the existing bill's value.
    return finalImport({});
  };
  const close = () => { setOpen(false); setPreview(null); setDecisions({}); setMerge(null); setKeepChoice({}); };

  const coNames = [...new Set((preview?.unmatched || []).map((u) => u.company_name).filter(Boolean))];
  const rows = (preview?.unmatched || []).filter((u) => u.kind === tab && (!coFilter || u.company_name === coFilter));
  // Import enables when the preview is fully resolved (0 unmatched) OR when YOU
  // have chosen an action (map/create/skip) for every remaining name — clicking
  // Import then applies those choices first, then imports.
  const allDecided = preview && (preview.unmatched || []).length > 0
    && (preview.unmatched || []).every((u) => decisions[rowKey(u)]?.action);
  const canImport = preview && ((preview.unmatched_count || 0) === 0 || allDecided);

  return (
    <>
      <Button variant="primary" icon={DownloadCloud} responsiveLabel onClick={() => { setOpen(true); setPreview(null); }}
        className="!bg-indigo-600 hover:!bg-indigo-700">
        {label || 'Import from Zoho'}
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={close}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl p-5 max-h-[90dvh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-bold text-slate-800">Import {what === 'freight' ? 'Freight' : 'Bills'} from Zoho</h3>
              <button onClick={close} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Close"><X size={18} /></button>
            </div>
            <div className="mb-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <span className="font-medium text-slate-500">Range</span>
                <input type="date" value={from}
                  onChange={(e) => { setFrom(e.target.value); setPreview(null); }}
                  className="border rounded px-2 py-1 text-sm" />
                <span className="text-slate-400">→</span>
                <input type="date" value={to}
                  onChange={(e) => { setTo(e.target.value); setPreview(null); }}
                  className="border rounded px-2 py-1 text-sm" />
                <span className="text-slate-400">·</span>
                <select value={company}
                  onChange={(e) => { setCompany(e.target.value); setPreview(null); }}
                  className="border rounded px-2 py-1 text-sm bg-white"
                  title="Scope Preview + Import to one company (blank = all)">
                  <option value="">All Companies</option>
                  {companies.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <p className="text-[11px] text-slate-400 mt-1.5">
                Pick the date range, then run <b>Preview</b> to resolve any vendors/products not in your master, then Import.
              </p>
            </div>

            {preview && (
              <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                <p className="font-semibold text-slate-700 mb-1.5">Preview — {preview.record_count} record(s) in range · {preview.unmatched_count} unmatched</p>
                {((preview.dropped_company_count || 0) > 0 || (preview.blank_vendor_count || 0) > 0) && (
                  <div className="mb-2 rounded-md border border-rose-200 bg-rose-50 p-2 text-[11px] text-rose-700">
                    <b><AlertTriangle size={13} className="inline align-[-2px] mr-1 shrink-0" />Some records are being skipped and can't be resolved here:</b>
                    {(preview.dropped_companies || []).map((d) => (
                      <div key={d.company}>• <b>{d.count}</b> record(s) with company “{d.company}” — this company isn’t mapped to an ERP company, so its vendors won’t appear. Add/rename the ERP company (or its alias) first.</div>
                    ))}
                    {(preview.blank_vendor_count || 0) > 0 && (
                      <div>• <b>{preview.blank_vendor_count}</b> bill(s) have a blank vendor name in Zoho — fix the vendor in Zoho, then re-preview.</div>
                    )}
                  </div>
                )}
                {preview.unmatched_count === 0 ? (
                  <p className="text-xs text-emerald-700">Everything matches your master — safe to Import.</p>
                ) : (
                  <>
                    <p className="text-xs font-medium text-amber-700 mb-1.5"><AlertTriangle size={13} className="inline align-[-2px] mr-1 shrink-0" />{preview.unmatched_count} not in master — <b>Map</b> to existing, <b>Create</b> real master, or <b>Skip</b>.</p>
                    <div className="flex gap-0.5 mb-1.5 bg-slate-100 rounded-lg p-0.5">
                      {kinds.map((k) => {
                        const n = (preview.unmatched || []).filter((u) => u.kind === k).length;
                        return (
                          <button key={k} type="button" onClick={() => setTab(k)}
                            className={`flex-1 rounded-md py-1 text-xs font-medium transition ${tab === k ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                            {KIND_LABEL[k]} ({n})
                          </button>
                        );
                      })}
                    </div>
                    {coNames.length > 1 && (
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="text-[10px] uppercase text-slate-400">Company:</span>
                        <button type="button" onClick={() => setCoFilter('')}
                          className={`text-[11px] rounded px-2 py-0.5 border ${!coFilter ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200'}`}>All</button>
                        {coNames.map((c) => (
                          <button key={c} type="button" onClick={() => setCoFilter(c)}
                            className={`text-[11px] rounded px-2 py-0.5 border ${coFilter === c ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200'}`}>{shortCo(c)}</button>
                        ))}
                      </div>
                    )}
                    {/* Bulk set. After the matcher has claimed everything that
                        already exists, what's left is mostly genuinely new —
                        76 of one preview's 117 were new products. Deciding
                        those one dropdown at a time is the real cost of this
                        dialog, and it pushes people towards clicking through
                        without reading. Acts only on the rows CURRENTLY VISIBLE,
                        so the tab and company filters scope it, and every row
                        stays individually overridable afterwards. */}
                    {rows.length > 1 && (
                      <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                        <span className="text-[10px] uppercase text-slate-400">Set all {rows.length} shown:</span>
                        {/* Create all deliberately SKIPS any row the matcher
                            found a candidate for. Creating over a suggestion is
                            how a typo becomes a second master — 'Venus
                            Scienttific' alongside 'Venus Scientific'. Those rows
                            keep their amber "— choose —" so the ones that need a
                            person are exactly the ones still unset. */}
                        <button type="button"
                          onClick={() => setDecisions((p) => ({
                            ...p,
                            ...Object.fromEntries(rows.filter((u) => !(u.options || []).length)
                              .map((u) => [rowKey(u), { action: 'create' }])),
                          }))}
                          className="text-[11px] rounded px-2 py-0.5 border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100">
                          Create {rows.filter((u) => !(u.options || []).length).length} with no match
                        </button>
                        <button type="button"
                          onClick={() => setDecisions((p) => ({ ...p, ...Object.fromEntries(rows.map((u) => [rowKey(u), { action: 'skip' }])) }))}
                          className="text-[11px] rounded px-2 py-0.5 border border-slate-200 bg-white text-slate-600 hover:bg-slate-50">
                          Skip all
                        </button>
                        <button type="button"
                          onClick={() => setDecisions((p) => {
                            const next = { ...p };
                            rows.forEach((u) => delete next[rowKey(u)]);
                            return next;
                          })}
                          className="text-[11px] rounded px-2 py-0.5 border border-slate-200 bg-white text-slate-400 hover:bg-slate-50">
                          Clear
                        </button>
                        {rows.some((u) => (u.options || []).length > 0) && (
                          <span className="text-[11px] text-amber-700">
                            · {rows.filter((u) => (u.options || []).length).length} have a possible match — open those and check
                          </span>
                        )}
                      </div>
                    )}
                    <div className="max-h-56 overflow-auto rounded border border-slate-200 bg-white divide-y divide-slate-100">
                      {rows.length === 0 && <div className="px-2 py-4 text-center text-xs text-slate-400">No unmatched {KIND_LABEL[tab].toLowerCase()}</div>}
                      {rows.map((u) => (
                        <div key={rowKey(u)} className="flex items-center gap-2 px-2 py-1 text-xs">
                          <span className={`shrink-0 text-[9px] font-semibold uppercase rounded px-1.5 py-0.5 ${coCls(u.company_name)}`} title={u.company_name}>{shortCo(u.company_name)}</span>
                          <span className="text-slate-700 truncate flex-1" title={`${u.name} · ${u.company_name}`}>{u.name}</span>
                          <MapControl dec={decisions[rowKey(u)]} onSet={(obj) => setDecisions((p) => ({ ...p, [rowKey(u)]: obj }))}
                            kind={u.kind} options={u.options} companyId={u.company_id} companyName={u.company_name} />
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center justify-between mt-1.5">
                      <span className="text-[11px] text-slate-400">Only names YOU set are applied — nothing is auto-created. Choices are remembered.</span>
                      <button onClick={applyResolve} disabled={busy} className="text-xs rounded border border-slate-300 px-2.5 py-1 hover:bg-slate-50">
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : `Apply ${Object.values(decisions).filter((x) => x?.action).length || ''} & re-preview`}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="flex justify-end items-center gap-2 mt-2">
              <button onClick={close} className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-300 text-slate-600 hover:bg-slate-50">Close</button>
              <button onClick={runPreview} disabled={busy} className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-300 text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Preview'}
              </button>
              <button onClick={doImport} disabled={busy || !canImport}
                title={!canImport ? 'Choose map / create / skip for every remaining name first.' : 'Import'}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <><DownloadCloud size={15} /> Import</>}
              </button>
            </div>
            {!preview && <p className="text-[11px] text-slate-400 mt-2 text-right">Run <b>Preview</b> first — then map / create / skip each name.</p>}
            {preview && !canImport && <p className="text-[11px] text-amber-600 mt-2 text-right"><AlertTriangle size={13} className="inline align-[-2px] mr-1 shrink-0" />{preview.unmatched_count} still need a choice — pick <b>map / create / skip</b> for each. Import enables once all are chosen.</p>}
            {canImport && (preview.unmatched_count || 0) > 0 && <p className="text-[11px] text-emerald-600 mt-2 text-right">✓ All {preview.unmatched_count} chosen — <b>Import</b> will apply them, then import.</p>}
            {canImport && (preview.unmatched_count || 0) === 0 && <p className="text-[11px] text-emerald-600 mt-2 text-right">✓ All resolved — ready to Import.</p>}
          </div>
        </div>
      )}
    </>
  );
}
