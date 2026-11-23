import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowDownLeft, ArrowUpRight, AlertTriangle,
  TrendingUp, PiggyBank, RotateCcw, ChevronRight, Loader2, Database,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatsCard from '../../../components/common/StatsCard';
import StatusBadge from '../../../components/common/StatusBadge';
import CustomSelect from '../../../components/ui/CustomSelect';
import CustomDatePicker from '../../../components/ui/CustomDatePicker';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import useGuardedNavigate from '../../../hooks/useGuardedNavigate.js';
import { formatCurrency, formatCompactCurrency, formatDate } from '../../../utils/formatters.js';

// ── helpers ────────────────────────────────────────────────────────────
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const pick = (row, keys, fallback = '') => {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
};
const isoDate = (v) => (v ? String(v).slice(0, 10) : '');

const SOURCE_COLORS = {
  'Vendor Ledger': 'bg-rose-50 text-rose-700',
  'Vendor Bill': 'bg-rose-50 text-rose-700',
  'Payment Made': 'bg-orange-50 text-orange-700',
  'Customer Ledger': 'bg-emerald-50 text-emerald-700',
  'Receivable': 'bg-emerald-50 text-emerald-700',
  'Customer Advance': 'bg-teal-50 text-teal-700',
  'Freight Ledger': 'bg-indigo-50 text-indigo-700',
  'Inward Freight': 'bg-indigo-50 text-indigo-700',
  'Outward Freight': 'bg-sky-50 text-sky-700',
  'Wage Ledger': 'bg-violet-50 text-violet-700',
  'Production Wage': 'bg-violet-50 text-violet-700',
  'Credit/Debit Note': 'bg-amber-50 text-amber-700',
};
// Module chips shown above the table (always visible, even when empty).
const MODULE_ORDER = ['Purchase', 'Sales', 'Inward', 'Outward', 'Wage'];

// ── per-row document trail (hyperlinked chain) ──────────────────────────
function RefChip({ label, value, to, go }) {
  if (!value && !to) return null;
  const inner = (
    <>
      <span className="text-[10px] uppercase tracking-wide text-slate-400 leading-none">{label}</span>
      <span className="font-medium leading-tight">{value || 'Open'}</span>
    </>
  );
  return to ? (
    <button
      onClick={() => go(to)}
      className="flex flex-col items-start px-3 py-2 rounded-lg border border-primary-200 bg-primary-50 hover:bg-primary-100 text-primary-700 text-sm transition text-left"
    >
      {inner}
    </button>
  ) : (
    <div className="flex flex-col items-start px-3 py-2 rounded-lg border border-slate-200 bg-slate-50 text-slate-600 text-sm">
      {inner}
    </div>
  );
}

function TrackingChain({ row, go }) {
  const raw = row._raw || {};
  const [extra, setExtra] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (row.source === 'Vendor Bill' && raw.purchase_order) {
          setLoading(true);
          const poRes = await apiClient.get(`/api/purchase/orders/${raw.purchase_order}/`);
          let rfq = null;
          if (poRes.data?.linked_rfq) {
            try { rfq = (await apiClient.get(`/api/purchase/rfq/${poRes.data.linked_rfq}/`)).data; } catch { /* ignore */ }
          }
          if (!cancelled) setExtra({ po: poRes.data, rfq });
        } else if (row.source === 'Receivable' && raw.invoice_reference) {
          setLoading(true);
          const inv = await apiClient.get(`/api/sales/invoices/${raw.invoice_reference}/`);
          if (!cancelled) setExtra({ invoice: inv.data });
        } else if (row.source === 'Payment Made' && raw.bill) {
          setLoading(true);
          const bill = await apiClient.get(`/api/purchase/bills/${raw.bill}/`);
          if (!cancelled) setExtra({ bill: bill.data });
        }
      } catch { /* graceful: show what we have */ } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [row]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build the chain (oldest → newest) per source.
  const chips = [];
  if (row.source === 'Vendor Bill') {
    const prIds = extra?.po?.linked_prs || [];
    const prNos = extra?.po?.linked_pr_numbers || [];
    prIds.forEach((id, i) => chips.push({ label: 'Purchase Request', value: prNos[i] || 'PR', to: `/purchase/requests/${id}` }));
    if (extra?.rfq || extra?.po?.linked_rfq) {
      chips.push({ label: 'RFQ', value: extra?.rfq?.rfq_no || 'RFQ', to: extra?.po?.linked_rfq ? `/purchase/rfq/${extra.po.linked_rfq}` : null });
    }
    chips.push({ label: 'Purchase Order', value: raw.po_no, to: raw.purchase_order ? `/purchase/orders/${raw.purchase_order}` : null });
    chips.push({ label: 'Receipt', value: raw.receipt_no, to: raw.receipt_advice ? `/purchase/receipts/${raw.receipt_advice}` : null });
    chips.push({ label: 'Vendor Bill', value: raw.bill_no, to: `/purchase/bills/${raw.id}` });
  } else if (row.source === 'Receivable') {
    chips.push({ label: 'Sales Order', value: extra?.invoice?.so_no, to: extra?.invoice?.so_reference ? `/sales/orders/${extra.invoice.so_reference}` : null });
    chips.push({ label: 'Dispatch Challan', value: extra?.invoice?.dc_no, to: extra?.invoice?.dc_reference ? `/sales/dc/${extra.invoice.dc_reference}` : null });
    chips.push({ label: 'Invoice', value: raw.invoice_no, to: raw.invoice_reference ? `/sales/invoices/${raw.invoice_reference}` : null });
    chips.push({ label: 'Receivable', value: raw.invoice_no || 'Receivable', to: `/sales/receivables/${raw.id}` });
  } else if (row.source === 'Payment Made') {
    chips.push({ label: 'Vendor Bill', value: extra?.bill?.bill_no, to: raw.bill ? `/purchase/bills/${raw.bill}` : null });
    chips.push({ label: 'Payment', value: raw.payment_no, to: row.link });
  } else if (row.source === 'Customer Advance') {
    chips.push({ label: 'Advance', value: raw.advance_no, to: row.link });
  } else if (row.source === 'Inward Freight') {
    chips.push({ label: 'Receipt', value: raw.receipt_advice_no, to: raw.receipt_advice ? `/purchase/receipts/${raw.receipt_advice}` : null });
    chips.push({ label: 'Inward Freight', value: raw.advice_no, to: `/freight/purchase/${raw.id}` });
  } else if (row.source === 'Outward Freight') {
    (raw.dc_ids || []).forEach((id) => chips.push({ label: 'Dispatch Challan', value: 'DC', to: `/sales/dc/${id}` }));
    chips.push({ label: 'Outward Freight', value: raw.advice_no, to: `/freight/sales/${raw.id}` });
  } else if (row.source === 'Production Wage') {
    chips.push({ label: 'Work Order', value: raw.work_order_no, to: raw.work_order ? `/production/work-orders/${raw.work_order}` : null });
    chips.push({ label: 'Packing', value: raw.packing_no, to: raw.packing_process ? `/production/packing-processes/${raw.packing_process}` : null });
    chips.push({ label: 'Wage Voucher', value: raw.voucher_no, to: `/production/wage-vouchers/${raw.id}` });
  } else {
    // Ledgers / freight / wage / notes — show the document type + the
    // row's own destination. Ledger doc refs are opaque ids with no
    // dedicated detail route, so they render as plain context chips.
    if (row.reference) chips.push({ label: 'Reference', value: String(row.reference).slice(0, 24), to: null });
    chips.push({ label: row.source, value: 'Open', to: row.link });
  }

  const visible = chips.filter((c) => c.value || c.to);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 text-sm text-slate-500">
        <span>{row.party}</span>
        <span className="text-slate-300">·</span>
        <span className="font-medium text-slate-700">{formatCurrency(row.amount)}</span>
        {loading && <Loader2 size={14} className="animate-spin text-slate-400" />}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {visible.map((c, i) => (
          <span key={i} className="flex items-center gap-2">
            {i > 0 && <ChevronRight size={15} className="text-slate-300 shrink-0" />}
            <RefChip {...c} go={go} />
          </span>
        ))}
      </div>
      <p className="mt-3 text-xs text-slate-400">Click any document to open it. Greyed chips have no linked record.</p>
    </div>
  );
}

export default function FinanceDashboard() {
  const { canExport, isAdmin, isSuperuser } = usePermissions();
  // Permission-aware navigation: raises a toast instead of routing the user
  // into a denied redirect when they lack view access to the target module.
  const go = useGuardedNavigate();

  const vendorLedger   = useApiData('/api/finance/vendor-ledger/');
  const customerLedger = useApiData('/api/finance/customer-ledger/');
  const bills          = useApiData('/api/purchase/bills/');
  const paymentsMade   = useApiData('/api/purchase/payments-made/');
  const receivables    = useApiData('/api/sales/receivables/');
  const advances       = useApiData('/api/sales/advances/');
  // Operational freight + wage documents — the actual inward/outward
  // freight (purchase/sales) and production wage vouchers, which carry
  // the real data the finance freight/wage ledgers post from.
  const inwardFreight  = useApiData('/api/purchase/freight/');
  const outwardFreight = useApiData('/api/sales/freight/');
  const prodWage       = useApiData('/api/production/wage-vouchers/');

  const allSources = [vendorLedger, customerLedger, bills, paymentsMade, receivables, advances, inwardFreight, outwardFreight, prodWage];
  const isLoading = allSources.some((s) => s.isLoading);

  const rows = useMemo(() => {
    const out = [];
    const add = (o, raw) => out.push({ ...o, _raw: raw });

    (vendorLedger.data || []).forEach((r) => add({
      id: `vl-${r.id}`, date: isoDate(r.document_date), source: 'Vendor Ledger', module: 'Purchase', category: 'Payable',
      party: pick(r, ['vendor_name'], '—'), reference: pick(r, ['document_type', 'document_reference_id']),
      amount: num(r.debit_amount) - num(r.credit_amount), outstanding: num(r.debit_amount) - num(r.credit_amount),
      status: r.payment_status || '', link: `/import/ledgers?party=${encodeURIComponent(pick(r, ['vendor_name'], ''))}`,
    }, r));

    (customerLedger.data || []).forEach((r) => add({
      id: `cl-${r.id}`, date: isoDate(r.document_date), source: 'Customer Ledger', module: 'Sales', category: 'Receivable',
      party: pick(r, ['customer_name'], '—'), reference: pick(r, ['document_type', 'document_reference_id']),
      amount: num(r.debit_amount) - num(r.credit_amount), outstanding: num(r.debit_amount) - num(r.credit_amount),
      status: r.payment_status || '', link: `/import/ledgers?party=${encodeURIComponent(pick(r, ['customer_name'], ''))}`,
    }, r));

    (bills.data || []).forEach((r) => add({
      id: `vb-${r.id}`, date: isoDate(r.bill_date), source: 'Vendor Bill', module: 'Purchase', category: 'Payable',
      party: pick(r, ['vendor_name'], '—'), reference: pick(r, ['bill_no', 'vendor_invoice_no']),
      amount: num(r.total_amount), outstanding: num(pick(r, ['balance_due'], num(r.total_amount) - num(r.amount_paid))),
      status: r.status || '', link: `/purchase/bills/${r.id}`,
    }, r));

    (paymentsMade.data || []).forEach((r) => add({
      id: `pm-${r.id}`, date: isoDate(r.payment_date), source: 'Payment Made', module: 'Purchase', category: 'Payable',
      party: pick(r, ['vendor_name'], '—'), reference: pick(r, ['payment_no', 'reference_no']),
      amount: num(r.amount), outstanding: 0, status: r.status || '', link: '/purchase/payments-made',
    }, r));

    (receivables.data || []).forEach((r) => add({
      id: `rc-${r.id}`, date: isoDate(pick(r, ['invoice_date', 'due_date'])), source: 'Receivable', module: 'Sales', category: 'Receivable',
      party: pick(r, ['customer_name'], '—'), reference: pick(r, ['invoice_no']),
      amount: num(r.amount), outstanding: num(r.balance), status: r.payment_status || '', link: `/sales/receivables/${r.id}`,
    }, r));

    (advances.data || []).forEach((r) => add({
      id: `ca-${r.id}`, date: isoDate(r.received_date), source: 'Customer Advance', module: 'Sales', category: 'Receivable',
      party: pick(r, ['customer_name'], '—'), reference: pick(r, ['advance_no', 'reference_no']),
      amount: num(r.amount), outstanding: num(r.balance_unused), status: r.status || '', link: `/sales/advances/${r.id}`,
    }, r));

    (inwardFreight.data || []).forEach((r) => add({
      id: `if-${r.id}`, date: isoDate(pick(r, ['freight_date', 'created_date'])), source: 'Inward Freight', module: 'Inward', category: 'Payable',
      party: pick(r, ['transporter_name'], '—'), reference: pick(r, ['advice_no', 'receipt_advice_no']),
      amount: num(pick(r, ['payable_amount', 'base_amount'])), outstanding: num(r.balance),
      status: r.status || '', link: `/freight/purchase/${r.id}`,
    }, r));

    (outwardFreight.data || []).forEach((r) => add({
      id: `of-${r.id}`, date: isoDate(pick(r, ['freight_date', 'created_date'])), source: 'Outward Freight', module: 'Outward', category: 'Payable',
      party: pick(r, ['transporter_name', 'customer_name'], '—'), reference: pick(r, ['advice_no']),
      amount: num(pick(r, ['payable_amount', 'base_amount'])), outstanding: num(r.balance),
      status: r.status || '', link: `/freight/sales/${r.id}`,
    }, r));

    (prodWage.data || []).forEach((r) => add({
      id: `pw-${r.id}`, date: isoDate(r.prepared_date), source: 'Production Wage', module: 'Wage', category: 'Payable',
      party: pick(r, ['work_order_no', 'packing_no', 'prepared_by_name'], 'Wage'), reference: pick(r, ['voucher_no']),
      amount: num(r.amount), outstanding: num(pick(r, ['net_amount'], r.amount)),
      status: r.status || '', link: `/production/wage-vouchers/${r.id}`,
    }, r));

    return out;
  }, [vendorLedger.data, customerLedger.data, bills.data, paymentsMade.data, receivables.data, advances.data, inwardFreight.data, outwardFreight.data, prodWage.data]);

  const kpis = useMemo(() => {
    const recvOutstanding = (receivables.data || []).reduce((s, r) => s + Math.max(0, num(r.balance)), 0);
    const recvOverdue = (receivables.data || []).filter((r) => r.payment_status === 'OVERDUE').reduce((s, r) => s + Math.max(0, num(r.balance)), 0);
    const payOutstanding = (bills.data || []).reduce((s, r) => s + Math.max(0, num(pick(r, ['balance_due'], num(r.total_amount) - num(r.amount_paid)))), 0);
    const payOverdue = (bills.data || []).filter((r) => r.status === 'OVERDUE').reduce((s, r) => s + Math.max(0, num(pick(r, ['balance_due'], num(r.total_amount) - num(r.amount_paid)))), 0);
    const advanceUnused = (advances.data || []).reduce((s, r) => s + Math.max(0, num(r.balance_unused)), 0);
    return { recvOutstanding, recvOverdue, payOutstanding, payOverdue, advanceUnused, netPosition: recvOutstanding - payOutstanding };
  }, [receivables.data, bills.data, advances.data]);

  // ── filters ─────────────────────────────────────────────────────────
  // Filters live in the URL so opening a record and pressing Back — or a
  // refresh / shared link — restores the same filtered view. Seeded from the
  // query string on mount; a single writeback effect syncs the whole object
  // back (one setSearchParams call, so the many atomic multi-key updates below
  // — KPI cards, module chips, the Past-N-days preset — stay intact).
  const blankFilters = { module: '', source: '', category: '', status: '', party: '', from: '', to: '' };
  const [sp, setSp] = useSearchParams();
  const [filters, setFilters] = useState(() => ({
    module: sp.get('module') || '', source: sp.get('source') || '', category: sp.get('category') || '',
    status: sp.get('status') || '', party: sp.get('party') || '', from: sp.get('from') || '', to: sp.get('to') || '',
  }));
  const [pastPreset, setPastPreset] = useState('');

  useEffect(() => {
    const p = new URLSearchParams(sp);
    const put = (k, val) => { if (val) p.set(k, val); else p.delete(k); };
    put('module', filters.module);
    put('source', filters.source);
    put('category', filters.category);
    put('status', filters.status);
    put('party', filters.party);
    put('from', filters.from);
    put('to', filters.to);
    if (p.toString() !== sp.toString()) setSp(p, { replace: true });
  }, [filters, sp, setSp]);
  const setFilter = (k, v) => {
    // Editing From/To by hand drops the "Past N days" quick label.
    if (k === 'from' || k === 'to') setPastPreset('');
    setFilters((p) => ({ ...p, [k]: v }));
  };
  const resetFilters = () => { setPastPreset(''); setFilters(blankFilters); };
  // "Past N days" quick range → today−(N−1) … today (so "1 day" = today only).
  const applyPastPreset = (v) => {
    setPastPreset(v);
    if (!v) return;
    const iso = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
    const today = new Date();
    const from = new Date(today); from.setDate(from.getDate() - (Number(v) - 1));
    setFilters((p) => ({ ...p, from: iso(from), to: iso(today) }));
  };
  // A module chip is the headline filter — show ALL of that module's data.
  const pickModule = (m) => setFilters({ ...blankFilters, module: m });

  // Always show the full module set so Inward / Outward / Wage / Finance
  // are available as filters even before any data exists for them.
  const moduleChips = MODULE_ORDER;
  const sourceOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.source))).sort().map((s) => ({ value: s, label: s })),
    [rows],
  );
  const statusOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.status).filter(Boolean))).sort().map((s) => ({ value: s, label: s })),
    [rows],
  );
  // Party = vendor / customer / transporter name carried on every row.
  const partyOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.party).filter((p) => p && p !== '—'))).sort((a, b) => a.localeCompare(b)).map((s) => ({ value: s, label: s })),
    [rows],
  );

  const [sortBy, setSortBy] = useState('date');
  const [sortOrder, setSortOrder] = useState('desc');

  const filteredRows = useMemo(() => {
    let data = rows.filter((r) => {
      if (filters.module && r.module !== filters.module) return false;
      if (filters.source && r.source !== filters.source) return false;
      if (filters.category && r.category !== filters.category) return false;
      if (filters.status && r.status !== filters.status) return false;
      if (filters.party && r.party !== filters.party) return false;
      if (filters.from && r.date && r.date < filters.from) return false;
      if (filters.to && r.date && r.date > filters.to) return false;
      return true;
    });
    const dir = sortOrder === 'asc' ? 1 : -1;
    const numeric = sortBy === 'amount' || sortBy === 'outstanding';
    data = [...data].sort((a, b) => {
      const av = a[sortBy], bv = b[sortBy];
      if (numeric) return (num(av) - num(bv)) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return data;
  }, [rows, filters, sortBy, sortOrder]);

  // Totals for the CURRENTLY-FILTERED set — recompute live as the date
  // range (or any filter) changes, so the summary always matches the table.
  const filteredTotals = useMemo(() => {
    let totalAmount = 0, totalOutstanding = 0, receivable = 0, payable = 0;
    for (const r of filteredRows) {
      const amt = num(r.amount), out = Math.max(0, num(r.outstanding));
      totalAmount += amt;
      totalOutstanding += out;
      if (r.category === 'Receivable') receivable += out;
      else if (r.category === 'Payable') payable += out;
    }
    return { count: filteredRows.length, totalAmount, totalOutstanding, receivable, payable };
  }, [filteredRows]);

  const columns = [
    { field: 'date', header: 'Date', render: (v) => (v ? formatDate(v) : '—') },
    {
      field: 'source', header: 'Source',
      render: (v) => <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${SOURCE_COLORS[v] || 'bg-slate-100 text-slate-700'}`}>{v}</span>,
    },
    {
      field: 'category', header: 'Type',
      render: (v) => (
        <span className={`inline-flex items-center gap-1 text-xs font-medium ${v === 'Receivable' ? 'text-emerald-700' : 'text-rose-700'}`}>
          {v === 'Receivable' ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}{v}
        </span>
      ),
    },
    { field: 'party', header: 'Party' },
    { field: 'reference', header: 'Reference' },
    { field: 'amount', header: 'Amount', render: (v) => <span className="font-medium tabular-nums">{formatCurrency(v)}</span> },
    {
      field: 'outstanding', header: 'Outstanding',
      render: (v) => <span className={`tabular-nums ${num(v) > 0 ? 'font-semibold text-slate-900' : 'text-slate-400'}`}>{formatCurrency(v)}</span>,
    },
    { field: 'status', header: 'Status', render: (v) => (v ? <StatusBadge status={v} /> : '—') },
  ];

  const chipBase = 'px-3.5 py-1.5 rounded-full text-sm font-medium border transition whitespace-nowrap';

  return (
    <MainLayout>
      <PageHeader
        title="Finance Dashboard"
        subtitle="Payables, receivables and ledgers across Finance, Purchase & Sales"
        breadcrumbs={[{ label: 'Finance', path: '/finance/vendor-ledger' }, { label: 'Dashboard' }]}
        actions={{
          onPrint: () => window.print(),
          right: (isAdmin || isSuperuser) ? (
            <button
              type="button"
              onClick={() => go('/finance/data-tools')}
              className="print:hidden inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-sm font-medium text-slate-600 hover:bg-slate-50"
              title="Import opening balances — receivables & payables (admin only)"
            >
              <Database className="w-4 h-4" /> Import Data
            </button>
          ) : null,
        }}
      />

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2.5 sm:gap-3 mb-5">
        <StatsCard icon={ArrowDownLeft} label="Receivables Outstanding" value={formatCompactCurrency(kpis.recvOutstanding)}
          isLoading={isLoading} onClick={() => setFilters({ ...blankFilters, category: 'Receivable' })} />
        <StatsCard icon={ArrowUpRight} label="Payables Outstanding" value={formatCompactCurrency(kpis.payOutstanding)}
          isLoading={isLoading} onClick={() => setFilters({ ...blankFilters, category: 'Payable' })} />
        <StatsCard icon={TrendingUp} label="Net Position" value={formatCompactCurrency(kpis.netPosition)}
          isLoading={isLoading} onClick={resetFilters} />
        <StatsCard icon={AlertTriangle} label="Overdue Receivables" value={formatCompactCurrency(kpis.recvOverdue)}
          isLoading={isLoading} onClick={() => setFilters({ ...blankFilters, source: 'Receivable', status: 'OVERDUE' })} />
        <StatsCard icon={AlertTriangle} label="Overdue Payables" value={formatCompactCurrency(kpis.payOverdue)}
          isLoading={isLoading} onClick={() => setFilters({ ...blankFilters, source: 'Vendor Bill', status: 'OVERDUE' })} />
        <StatsCard icon={PiggyBank} label="Customer Advances" value={formatCompactCurrency(kpis.advanceUnused)}
          isLoading={isLoading} onClick={() => setFilters({ ...blankFilters, source: 'Customer Advance' })} />
      </div>

      {/* Module chips — the headline "show me everything from X" filter */}
      <div className="flex items-center gap-2 mb-4 overflow-x-auto pb-1">
        <button onClick={resetFilters}
          className={`${chipBase} ${!filters.module ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}>
          All ({rows.length})
        </button>
        {moduleChips.map((m) => {
          const count = rows.filter((r) => r.module === m).length;
          const active = filters.module === m;
          return (
            <button key={m} onClick={() => pickModule(m)}
              className={`${chipBase} ${active ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}>
              {m} ({count})
            </button>
          );
        })}
      </div>

      {/* Fine-grained filters */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
        {/* Compact quick range — sets From/To to the last N days. */}
        <div className="flex items-center gap-2 mb-3 pb-3 border-b border-slate-100">
          <span className="text-xs font-medium text-slate-500">Past</span>
          <CustomSelect value={pastPreset} onChange={(e) => applyPastPreset(e.target.value)} className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm">
            <option value="">— custom range —</option>
            <option value="1">1 day (today)</option>
            <option value="7">7 days</option>
            <option value="15">15 days</option>
            <option value="30">30 days</option>
            <option value="60">60 days</option>
          </CustomSelect>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Source</label>
            <CustomSelect value={filters.source} onChange={(e) => setFilter('source', e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">
              <option value="">All Sources</option>
              {sourceOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </CustomSelect>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Type</label>
            <CustomSelect value={filters.category} onChange={(e) => setFilter('category', e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">
              <option value="">All Types</option>
              <option value="Receivable">Receivable</option>
              <option value="Payable">Payable</option>
            </CustomSelect>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Party</label>
            <CustomSelect value={filters.party} onChange={(e) => setFilter('party', e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">
              <option value="">All Parties</option>
              {partyOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </CustomSelect>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Status</label>
            <CustomSelect value={filters.status} onChange={(e) => setFilter('status', e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm">
              <option value="">All Status</option>
              {statusOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </CustomSelect>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">From</label>
            <CustomDatePicker value={filters.from} onChange={(e) => setFilter('from', e.target.value)} max={filters.to || undefined} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">To</label>
            <CustomDatePicker value={filters.to} onChange={(e) => setFilter('to', e.target.value)} min={filters.from || undefined} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <button onClick={resetFilters} className="inline-flex items-center justify-center gap-1.5 w-full px-3 py-2 text-sm font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 transition">
              <RotateCcw size={14} /> Reset
            </button>
          </div>
        </div>
      </div>

      {/* Totals for the filtered set — recompute live with every filter,
          including the date range. */}
      <div className="bg-white rounded-lg border border-slate-200 px-3 sm:px-4 py-2.5 mb-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm">
        <span className="text-slate-500"><strong className="text-slate-800">{filteredTotals.count}</strong> txn{filteredTotals.count === 1 ? '' : 's'}</span>
        <span className="text-slate-500">Amount <strong className="text-slate-800 tabular-nums">{formatCurrency(filteredTotals.totalAmount)}</strong></span>
        <span className="text-slate-500">Outstanding <strong className="text-slate-800 tabular-nums">{formatCurrency(filteredTotals.totalOutstanding)}</strong></span>
        <span className="text-slate-500">Receivable <strong className="text-emerald-700 tabular-nums">{formatCurrency(filteredTotals.receivable)}</strong></span>
        <span className="text-slate-500">Payable <strong className="text-rose-700 tabular-nums">{formatCurrency(filteredTotals.payable)}</strong></span>
        {(filters.from || filters.to) && (
          <span className="text-xs text-slate-400 sm:ml-auto">for {filters.from || '…'} → {filters.to || '…'}</span>
        )}
      </div>

      {/* Unified transactions table — expand a row to see its document trail */}
      <DataTable persistKey="finance-dashboard"
        columns={columns}
        data={filteredRows}
        isLoading={isLoading}
        pageSize={15}
        sortBy={sortBy}
        sortOrder={sortOrder}
        onSort={(field, order) => { setSortBy(field); setSortOrder(order); }}
        onRowClick={(row) => go(row.link)}
        searchPlaceholder="Search party, reference, status…"
        exportFileName="finance-dashboard"
        canExport={canExport('Finance Dashboard')}
        emptyMessage="No finance records match the current filters."
        expandableContent={(row) => <TrackingChain row={row} go={go} />}
        expandAsModal
        expandModalTitle={(row) => `${row.source} · ${row.reference || ''} — Document trail`}
      />
    </MainLayout>
  );
}
