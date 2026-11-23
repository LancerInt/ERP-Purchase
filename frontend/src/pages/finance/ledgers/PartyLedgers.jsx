import { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { fetchTallySyncSummary } from '../../../utils/tallySync.js';
import { formatCurrency } from '@/utils/formatters';
import { Search, Loader2, ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react';
import MultiSelect from '@/components/ui/MultiSelect';

// Contextual category multiselect per group tab (item 4). Debtor categories are
// the customer's type (Direct / Export / Maize) from the customer master, and
// are fixed. Creditor categories are the vendor's Tally GROUP (Sundry Creditors
// - RM / Packing / …) and are built dynamically from the rows (see catOpts), so
// they reflect whatever groups exist for the selected company.
const CAT_OPTS = {
  'Sundry Debtors': [
    { value: 'DIRECT', label: 'Direct customer' },
    { value: 'EXPORT', label: 'Export customer' },
    { value: 'MAIZE', label: 'Maize' },
  ],
};

// Canonical display order for the creditor Tally-group filter (the backend
// _grp_cat buckets). Options are still built from the rows, so only groups that
// exist for the selected company appear — this just orders them.
const CREDITOR_CAT_ORDER = [
  'RM', 'Packing Material', 'Maize', 'Bought Note', 'Fruit',
  'Expense', 'Sales', 'Transporter', 'MSME', 'Group',
];

// "12 Nov 2026, 3:45 pm" — the Tally sync date + time for the drawer header.
const fmtSyncDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
};

// Short company tag — SS / UAI — mirroring the bills list.
const shortCompany = (name) =>
  /biochem/i.test(name || '') ? 'SS'
    : /united\s*agro/i.test(name || '') ? 'UAI'
      : ((name || '').split(/[\s,]+/)[0] || '—');

// Whole-rupee money for the summary band — grouped Indian digits, no paise.
const fmtMoney0 = (v) => `₹${Math.round(Number(v) || 0).toLocaleString('en-IN')}`;

// Balance with its Dr/Cr nature, Tally-style. A creditor balance is credit by
// nature (+ve = Cr, we owe); a debtor balance is debit by nature (+ve = Dr, they
// owe). A sign flip (advance / overpaid) swaps the tag.
const drCr = (v, group) => {
  const n = Number(v) || 0;
  const creditNature = group === 'Sundry Creditors';
  const tag = creditNature ? (n >= 0 ? 'Cr' : 'Dr') : (n >= 0 ? 'Dr' : 'Cr');
  return `${fmtMoney0(Math.abs(n))} ${tag}`;
};

// The BUSINESS NATURE of a balance, not just its Dr/Cr side — the gap Tally
// leaves to the reader. On a party's NATURAL side (+ve here) the balance is a
// plain due (Payable for a creditor, Receivable for a debtor); on the OPPOSITE
// side the whole balance is an advance / overpayment sitting the wrong way.
const balanceNature = (v, group) => {
  const n = Number(v) || 0;
  if (Math.abs(n) < 1) return { label: 'Settled', cls: 'bg-slate-100 text-slate-500 border-slate-200' };
  const creditor = group === 'Sundry Creditors';
  if (n >= 0) {
    return creditor
      ? { label: 'Payable', cls: 'bg-indigo-100 text-indigo-700 border-indigo-300' }
      : { label: 'Receivable', cls: 'bg-emerald-100 text-emerald-700 border-emerald-300' };
  }
  return creditor
    ? { label: 'Advance paid', cls: 'bg-amber-100 text-amber-800 border-amber-300' }
    : { label: 'Advance received', cls: 'bg-amber-100 text-amber-800 border-amber-300' };
};

const GROUP_META = {
  'Sundry Creditors': { label: 'Creditor', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  'Sundry Debtors': { label: 'Debtor', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
};

// Pretty label for a party's category tag. Debtor cats arrive as all-caps codes
// (DIRECT / EXPORT / MAIZE); creditor cats are already business labels (RM,
// Packing Material, Expense, Group, …) and pass through unchanged.
const CAT_LABEL = { DIRECT: 'Direct', EXPORT: 'Export', MAIZE: 'Maize' };
const prettyCat = (c) => CAT_LABEL[c] || c;

// ── Ledger-drawer transaction filters (all client-side on the fetched rows) ──
// Local-date ISO so a period boundary never shifts a day via UTC.
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// [from, to] for a preset; to is always today for the running presets.
const periodRange = (p, cFrom, cTo) => {
  const today = new Date();
  const t = isoLocal(today);
  switch (p) {
    case 'today': return [t, t];
    case 'week': { const d = new Date(today); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return [isoLocal(d), t]; }
    case 'month': return [isoLocal(new Date(today.getFullYear(), today.getMonth(), 1)), t];
    case 'year': return [isoLocal(new Date(today.getFullYear(), 0, 1)), t];
    case 'fy': { const y = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1; return [`${y}-04-01`, t]; }
    case 'custom': return [cFrom || null, cTo || null];
    default: return [null, null];
  }
};
// Entry kind from the row's Type — Bill/Invoice, Debit/Credit Note, Payment/Receipt/Advance.
const typeGroup = (ty) => {
  const s = String(ty || '').toLowerCase();
  if (s.includes('note')) return 'notes';
  if (s.includes('bill') || s.includes('invoice')) return 'bills';
  if (s.includes('payment') || s.includes('receipt') || s.includes('advance')) return 'payments';
  return 'other';
};
// Age bucket by days since the entry date (today − date).
const ageBucket = (dateStr) => {
  if (!dateStr) return null;
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days <= 30) return '0_30';
  if (days <= 60) return '31_60';
  if (days <= 90) return '61_90';
  if (days <= 180) return '91_180';
  return '180p';
};
const PERIODS = [['all', 'All'], ['today', 'Today'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year'], ['fy', 'FY'], ['custom', 'Custom']];
const ETYPES = [['all', 'All'], ['bills', 'Bills'], ['notes', 'Notes'], ['payments', 'Payments']];
const AGES = [['all', 'All'], ['0_30', '0–30'], ['31_60', '31–60'], ['61_90', '61–90'], ['91_180', '91–180'], ['180p', '180+']];

function Chip({ on, onClick, children }) {
  return (
    <button type="button" onClick={onClick}
      className={`px-2 py-0.5 rounded-md text-[11px] font-medium border transition ${on
        ? 'bg-indigo-600 text-white border-indigo-600'
        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>{children}</button>
  );
}

// Master sync state — where the ledger exists across the ERP and Tally.
const SYNC_META = {
  synced: { label: 'Synced', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  tally_only: { label: 'Tally only', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  erp_only: { label: 'ERP only', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
};

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'Sundry Creditors', label: 'Creditors' },
  { key: 'Sundry Debtors', label: 'Debtors' },
];

const PAGE_SIZE = 25;

// Compact page-number list with ellipsis gaps (e.g. 1 … 4 5 6 … 20),
// matching the numbered pagers on the Vendor / Customer detail tables.
function pageWindow(cur, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const wanted = [1, 2, total - 1, total, cur - 1, cur, cur + 1].filter((p) => p >= 1 && p <= total);
  const sorted = [...new Set(wanted)].sort((a, b) => a - b);
  const out = []; let prev = 0;
  for (const p of sorted) { if (p - prev > 1) out.push('…'); out.push(p); prev = p; }
  return out;
}

// Right-side slide-over: a party's running-balance summary + its transactions.
// Vendor (creditor) rows read the purchase vendor-ledger; customer (debtor) rows
// read the finance customer-ledger-entries. No redirect — the card opens in place.
function PartyDrawer({ row, onClose, syncedAt, inline = false, showBack = false }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Transaction filters (period / entry-type / age) — client-side on the rows.
  const [period, setPeriod] = useState('all');
  const [cFrom, setCFrom] = useState('');
  const [cTo, setCTo] = useState('');
  const [etype, setEtype] = useState('all');
  const [age, setAge] = useState('all');
  const [reloadKey, setReloadKey] = useState(0);  // bumped by Retry
  const [selIdx, setSelIdx] = useState(0);        // Tally-style keyboard row cursor
  const scrollRef = useRef(null);                 // the scrollable table body
  // Reset filters whenever a different party opens.
  useEffect(() => {
    setPeriod('all'); setCFrom(''); setCTo(''); setEtype('all'); setAge('all'); setSelIdx(0);
  }, [row?.id]);
  // Reset the row cursor whenever the filtered set changes.
  useEffect(() => { setSelIdx(0); }, [period, etype, age, cFrom, cTo]);
  // Keep the selected row scrolled into view as the cursor moves.
  useEffect(() => {
    const el = scrollRef.current?.querySelector(`[data-rowidx="${selIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selIdx]);
  // Focus the ledger body once a party's rows arrive, so the Up/Down arrows
  // drive the cursor straight away (like opening a ledger in Tally).
  useEffect(() => {
    if (!data) return undefined;
    const t = setTimeout(() => scrollRef.current?.focus({ preventScroll: true }), 60);
    return () => clearTimeout(t);
  }, [data]);
  // Up/Down arrows move the cursor like Tally (also PageUp/Down, Home/End).
  const onTableKey = (e) => {
    const n = (scrollRef.current?.querySelectorAll('[data-rowidx]').length) || 0;
    if (!n) return;
    let next = null;
    if (e.key === 'ArrowDown') next = Math.min(n - 1, selIdx + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, selIdx - 1);
    else if (e.key === 'PageDown') next = Math.min(n - 1, selIdx + 12);
    else if (e.key === 'PageUp') next = Math.max(0, selIdx - 12);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next !== null) { e.preventDefault(); setSelIdx(next); }
  };

  useEffect(() => {
    if (!row) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    if (inline) return () => document.removeEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [row, onClose, inline]);

  useEffect(() => {
    if (!row || !row.id) { setData(null); return undefined; }
    let alive = true; setLoading(true); setError(null); setData(null);
    const url = row.group === 'Sundry Creditors'
      ? `/api/purchase/bills/vendor-ledger/?vendor=${encodeURIComponent(row.id)}`
      : `/api/finance/customer-ledger-entries/?customer=${encodeURIComponent(row.id)}`;
    apiClient.get(url)
      .then((r) => { if (alive) setData(r.data); })
      .catch((e) => { if (alive) setError(e?.response?.data?.detail || e?.message || 'Failed to load transactions'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [row, reloadKey]);

  if (!row) return null;
  const isCreditor = row.group === 'Sundry Creditors';
  // vendor ledger → data.rows {type, doc_no}; customer ledger → data.results {doc_type, reference}
  const txns = ((data?.rows) || (data?.results) || []).map((t) => ({
    date: t.date,
    type: t.type || t.doc_type || '—',
    ref: t.doc_no || t.reference || '—',
    debit: Number(t.debit) || 0,
    credit: Number(t.credit) || 0,
    tds: Number(t.tds) || 0,
    // Customer rows ship a ready `link`; vendor bill rows give a bill id.
    link: t.link || (t.ref_id ? `/purchase/bills/${t.ref_id}` : ''),
  }));
  const sm = SYNC_META[row.sync] || { label: row.sync, cls: 'bg-slate-50 text-slate-500 border-slate-200' };

  // Apply the period / entry-type / age filters to the fetched rows.
  const [pFrom, pTo] = periodRange(period, cFrom, cTo);
  const shown = txns.filter((t) => {
    if (pFrom && t.date < pFrom) return false;
    if (pTo && t.date > pTo) return false;
    if (etype !== 'all' && typeGroup(t.type) !== etype) return false;
    if (age !== 'all' && ageBucket(t.date) !== age) return false;
    return true;
  });
  const filtersOn = period !== 'all' || etype !== 'all' || age !== 'all';
  const clearFilters = () => { setPeriod('all'); setCFrom(''); setCTo(''); setEtype('all'); setAge('all'); };
  // Debit / credit totals of the filtered set (shown as a footer row), and the
  // current page of transactions.
  const totDebit = shown.reduce((s, t) => s + t.debit, 0);
  const totCredit = shown.reduce((s, t) => s + t.credit, 0);
  const totTds = shown.reduce((s, t) => s + (t.tds || 0), 0);

  return (
    <div className={inline ? '' : 'fixed inset-0 z-50'}>
      {!inline && <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} aria-hidden="true" />}
      <div role={inline ? undefined : 'dialog'} aria-modal={inline ? undefined : 'true'} aria-label={row.party}
        className={inline
          ? 'bg-slate-50 rounded-xl border border-slate-200 flex flex-col overflow-hidden h-full'
          : 'absolute right-0 top-0 h-full w-full lg:w-[min(1060px,94vw)] bg-slate-50 shadow-2xl flex flex-col'}>
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-slate-200 bg-white shrink-0">
          <div className="min-w-0 flex items-center gap-2">
            {showBack && (
              <button type="button" onClick={onClose} aria-label="Back"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-sm font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 shrink-0">
                <ChevronLeft size={16} /> Back
              </button>
            )}
            <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-800 truncate">{row.party}</h2>
            {/* Identity pills after the name: Creditor/Debtor · company name ·
                category (RM / Packing / Expense / Group / Direct / Export / …). */}
            <div className="flex flex-wrap items-center gap-1 mt-1">
              {(() => { const g = GROUP_META[row.group] || { label: isCreditor ? 'Creditor' : 'Debtor', cls: 'bg-slate-50 text-slate-600 border-slate-200' }; return (
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold ${g.cls}`}>{g.label}</span>
              ); })()}
              {row.company && (
                <span title={row.company}
                  className="inline-flex items-center px-1.5 py-0.5 rounded border border-slate-200 bg-slate-50 text-slate-600 text-[10px] font-semibold max-w-[180px] truncate">
                  {row.company}
                </span>
              )}
              {(row.cats || []).map((c) => (
                <span key={c}
                  className="inline-flex items-center px-1.5 py-0.5 rounded border border-violet-200 bg-violet-50 text-violet-700 text-[10px] font-semibold">
                  {prettyCat(c)}
                </span>
              ))}
            </div>
          </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Master Ledger links OUT to the source documents: a creditor opens
                the Bills page filtered to this vendor; a debtor opens the Sales
                Invoices filtered to this customer. */}
            <Link
              to={isCreditor
                ? `/purchase/bills?vendor=${encodeURIComponent(row.party || '')}`
                : `/sales/invoices?q=${encodeURIComponent(row.party || '')}`}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-indigo-200 text-indigo-700 text-[11px] font-semibold hover:bg-indigo-50">
              <ExternalLink size={12} /> {isCreditor ? 'View in Bills' : 'View in Invoices'}
            </Link>
            <div className="flex flex-col items-end">
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-medium ${sm.cls}`}>{sm.label}</span>
              {syncedAt && (
                <span className="text-[10px] text-slate-400 mt-0.5 whitespace-nowrap"
                  title="Last Tally sync for this company">synced {fmtSyncDateTime(syncedAt)}</span>
              )}
            </div>
            <button type="button" onClick={onClose} aria-label="Close"
              className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X size={18} /></button>
          </div>
        </div>

        {/* Opening / Debit / Credit / Closing — kept OUT of the scroll region
            (below the header) so the running balances stay visible while the
            transaction list scrolls. */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 px-3 py-2.5 border-b border-slate-100 shrink-0 bg-white">
          {(() => { const b = balanceNature(row.opening, row.group); return (
            <div className="rounded-lg bg-indigo-50 border border-indigo-300 px-3 py-2">
              <div className="flex items-start justify-between gap-1">
                <p className="text-[11px] text-indigo-500">Opening</p>
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold ${b.cls}`}>{b.label}</span>
              </div>
              <p className="text-sm font-bold text-indigo-900 tabular-nums whitespace-nowrap">{drCr(row.opening, row.group)}</p>
            </div>
          ); })()}
          {/* Debit / Credit mirror the footer's Current Total (the same filtered
              rows), so a quick glance at the tile matches the table below. A
              'shown' tag appears when the view is narrowed by a filter. */}
          <div className="rounded-lg bg-indigo-50 border border-indigo-300 px-3 py-2">
            <div className="flex items-start justify-between gap-1">
              <p className="text-[11px] text-indigo-500">Debit</p>
              {filtersOn && <span className="text-[9px] text-indigo-400 font-medium">shown</span>}
            </div>
            <p className="text-sm font-bold text-indigo-900 tabular-nums whitespace-nowrap">{formatCurrency(totDebit)}</p>
          </div>
          <div className="rounded-lg bg-indigo-50 border border-indigo-300 px-3 py-2">
            <div className="flex items-start justify-between gap-1">
              <p className="text-[11px] text-indigo-500">Credit</p>
              {filtersOn && <span className="text-[9px] text-indigo-400 font-medium">shown</span>}
            </div>
            <p className="text-sm font-bold text-indigo-900 tabular-nums whitespace-nowrap">{formatCurrency(totCredit)}</p>
          </div>
          {(() => { const b = balanceNature(row.closing, row.group); const adv = Number(row.advance) || 0; return (
            <div className="rounded-lg bg-indigo-50 border border-indigo-300 px-3 py-2">
              <div className="flex items-start justify-between gap-1">
                <p className="text-[11px] text-indigo-500">Closing</p>
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold ${b.cls}`}>{b.label}</span>
              </div>
              <p className="text-sm font-bold text-indigo-900 tabular-nums whitespace-nowrap">{drCr(row.closing, row.group)}</p>
              {/* Advance hiding inside a netted balance: unapplied money we hold
                  (debtor) or they hold (creditor). From VendorCredit / CustomerAdvance. */}
              {adv > 0 && (
                <p className="text-[10px] text-amber-700 mt-0.5 whitespace-nowrap"
                  title={isCreditor ? 'Unadjusted advance we have paid this vendor' : 'Unadjusted advance this customer has paid us'}>
                  incl. {fmtMoney0(adv)} advance
                </p>
              )}
            </div>
          ); })()}
        </div>

        <div className="flex-1 min-h-0 p-3 flex flex-col">
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden flex-1 min-h-0 flex flex-col">
            {/* Filters — period / entry-type / age, all applied client-side to the
                fetched rows. The row count rides on the right of the same line so
                the filters, the count and the Closing tile above all read in line. */}
            {row.id && !loading && !error && txns.length > 0 && (
              <div className="px-3 py-2 border-b border-slate-100 bg-slate-50/60 flex flex-wrap items-center gap-x-4 gap-y-1.5 shrink-0">
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-slate-600 shrink-0 mr-0.5">Period</span>
                  {PERIODS.map(([v, l]) => <Chip key={v} on={period === v} onClick={() => setPeriod(v)}>{l}</Chip>)}
                  {period === 'custom' && (
                    <span className="inline-flex items-center gap-1 ml-1">
                      <input type="date" value={cFrom} max={cTo || undefined} onChange={(e) => setCFrom(e.target.value)}
                        className="border border-slate-300 rounded px-1.5 py-0.5 text-[11px]" />
                      <span className="text-slate-400 text-[11px]">to</span>
                      <input type="date" value={cTo} min={cFrom || undefined} onChange={(e) => setCTo(e.target.value)}
                        className="border border-slate-300 rounded px-1.5 py-0.5 text-[11px]" />
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-slate-600 shrink-0 mr-0.5">Type</span>
                  {ETYPES.map(([v, l]) => <Chip key={v} on={etype === v} onClick={() => setEtype(v)}>{l}</Chip>)}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-slate-600 shrink-0 mr-0.5">Age</span>
                  {AGES.map(([v, l]) => <Chip key={v} on={age === v} onClick={() => setAge(v)}>{l}</Chip>)}
                </div>
                <span className="ml-auto text-[11px] tabular-nums flex items-center gap-2">
                  {filtersOn ? (
                    <span className="inline-flex items-center gap-1 rounded-md bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 font-semibold text-indigo-700">
                      {shown.length}
                      <span className="font-normal text-indigo-400">of {txns.length}</span>
                    </span>
                  ) : (
                    <span className="text-slate-400">{txns.length} txns</span>
                  )}
                  {filtersOn && (
                    <button type="button" onClick={clearFilters}
                      className="text-indigo-600 hover:underline font-medium">Clear</button>
                  )}
                </span>
              </div>
            )}

            {!row.id ? (
              <div className="py-8 text-center text-xs text-slate-400">Opening-only Tally party (no ERP master) — no transactions to show.</div>
            ) : loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-slate-500"><Loader2 size={16} className="animate-spin" /><span className="text-xs">Loading transactions…</span></div>
            ) : error ? (
              <div className="py-6 text-center">
                <p className="text-xs text-rose-600">{error}</p>
                <button type="button" onClick={() => setReloadKey((k) => k + 1)}
                  className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50">
                  <Loader2 size={13} /> Retry
                </button>
              </div>
            ) : txns.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">No transactions for this party.</div>
            ) : shown.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">No transactions match these filters.</div>
            ) : (
              <div ref={scrollRef} tabIndex={0} onKeyDown={onTableKey}
                className="overflow-auto flex-1 min-h-0 max-h-[calc(100dvh-14rem)] outline-none focus:ring-1 focus:ring-indigo-300 focus:ring-inset">
                {/* No pagination — every voucher in one Tally-style scroll, with
                    the header and the Opening/Total/Closing footer pinned.
                    Up/Down arrows move a row cursor (click the table or Tab to it). */}
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10">
                    <tr className="text-[10px] uppercase tracking-wide text-slate-500 shadow-[0_1px_0_0_rgb(226_232_240)]">
                      <th className="px-3 py-2 text-left font-semibold bg-slate-100">Date</th>
                      <th className="px-3 py-2 text-left font-semibold bg-slate-100">Type</th>
                      <th className="px-3 py-2 text-left font-semibold bg-slate-100">Voucher</th>
                      <th className="px-3 py-2 text-right font-semibold bg-slate-100">Debit</th>
                      <th className="px-3 py-2 text-right font-semibold bg-slate-100">Credit</th>
                      <th className="px-3 py-2 text-right font-semibold bg-slate-100">TDS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((t, i) => (
                      <tr key={i} data-rowidx={i}
                        onClick={() => setSelIdx(i)}
                        className={`border-t border-slate-100 cursor-default ${i === selIdx ? 'bg-indigo-100' : 'odd:bg-white even:bg-slate-50/60'}`}>
                        <td className="px-3 py-1.5 whitespace-nowrap text-slate-500">{t.date}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-slate-700">{t.type}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap font-medium">
                          {t.link
                            ? <Link to={t.link} state={{ backTo: window.location.pathname + window.location.search }}
                                className="text-indigo-700 hover:underline">{t.ref}</Link>
                            : <span className="text-slate-700">{t.ref}</span>}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-slate-700 whitespace-nowrap">{t.debit ? formatCurrency(t.debit) : '—'}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-slate-700 whitespace-nowrap">{t.credit ? formatCurrency(t.credit) : '—'}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-indigo-600 whitespace-nowrap">{t.tds ? formatCurrency(t.tds) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                  {/* Tally-style footer, pinned to the bottom: Opening Balance,
                      Current Total (Dr / Cr / TDS), Closing Balance. */}
                  <tfoot className="sticky bottom-0 z-10">
                    <tr className="bg-slate-50 border-t-2 border-slate-200 text-slate-600">
                      <td className="px-3 py-1.5 bg-slate-50" colSpan={3}>Opening Balance</td>
                      <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap bg-slate-50" colSpan={3}>{drCr(row.opening, row.group)}</td>
                    </tr>
                    <tr className="bg-slate-50 border-t border-slate-200 font-bold text-slate-800">
                      <td className="px-3 py-2 bg-slate-50" colSpan={3}>Current Total · {shown.length} txn(s)</td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap bg-slate-50">{formatCurrency(totDebit)}</td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap bg-slate-50">{formatCurrency(totCredit)}</td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-indigo-700 bg-slate-50">{totTds ? formatCurrency(totTds) : '—'}</td>
                    </tr>
                    <tr className="bg-slate-50 border-t border-slate-200 font-bold text-slate-900">
                      <td className="px-3 py-1.5 bg-slate-50" colSpan={3}>Closing Balance</td>
                      <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap bg-slate-50" colSpan={3}>{drCr(row.closing, row.group)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PartyLedgers() {
  // All filters are seeded from, and written back to, the URL so that opening a
  // ledger's bill/invoice and pressing Back restores the same view instead of
  // resetting to All. ?party= is the legacy deep-link (Dashboard/Payments/
  // Insights); it is folded into ?q on first sync.
  const [sp, setSp] = useSearchParams();
  const [syncSummary, setSyncSummary] = useState(null);
  const [companyPick, setCompanyPick] = useState(sp.get('company') || '');
  const [companies, setCompanies] = useState([]);
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState(sp.get('party') || sp.get('q') || '');
  const [tab, setTab] = useState(sp.get('tab') || 'all');
  const [catSel, setCatSel] = useState(() => {
    const c = sp.get('cats');
    return c ? c.split(',').filter(Boolean) : [];
  });
  // Tally-style "Show zero balance": off shows activity-only parties (default),
  // on reveals every master incl. zero-transaction ones.
  const [showZero, setShowZero] = useState(sp.get('zero') === '1');
  const [page, setPage] = useState(1);

  // Reflect the active filters in the URL (replace — a filter change isn't a
  // history entry; only opening a record is).
  useEffect(() => {
    const p = new URLSearchParams(sp);
    const put = (k, v) => { if (v) p.set(k, v); else p.delete(k); };
    put('company', companyPick);
    put('tab', tab !== 'all' ? tab : '');
    put('cats', catSel.length ? catSel.join(',') : '');
    put('q', search.trim());
    put('zero', showZero ? '1' : '');
    p.delete('party');   // folded into ?q
    if (p.toString() !== sp.toString()) setSp(p, { replace: true });
  }, [companyPick, tab, catSel, search, showZero, sp, setSp]);

  // Tally sync recency (same source as the sidebar button), so the drawer can
  // show when this ledger's company was last synced from Tally.
  useEffect(() => {
    let alive = true;
    fetchTallySyncSummary().then((s) => { if (alive) setSyncSummary(s); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Last Tally sync time for a company name (matched by its SS/UAI short code),
  // falling back to the overall last sync.
  const syncedAtFor = (companyName) => {
    if (!syncSummary) return '';
    const short = shortCompany(companyName || '');
    const hit = (syncSummary.by_company || []).find((c) => c.short === short);
    return (hit && hit.last_synced_at) || syncSummary.last_synced_at || '';
  };

  // Company options — same endpoint/shape the dashboards use.
  useEffect(() => {
    let alive = true;
    apiClient.get('/api/companies/?page_size=1000&page=1')
      .then((res) => {
        if (!alive) return;
        const list = res.data?.results || res.data || [];
        setCompanies(Array.isArray(list) ? list : []);
      })
      .catch(() => { if (alive) setCompanies([]); });
    return () => { alive = false; };
  }, []);

  // Ledger rows — refetch whenever the company filter changes.
  useEffect(() => {
    let alive = true;
    setIsLoading(true);
    setError(null);
    apiClient.get(`/api/finance/party-ledgers/?company=${encodeURIComponent(companyPick)}&show_zero=${showZero ? '1' : '0'}`)
      .then((res) => { if (alive) setData(res.data); })
      .catch((err) => {
        if (!alive) return;
        setError(err?.response?.data?.detail || err?.message || 'Failed to load ledgers');
        setData(null);
      })
      .finally(() => { if (alive) setIsLoading(false); });
    return () => { alive = false; };
  }, [companyPick, showZero]);

  // Reset to first page when the view narrows.
  useEffect(() => { setPage(1); }, [search, tab, companyPick, catSel, showZero]);
  // The category options are group-specific, so clear the picks when the tab
  // changes (and the filter only applies inside Creditors / Debtors). Skip the
  // first run so categories restored from the URL on mount aren't wiped.
  const tabFirstRun = useRef(true);
  useEffect(() => {
    if (tabFirstRun.current) { tabFirstRun.current = false; return; }
    setCatSel([]);
  }, [tab]);

  const rows = data?.rows || [];

  // The open ledger lives in the URL (?ledger=<id|party>) so browser Back and a
  // refresh restore it (and Back returns to the list). We re-find the full row
  // from the loaded data by its key — id when the master exists, else the party
  // name for opening-only Tally parties that carry no id. While the rows are
  // still loading (or the key no longer matches), drawerRow is null and the list
  // shows, rather than crashing. `?party=` is kept for the legacy search seed.
  const rowKey = (r) => String(r.id ?? r.party);
  const drawerParam = sp.get('ledger');
  const drawerRow = useMemo(
    () => (drawerParam == null ? null : (rows.find((r) => rowKey(r) === drawerParam) || null)),
    [drawerParam, rows],
  );
  const openDrawer = (r) => setSp((prev) => { const p = new URLSearchParams(prev); p.set('ledger', rowKey(r)); return p; });
  const closeDrawer = () => setSp((prev) => { const p = new URLSearchParams(prev); p.delete('ledger'); return p; }, { replace: true });

  // Debtors: fixed Direct/Export/Maize. Creditors: the Tally groups actually
  // present in the (company-filtered) rows, so the filter mirrors Tally's Group
  // Summary for the selected company. 'all' tab has no category filter.
  const catOpts = useMemo(() => {
    if (CAT_OPTS[tab]) return CAT_OPTS[tab];
    if (tab !== 'Sundry Creditors') return null;
    const seen = new Set();
    rows.forEach((r) => {
      if (r.group === 'Sundry Creditors') (r.cats || []).forEach((c) => seen.add(c));
    });
    // Canonical business order (matches the backend _grp_cat buckets); any
    // unexpected label sorts to the end alphabetically. Only groups actually
    // present for the selected company are shown.
    const order = CREDITOR_CAT_ORDER;
    return [...seen]
      .sort((a, b) => {
        const ia = order.indexOf(a), ib = order.indexOf(b);
        if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        return a.localeCompare(b);
      })
      .map((c) => ({ value: c, label: c }));
  }, [tab, rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (tab !== 'all' && r.group !== tab) return false;
      if (q && !(r.party || '').toLowerCase().includes(q)) return false;
      if (catOpts && catSel.length) {
        const cats = r.cats || [];
        if (!catSel.some((c) => cats.includes(c))) return false;
      }
      return true;
    });
  }, [rows, search, tab, catOpts, catSel]);

  const totalClosing = useMemo(
    () => filtered.reduce((s, r) => s + (Number(r.closing) || 0), 0),
    [filtered],
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const curPage = Math.min(page, pageCount);
  const pageRows = filtered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);

  // Filters — company pills (like Analytics), group tabs and search. Rendered
  // on the breadcrumb row from lg up (PageHeader `center`), and below it on phones.
  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1 shrink-0">
        <button type="button" onClick={() => setCompanyPick('')}
          className={`px-2 py-1 rounded-lg text-xs font-semibold border transition ${companyPick === '' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'}`}>All</button>
        {companies.map((c) => {
          const active = String(companyPick) === String(c.id);
          return (
            <button key={c.id} type="button" onClick={() => setCompanyPick(active ? '' : c.id)}
              title={c.legal_name || c.name}
              className={`px-2 py-1 rounded-lg text-xs font-semibold border transition whitespace-nowrap ${active ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-700 border-slate-200 hover:border-indigo-300 hover:text-indigo-600'}`}>
              {shortCompany(c.legal_name || c.name)}
            </button>
          );
        })}
      </div>
      <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 shrink-0">
        {TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              tab === t.key ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}>
            {t.label}
          </button>
        ))}
      </div>
      {catOpts && (
        <MultiSelect options={catOpts} value={catSel} onChange={setCatSel}
          placeholder="All Categories" title="Category" className="shrink-0 min-w-[150px]" />
      )}
      <button type="button" onClick={() => setShowZero((v) => !v)}
        title="Tally-style: include ledger masters with zero balance / no transactions"
        className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition whitespace-nowrap shrink-0 ${
          showZero ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'}`}>
        Show zero-balance
      </button>
      <div className="relative flex-1 min-w-[10rem] max-w-xs">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search party…"
          className="w-full pl-8 pr-3 py-1 text-[13px] rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400" />
      </div>
    </div>
  );

  // When a party is open, render the ledger as a normal in-layout page (the
  // sidebar stays, no backdrop) with a Back button, instead of an overlay.
  if (drawerRow) {
    return (
      <MainLayout>
        <div className="p-2 sm:p-3 h-full">
          <PartyDrawer row={drawerRow} syncedAt={syncedAtFor(drawerRow?.company)}
            inline showBack onClose={closeDrawer} />
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Ledger"
        breadcrumbs={[{ label: 'Import Data', href: '/import/overview' }, { label: 'Ledger' }]}
        center={controls}
      />
      {/* On phones PageHeader hides `center`, so show the filters just below. */}
      <div className="lg:hidden mb-3">{controls}</div>

      {/* Summary band. */}
      <div className="metric-band mb-3">
        <div className="px-3 py-2">
          <p className="text-[11px] text-slate-500">Creditors ({data?.creditor_count ?? 0})</p>
          <p className="text-sm font-bold text-indigo-700 tabular-nums">{fmtMoney0(data?.creditors_total || 0)}</p>
        </div>
        <div className="px-3 py-2">
          <p className="text-[11px] text-slate-500">Debtors ({data?.debtor_count ?? 0})</p>
          <p className="text-sm font-bold text-emerald-700 tabular-nums">{fmtMoney0(data?.debtors_total || 0)}</p>
        </div>
        <div className="px-3 py-2">
          <p className="text-[11px] text-slate-500">Ledgers</p>
          <p className="text-sm font-bold text-slate-900 tabular-nums">{(rows.length).toLocaleString('en-IN')}</p>
        </div>
      </div>

      {/* Table / states. */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
            <Loader2 size={18} className="animate-spin" />
            <span className="text-sm">Loading ledgers…</span>
          </div>
        ) : error ? (
          <div className="py-12 text-center text-sm text-rose-600">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-slate-500">No ledgers match this view.</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-2.5 text-left font-semibold">Ledger</th>
                    <th className="px-3 py-2.5 text-left font-semibold">Company</th>
                    <th className="px-3 py-2.5 text-left font-semibold">Group</th>
                    <th className="px-3 py-2.5 text-left font-semibold">Master</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Opening</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Debit</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Credit</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Closing</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r, i) => {
                    const meta = GROUP_META[r.group] || { label: r.group, cls: 'bg-slate-50 text-slate-600 border-slate-200' };
                    const sm = SYNC_META[r.sync] || { label: r.sync || '—', cls: 'bg-slate-50 text-slate-500 border-slate-200' };
                    return (
                      <tr key={`${r.party}-${i}`}
                        onClick={() => openDrawer(r)}
                        onKeyDown={(e) => { if (e.key === 'Enter') openDrawer(r); }}
                        tabIndex={0} role="button"
                        title={`View ${r.party}'s transactions`}
                        className="border-b border-slate-100 last:border-0 hover:bg-indigo-50/50 cursor-pointer focus:outline-none focus:bg-indigo-50/60">
                        <td className="px-3 py-2.5 font-medium text-slate-800">
                          <span className="inline-flex items-center gap-1.5 flex-wrap">
                            {r.party}
                            {/* Category pill(s) for every row (not just Expense),
                                so the list reads consistently. Expense stays
                                amber (excluded-from-payables); the rest neutral. */}
                            {(r.cats || []).map((c) => (
                              <span key={c}
                                title={c === 'Expense' ? 'Expense creditor — tracked in the Expense Register, excluded from purchase payables' : c}
                                className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-semibold shrink-0 ${
                                  c === 'Expense'
                                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                                    : 'border-violet-200 bg-violet-50 text-violet-700'}`}>
                                {prettyCat(c)}
                              </span>
                            ))}
                            <ExternalLink size={12} className="text-slate-300 shrink-0" />
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          {r.company
                            ? <span title={r.company} className="text-[11px] font-semibold text-slate-600 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 whitespace-nowrap">{shortCompany(r.company)}</span>
                            : <span className="text-slate-400">—</span>}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-medium ${meta.cls}`}>
                            {meta.label}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-medium ${sm.cls}`}>
                            {sm.label}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-slate-600 whitespace-nowrap">{drCr(r.opening, r.group)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-slate-600 whitespace-nowrap">{formatCurrency(r.debit)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-slate-600 whitespace-nowrap">{formatCurrency(r.credit)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-slate-900 whitespace-nowrap">{drCr(r.closing, r.group)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-200 bg-slate-50 font-semibold text-slate-900">
                    <td className="px-3 py-1.5" colSpan={7}>
                      Grand total ({filtered.length.toLocaleString('en-IN')} ledgers)
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(totalClosing)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {pageCount > 1 && (
              <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-slate-200 text-xs text-slate-500">
                <span>
                  {(curPage - 1) * PAGE_SIZE + 1}–{Math.min(curPage * PAGE_SIZE, filtered.length)} of {filtered.length}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={curPage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    aria-label="Previous page"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  {pageWindow(curPage, pageCount).map((p, idx) => p === '…'
                    ? <span key={`e${idx}`} className="px-1.5 text-slate-400">…</span>
                    : <button key={p} type="button" onClick={() => setPage(p)}
                        className={`min-w-[30px] px-2 py-1 rounded-lg border text-xs font-medium transition ${p === curPage ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{p}</button>
                  )}
                  <button
                    type="button"
                    disabled={curPage >= pageCount}
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                    className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    aria-label="Next page"
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

    </MainLayout>
  );
}
