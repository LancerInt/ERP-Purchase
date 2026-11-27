import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useGlobalCompany } from '@/hooks/useGlobalCompany.js';
import { ChevronDown, Layers, Check } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import ListState from '@/components/common/ListState.jsx';
import useApiData from '../../../hooks/useApiData.js';
import CustomSelect from '@/components/ui/CustomSelect';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import { CTRL_ROW, CTRL_FIELD } from '@/components/common/controls';
import { formatDate, formatCurrency } from '@/utils/formatters';

// A payment is Tally-side ONLY when it carries a bank/Day-Book reference — the
// BK-… voucher a bank-statement import writes into reference_no (or the API's
// source_origin=TALLY). An ERP-entered payment has NO such reference (it may
// still sit in a bank account, so the account is NOT the signal) → ERP.
const paymentIsTally = (r) => r.source_origin === 'TALLY'
  || !!(r.reference_no && String(r.reference_no).trim());

// Display category for a payment row — the SAME resolution the Category column
// uses: refund / transfer first, then the linked bill's FINE category, then the
// coarse bucket, then the vendor master's type. Used both by the Category cell
// and by the per-category breakdown band so the two always agree. Returns a
// { key, label } pair; key is stable for grouping, label is what's shown.
// Synonyms from the three sources (bill fine category, coarse bucket, vendor
// master type) collapse to ONE canonical key, so the breakdown shows each
// category once — e.g. a bill's 'RM' and a vendor's 'RAW_MATERIAL' are both RM.
const CAT_CANON = {
  RM: 'RM', RAW_MATERIAL: 'RM', PURCHASE: 'RM',
  MAIZE: 'MAIZE',
  BOUGHT_NOTE: 'BOUGHT_NOTE',
  PACKING: 'PACKING', PACKING_MATERIAL: 'PACKING',
  FRUIT: 'FRUIT',
  // TRANSPORTER is the canonical transporter value; TRANSPORT (legacy) and
  // FREIGHT (old manual) are synonyms — all show as the Freight category.
  FREIGHT: 'FREIGHT', TRANSPORTER: 'FREIGHT', TRANSPORT: 'FREIGHT',
  // Everything expense-type rolls up into one Expense bucket: plain expenses,
  // lab expenses, and labour/wage spend (contractor + employee/wage payees).
  EXPENSES: 'EXPENSE', EXPENSE: 'EXPENSE', LAB_EXPENSE: 'EXPENSE',
  CONTRACTOR: 'EXPENSE', WAGES: 'EXPENSE', EMPLOYEE: 'EXPENSE',
  MACHINERY: 'MACHINERY',
  REFUND: 'REFUND', TRANSFER: 'TRANSFER',
};
const CAT_LABELS = {
  RM: 'RM', MAIZE: 'Maize', BOUGHT_NOTE: 'Bought Note', PACKING: 'Packing',
  FRUIT: 'Fruit', FREIGHT: 'Freight', EXPENSE: 'Expense', MACHINERY: 'Machinery',
  REFUND: 'Refund', TRANSFER: 'Contra', UNCATEGORISED: 'Uncategorised',
};
// Display order — purchase first, then expense-ish, then the non-spend lines
// (Transfer / Refund). Every payment lands in one of these so the breakdown
// reconciles to the Amount Paid total. UNCATEGORISED is intentionally NOT shown
// as its own line (everything classifies; any stray lands under its nearest
// real bucket via paymentCat, and OTHER is 0 in practice).
const CAT_ORDER = ['RM', 'MAIZE', 'BOUGHT_NOTE', 'PACKING', 'FRUIT', 'FREIGHT',
  'EXPENSE', 'MACHINERY', 'TRANSFER', 'REFUND'];
function paymentCat(row) {
  if (row?.payment_category === 'REFUND') return 'REFUND';
  if (row?.is_transfer) return 'TRANSFER';
  const fine = (row?.bill_purchase_category || '').toUpperCase();
  if (fine && CAT_CANON[fine]) return CAT_CANON[fine];
  const coarse = (row?.bill_category || '').toUpperCase();
  if (coarse && CAT_CANON[coarse]) return CAT_CANON[coarse];
  const vt = (row?.vendor_category || '').toUpperCase();
  if (vt && CAT_CANON[vt]) return CAT_CANON[vt];
  return 'UNCATEGORISED';
}

// Purchase · Payment Entries — the raw vendor-payment records, now with the
// SAME filter + table chrome as the Bills page: a period (today/week/month/FY/
// all) + company + bill-vs-on-account filter, a metric strip, and a paginated
// DataTable (the flat 9k-row table had no paging). Reads the same
// /api/purchase/payments-made/ list the Payments Made page uses.
export default function PaymentEntries() {
  const navigate = useNavigate();
  // Filters live in the URL so opening a payment and pressing Back restores the
  // same filtered view instead of resetting to "All".
  const [sp, setSp] = useSearchParams();
  const { company: globalCompany } = useGlobalCompany();
  const [company, setCompany] = useState(sp.get('company') || globalCompany || '');
  useEffect(() => { setCompany(globalCompany || ''); }, [globalCompany]);
  const [q, setQ] = useState(sp.get('q') || '');
  const [kind, setKind] = useState(sp.get('kind') || '');   // '' all | 'bill' | 'onaccount' | 'transfer'
  // Category filter is MULTI-select: a set of canonical keys (RM, EXPENSE, …).
  // Empty set = all. Stored in the URL as a comma-separated list.
  const [cats, setCats] = useState(() => {
    const raw = sp.get('cat') || '';
    return new Set(raw ? raw.split(',').filter(Boolean) : []);
  });
  const [src, setSrc] = useState(sp.get('src') || '');      // '' all | TALLY | ERP
  const [tab, setTab] = useState(sp.get('tab') || 'list');  // 'list' | 'bycat'
  const [catFilterOpen, setCatFilterOpen] = useState(false); // category multi-select filter
  const catFilterRef = useRef(null);
  const period = usePeriodFilter(sp.get('period') || 'fy', {
    anchor: sp.get('anchor'), customFrom: sp.get('cfrom'), customTo: sp.get('cto'),
  });

  // Write the active filters back to the URL (replace — a filter change isn't a
  // separate history entry; only opening a record is).
  useEffect(() => {
    const p = new URLSearchParams(sp);
    const put = (k, val, keep) => { if (keep) p.set(k, val); else p.delete(k); };
    const np = period.navProps;
    put('period', np.period, np.period && np.period !== 'all');
    put('anchor', np.anchor, np.period !== 'all' && np.period !== 'custom');
    put('cfrom', np.customFrom, np.period === 'custom');
    put('cto', np.customTo, np.period === 'custom');
    put('company', company, !!company);
    put('kind', kind, !!kind);
    const catStr = [...cats].join(',');
    put('cat', catStr, cats.size > 0);
    put('src', src, !!src);
    put('q', q, !!q.trim());
    put('tab', tab, tab !== 'list');
    if (p.toString() !== sp.toString()) setSp(p, { replace: true });
  }, [period.navProps, company, kind, cats, src, q, tab, sp, setSp]);

  // Close the category-filter dropdown on outside click or Escape.
  useEffect(() => {
    if (!catFilterOpen) return undefined;
    const onDown = (e) => {
      if (catFilterRef.current && !catFilterRef.current.contains(e.target)) setCatFilterOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setCatFilterOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [catFilterOpen]);

  // Push the PERIOD + KIND filters to the server so a month / FY view fetches
  // only that slice instead of every payment for the company (the page was
  // loading ~1,500 rows then filtering in the browser — slow). cat / source /
  // search stay client-side: they run instantly on the already-narrowed set.
  const endpoint = useMemo(() => {
    const p = new URLSearchParams({ slim: '1' });
    if (company) p.set('company', company);
    if (period.range?.from) p.set('date_from', period.range.from);
    if (period.range?.to) p.set('date_to', period.range.to);
    if (kind) p.set('kind', kind);
    return `/api/purchase/payments-made/?${p.toString()}`;
  }, [company, period.range, kind]);
  const { data, isLoading, error, refetch } = useApiData(endpoint);

  const rows = useMemo(() => {
    let list = Array.isArray(data) ? data : (data?.results || []);
    // Period + kind are applied server-side (see endpoint above). Only the light
    // client-side filters remain, on the already-narrowed set.
    // Category filter uses the RESOLVED category (paymentCat) — the same logic
    // as the row badge and the breakdown — so an on-account Expense payment (no
    // bill) is matched too. Multi-select: a row matches if its category is in
    // the chosen set.
    if (cats.size > 0) list = list.filter((r) => cats.has(paymentCat(r)));
    if (src) list = list.filter((r) => (paymentIsTally(r) ? 'TALLY' : 'ERP') === src);
    if (q.trim()) {
      const t = q.trim().toLowerCase();
      list = list.filter((r) =>
        (r.vendor_name || '').toLowerCase().includes(t)
        || (r.payment_no || '').toLowerCase().includes(t)
        || (r.reference_no || '').toLowerCase().includes(t)
        || (r.bill_no || '').toLowerCase().includes(t));
    }
    return list;
  }, [data, q, cats, src]);

  const total = useMemo(() => rows.reduce((s, r) => s + Number(r.amount || 0), 0), [rows]);
  // On-account = vendor advances with no bill. A TRANSFER (bank/cash contra) is
  // NOT a vendor advance, so it must not swell the on-account figure.
  const onAcct = useMemo(
    () => rows.reduce((s, r) => s + ((r.bill_no || r.is_transfer || r.payment_category === 'REFUND') ? 0 : Number(r.amount || 0)), 0), [rows]);
  const transferTotal = useMemo(
    () => rows.reduce((s, r) => s + (r.is_transfer ? Number(r.amount || 0) : 0), 0), [rows]);
  const refundTotal = useMemo(
    () => rows.reduce((s, r) => s + (r.payment_category === 'REFUND' ? Number(r.amount || 0) : 0), 0), [rows]);

  // Per-category totals over the currently visible rows (respects every active
  // filter). Each entry is { key, label, amount, count }, sorted big→small, so
  // the breakdown band reads "RM ₹… · Bought Note ₹… · Expense ₹…". Transfers
  // are a bank/cash contra, not a spend category, so they're left out here (they
  // already have their own figure in the metric strip).
  // Every payment lands in exactly ONE bucket — the spend categories PLUS
  // Transfer / Refund / Uncategorised — so the breakdown reconciles to the TOTAL
  // with zero deviation (Σ categories = Total Amount Paid).
  const catTotals = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const key = paymentCat(r);  // returns TRANSFER / REFUND / RM / ... / UNCATEGORISED
      const cur = m.get(key) || { key, label: CAT_LABELS[key] || key, amount: 0, count: 0 };
      cur.amount += Number(r.amount || 0);
      cur.count += 1;
      m.set(key, cur);
    }
    const idx = (k) => { const i = CAT_ORDER.indexOf(k); return i < 0 ? 99 : i; };
    return [...m.values()].sort((a, b) => idx(a.key) - idx(b.key));
  }, [rows]);
  // Total of all buckets — equals `total` (every row is counted once), so the
  // breakdown is a full reconciliation of the Amount Paid total.
  const catPaidTotal = useMemo(
    () => catTotals.reduce((s, c) => s + c.amount, 0), [catTotals]);

  const columns = [
    { key: 'payment_date', label: 'Date', sortable: true,
      render: (v) => <span className="whitespace-nowrap text-slate-500">{formatDate(v)}</span> },
    { key: 'vendor_name', label: 'Vendor', sortable: true,
      render: (v) => <span className="font-medium text-slate-800">{v || '—'}</span> },
    { key: 'bill_no', label: 'Bill No', sortable: true,
      render: (v, row) => {
        if (row?.payment_category === 'REFUND') {
          return <span className="inline-flex items-center text-[11px] font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded px-1.5 py-0.5 whitespace-nowrap">refund</span>;
        }
        if (row?.is_transfer) {
          return <span className="inline-flex items-center text-[11px] font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-1.5 py-0.5 whitespace-nowrap">contra</span>;
        }
        if (v) {
          return <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5 whitespace-nowrap">{v}</span>;
        }
        // A freight payment settles an Outward/Local freight record, not a bill —
        // link to that record instead of reading as a loose on-account.
        const fl = row?.freight_link;
        if (fl?.no) {
          const to = fl.kind === 'local' ? `/freight/local/${fl.id}` : `/freight/outward?q=${encodeURIComponent(fl.no)}`;
          return (
            <button type="button" onClick={(e) => { e.stopPropagation(); navigate(to); }}
              title={`Linked to ${fl.kind === 'local' ? 'local' : 'outward'} freight ${fl.no}`}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-teal-700 bg-teal-50 border border-teal-200 rounded px-1.5 py-0.5 whitespace-nowrap hover:bg-teal-100">
              {fl.no}
            </button>
          );
        }
        return <span className="text-slate-400 text-[11px]">on-account</span>;
      } },
    { key: 'bill_purchase_category', label: 'Category', sortable: true,
      // Show the FINE category of the linked bill (RM / Packing / Bought Note /
      // Fruit / Maize / Freight / Expenses…), the same tag the Bills page shows —
      // so a payment settling an RM bill reads 'RM', not just 'Purchase'. Falls
      // back to the coarse bucket, then '—' for an on-account payment. A TRANSFER
      // (bank/cash contra) reads 'Transfer', matching its Bill-No badge.
      render: (v, row) => {
        if (row?.payment_category === 'REFUND') {
          return <span className="inline-block text-[10px] font-semibold rounded border px-1.5 py-0.5 bg-rose-50 text-rose-700 border-rose-200">Refund</span>;
        }
        if (row?.is_transfer) {
          return <span className="inline-block text-[10px] font-semibold rounded border px-1.5 py-0.5 bg-indigo-50 text-indigo-700 border-indigo-200">Contra</span>;
        }
        const fine = {
          RM: { label: 'RM', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
          PACKING: { label: 'Packing', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
          BOUGHT_NOTE: { label: 'Bought Note', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
          FRUIT: { label: 'Fruit', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
          MAIZE: { label: 'Maize', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
          FREIGHT: { label: 'Freight', cls: 'bg-teal-50 text-teal-700 border-teal-200' },
          EXPENSES: { label: 'Expense', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
          MACHINERY: { label: 'Machinery', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
          LAB_EXPENSE: { label: 'Lab', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
        }[(v || '').toUpperCase()];
        const coarse = {
          PURCHASE: { label: 'Purchase', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
          EXPENSE: { label: 'Expense', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
          FREIGHT: { label: 'Freight', cls: 'bg-teal-50 text-teal-700 border-teal-200' },
        }[(row?.bill_category || '').toUpperCase()];
        // No linked-bill category (an on-account payment)? Fall back to the VENDOR
        // MASTER's category (vendor_type) so the row still reads RM / Packing /
        // Expense etc. — shown lighter to signal it's from the master, not a bill.
        const vmeta = {
          RAW_MATERIAL: { label: 'RM', cls: 'bg-emerald-50/60 text-emerald-600 border-emerald-100' },
          MATERIAL: { label: 'RM', cls: 'bg-emerald-50/60 text-emerald-600 border-emerald-100' },
          PACKING_MATERIAL: { label: 'Packing', cls: 'bg-sky-50/60 text-sky-600 border-sky-100' },
          EXPENSE: { label: 'Expense', cls: 'bg-amber-50/60 text-amber-600 border-amber-100' },
          // Transporter vendors (vendor_type=['TRANSPORTER']) — show Freight, so
          // on-account transporter payments don't read as a blank category.
          TRANSPORTER: { label: 'Freight', cls: 'bg-teal-50/60 text-teal-600 border-teal-100' },
          FREIGHT: { label: 'Freight', cls: 'bg-teal-50/60 text-teal-600 border-teal-100' },
          CONTRACTOR: { label: 'Expense', cls: 'bg-amber-50/60 text-amber-600 border-amber-100' },
          EMPLOYEE: { label: 'Expense', cls: 'bg-amber-50/60 text-amber-600 border-amber-100' },
        }[(row?.vendor_category || '').toUpperCase()];
        const meta = fine || coarse || vmeta;
        return meta
          ? <span className={`inline-block text-[10px] font-semibold rounded border px-1.5 py-0.5 ${meta.cls}`}>{meta.label}</span>
          : <span className="text-slate-300 text-[11px]">—</span>;
      } },
    { key: 'bank_account_name', label: 'Account', sortable: true, render: (v) => v || '—' },
    // How the money moved — Cash / Bank / UPI / Cheque / NEFT / RTGS.
    { key: 'payment_mode', label: 'Mode', sortable: true,
      render: (v, row) => {
        const raw = (v || '').toUpperCase();
        if (!raw) return <span className="text-slate-300">—</span>;
        const MODE = {
          CASH: 'bg-emerald-50 text-emerald-700 border-emerald-200',
          BANK: 'bg-sky-50 text-sky-700 border-sky-200',
          BANK_TRANSFER: 'bg-sky-50 text-sky-700 border-sky-200',
          UPI: 'bg-violet-50 text-violet-700 border-violet-200',
          CHEQUE: 'bg-amber-50 text-amber-700 border-amber-200',
          NEFT: 'bg-indigo-50 text-indigo-700 border-indigo-200',
          RTGS: 'bg-indigo-50 text-indigo-700 border-indigo-200',
        };
        const label = (row.payment_mode_display || raw).replace(/_/g, ' ');
        return <span className={`inline-block text-[10px] font-semibold rounded border px-1.5 py-0.5 ${MODE[raw] || 'bg-slate-50 text-slate-600 border-slate-200'}`}>{label}</span>;
      } },
    // ERP payment voucher (payment_no — PAY-xxxxx, always present). The Tally
    // reference column is dropped: this standalone has no Tally integration.
    { key: 'payment_no', label: 'ERP Ref', sortable: true,
      render: (v) => v
        ? <span className="font-mono text-[11px] text-indigo-600">{v}</span>
        : <span className="text-slate-300 text-[11px]">—</span> },
    // Where the payment came from — Tally (Day-Book voucher OR bank-statement
    // import: a BK-… reference / a bank account) vs ERP (hand-entered, none of
    // those), like the Bills page SOURCE column. Computed from the row (see
    // paymentIsTally) so it's right even if the API hasn't sent source_origin.
    { key: 'source_origin', label: 'Source', sortable: true,
      render: (_, row) => paymentIsTally(row)
        ? <span className="inline-block text-[10px] font-semibold rounded border px-1.5 py-0.5 bg-teal-50 text-teal-700 border-teal-200" title="From Tally / bank import">Tally</span>
        : <span className="inline-block text-[10px] font-semibold rounded border px-1.5 py-0.5 bg-indigo-50 text-indigo-700 border-indigo-200" title="Recorded in the ERP">ERP</span> },
    { key: 'amount', label: 'Amount', sortable: true,
      footer: () => <span className="tabular-nums font-semibold">{formatCurrency(total)}</span>,
      render: (v) => <span className="tabular-nums font-semibold text-slate-800">{formatCurrency(v)}</span> },
  ];

  const hasFilter = period.range || company || kind || cats.size > 0 || src || q.trim();

  // Metric strip — same design as the Bills page summary band (.metric-band
  // cells), rendered AFTER the filter row so the page reads filter → tiles.
  const metricStrip = (
    <div className="metric-band mb-3">
      <div className="px-3 py-2">
        <p className="text-[11px] text-slate-500">Entries</p>
        <p className="text-sm font-bold text-slate-900 tabular-nums">{rows.length.toLocaleString('en-IN')}</p>
      </div>
      <div className="px-3 py-2">
        <p className="text-[11px] text-slate-500">Total</p>
        <p className="text-sm font-bold text-slate-900 money">{formatCurrency(total)}</p>
      </div>
      <div className="px-3 py-2">
        <p className="text-[11px] text-slate-500">On account</p>
        <p className={`text-sm font-bold money ${onAcct ? 'text-amber-600' : 'text-slate-900'}`}>{formatCurrency(onAcct)}</p>
      </div>
      <div className="px-3 py-2">
        <p className="text-[11px] text-slate-500">Contra</p>
        <p className={`text-sm font-bold money ${transferTotal ? 'text-indigo-600' : 'text-slate-900'}`}>{formatCurrency(transferTotal)}</p>
      </div>
    </div>
  );

  return (
    <MainLayout>
      <PageHeader  title="Payment Entries"
        breadcrumbs={[{ label: 'Purchase', href: '/purchase/dashboard' }, { label: 'Payment Entries' }]} />

      {/* Tabs: the plain entries list, and a By-Category reconciliation that
          sums to the Amount Paid total. */}
      <div className="mb-3 flex gap-5 border-b border-slate-200 text-sm">
        {[['list', 'List'], ['bycat', 'By Category']].map(([k, lbl]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={`pb-2 -mb-px border-b-2 ${tab === k ? 'border-indigo-500 text-indigo-600 font-semibold' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>
            {lbl}{k === 'bycat' && catTotals.length ? ` · ${catTotals.length}` : ''}
          </button>
        ))}
      </div>

      {/* Period + company apply to BOTH tabs, so the reconciliation respects
          the chosen window / company. */}
      {tab === 'bycat' && (
        <div className={`${CTRL_ROW} mb-3`}>
          <PeriodNavigator allowAll {...period.navProps} />
          {/* Company comes from the global header filter — no local dropdown. */}
        </div>
      )}
      {tab === 'bycat' && metricStrip}

      {/* ── By-Category reconciliation: every payment in one bucket, summing to
          the Amount Paid total. Click a row to see its payments in a popup. ── */}
      {tab === 'bycat' && (() => {
        const DOT = {
          RM: 'bg-emerald-500', MAIZE: 'bg-amber-500', BOUGHT_NOTE: 'bg-indigo-500',
          PACKING: 'bg-sky-500', FRUIT: 'bg-rose-500', FREIGHT: 'bg-teal-500',
          EXPENSE: 'bg-orange-500', MACHINERY: 'bg-slate-500',
          TRANSFER: 'bg-indigo-500', REFUND: 'bg-rose-400',
        };
        const BAR = {
          RM: 'bg-emerald-400', MAIZE: 'bg-amber-400', BOUGHT_NOTE: 'bg-indigo-400',
          PACKING: 'bg-sky-400', FRUIT: 'bg-rose-400', FREIGHT: 'bg-teal-400',
          EXPENSE: 'bg-orange-400', MACHINERY: 'bg-slate-400',
          TRANSFER: 'bg-indigo-400', REFUND: 'bg-rose-300',
        };
        return (
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-100">
              <div className="flex items-center gap-2 text-slate-700">
                <Layers size={18} className="text-indigo-600" />
                <span className="font-semibold">Amount Paid — by category</span>
              </div>
              <div className="text-right">
                <div className="text-lg font-bold text-slate-900 tabular-nums">{formatCurrency(catPaidTotal)}</div>
                <div className="text-[11px] text-slate-400">{rows.length.toLocaleString('en-IN')} payments · reconciles to total</div>
              </div>
            </div>
            <div className="divide-y divide-slate-100">
              {catTotals.length === 0 ? (
                <p className="text-sm text-slate-500 px-5 py-8 text-center">No payments in this period.</p>
              ) : catTotals.map((c) => {
                const pct = catPaidTotal ? (c.amount / catPaidTotal) * 100 : 0;
                // Click → switch to the List tab filtered to this category. The
                // filter + tab live in the URL, so browser Back returns here.
                const openCategory = () => {
                  if (c.key === 'TRANSFER') { setKind('transfer'); setCats(new Set()); }
                  else if (c.key === 'REFUND') { setKind('refund'); setCats(new Set()); }
                  else { setCats(new Set([c.key])); setKind(''); }
                  setTab('list');
                };
                return (
                  <button key={c.key} type="button" onClick={openCategory}
                    className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-slate-50 transition">
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[c.key] || 'bg-slate-300'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-medium text-slate-700">{c.label}</span>
                        <span className="text-sm font-bold tabular-nums text-slate-900">{formatCurrency(c.amount)}</span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                          <div className={`h-full rounded-full ${BAR[c.key] || 'bg-slate-300'}`} style={{ width: `${Math.max(pct, 2)}%` }} />
                        </div>
                        <span className="w-24 shrink-0 text-right text-[11px] tabular-nums text-slate-400">
                          {pct.toFixed(1)}% · {c.count} pmt
                        </span>
                      </div>
                    </div>
                    <ChevronDown size={15} className="shrink-0 -rotate-90 text-slate-300" />
                  </button>
                );
              })}
            </div>
            {/* Reconciliation footer — Σ categories = total, zero deviation. */}
            <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 bg-slate-50 rounded-b-xl">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Total Amount Paid</span>
              <span className="text-sm font-bold tabular-nums text-slate-900">{formatCurrency(catPaidTotal)}</span>
            </div>
          </div>
        );
      })()}


      {/* One filter row, Bills-style: period → company → bill/on-account, Clear. */}
      {tab === 'list' && (<>
      <div className={`${CTRL_ROW} mb-3`}>
        <PeriodNavigator allowAll {...period.navProps} />
        {/* Company comes from the global header filter — no local dropdown. */}
        {/* Category — MULTI-select. Pick any combination; a row matches if its
            resolved category is among the chosen. */}
        <div ref={catFilterRef} className="relative">
          <button type="button" onClick={() => setCatFilterOpen((v) => !v)}
            title="Filter by one or more spend categories"
            className={`${CTRL_FIELD} max-w-[200px] inline-flex items-center justify-between gap-2 cursor-pointer
              ${catFilterOpen ? 'ring-2 ring-indigo-200 border-indigo-300' : ''}`}>
            <span className={`truncate ${cats.size ? 'text-slate-800' : 'text-slate-400'}`}>
              {cats.size === 0 ? 'All Categories'
                : cats.size === 1 ? (CAT_LABELS[[...cats][0]] || [...cats][0])
                : `${cats.size} categories`}
            </span>
            <ChevronDown size={16} className={`shrink-0 text-slate-400 transition-transform ${catFilterOpen ? 'rotate-180' : ''}`} />
          </button>
          {catFilterOpen && (
            <div className="absolute left-0 z-[200] mt-1 w-56 rounded-lg border border-slate-200 bg-white py-1 shadow-xl">
              <div className="flex items-center justify-between px-3 py-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Categories</span>
                {cats.size > 0 && (
                  <button type="button" onClick={() => setCats(new Set())}
                    className="text-[11px] text-indigo-600 hover:underline">Clear</button>
                )}
              </div>
              <div className="max-h-[300px] overflow-auto">
                {CAT_ORDER.map((k) => {
                  const on = cats.has(k);
                  return (
                    <button key={k} type="button"
                      onClick={() => setCats((prev) => {
                        const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n;
                      })}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-slate-50">
                      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border
                        ${on ? 'border-indigo-500 bg-indigo-500' : 'border-slate-300 bg-white'}`}>
                        {on && <Check size={12} className="text-white" />}
                      </span>
                      <span className="text-slate-700">{CAT_LABELS[k] || k}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <CustomSelect value={src} onChange={(e) => setSrc(e.target.value)}
          title="Where the payment came from" className={`${CTRL_FIELD} max-w-[150px]`}>
          <option value="">All Sources</option>
          <option value="TALLY">Tally</option>
          <option value="ERP">ERP</option>
        </CustomSelect>
        <CustomSelect value={kind} onChange={(e) => setKind(e.target.value)}
          title="Applied to a bill, or recorded on account" className={`${CTRL_FIELD} max-w-[170px]`}>
          <option value="">All Payments</option>
          <option value="bill">Applied to a bill</option>
          <option value="onaccount">On account</option>
          <option value="transfer">Contra (bank/cash)</option>
          <option value="refund">Refund received</option>
        </CustomSelect>
        {hasFilter && (
          <button type="button"
            onClick={() => { period.navProps.setPeriod('all'); setCompany(''); setKind(''); setCats(new Set()); setSrc(''); setQ(''); }}
            className="text-xs text-slate-500 hover:text-slate-800 underline">Clear</button>
        )}
      </div>

      {metricStrip}

      <ListState error={error} onRetry={refetch} errorMessage="Failed to load payments.">
        <DataTable
          persistKey="payment-entries"
          exportFileName="payment-entries"
          columns={columns}
          data={rows}
          isLoading={isLoading}
          pageSize={25}
          onSearch={setQ}
          searchPlaceholder="Search vendor / payment no / reference / bill…"
          onRowClick={(r) => navigate(`/purchase/payments-made/${r.id}`)}
        />
      </ListState>
      </>)}
    </MainLayout>
  );
}
