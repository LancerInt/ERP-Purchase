/**
 * Freight review popup — bring separately-billed freight into the Inward Freight
 * page. Two sources share one UI:
 *   source="tally" — freight Journals in live Tally ("Freight Inward Charges")
 *                    not yet an Inward Freight record. Needs the Tally connector.
 *   source="zoho"  — rows from the Zoho Inward Freight report not yet a record.
 *                    Plain HTTP; ONLY freight details are pulled (no bills).
 * Either way: map the transporter (map/create/skip), confirm the linked bill,
 * select, and create.
 */
import { useState, useEffect } from 'react';
import { Loader2, X, Scale, RefreshCw, Download, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import { MapControl, fmtINRfull } from './shared.jsx';

// The group's real Tally companies — always offered in the reconcile picker so you
// don't have to click "Load open companies" first. Loading merges in whatever is
// actually open (deduped). The chosen company must be open in Tally to reconcile.
const TALLY_KNOWN = [
  'SS BIOCHEM (INDIA) P LTD., - 26-27',
  'SS BIOCHEM INDIA PVT LTD',
  'UNITED AGRO INDUSTRIES',
];

const CFG = {
  tally: {
    title: 'Reconcile Freight with Tally',
    blurb: 'Separately-billed freight in Tally (Journals using "Freight Inward Charges") not yet an Inward Freight record. Map the transporter, confirm the linked bill, then create.',
    icon: Scale, cta: 'Reconcile Freight with Tally', check: 'Check with Tally',
    previewAction: 'freight_reconcile', createAction: 'create_freight',
    needsTally: true,
  },
  zoho: {
    title: 'Import Freight from Zoho',
    blurb: 'Freight rows from the Zoho Inward Freight report not yet an Inward Freight record. Only freight details are pulled (not bills). Map the transporter, confirm the linked bill, then create.',
    icon: Download, cta: 'Import Freight from Zoho', check: 'Fetch from Zoho',
    previewAction: 'freight_preview_zoho', createAction: 'create_freight_zoho',
    needsTally: false,
  },
};

export function FreightReconcileButton({ label, onDone, source = 'tally' }) {
  const cfg = CFG[source] || CFG.tally;
  const Icon = cfg.icon;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState(null);
  const [company, setCompany] = useState('');
  const [companies, setCompanies] = useState(null);
  const [loadingCos, setLoadingCos] = useState(false);
  const [sel, setSel] = useState({});        // guid -> true (selected to create)
  const [tmap, setTmap] = useState({});      // transporter name -> {action,id,name}
  const [blink, setBlink] = useState({});    // guid -> linked bill/invoice no
  const [amtPick, setAmtPick] = useState({}); // guid -> 'zoho' | 'tally' (which amount to use)
  const [datePick, setDatePick] = useState({}); // advice_id -> 'zoho' | 'tally' (which date)
  const [doneDates, setDoneDates] = useState(() => new Set());  // advice_ids resolved this session (hidden after Apply)
  const [tab, setTab] = useState('all');     // 'all' | 'diff' | 'datediff'
  const [photo, setPhoto] = useState(null);  // { adviceId, url, isPdf, loading, error }
  const openPhoto = async (adviceId, kind) => {
    setPhoto({ adviceId, url: null, isPdf: false, loading: true, error: null });
    try {
      const res = await apiClient.get(`/api/purchase/freight/${adviceId}/zoho-photo/?kind=${kind || 'pdf'}`, { responseType: 'blob' });
      const isPdf = (res.data.type || '').includes('pdf');
      const url = URL.createObjectURL(res.data);
      setPhoto((p) => (p && p.adviceId === adviceId ? { ...p, url, isPdf, loading: false } : p));
    } catch (e) {
      // The response is a blob (even for errors) — read the backend's real reason.
      let msg = 'Could not load the freight bill from Zoho.';
      try {
        const blob = e?.response?.data;
        if (blob?.text) { const j = JSON.parse(await blob.text()); if (j?.detail) msg = j.detail; }
      } catch { /* keep the generic message */ }
      setPhoto((p) => (p && p.adviceId === adviceId ? { ...p, loading: false, error: msg } : p));
    }
  };
  const closePhoto = () => setPhoto((p) => { if (p?.url) URL.revokeObjectURL(p.url); return null; });
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Zoho variant: the company list is the app's own companies (from imported Zoho
  // data), not the Tally-open names. Fetched once when the popup opens.
  useEffect(() => {
    if (!open || cfg.needsTally || companies) return;
    apiClient.get('/api/purchase/zoho/companies/')
      .then((r) => setCompanies(r.data?.companies || []))
      .catch(() => {});
  }, [open, cfg.needsTally, companies]);
  // Remember in-progress picks (selected rows, transporter maps, bill links, amount
  // choice) per source + company in localStorage, so closing/reopening the popup —
  // or a page refresh — keeps them until they're imported. Cleared after a Create.
  const picksKey = `freight-reconcile-picks:${source}:${(company || '').trim().toLowerCase() || 'default'}`;
  useEffect(() => {
    if (!open || !data) return;
    try { localStorage.setItem(picksKey, JSON.stringify({ sel, tmap, blink, amtPick, datePick })); } catch { /* quota / private mode */ }
  }, [sel, tmap, blink, amtPick, datePick, open, data, picksKey]);
  const postRelay = async (body, { tries = 40, delay = 3000 } = {}) => {
    for (let i = 0; i < tries; i++) {
      const r = await apiClient.post('/api/purchase/zoho/import/', body, { timeout: 600000 });
      if (!r.data?.pending) return r;         // Zoho never pends; Tally may (connector)
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
      else if (names.length === 1) setCompany(names[0]);
    } catch (e) { toast.error(e?.response?.data?.detail || e.message || 'Could not load companies.'); }
    finally { setLoadingCos(false); }
  };
  const run = async () => {
    setBusy(true); setData(null); setDoneDates(new Set());   // fresh check re-evaluates everything
    try {
      const body = cfg.needsTally
        ? { action: cfg.previewAction, tally_company: company || undefined, from: from || undefined, to: to || undefined }
        : { action: cfg.previewAction, company: company || undefined, from: from || undefined, to: to || undefined };
      const r = await postRelay(body);
      const _f = r.data?.freight || []; const _dd = r.data?.date_mismatches || [];
      setData(r.data); setQ('');
      setTab(_f.length === 0 && _dd.length > 0 ? 'datediff' : 'all');
      // Restore any in-progress picks saved for this source + company.
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(picksKey) || '{}'); } catch { saved = {}; }
      const _kd = {}; _dd.forEach((m) => { _kd[m.advice_id] = saved.datePick?.[m.advice_id] || 'zoho'; }); setDatePick(_kd);
      setSel(saved.sel || {}); setTmap(saved.tmap || {}); setAmtPick(saved.amtPick || {});
      const b = {}; (r.data?.freight || []).forEach((f) => { b[f.guid] = f.ref || ''; });
      setBlink({ ...b, ...(saved.blink || {}) });
    } catch (e) {
      setData({ tally_available: false, freight: [], detail: e?.response?.data?.detail || e.message });
    } finally { setBusy(false); }
  };
  const freight = data?.freight || [];
  const diffs = freight.filter((f) => f.amount_mismatch);   // Tally ≠ Zoho amount
  // Hide rows resolved via Apply this session. A "Keep Zoho" pick writes the date
  // the freight already has, so a Tally re-check would still report it — dismissing
  // locally is what drops the count to 0 after Apply. Cleared on a new check.
  const dateDiffs = (data?.date_mismatches || []).filter((m) => !doneDates.has(m.advice_id));  // freight date ≠ Tally date
  // Every row has a choice (defaults to Zoho); Apply writes whichever date was
  // picked for each freight — Zoho OR Tally.
  const applyDates = async () => {
    const overrides = {};
    dateDiffs.forEach((m) => { overrides[m.advice_id] = datePick[m.advice_id] === 'tally' ? m.tally_date : m.zoho_date; });
    if (!Object.keys(overrides).length) { toast('Nothing to apply.', { icon: 'ℹ️' }); return; }
    setBusy(true);
    const t = toast.loading('Updating freight dates…');
    try {
      const r = await apiClient.post('/api/purchase/zoho/import/', { action: 'apply_freight_dates', overrides }, { timeout: 600000 });
      toast.success(r.data?.detail || 'Updated.', { id: t });
      onDone?.();
      // Mark applied rows resolved so the list drops to 0 (incl. "Keep Zoho" picks).
      const ids = Object.keys(overrides);
      setDoneDates((prev) => new Set([...prev, ...ids]));
      // Applied → drop those picks from the cache so they don't linger.
      setDatePick((prev) => { const n = { ...prev }; ids.forEach((id) => delete n[id]); return n; });
      setBusy(false);
    } catch (e) { toast.error(e?.response?.data?.detail || 'Update failed.', { id: t }); setBusy(false); }
  };
  const base = tab === 'diff' ? diffs : freight;
  const qn = q.trim().toLowerCase();
  const shown = qn ? base.filter((f) => `${f.transporter} ${f.ref} ${f.narration}`.toLowerCase().includes(qn)) : base;
  const nSel = freight.filter((f) => sel[f.guid]).length;
  // Which amount to create with: Zoho only if the operator explicitly picked it.
  const amtFor = (f) => (amtPick[f.guid] === 'zoho' && f.zoho_amount != null
    ? { amount: f.zoho_amount, payable: f.zoho_payable ?? f.zoho_amount }
    : { amount: f.amount, payable: f.payable });
  const createFreight = async () => {
    const items = freight.filter((f) => sel[f.guid]).map((f) => ({ ...f, ...amtFor(f), bill_ref: blink[f.guid] || f.ref }));
    if (!items.length) { toast('Select a freight first.', { icon: 'ℹ️' }); return; }
    const decisions = Object.entries(tmap).filter(([, d]) => d?.action)
      .map(([name, d]) => ({ name, kind: 'transporter', action: d.action, target_id: d.id, company_id: data?.company_id }));
    setBusy(true);
    const t = toast.loading(`Creating ${items.length} freight record(s)…`);
    try {
      if (decisions.length) await apiClient.post('/api/purchase/zoho/import/', { action: 'resolve', decisions }, { timeout: 600000 });
      const body = cfg.needsTally
        ? { action: cfg.createAction, items, tally_company: company || undefined }
        : { action: cfg.createAction, items, company: company || undefined };
      const r = await postRelay(body);
      toast.success(r.data?.detail || 'Created.', { id: t });
      onDone?.();
      // Imported — drop the cached picks so the next open starts clean.
      try { localStorage.removeItem(picksKey); } catch { /* ignore */ }
      setSel({}); setTmap({}); setAmtPick({});
      await run();
    } catch (e) { toast.error(e?.response?.data?.detail || 'Create failed.', { id: t }); setBusy(false); }
  };
  const notReachableMsg = cfg.needsTally
    ? 'Tally not reachable — open Tally (gateway on port 9000) and try again.'
    : 'Could not fetch from Zoho — check the Zoho credentials and try again.';
  return (
    <>
      <button onClick={() => { setOpen(true); setData(null); }}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
        <Icon size={15} /> {label || cfg.cta}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl p-5 max-h-[90dvh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-lg font-bold text-slate-800">{cfg.title}</h3>
              <button onClick={() => setOpen(false)} className="p-1 text-slate-400 hover:text-slate-700"><X size={18} /></button>
            </div>
            <p className="text-xs text-slate-500 mb-3">{cfg.blurb}</p>
            <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-slate-600">{cfg.needsTally ? 'Tally company' : 'Company (optional)'}</label>
                {cfg.needsTally && (
                  <button onClick={loadCompanies} disabled={loadingCos} type="button"
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50">
                    {loadingCos ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Load open companies
                  </button>
                )}
              </div>
              <input list={`frt-companies-${source}`} value={company} onChange={(e) => setCompany(e.target.value)}
                autoComplete="off" name={`frt-company-${source}`} spellCheck={false}
                placeholder={cfg.needsTally ? 'Pick the exact name — blank = the currently-open company' : 'Exact company name — blank = all companies'}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
              <datalist id={`frt-companies-${source}`}>
                {(cfg.needsTally
                  ? Array.from(new Set([...(companies || []), ...TALLY_KNOWN]))
                  : (companies || [])
                 ).map((c) => <option key={c} value={c} />)}
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
                <span className="text-[11px] text-slate-400">{cfg.needsTally ? 'That company must be open in Tally. Result is cached.' : 'Pulls the Zoho Inward Freight report. Result is cached.'}</span>
                <button onClick={run} disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />} {cfg.check}
                </button>
              </div>
            </div>
            {busy && <div className="py-10 text-center text-slate-500"><Loader2 className="animate-spin inline mr-2" size={18} /> {cfg.needsTally ? 'Checking Tally freight… (first time can take a minute)' : 'Fetching freight from Zoho…'}</div>}
            {!busy && data && !data.tally_available && (
              <div className="py-8 text-center text-amber-600 text-sm">{notReachableMsg}
                {data.detail && <div className="mt-2 text-[11px] text-slate-500 break-words">{data.detail}</div>}</div>
            )}
            {!busy && data && data.tally_available && freight.length === 0 && dateDiffs.length === 0 && (
              <div className="py-4 sm:py-5 text-center text-slate-500 text-sm">No separate freight to create — all done.</div>
            )}
            {!busy && (freight.length > 0 || dateDiffs.length > 0) && (
              <>
                {cfg.needsTally && (diffs.length > 0 || dateDiffs.length > 0) && (
                  <div className="flex items-center gap-1 mb-2 border-b border-slate-200">
                    <button type="button" onClick={() => setTab('all')}
                      className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px ${tab === 'all' ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                      To create ({freight.length})
                    </button>
                    {diffs.length > 0 && (
                      <button type="button" onClick={() => setTab('diff')}
                        className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px flex items-center gap-1 ${tab === 'diff' ? 'border-amber-500 text-amber-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                        Amount differences <span className="text-[10px] font-bold rounded-full px-1.5 py-0.5 bg-amber-100 text-amber-700">{diffs.length}</span>
                      </button>
                    )}
                    {dateDiffs.length > 0 && (
                      <button type="button" onClick={() => setTab('datediff')}
                        className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px flex items-center gap-1 ${tab === 'datediff' ? 'border-amber-500 text-amber-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                        Date differences <span className="text-[10px] font-bold rounded-full px-1.5 py-0.5 bg-amber-100 text-amber-700">{dateDiffs.length}</span>
                      </button>
                    )}
                  </div>
                )}
                {tab === 'datediff' ? (
                  <>
                    <p className="text-sm font-semibold text-amber-800 mb-2"><AlertTriangle size={13} className="inline align-[-2px] mr-1 shrink-0" />{dateDiffs.length} freight with a date different from Tally — pick which date to keep:</p>
                    <div className="space-y-2">
                      {dateDiffs.map((m) => {
                        const k = datePick[m.advice_id] || 'zoho';
                        return (
                          <div key={m.advice_id} className="rounded-lg border border-slate-200 p-2">
                            <div className="text-[11px] text-slate-500 mb-1 flex items-center gap-1.5 flex-wrap">
                              {m.advice_no} · {m.transporter || '—'}{m.sra ? ` · ${m.sra}` : ''}
                              {(m.photos || []).map((ph) => (
                                <button key={ph.kind} type="button" onClick={() => openPhoto(m.advice_id, ph.kind)}
                                  className="text-[10px] font-semibold rounded px-1.5 py-0.5 border border-indigo-300 text-indigo-700 hover:bg-indigo-50"> {ph.label}</button>
                              ))}
                            </div>
                            <div className="grid grid-cols-2 gap-3 text-[11px]">
                              <div className={`rounded p-1.5 ${k === 'zoho' ? 'ring-2 ring-indigo-400 bg-indigo-50/40' : ''}`}>
                                <div className="font-semibold text-indigo-700 mb-0.5">Zoho</div>
                                {m.zoho_invoice && <div className="text-slate-500">Invoice: <span className="text-slate-800">{m.zoho_invoice}</span></div>}
                                <div className="text-slate-500">Date: <span className="font-semibold text-slate-800">{m.zoho_date}</span></div>
                              </div>
                              <div className={`rounded p-1.5 ${k === 'tally' ? 'ring-2 ring-emerald-400 bg-emerald-50/40' : ''}`}>
                                <div className="font-semibold text-emerald-700 mb-0.5">Tally</div>
                                {m.tally_invoice && <div className="text-slate-500">Invoice/Ref: <span className="text-slate-800">{m.tally_invoice}</span></div>}
                                <div className="text-slate-500">Date: <span className="font-semibold text-slate-800">{m.tally_date}</span></div>
                              </div>
                            </div>
                            <div className="flex gap-1.5 mt-1.5">
                              {[['zoho', 'Keep Zoho date'], ['tally', 'Use Tally date']].map(([v, l]) => (
                                <button key={v} type="button" onClick={() => setDatePick((p) => ({ ...p, [m.advice_id]: v }))}
                                  className={`text-[11px] rounded px-2 py-1 border ${k === v ? (v === 'tally' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-indigo-600 text-white border-indigo-600') : 'bg-white text-slate-600 border-slate-200'}`}>{l}</button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex items-center justify-between mt-3">
                      <span className="text-[11px] text-slate-400">
                        {dateDiffs.filter((m) => datePick[m.advice_id] === 'tally').length} → Tally · {dateDiffs.filter((m) => (datePick[m.advice_id] || 'zoho') === 'zoho').length} → keep Zoho
                      </span>
                      <button onClick={applyDates} disabled={busy || dateDiffs.length === 0}
                        className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : `Apply to ${dateDiffs.length} freight`}
                      </button>
                    </div>
                  </>
                ) : (<>
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search transporter / ref / narration…"
                    className="flex-1 min-w-[160px] border border-slate-300 rounded px-2 py-1 text-xs" />
                  <button type="button" onClick={() => setSel((p) => { const n = { ...p }; shown.forEach((f) => { n[f.guid] = true; }); return n; })}
                    className="text-[11px] rounded px-2 py-1 border bg-white text-slate-600 border-slate-200 hover:bg-emerald-50">Select all shown</button>
                  <button type="button" onClick={() => setSel({})} className="text-[11px] rounded px-2 py-1 border bg-white text-slate-500 border-slate-200 hover:bg-slate-50">Clear</button>
                </div>
                <div className="text-[10px] text-slate-400 mb-1">Showing {Math.min(shown.length, 200)} of {shown.length}{qn ? ` (of ${freight.length})` : ''}</div>
                <div className="space-y-2">
                  {shown.slice(0, 200).map((f) => {
                    const on = sel[f.guid];
                    return (
                      <div key={f.guid} className={`rounded-lg border p-2 text-[11px] ${on ? 'border-emerald-300 bg-emerald-50/40' : 'border-slate-200'}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold text-emerald-700 mb-0.5 flex items-center gap-1.5 flex-wrap">{cfg.needsTally ? 'Tally freight' : 'Zoho freight'}
                              {f.company_label && <span className="text-[9px] font-semibold rounded px-1 py-0.5 bg-slate-700 text-white">{f.company_label}</span>}</div>
                            <div className="text-slate-500 flex items-center gap-1.5 flex-wrap">Transporter: <span className="text-slate-800">{f.transporter || '—'}</span>
                              {f.transporter_matched
                                ? <span className="text-[9px] font-semibold rounded px-1 py-0.5 bg-emerald-100 text-emerald-700">✓ in ERP</span>
                                : <span className="text-[9px] font-semibold rounded px-1 py-0.5 bg-amber-100 text-amber-700">new</span>}
                            </div>
                            {!f.transporter_matched && (
                              <div className="mt-1 flex items-center gap-1.5">
                                <span className="text-[10px] text-slate-400 shrink-0">Map transporter:</span>
                                <MapControl dec={tmap[f.transporter]} onSet={(obj) => setTmap((p) => ({ ...p, [f.transporter]: obj }))}
                                  kind="transporter" options={f.transporter_options || []} companyId={data?.company_id} companyName={data?.company_name} />
                              </div>
                            )}
                            <div className="text-slate-500 mt-0.5">Date: <span className="text-slate-800">{f.date || '—'}</span> · Freight: <span className="font-semibold text-slate-800">{fmtINRfull(f.amount)}</span>
                              {f.payable != null && String(f.payable) !== String(f.amount) &&
                                <> · Payable: <span className="font-semibold text-emerald-700">{fmtINRfull(f.payable)}</span></>}
                            </div>
                            {f.amount_mismatch && (
                              <div className="mt-1 rounded border border-amber-300 bg-amber-50 p-1.5">
                                <div className="text-[10px] font-semibold text-amber-700 mb-1 flex items-center gap-1"><AlertTriangle size={13} className="inline align-[-2px] mr-1 shrink-0" />Amount differs from Zoho{f.zoho_sra ? ` (${f.zoho_sra})` : ''} — pick which to keep:</div>
                                <div className="flex items-center gap-1.5">
                                  <button type="button" onClick={() => setAmtPick((p) => ({ ...p, [f.guid]: 'tally' }))}
                                    className={`text-[11px] rounded px-2 py-0.5 border ${amtPick[f.guid] !== 'zoho' ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-300'}`}>
                                    Use Tally {fmtINRfull(f.amount)}
                                  </button>
                                  <button type="button" onClick={() => setAmtPick((p) => ({ ...p, [f.guid]: 'zoho' }))}
                                    className={`text-[11px] rounded px-2 py-0.5 border ${amtPick[f.guid] === 'zoho' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-300'}`}>
                                    Keep Zoho {fmtINRfull(f.zoho_amount)}
                                  </button>
                                </div>
                              </div>
                            )}
                            <div className="mt-1 flex items-center gap-1.5">
                              <span className="text-[10px] text-slate-400 shrink-0">Link to bill (inv/SRA no):</span>
                              <input value={blink[f.guid] || ''} onChange={(e) => setBlink((p) => ({ ...p, [f.guid]: e.target.value }))}
                                className="border border-slate-300 rounded px-2 py-0.5 text-[11px] w-40" />
                            </div>
                            {f.narration && <div className="text-slate-400 mt-0.5 break-words">{f.narration}</div>}
                          </div>
                          <div className="shrink-0">
                            <button type="button" onClick={() => setSel((p) => ({ ...p, [f.guid]: p[f.guid] ? undefined : true }))}
                              className={`text-[11px] rounded px-3 py-1 border ${on ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>{on ? '✓ Selected' : 'Select'}</button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                </>)}
              </>
            )}
            <div className="flex justify-between items-center mt-3">
              <span className="text-[11px] text-slate-400">{freight.length > 0 && tab !== 'datediff' ? `${nSel} selected · transporter from ${cfg.needsTally ? 'Tally' : 'Zoho'}` : ''}</span>
              <div className="flex gap-2">
                <button onClick={() => setOpen(false)} className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-300 text-slate-600 hover:bg-slate-50">Close</button>
                {freight.length > 0 && tab !== 'datediff' && (
                  <button onClick={createFreight} disabled={busy || nSel === 0}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-slate-800 text-white hover:bg-slate-900 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : `Create ${nSel} freight record(s)`}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Freight bill (from Zoho) — opens above the reconcile popup; PDF or image. */}
      {photo && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={closePhoto}>
          <div className="relative bg-white rounded-lg shadow-2xl w-full max-w-3xl h-[88dvh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200">
              <span className="text-sm font-semibold text-slate-700">Freight Bill (from Zoho)</span>
              <div className="flex items-center gap-2">
                {photo.url && <a href={photo.url} download="freight-bill" className="text-xs text-indigo-600 hover:text-indigo-800">Download</a>}
                <button onClick={closePhoto} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Close photo"><X size={18} /></button>
              </div>
            </div>
            <div className="flex-1 p-2 flex items-center justify-center overflow-auto">
              {photo.loading && <div className="text-slate-500 text-sm">Loading freight bill…</div>}
              {photo.error && <div className="text-amber-600 text-sm">{photo.error}</div>}
              {photo.url && (photo.isPdf
                ? <iframe title="Freight Bill" src={photo.url} className="w-full h-full border-0" />
                : <img src={photo.url} alt="Freight Bill" className="max-w-full max-h-full object-contain" />)}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** "Import Freight from Zoho" — same review popup, Zoho source. */
export function ImportFreightFromZohoButton(props) {
  return <FreightReconcileButton {...props} source="zoho" />;
}
