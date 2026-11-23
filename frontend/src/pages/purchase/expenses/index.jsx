/**
 * Expenses Analytics — mirrors the Purchase Analytics page layout.
 * Company chips in header, segmented period control, stat cards with
 * delta chips, spend-by-category breakdown, and a DataTable drill-down.
 *
 * defaultBucket prop: '' = all, 'DIRECT' = direct only, 'INDIRECT' = indirect only
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import apiClient from '../../../utils/api.js';
import {
  Receipt, Wallet, IndianRupee, ChevronDown, ChevronRight, ChevronLeft,
  Download, Printer, Plus, X, Loader2, AlertCircle, ArrowLeftRight,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import CustomSelect from '@/components/ui/CustomSelect';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import { CTRL_H } from '@/components/common/controls';
import { Button } from '../../../components/ui';
import { formatCurrency, formatDate } from '@/utils/formatters';
import useLookup from '../../../hooks/useLookup.js';
import { usePurchaseFilter } from '../components/purchaseFilter.js';

/* ── date helpers (identical to Purchase Analytics) ─────────────────────── */
const todayISO = () => new Date().toISOString().slice(0, 10);
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseISO = (s) => { const [y, m, d] = (s || todayISO()).split('-').map(Number); return new Date(y, m - 1, d); };
const monthRangeOf = (a) => { const d = parseISO(a); return { from: isoOf(new Date(d.getFullYear(), d.getMonth(), 1)), to: isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0)) }; };
const weekRangeOf  = (a) => { const d = parseISO(a); const dow = (d.getDay() + 6) % 7; const mon = new Date(d); mon.setDate(d.getDate() - dow); const sun = new Date(mon); sun.setDate(mon.getDate() + 6); return { from: isoOf(mon), to: isoOf(sun) }; };
const fyStartYearOf = (d) => (d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1);
const FY_SEP = '..';
const fyRangeOf  = (t) => { const [f, x] = String(t || '').split(FY_SEP); return { from: f, to: x }; };
const fyLabel    = (y) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
const fyTokenFor = (d) => { const y = fyStartYearOf(d); return `${y}-04-01${FY_SEP}${y + 1}-03-31`; };
const fyOptions  = (count = 3) => {
  const today = todayISO(); const cy = fyStartYearOf(new Date()); const out = [];
  for (let i = 0; i < count; i++) {
    const y = cy - i; const l = fyLabel(y);
    out.push({ value: `${y}-04-01${FY_SEP}${y + 1}-03-31`, label: i === 0 ? `FY ${l} (to date)` : `FY ${l}` });
    out.push({ value: `${y}-04-01${FY_SEP}${y}-09-30`,     label: `FY ${l} · H1 Apr–Sep` });
    out.push({ value: `${y}-10-01${FY_SEP}${y + 1}-03-31`, label: `FY ${l} · H2 Oct–Mar` });
  }
  return out.filter((o) => fyRangeOf(o.value).from <= today);
};
const monthOptions = (n = 12) => { const now = new Date(); const out = []; for (let i = 0; i < n; i++) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); out.push({ value: isoOf(d), label: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) }); } return out; };
const weekOptions  = (n = 10) => { const now = new Date(); const dow = (now.getDay() + 6) % 7; const thisMon = new Date(now); thisMon.setDate(now.getDate() - dow); const out = []; for (let i = 0; i < n; i++) { const mon = new Date(thisMon); mon.setDate(thisMon.getDate() - i * 7); const sun = new Date(mon); sun.setDate(mon.getDate() + 6); const lbl = `${mon.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} – ${sun.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`; out.push({ value: isoOf(mon), label: i === 0 ? `${lbl} (this week)` : lbl }); } return out; };
const rangeFor = (period, aRaw) => {
  const today = todayISO(); const cap = (t) => (t > today ? today : t);
  const mismatched = String(aRaw).includes(FY_SEP) !== (period === 'fy');
  const a = mismatched ? (period === 'fy' ? fyTokenFor(new Date()) : today) : aRaw;
  if (period === 'today') return { from: a, to: a };
  if (period === 'week')  { const r = weekRangeOf(a);  return { from: r.from, to: cap(r.to) }; }
  if (period === 'month') { const r = monthRangeOf(a); return { from: r.from, to: cap(r.to) }; }
  if (period === 'fy')    { const r = fyRangeOf(a);    return { from: r.from, to: (r.from <= today && r.to > today) ? today : r.to }; }
  return null;
};

const fmtINR  = (v) => { const n = Math.abs(Number(v) || 0); if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`; if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`; return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`; };
const fmtFull = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;


const STATUSES = [['', 'All Status'], ['DRAFT', 'Draft'], ['OPEN', 'Open'], ['APPROVED', 'Approved'], ['PAID', 'Paid']];

/* ── KPI tile — exact shape from Purchase Analytics ─────────────────────── */
function KpiTile({ dot, label, value, sub, onClick }) {
  const clickable = typeof onClick === 'function';
  return (
    <div
      className={`min-w-0 bg-white rounded-lg border border-slate-300 shadow-sm p-2 transition ${clickable ? 'cursor-pointer hover:border-indigo-400 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-indigo-300' : ''}`}
      onClick={clickable ? onClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
        <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wide">{label}</p>
      </div>
      <p className="text-sm font-bold text-slate-900 tabular-nums leading-snug">{value}</p>
      <p className="text-[10px] text-slate-400 mt-0.5">{sub}</p>
    </div>
  );
}

const bucketPill = (b) =>
  b === 'DIRECT'
    ? <span className="inline-flex items-center rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-[10px] font-bold text-teal-700">Direct</span>
    : <span className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-bold text-violet-700">Indirect</span>;

const STATUS_CLS = {
  DRAFT: 'bg-orange-50 text-orange-700 border-orange-200', OPEN: 'bg-teal-50 text-teal-700 border-teal-200',
  APPROVED: 'bg-emerald-50 text-emerald-700 border-emerald-200', PAID: 'bg-blue-50 text-blue-700 border-blue-200',
};
const statusPill = (s) => (
  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${STATUS_CLS[s] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>
    {s ? s.charAt(0) + s.slice(1).toLowerCase() : '—'}
  </span>
);

const fmtDate    = (iso) => (iso ? formatDate(iso) : '—');
const fmtINRfull = (v)  => `₹${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const EXP_TABS   = [{ key: 'all', label: 'All' }, { key: 'OPEN', label: 'Open' }, { key: 'PAID', label: 'Paid' }];

/* ── Expense Bills Popup — same pattern as Purchase Analytics BillsPopup ─── */
function ExpenseBillsPopup({ companyId, from, to, period, bucketFilter, initialTab = 'all', onClose }) {
  const [tab,        setTab]        = useState(initialTab);
  const [bills,      setBills]      = useState([]);
  const [counts,     setCounts]     = useState({});
  const [loading,    setLoading]    = useState(true);
  const [page,       setPage]       = useState(1);
  const [hasMore,    setHasMore]    = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [catFilter,  setCatFilter]  = useState(bucketFilter || '');
  const [subFilter,  setSubFilter]  = useState('');
  const [subOptions, setSubOptions] = useState([]);
  const PAGE_SIZE = 10;

  const buildQuery = useCallback((statusKey, pg = 1) => {
    const p = new URLSearchParams({ is_expense: 'true', ordering: '-bill_date', page_size: String(PAGE_SIZE), page: String(pg), include_lines: '0' });
    if (from)      p.set('bill_date_from', from);
    if (to)        p.set('bill_date_to',   to);
    if (catFilter) p.set('expense_group',   catFilter);
    if (subFilter) p.set('expense_subcategory', subFilter);
    if (statusKey && statusKey !== 'all') p.set('status', statusKey);
    return p.toString();
  }, [from, to, catFilter, subFilter]);

  /* load subcategory options once (all expense bills for period, no pagination) */
  useEffect(() => {
    const p = new URLSearchParams({ is_expense: 'true', page_size: '500' });
    if (from) p.set('bill_date_from', from);
    if (to)   p.set('bill_date_to',   to);
    if (catFilter) p.set('expense_group', catFilter);
    apiClient.get(`/api/purchase/bills/?${p.toString()}`)
      .then(r => {
        const all = (r.data.results ?? r.data).filter(b => b.purchase_category !== 'FREIGHT');
        const subs = [...new Set(all.map(b => b.expense_subcategory).filter(Boolean))].sort();
        setSubOptions(subs);
      }).catch(() => {});
  }, [from, to, catFilter]);

  useEffect(() => {
    Promise.all([
      apiClient.get(`/api/purchase/bills/?${buildQuery('all', 1)}&page_size=1`).then(r => ['all', r.data.count ?? 0]).catch(() => ['all', 0]),
      apiClient.get(`/api/purchase/bills/?${buildQuery('OPEN', 1)}&page_size=1`).then(r => ['OPEN', r.data.count ?? 0]).catch(() => ['OPEN', 0]),
      apiClient.get(`/api/purchase/bills/?${buildQuery('PAID', 1)}&page_size=1`).then(r => ['PAID', r.data.count ?? 0]).catch(() => ['PAID', 0]),
    ]).then(pairs => setCounts(Object.fromEntries(pairs)));
  }, [buildQuery]);

  useEffect(() => {
    setLoading(true);
    apiClient.get(`/api/purchase/bills/?${buildQuery(tab, page)}`)
      .then(r => {
        const res = (r.data.results ?? r.data).filter(b => b.purchase_category !== 'FREIGHT');
        setBills(res); setHasMore(!!r.data.next); setTotalCount(r.data.count ?? res.length);
      })
      .catch(() => setBills([]))
      .finally(() => setLoading(false));
  }, [tab, page, buildQuery]);

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const switchTab = (key) => { setTab(key); setPage(1); };
  const switchCat = (key) => { setCatFilter(key); setSubFilter(''); setPage(1); };
  const switchSub = (key) => { setSubFilter(key); setPage(1); };
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  const companyTag = (name) => /biochem/i.test(name) ? 'SS' : /united\s*agro/i.test(name) ? 'UAI' : (name || '').split(' ')[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl w-full max-w-4xl flex flex-col shadow-2xl border border-slate-200 overflow-hidden"
        style={{ maxHeight: '88vh', animation: 'fadeScale .18s ease' }}>

        {/* Header */}
        <div className="px-5 pt-5 pb-0 border-b border-slate-100">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-base font-bold text-slate-900">{initialTab === 'OPEN' ? 'Outstanding Expense Bills' : 'Expense Bills'}</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                {from && to ? `${fmtDate(from)} — ${fmtDate(to)}` : period || 'All Time'}
                {bucketFilter ? ` · ${bucketFilter === 'DIRECT' ? 'Direct' : 'Indirect'} only` : ''}
              </p>
            </div>
            <button onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 transition">
              <X size={14} />
            </button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex">
              {EXP_TABS.map(t => (
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
            </div>
            <div className="flex items-center gap-1.5 mb-1">
              {!bucketFilter && (
                <select value={catFilter} onChange={(e) => switchCat(e.target.value)}
                  className={`text-xs font-medium border rounded-lg px-2.5 py-1.5 bg-white focus:outline-none cursor-pointer
                    ${catFilter ? 'border-indigo-400 text-indigo-700 bg-indigo-50' : 'border-slate-200 text-slate-500'}`}>
                  <option value="">All Categories</option>
                  <option value="DIRECT">Direct</option>
                  <option value="INDIRECT">Indirect</option>
                </select>
              )}
              <select value={subFilter} onChange={(e) => switchSub(e.target.value)}
                disabled={subOptions.length === 0}
                className={`text-xs font-medium border rounded-lg px-2.5 py-1.5 bg-white focus:outline-none cursor-pointer
                  ${subFilter ? 'border-indigo-400 text-indigo-700 bg-indigo-50' : 'border-slate-200 text-slate-500'} disabled:opacity-40`}>
                <option value="">All subcategories</option>
                {subOptions.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-y-auto flex-1">
          {loading && page === 1 ? (
            <div className="flex items-center justify-center py-16 text-slate-400 gap-2">
              <Loader2 size={16} className="animate-spin" /> Loading…
            </div>
          ) : bills.length === 0 ? (
            <div className="flex items-center justify-center py-16 text-slate-400 text-sm">No expense bills found</div>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 sticky top-0 z-10">
                  <th className="px-4 py-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider text-left border-b border-slate-200 whitespace-nowrap">Date</th>
                  <th className="px-4 py-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider text-left border-b border-slate-200 whitespace-nowrap">Bill No</th>
                  <th className="px-4 py-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider text-left border-b border-slate-200">Vendor</th>
                  <th className="px-4 py-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider text-left border-b border-slate-200 whitespace-nowrap">Category</th>
                  <th className="px-4 py-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider text-left border-b border-slate-200">Co</th>
                  <th className="px-4 py-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider text-right border-b border-slate-200 whitespace-nowrap">Amount</th>
                  <th className="px-4 py-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider text-right border-b border-slate-200 whitespace-nowrap">Paid</th>
                  <th className="px-4 py-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider text-right border-b border-slate-200 whitespace-nowrap">Balance</th>
                  <th className="px-4 py-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider text-left border-b border-slate-200">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {bills.map((b) => {
                  const billNo = b.bill_no || b.vendor_invoice_no || '—';
                  const balance = Number(b.balance_due ?? (Number(b.total_amount || 0) - Number(b.amount_paid || 0)));
                  const bucket  = b.expense_group;
                  return (
                    <tr key={b.id} className="hover:bg-primary-50/40 transition-colors">
                      <td className="px-4 py-2.5 text-slate-400 whitespace-nowrap">{fmtDate(b.bill_date)}</td>
                      <td className="px-4 py-2.5">
                        <Link to={`/purchase/bills/${b.id}`} onClick={onClose}
                          className="font-mono text-indigo-600 hover:text-indigo-900 hover:underline underline-offset-2 whitespace-nowrap">
                          {billNo}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 font-medium text-slate-800 max-w-[160px] truncate">{b.vendor_name || '—'}</td>
                      <td className="px-4 py-2.5">
                        {bucket === 'DIRECT'
                          ? <span className="text-[11px] font-medium text-teal-700">{b.expense_subcategory || 'Direct'}</span>
                          : bucket === 'INDIRECT'
                          ? <span className="text-[11px] font-medium text-violet-700">{b.expense_subcategory || 'Indirect'}</span>
                          : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-[11px] text-slate-500 whitespace-nowrap">{companyTag(b.company_name || '')}</td>
                      <td className="px-4 py-2.5 text-right font-semibold text-slate-800 tabular-nums whitespace-nowrap">{fmtINRfull(b.total_amount)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap text-emerald-600">{fmtINRfull(b.amount_paid)}</td>
                      <td className={`px-4 py-2.5 text-right tabular-nums whitespace-nowrap font-medium ${balance > 0 ? 'text-red-600' : 'text-slate-400'}`}>{fmtINRfull(balance)}</td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-bold ${STATUS_CLS[b.status] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                          {b.status ? b.status.charAt(0) + b.status.slice(1).toLowerCase() : '—'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between bg-slate-50 rounded-b-2xl">
          <div className="flex items-center gap-4">
            <span className="text-xs text-slate-500 font-medium">
              {totalCount > 0 ? `${((page - 1) * PAGE_SIZE) + 1}–${Math.min(page * PAGE_SIZE, totalCount)} of ${totalCount} bills` : '0 bills'}
            </span>
            {totalCount > PAGE_SIZE && (
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
          <Link to={`/purchase/bills?is_expense=true`} onClick={onClose}
            className="text-xs font-semibold text-indigo-600 border border-indigo-200 rounded-lg px-3 py-1.5 hover:bg-indigo-50 transition bg-white">
            View all in Bills →
          </Link>
        </div>
      </div>
      <style>{`@keyframes fadeScale { from { opacity:0; transform:scale(.97); } to { opacity:1; transform:scale(1); } }`}</style>
    </div>
  );
}

/* ── Tally vs ERP modal — fetches all bills (no page limit), computes client-side */
function ExpenseTallyVsERPModal({ companyId, from, to, onClose }) {
  const [allBills, setAllBills] = useState([]);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    setLoading(true);
    const p = new URLSearchParams({ is_expense: 'true', page_size: '2000', include_lines: '0' });
    if (from) p.set('bill_date_from', from);
    if (to)   p.set('bill_date_to',   to);
    apiClient.get(`/api/purchase/bills/?${p.toString()}`)
      .then(r => {
        let res = r.data.results ?? r.data;
        res = res.filter(b => b.purchase_category !== 'FREIGHT');
        if (companyId) res = res.filter(b => String(b.company || '') === String(companyId));
        setAllBills(res);
      })
      .catch(() => setAllBills([]))
      .finally(() => setLoading(false));
  }, [companyId, from, to]);

  const isTally = (b) => b.tally_guid && !String(b.tally_guid).startsWith('OPENING');
  const isScan  = (b) => b.is_scanned;
  const money   = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const stats = useMemo(() => {
    const sum = (arr) => arr.reduce((s, b) => s + Number(b.total_amount || 0), 0);
    const tallyBills = allBills.filter(b => isTally(b));
    const scanBills  = allBills.filter(b => isScan(b));
    const bothBills  = allBills.filter(b => isTally(b) && isScan(b));
    const onlyTally  = allBills.filter(b => isTally(b) && !isScan(b));
    const onlyScan   = allBills.filter(b => !isTally(b) && isScan(b));
    const tallyVal = sum(tallyBills), scanVal = sum(scanBills);
    return {
      total:      allBills.length,
      tally:      { count: tallyBills.length, value: tallyVal },
      scan:       { count: scanBills.length,  value: scanVal },
      both:       { count: bothBills.length,  value: sum(bothBills) },
      only_tally: { count: onlyTally.length,  value: sum(onlyTally) },
      only_scan:  { count: onlyScan.length,   value: sum(onlyScan) },
      difference: Math.abs(tallyVal - scanVal),
    };
  }, [allBills]);

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const rows = [
    { label: 'In Tally',                    tone: 'text-indigo-700',  bucket: stats.tally },
    { label: 'ERP scanned',                 tone: 'text-sky-700',     bucket: stats.scan },
    { label: 'Matched (both)',              tone: 'text-emerald-700', bucket: stats.both },
    { label: 'Only in Tally (not scanned)', tone: 'text-slate-700',   bucket: stats.only_tally },
    { label: 'Only scanned (not in Tally)', tone: 'text-slate-700',   bucket: stats.only_scan },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <h3 className="font-bold text-slate-800 flex items-center gap-2">
            <ArrowLeftRight size={16} className="text-indigo-600" /> Tally vs ERP
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>
        {loading ? (
          <div className="py-12 text-center text-slate-400 flex items-center justify-center gap-2">
            <Loader2 size={16} className="animate-spin" /> Loading…
          </div>
        ) : (
          <>
            {from && to && (
              <p className="px-4 pt-3 text-xs text-slate-500">
                Period: <b>{from} – {to}</b> · {stats.total} expense bills
              </p>
            )}
            <div className="p-2">
              {rows.map(r => (
                <div key={r.label} className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 text-sm">
                  <span className={`font-medium ${r.tone}`}>{r.label}</span>
                  <span className="flex items-baseline gap-3">
                    <span className="text-slate-400 text-xs">{r.bucket.count} bill(s)</span>
                    <span className="tabular-nums font-semibold">{money(r.bucket.value)}</span>
                  </span>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between px-4 py-3 border-t-2 border-slate-200 bg-slate-50 rounded-b-xl">
              <span className="font-bold text-slate-800">Difference (Tally vs scan total)</span>
              <span className="tabular-nums font-bold text-rose-700">{money(stats.difference)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Outstanding bucket styles (mirrors Purchase Analytics BucketsModal) ─── */
const EXP_SUB_STYLE = {
  paid_early:     { dot: 'bg-emerald-500', amt: 'text-emerald-700', border: 'border-emerald-200', ring: 'border-emerald-300 ring-1 ring-emerald-200', hdr: 'bg-emerald-50 border-emerald-100' },
  still_open:     { dot: 'bg-blue-500',    amt: 'text-blue-700',    border: 'border-blue-200',    ring: 'border-blue-300 ring-1 ring-blue-200',    hdr: 'bg-blue-50 border-blue-100' },
  paid_late:      { dot: 'bg-amber-500',   amt: 'text-amber-700',   border: 'border-amber-200',   ring: 'border-amber-300 ring-1 ring-amber-200',  hdr: 'bg-amber-50 border-amber-100' },
  overdue_unpaid: { dot: 'bg-rose-500',    amt: 'text-rose-700',    border: 'border-rose-200',    ring: 'border-rose-300 ring-1 ring-rose-200',    hdr: 'bg-rose-50 border-rose-100' },
};
const EXP_BUCKET_META = [
  { key: 'paid_early',     label: 'Paid Early',              exceeded: false },
  { key: 'still_open',     label: 'Still Open (within terms)', exceeded: false },
  { key: 'paid_late',      label: 'Paid Late',               exceeded: true  },
  { key: 'overdue_unpaid', label: 'Overdue Unpaid',          exceeded: true  },
];
const PAYMENT_TERMS_DAYS = 30; // default assumption for expenses

function classifyBill(bill, today = new Date()) {
  const billDate = bill.bill_date ? new Date(bill.bill_date) : null;
  const dueDate  = billDate ? new Date(billDate.getTime() + PAYMENT_TERMS_DAYS * 86400000) : null;
  const isPaid   = bill.status === 'PAID';
  const paidDate = bill.paid_date ? new Date(bill.paid_date) : (isPaid ? dueDate : null);
  if (!dueDate) return 'still_open';
  const days = Math.round((today - dueDate) / 86400000);
  if (isPaid) {
    return paidDate && paidDate <= dueDate ? 'paid_early' : 'paid_late';
  }
  return days > 0 ? 'overdue_unpaid' : 'still_open';
}

/* ── Expense Outstanding Popup (mirrors BucketsModal from Purchase Analytics) */
function ExpenseOutstandingModal({ companyId, from, to, bucketFilter, onClose }) {
  const navigate = useNavigate();
  const [bills,        setBills]        = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [catFilter,    setCatFilter]    = useState(bucketFilter || '');
  const [expanded,     setExpanded]     = useState(null);
  const [mainTab,      setMainTab]      = useState('buckets');
  const [bucketSort,   setBucketSort]   = useState('vendor');
  const [bucketPage,   setBucketPage]   = useState(1);

  /* fetch ALL open + all expense bills for this period */
  useEffect(() => {
    setLoading(true);
    const p = new URLSearchParams({ is_expense: 'true', page_size: '1000', include_lines: '0' });
    if (from) p.set('bill_date_from', from);
    if (to)   p.set('bill_date_to',   to);
    if (catFilter) p.set('expense_group', catFilter);
    // load all statuses so we can compute paid_early / paid_late too
    apiClient.get(`/api/purchase/bills/?${p.toString()}`)
      .then(r => setBills((r.data.results ?? r.data).filter(b => b.purchase_category !== 'FREIGHT')))
      .catch(() => setBills([]))
      .finally(() => setLoading(false));
  }, [from, to, catFilter]);

  /* company filter client-side (same as main page) */
  const filtered = useMemo(() =>
    companyId ? bills.filter(b => String(b.company || '') === String(companyId)) : bills
  , [bills, companyId]);

  /* classify each bill into a bucket */
  const today = new Date();
  const classified = useMemo(() => {
    const out = { paid_early: [], still_open: [], paid_late: [], overdue_unpaid: [] };
    for (const b of filtered) out[classifyBill(b, today)]?.push(b);
    return out;
  }, [filtered]);

  const outstanding_total = useMemo(() =>
    filtered.filter(b => b.status !== 'PAID').reduce((s, b) => s + Number(b.balance_due ?? (Number(b.total_amount || 0) - Number(b.amount_paid || 0))), 0)
  , [filtered]);

  const total_billed = useMemo(() =>
    filtered.reduce((s, b) => s + Number(b.total_amount || 0), 0)
  , [filtered]);

  /* month-wise breakdown */
  const monthlyRows = useMemo(() => {
    const map = {};
    for (const b of filtered) {
      if (!b.bill_date) continue;
      const d = new Date(b.bill_date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const lbl = d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
      if (!map[key]) map[key] = { key, label: lbl, total: 0, paid: 0, partial: 0, open: 0, billed: 0, outstanding: 0 };
      const row = map[key];
      row.total++;
      row.billed += Number(b.total_amount || 0);
      const bal = Number(b.balance_due ?? (Number(b.total_amount || 0) - Number(b.amount_paid || 0)));
      if (b.status === 'PAID') row.paid++;
      else if (Number(b.amount_paid || 0) > 0) row.partial++;
      else row.open++;
      row.outstanding += bal;
    }
    return Object.values(map).sort((a, b) => a.key.localeCompare(b.key));
  }, [filtered]);

  /* category options for filter */
  const catOpts = useMemo(() => {
    const s = new Set(bills.map(b => b.expense_group).filter(Boolean));
    return [...s].sort();
  }, [bills]);

  /* bucket detail */
  const selBucketMeta = expanded ? EXP_BUCKET_META.find(m => m.key === expanded) : null;
  const selRows = expanded ? (classified[expanded] || []) : [];
  const PAGE = 12;

  const sortedRows = useMemo(() => {
    if (!expanded) return [];
    const rows = [...selRows];
    if (bucketSort === 'longest') {
      rows.sort((a, b) => {
        const daysA = new Date() - (a.bill_date ? new Date(new Date(a.bill_date).getTime() + PAYMENT_TERMS_DAYS * 86400000) : new Date());
        const daysB = new Date() - (b.bill_date ? new Date(new Date(b.bill_date).getTime() + PAYMENT_TERMS_DAYS * 86400000) : new Date());
        return daysB - daysA;
      });
    } else if (bucketSort === 'newest') {
      rows.sort((a, b) => (b.bill_date || '').localeCompare(a.bill_date || ''));
    }
    return rows;
  }, [selRows, bucketSort, expanded]);

  const totalBucketPages = Math.max(1, Math.ceil(sortedRows.length / PAGE));
  const cp = Math.min(bucketPage, totalBucketPages);
  const pageRows = sortedRows.slice((cp - 1) * PAGE, cp * PAGE);

  const daysLabel = (bill) => {
    if (!bill.bill_date) return '—';
    const due = new Date(new Date(bill.bill_date).getTime() + PAYMENT_TERMS_DAYS * 86400000);
    const days = Math.round((today - due) / 86400000);
    if (expanded === 'overdue_unpaid') return days > 0 ? `${days}d overdue` : 'due today';
    if (expanded === 'paid_late') return `paid ${Math.abs(days)}d late`;
    if (expanded === 'paid_early') return `paid ${Math.abs(days)}d early`;
    if (expanded === 'still_open') return days < 0 ? `due in ${-days}d` : 'due today';
    return '—';
  };

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') { if (expanded) setExpanded(null); else onClose(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, expanded]);

  const fmtINRfull = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtD = (iso) => iso ? formatDate(iso) : '—';

  const dueOf = (bill) => {
    if (!bill.bill_date) return null;
    const d = new Date(new Date(bill.bill_date).getTime() + PAYMENT_TERMS_DAYS * 86400000);
    return d.toISOString().slice(0, 10);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-2 sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[92dvh] flex flex-col"
        onClick={e => e.stopPropagation()}
        style={{ animation: 'fadeScale .18s ease' }}>

        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-5 py-3 border-b border-slate-200 flex-wrap">
          <div className="flex items-center gap-3 min-w-0 shrink-0">
            <span className="p-2 rounded-xl bg-rose-50 text-rose-600 shrink-0"><AlertCircle size={20} /></span>
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-semibold text-slate-900 leading-tight">Outstanding Expense Payables</h2>
              <p className="text-xs text-slate-500 mt-0.5">Grouped by payment timing — open a bucket to see overdue bills</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
            <select value={catFilter} onChange={e => { setCatFilter(e.target.value); setExpanded(null); }}
              className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white min-w-0 max-w-[180px]">
              <option value="">All Categories</option>
              <option value="DIRECT">Direct</option>
              <option value="INDIRECT">Indirect</option>
            </select>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Summary strip */}
        {!loading && (
          <div className="px-5 py-3 border-b border-slate-100 grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="rounded-xl border border-rose-200 bg-rose-50/60 px-4 py-2.5">
              <p className="text-[10px] uppercase text-rose-600 font-semibold tracking-wide">Outstanding</p>
              <p className="text-lg font-bold text-rose-700 tabular-nums">{fmtINRfull(outstanding_total)}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5">
              <p className="text-[10px] uppercase text-slate-500 font-semibold tracking-wide">Total (incl. settled)</p>
              <p className="text-lg font-bold text-slate-800 tabular-nums">{fmtINRfull(total_billed)}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5">
              <p className="text-[10px] uppercase text-slate-500 font-semibold tracking-wide">Bills</p>
              <p className="text-lg font-bold text-slate-800 tabular-nums">{filtered.length}</p>
            </div>
          </div>
        )}

        {/* Main tabs */}
        <div className="flex border-b border-slate-100 px-5">
          {[['buckets', 'Buckets'], ['monthly', 'Month-wise']].map(([key, label]) => (
            <button key={key} onClick={() => { setMainTab(key); setExpanded(null); }}
              className={`px-3 py-2.5 text-xs font-semibold mr-1 border-b-2 -mb-px transition whitespace-nowrap
                ${mainTab === key ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
              {label}
            </button>
          ))}
        </div>

        <div className="overflow-y-auto flex-1">

          {/* Loading */}
          {loading && (
            <div className="flex items-center justify-center py-12 text-slate-500">
              <Loader2 className="animate-spin mr-2" size={18} /> Loading…
            </div>
          )}

          {/* Monthly tab */}
          {!loading && mainTab === 'monthly' && (
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
                {monthlyRows.map(r => {
                  const paidPct = r.billed > 0 ? Math.round(((r.billed - r.outstanding) / r.billed) * 100) : 0;
                  return (
                    <tr key={r.key} className="hover:bg-primary-50/40 transition-colors">
                      <td className="px-4 py-2.5 font-medium text-slate-700 whitespace-nowrap">{r.label}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-600 font-semibold">{r.total}</td>
                      <td className="px-3 py-2.5 text-center"><span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-semibold text-[11px]">✓ {r.paid}</span></td>
                      <td className="px-3 py-2.5 text-center"><span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-semibold text-[11px]">~ {r.partial}</span></td>
                      <td className="px-3 py-2.5 text-center"><span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold text-[11px]">○ {r.open}</span></td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-600 whitespace-nowrap">{fmtINRfull(r.billed)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-rose-600 whitespace-nowrap">{fmtINRfull(r.outstanding)}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <div className="flex-1 h-1.5 rounded bg-slate-200 overflow-hidden min-w-[60px]">
                            <div className="h-full rounded bg-green-400" style={{ width: `${paidPct}%` }} />
                          </div>
                          <span className="text-[10px] text-slate-400 w-7 text-right">{paidPct}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {monthlyRows.length > 0 && (
                  <tr className="bg-slate-50 border-t-2 border-slate-300 font-semibold">
                    <td className="px-4 py-2.5 text-slate-800">Total</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-800">{monthlyRows.reduce((s, r) => s + r.total, 0)}</td>
                    <td className="px-3 py-2.5 text-center"><span className="px-2 py-0.5 rounded-full bg-green-100 text-green-700 text-[11px] font-bold">{monthlyRows.reduce((s, r) => s + r.paid, 0)}</span></td>
                    <td className="px-3 py-2.5 text-center"><span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-[11px] font-bold">{monthlyRows.reduce((s, r) => s + r.partial, 0)}</span></td>
                    <td className="px-3 py-2.5 text-center"><span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[11px] font-bold">{monthlyRows.reduce((s, r) => s + r.open, 0)}</span></td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-800">{fmtINRfull(total_billed)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-rose-700">{fmtINRfull(outstanding_total)}</td>
                    <td className="px-4 py-2.5" />
                  </tr>
                )}
              </tbody>
            </table>
          )}

          {/* Buckets tab */}
          {!loading && mainTab === 'buckets' && (
            <div className="px-4 sm:px-5 py-4 space-y-4">
              {expanded && selBucketMeta ? (() => {
                const st = EXP_SUB_STYLE[expanded] || {};
                const longestLabel = (expanded === 'overdue_unpaid' || expanded === 'paid_late') ? 'Most overdue' : 'Longest';
                return (
                  <div className={`bg-white rounded-xl border shadow-sm overflow-hidden ${st.ring}`}>
                    <div className={`flex items-center justify-between gap-3 px-4 py-3 border-b ${st.hdr}`}>
                      <button type="button" onClick={() => setExpanded(null)}
                        className="inline-flex items-center gap-1 text-sm font-medium text-slate-700 hover:text-slate-900 shrink-0">
                        <ChevronLeft size={16} /> Back
                      </button>
                      <span className="flex items-center gap-2 text-sm font-semibold text-slate-700 min-w-0 truncate">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot}`} />
                        <span className="truncate">{selBucketMeta.label}</span>
                        <span className="text-[11px] font-medium text-slate-500 bg-white/70 rounded-full px-1.5 py-0.5 shrink-0">{selRows.length}</span>
                      </span>
                      <div className="flex items-center gap-2 shrink-0">
                        {selRows.length > 1 && (
                          <div className="flex rounded-lg border border-slate-300 overflow-hidden bg-white">
                            {[['vendor', 'Vendor'], ['longest', longestLabel], ['newest', 'Newest']].map(([k, l], i) => (
                              <button key={k} type="button" onClick={() => { setBucketSort(k); setBucketPage(1); }}
                                className={`px-2 py-1 text-[11px] font-medium ${i > 0 ? 'border-l border-slate-300' : ''} ${bucketSort === k ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}>
                                {l}
                              </button>
                            ))}
                          </div>
                        )}
                        <span className={`text-sm font-bold tabular-nums ${st.amt}`}>
                          {fmtINRfull(selRows.reduce((s, b) => s + Number(b.total_amount || 0), 0))}
                        </span>
                      </div>
                    </div>
                    {selRows.length === 0 ? (
                      <p className="px-4 py-5 text-sm text-slate-400 text-center">No bills in this bucket.</p>
                    ) : (
                      <>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs sm:text-sm">
                            <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-slate-500 text-[11px] uppercase tracking-wide">
                              <tr>
                                <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Bill No</th>
                                <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Bill Date</th>
                                <th className="text-left px-3 py-2 font-semibold">Vendor</th>
                                <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Category</th>
                                <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Due Date</th>
                                <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Timing</th>
                                <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Amount</th>
                              </tr>
                            </thead>
                            <tbody>
                              {pageRows.map((b, i) => (
                                <tr key={b.id || i} className="border-t border-slate-100 hover:bg-primary-50/40 transition-colors">
                                  <td className="px-3 py-2 whitespace-nowrap">
                                    <button onClick={() => { navigate(`/purchase/bills/${b.id}`); onClose(); }}
                                      className="text-violet-700 hover:underline font-medium">
                                      {b.bill_no || b.vendor_invoice_no || '—'}
                                    </button>
                                  </td>
                                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap tabular-nums">{fmtD(b.bill_date)}</td>
                                  <td className="px-3 py-2 text-slate-700">{b.vendor_name || '—'}</td>
                                  <td className="px-3 py-2">
                                    {b.expense_group === 'DIRECT'
                                      ? <span className="text-[11px] font-medium text-teal-700">{b.expense_subcategory || 'Direct'}</span>
                                      : b.expense_group === 'INDIRECT'
                                      ? <span className="text-[11px] font-medium text-violet-700">{b.expense_subcategory || 'Indirect'}</span>
                                      : <span className="text-slate-400">—</span>}
                                  </td>
                                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap tabular-nums">{fmtD(dueOf(b))}</td>
                                  <td className={`px-3 py-2 whitespace-nowrap text-xs font-medium ${
                                    expanded === 'overdue_unpaid' ? 'text-rose-600' :
                                    expanded === 'paid_late' ? 'text-amber-600' :
                                    expanded === 'paid_early' ? 'text-emerald-600' : 'text-blue-600'}`}>
                                    {daysLabel(b)}
                                  </td>
                                  <td className="px-3 py-2 text-right font-semibold text-slate-800 whitespace-nowrap tabular-nums">{fmtINRfull(b.total_amount)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {totalBucketPages > 1 && (
                          <div className="flex items-center justify-between px-3 py-2 border-t border-slate-100 text-xs text-slate-500">
                            <span>Showing {(cp - 1) * PAGE + 1}–{Math.min(cp * PAGE, selRows.length)} of {selRows.length}</span>
                            <div className="flex items-center gap-1">
                              <button onClick={() => setBucketPage(p => Math.max(1, p - 1))} disabled={cp <= 1}
                                className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40">
                                <ChevronLeft size={15} />
                              </button>
                              <span className="px-2 tabular-nums">{cp} / {totalBucketPages}</span>
                              <button onClick={() => setBucketPage(p => Math.min(totalBucketPages, p + 1))} disabled={cp >= totalBucketPages}
                                className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40">
                                <ChevronRight size={15} />
                              </button>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })() : (
                <div className="flex flex-wrap gap-2">
                  {EXP_BUCKET_META.map(meta => {
                    const st = EXP_SUB_STYLE[meta.key] || {};
                    const rows = classified[meta.key] || [];
                    const canOpen = rows.length > 0;
                    const total = rows.reduce((s, b) => s + Number(b.total_amount || 0), 0);
                    return (
                      <button key={meta.key} type="button"
                        onClick={() => canOpen && (setExpanded(meta.key), setBucketPage(1))}
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
              )}
            </div>
          )}

        </div>
      </div>
      <style>{`@keyframes fadeScale { from { opacity:0; transform:scale(.97); } to { opacity:1; transform:scale(1); } }`}</style>
    </div>
  );
}

/* ── Expense Aging Buckets Panel (mirrors Purchase Analytics AgingBucketsPanel) ── */
const EXP_AGING_COLORS = {
  emerald: { bar: 'bg-emerald-400', dot: 'bg-emerald-400', text: 'text-emerald-700', light: 'bg-emerald-50', border: 'border-emerald-100', sub: 'bg-emerald-50/60', divider: 'divide-emerald-100/60' },
  sky:     { bar: 'bg-sky-400',     dot: 'bg-sky-400',     text: 'text-sky-700',     light: 'bg-sky-50',     border: 'border-sky-100',     sub: 'bg-sky-50/60',     divider: 'divide-sky-100/60' },
  amber:   { bar: 'bg-amber-400',   dot: 'bg-amber-400',   text: 'text-amber-700',   light: 'bg-amber-50',   border: 'border-amber-100',   sub: 'bg-amber-50/60',   divider: 'divide-amber-100/60' },
  orange:  { bar: 'bg-orange-500',  dot: 'bg-orange-500',  text: 'text-orange-700',  light: 'bg-orange-50',  border: 'border-orange-100',  sub: 'bg-orange-50/60',  divider: 'divide-orange-100/60' },
  rose:    { bar: 'bg-rose-500',    dot: 'bg-rose-500',    text: 'text-rose-700',    light: 'bg-rose-50',    border: 'border-rose-100',    sub: 'bg-rose-50/60',    divider: 'divide-rose-100/60' },
};

function ExpenseAgingPanel({ companyId }) {
  const navigate = useNavigate();
  const [data,      setData]      = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [expanded,  setExpanded]  = useState(null);
  const [panelOpen, setPanelOpen] = useState(true);

  useEffect(() => {
    setLoading(true);
    const qp = new URLSearchParams({ type: 'expense_aging_buckets' });
    if (companyId) qp.set('company', companyId);
    apiClient.get(`/api/purchase/dashboard/records/?${qp}`)
      .then(r => setData(r.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [companyId]);

  const toggle = (key) => setExpanded(k => k === key ? null : key);

  if (loading) return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 flex items-center gap-2 text-slate-400 text-sm">
      <Loader2 size={15} className="animate-spin" /> Loading outstanding by age…
    </div>
  );
  if (!data) return null;

  const grand = Number(data.total || 0);
  const urgent = (data.buckets || [])
    .filter(b => b.key === '91_180' || b.key === '180p')
    .reduce((s, b) => s + Number(b.total || 0), 0);
  const urgentPct = grand > 0 ? Math.round(urgent / grand * 100) : 0;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-slate-200 cursor-pointer select-none"
        onClick={() => setPanelOpen(o => !o)}>
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="p-1.5 rounded-lg shrink-0 bg-amber-50 text-amber-600"><AlertCircle size={17} /></span>
          <div className="min-w-0">
            <h2 className="text-sm sm:text-base font-semibold text-slate-800">Outstanding by Age</h2>
            <p className="text-[11px] text-slate-500">
              {data.bill_count} unpaid bills · {fmtFull(grand)} total
              {urgentPct > 0 && <span className="ml-2 text-rose-600 font-semibold">· {urgentPct}% is 91+ days old</span>}
            </p>
          </div>
        </div>
        <ChevronDown size={15} className={`text-slate-400 transition-transform ${panelOpen ? 'rotate-180' : ''}`} />
      </div>

      {panelOpen && (
        <div>
          {/* Stacked bar */}
          <div className="flex h-5 overflow-hidden mx-4 mt-3 mb-0 rounded-lg gap-px">
            {(data.buckets || []).filter(b => b.pct > 0).map(b => {
              const c = EXP_AGING_COLORS[b.color] || EXP_AGING_COLORS.emerald;
              return (
                <div key={b.key} className={`${c.bar} flex items-center justify-center cursor-pointer transition-opacity hover:opacity-80`}
                  style={{ width: `${b.pct}%` }} onClick={() => toggle(b.key)}>
                  {b.pct >= 8 && <span className="text-white text-[10px] font-bold">{b.pct}%</span>}
                </div>
              );
            })}
          </div>
          {/* Legend */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2 text-[11px] text-slate-500">
            {(data.buckets || []).map(b => {
              const c = EXP_AGING_COLORS[b.color] || EXP_AGING_COLORS.emerald;
              return (
                <span key={b.key} className="flex items-center gap-1">
                  <span className={`w-2 h-2 rounded-sm ${c.dot}`} /> {b.label}
                </span>
              );
            })}
          </div>
          {/* Table */}
          <table className="w-full text-sm mt-1">
            <thead>
              <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-y border-slate-200">
                <th className="w-6 px-3 py-2.5" />
                <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Bucket</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Bills</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Outstanding</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-slate-500 uppercase tracking-wide">% of Total</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Share</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Oldest Bill</th>
              </tr>
            </thead>
            <tbody>
              {(data.buckets || []).map(b => {
                const c = EXP_AGING_COLORS[b.color] || EXP_AGING_COLORS.emerald;
                const isOpen   = expanded === b.key;
                const isUrgent = b.key === '180p';
                return (
                  <Fragment key={b.key}>
                    <tr className={`border-b border-slate-100 cursor-pointer select-none hover:bg-primary-50/40 transition-colors transition ${isOpen ? 'bg-slate-50' : ''}`}
                      onClick={() => toggle(b.key)}>
                      <td className="px-3 py-3">
                        <ChevronDown size={13} className={`text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                      </td>
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-2">
                          <span className={`w-2.5 h-2.5 rounded-sm ${c.dot} shrink-0`} />
                          <span className={`font-semibold ${isUrgent ? 'text-rose-700' : 'text-slate-700'}`}>{b.label}</span>
                          {isUrgent && <span className="text-[10px] bg-rose-100 text-rose-600 font-bold rounded-full px-1.5 py-0.5">Urgent</span>}
                        </span>
                      </td>
                      <td className={`px-4 py-3 text-right tabular-nums font-semibold ${isUrgent ? 'text-rose-700' : 'text-slate-600'}`}>{b.count}</td>
                      <td className={`px-4 py-3 text-right tabular-nums font-bold ${isUrgent ? 'text-rose-700' : 'text-slate-800'}`}>{fmtFull(b.total)}</td>
                      <td className={`px-4 py-3 text-right font-semibold ${c.text}`}>{b.pct}%</td>
                      <td className="px-4 py-3">
                        <div className="h-1.5 rounded bg-slate-100 overflow-hidden">
                          <div className={`h-full rounded ${c.bar}`} style={{ width: `${b.pct}%` }} />
                        </div>
                      </td>
                      <td className={`px-4 py-3 text-right text-[11px] ${isUrgent ? 'text-rose-600 font-semibold' : 'text-slate-400'}`}>
                        {b.oldest_bill_date ? formatDate(b.oldest_bill_date) : '—'}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={7} className="px-0 py-0">
                          <table className="w-full text-xs border-collapse">
                            <thead>
                              <tr className={`border-y ${c.border} ${c.light}`}>
                                <th className="pl-14 pr-4 py-2 text-left text-[10px] font-semibold text-slate-400 uppercase">Bill Date</th>
                                <th className="px-4 py-2 text-left text-[10px] font-semibold text-slate-400 uppercase">Bill No</th>
                                <th className="px-4 py-2 text-left text-[10px] font-semibold text-slate-400 uppercase">Vendor</th>
                                <th className="px-4 py-2 text-right text-[10px] font-semibold text-slate-400 uppercase">Days Old</th>
                                <th className="px-4 py-2 text-right text-[10px] font-semibold text-slate-400 uppercase">Outstanding</th>
                              </tr>
                            </thead>
                            <tbody className={`divide-y ${c.divider}`}>
                              {(b.preview || []).map(row => (
                                <tr key={row.bill_id} className={`${c.sub} hover:opacity-80`}>
                                  <td className="pl-14 pr-4 py-2.5 text-slate-500">{row.bill_date ? formatDate(row.bill_date) : '—'}</td>
                                  <td className="px-4 py-2.5">
                                    <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/bills/${row.bill_id}`); }}
                                      className="text-indigo-600 hover:underline font-medium">
                                      {row.bill_no || '—'}
                                    </button>
                                  </td>
                                  <td className="px-4 py-2.5 text-slate-700">{row.vendor_name}</td>
                                  <td className={`px-4 py-2.5 text-right font-semibold ${c.text}`}>{row.days}</td>
                                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-800">{fmtFull(row.outstanding)}</td>
                                </tr>
                              ))}
                              {b.count > 3 && (
                                <tr className={c.light}>
                                  <td colSpan={4} className="pl-14 pr-4 py-2 text-slate-400 text-[10px]">+ {b.count - 3} more bills</td>
                                  <td className="px-4 py-2 text-right">
                                    <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/bills?is_expense=true&status=OPEN`); }}
                                      className="text-[10px] text-indigo-600 hover:underline font-medium">
                                      View all →
                                    </button>
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {/* Total row */}
              <tr className="bg-slate-50 border-t-2 border-slate-300">
                <td className="px-3 py-3" />
                <td className="px-4 py-3 font-bold text-slate-800">Total</td>
                <td className="px-4 py-3 text-right tabular-nums font-bold text-slate-800">{data.bill_count}</td>
                <td className="px-4 py-3 text-right tabular-nums font-bold text-slate-900">{fmtFull(grand)}</td>
                <td className="px-4 py-3 text-right font-bold text-slate-800">100%</td>
                <td colSpan={2} />
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── main ────────────────────────────────────────────────────────────────── */
export default function PurchaseExpenses({ defaultBucket = '' }) {
  const navigate = useNavigate();
  const f = usePurchaseFilter({ period: 'month' });
  const period    = f.get('period', 'month');
  const anchor    = f.get('anchor', todayISO());
  const fromUrl   = f.get('from',   todayISO());
  const toUrl     = f.get('to',     todayISO());
  const companyId = f.get('company');

  const setPeriod = (v) => f.setFilter({ period: v, anchor: v === 'fy' ? fyTokenFor(new Date()) : todayISO() });
  const setAnchor = (v) => f.setFilter({ anchor: v });
  const setFrom   = (v) => f.setFilter({ from: v });
  const setTo     = (v) => f.setFilter({ to: v });

  const { options: companyOptions } = useLookup('/api/companies/');

  const [bucket,  setBucket]  = useState(defaultBucket);
  const [status,  setStatus]  = useState('');
  const [rcmOnly, setRcmOnly] = useState(false);
  const [tdsOnly, setTdsOnly] = useState(false);
  const [source,  setSource]  = useState('all');   // all | tally | scan
  const [gstView, setGstView] = useState('inclgst'); // inclgst | exgst
  const [metricsOpen,   setMetricsOpen]   = useState(true);
  const [catOpen,       setCatOpen]       = useState(true);
  const [billsPopup,       setBillsPopup]       = useState(false);
  const [outstandingPopup, setOutstandingPopup] = useState(false);
  const [compareOpen,      setCompareOpen]      = useState(false);
  const [expData,       setExpData]       = useState(null);
  const [expLoading,    setExpLoading]    = useState(false);

  /* ── fetch real expense data from by-category API ─────────────────────── */
  const range = rangeFor(period, anchor) || (period === 'custom' ? { from: fromUrl, to: toUrl } : null);
  const buildExpQuery = useCallback(() => {
    const p = new URLSearchParams();
    if (companyId) p.set('company', companyId);
    if (range?.from) p.set('from', range.from);
    if (range?.to)   p.set('to',   range.to);
    if (source && source !== 'all') p.set('source', source);
    return p.toString();
  }, [companyId, range?.from, range?.to, source]);

  useEffect(() => {
    setExpLoading(true);
    apiClient.get(`/api/purchase/by-category/?${buildExpQuery()}`)
      .then((r) => setExpData(r.data))
      .catch(() => setExpData(null))
      .finally(() => setExpLoading(false));
  }, [buildExpQuery]);

  /* ── derive tiles + category bars from API response ──────────────────── */
  const expGroups = expData?.expenses?.groups || [];

  const isExcl = gstView === 'exgst';

  const kpi = useMemo(() => {
    const groups = bucket
      ? expGroups.filter((g) => g.key === bucket)
      : expGroups;
    const totalKey = isExcl ? 'value' : 'value_incl';
    return {
      total:       groups.reduce((s, g) => s + Number(g[totalKey]   || 0), 0),
      bills:       groups.reduce((s, g) => s + Number(g.count       || 0), 0),
      paid:        groups.reduce((s, g) => s + Number(g.paid        || 0), 0),
      outstanding: groups.reduce((s, g) => s + Number(g.outstanding || 0), 0),
    };
  }, [expGroups, bucket, isExcl]);

  const catRows = useMemo(() => {
    const rows = [];
    const amtKey = isExcl ? 'value' : 'value_incl';
    for (const g of expGroups) {
      if (bucket && g.key !== bucket) continue;
      for (const sub of (g.subcategories || [])) {
        rows.push({
          key:    sub.sub,
          bucket: g.key,
          amount: Number(sub[amtKey] || 0),
          bills:  sub.count,
          paid:   Number(sub.paid || 0),
        });
      }
    }
    rows.sort((a, b) => b.amount - a.amount);
    return rows;
  }, [expGroups, bucket, isExcl]);

  const catMax = catRows.reduce((m, r) => Math.max(m, r.amount), 0) || 1;

  const [bills,     setBills]     = useState([]);
  const [billsLoad, setBillsLoad] = useState(false);

  const buildBillsQuery = useCallback(() => {
    const p = new URLSearchParams({ is_expense: 'true', page_size: '500' });
    if (range?.from) p.set('bill_date_from', range.from);
    if (range?.to)   p.set('bill_date_to',   range.to);
    if (bucket)      p.set('expense_group', bucket);
    if (status)      p.set('status', status);
    if (source && source !== 'all') p.set('source', source);
    return p.toString();
  }, [range?.from, range?.to, bucket, status, source]);

  useEffect(() => {
    setBillsLoad(true);
    apiClient.get(`/api/purchase/bills/?${buildBillsQuery()}`)
      .then((r) => setBills(r.data.results ?? r.data))
      .catch(() => setBills([]))
      .finally(() => setBillsLoad(false));
  }, [buildBillsQuery]);

  const rows = useMemo(() => {
    let r = bills;
    r = r.filter((b) => b.purchase_category !== 'FREIGHT');
    if (companyId) r = r.filter((b) => String(b.company || '') === String(companyId));
    if (rcmOnly) r = r.filter((b) => (b.tally_voucher_type || '').toLowerCase().includes('rcm'));
    if (tdsOnly) r = r.filter((b) => b.computed_tds_section || Number(b.tds_deducted) > 0);
    return r.map((b) => ({
      id:       b.id,
      date:     b.bill_date,
      ref:      b.bill_no || b.vendor_invoice_no || '—',
      ledger:   b.vendor_name || '—',
      bucket:   b.expense_group || '—',
      category: b.expense_subcategory || '—',
      party:    b.vendor_name || '',
      company:  (b.company_name || '').replace(/SS Biochem.*/i, 'SS').replace(/United Agro.*/i, 'UAI'),
      rcm:      (b.tally_voucher_type || '').toLowerCase().includes('rcm') ? 'RCM' : '',
      tds:      b.computed_tds_section || '',
      excl:     Number(b.subtotal || 0),
      gst:      Number(b.tax_amount || 0),
      total:    Number(b.total_amount || 0),
      paid:     Number(b.amount_paid || 0),
      balance:  Number(b.balance_due || 0),
      status:   b.status || '',
    }));
  }, [bills, companyId, rcmOnly, tdsOnly]);

  const onCompanyChange = (v) => f.setFilter({ company: v });
  const companyChips = (() => {
    const shortName = (l) => /biochem/i.test(l) ? 'SS Biochem' : /united\s*agro/i.test(l) ? 'United Agro' : l;
    const quick = companyOptions.filter((c) => /biochem|united\s*agro/i.test(c.label));
    if (!quick.length) return null;
    return (
      <div className="flex items-center gap-1.5 shrink-0">
        {quick.map((c) => {
          const active = String(companyId || '') === String(c.value);
          return (
            <button key={c.value} type="button" onClick={() => onCompanyChange(active ? '' : c.value)} title={c.label}
              className={`px-2 py-1.5 rounded-lg text-xs font-semibold border transition whitespace-nowrap ${active
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                : 'bg-white text-slate-700 border-slate-200 hover:border-indigo-300 hover:text-indigo-600'}`}>
              {shortName(c.label)}
            </button>
          );
        })}
      </div>
    );
  })();

  const title    = defaultBucket === 'DIRECT' ? 'Direct Expenses' : defaultBucket === 'INDIRECT' ? 'Indirect Expenses' : 'Expenses';
  const subtitle = defaultBucket === 'DIRECT' ? 'Manufacturing cost — power, labour, machinery, fuel, lab'
    : defaultBucket === 'INDIRECT' ? 'Overhead cost — rent, salary, professional fees, security, admin'
    : 'Direct and indirect expense analytics';
  const breadcrumbs = defaultBucket ? [{ label: 'Expenses' }, { label: title }] : [{ label: 'Expenses' }];

  const money = (v) => <span className="tabular-nums">{formatCurrency(v)}</span>;

  const columns = [
    { field: 'date',    header: 'Date',     render: (v) => formatDate(v) },
    { field: 'ref',     header: 'Ref',      render: (v) => <span className="font-mono text-[12px] text-slate-600">{v}</span> },
    { field: 'ledger',  header: 'Ledger',   render: (v) => <span className="font-medium text-slate-800">{v}</span> },
    ...(!defaultBucket ? [{ field: 'bucket', header: 'Bucket', render: (v) => bucketPill(v) }] : []),
    { field: 'category', header: 'Category', render: (v) => <span className="inline-flex items-center rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10.5px] font-medium text-slate-600">{v}</span> },
    { field: 'party',   header: 'Party',    render: (v) => v || <span className="text-slate-300">—</span> },
    { field: 'company', header: 'Co' },
    { field: 'rcm',     header: 'RCM',      render: (v) => v ? <span className="inline-flex items-center rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10.5px] font-bold text-amber-700">{v}</span> : <span className="text-slate-300">—</span> },
    { field: 'tds',     header: 'TDS',      render: (v) => v || <span className="text-slate-300">—</span> },
    { field: 'excl',    header: 'Excl GST', align: 'right', render: money,
      footer: (page) => <span className="tabular-nums font-semibold">{formatCurrency(page.reduce((a, r) => a + r.excl, 0))}</span> },
    { field: 'gst',     header: 'GST',      align: 'right', render: money },
    { field: 'total',   header: 'Total',    align: 'right',
      render: (v) => <span className="tabular-nums font-semibold text-slate-900">{formatCurrency(v)}</span>,
      footer: (page) => <span className="tabular-nums font-bold">{formatCurrency(page.reduce((a, r) => a + r.total, 0))}</span> },
    { field: 'paid',    header: 'Paid',     align: 'right',
      render: (v, row) => <span className={`tabular-nums ${v >= row.total && row.total > 0 ? 'text-emerald-600 font-medium' : ''}`}>{formatCurrency(v)}</span>,
      footer: (page) => <span className="tabular-nums font-bold">{formatCurrency(page.reduce((a, r) => a + r.paid, 0))}</span> },
    { field: 'balance', header: 'Balance',  align: 'right',
      render: (v) => <span className={`tabular-nums ${v > 0 ? 'text-red-600 font-medium' : 'text-slate-400'}`}>{formatCurrency(v)}</span>,
      footer: (page) => <span className="tabular-nums font-bold">{formatCurrency(page.reduce((a, r) => a + r.balance, 0))}</span> },
    { field: 'status',  header: 'Status',   render: (v) => statusPill(v) },
  ];

  return (
    <MainLayout>
      <PageHeader
        title={title}
        subtitle={subtitle}
        breadcrumbs={breadcrumbs}
        actions={{
          right: (
            <div className="flex items-center gap-2">
              {companyChips}
              <Button size="sm" onClick={() => navigate('/purchase/bills/new?is_expense=true')}>
                <Plus size={15} className="mr-1" /> New Expense
              </Button>
              <button onClick={() => window.print()} className={`inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-600 hover:bg-slate-50 ${CTRL_H}`}>
                <Printer size={14} /> Print
              </button>
            </div>
          ),
        }}
      />

      <div className="pb-10 space-y-5">

        {/* ── Single filter row — mirrors Purchase Analytics layout exactly ── */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Period toggles */}
          <div className="flex rounded-lg border border-slate-300 overflow-hidden shrink-0">
            {[{ v: 'today', l: 'Today' }, { v: 'week', l: 'Week' }, { v: 'month', l: 'Month' }, { v: 'fy', l: 'FY' }, { v: 'custom', l: 'Custom' }].map((pp, i) => (
              <button key={pp.v} type="button" onClick={() => setPeriod(pp.v)}
                className={`px-2.5 text-xs inline-flex items-center ${CTRL_H} ${i > 0 ? 'border-l border-slate-300' : ''} ${period === pp.v ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>
                {pp.l}
              </button>
            ))}
          </div>
          {/* Period sub-selector */}
          {period === 'fy' && (
            <CustomSelect value={anchor} onChange={(e) => setAnchor(e.target.value)}
              className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-[190px] ${CTRL_H}`}>
              {fyOptions().map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </CustomSelect>
          )}
          {period === 'week' && (
            <CustomSelect value={weekRangeOf(anchor).from} onChange={(e) => setAnchor(e.target.value)}
              className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-[180px] ${CTRL_H}`}>
              {weekOptions().map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
            </CustomSelect>
          )}
          {period === 'month' && (
            <CustomSelect value={monthRangeOf(anchor).from} onChange={(e) => setAnchor(e.target.value)}
              className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-[130px] ${CTRL_H}`}>
              {monthOptions().map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </CustomSelect>
          )}
          {period === 'custom' && (
            <div className="flex items-center gap-1.5 text-xs shrink-0">
              <CustomDatePicker value={fromUrl} onChange={(e) => setFrom(e.target.value)} max={toUrl} className="border border-slate-300 rounded px-2 py-1.5" />
              <span className="text-slate-400">to</span>
              <CustomDatePicker value={toUrl} onChange={(e) => setTo(e.target.value)} min={fromUrl} max={todayISO()} className="border border-slate-300 rounded px-2 py-1.5" />
            </div>
          )}
          {/* Bucket / status dropdowns */}
          {!defaultBucket && (
            <CustomSelect value={bucket} onChange={(e) => setBucket(e.target.value)}
              className={`border border-slate-300 rounded-lg px-2 text-xs bg-white ${CTRL_H}`}>
              <option value="">All Buckets</option>
              <option value="DIRECT">Direct</option>
              <option value="INDIRECT">Indirect</option>
            </CustomSelect>
          )}
          <CustomSelect value={status} onChange={(e) => setStatus(e.target.value)}
            className={`border border-slate-300 rounded-lg px-2 text-xs bg-white ${CTRL_H}`}>
            {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </CustomSelect>
          {/* Incl / Excl GST */}
          <div className="flex gap-0.5 bg-slate-100 rounded-md p-0.5 shrink-0">
            {[['inclgst', 'Incl GST'], ['exgst', 'Excl GST']].map(([v, l]) => (
              <button key={v} type="button" onClick={() => setGstView(v)}
                className={`px-2 py-1 rounded text-[11px] font-semibold transition ${gstView === v ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                {l}
              </button>
            ))}
          </div>
          {/* Source toggle */}
          <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden shrink-0 text-xs">
            {[['all', 'All Sources'], ['tally', 'Tally sync'], ['scan', 'ERP scanned']].map(([v, l], i) => (
              <button key={v} type="button" onClick={() => setSource(v)}
                className={`px-2.5 py-1.5 font-medium ${i > 0 ? 'border-l border-slate-300' : ''} ${source === v ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                {l}
              </button>
            ))}
          </div>
          {/* Tally vs ERP */}
          <button type="button" onClick={() => setCompareOpen(true)}
            title="Compare what Tally and ERP (scan) each captured for expenses"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 shrink-0 ${CTRL_H}`}>
            <ArrowLeftRight size={14} className="text-indigo-600" /> Tally vs ERP
          </button>
        </div>

        {/* ── Key metrics — collapsible 4-tile grid (identical to Purchase Analytics) ── */}
        <div>
          <button type="button" onClick={() => setMetricsOpen((o) => !o)}
            className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-700 mb-2"
            aria-expanded={metricsOpen}>
            <ChevronRight size={14} className={`transition-transform ${metricsOpen ? 'rotate-90' : ''}`} />
            Key metrics
          </button>
          {metricsOpen && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-2.5">
              <KpiTile dot="bg-indigo-400" label="Total Expense"
                value={expLoading ? '…' : fmtFull(kpi.total)} sub={isExcl ? 'Excl GST' : 'Incl GST'} />
              <KpiTile dot="bg-violet-400" label="Bills"
                value={expLoading ? '…' : String(kpi.bills)} sub="expense entries"
                onClick={() => setBillsPopup(true)} />
              <KpiTile dot="bg-emerald-400" label="Amount Paid"
                value={expLoading ? '…' : fmtFull(kpi.paid)} sub="settled" />
              <KpiTile dot="bg-amber-400" label="Outstanding"
                value={expLoading ? '…' : fmtFull(kpi.outstanding)} sub="unpaid balance"
                onClick={() => setOutstandingPopup(true)} />
            </div>
          )}
        </div>

        {/* ── Outstanding by Age ── */}
        <ExpenseAgingPanel companyId={companyId} />

        {/* ── Spend by Category card ── */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <button type="button" onClick={() => setCatOpen((v) => !v)}
            className="w-full flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-slate-100 hover:bg-slate-50 transition text-left">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="p-1.5 rounded-lg shrink-0 bg-indigo-50 text-indigo-600"><IndianRupee size={17} /></span>
              <div className="min-w-0">
                <h2 className="text-sm sm:text-base font-semibold text-slate-800">Spend by Category</h2>
                <p className="text-[11px] text-slate-500">{expLoading ? '…' : `${catRows.length} categor${catRows.length === 1 ? 'y' : 'ies'}`}</p>
              </div>
            </div>
            {catOpen
              ? <ChevronDown size={16} className="text-slate-400 shrink-0" />
              : <ChevronRight size={16} className="text-slate-400 shrink-0" />}
          </button>
          {catOpen && (
            <div className="divide-y divide-slate-100">
              {catRows.map((c) => {
                const pct    = (c.amount / catMax) * 100;
                const unpaid = c.amount - c.paid;
                const isTeal = c.bucket === 'DIRECT';
                return (
                  <div key={c.key} className="flex items-center gap-3 sm:gap-4 px-4 sm:px-5 py-3 hover:bg-slate-50/60 transition">
                    <div className="w-32 sm:w-40 shrink-0">
                      <p className="text-[13px] font-medium text-slate-700 truncate">{c.key}</p>
                      <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-bold mt-0.5 ${isTeal ? 'border-teal-200 bg-teal-50 text-teal-700' : 'border-violet-200 bg-violet-50 text-violet-700'}`}>
                        {isTeal ? 'Direct' : 'Indirect'}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                        <div className={`h-full rounded-full ${isTeal ? 'bg-teal-400' : 'bg-violet-400'}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                    <div className="text-right shrink-0 w-36 sm:w-44">
                      <p className="text-[13px] font-bold text-slate-900 tabular-nums">{fmtFull(c.amount)}</p>
                      <p className="text-[11px] text-slate-400 tabular-nums">
                        {c.bills} bill{c.bills !== 1 ? 's' : ''} ·{' '}
                        {unpaid > 0
                          ? <span className="text-red-500">{fmtINR(unpaid)} unpaid</span>
                          : <span className="text-emerald-600">settled</span>}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Expense entries table ── */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-slate-100">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="p-1.5 rounded-lg shrink-0 bg-slate-100 text-slate-600"><Receipt size={17} /></span>
              <div>
                <h2 className="text-sm sm:text-base font-semibold text-slate-800">Expense Entries</h2>
                {!billsLoad && <p className="text-[11px] text-slate-400">{rows.length} bill{rows.length !== 1 ? 's' : ''}</p>}
              </div>
            </div>
            <button className={`inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-600 hover:bg-slate-50 ${CTRL_H}`}>
              <Download size={14} /> Export
            </button>
          </div>
          <div className="overflow-x-auto">
            <DataTable columns={columns} data={rows} searchPlaceholder="Search ledger, party, ref…" />
          </div>
        </div>

      </div>

      {billsPopup && (
        <ExpenseBillsPopup
          companyId={companyId}
          from={range?.from}
          to={range?.to}
          period={period}
          bucketFilter={bucket}
          onClose={() => setBillsPopup(false)}
        />
      )}
      {outstandingPopup && (
        <ExpenseOutstandingModal
          companyId={companyId}
          from={range?.from}
          to={range?.to}
          bucketFilter={bucket}
          onClose={() => setOutstandingPopup(false)}
        />
      )}
      {compareOpen && (
        <ExpenseTallyVsERPModal
          companyId={companyId}
          from={range?.from}
          to={range?.to}
          onClose={() => setCompareOpen(false)}
        />
      )}
    </MainLayout>
  );
}
