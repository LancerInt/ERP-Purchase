import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import ProductPicker from "@/components/common/ProductPicker";
import { CTRL_H, CTRL_FIELD } from '@/components/common/controls';
/**
 * Purchase Module — Work Tracking Dashboard
 *
 * Mirrors the Sales dashboard for the procurement side. One GET request —
 * `/api/purchase/dashboard/?period=...&company=...&warehouse=...&vendor=...&product=...`
 * — returns every metric on this page (no per-card requests).
 *
 * Layout: period selector + Company / Warehouse / Vendor / Product filters,
 * KPI stat cards (count + delta vs the equal-length previous window), Top
 * vendors by PO amount, and a per-company rollup.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import {
  TrendingUp, TrendingDown, Minus, Calendar,
  FileText, ShoppingCart, Package, Receipt, Wallet, AlertCircle,
  Download, Upload, ChevronLeft, ChevronRight, ChevronDown, X, Loader2, ExternalLink,
  Check, Undo2, Redo2, Search, PieChart, ArrowLeftRight, Info,
} from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import TallyImportButton from '../../../components/common/TallyImportButton';
import SourceCompareModal from '../components/SourceCompareModal.jsx';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { usePurchaseFilter } from '../components/purchaseFilter.js';
import usePagerKeys from '../../../hooks/usePagerKeys.js';
import usePermissions from '../../../hooks/usePermissions.js';
import exportToExcel from '../../../utils/exportExcel.js';
import { formatDate } from '@/utils/formatters';
import { FreightTile, FreightOverviewScreen } from './FreightOverview.jsx';
import EmbeddedBills from './EmbeddedBills.jsx';

// ── Formatters ───────────────────────────────────────────────────────
const fmtINRfull = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// 2-digit year ('08-Apr-26') — the century is never in doubt on this dashboard,
// and the saved width keeps the ledger's Balance column from clipping.
const fmtDate = (iso) => (iso ? formatDate(iso, 'dd-MMM-yy') : '—');
// Compact money for inline chips, and days-past-due for the per-bill flag.
const fmtINRc = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
};
const overdueDaysOf = (due) => {
  if (!due) return 0;
  const d = Math.floor((Date.now() - new Date(`${due}T00:00:00`).getTime()) / 86400000);
  return d > 0 ? d : 0;
};
// Amount spelled in magnitude words, matching the Sales headline cards.
const fmtWords = (v) => {
  const n = Math.abs(Number(v) || 0);
  const t = (x) => x.toFixed(2).replace(/\.00$/, '');
  if (n >= 1e7) return `${t(n / 1e7)} Crore`;
  if (n >= 1e5) return `${t(n / 1e5)} Lakh`;
  if (n >= 1e3) return `${t(n / 1e3)} Thousand`;
  return Math.round(n).toLocaleString('en-IN');
};

// Headline KPI card, matching the Sales Analytics tiles: a coloured left
// accent, the figure, the amount in words, a context line — and, as the one
// distinctive touch here, a hover popover that reveals a DIFFERENT cut of the
// same number (reconciliation / by-account / ageing) instead of repeating it.
// Mirror of the Sales KEY METRICS cards: one bluish-violet (indigo) chrome over
// a light indigo backdrop, light white tiles with a darker-indigo border that
// goes borderless on hover. Only the figure colour stays semantic.
const PHEAD_CHROME = {
  dot: 'bg-indigo-500', bar: 'before:bg-indigo-500', ring: 'focus-visible:ring-indigo-300',
  tint: 'bg-white border-indigo-400', hover: 'hover:border-transparent',
  head: 'from-indigo-500 to-indigo-700',
};
const PHEAD_TONE = {
  purchase:    { ...PHEAD_CHROME, val: 'text-slate-900' },
  bills:       { ...PHEAD_CHROME, val: 'text-slate-900' },
  paid:        { ...PHEAD_CHROME, val: 'text-emerald-700' },
  outstanding: { ...PHEAD_CHROME, val: 'text-rose-600' },
};
function PHeadCard({ label, value, words, context, tone = 'purchase', onClick, title, popTitle, popRows }) {
  const clickable = typeof onClick === 'function';
  const t = PHEAD_TONE[tone] || PHEAD_TONE.purchase;
  const Tag = clickable ? 'button' : 'div';
  const pop = (popRows || []).filter(Boolean);
  return (
    <div className="relative group min-w-0 h-full">
      <Tag type={clickable ? 'button' : undefined} onClick={clickable ? onClick : undefined} title={title || ''}
        className={`relative flex h-full w-full min-w-0 flex-col text-left rounded-lg border-2 ${t.tint} px-3 py-3 shadow-sm ${clickable
          ? `cursor-pointer transition hover:shadow-md ${t.hover} focus:outline-none focus-visible:ring-2 ${t.ring}`
          : `transition hover:shadow-md ${t.hover}`}`}>
        <div className="flex items-center gap-1.5 min-w-0">
          <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${t.dot}`} />
          <p className="text-xs sm:text-[13px] font-semibold uppercase tracking-[0.06em] text-slate-600 truncate">{label}</p>
        </div>
        <p className={`mt-1 text-lg sm:text-xl lg:text-2xl font-bold tracking-tight money leading-tight break-words ${t.val}`}>{value}</p>
        {/* Words line always rendered (reserves space) so every card keeps the
            same rhythm even when a value has no words — e.g. Amount Paid ₹0. */}
        <p className="mt-0.5 text-[11px] font-medium text-slate-500 leading-tight truncate min-h-[0.9rem]">{words || ' '}</p>
      </Tag>
      {/* Big centered popup on hover: the headline figure (existing data) in a
          coloured header, then the breakdown (the hidden data) styled below.
          pointer-events-none so it never blocks the page. */}
      {pop.length > 0 && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150">
          <div className="absolute inset-0 bg-slate-900/20 backdrop-blur-[1.5px]" />
          <div className="relative w-[360px] max-w-[92vw] rounded-2xl bg-white shadow-2xl ring-1 ring-black/5 overflow-hidden scale-95 group-hover:scale-100 transition-transform duration-150">
            <div className={`bg-gradient-to-br ${t.head} px-5 py-4`}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-white/75">{label}</p>
              <p className="mt-0.5 text-2xl font-extrabold text-white money leading-tight">{value}</p>
              {words && <p className="mt-0.5 text-[11px] font-medium text-white/70">{words}</p>}
              {context && <p className="mt-1 text-[11px] text-white/60">{context}</p>}
            </div>
            <div className="px-5 py-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400 mb-2">{popTitle || 'Breakdown'}</p>
              <div className="divide-y divide-slate-100">
                {pop.map((r, i) => (
                  <div key={i} className="flex items-center justify-between gap-4 py-2 text-[13px]">
                    <span className="text-slate-500">{r.label}</span>
                    <span className={`tabular-nums font-bold ${r.tone || 'text-slate-800'}`}>{r.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Bills Popup ──────────────────────────────────────────────────────
const BILL_TABS = [
  { key: 'all',  label: 'All' },
  { key: 'OPEN', label: 'Open' },
];
const BILL_STATUS_BADGE = {
  OPEN:          { cls: 'bg-amber-100 text-amber-800',  label: 'Open' },
  PARTIALLY_PAID:{ cls: 'bg-blue-100 text-blue-800',   label: 'Partial' },
  PAID:          { cls: 'bg-green-100 text-green-800',  label: 'Paid' },
  DRAFT:         { cls: 'bg-slate-100 text-slate-600',  label: 'Draft' },
  CANCELLED:     { cls: 'bg-red-100 text-red-700',      label: 'Cancelled' },
};
const BILL_CAT_BADGE = {
  RM:          { cls: 'bg-sky-100 text-sky-700',         label: 'RM' },
  MAIZE:       { cls: 'bg-yellow-100 text-yellow-700',   label: 'Maize' },
  BOUGHT_NOTE: { cls: 'bg-purple-100 text-purple-700',   label: 'Bought Note' },
  PACKING:     { cls: 'bg-emerald-100 text-emerald-700', label: 'PM' },
};

const BILL_CATS = [
  { key: '', label: 'All Categories' },
  { key: 'RM',          label: 'RM' },
  { key: 'MAIZE',       label: 'Maize' },
  { key: 'PACKING',     label: 'PM' },
  { key: 'BOUGHT_NOTE', label: 'Bought Note' },
];

// ── Aging bucket helpers (client-side, same logic as Expenses page) ──
const AGING_PAYMENT_DAYS = 30;
const AGING_BUCKET_META = [
  { key: 'paid_early',     label: 'Paid Early',               exceeded: false },
  { key: 'still_open',     label: 'Still Open (within terms)', exceeded: false },
  { key: 'paid_late',      label: 'Paid Late',                exceeded: true  },
  { key: 'overdue_unpaid', label: 'Overdue Unpaid',           exceeded: true  },
];
const AGING_STYLE = {
  paid_early:     { dot: 'bg-emerald-500', amt: 'text-emerald-700', border: 'border-emerald-200' },
  still_open:     { dot: 'bg-blue-500',    amt: 'text-blue-700',    border: 'border-blue-200'    },
  paid_late:      { dot: 'bg-amber-500',   amt: 'text-amber-700',   border: 'border-amber-200'   },
  overdue_unpaid: { dot: 'bg-rose-500',    amt: 'text-rose-700',    border: 'border-rose-200'    },
};
function classifyBillAging(bill) {
  const billDate = bill.bill_date ? new Date(bill.bill_date) : null;
  const dueDate  = billDate ? new Date(billDate.getTime() + AGING_PAYMENT_DAYS * 86400000) : null;
  const isPaid   = bill.status === 'PAID';
  const paidDate = bill.paid_date ? new Date(bill.paid_date) : (isPaid ? dueDate : null);
  if (!dueDate) return 'still_open';
  const days = Math.round((new Date() - dueDate) / 86400000);
  if (isPaid) return paidDate && paidDate <= dueDate ? 'paid_early' : 'paid_late';
  return days > 0 ? 'overdue_unpaid' : 'still_open';
}
const AGING_PAGE = 12;

function BillsPopup({ companyId, vendorId, from, to, period, msmeFilter, source, transfersMode, onClose }) {
  const navigate = useNavigate();
  const [tab, setTab]         = useState('all');
  const [catFilter, setCatFilter] = useState('');   // '' = all, else purchase_category
  const [bills, setBills]     = useState([]);
  const [counts, setCounts]   = useState({});
  const [loading, setLoading] = useState(true);
  const [page, setPage]       = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  // Aging tab state
  const [agingBills,    setAgingBills]    = useState([]);
  const [agingLoading,  setAgingLoading]  = useState(false);
  const [agingExpanded, setAgingExpanded] = useState(null);
  const [agingPage,     setAgingPage]     = useState(1);
  const PAGE_SIZE = 50;   // show 50 bills per page in the scrollable popup (was 10 —
                          // too few, forced Prev/Next for even a short list); the
                          // table area is already overflow-y-auto so 50 rows scroll.

  const buildQuery = useCallback((statusKey, pg = 1, cat = catFilter) => {
    const p = new URLSearchParams();
    if (companyId) p.set('company', companyId);
    if (vendorId)  p.set('vendor', vendorId);
    if (from)      p.set('bill_date_after', from);
    if (to)        p.set('bill_date_before', to);
    if (msmeFilter === 'msme')     p.set('msme', 'true');
    if (msmeFilter === 'non-msme') p.set('msme', 'false');
    p.set('is_expense', 'false');
    p.set('exclude_opening', '1');
    // Mirror the page's transfers pill so the popup matches the Bills tile:
    //   'only' → just the DC branch transfers · '1' → include them ·
    //   '' (default) → exclude them (Tally's Purchases view).
    if (transfersMode === 'only') p.set('transfers', 'only');
    else if (transfersMode !== '1') p.set('transfers', 'exclude');
    if (source && source !== 'all') p.set('source', source);
    p.set('ordering', '-bill_date');
    p.set('page_size', String(PAGE_SIZE));
    p.set('page', String(pg));
    if (statusKey && statusKey !== 'all') p.set('status', statusKey);
    if (cat) p.set('purchase_category', cat);
    p.set('include_lines', '1');
    return p.toString();
  }, [companyId, vendorId, from, to, msmeFilter, catFilter, transfersMode]);

  // Counts for status tabs
  useEffect(() => {
    Promise.all([
      apiClient.get(`/api/purchase/bills/?${buildQuery('all', 1)}&page_size=1`).then(r => ['all', r.data.count ?? 0]).catch(() => ['all', 0]),
      apiClient.get(`/api/purchase/bills/?${buildQuery('OPEN', 1)}&page_size=1`).then(r => ['OPEN', r.data.count ?? 0]).catch(() => ['OPEN', 0]),
    ]).then(pairs => setCounts(Object.fromEntries(pairs)));
  }, [buildQuery]);

  // Bills list
  useEffect(() => {
    setLoading(true);
    apiClient.get(`/api/purchase/bills/?${buildQuery(tab, page)}`)
      .then(r => {
        const results = r.data.results ?? r.data;
        setBills(results);
        setHasMore(!!r.data.next);
        setTotalCount(r.data.count ?? results.length);
      })
      .catch(() => setBills([]))
      .finally(() => setLoading(false));
  }, [tab, page, buildQuery]);

  const switchTab = (key) => { setTab(key); setPage(1); if (key !== 'aging') setAgingExpanded(null); };
  const switchCat = (key) => { setCatFilter(key); setPage(1); };

  // Fetch all bills for aging (once, on first open of aging tab)
  useEffect(() => {
    if (tab !== 'aging') return;
    if (agingBills.length > 0) return;
    setAgingLoading(true);
    const p = new URLSearchParams({ is_expense: 'false', source: 'scan', page_size: '2000', include_lines: '0', ordering: '-bill_date' });
    // Mirror the transfers pill (same as buildQuery above).
    if (transfersMode === 'only') p.set('transfers', 'only');
    else if (transfersMode !== '1') p.set('transfers', 'exclude');
    if (companyId) p.set('company', companyId);
    if (vendorId)  p.set('vendor', vendorId);
    if (from)      p.set('bill_date_after', from);
    if (to)        p.set('bill_date_before', to);
    apiClient.get(`/api/purchase/bills/?${p.toString()}`)
      .then(r => setAgingBills(r.data.results ?? r.data))
      .catch(() => setAgingBills([]))
      .finally(() => setAgingLoading(false));
  }, [tab, companyId, vendorId, from, to, agingBills.length, transfersMode]);

  // Reset aging cache when filters change
  useEffect(() => { setAgingBills([]); setAgingExpanded(null); setAgingPage(1); },
    [companyId, vendorId, from, to]);

  const agingClassified = useMemo(() => {
    const out = { paid_early: [], still_open: [], paid_late: [], overdue_unpaid: [] };
    for (const b of agingBills) out[classifyBillAging(b)]?.push(b);
    return out;
  }, [agingBills]);

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const totalAmt = bills.reduce((s, b) => s + Number(b.total_amount || 0), 0);

  const headers = ['Date','Bill No','Vendor','Product','Qty','Unit Price','Amount'];

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  // Aging detail pagination
  const agingRows = agingExpanded ? (agingClassified[agingExpanded] || []) : [];
  const agingTotalPages = Math.ceil(agingRows.length / AGING_PAGE);
  const agingPageRows   = agingRows.slice((agingPage - 1) * AGING_PAGE, agingPage * AGING_PAGE);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl w-full max-w-4xl flex flex-col shadow-2xl border border-slate-200 overflow-hidden"
        style={{ maxHeight: '88vh', animation: 'fadeScale .18s ease' }}>

        {/* Header */}
        <div className="px-5 pt-5 pb-0 border-b border-slate-100">
          {/* Title row */}
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-base font-bold text-slate-900">Purchase Bills</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                {from && to ? `${fmtDate(from)} — ${fmtDate(to)}` : period || 'All Time'}
              </p>
            </div>
            <button onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 transition">
              <X size={14} />
            </button>
          </div>

          {/* Tabs + category filter in one row */}
          <div className="flex items-center justify-between">
            <div className="flex">
              {BILL_TABS.map(t => (
                <button key={t.key} type="button" onClick={() => switchTab(t.key)}
                  className={`px-4 py-2.5 text-xs font-semibold flex items-center gap-1.5 border-b-2 -mb-px transition whitespace-nowrap
                    ${tab === t.key ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
                  {t.label}
                  {counts[t.key] != null && (
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full
                      ${tab === t.key ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-500'}`}>
                      {counts[t.key]}
                    </span>
                  )}
                </button>
              ))}
              <button type="button" onClick={() => switchTab('aging')}
                className={`px-4 py-2.5 text-xs font-semibold flex items-center gap-1.5 border-b-2 -mb-px transition whitespace-nowrap
                  ${tab === 'aging' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
                Aging
              </button>
            </div>
            {tab !== 'aging' && (
              <select value={catFilter} onChange={(e) => switchCat(e.target.value)}
                className={`mb-1 text-xs font-medium border rounded-lg px-2.5 py-1.5 bg-white focus:outline-none cursor-pointer
                  ${catFilter ? 'border-indigo-400 text-indigo-700 bg-indigo-50' : 'border-slate-200 text-slate-500'}`}>
                {BILL_CATS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            )}
          </div>
        </div>

        {/* Aging tab content */}
        {tab === 'aging' && (
          <div className="overflow-y-auto flex-1 p-5">
            {agingLoading ? (
              <div className="flex items-center justify-center py-16 text-slate-400 gap-2"><Loader2 size={16} className="animate-spin" /> Loading…</div>
            ) : agingExpanded ? (
              <>
                {/* Back + header */}
                <div className="flex items-center gap-2 mb-4">
                  <button onClick={() => { setAgingExpanded(null); setAgingPage(1); }}
                    className="text-xs font-semibold text-indigo-600 hover:underline flex items-center gap-1">
                    <ChevronLeft size={13} /> All Buckets
                  </button>
                  <span className="text-slate-300">|</span>
                  <span className={`text-xs font-semibold ${AGING_STYLE[agingExpanded]?.amt || 'text-slate-600'}`}>
                    {AGING_BUCKET_META.find(m => m.key === agingExpanded)?.label}
                    <span className="ml-1.5 text-slate-400 font-normal">({agingRows.length} bills · {fmtINRfull(agingRows.reduce((s,b)=>s+Number(b.total_amount||0),0))})</span>
                  </span>
                </div>
                <table className="w-full text-xs">
                  <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-slate-500 text-[11px] uppercase tracking-wide">
                    <tr>
                      <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Bill No</th>
                      <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Bill Date</th>
                      <th className="text-left px-3 py-2 font-semibold">Vendor</th>
                      <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Category</th>
                      <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Due Date</th>
                      <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agingPageRows.map((b, i) => {
                      const dueD = b.bill_date ? new Date(new Date(b.bill_date).getTime() + AGING_PAYMENT_DAYS * 86400000) : null;
                      const dueStr = dueD ? isoOf(dueD) : '—';
                      return (
                        <tr key={b.id || i} className="border-t border-slate-100 hover:bg-primary-50/40 transition-colors">
                          <td className="px-3 py-2 whitespace-nowrap">
                            <button onClick={() => { navigate(`/purchase/bills/${b.id}`); onClose(); }}
                              className="text-indigo-600 hover:underline font-medium">
                              {b.bill_no || b.vendor_invoice_no || '—'}
                            </button>
                          </td>
                          <td className="px-3 py-2 text-slate-500 whitespace-nowrap tabular-nums">{fmtDate(b.bill_date)}</td>
                          <td className="px-3 py-2 text-slate-700">{b.vendor_name || '—'}</td>
                          <td className="px-3 py-2 text-slate-500 text-[11px]">{b.purchase_category || '—'}</td>
                          <td className="px-3 py-2 text-slate-500 whitespace-nowrap tabular-nums">{fmtDate(dueStr)}</td>
                          <td className="px-3 py-2 text-right font-semibold text-slate-800 whitespace-nowrap tabular-nums">{fmtINRfull(b.total_amount)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {agingTotalPages > 1 && (
                  <div className="flex items-center gap-2 mt-3 text-xs">
                    <button onClick={() => setAgingPage(p => p - 1)} disabled={agingPage === 1}
                      className="px-2.5 py-1 border border-slate-200 rounded-lg bg-white text-slate-600 hover:bg-slate-100 disabled:opacity-40">← Prev</button>
                    <span className="text-slate-400">{agingPage} / {agingTotalPages}</span>
                    <button onClick={() => setAgingPage(p => p + 1)} disabled={agingPage >= agingTotalPages}
                      className="px-2.5 py-1 border border-slate-200 rounded-lg bg-white text-slate-600 hover:bg-slate-100 disabled:opacity-40">Next →</button>
                  </div>
                )}
              </>
            ) : (
              <>
                {/* Summary strip */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
                  <div className="rounded-xl border border-rose-200 bg-rose-50/60 px-4 py-2.5">
                    <p className="text-[10px] uppercase text-rose-600 font-semibold tracking-wide">Overdue Unpaid</p>
                    <p className="text-lg font-bold text-rose-700 tabular-nums">
                      {fmtINRfull((agingClassified.overdue_unpaid || []).reduce((s,b)=>s+Number(b.total_amount||0),0))}
                    </p>
                    <p className="text-[10px] text-rose-500">{(agingClassified.overdue_unpaid||[]).length} bills</p>
                  </div>
                  <div className="rounded-xl border border-blue-200 bg-blue-50/60 px-4 py-2.5">
                    <p className="text-[10px] uppercase text-blue-600 font-semibold tracking-wide">Still Open</p>
                    <p className="text-lg font-bold text-blue-700 tabular-nums">
                      {fmtINRfull((agingClassified.still_open || []).reduce((s,b)=>s+Number(b.total_amount||0),0))}
                    </p>
                    <p className="text-[10px] text-blue-500">{(agingClassified.still_open||[]).length} bills</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5">
                    <p className="text-[10px] uppercase text-slate-500 font-semibold tracking-wide">Total Bills</p>
                    <p className="text-lg font-bold text-slate-800 tabular-nums">{agingBills.length}</p>
                    <p className="text-[10px] text-slate-400">{fmtINRfull(agingBills.reduce((s,b)=>s+Number(b.total_amount||0),0))}</p>
                  </div>
                </div>
                {/* Bucket pills */}
                <div className="flex flex-wrap gap-2">
                  {AGING_BUCKET_META.map(meta => {
                    const st = AGING_STYLE[meta.key] || {};
                    const rows = agingClassified[meta.key] || [];
                    const total = rows.reduce((s,b)=>s+Number(b.total_amount||0),0);
                    const canOpen = rows.length > 0;
                    return (
                      <button key={meta.key} type="button"
                        onClick={() => { if (canOpen) { setAgingExpanded(meta.key); setAgingPage(1); } }}
                        disabled={!canOpen}
                        className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border text-sm font-medium transition
                          ${meta.exceeded ? 'border-rose-200' : 'border-emerald-200'}
                          ${canOpen ? 'bg-white text-slate-700 hover:shadow-md cursor-pointer' : 'bg-slate-50 text-slate-400 cursor-default'}`}>
                        <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
                        {meta.label}
                        <span className="text-xs text-slate-400">({rows.length})</span>
                        {canOpen && <span className={`ml-1 text-xs font-semibold ${st.amt}`}>{fmtINRfull(total)}</span>}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-4 text-[11px] text-slate-400">Based on 30-day payment terms from bill date.</p>
              </>
            )}
          </div>
        )}

        {/* Table */}
        {tab !== 'aging' && <div className="overflow-y-auto flex-1">
          {loading && page === 1 ? (
            <div className="flex items-center justify-center py-16 text-slate-400 gap-2">
              <Loader2 size={16} className="animate-spin" /> Loading…
            </div>
          ) : bills.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-slate-400 text-sm">No bills found</div>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 sticky top-0 z-10">
                  <th className="px-4 py-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider text-left border-b border-slate-200 whitespace-nowrap">Date</th>
                  <th className="px-4 py-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider text-left border-b border-slate-200 whitespace-nowrap">Bill No</th>
                  <th className="px-4 py-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider text-left border-b border-slate-200">Vendor</th>
                  <th className="px-4 py-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider text-left border-b border-slate-200">Product</th>
                  <th className="px-4 py-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider text-right border-b border-slate-200 whitespace-nowrap">Qty</th>
                  <th className="px-4 py-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider text-right border-b border-slate-200 whitespace-nowrap">Unit Price</th>
                  <th className="px-4 py-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider text-right border-b border-slate-200 whitespace-nowrap">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {/* ONE ROW PER BILL — so a page always shows exactly PAGE_SIZE (10)
                    bills, never more. A bill with several product lines no longer
                    expands into multiple rows; the Product cell summarises them
                    ("<first> +N more") and Amount shows the bill total. */}
                {bills.map((b) => {
                  const lines = (b.bill_lines || []).filter(ln => {
                    const name = (ln.product_name || ln.description || '').toLowerCase();
                    if (/loading|unloading|freight|transport|charges?|labour|service/i.test(name)) return false;
                    return true;
                  });
                  const billNo = b.bill_no || b.vendor_invoice_no || '—';
                  const billLink = (
                    <Link to={`/purchase/bills/${b.id}`} onClick={onClose}
                      className="font-mono text-indigo-600 hover:text-indigo-900 hover:underline underline-offset-2 whitespace-nowrap">
                      {billNo}
                    </Link>
                  );
                  const first = lines[0];
                  const productCell = lines.length === 0
                    ? <span className="text-slate-400 italic text-[11px]">No line items</span>
                    : (
                      <span className="text-slate-700">
                        {first.product_name || first.description || '—'}
                        {lines.length > 1 && (
                          <span className="ml-1 text-[11px] text-slate-400">+{lines.length - 1} more</span>
                        )}
                      </span>
                    );
                  // Qty / Unit Price only make sense for a single-line bill; a
                  // multi-line bill mixes units, so show "—" there and rely on the
                  // bill total in Amount.
                  const single = lines.length === 1 ? first : null;
                  return (
                    <tr key={b.id} className="hover:bg-primary-50/40 transition-colors group">
                      <td className="px-4 py-3 text-slate-400 whitespace-nowrap">{fmtDate(b.bill_date)}</td>
                      <td className="px-4 py-3">{billLink}</td>
                      <td className="px-4 py-3 font-medium text-slate-800">{b.vendor_name || '—'}</td>
                      <td className="px-4 py-3">{productCell}</td>
                      <td className="px-4 py-3 text-right text-slate-600 tabular-nums whitespace-nowrap">
                        {single && single.quantity ? `${Number(single.quantity).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${single.uom || ''}`.trim() : '—'}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-600 tabular-nums whitespace-nowrap">{single && single.rate ? fmtINRfull(single.rate) : '—'}</td>
                      <td className="px-4 py-3 text-right font-semibold text-slate-800 tabular-nums whitespace-nowrap">{fmtINRfull(b.total_amount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>}

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between bg-slate-50 rounded-b-2xl">
          <div className="flex items-center gap-4">
            {tab !== 'aging' && <span className="text-xs text-slate-500 font-medium">
              {totalCount > 0 ? `${((page-1)*PAGE_SIZE)+1}–${Math.min(page*PAGE_SIZE,totalCount)} of ${totalCount} bills` : '0 bills'}
            </span>}
            {tab !== 'aging' && totalCount > PAGE_SIZE && (
              <div className="flex items-center gap-1">
                <button onClick={() => setPage(p => p - 1)} disabled={page === 1 || loading}
                  className="px-2.5 py-1 text-[11px] font-semibold border border-slate-200 rounded-lg bg-white text-slate-600 hover:bg-slate-100 disabled:opacity-40 transition">
                  ← Prev
                </button>
                <span className="text-[11px] text-slate-400 px-1">{page} / {totalPages}</span>
                <button onClick={() => setPage(p => p + 1)} disabled={!hasMore || loading}
                  className="px-2.5 py-1 text-[11px] font-semibold border border-slate-200 rounded-lg bg-white text-slate-600 hover:bg-slate-100 disabled:opacity-40 transition">
                  Next →
                </button>
              </div>
            )}
          </div>
          <Link to={`/purchase/bills?${companyId ? `company=${companyId}` : ''}`}
            className="text-xs font-semibold text-indigo-600 border border-indigo-200 rounded-lg px-3 py-1.5 hover:bg-indigo-50 transition bg-white"
            onClick={onClose}>
            View all in Bills →
          </Link>
        </div>
      </div>
      <style>{`@keyframes fadeScale { from { opacity:0; transform:scale(.97); } to { opacity:1; transform:scale(1); } }`}</style>
    </div>
  );
}
// Drop trailing-zero decimals so quantities stay compact ("5,47,310" not
// "5,47,310.000") and fit the two-column card without overlapping, while real
// fractional quantities ("8,288.528") keep their precision.
const fmtQty = (v) => (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
const fmtInt = (v) => (Number(v) || 0).toLocaleString('en-IN');
// Where a record should return to: this page exactly as it stands, filters and
// open drill-down included. Read from window.location at click time rather than
// through a hook, so the three separate drill-down components below can all use
// it without each taking its own useLocation().
const backHere = () => `${window.location.pathname}${window.location.search}`;

const todayISO = () => new Date().toISOString().slice(0, 10);

// ── Unit normalisation ───────────────────────────────────────────────
// Tally lets buyers type the unit free-hand, so the same physical unit
// arrives spelled a dozen ways (KG / KGS / kg / Kg). Left raw, a pivot
// buckets each spelling separately and the Quantity column becomes a
// 30-item run-on. Merge the well-known variants to one canonical label;
// leave anything unrecognised untouched. MTS (metric tons) is kept
// DISTINCT from MTR (metres) on purpose — they are different quantities.
const UOM_ALIASES = {
  KG: 'KG', KGS: 'KG', KILOGRAM: 'KG', KILOGRAMS: 'KG', KILO: 'KG', KILOS: 'KG',
  G: 'G', GM: 'G', GMS: 'G', GRAM: 'G', GRAMS: 'G',
  LTR: 'LTR', LTRS: 'LTR', LT: 'LTR', LTS: 'LTR', LITRE: 'LTR', LITRES: 'LTR', LITER: 'LTR', LITERS: 'LTR',
  ML: 'ML', MLS: 'ML',
  PCS: 'PCS', PC: 'PCS', PIECE: 'PCS', PIECES: 'PCS', PCES: 'PCS',
  NOS: 'NOS', NO: 'NOS', NUMBER: 'NOS', NUMBERS: 'NOS',
  MTR: 'MTR', MTRS: 'MTR', METER: 'MTR', METERS: 'MTR', METRE: 'MTR', METRES: 'MTR', MTRE: 'MTR',
  MTS: 'MTS',
  MT: 'MT', TON: 'MT', TONS: 'MT', TONNE: 'MT', TONNES: 'MT',
  BAG: 'BAG', BAGS: 'BAG',
  BOX: 'BOX', BOXES: 'BOX', BOXS: 'BOX',
  FEET: 'FEET', FT: 'FEET', FOOT: 'FEET',
  REAM: 'REAM', REAMS: 'REAM',
  ROL: 'ROL', ROLL: 'ROL', ROLLS: 'ROL', ROLS: 'ROL',
  COIL: 'COIL', COILS: 'COIL',
  DRUM: 'DRUM', DRUMS: 'DRUM',
  SET: 'SET', SETS: 'SET',
  // Quintal (100 kg) — every spelling, incl. the Tamil "குவிண்டால்", folds to QTL
  // so the quantity column stops showing the same unit under five labels.
  QTL: 'QTL', QTLS: 'QTL', QUINTAL: 'QTL', QUINTALS: 'QTL', QUINTALL: 'QTL',
  'குவிண்டால்': 'QTL', 'குவிண்ட்டால்': 'QTL', 'குவிண்டால': 'QTL',
};
const normUom = (u) => {
  // Trailing dots/spaces ("QTL." -> "QTL") so punctuation variants merge too.
  const k = String(u ?? '').trim().toUpperCase().replace(/[.\s]+$/, '');
  if (!k) return '';
  return UOM_ALIASES[k] || k;
};
// Collapse the many spellings of RAW neem seed/fruit — English (Neem Seed / Fruit /
// Seeds / Kernel / "Neem Fruit-Seed - SLP"), Tamil (வேப்பபழம் / நீம), Hindi
// (नीम / लिंब / Limbodi / Limdi) — into ONE English name, so the item list stops
// splitting the same raw material a dozen ways. PROCESSED neem (Oil / Cake /
// Concentrate / Extract / Azadirachtin) stays separate — it's a different product.
const itemDisplay = (name) => {
  const s = String(name ?? '').trim();
  const low = s.toLowerCase();
  const isNeem = /neem|limbod|limdi|limbd/.test(low) || /வேப்ப|வேம்ப|நீம|नीम|लिंब/.test(s);
  if (!isNeem) return s || '—';
  if (/\boil\b|cake|de-?oil|deoil|concentrat|extract|azadiracht|technical|powder/.test(low)) return s;
  return 'Neem Seed / Fruit';
};
// Merge a [{uom, qty}] breakdown by canonical unit, largest first.
const mergeUoms = (list) => {
  const m = new Map();
  for (const b of (list || [])) {
    const u = normUom(b.uom);
    if (!u) continue;
    m.set(u, (m.get(u) || 0) + (Number(b.qty) || 0));
  }
  return [...m.entries()]
    .filter(([, q]) => q)
    .map(([uom, qty]) => ({ uom, qty }))
    .sort((a, b) => b.qty - a.qty);
};

// ── Period navigator helpers (ported from the Sales dashboard) ───────
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseISO = (s) => { const [y, m, d] = (s || todayISO()).split('-').map(Number); return new Date(y, m - 1, d); };
const monthRangeOf = (a) => { const d = parseISO(a); return { from: isoOf(new Date(d.getFullYear(), d.getMonth(), 1)), to: isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0)) }; };
const weekRangeOf = (a) => { const d = parseISO(a); const dow = (d.getDay() + 6) % 7; const mon = new Date(d); mon.setDate(d.getDate() - dow); const sun = new Date(mon); sun.setDate(mon.getDate() + 6); return { from: isoOf(mon), to: isoOf(sun) }; };
// Indian financial year: 1 Apr → 31 Mar. Jan–Mar belong to the FY that
// STARTED the previous calendar year, so Feb 2027 is still FY 2026-27.
const fyStartYearOf = (d) => (d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1);
// The FY navigator can't be driven by a single anchor date the way week /
// month are — "Apr 2026" alone can't say whether the user picked the whole
// FY or just its first half. So the FY anchor carries the explicit window as
// "FROM..TO"; rangeFor still caps `to` at today, which is what makes the
// current FY read as "1 Apr → today".
const FY_SEP = '..';
const fyRangeOf = (token) => { const [f, t] = String(token || '').split(FY_SEP); return { from: f, to: t }; };
const fyLabel = (y) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
const fyTokenFor = (d) => { const y = fyStartYearOf(d); return `${y}-04-01${FY_SEP}${y + 1}-03-31`; };
const fyOptions = (count = 3) => {
  const today = todayISO();
  const cy = fyStartYearOf(new Date()); const out = [];
  for (let i = 0; i < count; i++) {
    const y = cy - i; const l = fyLabel(y);
    out.push({ value: `${y}-04-01${FY_SEP}${y + 1}-03-31`, label: i === 0 ? `FY ${l} (to date)` : `FY ${l}` });
    out.push({ value: `${y}-04-01${FY_SEP}${y}-09-30`,     label: `FY ${l} · H1 Apr–Sep` });
    out.push({ value: `${y}-10-01${FY_SEP}${y + 1}-03-31`, label: `FY ${l} · H2 Oct–Mar` });
  }
  // Drop windows that haven't started yet (H2 of the current FY when we're
  // still in, say, August) — they'd only ever return an empty dashboard.
  return out.filter((o) => fyRangeOf(o.value).from <= today);
};
const rangeFor = (period, aRaw) => {
  const today = todayISO(); const cap = (t) => (t > today ? today : t);
  // The anchor is URL-backed, so period and anchor can arrive mismatched from
  // a bookmarked / back-button URL. Never hand an FY token to the day / week /
  // month parsers (they'd build an Invalid Date and the request would 400),
  // and never hand a bare date to the FY reader (it has no end half).
  const mismatched = String(aRaw).includes(FY_SEP) !== (period === 'fy');
  const a = mismatched ? (period === 'fy' ? fyTokenFor(new Date()) : today) : aRaw;
  if (period === 'today') return { from: a, to: a };
  if (period === 'week') { const r = weekRangeOf(a); return { from: r.from, to: cap(r.to) }; }
  if (period === 'month') { const r = monthRangeOf(a); return { from: r.from, to: cap(r.to) }; }
  if (period === 'fy') {
    // Cap at today ONLY once the window has started, so the current FY reads
    // "1 Apr → today". Capping unconditionally would invert a not-yet-started
    // window (H2 picked in August → 1 Oct .. 22 Aug) into a backwards range.
    const r = fyRangeOf(a);
    return { from: r.from, to: (r.from <= today && r.to > today) ? today : r.to };
  }
  return null;
};
const monthOptions = (count = 12) => {
  const now = new Date(); const out = [];
  for (let i = 0; i < count; i++) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); out.push({ value: isoOf(d), label: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) }); }
  return out;
};
const weekOptions = (count = 10) => {
  const now = new Date(); const dow = (now.getDay() + 6) % 7; const thisMon = new Date(now); thisMon.setDate(now.getDate() - dow); const out = [];
  for (let i = 0; i < count; i++) { const mon = new Date(thisMon); mon.setDate(thisMon.getDate() - i * 7); const sun = new Date(mon); sun.setDate(mon.getDate() + 6); const lbl = `${mon.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} – ${sun.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`; out.push({ value: isoOf(mon), label: i === 0 ? `${lbl} (this week)` : lbl }); }
  return out;
};
const effWindow = (period, anchor, cf, ct) => period === 'custom' ? { from: cf, to: ct } : (rangeFor(period, anchor) || { from: cf, to: ct });

// Compact page-number list with ellipsis gaps (e.g. 1 … 4 5 6 … 20).
function pageWindow(cur, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const wanted = [1, 2, total - 1, total, cur - 1, cur, cur + 1].filter((p) => p >= 1 && p <= total);
  const sorted = [...new Set(wanted)].sort((a, b) => a - b);
  const out = []; let prev = 0;
  for (const p of sorted) { if (p - prev > 1) out.push('…'); out.push(p); prev = p; }
  return out;
}

// ── Delta chip (pct vs previous window) ──────────────────────────────
function DeltaChip({ current, previous }) {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev === 0 && cur === 0) return <span className="text-xs text-slate-400">no change</span>;
  if (prev === 0) return <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><TrendingUp size={12} /> new</span>;
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const up = pct > 0.5, down = pct < -0.5;
  const Icon = up ? TrendingUp : down ? TrendingDown : Minus;
  const cls = up ? 'text-emerald-700' : down ? 'text-red-700' : 'text-slate-500';
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${cls}`}>
      <Icon size={12} />{pct > 0 ? '+' : ''}{pct.toFixed(1)}%
      <span className="text-slate-400 font-normal hidden sm:inline">vs prev</span>
    </span>
  );
}

// ── Stat card ────────────────────────────────────────────────────────
function StatCard({ icon: Icon, label, value, sub, delta, deltaPrev, tone = 'slate', breakdown, onClick }) {
  const toneCls = {
    slate: 'bg-slate-50 text-slate-700', indigo: 'bg-indigo-50 text-indigo-700',
    emerald: 'bg-emerald-50 text-emerald-700', amber: 'bg-amber-50 text-amber-700',
    rose: 'bg-rose-50 text-rose-700', sky: 'bg-sky-50 text-sky-700', violet: 'bg-violet-50 text-violet-700',
  }[tone];
  const clickable = typeof onClick === 'function';
  // A tile carrying role="button" and tabIndex=0 is ANNOUNCED as a button and
  // can be tabbed to — so it must also activate on Enter/Space, or a keyboard
  // user is left on a control that says it works and does not. Matches the
  // Sales Analytics card, which is the same component by another name.
  const handleKeyDown = (e) => {
    if (!clickable) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
  };
  return (
    <div
      className={`min-w-0 bg-white rounded-lg border border-slate-200 p-2.5 sm:p-3 hover:shadow-sm transition ${clickable ? 'cursor-pointer hover:shadow-md hover:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-300' : ''}`}
      onClick={clickable ? onClick : undefined}
      onKeyDown={clickable ? handleKeyDown : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
    >
      <div className="flex items-center justify-between gap-2 mb-1 sm:mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className={`p-1 sm:p-1.5 rounded-md shrink-0 ${toneCls}`}><Icon size={14} className="sm:w-[16px] sm:h-[16px]" /></div>
          <p title={label} className="text-[10px] text-slate-500 font-medium uppercase tracking-wide truncate">{label}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {delta !== undefined && <DeltaChip current={delta} previous={deltaPrev} />}
          {clickable && <ExternalLink size={11} className="text-slate-300" />}
        </div>
      </div>
      <div className="flex items-end justify-between gap-x-2 gap-y-1 flex-wrap">
        <p className="text-base sm:text-xl font-bold text-slate-900 tabular-nums break-words leading-tight">{value}</p>
        {breakdown && breakdown.length > 0 && (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {breakdown.map((b, i) => (
              <span key={i} className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${b.cls || 'bg-slate-100 text-slate-700'}`} title={b.title || ''}>
                <span className="font-normal opacity-75 mr-1">{b.label}</span>
                <span className="tabular-nums">{b.value}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
    </div>
  );
}

// ── Quantity Billed card — one prominent figure per UOM (KG / MTS / LTR /
// PCS / anything newly added). Units are never summed into a single total:
// mixing litres with kilos would be meaningless.
//
// Sourced from the BILL lines, i.e. the same documents behind Total Purchase
// and Bills. It used to read from goods receipts, which are ERP-native and
// only exist from the month the warehouse team started using this app — so
// every earlier month showed money with a blank quantity and looked broken.
// Bill-sourced quantity always covers exactly the period the money covers.
function QuantityBilledCard({ data, onClick }) {
  const uoms = mergeUoms(data?.uom_breakdown);
  const clickable = typeof onClick === 'function';
  return (
    <div className={`bg-white rounded-lg border border-slate-200 p-3 sm:p-4 hover:shadow-sm transition ${clickable ? 'cursor-pointer hover:border-slate-300' : ''}`}
      onClick={clickable ? onClick : undefined} role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}>
      <div className="flex items-center justify-between gap-2 mb-1.5 sm:mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="p-1.5 sm:p-2 rounded-lg shrink-0 bg-amber-50 text-amber-700">
            <Package size={16} className="sm:w-[18px] sm:h-[18px]" />
          </div>
          <p className="text-[11px] text-slate-500 font-medium uppercase tracking-wide truncate">Quantity Billed</p>
        </div>
        {clickable && <ExternalLink size={12} className="text-slate-300 shrink-0" />}
      </div>
      {uoms.length === 0 ? (
        <>
          <p className="text-xl sm:text-2xl font-bold text-slate-900 tabular-nums">—</p>
          {/* Say WHY it's blank. A bare dash reads as a failure; in practice
              it means the period's bills carry no quantified stock lines
              (service / expense vouchers), which is a fact, not an error. */}
          <p className="text-xs text-slate-500 mt-1.5">No quantified lines on this period&apos;s bills</p>
        </>
      ) : (
        <>
          {/* Compact: the top few units on one wrapping row (no tall scroll);
              the full per-unit / per-item breakdown lives in the drill. */}
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mt-1">
            {uoms.slice(0, 3).map((b, i) => (
              <span key={i} className="inline-flex items-baseline gap-1" title={`${b.qty} ${b.uom}`}>
                <span className="text-base sm:text-xl font-bold text-slate-900 tabular-nums leading-tight">{fmtQty(b.qty)}</span>
                <span className="text-xs font-bold text-amber-700 uppercase tracking-wide">{b.uom}</span>
              </span>
            ))}
            {uoms.length > 3 && <span className="text-xs font-medium text-slate-400">+{uoms.length - 3} more</span>}
          </div>
          <p className="text-xs text-slate-500 mt-1.5">
            {uoms.length} unit{uoms.length > 1 ? 's' : ''} · across {fmtInt(data?.bill_count || 0)} bill(s)
          </p>
        </>
      )}
    </div>
  );
}

// ── Total Purchase card — tabbed: Total / Bills / Debit Notes. Mirrors the
// sales Total Sales tile. Total = bills booked (incl GST) − purchase returns
// (debit notes), i.e. the Tally Purchase Register.
// Scope metadata for the Total Purchase card — the real goods purchase split from
// expenses and branch transfers so neither inflates the other. Plain-English labels
// (no Tally jargon); these are your ERP bills, grouped by type.
const PURCHASE_SCOPES = [
  { key: 'purchase', label: 'Purchase', sub: 'RM + Packing + Bought Note', tie: 'Goods purchase', color: 'emerald',
    desc: 'RM + Maize + Bought Note + Packing — the real goods purchase (ex-GST value).' },
  { key: 'expenses', label: 'Expenses', sub: 'Freight + more', tie: 'Expenses', color: 'amber',
    desc: 'Freight, machinery, testing + bills marked as an expense at entry (rent, bank, professional) — shown apart so they never inflate "Purchase".' },
  { key: 'branch', label: 'Branch', sub: 'Inter-branch', tie: 'Branch transfer', color: 'violet',
    desc: 'Purchases between your own branches, kept in a separate bucket.' },
  { key: 'unclassified', label: 'Unclassified', sub: 'Not yet tagged', tie: 'Untagged', color: 'rose',
    desc: 'Bills not yet tagged to a category — kept OUT of Purchase and Expenses so neither is inflated. Tag them (Bills → set category) and they move into the right bucket.' },
  { key: 'total', label: 'Total', sub: 'All Bills (excl transfers)', tie: 'All Bills', color: 'sky',
    desc: 'Every bill for the period EXCEPT branch transfers, gross (before purchase returns) — matches the Bills list total. Returns are shown apart in the Debit Notes tile.' },
];
const SCOPE_C = {
  emerald: { on: 'bg-emerald-600 text-white', pill: 'bg-emerald-100 text-emerald-700' },
  amber: { on: 'bg-amber-500 text-white', pill: 'bg-amber-100 text-amber-700' },
  violet: { on: 'bg-violet-600 text-white', pill: 'bg-violet-100 text-violet-700' },
  rose: { on: 'bg-rose-600 text-white', pill: 'bg-rose-100 text-rose-700' },
  sky: { on: 'bg-sky-600 text-white', pill: 'bg-sky-100 text-sky-700' },
};

function TotalPurchaseCard({ data, gstView, onClick }) {
  const sc = data?.scopes || null;
  const scopes = sc || { total: { exgst: data?.taxable, gst: data?.gst, inclgst: data?.total, tally: data?.tally_taxable } };
  const s = scopes['purchase'] || {};
  const isExcl = gstView === 'exgst';
  const main = isExcl ? (s.tally != null ? s.tally : s.exgst) : s.inclgst;
  const clickable = typeof onClick === 'function';
  const handleKeyDown = (e) => { if (clickable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); } };
  return (
    <div className={`min-w-0 bg-white p-2 transition ${clickable ? 'cursor-pointer hover:bg-sky-50/60 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-sky-300' : ''}`}
      onClick={clickable ? onClick : undefined} onKeyDown={clickable ? handleKeyDown : undefined}
      role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}>
      <div className="flex items-center gap-1.5 mb-1">
        <span className="w-2 h-2 rounded-full bg-sky-400 shrink-0" />
        <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wide">Total Purchase</p>
      </div>
      <p className="text-sm font-bold text-slate-900 tabular-nums leading-snug">{fmtINRfull(main)}</p>
      <p className="text-[10px] text-slate-400 mt-0.5">RM · Maize · Packing · Bought Note</p>
    </div>
  );
}

function BillsCard({ data, totalPurchase, gstView, onOpen }) {
  const clickable = typeof onOpen === 'function';
  const handleKeyDown = (e) => { if (clickable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen('purchase'); } };
  const s = totalPurchase?.scopes?.purchase || {};
  const isExcl = gstView === 'exgst';
  const amount = isExcl ? (s.tally != null ? s.tally : s.exgst) : (s.inclgst ?? data?.amount);
  const label = isExcl ? 'excl GST' : 'incl GST';
  return (
    <div className={`min-w-0 bg-white p-2 transition ${clickable ? 'cursor-pointer hover:bg-violet-50/60 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-violet-300' : ''}`}
      onClick={clickable ? () => onOpen('purchase') : undefined} onKeyDown={clickable ? handleKeyDown : undefined}
      role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}>
      <div className="flex items-center gap-1.5 mb-1">
        <span className="w-2 h-2 rounded-full bg-violet-400 shrink-0" />
        <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wide">Bills</p>
      </div>
      <p className="text-sm font-bold text-slate-900 tabular-nums leading-snug">{fmtInt(data?.count)}</p>
      <p className="text-[10px] text-slate-400 mt-0.5">{fmtINRfull(amount)} {label}</p>
    </div>
  );
}

// Total-Purchase drill — the spend split by SCOPE (Purchase / Expenses /
// Branch / Total), each tied to its Tally group, with the Ex-GST ⇄ Incl-GST
// switch. Opened from the Total Purchase tile instead of dumping every bill.
// Reads the same stats.total_purchase.scopes the tile does — no extra fetch.
function PurchaseScopesScreen({ data, companyId, from, to, onDebitNotes }) {
  const navigate = useNavigate();
  const [view, setView] = useState('exgst');
  const sc = data?.scopes || null;

  const billsHref = (cat) => {
    const p = new URLSearchParams();
    if (companyId) p.set('company', companyId);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (cat) p.set('purchase_category', cat);
    // Carry the active source scope (Only Tally / Only ERP) so the Bills list
    // matches what the tile counted instead of showing every bill.
    if (source && source !== 'all') p.set('source', source);
    const s = p.toString();
    return s ? `/purchase/bills?${s}` : '/purchase/bills';
  };
  const scopes = sc || { total: { exgst: data?.taxable, gst: data?.gst, inclgst: data?.total, tally: data?.tally_taxable } };
  const rows = PURCHASE_SCOPES.filter((x) => {
    if (!sc) return x.key === 'purchase';
    if (x.key === 'purchase') return true;
    if (x.key === 'expenses') return false;
    return x.key !== 'total' && Number(scopes[x.key]?.inclgst || 0) > 0;
  });
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
      <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-100">
        <div className="flex items-center gap-2 text-slate-700">
          <TrendingUp size={18} className="text-sky-600" />
          <span className="font-semibold">Total Purchase — by category</span>
        </div>
        <div className="flex items-center gap-1 shrink-0 bg-slate-100 rounded-full p-0.5">
          {[['exgst', 'Ex-GST'], ['inclgst', 'Incl-GST']].map(([v, l]) => (
            <button key={v} type="button" onClick={() => setView(v)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-semibold transition ${view === v ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'}`}>{l}</button>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-slate-500 px-5 pt-3">
        Real goods purchase — RM, Maize, Packing, Bought Note, Fruit. Expenses live in the Expenses module.
      </p>
      <div className="px-3 py-3 space-y-2">
        {rows.map((x) => {
          const s = scopes[x.key] || {};
          const tallyRef = (x.key === 'purchase' && view === 'exgst') ? s.tally : null;
          const mainv = tallyRef != null ? tallyRef : (view === 'exgst' ? s.exgst : s.inclgst);
          const other = view === 'exgst' ? s.inclgst : s.exgst;
          const otherLabel = view === 'exgst' ? 'Incl-GST' : 'Ex-GST';
          return (
            <div key={x.key} className="rounded-lg border border-slate-100 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-slate-800">{x.label}</span>
                    <span className="text-[11px] text-slate-400">{x.sub}</span>
                    <span className={`text-[10px] font-semibold rounded-full px-2 py-0.5 ${SCOPE_C[x.color].pill}`}>{x.tie}</span>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">{x.desc}</p>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-base sm:text-lg font-bold text-slate-900 tabular-nums">{fmtINRfull(mainv)}</div>
                  <div className="text-[11px] text-slate-400">GST {fmtINRfull(s.gst)} · {otherLabel} {fmtINRfull(other)}</div>
                </div>
              </div>
              {/* One tile per category — the breakup of this scope. Shown only when it's
                  a real split (2+ tiles); a single tile would just repeat the headline. */}
              {(data?.scope_breakdown?.[x.key]?.length > 1) && (
                <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {data.scope_breakdown[x.key].map((c) => (
                    <div key={c.key}
                      onClick={() => {
                        if (c.key === 'RETURNS') { onDebitNotes && onDebitNotes(); }
                        else navigate(billsHref(c.key));
                      }}
                      className="rounded-lg bg-slate-50 border border-slate-100 px-2.5 py-2 cursor-pointer hover:bg-indigo-50 hover:border-indigo-200 transition">
                      <div className="text-[11px] font-semibold text-slate-600 truncate" title={c.label}>{c.label}</div>
                      <div className="text-sm font-bold text-slate-900 tabular-nums">{fmtINRfull(view === 'exgst' ? c.exgst : c.inclgst)}</div>
                      <div className="text-[10px] text-slate-400">{c.count > 0 ? `${c.count} ${c.count === 1 ? 'bill' : 'bills'}` : (c.key === 'RETURNS' ? 'debit notes' : '')}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Amount Paid card — headline is how much of THIS period's bills is settled
// (Σ VendorBill.amount_paid); below it, the period's actual cash out split by the
// CATEGORY of purchase it paid for (RM / Maize / Bought Note / Packing / Fruit),
// read from the bill each payment is linked to (or the vendor's usual category
// for on-account money). Replaces the old split-by-bank-account, which left
// connector-imported payments — no bank leg captured — in an "Untagged" bucket.
function AmountPaidCard({ data, onClick }) {
  const accts = data?.paid_by_account || [];
  const cashOut = data?.paid_by_account_total;
  const hasCash = accts.length > 0 && cashOut != null && Number(cashOut) > 0;
  const clickable = typeof onClick === 'function' && accts.length > 0;
  const handleKeyDown = (e) => { if (clickable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); } };
  const val = hasCash ? cashOut : data?.total;
  return (
    <div className={`min-w-0 bg-white p-2 transition ${clickable ? 'cursor-pointer hover:bg-emerald-50/60 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-emerald-300' : ''}`}
      onClick={clickable ? onClick : undefined} onKeyDown={clickable ? handleKeyDown : undefined}
      role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}>
      <div className="flex items-center gap-1.5 mb-1">
        <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
        <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wide">Amount Paid</p>
      </div>
      <p className="text-sm font-bold text-slate-900 tabular-nums leading-snug">{fmtINRfull(val)}</p>
      <p className="text-[10px] text-slate-400 mt-0.5">{hasCash ? 'cash paid to vendors' : 'settled against bills'}</p>
    </div>
  );
}

// A clean back bar for every drill view — replaces the old "Viewing: [chip ×]"
// row. The screen below carries its own title, so this is just the way back.
const BackBar = ({ onBack }) => (
  <button onClick={onBack}
    className="inline-flex items-center gap-1.5 mb-4 text-sm font-medium text-slate-500 hover:text-indigo-700">
    <ChevronLeft size={16} /> Back
  </button>
);

// Amount-Paid drill — its OWN screen (opened from the tile, like Outstanding
// Payables). Lists the cash paid split by purchase CATEGORY; click a category to
// drill into its payments and their bills (the existing payment_account records
// view).
function AmountPaidAccountsScreen({ accounts, total, onAccount }) {
  const rows = accounts || [];
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
      <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-100">
        <div className="flex items-center gap-2 text-slate-700">
          <Wallet size={18} className="text-emerald-600" />
          <span className="font-semibold">Amount Paid — by category</span>
        </div>
        <div className="text-right">
          <div className="text-lg font-bold text-slate-900 tabular-nums">{fmtINRfull(total)}</div>
          <div className="text-[11px] text-slate-400">cash paid this period</div>
        </div>
      </div>
      <p className="text-[11px] text-slate-500 px-5 pt-3">
        Cash paid this period, split by the category of purchase it paid for. Click a category to see its payments and their bills.
      </p>
      <div className="px-2 py-2">
        {rows.length === 0 ? (
          <p className="text-sm text-slate-500 px-3 py-6 text-center">No payments in this period.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {rows.map((a) => (
              <button key={a.key} type="button" onClick={() => onAccount(a.key, a.label)}
                className="w-full flex items-center justify-between gap-3 px-3 py-3 rounded-lg hover:bg-emerald-50 transition group text-left">
                <span className="font-medium text-slate-700 group-hover:text-emerald-700">{a.label}</span>
                <span className="flex items-center gap-3 shrink-0">
                  <span className="tabular-nums font-semibold text-slate-800 group-hover:text-emerald-700">{fmtINRfull(a.amount)}</span>
                  <ChevronRight size={15} className="text-slate-400 group-hover:text-emerald-600" />
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Payables buckets popup ───────────────────────────────────────────
// Outstanding-Payables drill-down: vendor bills split by payment terms —
// Within Payment Terms (Paid Early / Still Open) and Exceeded Payment
// Terms (Paid Late / Overdue), ordered by days early/late/overdue, with
// per-bucket + grand totals, a vendor filter, and hyperlinked bill + PO.
const SUB_STYLE = {
  paid_early:     { dot: 'bg-emerald-500', amt: 'text-emerald-700' },
  still_open:     { dot: 'bg-blue-500',    amt: 'text-blue-700' },
  paid_late:      { dot: 'bg-amber-500',   amt: 'text-amber-700' },
  overdue_unpaid: { dot: 'bg-rose-500',    amt: 'text-rose-700' },
};

function BucketsModal({ companyId, vendorId: vendorId0, productId: productId0, includeTransfers: includeTransfers0,
                         period: period0, anchor: anchor0, from: from0, to: to0, onClose, inline = false }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Seed from the dashboard's own current filters so the popup opens already
  // scoped to what the user was just looking at (the KPI card's number),
  // instead of silently resetting to "All Vendors / All Time" — the vendor
  // and period pickers below still let the user broaden the view from here.
  const [vendor, setVendor] = useState(vendorId0 || '');
  const [vendorOpts, setVendorOpts] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [bucketPage, setBucketPage] = useState(1);
  const [bucketSort, setBucketSort] = useState('vendor');
  const sortBucket = (k) => { setBucketSort(k); setBucketPage(1); };
  const [mainTab, setMainTab] = useState('buckets'); // buckets | monthly | opening
  const [monthlyData, setMonthlyData] = useState(null);
  const [monthlyLoading, setMonthlyLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    const qp = new URLSearchParams({ type: 'payables_buckets' });
    if (period0 && period0 !== 'all') {
      qp.set('period', period0);
      const w = period0 === 'custom' ? { from: from0, to: to0 } : effWindow(period0, anchor0, from0, to0);
      if (w) { qp.set('from', w.from); qp.set('to', w.to); }
    }
    if (companyId) qp.set('company', companyId);
    if (vendor) qp.set('vendor', vendor);
    if (productId0) qp.set('product', productId0);
    if (includeTransfers0) qp.set('include_transfers', '1');
    apiClient.get(`/api/purchase/dashboard/records/?${qp.toString()}`)
      .then(r => {
        if (cancelled) return;
        setData(r.data);
        if (!vendor) {
          const seen = new Map();
          (r.data.groups || []).forEach(g => g.sub.forEach(s => s.rows.forEach(row => {
            if (row.vendor_id && !seen.has(row.vendor_id)) seen.set(row.vendor_id, row.vendor_name);
          })));
          setVendorOpts([...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)));
        }
      })
      .catch(e => { if (!cancelled) setError(e.response?.data?.detail || 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [companyId, vendor, period0, anchor0, from0, to0, productId0, includeTransfers0]);

  // Fetch monthly breakdown when that tab is opened
  useEffect(() => {
    if (mainTab !== 'monthly' && mainTab !== 'opening') return;
    if (monthlyData) return; // already loaded
    setMonthlyLoading(true);
    const qp = new URLSearchParams({ type: 'payables_monthly' });
    if (period0 && period0 !== 'all') {
      qp.set('period', period0);
      const w = period0 === 'custom' ? { from: from0, to: to0 } : effWindow(period0, anchor0, from0, to0);
      if (w) { qp.set('from', w.from); qp.set('to', w.to); }
    }
    if (companyId) qp.set('company', companyId);
    if (vendor) qp.set('vendor', vendor);
    if (productId0) qp.set('product', productId0);
    if (includeTransfers0) qp.set('include_transfers', '1');
    apiClient.get(`/api/purchase/dashboard/records/?${qp.toString()}`)
      .then(r => setMonthlyData(r.data))
      .catch(() => {})
      .finally(() => setMonthlyLoading(false));
  }, [mainTab, companyId, vendor, period0, anchor0, from0, to0, productId0, includeTransfers0, monthlyData]);

  // Reset monthly cache when filters change
  useEffect(() => { setMonthlyData(null); },
    [companyId, vendor, period0, anchor0, from0, to0, productId0, includeTransfers0]);

  const openBucket = (k) => { setExpanded(k); setBucketPage(1); };
  const backToBuckets = () => setExpanded(null);

  // ← / → page the open bucket's bill table (12/page, mirrors the render).
  const _bktSel = (expanded && data)
    ? (data.groups || []).flatMap(g => g.sub || []).find(s => s.key === expanded)
    : null;
  const _bktTotal = Math.max(1, Math.ceil((_bktSel?.rows?.length || 0) / 12));
  usePagerKeys({
    enabled: !!_bktSel && _bktTotal > 1,
    onPrev: () => setBucketPage(p => Math.max(1, Math.min(p, _bktTotal) - 1)),
    onNext: () => setBucketPage(p => Math.min(_bktTotal, p + 1)),
  });

  const exportAll = () => {
    if (!data) return;
    const rows = [];
    data.groups.forEach(g => g.sub.forEach(s => s.rows.forEach(r => rows.push({
      group: g.label, bucket: s.label, bill_no: r.bill_no, vendor: r.vendor_name,
      po_no: r.po_no || '', bill_date: r.bill_date || '', due_date: r.due_date || '',
      status: r.days_label, amount: Number(r.amount || 0).toFixed(2),
    }))));
    exportToExcel(rows, [
      { field: 'group', header: 'Payment Terms' }, { field: 'bucket', header: 'Bucket' },
      { field: 'bill_no', header: 'Bill No' }, { field: 'vendor', header: 'Vendor' },
      { field: 'po_no', header: 'PO No' }, { field: 'bill_date', header: 'Bill Date' },
      { field: 'due_date', header: 'Due Date' }, { field: 'status', header: 'Timing' },
      { field: 'amount', header: 'Amount (₹)' },
    ], `payables-buckets-${new Date().toISOString().slice(0, 10)}`);
    toast.success('Buckets downloaded!');
  };

  return (
    <div className={inline ? '' : 'fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-2 sm:p-4'} onClick={inline ? undefined : onClose}>
      <div className={inline
        ? 'bg-white rounded-xl border border-slate-200 shadow-sm w-full flex flex-col'
        : 'bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[92dvh] flex flex-col'}
        onClick={inline ? undefined : (e => e.stopPropagation())}>
        {/* Header — tile name + vendor filter inline, Excel/close on the right */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-5 py-3 border-b border-slate-200 flex-wrap">
          <div className="flex items-center gap-3 min-w-0 shrink-0">
            <span className="p-2 rounded-xl bg-rose-50 text-rose-600 shrink-0"><AlertCircle size={20} /></span>
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-semibold text-slate-900 leading-tight">Outstanding Payables</h2>
              <p className="text-xs text-slate-500 mt-0.5">Live snapshot · grouped by vendor — open a bucket to order it by how overdue each bill is</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
            <CustomSelect value={vendor} onChange={(e) => setVendor(e.target.value)}
              className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white min-w-0 max-w-[180px]" title="Vendor">
              <option value="">All Vendors</option>
              {vendorOpts.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </CustomSelect>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={exportAll} disabled={!data}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 disabled:opacity-50">
              <Download size={14} /> Excel
            </button>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" aria-label="Close"><X size={18} /></button>
          </div>
        </div>

        {/* Summary strip */}
        {data && (
          <div className="px-5 py-3 border-b border-slate-100 grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="rounded-xl border border-rose-200 bg-rose-50/60 px-4 py-2.5">
              <p className="text-[10px] uppercase text-rose-600 font-semibold tracking-wide">Outstanding</p>
              <p className="text-lg font-bold text-rose-700 tabular-nums">{fmtINRfull(data.outstanding_total)}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5">
              <p className="text-[10px] uppercase text-slate-500 font-semibold tracking-wide">Total (incl. settled)</p>
              <p className="text-lg font-bold text-slate-800 tabular-nums">{fmtINRfull(data.total)}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5">
              <p className="text-[10px] uppercase text-slate-500 font-semibold tracking-wide">Bills</p>
              <p className="text-lg font-bold text-slate-800 tabular-nums">{(data.groups || []).reduce((s, g) => s + (g.count || 0), 0)}</p>
            </div>
          </div>
        )}

        {/* Main tabs */}
        <div className="flex border-b border-slate-100 px-5">
          {[['buckets','Buckets'],['monthly','Month-wise'],['opening','Opening Balance']].map(([key, label]) => (
            <button key={key} onClick={() => { setMainTab(key); setExpanded(null); }}
              className={`px-3 py-2.5 text-xs font-semibold mr-1 border-b-2 -mb-px transition whitespace-nowrap
                ${mainTab === key ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
              {label}
            </button>
          ))}
        </div>

        <div className={`${inline ? '' : 'overflow-y-auto'} flex-1`}>

        {/* ── Monthly tab ── */}
        {mainTab === 'monthly' && (
          <div>
            {monthlyLoading && <div className="flex items-center justify-center py-12 text-slate-500"><Loader2 className="animate-spin mr-2" size={18}/> Loading…</div>}
            {!monthlyLoading && monthlyData && (
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b border-slate-200 sticky top-0 z-10">
                    <th className="px-4 py-3 text-left text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Month</th>
                    <th className="px-3 py-3 text-right text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Bills</th>
                    <th className="px-3 py-3 text-center text-[10px] font-semibold text-green-500 uppercase tracking-wider">Paid</th>
                    <th className="px-3 py-3 text-center text-[10px] font-semibold text-blue-500 uppercase tracking-wider">Partial</th>
                    <th className="px-3 py-3 text-center text-[10px] font-semibold text-amber-500 uppercase tracking-wider">Open</th>
                    <th className="px-4 py-3 text-right text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Billed</th>
                    <th className="px-4 py-3 text-right text-[10px] font-semibold text-rose-400 uppercase tracking-wider">Outstanding</th>
                    <th className="px-4 py-3 text-left text-[10px] font-semibold text-slate-300 uppercase tracking-wider w-24">Paid %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {monthlyData.opening && (() => {
                    const op = monthlyData.opening;
                    const paidPct = op.total > 0 ? Math.round((op.paid / op.total) * 100) : 0;
                    return (
                      <tr className="bg-amber-50 border-b border-amber-200">
                        <td className="px-4 py-2.5 font-semibold text-amber-700 whitespace-nowrap italic">Opening (pre-FY)</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-amber-700 font-semibold">{op.total}</td>
                        <td className="px-3 py-2.5 text-center">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-semibold text-[11px]">✓ {op.paid}</span>
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-semibold text-[11px]">~ {op.partial}</span>
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold text-[11px]">○ {op.open}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-amber-700 whitespace-nowrap">{fmtINRfull(op.billed)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-rose-600 whitespace-nowrap">{fmtINRfull(op.outstanding)}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <div className="flex-1 h-1.5 rounded bg-slate-200 overflow-hidden min-w-[60px]">
                              <div className="h-full rounded bg-amber-300" style={{width: `${paidPct}%`}}></div>
                            </div>
                            <span className="text-[10px] text-slate-400 w-7 text-right">{paidPct}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })()}
                  {(monthlyData.months || []).map(r => {
                    const paidPct = r.total > 0 ? Math.round((r.paid / r.total) * 100) : 0;
                    return (
                      <tr key={r.month} className="hover:bg-primary-50/40 transition-colors">
                        <td className="px-4 py-2.5 font-medium text-slate-700 whitespace-nowrap">{r.label}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-slate-600 font-semibold">{r.total}</td>
                        <td className="px-3 py-2.5 text-center">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-semibold text-[11px]">✓ {r.paid}</span>
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-semibold text-[11px]">~ {r.partial}</span>
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold text-[11px]">○ {r.open}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-slate-600 whitespace-nowrap">{fmtINRfull(r.billed)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-rose-600 whitespace-nowrap">{fmtINRfull(r.outstanding)}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <div className="flex-1 h-1.5 rounded bg-slate-200 overflow-hidden min-w-[60px]">
                              <div className="h-full rounded bg-green-400" style={{width: `${paidPct}%`}}></div>
                            </div>
                            <span className="text-[10px] text-slate-400 w-7 text-right">{paidPct}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="bg-slate-50 border-t-2 border-slate-300 font-semibold">
                    <td className="px-4 py-2.5 text-slate-800">Total</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-800">
                      {(monthlyData.months || []).reduce((s, r) => s + r.total, 0)}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-700 text-[11px] font-bold">
                        {(monthlyData.months || []).reduce((s, r) => s + r.paid, 0)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-[11px] font-bold">
                        {(monthlyData.months || []).reduce((s, r) => s + r.partial, 0)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[11px] font-bold">
                        {(monthlyData.months || []).reduce((s, r) => s + r.open, 0)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-800">{fmtINRfull(monthlyData.total_billed)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-rose-700">{fmtINRfull(monthlyData.total_outstanding)}</td>
                    <td className="px-4 py-2.5"></td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── Opening Balance tab ── */}
        {mainTab === 'opening' && (
          <div>
            <div className="px-5 py-3 bg-indigo-50 border-b border-indigo-100 flex items-center justify-between">
              <div>
                <span className="text-xs font-semibold text-indigo-500 uppercase tracking-wide">Opening Balance (01-Apr-2026)</span>
                <span className="ml-3 text-sm font-bold text-indigo-700">₹0.00</span>
                <span className="ml-2 text-[11px] text-indigo-400">· from Tally</span>
              </div>
              <button className="text-xs text-indigo-600 border border-indigo-200 rounded-lg px-3 py-1.5 bg-white hover:bg-indigo-50">Set Opening</button>
            </div>
            {monthlyLoading && <div className="flex items-center justify-center py-12 text-slate-500"><Loader2 className="animate-spin mr-2" size={18}/> Loading…</div>}
            {!monthlyLoading && monthlyData && (
              <>
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b border-slate-200 sticky top-0 z-10">
                    <th className="px-4 py-3 text-left text-[10px] font-semibold text-slate-400 uppercase">Month</th>
                    <th className="px-4 py-3 text-right text-[10px] font-semibold text-slate-400 uppercase">Opening</th>
                    <th className="px-4 py-3 text-right text-[10px] font-semibold text-slate-400 uppercase">+ Billed</th>
                    <th className="px-4 py-3 text-right text-[10px] font-semibold text-slate-400 uppercase">− Paid</th>
                    <th className="px-4 py-3 text-right text-[10px] font-semibold text-slate-400 uppercase">Closing</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(monthlyData.months || []).map((r, i, arr) => {
                    const prevClose = arr.slice(0, i).reduce((s, x) => s + Number(x.billed), 0);
                    const closing = prevClose + Number(r.billed);
                    return (
                      <tr key={r.month} className="hover:bg-primary-50/40 transition-colors">
                        <td className="px-4 py-2.5 font-medium text-slate-700">{r.label}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{fmtINRfull(prevClose)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">+{fmtINRfull(r.billed)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-green-600">−{fmtINRfull(0)}</td>
                        <td className={`px-4 py-2.5 text-right tabular-nums font-semibold ${i === arr.length-1 ? 'text-rose-700' : 'text-slate-800'}`}>{fmtINRfull(closing)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="px-4 py-2.5 bg-rose-50 border-t border-rose-200 flex justify-between items-center">
                <span className="text-xs font-semibold text-rose-600">Closing Balance</span>
                <span className="text-sm font-bold text-rose-700">{fmtINRfull(monthlyData.total_outstanding)}</span>
              </div>
              </>
            )}
          </div>
        )}

        {/* ── Buckets tab ── */}
        {mainTab === 'buckets' && <div className="px-4 sm:px-5 py-4 space-y-4">
          {loading && <div className="flex items-center justify-center py-12 text-slate-500"><Loader2 className="animate-spin mr-2" size={18} /> Loading…</div>}
          {error && <p className="text-sm text-rose-600 text-center py-8">{error}</p>}
          {!loading && !error && data && (() => {
            // Resolve the selected bucket (if any) across both groups.
            let selSub = null, selExceeded = false;
            for (const g of data.groups) {
              const found = (g.sub || []).find(s => s.key === expanded);
              if (found) { selSub = found; selExceeded = g.key === 'exceeded_terms'; break; }
            }
            // ── Detail: the selected bucket alone + its bill table (paginated)
            if (selSub) {
              const st = SUB_STYLE[selSub.key] || {};
              const PAGE = 12;
              // `days` means a different thing per bucket (overdue / late /
              // early / to-due), but in every one of them a BIGGER number is
              // further from the due date — so one comparator serves all four
              // and the label is what changes.
              const sorted = bucketSort === 'vendor'
                ? selSub.rows
                : [...selSub.rows].sort((a, b) => (
                  bucketSort === 'longest'
                    ? (b.days || 0) - (a.days || 0)
                    : (a.days || 0) - (b.days || 0)
                ));
              const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE));
              const cp = Math.min(bucketPage, totalPages);
              const rows = sorted.slice((cp - 1) * PAGE, cp * PAGE);
              // "Most overdue" only reads correctly where the number IS a
              // lateness; on the other buckets it is a distance from due.
              const longestLabel = (selSub.key === 'overdue_unpaid'
                || selSub.key === 'paid_late') ? 'Most overdue' : 'Longest';
              return (
                <div className={`bg-white rounded-xl border shadow-sm overflow-hidden ${selExceeded ? 'border-rose-300 ring-1 ring-rose-200' : 'border-emerald-300 ring-1 ring-emerald-200'}`}>
                  <div className={`flex items-center justify-between gap-3 px-4 py-3 border-b ${selExceeded ? 'bg-rose-50 border-rose-100' : 'bg-emerald-50 border-emerald-100'}`}>
                    <button type="button" onClick={backToBuckets} className="inline-flex items-center gap-1 text-sm font-medium text-slate-700 hover:text-slate-900 shrink-0"><ChevronLeft size={16} /> Back</button>
                    <span className="flex items-center gap-2 text-sm font-semibold text-slate-700 min-w-0 truncate">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
                      <span className="truncate">{selSub.label}</span>
                      <span className="text-[11px] font-medium text-slate-500 bg-white/70 rounded-full px-1.5 py-0.5 shrink-0">{selSub.count}</span>
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      {selSub.rows.length > 1 && (
                        <div className="flex rounded-lg border border-slate-300 overflow-hidden bg-white" title="Order these bills by">
                          {[['vendor', 'Vendor'], ['longest', longestLabel], ['newest', 'Newest']].map(([k, l], i) => (
                            <button key={k} type="button" onClick={() => sortBucket(k)}
                              className={`px-2 py-1 text-[11px] font-medium ${i > 0 ? 'border-l border-slate-300' : ''} ${bucketSort === k ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}>{l}</button>
                          ))}
                        </div>
                      )}
                      <span className={`text-sm font-bold tabular-nums ${st.amt || 'text-slate-700'}`}>{fmtINRfull(selSub.total)}</span>
                    </div>
                  </div>
                  {selSub.rows.length === 0 ? (
                    <p className="px-4 py-4 sm:py-5 text-sm text-slate-400 text-center">No bills in this bucket.</p>
                  ) : (
                    <>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs sm:text-sm">
                          <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-slate-500 text-[11px] uppercase tracking-wide"><tr>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Bill No</th>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Bill Date</th>
                            <th className="text-left px-3 py-2 font-semibold">Vendor</th>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Due Date</th>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Timing</th>
                            <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Amount</th>
                          </tr></thead>
                          <tbody>
                            {rows.map((r, i) => (
                              <tr key={i} className="border-t border-slate-100 hover:bg-primary-50/40 transition-colors">
                                <td className="px-3 py-2 whitespace-nowrap">
                                  {r.is_opening ? <span className="text-slate-500">{r.bill_no}</span>
                                    : <button onClick={() => navigate(`/purchase/bills/${r.bill_id}`, { state: { backTo: backHere() } })} className="text-violet-700 hover:underline font-medium">{r.bill_no || '—'}</button>}
                                </td>
                                <td className="px-3 py-2 text-slate-500 whitespace-nowrap tabular-nums">{fmtDate(r.bill_date)}</td>
                                <td className="px-3 py-2 text-slate-700">{r.vendor_name}</td>
                                <td className="px-3 py-2 text-slate-500 whitespace-nowrap tabular-nums">{fmtDate(r.due_date)}</td>
                                <td className="px-3 py-2 whitespace-nowrap text-slate-500">{r.days_label || '—'}</td>
                                <td className="px-3 py-2 text-right font-semibold text-slate-800 whitespace-nowrap tabular-nums">{fmtINRfull(r.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {totalPages > 1 && (
                        <div className="flex items-center justify-between px-3 py-2 border-t border-slate-100 text-xs text-slate-500">
                          <span>Showing {(cp - 1) * PAGE + 1}–{Math.min(cp * PAGE, selSub.rows.length)} of {selSub.rows.length}</span>
                          <div className="flex items-center gap-1">
                            <button onClick={() => setBucketPage(p => Math.max(1, p - 1))} disabled={cp <= 1} className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40"><ChevronLeft size={15} /></button>
                            <span className="px-2 tabular-nums">{cp} / {totalPages}</span>
                            <button onClick={() => setBucketPage(p => Math.min(totalPages, p + 1))} disabled={cp >= totalPages} className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40"><ChevronRight size={15} /></button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            }
            // ── Master: all four buckets as pills; click → detail
            const allSubs = data.groups.flatMap(g => (g.sub || []).map(s => ({ ...s, exceeded: g.key === 'exceeded_terms' })));
            return (
              <div className="flex flex-wrap gap-2">
                {allSubs.map(s => {
                  const st = SUB_STYLE[s.key] || {};
                  const canOpen = s.rows.length > 0;
                  return (
                    <button key={s.key} type="button" onClick={() => canOpen && openBucket(s.key)} disabled={!canOpen}
                      className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border text-sm font-medium transition ${s.exceeded ? 'border-rose-200' : 'border-emerald-200'} ${canOpen ? 'bg-white text-slate-700 hover:shadow-md cursor-pointer' : 'bg-slate-50 text-slate-400 cursor-default'}`}>
                      <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot || 'bg-slate-400'}`} />
                      {s.label}
                      <span className="text-xs text-slate-400">({s.count})</span>
                    </button>
                  );
                })}
              </div>
            );
          })()}
        </div>}

        </div>{/* end overflow wrapper */}
      </div>
    </div>
  );
}

// Compact period bar for the ledger drill-down (Today/Week/Month/FY/Custom +
// the matching picker), reusing the dashboard's own range helpers. The "All
// time" toggle lives beside it in the modal header.
function LedgerPeriodBar({ period, setPeriod, anchor, setAnchor, from, to, setFrom, setTo }) {
  const P = [{ v: 'today', l: 'Today' }, { v: 'week', l: 'Week' }, { v: 'month', l: 'Month' }, { v: 'fy', l: 'FY' }, { v: 'custom', l: 'Custom' }];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div className="flex rounded-lg border border-slate-200 overflow-hidden">
        {P.map((p, i) => (
          <button key={p.v} type="button"
            onClick={() => { setPeriod(p.v); setAnchor(p.v === 'fy' ? fyTokenFor(new Date()) : todayISO()); }}
            title={p.v === 'fy' ? 'Financial year (1 Apr – 31 Mar)' : undefined}
            className={`px-2.5 py-1.5 text-xs ${i > 0 ? 'border-l border-slate-200' : ''} ${period === p.v ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>{p.l}</button>
        ))}
      </div>
      {period === 'week' && (
        <CustomSelect value={weekRangeOf(anchor).from} onChange={(e) => setAnchor(e.target.value)} title="Select week"
          className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm bg-white min-w-[170px]">
          {weekOptions().map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
        </CustomSelect>
      )}
      {period === 'month' && (
        <CustomSelect value={monthRangeOf(anchor).from} onChange={(e) => setAnchor(e.target.value)} title="Select month"
          className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm bg-white min-w-[130px]">
          {monthOptions().map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </CustomSelect>
      )}
      {period === 'fy' && (
        <CustomSelect value={anchor} onChange={(e) => setAnchor(e.target.value)} title="Select financial year / half"
          className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm bg-white min-w-[180px]">
          {fyOptions().map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </CustomSelect>
      )}
      {period === 'custom' && (
        <div className="flex items-center gap-1.5 text-xs">
          <CustomDatePicker value={from} onChange={(e) => setFrom(e.target.value)} max={to} className="border border-slate-300 rounded px-2 py-1.5" />
          <span className="text-slate-400">to</span>
          <CustomDatePicker value={to} onChange={(e) => setTo(e.target.value)} min={from} max={todayISO()} className="border border-slate-300 rounded px-2 py-1.5" />
        </div>
      )}
    </div>
  );
}

// ── Vendor transactions popup — full running ledger for one vendor (opening
// balance + every bill / payment / debit-credit note in date order with a
// running balance). Opened by clicking a Vendor-details row. Balance is
// credit-nature (a positive balance = we owe the vendor → shown "Cr").
// Seeds its period from the dashboard window; "All Time" shows the full history.
function VendorLedgerModal({ vendorId, vendorName, period0, anchor0, from0, to0, onClose, inline = false, settledPct }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  // Seeded from the dashboard's period so the ledger opens on the same window
  // the Vendor-details row was filtered to; "All Time" is one click away for
  // the full Tally-reconciling history.
  const [period, setPeriod] = useState(period0 || 'all');
  const [anchor, setAnchor] = useState(anchor0 || todayISO());
  const [from, setFrom] = useState(from0 || todayISO());
  const [to, setTo] = useState(to0 || todayISO());
  const [q, setQ] = useState('');                  // free-text search in the ledger
  const [typeFilter, setTypeFilter] = useState(''); // '' = all types
  const [flagFilter, setFlagFilter] = useState(''); // '' | 'outstanding' | 'overdue'
  const [barIn, setBarIn] = useState(false);        // Settled bar grow-in animation
  useEffect(() => { setBarIn(false); const t = setTimeout(() => setBarIn(true), 90); return () => clearTimeout(t); }, [vendorId, settledPct]);
  const eff = effWindow(period, anchor, from, to);

  useEffect(() => {
    if (!vendorId) return;
    let cancelled = false; setLoading(true); setError(null); setPage(1);
    const qp = new URLSearchParams({ vendor: vendorId });
    if (period !== 'all') { qp.set('from', eff.from); qp.set('to', eff.to); }
    apiClient.get(`/api/purchase/bills/vendor-ledger/?${qp.toString()}`)
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch((e) => { if (!cancelled) setError(e.response?.data?.detail || 'Failed to load vendor transactions.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [vendorId, period, eff.from, eff.to]);

  // Payable balance: positive = we owe the vendor (Cr); negative = advance (Dr).
  const bal = (v) => { const n = Number(v) || 0; return `${fmtINRfull(Math.abs(n))} ${n < 0 ? 'Dr' : 'Cr'}`; };
  const typeCls = (t) => ({
    'Bill': 'bg-sky-50 text-sky-700', 'Payment': 'bg-emerald-50 text-emerald-700',
    'Debit Note': 'bg-amber-50 text-amber-700', 'Credit Note': 'bg-blue-50 text-blue-700',
  }[t] || 'bg-slate-100 text-slate-600');

  // Proper in-drawer filters: a type filter + free-text search over every
  // visible field, applied before pagination (matches the sales statement).
  const allRows = data?.rows || [];
  const ledgerTypes = [...new Set(allRows.map((r) => r.type).filter(Boolean))];
  // Any bill still carrying a balance / past its due date — used by the
  // Outstanding / Overdue filters (only Bill rows carry these fields).
  const hasOutstanding = allRows.some((r) => Number(r.outstanding) > 0);
  const rows = allRows.filter((r) => {
    if (typeFilter && r.type !== typeFilter) return false;
    if (flagFilter === 'outstanding' && !(Number(r.outstanding) > 0)) return false;
    if (flagFilter === 'overdue' && !(Number(r.outstanding) > 0 && overdueDaysOf(r.due_date) > 0)) return false;
    const s = q.trim().toLowerCase();
    if (!s) return true;
    return [r.date, r.type, r.doc_no, r.debit, r.credit, r.tds, r.balance]
      .some((v) => String(v ?? '').toLowerCase().includes(s));
  });
  useEffect(() => { setPage(1); }, [q, typeFilter, flagFilter]);
  // No pagination — show every row in one Tally-style scroll (user ask).
  const PAGE_SIZE = Math.max(1, rows.length);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const cp = Math.min(page, totalPages);
  const pageRows = rows.slice((cp - 1) * PAGE_SIZE, cp * PAGE_SIZE);
  usePagerKeys({   // ← / → page the vendor ledger
    enabled: totalPages > 1,
    onPrev: () => setPage(p => Math.max(1, Math.min(p, totalPages) - 1)),
    onNext: () => setPage(p => Math.min(totalPages, p + 1)),
  });

  const exportAll = () => {
    if (!rows.length) return;
    exportToExcel(rows.map((r) => ({
      date: r.date, type: r.type, doc_no: r.doc_no,
      debit: Number(r.debit || 0).toFixed(2), credit: Number(r.credit || 0).toFixed(2),
      tds: Number(r.tds || 0).toFixed(2), balance: Number(r.balance || 0).toFixed(2),
    })), [
      { field: 'date', header: 'Date' }, { field: 'type', header: 'Type' },
      { field: 'doc_no', header: 'Doc No' }, { field: 'debit', header: 'Debit (₹)' },
      { field: 'credit', header: 'Credit (₹)' }, { field: 'tds', header: 'TDS (₹)' },
      { field: 'balance', header: 'Balance (₹)' },
    ], `vendor-ledger-${(data?.vendor_name || vendorName || 'vendor').replace(/[^\w-]+/g, '_')}`);
  };

  return (
    <div className={inline ? '' : 'fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-2 sm:p-4'} onClick={inline ? undefined : onClose}>
      <div className={inline
        ? 'bg-white rounded-xl border border-slate-200 shadow-sm w-full flex flex-col'
        : 'bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[92dvh] flex flex-col'}
        onClick={inline ? undefined : (e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-4 sm:px-5 py-3 border-b border-slate-100 flex-wrap">
          <div className="flex items-center gap-2 min-w-0 shrink-0">
            <Wallet size={18} className="text-indigo-600 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-semibold text-slate-800 truncate">{data?.vendor_name || vendorName || 'Vendor'}</h2>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => setPeriod('all')}
              className={`px-2.5 py-1.5 rounded-lg text-xs border shrink-0 ${period === 'all' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'}`}>All Time</button>
            <LedgerPeriodBar period={period === 'all' ? '' : period} setPeriod={setPeriod} anchor={anchor} setAnchor={setAnchor}
              from={from} to={to} setFrom={setFrom} setTo={setTo} />
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-auto">
            {/* Settled — small animated progress bar at the right end before Excel. */}
            {Number.isFinite(settledPct) && (
              <span className="hidden sm:flex items-center gap-1.5 whitespace-nowrap" title={`Settled ${settledPct}%`}>
                <span className="text-[11px] font-medium text-slate-500">Settled</span>
                <span className="h-1.5 w-16 rounded-full bg-slate-100 overflow-hidden">
                  <span className="block h-full rounded-full bg-emerald-500 transition-all duration-700 ease-out"
                    style={{ width: `${barIn ? settledPct : 0}%` }} />
                </span>
                <span className={`text-[11px] font-bold tabular-nums ${settledPct >= 100 ? 'text-emerald-600' : 'text-slate-700'}`}>{settledPct}%</span>
              </span>
            )}
            <button onClick={exportAll} disabled={!rows.length}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs sm:text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
              <Download size={14} /> <span className="hidden sm:inline">Excel</span>
            </button>
            {!inline && (
              <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-100 text-slate-500" aria-label="Close"><X size={18} /></button>
            )}
          </div>
        </div>

        <div className={inline ? 'px-4 sm:px-5 py-4' : 'overflow-y-auto px-4 sm:px-5 py-4'}>
          {loading && <div className="flex items-center justify-center py-10 text-slate-500"><Loader2 className="animate-spin mr-2" size={18} /> Loading transactions…</div>}
          {error && <p className="text-sm text-rose-600 text-center py-8">{error}</p>}
          {!loading && !error && data && (
            <>
              {/* Indigo backdrop + light bordered tiles, matching the Sales
                  customer-ledger drawer and the Analytics KEY METRICS look. */}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 mb-4 bg-indigo-50 border border-indigo-200 rounded-xl p-2.5">
                <div className="rounded-lg border border-slate-300 bg-white p-2.5">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500 font-medium block leading-tight min-h-[2.4em]">Opening Balance</p>
                  <p className="text-base sm:text-lg font-bold text-slate-800 tabular-nums mt-0.5 leading-tight whitespace-nowrap">{bal(data.opening_balance)}</p>
                </div>
                <div className="rounded-lg border border-slate-300 bg-white p-2.5">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500 font-medium block leading-tight min-h-[2.4em]">Total Debit (Dr)</p>
                  <p className="text-base sm:text-lg font-bold text-emerald-700 tabular-nums mt-0.5 leading-tight whitespace-nowrap">{fmtINRfull(data.current_debit)}</p>
                </div>
                <div className="rounded-lg border border-slate-300 bg-white p-2.5">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500 font-medium block leading-tight min-h-[2.4em]">Total Billed (Cr)</p>
                  <p className="text-base sm:text-lg font-bold text-slate-800 tabular-nums mt-0.5 leading-tight whitespace-nowrap">{fmtINRfull(data.current_credit)}</p>
                </div>
                <div className="rounded-lg border border-slate-300 bg-white p-2.5">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500 font-medium block leading-tight min-h-[2.4em]">TDS Deducted</p>
                  <p className="text-base sm:text-lg font-bold text-amber-700 tabular-nums mt-0.5 leading-tight whitespace-nowrap">{Number(data.current_tds) ? fmtINRfull(data.current_tds) : '—'}</p>
                </div>
                <div className="rounded-lg border border-slate-300 bg-white p-2.5">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500 font-medium block leading-tight min-h-[2.4em]">Closing Balance</p>
                  {(() => {
                    // A debit closing (Dr) means the vendor is in ADVANCE (we've
                    // paid ahead), not a payable — flag it green with an "Adv" chip
                    // so it isn't read as money owed. A credit (Cr) is the payable.
                    const adv = Number(data.closing_balance) < -0.5;
                    return (
                      <p className={`text-base sm:text-lg font-bold tabular-nums mt-0.5 leading-tight whitespace-nowrap inline-flex items-center gap-1.5 ${adv ? 'text-emerald-600' : 'text-slate-800'}`}>
                        {adv && <span className="rounded bg-emerald-50 border border-emerald-200 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide">Adv</span>}
                        {bal(data.closing_balance)}
                      </p>
                    );
                  })()}
                </div>
              </div>

              {/* In-drawer filters: free-text search + type chips (user ask). */}
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <div className="relative flex-1 min-w-[180px]">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search date, type, doc no or amount…"
                    className="w-full border border-slate-300 rounded-lg pl-8 pr-7 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary-400" />
                  {q && <button type="button" onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X size={13} /></button>}
                </div>
                {ledgerTypes.length > 1 && (
                  <div className="flex gap-0.5 bg-slate-100 rounded-md p-0.5 flex-wrap">
                    {[['', 'All'], ...ledgerTypes.map((t) => [t, t])].map(([k, l]) => (
                      <button key={k || 'all'} type="button" onClick={() => setTypeFilter(k)}
                        className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${typeFilter === k ? 'bg-white text-primary-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                        {l}
                      </button>
                    ))}
                  </div>
                )}
                {/* Outstanding / Overdue — bills still carrying a balance / past due. */}
                {hasOutstanding && (
                  <div className="flex gap-0.5 bg-slate-100 rounded-md p-0.5 flex-wrap">
                    {[['', 'All Bills'], ['outstanding', 'Outstanding'], ['overdue', 'Overdue']].map(([k, l]) => (
                      // Outstanding / Overdue are LIVE (all-time) balances — the
                      // same figure the Vendor Details row shows. The ledger,
                      // though, folds every pre-window bill into Opening and
                      // returns only rows inside the selected period, so on a
                      // Month/FY view those unpaid bills aren't listed and the
                      // filter came up empty. Switch to All Time so the full set
                      // of unpaid/overdue bills loads and the filter matches the
                      // live figure.
                      <button key={k || 'allflag'} type="button"
                        onClick={() => { setFlagFilter(k); setPage(1); if ((k === 'outstanding' || k === 'overdue') && period !== 'all') setPeriod('all'); }}
                        className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${flagFilter === k
                          ? (k === 'overdue' ? 'bg-white text-rose-600 shadow-sm' : k === 'outstanding' ? 'bg-white text-amber-600 shadow-sm' : 'bg-white text-slate-700 shadow-sm')
                          : 'text-slate-500 hover:text-slate-700'}`}>
                        {l}
                      </button>
                    ))}
                  </div>
                )}
                <span className="text-[11px] text-slate-400 tabular-nums ml-auto">{rows.length} row(s)</span>
              </div>

              {rows.length === 0
                ? <p className="text-sm text-slate-400 text-center py-8">{q || typeFilter || flagFilter ? 'No transactions match the filters.' : 'No transactions for this vendor.'}</p>
                : (
                <div className="rounded-lg border border-slate-200 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs sm:text-[13px]">
                      <thead className="bg-slate-100 text-slate-500 text-[11px] uppercase tracking-wide">
                        <tr>
                          <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Date</th>
                          <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Type</th>
                          <th className="text-left px-3 py-2 font-semibold">Doc No</th>
                          <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Paid (Dr)</th>
                          <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Billed (Cr)</th>
                          <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">TDS</th>
                          <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map((r, i) => (
                          <tr key={(cp - 1) * PAGE_SIZE + i} className="border-t border-slate-100 odd:bg-white even:bg-slate-100/70 hover:bg-amber-50/50">
                            <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.date ? fmtDate(r.date) : '—'}</td>
                            <td className="px-3 py-2 whitespace-nowrap"><span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${typeCls(r.type)}`}>{r.type}</span></td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              {(() => {
                                // Every ledger row links to its own document: a
                                // Bill → bill detail, a Payment → the payment
                                // entry, a Debit/Credit Note → the note detail.
                                const base = { 'Bill': '/purchase/bills', 'Payment': '/purchase/payments-made', 'Debit Note': '/sales/debit-notes', 'Credit Note': '/sales/debit-notes' }[r.type];
                                const link = base && r.ref_id
                                  ? <button onClick={() => navigate(`${base}/${r.ref_id}`, { state: { backTo: backHere() } })} className="text-blue-700 hover:underline font-medium">{r.doc_no || '—'}</button>
                                  : <span className="text-slate-700">{r.doc_no || '—'}</span>;
                                // Per-bill outstanding / overdue flag (user ask).
                                if (r.type === 'Bill' && Number(r.outstanding) > 0) {
                                  const od = overdueDaysOf(r.due_date);
                                  return (
                                    <span className="inline-flex items-center gap-1.5">
                                      {link}
                                      <span className={`shrink-0 text-[9px] font-semibold rounded px-1 py-0.5 border ${od > 0 ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}
                                        title={`${fmtINRfull(r.outstanding)} still due${od > 0 ? ` · ${od} day${od > 1 ? 's' : ''} overdue` : ''}`}>
                                        {fmtINRc(r.outstanding)} due{od > 0 ? ` · ${od}d` : ''}
                                      </span>
                                    </span>
                                  );
                                }
                                return link;
                              })()}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-emerald-700">{Number(r.debit) ? fmtINRfull(r.debit) : '—'}</td>
                            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-slate-800">{Number(r.credit) ? fmtINRfull(r.credit) : '—'}</td>
                            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-amber-700">
                              {Number(r.tds) ? fmtINRfull(r.tds) : '—'}
                              {/* Two different fallbacks, two different marks:
                                  ⚠ amber  = an unlinked Tally TDS voucher EXISTS for
                                             this vendor → relink_tds_to_bills repairs
                                             the link (actionable warning).
                                  ⓘ slate  = TDS is on the bill only; Tally booked NO
                                             separate TDS voucher, so relink can't help
                                             and this figure is final (neutral info). */}
                              {Number(r.tds) > 0 && r.tds_source === 'relinkable' && (
                                <span className="ml-1 text-[10px] text-rose-500" title="TDS on the bill but its Tally deduction voucher isn't linked in ERP — run relink_tds_to_bills to fix">⚠</span>
                              )}
                              {Number(r.tds) > 0 && r.tds_source === 'bill_only' && (
                                <span className="ml-1 text-[10px] text-slate-400" title="TDS is recorded on the bill; Tally has no separate TDS voucher to link, so this figure is final">ⓘ</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-slate-800">{bal(r.balance)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {rows.length > PAGE_SIZE && (
                    <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 text-xs text-slate-500 bg-white">
                      <span>Showing {(cp - 1) * PAGE_SIZE + 1} to {Math.min(cp * PAGE_SIZE, rows.length)} of {rows.length}</span>
                      <div className="flex items-center gap-1">
                        <button onClick={() => setPage(cp - 1)} disabled={cp <= 1}
                          className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Previous page"><ChevronLeft size={15} /></button>
                        {pageWindow(cp, totalPages).map((p, idx) => p === '…'
                          ? <span key={`e${idx}`} className="px-1.5 text-slate-400">…</span>
                          : <button key={p} onClick={() => setPage(p)}
                              className={`min-w-[30px] px-2 py-1 rounded-lg border text-xs font-medium transition ${p === cp ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{p}</button>
                        )}
                        <button onClick={() => setPage(cp + 1)} disabled={cp >= totalPages}
                          className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Next page"><ChevronRight size={15} /></button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────
// ── Daily import reconciliation (Purchase Analytics footer) ──────────────
// Per-date: what Tally holds vs what's actually in Bills, and the gap. Two ways
// to get the Tally side: upload an exported register file (offline, works now)
// or "Compare with Tally" live (via the connector). Broken down per voucher
// type ("GST Purchase", "Purchase-Bought Note", …) when a file is used.
function ImportReconcile({ company }) {
  // Its own wide range (financial year → today) so it shows EVERY day and never
  // depends on the page's period filter (which can be a single day).
  const to = todayISO();
  const from = (() => {
    const d = new Date();
    const y = (d.getMonth() + 1) >= 4 ? d.getFullYear() : d.getFullYear() - 1;
    return `${y}-04-01`;
  })();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);       // raw rows: erp-only, live, or per-(date,type) from a file
  const [types, setTypes] = useState([]);       // voucher types present (file mode)
  const [typeFilter, setTypeFilter] = useState('all');
  const [mode, setMode] = useState('erp');      // 'erp' | 'live' | 'file'
  const [loading, setLoading] = useState(false);
  const [tallyBusy, setTallyBusy] = useState(false);
  const [waited, setWaited] = useState(0);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileName, setFileName] = useState('');
  const [openDate, setOpenDate] = useState(null);   // expanded date row (file mode)
  const fileRef = useRef(null);

  const hasTally = mode === 'live' || mode === 'file';
  const perType = mode === 'file';

  const loadErp = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ from, to });
      if (company) p.set('company', company);
      const r = await apiClient.get(`/api/purchase/dashboard/import-reconcile/?${p}`);
      setRows(r.data.rows || []); setTypes([]); setTypeFilter('all'); setMode('erp'); setFileName('');
    } catch { setRows([]); } finally { setLoading(false); }
  }, [from, to, company]);

  useEffect(() => { if (open) loadErp(); }, [open, loadErp]);

  const compareTally = async () => {
    setTallyBusy(true); setWaited(0);
    const started = Date.now();
    try {
      const p = new URLSearchParams({ from, to, tally: '1' });
      if (company) p.set('company', company);
      for (;;) {
        const r = await apiClient.get(`/api/purchase/dashboard/import-reconcile/?${p}`, { timeout: 600000 });
        if (r.status !== 202) { setRows(r.data.rows || []); setTypes([]); setTypeFilter('all'); setMode('live'); break; }
        const secs = Math.round((Date.now() - started) / 1000);
        if (secs > 300) { toast.error("Tally didn't respond in time — on the office PC, make sure it's open with the gateway on, then click \"Sync Tally Now\"."); break; }
        setWaited(secs);
        await new Promise((res) => setTimeout(res, 3000));
      }
    } catch (e) { toast.error(e.response?.data?.detail || e.message || 'Could not compare with Tally.'); }
    finally { setTallyBusy(false); setWaited(0); }
  };

  const uploadFile = async (file) => {
    if (!file) return;
    setFileBusy(true); setFileName(file.name);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (company) fd.append('company', company);
      const r = await apiClient.post('/api/purchase/dashboard/import-reconcile-file/', fd, {
        timeout: 600000,
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setRows(r.data.rows || []); setTypes(r.data.types || []); setTypeFilter('all'); setMode('file');
      if (r.data.backfilled) toast.success(`Read ${r.data.totals?.tally_count || 0} vouchers · tagged ${r.data.backfilled} bill(s) by type`);
    } catch (e) {
      toast.error(e.response?.data?.detail || e.message || 'Could not read that file.');
      setFileName('');
    } finally { setFileBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const dfmt = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

  // Rows to display: in file mode, either one type or aggregate per date across
  // all types. Otherwise the rows as-is (already per date).
  const displayRows = (() => {
    const rs = rows || [];
    if (!perType) return rs;
    if (typeFilter !== 'all') return rs.filter((r) => r.vtype === typeFilter);
    const byDate = {};
    for (const r of rs) {
      const d = (byDate[r.date] ||= { date: r.date, tally_count: 0, erp_count: 0, missing_count: 0, extra_count: 0, tally_amount: 0, erp_amount: 0 });
      d.tally_count += r.tally_count || 0; d.erp_count += r.erp_count || 0;
      d.missing_count += r.missing_count || 0; d.extra_count += r.extra_count || 0;
      d.tally_amount += Number(r.tally_amount || 0); d.erp_amount += Number(r.erp_amount || 0);
    }
    return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({ ...d, gap_amount: d.tally_amount - d.erp_amount }));
  })();

  const totErp = displayRows.reduce((s, r) => s + (r.erp_count || 0), 0);
  const totTally = displayRows.reduce((s, r) => s + (r.tally_count || 0), 0);
  const totMissing = perType ? displayRows.reduce((s, r) => s + (r.missing_count || 0), 0) : null;

  return (
    <div className="mt-4 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 sm:px-5 py-3 text-left">
        <span className="text-sm sm:text-base font-semibold text-slate-800 flex items-center gap-2 flex-wrap">
          <Calendar size={17} className="text-indigo-600" /> Daily import check
          <span className="text-[11px] font-normal text-slate-500">Tally vs Bills, day by day — upload a register file or compare live, and see what&apos;s missing</span>
        </span>
        <ChevronDown size={18} className={`text-slate-400 transition-transform shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-slate-100">
          <div className="flex items-center justify-between gap-2 px-4 sm:px-5 py-2.5 flex-wrap">
            <span className="text-xs text-slate-500">
              {loading ? 'Loading bills…'
                : hasTally ? `Tally ${totTally} · Bills ${totErp}${totMissing != null ? ` · ${totMissing} missing` : ''}${fileName ? ` · from ${fileName}` : ''}`
                : `${totErp} bill(s) in Bills for this period`}
            </span>
            <div className="flex items-center gap-2">
              <input ref={fileRef} type="file" accept=".xml" className="hidden"
                onChange={(e) => uploadFile(e.target.files?.[0])} />
              <button type="button" onClick={() => fileRef.current?.click()} disabled={fileBusy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-indigo-200 text-indigo-700 hover:bg-indigo-50 disabled:opacity-50">
                {fileBusy ? <><Loader2 size={13} className="animate-spin" /> Reading…</> : <><Upload size={13} /> Upload register file</>}
              </button>
              <button type="button" onClick={compareTally} disabled={tallyBusy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
                {tallyBusy ? <><Loader2 size={13} className="animate-spin" /> Checking Tally{waited ? ` … ${waited}s` : '…'}</> : 'Compare with Tally (live)'}
              </button>
            </div>
          </div>

          {perType && types.length > 0 && (
            <div className="flex items-center gap-1.5 px-4 sm:px-5 pb-2 flex-wrap">
              <span className="text-[11px] text-slate-400 mr-1">Voucher type:</span>
              {['all', ...types].map((t) => (
                <button key={t} type="button" onClick={() => setTypeFilter(t)}
                  className={`px-2 py-0.5 rounded-full text-[11px] font-medium border ${typeFilter === t ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'}`}>
                  {t === 'all' ? 'All' : t}
                </button>
              ))}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-xs sm:text-[13px]">
              <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-y border-slate-100 text-slate-500 text-[11px] uppercase tracking-wide">
                <tr className="text-left">
                  <th className="px-4 py-2 font-semibold">Date</th>
                  {perType && typeFilter === 'all' && <th className="px-3 py-2 font-semibold">Type</th>}
                  <th className="px-3 py-2 font-semibold text-right">In Tally</th>
                  <th className="px-3 py-2 font-semibold text-right">In Bills</th>
                  <th className="px-3 py-2 font-semibold text-right">{perType ? 'Matched / Missing' : 'Gap'}</th>
                  <th className="px-3 py-2 font-semibold text-right">Amount (Tally / Bills)</th>
                  <th className="px-3 py-2 font-semibold text-right"> </th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((r, i) => {
                  // File mode = true bill-by-bill match (missing_count); live mode
                  // = count difference (gap_count).
                  const gap = perType ? (r.missing_count || 0) : (r.gap_count || 0);
                  const done = hasTally && gap === 0;
                  const missing = hasTally && gap > 0;
                  const showType = perType && typeFilter === 'all';
                  const canExpand = perType;   // per-voucher detail only exists in file mode
                  const isOpen = canExpand && openDate === r.date;
                  // All vouchers for this date (respecting the type filter), each
                  // flagged matched/missing — from the raw rows (which carry items).
                  const detail = isOpen
                    ? (rows || [])
                        .filter((x) => x.date === r.date && (typeFilter === 'all' || x.vtype === typeFilter))
                        .flatMap((x) => (x.items || []).map((it) => ({ ...it, vtype: x.vtype })))
                    : [];
                  const cols = 6 + (showType ? 1 : 0);
                  return (
                    <Fragment key={`${r.date}-${r.vtype || i}`}>
                      <tr className={`border-b border-slate-50 hover:bg-primary-50/40 transition-colors ${canExpand ? 'cursor-pointer' : ''}`}
                        onClick={canExpand ? () => setOpenDate(isOpen ? null : r.date) : undefined}>
                        <td className="px-4 py-2 whitespace-nowrap text-slate-700">
                          {canExpand && <ChevronDown size={13} className={`inline mr-1 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />}
                          {dfmt(r.date)}
                        </td>
                        {showType && <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.vtype}</td>}
                        <td className="px-3 py-2 text-right tabular-nums text-slate-700">{hasTally ? r.tally_count : '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-700">{r.erp_count}</td>
                        <td className="px-3 py-2">
                          {!hasTally ? <div className="text-right text-slate-300">—</div>
                            : perType ? (() => {
                                const inn = (r.tally_count || 0) - (r.missing_count || 0);
                                const miss = r.missing_count || 0;
                                const extra = r.extra_count || 0;
                                const tot = inn + miss + extra || 1;
                                const w = (n) => `${(n / tot) * 100}%`;
                                return (
                                  <div className="flex items-center justify-end gap-2">
                                    <div className="flex h-1.5 w-16 rounded-full overflow-hidden bg-slate-100"
                                      title={`${inn} matched · ${miss} missing · ${extra} extra`}>
                                      <div className="bg-emerald-500" style={{ width: w(inn) }} />
                                      <div className="bg-rose-500" style={{ width: w(miss) }} />
                                      <div className="bg-amber-400" style={{ width: w(extra) }} />
                                    </div>
                                    <span className="text-xs tabular-nums whitespace-nowrap">
                                      <span className="text-emerald-600 font-medium">{inn} in</span>
                                      {miss > 0 && <span className="text-rose-600 font-medium"> · {miss} missing</span>}
                                      {extra > 0 && <span className="text-amber-600 font-medium"> · {extra} extra</span>}
                                    </span>
                                  </div>
                                );
                              })()
                            : done ? <div className="text-right text-emerald-600 font-medium">✓ all in</div>
                            : missing ? <div className="text-right text-rose-600 font-medium">{gap} missing</div>
                            : <div className="text-right text-amber-600 font-medium">{Math.abs(gap)} extra</div>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-500 whitespace-nowrap">
                          {hasTally ? `${fmtINRfull(r.tally_amount)} / ` : ''}{fmtINRfull(r.erp_amount)}
                        </td>
                        <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                          {missing && !showType && (
                            <TallyImportButton what="purchase" initialFrom={r.date} initialTo={r.date}
                              initialCompany={company || null} triggerLabel="Import day"
                              triggerClassName="text-xs px-2 py-1 border-indigo-200 text-indigo-700 hover:bg-indigo-50"
                              onDone={loadErp} />
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={cols} className="p-0 bg-slate-50/70">
                            <div className="px-4 sm:px-6 py-2">
                              {detail.length === 0
                                ? <div className="text-xs text-slate-400 py-2">No voucher detail for this day.</div>
                                : (
                                <div className="overflow-x-auto">
                                  <table className="w-full text-[11px] sm:text-xs">
                                    <thead className="text-slate-400 uppercase tracking-wide">
                                      <tr className="text-left">
                                        <th className="py-1 pr-3 font-semibold">Status</th>
                                        <th className="py-1 pr-3 font-semibold">Voucher</th>
                                        <th className="py-1 pr-3 font-semibold">Supplier invoice</th>
                                        <th className="py-1 pr-3 font-semibold">Party</th>
                                        {showType && <th className="py-1 pr-3 font-semibold">Type</th>}
                                        <th className="py-1 text-right font-semibold">Amount</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {detail.map((it, j) => (
                                        <tr key={j} className="border-t border-slate-100">
                                          <td className="py-1 pr-3 whitespace-nowrap">
                                            {it.status === 'matched'
                                              ? <span className="text-emerald-600 font-medium">✓ matched</span>
                                              : it.status === 'extra'
                                                ? <span className="text-amber-600 font-medium">＋ extra (in Bills only)</span>
                                                : <span className="text-rose-600 font-medium">✗ missing</span>}
                                          </td>
                                          <td className="py-1 pr-3 whitespace-nowrap text-slate-700">{it.number || '—'}</td>
                                          <td className="py-1 pr-3 whitespace-nowrap text-slate-500">{it.invoice_no || '—'}</td>
                                          <td className="py-1 pr-3 text-slate-600 truncate max-w-[220px]" title={it.party}>{it.party || '—'}</td>
                                          {showType && <td className="py-1 pr-3 text-slate-400 whitespace-nowrap">{it.vtype}</td>}
                                          <td className="py-1 text-right tabular-nums text-slate-600 whitespace-nowrap">{fmtINRfull(it.amount)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                                )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {displayRows.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-4 sm:py-5 text-center text-slate-400 text-sm">No bills in this period.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// In-page drill: all Zoho bills for one vendor (opens from a Vendor details row).
function ZohoVendorBills({ vendorName, vendorId, from, to, includeTransfers, productId }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openBill, setOpenBill] = useState(null);   // which bill's items are expanded
  useEffect(() => {
    setLoading(true);
    // Look up by the mapped ERP vendor id (respects the Import-from-Zoho mapping);
    // fall back to the raw name only when no id is available.
    const parts = [vendorId
      ? `vendor=${encodeURIComponent(vendorId)}`
      : `vendor_name=${encodeURIComponent(vendorName || '')}`];
    // Scope to the selected date window by the supplier Bill Date, so an April
    // filter shows only April-dated bills (not the vendor's whole history).
    if (from) parts.push(`bill_from=${from}`);
    if (to) parts.push(`bill_to=${to}`);
    // Mirror the page's "Purchases / +Transfers" toggle so branch-transfer
    // (DC/-prefixed) bills stay excluded from "tally-matched" here by default,
    // same as _bill_qs/_vendor_breakdown exclude them on the rest of the page.
    if (includeTransfers) parts.push('include_transfers=1');
    // Mirror the page's product filter too, so this drill-down's total ties
    // to the Vendor Details row (_vendor_breakdown, also product-scoped) the
    // user clicked to open it, instead of always showing every product.
    if (productId) parts.push(`product=${encodeURIComponent(productId)}`);
    apiClient.get(`/api/purchase/zoho/bills/?${parts.join('&')}`)
      .then((r) => setRows(r.data || [])).catch(() => setRows([])).finally(() => setLoading(false));
  }, [vendorName, vendorId, from, to, includeTransfers, productId]);
  // Total ties to TALLY: only rows the backend marked `converted: true` are
  // backed by a real VendorBill (the same ones the Vendor Details table counts
  // via _vendor_breakdown), so the Total column sums those only.
  //
  // Paid / Outstanding stay sourced from the FULL Zoho bill data (every row,
  // converted or not) — by design, not by omission. A pending/unconverted row
  // still reflects a real amount Zoho has recorded against this vendor, and
  // hiding it from Paid/Outstanding would make a genuinely-owed or
  // genuinely-paid amount invisible just because it hasn't been converted into
  // an ERP bill yet. Total and Paid+Balance can therefore legitimately differ
  // when pending rows exist — that gap IS the useful signal (it's exactly how
  // many rupees are sitting in Zoho, unconverted).
  const convertedRows = rows.filter((r) => r.converted);
  const pendingRows = rows.filter((r) => !r.converted);
  const tallyTotal = convertedRows.reduce((a, r) => a + Number(r.total_amount || 0), 0);
  const zohoPaidBalance = rows.reduce((a, r) => ({
    paid: a.paid + Number(r.amount_paid || 0),
    balance: a.balance + Number(r.balance_due || 0),
  }), { paid: 0, balance: 0 });
  const tot = { total: tallyTotal, ...zohoPaidBalance };
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-slate-100">
        <h3 className="text-sm sm:text-base font-semibold text-slate-800 flex items-center gap-2">
          <Wallet size={17} className="text-indigo-600" /> Bills — {vendorName}
          <span className="text-[11px] font-medium text-slate-500 bg-slate-100 rounded-full px-1.5 py-0.5">{rows.length}</span>
        </h3>
      </div>
      {loading ? (
        <p className="text-sm text-slate-400 text-center py-8">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-8">No bills for this vendor.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b border-slate-100 text-slate-500 text-[11px] uppercase tracking-wide"><tr className="text-left">
              <th className="px-4 py-2.5 font-semibold">SRA No</th>
              <th className="px-3 py-2.5 font-semibold">Bill No</th>
              <th className="px-3 py-2.5 font-semibold">Bill Date</th>
              <th className="px-3 py-2.5 font-semibold text-right">Total</th>
              <th className="px-3 py-2.5 font-semibold text-right">Paid</th>
              <th className="px-3 py-2.5 font-semibold text-right">Balance</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const items = r.items || [];
                const isOpen = openBill === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr onClick={() => setOpenBill(isOpen ? null : r.id)}
                      className={`border-b border-slate-100 last:border-0 hover:bg-indigo-50/50 cursor-pointer ${!r.converted ? 'opacity-60' : ''}`}>
                      <td className="px-4 py-2.5 font-medium text-slate-800">
                        <span className="inline-block w-3 text-slate-400">{items.length ? (isOpen ? '▾' : '▸') : ''}</span>
                        {r.bill_no}
                        {items.length > 0 && <span className="ml-1.5 text-[10px] text-slate-400">({items.length} item{items.length > 1 ? 's' : ''})</span>}
                      </td>
                      <td className="px-3 py-2.5 text-slate-600">{r.vendor_invoice_no || '—'}</td>
                      <td className="px-3 py-2.5 text-slate-500 tabular-nums">{r.bill_date ? formatDate(r.bill_date) : '—'}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{fmtINRfull(r.total_amount)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700">{fmtINRfull(r.amount_paid)}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${Number(r.balance_due) > 0 ? 'text-orange-700' : 'text-slate-400'}`}>{fmtINRfull(r.balance_due)}</td>
                      <td className="px-4 py-2.5 text-slate-600">
                        {r.status || '—'}
                        {!r.converted && (
                          <span className="ml-1.5 inline-block text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-0.5 whitespace-nowrap"
                            title="Zoho's own record — not yet matched to a real bill in the ledger. Counted in Paid/Balance below (it's real Zoho data), but excluded from Total (which ties to Tally).">
                            pending Zoho match
                          </span>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-slate-50/70 border-b border-slate-100">
                        <td colSpan={7} className="px-4 sm:px-5 py-2.5">
                          {items.length === 0 ? (
                            <span className="text-xs text-slate-400">No item details for this bill.</span>
                          ) : (
                            <div className="max-w-xl">
                              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Items bought</div>
                              <div className="overflow-x-auto">
                                <table className="w-full text-xs">
                                  <tbody>
                                    {items.map((it, i) => (
                                      <tr key={i} className="border-b border-slate-100 last:border-0">
                                        <td className="py-1 pr-3 text-slate-700">{it.product || '—'}</td>
                                        <td className="py-1 px-3 text-right tabular-nums text-slate-500 whitespace-nowrap">{it.qty != null ? Number(it.qty).toLocaleString('en-IN') : '—'}</td>
                                        <td className="py-1 pl-3 text-right tabular-nums text-slate-500 whitespace-nowrap">{it.noa != null ? `₹${it.noa}` : ''}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold text-slate-800">
                <td className="px-4 py-2.5" colSpan={3}>
                  Total · {convertedRows.length} bill(s) tally-matched
                  {pendingRows.length > 0 && (
                    <span className="block font-normal text-[11px] text-amber-700 mt-0.5">
                      Paid / Balance also include {pendingRows.length} pending Zoho record{pendingRows.length > 1 ? 's' : ''} not yet in the ledger
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtINRfull(tot.total)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700">{fmtINRfull(tot.paid)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-orange-700">{fmtINRfull(tot.balance)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
          {/* Ledger-style summary, like Tally's Opening / Current / Closing.
              Deliberately mixed-source (see `tot` above): the Cr side (Total)
              ties to Tally — converted rows only. The Dr side (Paid) and
              Closing Balance sum EVERY Zoho row, converted or still pending
              — they're meant to reflect what Zoho itself has recorded for
              this vendor, not only what has already made it into a real ERP
              bill, so Dr and Cr can legitimately not net to zero when
              pending rows exist. */}
          <div className="flex justify-end px-4 sm:px-5 py-3 border-t border-slate-100 bg-slate-50/50">
            <div className="text-sm space-y-1 min-w-[320px]">
              <div className="flex justify-between gap-4 sm:gap-5">
                <span className="text-slate-500">Opening Balance <span className="text-[10px] text-slate-400">(not tracked in Zoho)</span></span>
                <span className="tabular-nums text-slate-500">{'₹'}0.00</span>
              </div>
              <div className="flex justify-between gap-4 sm:gap-5">
                <span className="text-slate-500">Current Total</span>
                <span className="tabular-nums">{fmtINRfull(tot.paid)} <span className="text-slate-400">Dr</span> · {fmtINRfull(tot.total)} <span className="text-slate-400">Cr</span></span>
              </div>
              <div className="flex justify-between gap-4 sm:gap-5 border-t border-slate-200 pt-1">
                <span className="font-semibold text-slate-800">Closing Balance</span>
                <span className={`tabular-nums font-bold ${tot.balance > 0 ? 'text-orange-700' : 'text-emerald-700'}`}>{fmtINRfull(tot.balance)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── KEY-METRICS records drill (like the Sales dashboard's records modal).
// Opens in-page from a tile; fetches flat records for the metric and renders a
// generic columns/rows table with a total, Excel export and bill hyperlinks.
// Searchable multi-select dropdown for the in-drill filters (Vendor / Item).
// A compact button opens a panel with a search box + a checkbox list, so a
// long vendor/item list stays usable instead of spilling dozens of chips.
function MultiSelectDropdown({ label, options, sel, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  if (!options.length) return null;
  const needle = q.trim().toLowerCase();
  const filtered = needle ? options.filter(o => o.toLowerCase().includes(needle)) : options;
  const toggle = (o) => onChange(sel.includes(o) ? sel.filter(x => x !== o) : [...sel, o]);
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(o => !o)}
        className={`${CTRL_H} inline-flex items-center gap-1.5 px-3 rounded-lg text-xs font-medium border transition ${sel.length
          ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
          : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
        {label}{sel.length ? ` (${sel.length})` : ''}
        <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {/* Popover is sized to its CONTENT, not a fixed 256px. At w-64 the
          checkbox and padding left ~208px for the name, so "3F Industries
          Limited-West Godavari" rendered as "3F Industries Limited-West G…" —
          and a vendor filter you cannot read the vendor in is not a filter. */}
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-max min-w-[16rem] max-w-[min(28rem,90vw)] bg-white border border-slate-200 rounded-lg shadow-lg">
          <div className="p-2 border-b border-slate-100">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className="w-full px-2 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-indigo-400" />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-xs text-slate-400">No matches</p>
            ) : filtered.map(o => (
              <button key={o} type="button" onClick={() => toggle(o)}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-sm hover:bg-slate-50">
                <span className={`flex items-center justify-center w-4 h-4 rounded border shrink-0 ${sel.includes(o)
                  ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-slate-300'}`}>
                  {sel.includes(o) && <Check size={11} />}
                </span>
                {/* Wrap rather than clip: a hover tooltip is no use on a
                    touch screen, and these names differ at the END
                    ("- North" vs "- North - TP"). */}
                <span className="text-slate-700 leading-snug break-words" title={o}>{o}</span>
              </button>
            ))}
          </div>
          {sel.length > 0 && (
            <div className="p-2 border-t border-slate-100">
              <button type="button" onClick={() => onChange([])}
                className="text-xs text-indigo-600 hover:underline">Clear {label.toLowerCase()} ({sel.length})</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Searchable vendor picker for the Vendor-details table filter. Type to filter
// the table live (substring, as before) AND get a dropdown of matching vendor
// names — click one to jump straight to that vendor, or "All Vendors" to reset.
function VendorCombobox({ value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const needle = value.trim().toLowerCase();
  const matches = needle ? options.filter(o => o.toLowerCase().includes(needle)) : options;
  return (
    <div className="relative" ref={ref}>
      <div className="relative">
        <input value={value}
          onChange={(e) => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="Search vendor…"
          className={`${CTRL_FIELD} pl-3 pr-8 min-w-[220px] focus:outline-none focus:ring-1 focus:ring-indigo-400`} />
        {value ? (
          <button type="button" onClick={() => { onChange(''); setOpen(false); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" aria-label="Clear"><X size={14} /></button>
        ) : (
          <ChevronDown size={14} className={`absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none transition-transform ${open ? 'rotate-180' : ''}`} />
        )}
      </div>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-max min-w-[18rem] max-w-[min(28rem,90vw)] bg-white border border-slate-200 rounded-lg shadow-lg max-h-64 overflow-y-auto py-1">
          {value && (
            <button type="button" onClick={() => { onChange(''); setOpen(false); }}
              className="w-full text-left px-3 py-1.5 text-sm font-medium text-indigo-600 hover:bg-slate-50">All Vendors</button>
          )}
          {matches.length === 0 ? (
            <p className="px-3 py-2 text-xs text-slate-400">No matches</p>
          ) : matches.slice(0, 200).map(o => (
            <button key={o} type="button" onClick={() => { onChange(o); setOpen(false); }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-sm hover:bg-slate-50">
              <span className="text-slate-700 leading-snug break-words" title={o}>{o}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Quantity pivot cell — units can't be summed together, so a group's quantity
// is one figure PER unit. Rendered as right-aligned wrapping chips (capped, with
// the full list on hover) instead of a run-on "a · b · c · …" line.
function QtyCell({ uoms }) {
  const entries = Object.entries(uoms || {}).filter(([, q]) => q).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <span className="text-slate-400">—</span>;
  const CAP = 8;
  const shown = entries.slice(0, CAP);
  const rest = entries.length - CAP;
  const full = entries.map(([u, q]) => `${fmtQty(q)} ${u}`).join(' · ');
  return (
    <div className="flex flex-wrap justify-end gap-1 max-w-md ml-auto" title={full}>
      {shown.map(([u, q]) => (
        <span key={u} className="inline-flex items-baseline gap-1 px-1.5 py-0.5 rounded bg-amber-50 text-amber-800">
          <span className="font-semibold tabular-nums text-[11px]">{fmtQty(q)}</span>
          <span className="text-[10px] uppercase tracking-wide text-amber-600">{u}</span>
        </span>
      ))}
      {rest > 0 && <span className="self-center text-[11px] text-slate-400">+{rest} more</span>}
    </div>
  );
}

function RecordsDrill({ kind, title, subtitle, summary, companyId, vendorId, productId,
                        includeTransfers, from, to, account }) {
  const navigate = useNavigate();
  const { canView } = usePermissions();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [pivot, setPivot] = useState('list');       // list | month | vendor | item
  const [vendorSel, setVendorSel] = useState([]);   // selected vendor names ([] = all)
  const [itemSel, setItemSel] = useState([]);       // selected item names ([] = all)
  const [search, setSearch] = useState('');         // free-text across all columns
  const PAGE = 15;                                  // page size, like the Bills list

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    setPage(1); setPivot('list'); setVendorSel([]); setItemSel([]); setSearch('');
    const qp = new URLSearchParams();
    qp.set('type', kind);
    if (account) qp.set('account', account);
    if (companyId) qp.set('company', companyId);
    if (vendorId) qp.set('vendor', vendorId);
    if (productId) qp.set('product', productId);
    if (includeTransfers) qp.set('include_transfers', '1');
    // Outstanding is a live snapshot; the others follow the dashboard window.
    if (kind !== 'outstanding') { qp.set('period', 'custom'); if (from) qp.set('from', from); if (to) qp.set('to', to); }
    apiClient.get(`/api/purchase/dashboard/records/?${qp.toString()}`)
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(e => { if (!cancelled) setError(e.response?.data?.detail || 'Failed to load records.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [kind, account, companyId, vendorId, productId, includeTransfers, from, to]);

  const cols = data?.columns || [];
  const allRows = data?.rows || [];
  const moneyKey = cols.find(c => c.money)?.key || null;
  const hasItem = cols.some(c => c.key === 'item');
  const hasQty = cols.some(c => c.key === 'qty');
  const num = (v) => Number(String(v ?? '0').replace(/,/g, '')) || 0;

  const vendorOptions = useMemo(() => [...new Set(allRows.map(r => r.vendor).filter(Boolean))].sort(), [allRows]);
  const itemOptions = useMemo(() => hasItem ? [...new Set(allRows.map(r => itemDisplay(r.item)).filter(Boolean))].sort() : [], [allRows, hasItem]);

  // Apply the in-drill filters: vendor + item multi-selects and a free-text
  // search across every column (payment ref, bill no, vendor, date, amount…).
  const rows = useMemo(() => {
    let rs = allRows;
    if (vendorSel.length) rs = rs.filter(r => vendorSel.includes(r.vendor));
    if (itemSel.length) rs = rs.filter(r => itemSel.includes(itemDisplay(r.item)));
    const q = search.trim().toLowerCase();
    if (q) rs = rs.filter(r => cols.some(c => String(r[c.key] ?? '').toLowerCase().includes(q)));
    return rs;
  }, [allRows, vendorSel, itemSel, search, cols]);

  // Pivot aggregation. Money kinds sum the money column; quantity sums qty per
  // UOM (units can't be added across).
  const pivotRows = useMemo(() => {
    if (pivot === 'list') return null;
    const keyOf = pivot === 'month' ? (r => (r.date || '').slice(0, 7))
      : pivot === 'vendor' ? (r => r.vendor || '—')
      : (r => itemDisplay(r.item));
    const map = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      let g = map.get(k);
      if (!g) { g = { key: k, count: 0, total: 0, uoms: {} }; map.set(k, g); }
      g.count += 1;
      if (moneyKey) g.total += num(r[moneyKey]);
      // Per-bill rows carry a `uoms` array (a bill can span several units);
      // older per-line rows carry a single uom/qty. Support both.
      if (Array.isArray(r.uoms)) {
        for (const p of r.uoms) { const u = normUom(p.uom); if (u) g.uoms[u] = (g.uoms[u] || 0) + num(p.qty); }
      } else if (hasQty) { const u = normUom(r.uom); if (u) g.uoms[u] = (g.uoms[u] || 0) + num(r.qty); }
    }
    const arr = [...map.values()];
    if (pivot === 'month') arr.sort((a, b) => String(b.key).localeCompare(String(a.key)));
    else arr.sort((a, b) => moneyKey ? b.total - a.total : b.count - a.count);
    return arr;
  }, [rows, pivot, moneyKey, hasQty]);  // eslint-disable-line

  // QUANTITY "By Month" is shown as a sales-style ITEM x MONTH pivot (items down
  // the rows, one column per month, Total at the end) — the same layout as Sales
  // Analytics' Quantity Dispatched — instead of one row per month. Only for a
  // quantity drill (money drills keep the month -> total table). A row is keyed by
  // item + UOM, since units can't be summed together (so a product sold in two
  // units shows as two rows, exactly like sales).
  const isQtyMonth = pivot === 'month' && hasQty && !moneyKey;
  const monthQtyPivot = useMemo(() => {
    if (!isQtyMonth) return null;
    const monthsSet = new Set();
    const m = new Map();
    for (const r of rows) {
      const mon = (r.date || '').slice(0, 7);
      if (!mon) continue;
      monthsSet.add(mon);
      // Per-bill rows carry a `uoms` array; older per-line rows a single uom/qty.
      const parts = Array.isArray(r.uoms)
        ? r.uoms.map(p => [normUom(p.uom), num(p.qty)])
        : [[normUom(r.uom), num(r.qty)]];
      const item = itemDisplay(r.item);
      for (const [u, q] of parts) {
        if (!u || !q) continue;
        const k = `${item}||${u}`;
        let e = m.get(k);
        if (!e) { e = { product: item, uom: u, byMonth: {}, total: 0 }; m.set(k, e); }
        e.byMonth[mon] = (e.byMonth[mon] || 0) + q;
        e.total += q;
      }
    }
    return { months: [...monthsSet].sort(), rows: [...m.values()].sort((a, b) => b.total - a.total) };
  }, [isQtyMonth, rows]);  // eslint-disable-line

  const isPivot = pivot !== 'list';
  // Item x month pivot paginates on ITEM rows; the other pivots on their groups.
  const pivotView = isQtyMonth ? (monthQtyPivot?.rows || []) : (pivotRows || []);
  const viewLen = isPivot ? pivotView.length : rows.length;
  const totalPages = Math.max(1, Math.ceil(viewLen / PAGE));
  const cp = Math.min(page, totalPages);
  const pageList = (isPivot ? pivotView : rows).slice((cp - 1) * PAGE, cp * PAGE);
  const filteredTotal = moneyKey ? rows.reduce((s, r) => s + num(r[moneyKey]), 0) : null;
  // ← / → page this drill (only when it has more than one page).
  usePagerKeys({
    enabled: totalPages > 1,
    onPrev: () => setPage(p => Math.max(1, Math.min(p, totalPages) - 1)),
    onNext: () => setPage(p => Math.min(totalPages, p + 1)),
  });

  const pivots = ['list', 'month', ...(hasItem ? ['item'] : []), 'vendor'];
  const pivotName = { list: 'Records', month: 'By Month', vendor: 'By Vendor', item: 'By Item' };
  const pivotLabel = pivot === 'month' ? 'Month' : pivot === 'vendor' ? 'Vendor' : 'Item';
  const anyFilter = vendorSel.length + itemSel.length + (search.trim() ? 1 : 0);
  const monthLabel = (ym) => { const [y, m] = (ym || '').split('-'); const mi = parseInt(m, 10) - 1; return (mi >= 0 && mi < 12) ? `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][mi]} ${y}` : (ym || '—'); };
  const uomStr = (uoms) => Object.entries(uoms).filter(([, q]) => q).map(([u, q]) => `${fmtQty(q)} ${u}`.trim()).join(' · ') || '—';

  const cell = (row, c) => {
    const v = row[c.key];
    if (c.link === 'bill') {
      // Which field holds the bill id — defaults to the row id (bills/payments
      // drills), but a payment row links to the bill it settled via `linkId`.
      const bid = row[c.linkId || 'id'];
      if (bid) return <button type="button" onClick={() => navigate(`/purchase/bills/${bid}`, { state: { backTo: backHere() } })}
        className="text-violet-700 hover:underline font-medium">{v || '—'}</button>;
    }
    if (c.link === 'payment') {
      const pid = row[c.linkId || 'id'];
      if (pid) {
        return (
          <button type="button"
            onClick={() => navigate(`/purchase/payments-made/${pid}`, { state: { backTo: backHere() } })}
            className="text-violet-700 hover:underline font-medium">{v || '—'}</button>
        );
      }
    }
    if (c.link === 'note') {
      // Purchase-side debit/credit notes. One model holds all four
      // (note_type x side) cases, so the detail screen is the shared
      // /sales/debit-notes/<id> — there is no purchase-side equivalent, and
      // vendor-credits is a DIFFERENT model entirely.
      //
      // That route is gated on the Sales Invoice module, so the link is only
      // offered to someone who can actually open it. Rendering it regardless
      // would walk a purchase-only role into a permission wall from a screen
      // they are entitled to be on.
      const nid = row[c.linkId || 'id'];
      if (nid && canView('Sales Invoice')) {
        return (
          <button type="button"
            onClick={() => navigate(`/sales/debit-notes/${nid}`, { state: { backTo: backHere() } })}
            className="text-violet-700 hover:underline font-medium">{v || '—'}</button>
        );
      }
    }
    if (c.money) return fmtINRfull(v);
    return v === null || v === undefined || v === '' ? '—' : String(v);
  };

  const exportRows = () => {
    if (isPivot) {
      if (isQtyMonth) {
        if (!monthQtyPivot?.rows?.length) return;
        const months = monthQtyPivot.months;
        const data2 = monthQtyPivot.rows.map(r => {
          const o = { item: `${r.product}${r.uom ? ` (${r.uom})` : ''}` };
          for (const mon of months) o[mon] = r.byMonth[mon] ? Number(r.byMonth[mon].toFixed(3)) : '';
          o.total = Number(r.total.toFixed(3));
          return o;
        });
        const cfg = [{ field: 'item', header: 'Item' },
          ...months.map(mon => ({ field: mon, header: monthLabel(mon) })),
          { field: 'total', header: 'Total' }];
        exportToExcel(data2, cfg, `purchase-${kind}-by-item-month`, 'Sheet1');
        toast.success('Exported!');
        return;
      }
      if (!pivotRows?.length) return;
      const data2 = pivotRows.map(g => moneyKey
        ? { group: pivot === 'month' ? monthLabel(g.key) : g.key, count: g.count, total: g.total.toFixed(2) }
        : { group: pivot === 'month' ? monthLabel(g.key) : g.key, count: g.count, qty: uomStr(g.uoms) });
      const cfg = moneyKey
        ? [{ field: 'group', header: pivotLabel }, { field: 'count', header: 'Records' }, { field: 'total', header: 'Total' }]
        : [{ field: 'group', header: pivotLabel }, { field: 'count', header: 'Records' }, { field: 'qty', header: 'Qty' }];
      exportToExcel(data2, cfg, `purchase-${kind}-${pivot}`, 'Sheet1');
    } else {
      if (!rows.length) return;
      exportToExcel(rows, cols.map(c => ({ field: c.key, header: c.label })), `purchase-${kind}`, 'Sheet1');
    }
    toast.success('Exported!');
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-slate-100">
        <div className="min-w-0">
          <p className="text-sm sm:text-base font-semibold text-slate-800">{title}</p>
          <p className="text-xs text-slate-500">
            {viewLen.toLocaleString('en-IN')} {isPivot ? (isQtyMonth ? 'item(s)' : `${pivotLabel.toLowerCase()} group(s)`) : 'record(s)'}
            {subtitle ? ` · ${subtitle}` : ''}
            {filteredTotal != null ? <> · Total <span className="font-semibold text-slate-700 tabular-nums">{fmtINRfull(filteredTotal)}</span></> : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportRows} disabled={!rows.length}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
            <Download size={14} /> Excel
          </button>
        </div>
      </div>

      {summary && summary.length > 0 && (
        <div className="px-4 sm:px-5 py-2.5 border-b border-slate-100 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] bg-slate-50/60">
          {summary.map((s, i) => (
            <span key={i} className="text-slate-500">{s.label} <span className="font-semibold text-slate-700 tabular-nums">{s.value}</span></span>
          ))}
        </div>
      )}

      {/* Pivots (List / By Month / By Vendor / By Item) + searchable filter
          dropdowns, like the Sales drill. */}
      <div className="px-4 sm:px-5 pt-3 pb-1 flex flex-wrap items-center gap-1.5">
        {pivots.map(pv => (
          <button key={pv} type="button" onClick={() => { setPivot(pv); setPage(1); }}
            className={`px-3 py-1 rounded-lg text-xs font-medium border transition ${pivot === pv
              ? 'bg-indigo-600 text-white border-indigo-600'
              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
            {pivotName[pv]}
          </button>
        ))}
        <div className="flex flex-wrap items-center gap-1.5 ml-auto">
          {/* Free-text search across every column — like the Bills list. */}
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search…"
              className="pl-8 pr-2 py-1 rounded-lg border border-slate-200 text-xs w-36 sm:w-44 focus:outline-none focus:ring-2 focus:ring-indigo-200" />
          </div>
          {vendorOptions.length > 0 && <MultiSelectDropdown label="Vendor" options={vendorOptions} sel={vendorSel}
            onChange={(v) => { setVendorSel(v); setPage(1); }} />}
          {hasItem && itemOptions.length > 0 && <MultiSelectDropdown label="Item" options={itemOptions} sel={itemSel}
            onChange={(v) => { setItemSel(v); setPage(1); }} />}
          {anyFilter > 0 && (
            <button onClick={() => { setVendorSel([]); setItemSel([]); setSearch(''); setPage(1); }}
              className="text-xs text-indigo-600 hover:underline">Clear</button>
          )}
        </div>
      </div>

      {loading && <div className="flex items-center justify-center py-12 text-slate-500"><Loader2 className="animate-spin mr-2" size={18} /> Loading…</div>}
      {error && <p className="text-sm text-rose-600 text-center py-8">{error}</p>}
      {!loading && !error && (
        viewLen === 0 ? (
          <p className="text-sm text-slate-400 text-center py-10">No records in this window.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              {isPivot ? (
                isQtyMonth ? (
                  /* Sales-style ITEM x MONTH x Total pivot (Quantity Dispatched layout). */
                  <table className="w-full text-xs sm:text-sm">
                    <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b border-slate-100 text-slate-500 text-[11px] uppercase tracking-wide">
                      <tr>
                        <th className="px-3 py-2 text-left sticky left-0 bg-slate-50 z-10">Item</th>
                        {monthQtyPivot.months.map(mon => (
                          <th key={mon} className="px-3 py-2 text-right whitespace-nowrap">{monthLabel(mon)}</th>
                        ))}
                        <th className="px-3 py-2 text-right whitespace-nowrap">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageList.map((r, i) => (
                        <tr key={i} className="border-b last:border-b-0 hover:bg-indigo-50/40">
                          <td className="px-3 py-2 text-slate-700 sticky left-0 bg-white whitespace-nowrap max-w-[45vw] sm:max-w-none truncate" title={r.product}>
                            {r.product}{r.uom ? <span className="text-slate-400"> ({r.uom})</span> : ''}
                          </td>
                          {monthQtyPivot.months.map(mon => (
                            <td key={mon} className="px-3 py-2 text-right tabular-nums text-slate-600">{r.byMonth[mon] ? fmtQty(r.byMonth[mon]) : '—'}</td>
                          ))}
                          <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-800">{fmtQty(r.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                <table className="w-full text-xs sm:text-sm">
                  <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b border-slate-100 text-slate-500 text-[11px] uppercase tracking-wide">
                    <tr>
                      <th className="px-3 py-2 text-left">{pivotLabel}</th>
                      <th className="px-3 py-2 text-right">Records</th>
                      <th className="px-3 py-2 text-right">{moneyKey ? 'Total' : 'Qty'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageList.map((g, i) => (
                      <tr key={i} className="border-b last:border-b-0 hover:bg-primary-50/40 transition-colors">
                        <td className="px-3 py-2 text-slate-700">{pivot === 'month' ? monthLabel(g.key) : g.key}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-500">{g.count.toLocaleString('en-IN')}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium text-slate-800">{moneyKey ? fmtINRfull(g.total) : <QtyCell uoms={g.uoms} />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                )
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs sm:text-sm">
                    <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b border-slate-100 text-slate-500 text-[11px] uppercase tracking-wide">
                      <tr>{cols.map(c => (
                        <th key={c.key} className={`px-3 py-2 ${c.align === 'right' ? 'text-right' : 'text-left'} whitespace-nowrap`}>{c.label}</th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {pageList.map((row, i) => (
                        <tr key={row.id ? `${row.id}-${i}` : i} className="border-b last:border-b-0 hover:bg-primary-50/40 transition-colors">
                          {cols.map(c => (
                            <td key={c.key} className={`px-3 py-2 ${c.align === 'right' ? 'text-right tabular-nums' : 'text-left'} ${c.key === 'item' || c.key === 'vendor' ? '' : 'whitespace-nowrap'} text-slate-700`}>
                              {cell(row, c)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 text-xs text-slate-500">
                <span>Showing {(cp - 1) * PAGE + 1}–{Math.min(cp * PAGE, viewLen)} of {viewLen.toLocaleString('en-IN')}</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => setPage(cp - 1)} disabled={cp <= 1}
                    className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    aria-label="Previous page"><ChevronLeft size={15} /></button>
                  {pageWindow(cp, totalPages).map((p, idx) => (p === '…'
                    ? <span key={`e${idx}`} className="px-1.5 text-slate-400">…</span>
                    : <button key={p} onClick={() => setPage(p)}
                        className={`min-w-[30px] px-2 py-1 rounded-lg border text-xs font-medium transition ${p === cp ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{p}</button>
                  ))}
                  <button onClick={() => setPage(cp + 1)} disabled={cp >= totalPages}
                    className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    aria-label="Next page"><ChevronRight size={15} /></button>
                </div>
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}

// ── Aging Buckets Panel ───────────────────────────────────────────────────────
// Bluish-violet (indigo → violet) age gradient, matching the sales AGE_TONE:
// light indigo for recent buckets, deepening to violet for the oldest.
const AGING_COLORS = {
  emerald: { bar: 'bg-indigo-300', dot: 'bg-indigo-300', text: 'text-indigo-700', light: 'bg-indigo-50',  border: 'border-indigo-100', sub: 'bg-indigo-50/60',  divider: 'divide-indigo-100/60' },
  sky:     { bar: 'bg-indigo-400', dot: 'bg-indigo-400', text: 'text-indigo-700', light: 'bg-indigo-50',  border: 'border-indigo-100', sub: 'bg-indigo-50/60',  divider: 'divide-indigo-100/60' },
  amber:   { bar: 'bg-indigo-500', dot: 'bg-indigo-500', text: 'text-indigo-700', light: 'bg-indigo-50',  border: 'border-indigo-100', sub: 'bg-indigo-50/60',  divider: 'divide-indigo-100/60' },
  orange:  { bar: 'bg-violet-600', dot: 'bg-violet-600', text: 'text-violet-700', light: 'bg-violet-50',  border: 'border-violet-100', sub: 'bg-violet-50/60',  divider: 'divide-violet-100/60' },
  rose:    { bar: 'bg-violet-800', dot: 'bg-violet-800', text: 'text-violet-800', light: 'bg-violet-100', border: 'border-violet-200', sub: 'bg-violet-100/60', divider: 'divide-violet-200/60' },
};

// Right-side slide-over — shows a drill (aging buckets, vendor detail) in a card
// beside the page instead of swapping the whole page or navigating away.
// Backdrop click and Escape close it.
function RightDrawer({ open, onClose, title, subtitle, children, wide = false }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // Lock page scroll while the drawer is up.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label={title}
        className={`absolute right-0 top-0 h-full w-full ${wide ? 'lg:w-[min(1060px,94vw)]' : 'max-w-3xl'} bg-slate-50 shadow-2xl flex flex-col`}>
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200 bg-white shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-800 truncate">{title}</h2>
            {subtitle && <p className="text-[11px] text-slate-500 truncate">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 shrink-0"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">{children}</div>
      </div>
    </div>
  );
}

function AgingBucketsPanel({ companyId, vendorId, includeTransfers }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null); // key of open bucket
  const [panelOpen, setPanelOpen] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    setLoading(true);
    const qp = new URLSearchParams({ type: 'aging_buckets' });
    if (companyId) qp.set('company', companyId);
    if (vendorId) qp.set('vendor', vendorId);
    if (includeTransfers) qp.set('include_transfers', '1');
    apiClient.get(`/api/purchase/dashboard/records/?${qp}`)
      .then(r => setData(r.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [companyId, vendorId, includeTransfers]);

  const toggle = (key) => setExpanded(k => k === key ? null : key);

  const AGE_BUCKET_KEYS = ['0_30', '31_60', '61_90', '91_180', '180p'];
  const billsHref = (b) => {
    // Filter the Bills page to the unpaid bills behind this panel. company +
    // st=Unpaid are keys it honours; `age` (one of the five bucket keys) narrows
    // to this bucket's bill_date window on the server — the same windows this
    // panel's aging_buckets endpoint uses — so the list ties the bucket count.
    const p = new URLSearchParams();
    if (companyId) p.set('company', companyId);
    p.set('st', 'Unpaid');
    if (b && AGE_BUCKET_KEYS.includes(b.key)) p.set('age', b.key);
    return `/purchase/bills?${p}`;
  };

  if (loading) return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 mb-3 flex items-center gap-3 text-slate-400">
      <Loader2 size={16} className="animate-spin" /> Loading aging data…
    </div>
  );
  if (!data || !data.buckets?.length) return null;

  const grand = Number(data.total || 0);
  const urgent = data.buckets.filter(b => b.key === '91_180' || b.key === '180p')
    .reduce((s, b) => s + Number(b.total || 0), 0);
  const urgentPct = grand > 0 ? Math.round(urgent / grand * 100) : 0;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden mb-3">
      {/* Header — collapsible. Title, the one-line total, and the 91+-day risk as
          a chip so the headline worry reads at a glance. */}
      <div role="button" tabIndex={0} aria-expanded={panelOpen}
        onClick={() => setPanelOpen(o => !o)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPanelOpen(o => !o); } }}
        className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-slate-100 cursor-pointer select-none hover:bg-slate-50/60 transition">
        <div className="flex items-center gap-2 min-w-0">
          <span className="p-1.5 rounded-lg bg-indigo-50 text-indigo-600 shrink-0"><AlertCircle size={15} /></span>
          <div className="flex items-baseline gap-2 flex-wrap min-w-0">
            <h3 className="text-sm font-semibold text-slate-800">Outstanding by Age</h3>
            <span className="text-[11px] text-slate-400 tabular-nums">{Number(data.bill_count).toLocaleString('en-IN')} bills · {fmtINRfull(grand)}</span>
            {urgentPct > 0 && (
              <span className="text-[10px] font-semibold text-violet-700 bg-violet-50 border border-violet-200 rounded-full px-1.5 py-0.5">
                {urgentPct}% is 91+ days
              </span>
            )}
          </div>
        </div>
        <ChevronDown size={15} className={`text-slate-400 transition-transform shrink-0 ${panelOpen ? 'rotate-180' : ''}`} />
      </div>

      {panelOpen && (
        <div>
          {/* Hero — one segmented bar carries the whole distribution; clicking a
              segment opens that bucket below. No separate legend: each row's
              severity rail is the key. */}
          <div className="px-4 pt-3">
            <div className="flex h-6 overflow-hidden rounded-lg gap-px bg-slate-100">
              {data.buckets.map(b => {
                const c = AGING_COLORS[b.color] || AGING_COLORS.emerald;
                return b.pct > 0 ? (
                  <button key={b.key} type="button"
                    className={`${c.bar} flex items-center justify-center text-[10px] font-bold text-white hover:opacity-85 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white transition`}
                    style={{ width: `${b.pct}%` }}
                    onClick={() => toggle(b.key)}
                    title={`${b.label}: ${b.pct}% · ${fmtINRfull(b.total)}`}>
                    {b.pct >= 8 ? `${b.pct}%` : ''}
                  </button>
                ) : null;
              })}
            </div>
          </div>

          {/* Bucket list — a dense row per bucket, each with a severity rail in
              its aging colour so the eye reads risk deepening down the list. The
              Share column is gone: the hero bar above already shows it. */}
          <div className="px-4 pt-3 pb-3 overflow-x-auto">
           <div className="min-w-[560px]">
            <div className="hidden sm:grid grid-cols-[1.7fr_repeat(4,1fr)] gap-2 px-2 pb-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
              <span>Bucket</span>
              <span className="text-right">Bills</span>
              <span className="text-right">Outstanding</span>
              <span className="text-right">Share</span>
              <span className="text-right">Oldest</span>
            </div>
            <div className="rounded-lg border border-slate-100 divide-y divide-slate-100 overflow-hidden">
              {data.buckets.map(b => {
                const c = AGING_COLORS[b.color] || AGING_COLORS.emerald;
                const isOpen = expanded === b.key;
                const isUrgent = b.key === '180p';
                const empty = !b.count;
                const shown = (b.preview || []).length;
                return (
                  <Fragment key={b.key}>
                    <div role="button" tabIndex={0}
                      onClick={() => toggle(b.key)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(b.key); } }}
                      className={`relative grid grid-cols-[1.7fr_repeat(4,1fr)] items-center gap-2 pl-4 pr-2 py-1.5 cursor-pointer select-none text-xs transition
                        ${isOpen ? c.light : (isUrgent ? 'hover:bg-violet-50/60' : 'hover:bg-slate-50')} ${empty ? 'opacity-55' : ''}`}>
                      {/* severity rail */}
                      <span className={`absolute left-0 top-0 bottom-0 w-1 ${c.bar}`} aria-hidden="true" />
                      <span className="flex items-center gap-1.5 min-w-0">
                        <ChevronDown size={12} className={`text-slate-300 transition-transform shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
                        <span className={`font-semibold truncate ${isUrgent ? 'text-violet-800' : 'text-slate-700'}`}>{b.label}</span>
                        {isUrgent && !empty && <span className="text-[9px] font-bold text-violet-700 bg-violet-100 rounded px-1 py-0.5 shrink-0">URGENT</span>}
                      </span>
                      <span className={`text-right tabular-nums ${isUrgent ? 'text-violet-800 font-semibold' : 'text-slate-500'}`}>{Number(b.count).toLocaleString('en-IN')}</span>
                      <span className={`text-right tabular-nums font-bold ${isUrgent ? 'text-violet-800' : 'text-slate-800'}`}>{fmtINRfull(b.total)}</span>
                      <span className={`text-right font-semibold ${c.text}`}>{b.pct}%</span>
                      <span className={`text-right text-[11px] tabular-nums ${isUrgent ? 'text-violet-700 font-medium' : 'text-slate-400'}`}>{fmtDate(b.oldest_bill_date) || '—'}</span>
                    </div>

                    {/* Expanded preview — first few bills in the bucket */}
                    {isOpen && !empty && (
                      <div className={`${c.sub} px-4 py-2`}>
                        <div className="rounded-lg bg-white/70 border border-white overflow-hidden divide-y divide-slate-100/80">
                          {(b.preview || []).map(row => (
                            <div key={row.bill_id} className="flex items-center gap-3 px-3 py-1.5 text-[11px]">
                              <span className="text-slate-400 tabular-nums w-[70px] shrink-0">{fmtDate(row.bill_date)}</span>
                              <Link to={`/purchase/bills/${row.bill_id}`} onClick={(e) => e.stopPropagation()}
                                className="text-indigo-600 hover:underline font-medium w-24 shrink-0 truncate">{row.bill_no || '—'}</Link>
                              <span className="text-slate-600 flex-1 min-w-0 truncate">{row.vendor_name}</span>
                              <span className={`font-semibold ${c.text} w-12 text-right shrink-0`}>{row.days}d</span>
                              <span className="tabular-nums font-semibold text-slate-800 w-24 text-right shrink-0">{fmtINRfull(row.outstanding)}</span>
                            </div>
                          ))}
                        </div>
                        {b.count > shown && (
                          <div className="flex justify-end pt-1.5">
                            <button className="text-[11px] text-indigo-600 hover:underline font-medium"
                              onClick={(e) => { e.stopPropagation(); navigate(billsHref(b)); }}>
                              View all {Number(b.count).toLocaleString('en-IN')} bills →
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </Fragment>
                );
              })}

              {/* Total */}
              <div className="grid grid-cols-[1.7fr_repeat(4,1fr)] items-center gap-2 pl-4 pr-2 py-2 bg-slate-50 text-xs font-bold text-slate-800">
                <span>Total</span>
                <span className="text-right tabular-nums">{Number(data.bill_count).toLocaleString('en-IN')}</span>
                <span className="text-right tabular-nums text-slate-900">{fmtINRfull(grand)}</span>
                <span className="text-right">100%</span>
                <span />
              </div>
            </div>
           </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PurchaseDashboard() {
  // Filters live in the URL query string, so they survive a refresh and can be
  // bookmarked / shared. `replace: true` keeps the back button clean.
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const period = searchParams.get('period') || 'month';
  const customFrom = searchParams.get('from') || todayISO();
  const customTo = searchParams.get('to') || todayISO();
  const companyId = searchParams.get('company') || '';
  const warehouseId = searchParams.get('warehouse') || '';
  const vendorId = searchParams.get('vendor') || '';
  const productId = searchParams.get('product') || '';
  // Branch-transfer pill: 3 states via ?transfers=
  //   ''      Purchases      — exclude DC branch transfers (default, matches Tally)
  //   '1'     + Transfers    — purchases PLUS the DC branch transfers
  //   'only'  Transfers      — ONLY the DC branch transfers
  const transfersMode = searchParams.get('transfers') || '';
  const includeTransfers = transfersMode === '1';
  const transfersOnly = transfersMode === 'only';
  // Capture-source toggle: all | tally | scan. Re-scopes every Key Metrics tile
  // to bills from that source (present in Tally vs captured in the ERP). Defaults
  // to 'scan' (ERP) when no ?source= is in the URL; an explicit '' means unscoped.
  const source = searchParams.has('source') ? (searchParams.get('source') || 'all') : 'scan';
  const setFilter = (patch) => setSearchParams((prev) => {
    const p = new URLSearchParams(prev);
    Object.entries(patch).forEach(([k, v]) => { if (v) p.set(k, v); else p.delete(k); });
    return p;
  }, { replace: true });
  // This page has always kept its filter in the address; what it could not do
  // is carry that filter to the Purchase Dashboard or Vendor Insights, because
  // you reach those through the SIDEBAR and a sidebar link is a bare path. The
  // shared hook mirrors the filter into the session so the sibling pages can
  // pick it up. Called for that effect alone -- it does NOT own the state here,
  // setFilter above still does, and nothing on this page links to a sibling.
  usePurchaseFilter();
  const anchor = searchParams.get('anchor') || todayISO();
  // Period + navigator anchor MUST move in a single search-params update.
  // Two sequential setSearchParams calls inside one handler both read the
  // last-committed params, so the second silently drops the first's key —
  // that left `?anchor=<FY token>` with no `period=fy`, the period fell back
  // to 'month', and the month parser choked on the token ("Failed to load").
  // FY seeds a full-year token; every other period resets the navigator.
  const setPeriod = (v) => setFilter({ period: v, anchor: v === 'fy' ? fyTokenFor(new Date()) : '' });
  const setAnchor = (v) => setFilter({ anchor: v });
  const setCustomFrom = (v) => setFilter({ from: v });
  const setCustomTo = (v) => setFilter({ to: v });
  const setWarehouseId = (v) => setFilter({ warehouse: v });
  const setVendorId = (v) => setFilter({ vendor: v });
  const setProductId = (v) => setFilter({ product: v });
  // v is the raw transfers mode: '' (purchases) | '1' (+transfers) | 'only'
  const setTransfersMode = (v) => setFilter({ transfers: v });
  const setSource = (v) => setFilter({ source: v === 'all' ? '' : v });

  const { options: companyOptions } = useLookup('/api/companies/');
  const { raw: warehousesRaw } = useLookup('/api/warehouses/');
  // Scope the vendor dropdown to parties we've actually billed (has_purchases)
  // so the ~2700-vendor master — riddled with cross-company namesakes — doesn't
  // flood the filter with dead duplicates. Company-scoped when one is selected.
  // Goods-vendor filter: expense vendors and transporters are tagged on the
  // vendor master (vendor_type) and excluded here, so the dropdown lists only
  // trade suppliers (item 3). Untagged vendors are still shown.
  const { options: vendorOptions } = useLookup(
    companyId
      ? `/api/vendors/?company=${companyId}&has_purchases=true&slim=1&exclude_vendor_type=EXPENSE,TRANSPORTER`
      : '/api/vendors/?has_purchases=true&slim=1&exclude_vendor_type=EXPENSE,TRANSPORTER',
  );
  // Product filter — server-side search via ProductPicker (no rows prop).
  // The useLookup('/api/products/?slim=1') that used to sit here downloaded
  // the full catalog (5,000+ rows, multiple concurrent page requests) and was
  // the cause of OOM on the 512 MB Render instance.


  // Warehouse options cascade off the selected company.
  const warehouseOptions = (companyId
    ? (warehousesRaw || []).filter((w) => String(w.company ?? w.company_id) === String(companyId))
    : (warehousesRaw || [])
  ).map((w) => ({ value: w.id, label: w.name || w.warehouse_name || w.warehouse_code || w.id }));
  // Switching company also closes any open vendor drill/ledger and returns to
  // the (now company-filtered) list — a single vendor's ledger isn't company-
  // scoped and the vendor may not belong to the new company, so leaving it open
  // looks like "nothing changed". Mirrors Sales, which clears the customer.
  const onCompanyChange = (v) => setFilter({
    company: v, warehouse: '',
    view: '', ledger_vendor: '', ledger_name: '', drill_vendor: '', drill_vendor_id: '',
  });

  // SS Biochem is the default scope on every analytics page. On a fresh landing
  // (no ?company= in the URL yet) pre-select SS once the company list loads; the
  // user can click SS again to see both companies, or pick United Agro — those
  // choices live in the URL and win for the rest of the session. Guarded by a
  // ref so clearing the scope within the session doesn't snap back to SS.
  const didDefaultCompany = useRef(false);
  useEffect(() => {
    if (didDefaultCompany.current) return;
    if (searchParams.has('company')) { didDefaultCompany.current = true; return; }
    const ss = (companyOptions || []).find((c) => /biochem/i.test(c.label));
    if (ss) { didDefaultCompany.current = true; onCompanyChange(String(ss.value)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyOptions]);

  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);   // bump to refetch after a Zoho import
  const [compareOpen, setCompareOpen] = useState(false);   // Tally vs ERP modal
  // In-page drill-downs (like the Sales dashboard): a tile opens a full-page
  // view via ?view=..., not a popup. Outstanding Payables → payables_buckets;
  // Purchase Orders → po_fulfillment.
  const view = searchParams.get('view') || null;
  const payablesOpen = view === 'payables_buckets';
  const poOpen = view === 'po_fulfillment';
  const ledgerOpen = view === 'vendor_ledger';
  const ledgerVendorId = searchParams.get('ledger_vendor') || '';
  const ledgerVendorName = searchParams.get('ledger_name') || '';
  const vendorBillsOpen = view === 'zoho_vendor';           // in-page vendor bills drill
  const drillVendorName = searchParams.get('drill_vendor') || '';
  const drillVendorId = searchParams.get('drill_vendor_id') || '';
  // KEY-METRICS record drill (bills / payments / quantity), like the Sales tiles.
  const recordsOpen = view === 'records';
  const recordsKind = searchParams.get('kind') || '';
  const recordsTitle = searchParams.get('rtitle') || '';
  const recordsAccount = searchParams.get('racct') || '';
  const paidAccountsOpen = view === 'paid_accounts';
  const scopesOpen = view === 'purchase_scopes';
  const freightOpen = view === 'freight';
  const anyView = payablesOpen || poOpen || ledgerOpen || vendorBillsOpen || recordsOpen || paidAccountsOpen || scopesOpen || freightOpen;
  // Opening a tile is idempotent: if the drill it opens is ALREADY showing,
  // ignore the click. A fast double/triple-click on the same tile otherwise
  // re-fires setSearchParams, which re-runs the drill's fetch and can race its
  // own in-flight render — the crash that tripped the "reload" card.
  const openView = (v) => {
    if (view === v) return;
    setSearchParams((prev) => { const p = new URLSearchParams(prev); p.set('view', v); return p; });
  };
  const openRecords = (kind, title, account) => {
    if (view === 'records' && searchParams.get('kind') === kind) return;
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set('view', 'records'); p.set('kind', kind);
      if (title) p.set('rtitle', title); else p.delete('rtitle');
      if (account) p.set('racct', account); else p.delete('racct');
      return p;
    });
  };
  const closeDrill = () => setSearchParams((prev) => {
    const p = new URLSearchParams(prev);
    p.delete('view'); p.delete('ledger_vendor'); p.delete('ledger_name'); p.delete('drill_vendor'); p.delete('drill_vendor_id');
    p.delete('kind'); p.delete('rtitle'); p.delete('racct');
    return p;
  }, { replace: true });
  const openVendorBills = (name, id) => setSearchParams((prev) => {
    const p = new URLSearchParams(prev);
    p.set('view', 'zoho_vendor');
    if (name) p.set('drill_vendor', name); else p.delete('drill_vendor');
    // Pass the mapped ERP vendor id so the bills lookup respects the mapping
    // (raw Zoho name may differ from the master name shown in the row).
    if (id) p.set('drill_vendor_id', String(id)); else p.delete('drill_vendor_id');
    return p;
  });
  const openPayables = () => setPayablesDrawer(true);
  const openPaidAccounts = () => openView('paid_accounts');
  const openScopes = () => openView('purchase_scopes');
  const openFreight = () => openView('freight');
  const closePayables = closeDrill;
  // Vendor ledger opens as an in-page view (like the tiles), keyed in the URL so
  // the browser Back button returns to the dashboard instead of leaving the page.
  const openLedger = (id, name) => setSearchParams((prev) => {
    const p = new URLSearchParams(prev);
    p.set('view', 'vendor_ledger');
    p.set('ledger_vendor', String(id));
    if (name) p.set('ledger_name', name); else p.delete('ledger_name');
    return p;
  });
  const [metricsOpen, setMetricsOpen] = useState(true);   // collapsible KPI grid
  const [raOpen, setRaOpen] = useState(false);            // Returns & Adjustments toggle
  const [gstView, setGstView] = useState('inclgst');       // shared tile toggle: inclgst | exgst
  const [msmeFilter, setMsmeFilter] = useState('all');     // all | msme | non-msme
  // Outstanding payables open as a right-side slide-over (aging buckets), not a
  // full-page view, so the dashboard stays put behind it.
  const [payablesDrawer, setPayablesDrawer] = useState(false);
  // A Vendor-details row opens its summary in the same right-side card (holds
  // the clicked row), instead of swapping the page for the full ledger.
  const [vendorDrawer, setVendorDrawer] = useState(null);
  const [billsPopupOpen, setBillsPopupOpen] = useState(false);

  // Effective window: a picked past month/week (anchor ≠ today) is sent as a
  // custom range so the backend honours it; otherwise the granularity is sent
  // and the backend computes the current window.
  const effRange = effWindow(period, anchor, customFrom, customTo);

  // Carry the current company + period (+ vendor) filter to the Bills page, so a
  // tile opened from a filtered dashboard lands on the SAME slice instead of the
  // full list. The Bills page reads company/period/anchor/cfrom/cto/vend from the
  // URL (its usePeriodFilter mirrors this page's), so we just translate the names
  // (this page's custom range lives on from/to; the Bills page reads cfrom/cto).
  const billsHref = (typeOverride) => {
    const q = new URLSearchParams();
    if (companyId) q.set('company', companyId);
    // The Bills list matches `vend` against the vendor NAME (that is what its
    // dropdown is built from), so sending the id filters every row away.
    const vn = (vendorOptions || []).find((o) => String(o.value) === String(vendorId));
    if (vn) q.set('vend', vn.label);
    if (period && period !== 'all') {
      q.set('period', period);
      if (period === 'custom') {
        if (customFrom) q.set('cfrom', customFrom);
        if (customTo) q.set('cto', customTo);
      } else {
        q.set('anchor', anchor);
      }
    }
    // This page defaults to purchases-only; the Bills list defaults to
    // everything. Without this the drill-through shows MORE bills than the
    // tile that was clicked. A typeOverride ('purchases' / 'expenses') from the
    // Bills tile's toggle wins, so the list opens on the matching tab.
    q.set('type', typeOverride || (includeTransfers ? 'all' : 'purchases'));
    // Carry the active source scope (Only Tally / Only ERP) so the drill-through
    // shows the SAME source the tile counted. Without this, clicking the ERP tile
    // (e.g. 92) opened the full Tally+ERP list (e.g. 183).
    if (source && source !== 'all') q.set('source', source);
    const s = q.toString();
    return s ? `/purchase/bills?${s}` : '/purchase/bills';
  };

  // Open the Purchase-by-Category page carrying the current company + period,
  // like the Bills drill-through (that page reads the same company/period/
  // anchor/cfrom/cto params).
  const byCategoryHref = () => {
    const q = new URLSearchParams();
    if (companyId) q.set('company', companyId);
    if (period && period !== 'all') {
      q.set('period', period);
      if (period === 'custom') {
        if (customFrom) q.set('cfrom', customFrom);
        if (customTo) q.set('cto', customTo);
      } else {
        q.set('anchor', anchor);
      }
    }
    const s = q.toString();
    return s ? `/purchase/by-category?${s}` : '/purchase/by-category';
  };

  const buildParams = () => {
    const p = new URLSearchParams();
    // Always send the RESOLVED window (from/to) for every period, not just
    // custom/past. The backend's _resolve_range reads from/to for month/week/fy
    // too; sending only `period=month` made it fall back to the CURRENT month,
    // so the period picker silently did nothing. Keep `period` for the label,
    // but the explicit window is what actually scopes the whole page.
    p.set('period', period === 'custom' ? 'custom' : period);
    if (effRange.from) p.set('from', effRange.from);
    if (effRange.to) p.set('to', effRange.to);
    if (companyId) p.set('company', companyId);
    if (warehouseId) p.set('warehouse', warehouseId);
    if (vendorId) p.set('vendor', vendorId);
    if (productId) p.set('product', productId);
    if (transfersOnly) p.set('transfers', 'only');
    else if (includeTransfers) p.set('include_transfers', '1');
    if (source && source !== 'all') p.set('source', source);
    if (msmeFilter === 'msme') p.set('msme', 'true');
    else if (msmeFilter === 'non-msme') p.set('msme', 'false');
    return p.toString();
  };

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    apiClient.get(`/api/purchase/dashboard/?${buildParams()}`)
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((err) => { if (!cancelled) setError(err.response?.data?.detail || 'Failed to load dashboard.'); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, anchor, customFrom, customTo, companyId, warehouseId, vendorId, productId, includeTransfers, transfersOnly, source, msmeFilter, reloadTick]);

  const stats = data?.stats;
  const topVendors = data?.top_vendors || [];
  const byCompany = data?.by_company || [];
  const poFulfillment = data?.po_fulfillment || [];
  const vendorBreakdown = data?.vendor_breakdown || [];

  // Vendor details table — searchable + paginated (10/page); click a row to
  // open that vendor's full transaction ledger in-page (mirror of sales customers).
  const [vendorSearch, setVendorSearch] = useState('');
  const [overdueFilter, setOverdueFilter] = useState('');  // '' | 'any' | '30' | '60' | '90'
  const [vendorPage, setVendorPage] = useState(1);
  const [vendOpen, setVendOpen] = useState(true);   // Vendor details collapse/expand
  useEffect(() => { setVendorPage(1); }, [vendorSearch, overdueFilter, data]);
  const VEND_PAGE_SIZE = 10;
  const vendQuery = vendorSearch.trim().toLowerCase();
  const odMin = overdueFilter === 'any' ? 1 : (overdueFilter ? Number(overdueFilter) : 0);
  const vendRows = vendorBreakdown.filter((v) =>
    (!vendQuery || (v.vendor_name || '').toLowerCase().includes(vendQuery))
    && (!odMin || Number(v.overdue_days || 0) >= odMin));
  const vendorNames = useMemo(
    () => [...new Set(vendorBreakdown.map((v) => v.vendor_name).filter(Boolean))].sort(),
    [vendorBreakdown]);
  const vendTot = vendRows.reduce((a, v) => ({
    billed: a.billed + Number(v.billed || 0), paid: a.paid + Number(v.paid || 0),
    // outstanding = signed net closing (Cr positive). payable = only what is
    // actually owed (positive balances). overdue = sum of the overdue column.
    outstanding: a.outstanding + Number(v.outstanding || 0),
    payable: a.payable + Math.max(0, Number(v.outstanding || 0)),
    overdue: a.overdue + Number(v.overdue || 0),
  }), { billed: 0, paid: 0, outstanding: 0, payable: 0, overdue: 0 });
  const vendTotalPages = Math.max(1, Math.ceil(vendRows.length / VEND_PAGE_SIZE));
  const vendSafePage = Math.min(vendorPage, vendTotalPages);
  const vendPageRows = vendRows.slice((vendSafePage - 1) * VEND_PAGE_SIZE, vendSafePage * VEND_PAGE_SIZE);

  // Client-side paginate the per-PO fulfilment table (20/page) so it doesn't
  // become one long scroll — arrows + page numbers like the master lists.
  const PO_PAGE_SIZE = 20;
  const [poPage, setPoPage] = useState(1);
  useEffect(() => { setPoPage(1); }, [data]);  // reset when a new payload loads
  const poTotalPages = Math.max(1, Math.ceil(poFulfillment.length / PO_PAGE_SIZE));
  const poSafePage = Math.min(poPage, poTotalPages);
  const poPageRows = poFulfillment.slice((poSafePage - 1) * PO_PAGE_SIZE, poSafePage * PO_PAGE_SIZE);

  // ← / → page whichever of these two tables is on screen. Both predate the
  // shared DataTable and carry their own pagers, so they need wiring up
  // explicitly; the `enabled` flags keep only one of them listening.
  usePagerKeys({
    enabled: !anyView && vendTotalPages > 1,
    onPrev: () => setVendorPage(p => Math.max(1, Math.min(p, vendTotalPages) - 1)),
    onNext: () => setVendorPage(p => Math.min(vendTotalPages, p + 1)),
  });
  usePagerKeys({
    enabled: poOpen && poTotalPages > 1,
    onPrev: () => setPoPage(p => Math.max(1, Math.min(p, poTotalPages) - 1)),
    onNext: () => setPoPage(p => Math.min(poTotalPages, p + 1)),
  });

  const handleExport = () => {
    if (!stats) { toast.error('Dashboard is still loading.'); return; }
    const periodLabel = data?.period?.label || period;
    const from = data?.period?.from || '', to = data?.period?.to || '';
    const uomList = mergeUoms(stats.quantity_billed?.uom_breakdown)
      .map((b) => `${fmtQty(b.qty)} ${b.uom}`).join(' · ') || '—';
    const section = (title) => ({ metric: title, value: '', extra: '' });
    const blank = { metric: '', value: '', extra: '' };
    const rows = [
      { metric: 'Period', value: periodLabel, extra: `${from} → ${to}` },
      { metric: 'Company', value: companyId ? (companyOptions.find((c) => String(c.value) === String(companyId))?.label || '(filtered)') : 'All Companies', extra: '' },
      { metric: 'Vendor', value: vendorId ? (vendorOptions.find((v) => String(v.value) === String(vendorId))?.label || '(filtered)') : 'All Vendors', extra: '' },
      blank,
      section('KPI'),
      ...(stats.total_purchase ? [{ metric: 'Total Purchase (incl GST — Tally Purchase Register)', value: fmtINRfull(stats.total_purchase.total), extra: `Taxable ${fmtINRfull(stats.total_purchase.taxable)} · Returns ${fmtINRfull(stats.total_purchase.returns)}` }] : []),
      { metric: 'Purchase Requests', value: stats.purchase_requests.count, extra: `Pending ${stats.purchase_requests.pending_count} · Approved ${stats.purchase_requests.approved_count}` },
      { metric: 'Purchase Orders', value: stats.purchase_orders.count, extra: fmtINRfull(stats.purchase_orders.amount) },
      { metric: 'Quantity Billed', value: uomList, extra: `across ${stats.quantity_billed?.bill_count || 0} bill(s)` },
      { metric: 'Bills', value: stats.bills.count, extra: fmtINRfull(stats.bills.amount) },
      { metric: 'Amount Paid', value: '₹0', extra: 'no payment data yet' },
      { metric: 'Outstanding Payables', value: fmtINRfull(stats.outstanding_payables.total), extra: `${stats.outstanding_payables.count} unpaid bill(s)` },
      blank,
      section('Top vendors by PO amount'),
      ...topVendors.map((v, i) => ({ metric: `${i + 1}. ${v.vendor_name}`, value: `${v.po_count} PO(s)`, extra: fmtINRfull(v.amount) })),
    ];
    if (!companyId && byCompany.length > 0) {
      rows.push(blank, section('By company'));
      byCompany.forEach((c) => rows.push({ metric: c.company_name, value: `${c.po_count} PO(s)`, extra: fmtINRfull(c.amount) }));
    }
    if (poFulfillment.length > 0) {
      rows.push(blank, section('PO fulfilment — Ordered / Received / Pending'));
      rows.push({ metric: 'PO No', value: 'Vendor', extra: 'Ordered / Received / Pending' });
      poFulfillment.forEach((r) => rows.push({
        metric: r.po_no, value: r.vendor_name,
        extra: `${fmtQty(r.ordered_qty)} / ${fmtQty(r.received_qty)} / ${fmtQty(r.pending_qty)}`,
      }));
    }
    exportToExcel(rows, [
      { field: 'metric', header: 'Metric' }, { field: 'value', header: 'Value' }, { field: 'extra', header: 'Detail' },
    ], `purchase-dashboard-${String(periodLabel).replace(/\s+/g, '-').toLowerCase()}-${from}-to-${to}`);
    toast.success('Dashboard exported to Excel!');
  };

  // Company quick-switch chips (SS Biochem / United Agro) — one click scopes the
  // whole dashboard to that company; click the active one again to clear. Shown
  // inline beside the title, mirroring the Sales dashboard.
  const companyButtons = (() => {
    const bioCo = companyOptions.find((c) => /biochem/i.test(c.label));
    const uaiCo = companyOptions.find((c) => /united\s*agro/i.test(c.label));
    const quick = [...(bioCo ? [bioCo] : []), ...(uaiCo ? [uaiCo] : [])];
    if (!quick.length) return null;
    // Rendered at every width. These chips ARE the company filter now --
    // the dropdown that used to sit beside the period controls is gone --
    // so hiding them on a phone would leave no way to scope by company.
    const shortName = (label) => (/biochem/i.test(label) ? 'SS Biochem' : /united\s*agro/i.test(label) ? 'United Agro' : label);
    return (
      <div className="flex items-center gap-1.5 shrink-0">
        {quick.map((c) => {
          const active = String(companyId || '') === String(c.value);
          const chip = shortName(c.label);
          return (
            <button key={c.value} type="button" onClick={() => onCompanyChange(active ? '' : c.value)} title={c.label}
              className={`px-2 py-1.5 rounded-lg text-xs font-semibold border transition whitespace-nowrap ${active
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                : 'bg-white text-slate-700 border-slate-200 hover:border-indigo-300 hover:text-indigo-600'}`}>
              {chip}
            </button>
          );
        })}
      </div>
    );
  })();

  // Filter controls — a single full-width row directly under the header, so
  // everything (period + warehouse/vendor/product) sits on one straight line
  // instead of being squeezed beside the title and wrapping. Company chips stay
  // up in the header row. Wraps only on genuinely narrow phones.
  const filterBar = (
    <div className="flex flex-wrap items-center gap-1.5">
      <div className="flex rounded-lg border border-slate-200 overflow-hidden shrink-0">
        {[{ v: 'today', l: 'Today' }, { v: 'week', l: 'Week' }, { v: 'month', l: 'Month' }, { v: 'fy', l: 'FY' }, { v: 'custom', l: 'Custom' }].map((p, i) => (
          // setPeriod re-seeds the anchor itself, in the SAME params update —
          // FY stores a "FROM..TO" token while the others store a plain date,
          // and splitting that across two updates loses one of the keys.
          <button key={p.v} onClick={() => setPeriod(p.v)}
            title={p.v === 'fy' ? 'Financial year (1 Apr – 31 Mar)' : undefined}
            className={`px-2 py-1.5 text-xs whitespace-nowrap ${i > 0 ? 'border-l border-slate-200' : ''} ${period === p.v ? 'bg-indigo-600 text-white' : 'text-slate-700 hover:bg-slate-50'}`}>
            {p.l}
          </button>
        ))}
      </div>
      {period === 'today' && (
        <CustomDatePicker value={anchor} onChange={(e) => setAnchor(e.target.value || todayISO())} max={todayISO()}
          className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white min-w-0 max-w-[140px] shrink-0" />
      )}
      {period === 'week' && (
        <CustomSelect value={weekRangeOf(anchor).from} onChange={(e) => setAnchor(e.target.value)} title="Select week"
          className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white min-w-0 max-w-[180px] shrink-0">
          {weekOptions().map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
        </CustomSelect>
      )}
      {period === 'month' && (
        <CustomSelect value={monthRangeOf(anchor).from} onChange={(e) => setAnchor(e.target.value)} title="Select month"
          className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white min-w-0 max-w-[130px] shrink-0">
          {monthOptions().map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </CustomSelect>
      )}
      {period === 'fy' && (
        <CustomSelect value={anchor} onChange={(e) => setAnchor(e.target.value)} title="Select financial year / half"
          className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white min-w-0 max-w-[200px] shrink-0">
          {fyOptions().map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </CustomSelect>
      )}
      {/* No company dropdown. The chips beside the title do this job, and
          clicking the active one clears it, so "all companies" is still
          reachable. The dropdown also listed companies this module never
          uses - Biogreen has no purchases - which made it a way to ask a
          question with no answer. */}
      {/* Warehouse / product / Purchases-+Transfers / By-Category don't apply inside
          a drill (which carries its own controls), so hide them while any drill view
          is open — leaving period · company · vendor, which DO scope the drill. */}
      {!anyView && (
      <CustomSelect value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} title="Factory / warehouse"
        className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white min-w-0 max-w-[140px] truncate">
        <option value="">All Warehouses</option>
        {warehouseOptions.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
      </CustomSelect>
      )}
      <CustomSelect value={vendorId} onChange={(e) => setVendorId(e.target.value)} title="Vendor"
        className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white min-w-0 max-w-[160px] truncate">
        <option value="">All Vendors</option>
        {vendorOptions.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
      </CustomSelect>
      <CustomSelect value={msmeFilter} onChange={(e) => setMsmeFilter(e.target.value)} title="MSME filter"
        className={`border rounded-lg px-2 py-1.5 text-xs bg-white shrink-0 ${msmeFilter !== 'all' ? 'border-indigo-400 text-indigo-700 font-semibold' : 'border-slate-300 text-slate-600'}`}>
        <option value="all">MSME: All</option>
        <option value="msme">MSME only</option>
        <option value="non-msme">Non-MSME</option>
      </CustomSelect>
      <div className="flex gap-0.5 bg-slate-100 rounded-md p-0.5 shrink-0">
        {[['inclgst', 'Incl GST'], ['exgst', 'Excl GST']].map(([v, l]) => (
          <button key={v} type="button" onClick={() => setGstView(v)}
            className={`px-2 py-1 rounded text-[11px] font-semibold transition ${gstView === v ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
            {l}
          </button>
        ))}
      </div>
      {!anyView && (
      <ProductPicker value={productId}
        onChange={(e) => setProductId(e.target.value)}
        className="inline-flex items-center gap-1.5 border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white text-slate-700 hover:bg-slate-50 min-w-0 max-w-[170px]" />
      )}
      {/* Branch-transfer pill: Purchases-only (matches Tally) · + Transfers
          (purchases plus DC challans) · Transfers (only the DC challans). */}
      {!anyView && (
      <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden shrink-0 text-xs" title="Branch transfers (DC/ delivery challans) are internal stock moves, not purchases — Tally excludes them">
        <button type="button" onClick={() => setTransfersMode('')}
          className={`px-2.5 py-1.5 font-medium ${transfersMode === '' ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>Purchases</button>
        <button type="button" onClick={() => setTransfersMode('1')}
          className={`px-2.5 py-1.5 font-medium border-l border-slate-300 ${transfersMode === '1' ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>+ Transfers</button>
        <button type="button" onClick={() => setTransfersMode('only')}
          className={`px-2.5 py-1.5 font-medium border-l border-slate-300 ${transfersMode === 'only' ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>Transfers</button>
      </div>
      )}
      {/* Standalone (no Tally): Only Tally / Only ERP / Tally vs ERP controls
          removed — there is no Tally source to scope against or compare. */}
      {!anyView && (
      <button type="button" onClick={() => navigate(byCategoryHref())}
        title="Spend split by category (RM / Packing / Freight / Expenses …)"
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 shrink-0">
        <PieChart size={14} className="text-indigo-600" /> By Category
      </button>
      )}
      {!anyView && stats && (Number(stats.total_purchase?.returns) > 0 || Number(stats.total_purchase?.credit_notes) > 0) && (
      <div className="relative shrink-0">
        <button type="button" onClick={() => setRaOpen(o => !o)}
          title="Returns & Adjustments"
          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition shrink-0 ${raOpen ? 'bg-amber-50 border-amber-300 text-amber-700' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}>
          <Undo2 size={14} className={raOpen ? 'text-amber-600' : 'text-slate-500'} /> Returns & Adj
          <ChevronDown size={12} className={`transition-transform ${raOpen ? 'rotate-180 text-amber-500' : 'text-slate-400'}`} />
        </button>
        {raOpen && (
          <div className="absolute top-full left-0 mt-1 z-30 bg-white border border-slate-200 rounded-lg shadow-lg p-2 flex flex-col gap-1.5 min-w-[180px]">
            {Number(stats.total_purchase?.returns) > 0 && (
              <button onClick={() => { openRecords('debit_notes', 'Debit Notes'); setRaOpen(false); }}
                className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-100 transition text-left">
                <Undo2 size={12} /> Debit Notes <span className="ml-auto tabular-nums">{fmtINRfull(stats.total_purchase.returns)}</span>
              </button>
            )}
            {Number(stats.total_purchase?.credit_notes) > 0 && (
              <button onClick={() => { openRecords('credit_notes', 'Credit Notes'); setRaOpen(false); }}
                className="flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-700 hover:bg-violet-100 transition text-left">
                <Redo2 size={12} /> Credit Notes <span className="ml-auto tabular-nums">{fmtINRfull(stats.total_purchase.credit_notes)}</span>
              </button>
            )}
          </div>
        )}
      </div>
      )}
      {period === 'custom' && (
        <div className="flex items-center gap-2 text-xs shrink-0">
          <Calendar size={14} className="text-slate-500 shrink-0" />
          <CustomDatePicker value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} max={customTo} className="border border-slate-300 rounded px-2 py-1.5 min-w-0 w-[130px]" />
          <span className="text-slate-400">to</span>
          <CustomDatePicker value={customTo} onChange={(e) => setCustomTo(e.target.value)} min={customFrom} max={todayISO()} className="border border-slate-300 rounded px-2 py-1.5 min-w-0 w-[130px]" />
        </div>
      )}
    </div>
  );

  return (
    <MainLayout>
      {/* In the full-page vendor-ledger drill the BackBar is the single back
          control, so the page header (its own back chevron + breadcrumb) would
          be a duplicate — hide it there, like the sales customer-ledger page. */}
      {!ledgerOpen && (
        <PageHeader
          compact
          title="Purchase Analytics"
          breadcrumbs={[{ label: 'Purchase', href: '/purchase/requests' }, { label: 'Analytics' }]}
          actions={{
            right: (
              <div className="flex items-center gap-2">
                {companyButtons}
              </div>
            ),
            onPrint: () => window.print(),
          }}
        />
      )}

      {/* Filter bar — its own full-width row under the header (all sizes), so the
          controls sit on one straight line instead of wrapping beside the title.
          Company chips stay in the header row above and never push this down.
          Shown on the drill views too (period / company / vendor …), so a record
          list or the Amount-Paid account split can be re-scoped without going back. */}
      {/* Hide this wrapper on the vendor-ledger drill, where filterBar is off and
          it would render as an empty rounded bar above the Back button. */}
      {!ledgerOpen && (
        <div className="bg-white rounded-lg border border-slate-200 mb-4 px-2.5 py-2.5">
          {filterBar}
          {warehouseId && !anyView && (
            <p className="text-[11px] text-slate-400 mt-1.5">
              * The warehouse filter narrows PRs / POs / receipts (Excel export &amp; PO drill-down).
              Bills, payments, outstanding and vendor details are company-level — bills don't carry a
              warehouse, so those cards show <strong>all warehouses</strong>.
            </p>
          )}
        </div>
      )}

      {/* In-page Amount-Paid by-account view (opens from the Amount Paid tile) */}
      {scopesOpen && (
        <>
          <BackBar onBack={closeDrill} />
          <PurchaseScopesScreen data={stats?.total_purchase} companyId={companyId} from={effRange.from} to={effRange.to} onDebitNotes={() => openRecords('debit_notes', 'Debit Notes')} />
        </>
      )}

      {/* In-page Exec Freight Overview (opens from the Freight tile) */}
      {freightOpen && (
        <>
          <BackBar onBack={closeDrill} />
          <FreightOverviewScreen companyId={companyId} from={effRange.from} to={effRange.to} vendorId={vendorId} />
        </>
      )}

      {paidAccountsOpen && (
        <>
          <BackBar onBack={closeDrill} />
          <AmountPaidAccountsScreen
            accounts={stats?.amount_paid?.paid_by_account || []}
            total={stats?.amount_paid?.paid_by_account_total}
            onAccount={(key, label) => openRecords('payment_account', `Paid · ${label}`, key)} />
        </>
      )}

      {/* In-page Outstanding Payables view (opens like the Sales drill-downs) */}
      {payablesOpen && (
        <>
          <BackBar onBack={closePayables} />
          <BucketsModal inline companyId={companyId} vendorId={vendorId} productId={productId}
            includeTransfers={includeTransfers} period={period} anchor={anchor} from={effRange.from} to={effRange.to}
            onClose={closePayables} />
        </>
      )}

      {/* In-page KEY-METRICS record drill (Bills / Amount Paid / Quantity — like the Sales tiles) */}
      {recordsOpen && (
        <>
          <BackBar onBack={closeDrill} />
          <RecordsDrill kind={recordsKind} title={recordsTitle || 'Records'} account={recordsAccount}
            companyId={companyId} vendorId={vendorId} productId={productId}
            includeTransfers={includeTransfers} from={effRange.from} to={effRange.to}
            summary={recordsTitle === 'Total Purchase' && stats?.total_purchase ? [
              { label: 'Ex-GST', value: fmtINRfull(stats.total_purchase.taxable) },
              ...(Number(stats.total_purchase.charges) > 0 ? [{ label: 'Charges', value: fmtINRfull(stats.total_purchase.charges) }] : []),
              { label: 'GST', value: fmtINRfull(stats.total_purchase.gst) },
              ...(Number(stats.total_purchase.tds) > 0 ? [{ label: 'TDS', value: fmtINRfull(stats.total_purchase.tds) }] : []),
              { label: 'Incl. GST', value: fmtINRfull(stats.total_purchase.total) },
              ...(Number(stats.total_purchase.returns) > 0 ? [{ label: 'Returns', value: fmtINRfull(stats.total_purchase.returns) }] : []),
            ] : null} />
        </>
      )}

      {/* In-page Purchase Orders drill-down (opens from the Purchase Orders tile) */}
      {poOpen && (
        <>
          <BackBar onBack={closeDrill} />
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-slate-100">
              <h3 className="text-sm sm:text-base font-semibold text-slate-800 flex items-center gap-2">
                <ShoppingCart size={17} className="text-indigo-600" /> Purchase Orders — Ordered / Billed / Pending
                <span className="text-[11px] font-medium text-slate-500 bg-slate-100 rounded-full px-1.5 py-0.5">{poFulfillment.length}</span>
              </h3>
            </div>
            {poFulfillment.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">No Purchase Orders in this window.</p>
            ) : (
              <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b border-slate-100 text-slate-500 text-[11px] uppercase tracking-wide"><tr className="text-left">
                    <th className="px-4 py-2.5 font-semibold">PO No</th>
                    <th className="px-3 py-2.5 font-semibold">Vendor</th>
                    <th className="px-3 py-2.5 font-semibold text-right">Ordered</th>
                    <th className="px-3 py-2.5 font-semibold text-right">Billed</th>
                    <th className="px-4 py-2.5 font-semibold text-right">Pending</th>
                  </tr></thead>
                  <tbody>
                    {poPageRows.flatMap((r, i) => {
                      const pending = Number(r.pending_value) || 0;
                      const showCompany = i === 0 || r.company_name !== poPageRows[i - 1].company_name;
                      const out = [];
                      if (showCompany) {
                        out.push(
                          <tr key={`co-${r.po_id}`} className="bg-slate-100/80">
                            <td colSpan={5} className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-700">{r.company_name || '(no company)'}</td>
                          </tr>
                        );
                      }
                      out.push(
                        <tr key={r.po_id} className="border-b border-slate-100 last:border-b-0 hover:bg-primary-50/40 transition-colors">
                          <td className="px-4 py-2.5 tabular-nums">
                            <Link to={`/purchase/orders/${r.po_id}`} state={{ backTo: backHere() }} className="font-medium text-indigo-700 hover:text-indigo-900 hover:underline">{r.po_no || '—'}</Link>
                          </td>
                          <td className="px-3 py-2.5 text-slate-700">{r.vendor_name || '—'}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{fmtINRfull(r.ordered_value)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700">{fmtINRfull(r.billed_value)}</td>
                          <td className={`px-4 py-2.5 text-right tabular-nums font-semibold ${pending > 0 ? 'text-amber-700' : 'text-slate-400'}`}>{fmtINRfull(r.pending_value)}</td>
                        </tr>
                      );
                      return out;
                    })}
                  </tbody>
                </table>
              </div>
              {poTotalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 text-xs text-slate-500">
                  <span>Showing {(poSafePage - 1) * PO_PAGE_SIZE + 1} to {Math.min(poSafePage * PO_PAGE_SIZE, poFulfillment.length)} of {poFulfillment.length}</span>
                  <div className="flex items-center gap-1">
                    <button onClick={() => setPoPage(poSafePage - 1)} disabled={poSafePage <= 1}
                      className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Previous page"><ChevronLeft size={15} /></button>
                    {pageWindow(poSafePage, poTotalPages).map((p, idx) => p === '…'
                      ? <span key={`e${idx}`} className="px-1.5 text-slate-400">…</span>
                      : <button key={p} onClick={() => setPoPage(p)}
                          className={`min-w-[30px] px-2 py-1 rounded-lg border text-xs font-medium transition ${p === poSafePage ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{p}</button>
                    )}
                    <button onClick={() => setPoPage(poSafePage + 1)} disabled={poSafePage >= poTotalPages}
                      className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Next page"><ChevronRight size={15} /></button>
                  </div>
                </div>
              )}
              </>
            )}
          </div>
        </>
      )}

      {/* In-page Vendor Ledger drill-down (opens from a Vendor details row) */}
      {ledgerOpen && (
        <>
          <BackBar onBack={closeDrill} />
          <VendorLedgerModal inline vendorId={ledgerVendorId} vendorName={ledgerVendorName}
            period0={period} anchor0={anchor} from0={effRange.from} to0={effRange.to} onClose={closeDrill} />
        </>
      )}

      {/* In-page vendor bills drill (opens from a Vendor details row) */}
      {vendorBillsOpen && (
        <>
          <BackBar onBack={closeDrill} />
          <ZohoVendorBills vendorName={drillVendorName} vendorId={drillVendorId} from={effRange.from} to={effRange.to} includeTransfers={includeTransfers} productId={productId} />
        </>
      )}

      {error && !anyView && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 mb-4 text-sm flex items-center gap-2">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {isLoading && !anyView && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="relative overflow-hidden rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm animate-pulse">
              <span className="absolute left-0 top-0 h-full w-1 bg-slate-200" />
              <div className="h-2 w-20 rounded bg-slate-200" />
              <div className="mt-1.5 h-4 w-28 rounded bg-slate-200" />
              <div className="mt-1 h-2 w-16 rounded bg-slate-100" />
              <div className="mt-1 h-2.5 w-24 rounded bg-slate-100" />
            </div>
          ))}
        </div>
      )}

      {!isLoading && stats && !anyView && (
        <>
          {/* Key metrics — collapsible KPI grid */}
          <div className="flex items-center justify-between gap-3 mb-2">
            <button type="button" onClick={() => setMetricsOpen((o) => !o)}
              className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-700"
              aria-expanded={metricsOpen}>
              <ChevronRight size={14} className={`transition-transform ${metricsOpen ? 'rotate-90' : ''}`} />
              Key metrics
            </button>
          </div>
          {metricsOpen && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3 bg-indigo-100 border border-indigo-200 rounded-xl p-2.5">
            {(() => {
              const tp = stats.total_purchase || {};
              const tpVal = gstView === 'exgst' ? Number(tp.taxable || 0) : Number(tp.total || 0);
              return (
                <PHeadCard label="Total Purchase" tone="purchase"
                  value={fmtINRfull(tpVal)}
                  words={`₹${fmtWords(tpVal)} · ${gstView === 'exgst' ? 'ex-GST' : 'incl GST'}`}
                  context="RM · Maize · Packing · Bought Note"
                  title="Click for the category breakdown." onClick={openScopes}
                  popTitle="Reconciliation"
                  popRows={[
                    { label: 'Ex-GST', value: fmtINRc(tp.taxable) },
                    { label: 'GST', value: fmtINRc(tp.gst) },
                    Number(tp.returns) ? { label: 'Returns', value: fmtINRc(tp.returns), tone: 'text-rose-600' } : null,
                    { label: 'Incl GST', value: fmtINRc(tp.total) },
                  ]} />
              );
            })()}
            {(() => {
              const b = stats.bills || {};
              return (
                <PHeadCard label="Amount Billed" tone="bills"
                  value={`${fmtINRc(b.amount)}`}
                  words={`${fmtInt(b.count)} bills · incl GST`}
                  context="bills booked this period"
                  title="Open the Bills list." onClick={() => navigate(billsHref())}
                  popTitle="This period"
                  popRows={[
                    { label: 'Vouchers', value: fmtInt(b.count) },
                    { label: 'Total value', value: fmtINRc(b.amount) },
                    Number(b.count) ? { label: 'Avg / bill', value: fmtINRc(Number(b.amount || 0) / Number(b.count)) } : null,
                  ]} />
              );
            })()}
            {(() => {
              const op = stats.outstanding_payables || {};
              const paid = Number(op.amount_paid || 0);
              const paidCount = op.paid_count || 0;
              // Split by the CATEGORY of purchase each payment paid for (RM /
              // Maize / Bought Note / Packing / Fruit) — always known, so there
              // is no "Untagged" bucket.
              const byAcct = stats.amount_paid?.paid_by_account || [];
              return (
                <PHeadCard label="Amount Paid" tone="paid"
                  value={paid ? fmtINRfull(Math.abs(paid)) : '₹0'}
                  words={paid ? `₹${fmtWords(paid)}` : undefined}
                  context={paidCount ? `${paidCount} payment(s)` : 'no payment data yet'}
                  popTitle={byAcct.length ? 'By category' : undefined}
                  popRows={byAcct.slice(0, 5).map((a) => ({ label: a.label || a.account || a.name || '—', value: fmtINRc(a.amount), tone: 'text-emerald-700' }))} />
              );
            })()}
            {(() => {
              const op = stats.outstanding_payables || {};
              const live = Number(op.forward_total || op.total || 0);
              const sub = op.forward_total ? 'Tally Sundry Creditors closing' : `${op.count || 0} unpaid bill(s)`;
              return (
                <PHeadCard label="Payable" tone="outstanding"
                  value={fmtINRfull(Math.abs(live))}
                  words={`₹${fmtWords(live)}`}
                  context={sub}
                  title="Unpaid payables. Click for the ageing." onClick={openPayables}
                  popTitle="Payables"
                  popRows={[
                    { label: 'Payable', value: fmtINRc(op.total), tone: 'text-rose-600' },
                    { label: 'Unpaid bills', value: fmtInt(op.count || 0) },
                    op.forward_total ? { label: 'Tally closing', value: fmtINRc(op.forward_total) } : null,
                  ]} />
              );
            })()}
          </div>
          )}


          {/* Aging buckets now live in the right-side drawer opened from the
              Outstanding tile (openPayables), not inline — keeps the page compact. */}

          {/* Vendor details — full per-vendor money view (click a row → ledger) */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden mb-4">
            <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-slate-100 flex-wrap">
              <button type="button" onClick={() => setVendOpen(o => !o)} aria-expanded={vendOpen}
                className="flex items-center gap-2 text-sm sm:text-base font-semibold text-slate-800 group">
                <ChevronRight size={15} className={`shrink-0 text-slate-400 transition-transform ${vendOpen ? 'rotate-90' : ''}`} />
                <Wallet size={17} className="text-indigo-600" /> Vendor details
                <span className="text-[11px] font-medium text-slate-500 bg-slate-100 rounded-full px-1.5 py-0.5">{vendRows.length}</span>
                {/* The reconciliation caveat, moved off the page into a tooltip. */}
                <Info size={13} className="text-slate-300 group-hover:text-slate-500 cursor-help"
                  title="Billed + Opening/adj = Outstanding. Incl-GST, ledger basis — rolls in on-account advances and pre-ERP Tally opening balances, so these totals differ from the ex-GST, period-scoped KEY METRICS tiles above." />
              </button>
              <div className="flex items-center gap-2 flex-wrap">
                <CustomSelect value={overdueFilter} onChange={(e) => setOverdueFilter(e.target.value)} title="Filter by days overdue"
                  className={`border rounded-lg px-2 py-1.5 text-xs bg-white shrink-0 ${overdueFilter ? 'border-rose-400 text-rose-700 font-semibold' : 'border-slate-300 text-slate-600'}`}>
                  <option value="">All ageing</option>
                  <option value="any">Overdue (1+ days)</option>
                  <option value="30">30+ days</option>
                  <option value="60">60+ days</option>
                  <option value="90">90+ days</option>
                </CustomSelect>
                <VendorCombobox value={vendorSearch} onChange={setVendorSearch} options={vendorNames} />
              </div>
            </div>
            {!vendOpen ? null : vendRows.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">No billed vendors.</p>
            ) : (
              <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b border-slate-100 text-slate-500 text-[11px] uppercase tracking-wide">
                    <tr>
                      <th className="text-left px-4 py-2.5 font-semibold">Vendor</th>
                      <th className="text-right px-3 py-2.5 font-semibold whitespace-nowrap">Billed</th>
                      <th className="text-right px-3 py-2.5 font-semibold whitespace-nowrap" title="Pre-ERP Tally opening balance + credit-note adjustments carried into this ledger.">Opening / adj</th>
                      <th className="text-right px-3 py-2.5 font-semibold whitespace-nowrap" title="What is owed to the vendor now. A green “Adv” chip instead means the vendor is in advance (you've paid ahead) — nothing is due.">Payable</th>
                      <th className="text-right px-3 py-2.5 font-semibold whitespace-nowrap">Overdue</th>
                      <th className="text-right px-3 py-2.5 font-semibold whitespace-nowrap" title="How long the vendor's longest-overdue unpaid bill has been past its due date.">Overdue (days)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendPageRows.map((v, i) => {
                      const pct = Math.min(100, Math.round(Number(v.paid_pct) || 0));
                      const carry = Number(v.outstanding || 0) - (Number(v.billed || 0) - Number(v.paid || 0));
                      return (
                        <tr key={i}
                          onClick={() => openLedger(v.vendor_id, v.vendor_name)}
                          className="border-b border-slate-100 hover:bg-indigo-50/60 cursor-pointer">
                          <td className="px-4 py-2.5 font-medium text-slate-800 max-w-[320px]" title={v.vendor_name}>
                            <span className="inline-flex items-center gap-1.5 max-w-full">
                              <span className="truncate">{v.vendor_name}</span>
                              {/* Company as a coloured pill (SS / UAI) next to the
                                  name, matching Sales — not a line underneath.
                                  Shown only when both companies are in view. */}
                              {!companyId && v.company_name && (() => {
                                const short = /biochem/i.test(v.company_name) ? 'SS' : /united\s*agro/i.test(v.company_name) ? 'UAI' : '';
                                if (!short) return null;
                                const cls = short === 'SS' ? 'text-sky-700 bg-sky-50 border-sky-200' : 'text-violet-700 bg-violet-50 border-violet-200';
                                return <span className={`shrink-0 text-[9px] font-bold uppercase tracking-wide rounded px-1 py-0.5 border ${cls}`}>{short}</span>;
                              })()}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-slate-800 whitespace-nowrap">{fmtINRfull(v.billed)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-slate-500 whitespace-nowrap">{Math.abs(carry) < 1 ? '—' : (carry > 0 ? '+' : '−') + fmtINRfull(Math.abs(carry))}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{(() => {
                            const c = Number(v.outstanding || 0);
                            if (c > 0) return <span className="font-semibold text-orange-700">{fmtINRfull(c)}</span>;
                            if (c < -0.5) return (
                              <span className="inline-flex items-center gap-1 text-emerald-600 font-medium">
                                <span className="rounded bg-emerald-50 border border-emerald-200 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide not-italic">Adv</span>
                                {fmtINRfull(Math.abs(c))}
                              </span>
                            );
                            return <span className="text-slate-300">—</span>;
                          })()}</td>
                          <td className="px-3 py-2.5 text-right whitespace-nowrap">
                            {Number(v.overdue) > 0 && v.vendor_name ? (
                              <button
                                onClick={(e) => { e.stopPropagation(); navigate(`/purchase/bills?vend=${encodeURIComponent(v.vendor_name)}&overdue=1`); }}
                                title="View the overdue bills and how many days each is past due"
                                className="tabular-nums text-red-600 font-medium hover:underline">
                                {fmtINRfull(v.overdue)}
                              </button>
                            ) : (
                              <span className="tabular-nums text-slate-300">—</span>
                            )}
                          </td>
                          <td className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap ${Number(v.overdue_days) > 0 ? 'text-rose-600 font-semibold' : 'text-slate-300'}`}>{Number(v.overdue_days) > 0 ? `${fmtInt(v.overdue_days)}d` : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold text-slate-800">
                      <td className="px-4 py-2.5">Grand Total · {vendRows.length} vendor(s)</td>
                      <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{fmtINRfull(vendTot.billed)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-500 whitespace-nowrap">{(() => { const gc = Number(vendTot.outstanding) - (Number(vendTot.billed) - Number(vendTot.paid)); return Math.abs(gc) < 1 ? '—' : (gc > 0 ? '+' : '−') + fmtINRfull(Math.abs(gc)); })()}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-orange-700 whitespace-nowrap">{fmtINRfull(Number(vendTot.payable))}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-red-600 whitespace-nowrap">{Number(vendTot.overdue) > 0 ? fmtINRfull(vendTot.overdue) : '—'}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
              {vendRows.length > VEND_PAGE_SIZE && (
                <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 text-xs text-slate-500">
                  <span>Showing {(vendSafePage - 1) * VEND_PAGE_SIZE + 1} to {Math.min(vendSafePage * VEND_PAGE_SIZE, vendRows.length)} of {vendRows.length}</span>
                  <div className="flex items-center gap-1">
                    <button onClick={() => setVendorPage(vendSafePage - 1)} disabled={vendSafePage <= 1}
                      className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Previous page"><ChevronLeft size={15} /></button>
                    {pageWindow(vendSafePage, vendTotalPages).map((p, idx) => p === '…'
                      ? <span key={`e${idx}`} className="px-1.5 text-slate-400">…</span>
                      : <button key={p} onClick={() => setVendorPage(p)}
                          className={`min-w-[30px] px-2 py-1 rounded-lg border text-xs font-medium transition ${p === vendSafePage ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{p}</button>
                    )}
                    <button onClick={() => setVendorPage(vendSafePage + 1)} disabled={vendSafePage >= vendTotalPages}
                      className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Next page"><ChevronRight size={15} /></button>
                  </div>
                </div>
              )}
              </>
            )}
          </div>

          {/* Bills behind the figures — the per-bill list from the Bills page,
              embedded and scoped to the same filters. Collapsed by default;
              loads only when opened (item 1). */}
          <div className="mb-4">
            <EmbeddedBills companyId={companyId} vendorId={vendorId}
              from={effRange.from} to={effRange.to} source={source} />
          </div>

          {/* Daily Tally import reconciliation hidden — this page runs on Zoho data. */}

        </>
      )}
      {compareOpen && <SourceCompareModal params={buildParams()} onClose={() => setCompareOpen(false)} />}
      {billsPopupOpen && (
        <BillsPopup
          companyId={companyId}
          vendorId={vendorId}
          from={effRange.from}
          to={effRange.to}
          period={period}
          msmeFilter={msmeFilter}
          source={source}
          transfersMode={transfersMode}
          onClose={() => setBillsPopupOpen(false)}
        />
      )}
      {/* Outstanding payables — aging buckets in a right-side slide-over,
          opened from the Outstanding KEY METRICS tile. */}
      <RightDrawer
        open={payablesDrawer}
        onClose={() => setPayablesDrawer(false)}
        title="Outstanding payables"
        subtitle="Unpaid bills by age — click a bucket to see the bills behind it">
        <AgingBucketsPanel companyId={companyId} vendorId={vendorId} includeTransfers={includeTransfers} />
      </RightDrawer>
      {/* Vendor detail — summary card in the same right-side slide-over.
          `wide` so the full ledger has the same room as the sales statement. */}
      <RightDrawer
        wide
        open={!!vendorDrawer}
        onClose={() => setVendorDrawer(null)}
        title={vendorDrawer?.vendor_name || 'Vendor'}
        subtitle={vendorDrawer?.company_name
          ? (/biochem/i.test(vendorDrawer.company_name) ? 'SS Biochem'
            : /united\s*agro/i.test(vendorDrawer.company_name) ? 'United Agro'
            : vendorDrawer.company_name)
          : undefined}>
        {vendorDrawer && (() => {
          const v = vendorDrawer;
          const pct = Math.min(100, Math.round(Number(v.paid_pct) || 0));
          const carry = Number(v.outstanding || 0) - (Number(v.billed || 0) - Number(v.paid || 0));
          return (
            <div className="space-y-3">
              <div className="metric-band">
                <div className="px-3 py-2">
                  <p className="text-[11px] text-slate-500">Billed</p>
                  <p className="text-sm font-bold text-slate-900 money">{fmtINRfull(v.billed)}</p>
                </div>
                <div className="px-3 py-2">
                  <p className="text-[11px] text-slate-500">Opening / adj</p>
                  <p className="text-sm font-bold text-slate-900 money">{Math.abs(carry) < 1 ? '—' : (carry > 0 ? '+' : '−') + fmtINRfull(Math.abs(carry))}</p>
                </div>
                <div className="px-3 py-2">
                  <p className="text-[11px] text-slate-500">Outstanding</p>
                  <p className={`text-sm font-bold money ${Number(v.outstanding) > 0 ? 'text-orange-700' : 'text-slate-900'}`}>{fmtINRfull(Math.abs(Number(v.outstanding)))}</p>
                </div>
                <div className="px-3 py-2">
                  <p className="text-[11px] text-slate-500">Overdue</p>
                  <p className={`text-sm font-bold money ${Number(v.overdue) > 0 ? 'text-red-600' : 'text-slate-900'}`}>{Number(v.overdue) > 0 ? fmtINRfull(v.overdue) : '—'}</p>
                </div>
              </div>
              {/* Settled % now shows at the top-right of the ledger header,
                  beside Excel (settledPct prop) — the full-width bar is gone. */}
              {/* Full ledger, rendered in place — no page swap. */}
              <VendorLedgerModal inline vendorId={v.vendor_id} vendorName={v.vendor_name}
                period0={period} anchor0={anchor} from0={effRange.from} to0={effRange.to}
                settledPct={pct}
                onClose={() => setVendorDrawer(null)} />
            </div>
          );
        })()}
      </RightDrawer>
    </MainLayout>
  );
}
