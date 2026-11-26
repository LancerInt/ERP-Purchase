/**
 * Reports — Sales / Purchase / Expense / Freight / Trend.
 *
 * Config-driven management reports. Each tab holds several reports (chips). The
 * first report in every tab is the original grouped "Top … by value" table,
 * kept verbatim (with its pagination, skeleton loader, blue styling and the
 * interactive by-month bar graph). Added on top: Ageing, item qty/rate trend,
 * category bars, a money Trend tab, cumulative concentration, Top-10 collapse,
 * Excel + PDF export, and clean deep-linking into the detail pages.
 *
 * Data: the same slim LIST endpoints the Bills / Invoices / Freight pages use,
 * fetched client-side and filtered by period + company, so the figures tie to
 * those pages. The one server read is the item qty/rate trend
 * (/api/sales/item-rate-trend/) — invoice/bill LINE rates aren't in any list
 * payload, so a tested endpoint aggregates them.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  BarChart3, Download, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, AlertTriangle,
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import ListState from '@/components/common/ListState.jsx';
import CustomSelect from '@/components/ui/CustomSelect';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import { useGlobalCompany } from '@/hooks/useGlobalCompany.js';
import { CTRL_ROW, CTRL_FIELD } from '@/components/common/controls';
import apiClient from '../../../utils/api.js';
import { categoryChipCls } from '../../../utils/constants.js';
import { formatCurrency } from '@/utils/formatters';
import exportToExcel from '../../../utils/exportExcel.js';

const num = (v) => Number(v) || 0;
const INR = (v) => formatCurrency(v || 0);
const pctTxt = (v) => `${(Number(v) || 0).toFixed(0)}%`;

// Purchase vs Expense split — the SAME rule the Bills page uses, so the Reports
// tabs tie to it. A bill is an Expense when flagged is_expense at scan, OR its
// Tally voucher is a journal, OR its spend category is Freight/Expenses/Lab/
// Machinery. A real Purchase is everything else (RM / Packing / Maize / Fruit /
// Bought Note, plus untagged bills that are pending-purchase). Mirrors
// bills/index.jsx isExpenseBill / isExpenseLike.
const EXPENSE_CATS = ['FREIGHT', 'EXPENSES', 'LAB_EXPENSE', 'MACHINERY'];
const isExpenseBill = (r) => r.is_expense === true
  || (r.tally_voucher_type || '').toLowerCase().includes('journal');
const isExpenseLike = (r) =>
  isExpenseBill(r) || EXPENSE_CATS.includes((r.purchase_category || '').toUpperCase());
const isPurchaseBill = (r) => !isExpenseLike(r);

// Category chip colour — the ONE shared RM/PM palette used app-wide.
const catChipCls = categoryChipCls;

// Month bucket + label for the "by month" block. '2026-11-03' → '2026-11' → 'Nov 2026'.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthKey = (d) => (d ? String(d).slice(0, 7) : '');
const monthLabel = (ym) => {
  const [y, m] = (ym || '').split('-');
  const mi = Number(m) - 1;
  return (mi >= 0 && mi < 12) ? `${MONTHS[mi]} ${y}` : ym;
};
// Short month label for trend column headers: '2026-05' -> 'May 26'.
const monthShort = (ym) => {
  const [y, m] = (ym || '').split('-');
  const mi = Number(m) - 1;
  return (mi >= 0 && mi < 12) ? `${MONTHS[mi]} ${(y || '').slice(2)}` : ym;
};
const fmtCr = (v) => {
  const n = num(v);
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
};

// Short, friendly company name, used when deep-linking (matches the other pages).
function niceCompany(raw) {
  const s = `${raw || ''}`.toLowerCase();
  if (/ssb|biochem|ss\s*bio/.test(s)) return 'SS Biochem';
  if (/uai|united|agro/.test(s)) return 'United Agro';
  return raw || '';
}

// Opening-balance carrier: a bill/invoice that only brings forward last year's
// closing balance on day 1 of the FY — NOT a real payable/receivable document.
// Its per-row balance_due is unreliable because the vendor's payments settle it
// at the running-ledger level (on-account), not onto this carrier's amount_paid
// — so it would otherwise sit in a "what to pay" view at its full opening amount
// forever (e.g. Morya Castor's ₹12,97,289, already down to ₹2.36L in the ledger).
// Mirrors the Bills page's exclude_opening=1 and the backend OPENING filters.
function isOpeningCarrier(r) {
  const inv = String(r.vendor_invoice_no || r.invoice_no || '').toUpperCase();
  const guid = String(r.tally_guid || '').toUpperCase();
  return inv === 'OPENING' || inv.startsWith('OPEN-') || guid.startsWith('OPENING');
}

// Purchase category → short label + badge colour, for the calendar's Category
// column. Mirrors the Purchase tab's categories (RM / Packing / Maize / Fruit /
// Bought Note / Freight / …); anything else shows its raw code.
const CAT_LABEL = {
  RM: 'RM', PACKING: 'PM', MAIZE: 'Maize', FRUIT: 'Fruit', BOUGHT_NOTE: 'Bought Note',
  FREIGHT: 'Freight', EXPENSES: 'Expense', MACHINERY: 'Machinery', LAB_EXPENSE: 'Lab',
  BRANCH: 'Branch',
};
function catLabel(code) {
  const c = (code || '').toUpperCase();
  if (!c) return '';
  return CAT_LABEL[c] || code;
}
function catTone(code) {
  return categoryChipCls(code);   // shared app-wide RM/PM palette
}

// Where a record was CREATED (mirrors purchase/source_classify.py):
//   'tally' = imported from Tally (has a tally_guid / tally_invoice_no) and NOT
//             scanned/hand-entered here; 'erp' = scanned/emailed/hand-entered
//             (a scan that later matched Tally is still ERP — you entered it).
// Purchase bills carry tally_guid + is_scanned/scan_tally_matched; sales
// invoices only expose tally_invoice_no, so that's the Tally marker there.
function recordSource(r) {
  const scanned = r.is_scanned === true || r.scan_tally_matched === true;
  const hasTally = !!(r.tally_guid && !String(r.tally_guid).startsWith('OPENING')) || !!r.tally_invoice_no;
  if (scanned) return 'erp';
  return hasTally ? 'tally' : 'erp';
}
function matchesSource(r, pick) {
  if (!pick) return true;
  return recordSource(r) === pick;
}

// Fetch every page of a list, optionally narrowing to a server-side date
// window so a month view pulls a month of rows, not the whole table. `win` is
// {from,to} ISO (null = everything) and `dateParam` is the endpoint's date
// field name ('bill_date' | 'invoice_date' | 'freight_date').
async function fetchAll(url, win, dateParam) {
  const params = ['page_size=500'];
  if (win && dateParam) {
    if (win.from) params.push(`${dateParam}_from=${win.from}`);
    if (win.to) params.push(`${dateParam}_to=${win.to}`);
  }
  const base = `${url}${url.includes('?') ? '&' : '?'}${params.join('&')}`;
  const out = [];
  let next = base;
  for (let i = 0; i < 60 && next; i++) {
    const { data } = await apiClient.get(next);
    const rows = Array.isArray(data) ? data : (data?.results || []);
    out.push(...rows);
    next = (!Array.isArray(data) && data?.next) ? data.next : null;
  }
  return out;
}

// ── Ageing (pure) ──────────────────────────────────────────────────────────
const BUCKETS = [
  { k: 'current', label: 'Current' }, { k: 'd1_30', label: '1–30' },
  { k: 'd31_60', label: '31–60' }, { k: 'd61_90', label: '61–90' },
  { k: 'd90p', label: '90+', tone: 'rose' },
];
function ageBucket(days) {
  if (days <= 0) return 'current';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90p';
}
function daysOverdue(iso, today) {
  if (!iso) return 0;
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return 0;
  return Math.round((today - d) / 86400000);
}

// Payment calendar (Payables tab): forward buckets by WHEN a bill falls due,
// soonest first. Relative to today, so the whole page re-buckets itself every
// day — a bill due tomorrow is in "Next 7 days" today and in "Overdue" once it
// passes. `test(days)` takes days-until-due (= -daysOverdue): >0 future, 0 today.
const PAY_BUCKETS = [
  { k: 'over',  title: 'Overdue',      when: 'already past due',       dot: 'bg-rose-600',    danger: true,  test: (dd) => dd !== null && dd < 0 },
  { k: 'today', title: 'Today',        when: 'due today',              dot: 'bg-orange-500',  test: (dd) => dd === 0 },
  { k: 'd7',    title: 'Next 7 days',  when: 'due within a week',      dot: 'bg-amber-500',   test: (dd) => dd !== null && dd >= 1 && dd <= 7 },
  { k: 'd15',   title: 'Next 15 days', when: '8–15 days',              dot: 'bg-blue-500',    test: (dd) => dd !== null && dd >= 8 && dd <= 15 },
  { k: 'd30',   title: 'Next 30 days', when: '16–30 days',             dot: 'bg-blue-500',    test: (dd) => dd !== null && dd >= 16 && dd <= 30 },
  // Later also catches undated rows (dd === null): a bill with no resolvable due
  // date must NOT be reported as "Today" (daysOverdue(null) used to be 0), so it
  // falls to the tail instead of a false "due today".
  { k: 'later', title: 'Later',        when: 'more than 30 days away / no due date', dot: 'bg-slate-400', test: (dd) => dd === null || dd > 30 },
];
// Days until a bill's due date relative to today: >0 future, 0 today, <0 overdue,
// and NULL when there is no usable date (missing/unparseable) — distinct from 0.
function payDaysUntilDue(iso, today) {
  if (!iso) return null;
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return null;
  return Math.round((d - today) / 86400000);
}
function payBucketKey(daysUntilDue) {
  const b = PAY_BUCKETS.find((x) => x.test(daysUntilDue));
  return b ? b.k : 'later';
}

const TONE = {
  rose: 'text-rose-600', emerald: 'text-emerald-700', blue: 'text-blue-600',
  violet: 'text-violet-600', amber: 'text-amber-600',
};
const PAGE_SIZE = 10;   // keep each report page within one screen (no long scroll)

// Reusable pager — matches the Bills page / DataTable pagination design:
// "Showing X to Y of Z results" + numbered page buttons (first/last/±1 with
// ellipsis) + Prev/Next arrows. Used by the long reports.
function Pager({ page, setPage, total, size = PAGE_SIZE }) {
  const totalPages = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(page, totalPages);
  const go = (p) => { if (p >= 1 && p <= totalPages) setPage(p); };
  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-3 py-3 border-t border-slate-100 bg-white">
      <p className="order-2 sm:order-1 text-xs sm:text-sm text-slate-600">
        Showing {total === 0 ? 0 : Math.min((safePage - 1) * size + 1, total)} to{' '}
        {Math.min(safePage * size, total)} of {total} results
      </p>
      {totalPages > 1 && (
        <div className="order-1 sm:order-2 flex items-center gap-2">
          <button onClick={() => go(safePage - 1)} disabled={safePage <= 1}
            aria-label="Previous page" title="Previous page"
            className="p-2 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition">
            <ChevronLeft size={18} />
          </button>
          <div className="flex items-center gap-1">
            {Array.from({ length: totalPages }).map((_, i) => {
              const pageNum = i + 1;
              const isNear = Math.abs(pageNum - safePage) <= 1;
              const isFirst = pageNum === 1;
              const isLast = pageNum === totalPages;
              if (!isNear && !isFirst && !isLast) {
                if (pageNum === 2 || pageNum === totalPages - 1) {
                  return <span key={`dots-${pageNum}`} className="px-1 text-slate-400">...</span>;
                }
                return null;
              }
              return (
                <button key={pageNum} onClick={() => go(pageNum)}
                  className={`w-10 h-10 rounded-lg transition ${safePage === pageNum ? 'bg-primary-600 text-white shadow-sm' : 'border border-slate-300 hover:bg-slate-50'}`}>
                  {pageNum}
                </button>
              );
            })}
          </div>
          <button onClick={() => go(safePage + 1)} disabled={safePage >= totalPages}
            aria-label="Next page" title="Next page"
            className="p-2 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition">
            <ChevronRight size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
// Slice an array to the current page.
const pageSlice = (arr, page, size = PAGE_SIZE) => {
  const cp = Math.min(page, Math.max(1, Math.ceil(arr.length / size)));
  return arr.slice((cp - 1) * size, cp * size);
};

// ── Tab + report registry ────────────────────────────────────────────────────
// Each tab keeps its original grouped columns as the first ('summary') report;
// extra reports are layered on. report.kind:
//   'summary' (the original paginated table + by-month graph)
//   'aged' | 'bars' | 'ratetrend' | 'moneytrend'
const ALL_TABS = [
  {
    key: 'sales', label: 'Sales', party: 'Customer',
    load: (win) => fetchAll('/api/sales/invoices/', win, 'invoice_date'),
    dateOf: (r) => r.invoice_date, companyOf: (r) => r.company_name,
    keyOf: (r) => r.customer_name || '—',
    listRoute: '/sales/invoices',
    link: (key) => `/sales/invoices?customer=${encodeURIComponent(key)}`,
    cols: [
      { k: 'count', label: 'Invoices', agg: () => 1 },
      { k: 'taxable', label: 'Taxable', money: true, agg: (r) => num(r.subtotal) },
      { k: 'gst', label: 'GST', money: true, agg: (r) => num(r.cgst_total) + num(r.sgst_total) + num(r.igst_total) },
      { k: 'total', label: 'Total', money: true, agg: (r) => num(r.grand_total) },
      { k: 'received', label: 'Received', money: true, agg: (r) => num(r.received), tone: 'emerald' },
      { k: 'outstanding', label: 'Outstanding', money: true, agg: (r) => num(r.outstanding), tone: 'rose' },
    ],
    reports: [
      { id: 'summary', name: 'Top customers', kind: 'summary', top10: true },
      { id: 's_products', name: 'Top products', kind: 'topitems', side: 'sales', valueLabel: 'Revenue'},
      { id: 's_ageing', name: 'Receivables ageing', kind: 'aged', ageField: 'outstanding' },
      { id: 's_collection', name: 'Collection / DSO', kind: 'collection'},
      { id: 's_ratetrend', name: 'Item qty & rate trend', kind: 'ratetrend', side: 'sales'},
      { id: 's_credit', name: 'Over credit terms', kind: 'creditbreach'},
    ],
  },
  {
    key: 'purchase', label: 'Purchase', party: 'Vendor', excludeBranch: true,
    load: (win) => fetchAll('/api/purchase/bills/?slim=list', win, 'bill_date'),
    // Only REAL purchases (RM / Packing / Maize / Fruit / Bought Note). Expense-
    // like bills (Freight / Expenses / Lab / Machinery / journals / is_expense)
    // belong on the Expense tab, exactly as the Bills page splits them.
    filter: (r) => isPurchaseBill(r),
    dateOf: (r) => r.bill_date, dueOf: (r) => r.due_date, companyOf: (r) => r.company_name,
    keyOf: (r) => r.vendor_name || '—', isBranch: (r) => r.is_branch_transfer === true,
    listRoute: '/purchase/bills',
    link: (key) => `/purchase/bills?vendor=${encodeURIComponent(key)}`,
    cols: [
      { k: 'count', label: 'Bills', agg: () => 1 },
      { k: 'taxable', label: 'Taxable', money: true, agg: (r) => num(r.subtotal) },
      { k: 'gst', label: 'GST', money: true, agg: (r) => num(r.tax_amount) },
      { k: 'total', label: 'Total', money: true, agg: (r) => num(r.total_amount) },
      { k: 'paid', label: 'Paid', money: true, agg: (r) => num(r.amount_paid) },
      { k: 'outstanding', label: 'Outstanding', money: true, agg: (r) => num(r.balance_due), tone: 'rose' },
    ],
    // 'Payables ageing' dropped here — the dedicated Payables tab covers ageing
    // + the payment calendar, so it'd be redundant on the Purchase tab.
    reports: [
      { id: 'summary', name: 'Top vendors', kind: 'summary', top10: true},
      { id: 'p_topitems', name: 'Top purchased items', kind: 'topitems', side: 'purchase', valueLabel: 'Spend'},
      { id: 'p_category', name: 'By category', kind: 'bars', catOf: (r) => r.purchase_category || 'Unclassified'},
      { id: 'p_pivot', name: 'Item × vendor pivot', kind: 'pivot', side: 'purchase'},
      { id: 'p_health', name: 'Bills data-health', kind: 'health'},
    ],
  },
  {
    // Payables — a forward payment calendar + the overdue ageing, built on the
    // very same vendor bills as the Purchase tab (real purchases only; expense-
    // like bills live on the Expense tab). It answers "what must I clear, and
    // when", grouped by due date relative to today.
    key: 'payables', label: 'Payables', party: 'Vendor', excludeBranch: true,
    load: (win) => fetchAll('/api/purchase/bills/?slim=list', win, 'bill_date'),
    filter: (r) => isPurchaseBill(r),
    dateOf: (r) => r.bill_date, dueOf: (r) => r.due_date, companyOf: (r) => r.company_name,
    keyOf: (r) => r.vendor_name || '—', isBranch: (r) => r.is_branch_transfer === true,
    listRoute: '/purchase/bills',
    link: (key) => `/purchase/bills?vendor=${encodeURIComponent(key)}`,
    cols: [
      { k: 'count', label: 'Bills', agg: () => 1 },
      { k: 'outstanding', label: 'Outstanding', money: true, agg: (r) => num(r.balance_due), tone: 'rose' },
    ],
    reports: [
      { id: 'pay_calendar', name: 'Payment calendar', kind: 'paycal', ageField: 'balance_due', useDue: true },
      { id: 'pay_ageing', name: 'Vendor ageing', kind: 'aged', ageField: 'balance_due', useDue: true },
    ],
  },
  {
    // Receivables — the collection calendar + ageing for money coming IN, the
    // mirror of Payables. Built on the sales invoices the Sales tab loads.
    // Buckets on the invoice's effective due date (receivable's resolved due
    // date, else the invoice's own due_date), relative to today.
    key: 'receivables', label: 'Receivables', party: 'Customer',
    load: (win) => fetchAll('/api/sales/invoices/', win, 'invoice_date'),
    filter: (r) => num(r.outstanding) > 0,
    dateOf: (r) => r.invoice_date, dueOf: (r) => r.effective_due_date || r.due_date,
    companyOf: (r) => r.company_name, keyOf: (r) => r.customer_name || '—',
    listRoute: '/sales/invoices',
    link: (key) => `/sales/invoices?customer=${encodeURIComponent(key)}`,
    cols: [
      { k: 'count', label: 'Invoices', agg: () => 1 },
      { k: 'outstanding', label: 'Outstanding', money: true, agg: (r) => num(r.outstanding), tone: 'rose' },
    ],
    reports: [
      { id: 'rec_calendar', name: 'Collection calendar', kind: 'paycal', inflow: true, ageField: 'outstanding', useDue: true },
      { id: 'rec_ageing', name: 'Receivables ageing', kind: 'aged', ageField: 'outstanding', useDue: true },
    ],
  },
  {
    key: 'expense', label: 'Expense', party: 'Category',
    load: (win) => fetchAll('/api/purchase/bills/?slim=list', win, 'bill_date'),
    // Expense bills — the same definition as the Bills page's Expenses tab
    // (is_expense OR a journal voucher OR a Freight/Expenses/Lab/Machinery cat).
    filter: (r) => isExpenseLike(r),
    dateOf: (r) => r.bill_date, companyOf: (r) => r.company_name,
    keyOf: (r) => r.expense_subcategory || r.expense_group || r.purchase_category || 'Uncategorised',
    listRoute: '/purchase/bills',
    cols: [
      { k: 'count', label: 'Bills', agg: () => 1 },
      { k: 'amount', label: 'Amount', money: true, agg: (r) => num(r.total_amount) },
      { k: 'paid', label: 'Paid', money: true, agg: (r) => num(r.amount_paid), tone: 'emerald' },
      { k: 'outstanding', label: 'Outstanding', money: true, agg: (r) => num(r.balance_due), tone: 'rose' },
    ],
    reports: [
      { id: 'summary', name: 'By expense head', kind: 'summary', top10: true },
      { id: 'e_variance', name: 'This period vs last', kind: 'variance'},
      { id: 'e_ratio', name: 'Expense per ₹1L sales', kind: 'ratio'},
    ],
  },
  {
    key: 'freight', label: 'Freight', party: 'Transporter',
    load: async (win) => {
      const [p, s] = await Promise.all([
        fetchAll('/api/purchase/freight/', win, 'freight_date'),
        fetchAll('/api/sales/freight/', win, 'freight_date'),
      ]);
      return [...p.map((f) => ({ ...f, _dir: 'in' })), ...s.map((f) => ({ ...f, _dir: 'out' }))];
    },
    dateOf: (r) => r.freight_date || r.created_date, companyOf: (r) => r.company_name,
    keyOf: (r) => r.transporter_name || r.vendor_name || r.customer_name || '—',
    link: (key) => `/freight?transporter=${encodeURIComponent(key)}`,
    cols: [
      { k: 'count', label: 'Slips', agg: () => 1 },
      { k: 'inward', label: 'Inward', money: true, agg: (r) => r._dir === 'in' ? (num(r.total_freight_cost) || num(r.payable_amount)) : 0, tone: 'blue' },
      { k: 'outward', label: 'Outward', money: true, agg: (r) => r._dir === 'out' ? (num(r.total_freight_cost) || num(r.payable_amount)) : 0, tone: 'violet' },
      { k: 'total', label: 'Total', money: true, agg: (r) => num(r.total_freight_cost) || num(r.payable_amount) },
      { k: 'paid', label: 'Paid', money: true, agg: (r) => num(r.total_paid), tone: 'emerald' },
      { k: 'outstanding', label: 'Outstanding', money: true, agg: (r) => (num(r.total_freight_cost) || num(r.payable_amount)) - num(r.total_paid), tone: 'rose' },
    ],
    reports: [
      { id: 'summary', name: 'Inward / Outward', kind: 'summary', top10: true },
      { id: 'f_ageing', name: 'Transporter payable ageing', kind: 'aged', ageField: '_balance', useFreightDue: true },
      { id: 'f_pctvalue', name: 'Freight % of value', kind: 'freightpct'},
    ],
  },
];

// Standalone build = PURCHASE + PAYABLES only. The full multi-module config
// above is kept intact, but only the Purchase and Payables top-tabs are exposed
// (no Sales / Receivables / Expense / Freight). Payables carries the Payment
// calendar (Overdue / Today / Next 7-15-30 / Later buckets) + Vendor ageing.
const STANDALONE_REPORT_TABS = ['purchase', 'payables'];
const TABS = ALL_TABS.filter((t) => STANDALONE_REPORT_TABS.includes(t.key));

export default function ReportsSummary() {
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [tabKey, setTabKey] = useState(() => (TABS.some((t) => t.key === sp.get('tab')) ? sp.get('tab') : 'purchase'));
  const [reportId, setReportId] = useState(sp.get('report') || 'summary');
  const [page, setPage] = useState(1);
  const [hoverYm, setHoverYm] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [dueWithin, setDueWithin] = useState(0);        // overdue window: 0=all overdue; N=overdue ≤N days
  const [upcomingWithin, setUpcomingWithin] = useState(0);  // upcoming window: 0=off; N=due in the NEXT N days (not yet overdue)
  const [itemPick, setItemPick] = useState('');    // filter one item (item-trend / top-items / vendor-cmp)
  const [partyPick, setPartyPick] = useState('');  // filter one vendor (purchase) or customer (sales)
  const [catPick, setCatPick] = useState('');      // filter one purchase category (Purchase tab)
  const [sourcePick, setSourcePick] = useState(''); // '' = all, 'tally', 'erp' (origin filter)
  const [msmePick, setMsmePick] = useState('');    // '' = all, 'msme', 'non' (Purchase MSME vendor filter)
  const [cache, setCache] = useState({});
  const [trendData, setTrendData] = useState(null);
  const [cmpData, setCmpData] = useState(null);        // vendor-comparison payload
  const [pivotData, setPivotData] = useState(null);    // item x vendor x month pivot payload
  const [calData, setCalData] = useState(null);        // payables-calendar payload (ledger-tied, as-of today)
  const [salesForPeriod, setSalesForPeriod] = useState(0);  // sales total for the ratio report
  const [varianceBills, setVarianceBills] = useState(null); // bills across current+prev window
  const [openCat, setOpenCat] = useState(null);        // By-category: which category is expanded
  const [catItems, setCatItems] = useState({});        // category -> {loading, items, vendors, error}
  const [catTab, setCatTab] = useState('items');       // 'items' | 'vendors' in the expanded panel
  const [openCmp, setOpenCmp] = useState(null);        // Vendor-comparison: which item is expanded
  const [openTrend, setOpenTrend] = useState(null);    // Item rate-trend: which item's Qty row is expanded
  const [openAged, setOpenAged] = useState(null);      // Ageing: which party row is expanded to its bills
  const [closedPay, setClosedPay] = useState({});      // Payment calendar: bucket keys the user collapsed
  const [payPage, setPayPage] = useState({});          // Payment calendar: current page per bucket key
  const [openPayRow, setOpenPayRow] = useState(null);  // Payment calendar: which row (record id) is expanded
  const [payRowDetail, setPayRowDetail] = useState({}); // record id -> {loading, lines, error, bill}
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Company comes from the GLOBAL header filter (SS default; '' = All), like
  // every other standalone page — no local dropdown.
  const { company: globalCompany } = useGlobalCompany();
  const company = globalCompany || '';
  // Default to the current FINANCIAL YEAR, so the report opens WITH data (bills
  // are spread across the year; a single month is often near-empty). Month /
  // Week / All stay one click away.
  const period = usePeriodFilter(sp.get('period') || 'fy', {
    anchor: sp.get('anchor'), customFrom: sp.get('cfrom'), customTo: sp.get('cto'),
  });

  const tab = TABS.find((t) => t.key === tabKey);
  const report = (tab.reports || []).find((r) => r.id === reportId) || tab.reports[0];
  // Rows per page, tuned so each report fits one screen (no long scroll):
  // item-trend renders 2 lines per item, vendor-comparison has expandable
  // panels — both get fewer per page; normal tables use the Bills default.
  const rpp = report.kind === 'ratetrend' ? 8
    : report.kind === 'vendorcmp' ? 12
      : report.kind === 'pivot' ? 12
      : report.kind === 'summary' ? 8   // summary shows a by-month graph below, so keep it short
        : PAGE_SIZE;
  // Cache key = tab + the resolved window, so each period is fetched once and
  // switching back to a period already seen is instant.
  // The Trend tab needs several months by nature, so it always loads the last
  // 12 months regardless of the period buttons (which it hides anyway).
  const monthWin = () => {
    const to = new Date();
    const from = new Date(to.getFullYear(), to.getMonth() - 11, 1);
    const iso = (d) => d.toISOString().slice(0, 10);
    return { from: iso(from), to: iso(to) };
  };
  // Window for the item-rate / vendor-comparison endpoint: a trend needs a few
  // months, so widen a single-month tab window to the last 6; honour a wider one.
  const trendWindow = () => {
    const iso = (d) => d.toISOString().slice(0, 10);
    const r = period.range;
    if (r && r.from && r.to) {
      const from = new Date(r.from), to = new Date(r.to);
      const sixMonths = 1000 * 60 * 60 * 24 * 150;
      if (to - from >= sixMonths) return { from: r.from, to: r.to };
      const wideFrom = new Date(to.getFullYear(), to.getMonth() - 5, 1);
      return { from: iso(wideFrom), to: r.to };
    }
    // 'all' → last 6 months (a full-history line chart is unreadable anyway)
    const to = new Date();
    return { from: iso(new Date(to.getFullYear(), to.getMonth() - 5, 1)), to: iso(to) };
  };
  const win = tab.noCompanyGroup ? monthWin() : period.range;   // {from,to} | null (= All)
  const winKey = win ? `${win.from || ''}..${win.to || ''}` : 'all';
  const cacheKey = `${tabKey}|${winKey}`;
  const raw = cache[cacheKey];

  useEffect(() => {
    const p = new URLSearchParams(sp);
    const put = (k, v, keep) => { if (keep) p.set(k, v); else p.delete(k); };
    const np = period.navProps;
    put('tab', tabKey, tabKey && tabKey !== 'sales');
    put('report', report.id, report.id !== 'summary');
    put('company', company, !!company);
    put('period', np.period, np.period && np.period !== 'month');
    put('anchor', np.anchor, np.period !== 'all' && np.period !== 'custom');
    put('cfrom', np.customFrom, np.period === 'custom');
    put('cto', np.customTo, np.period === 'custom');
    if (p.toString() !== sp.toString()) setSp(p, { replace: true });
  }, [tabKey, report.id, company, period.navProps, sp, setSp]);

  useEffect(() => { setExpanded(false); setDueWithin(0); setUpcomingWithin(0); setPage(1); setOpenCat(null); setOpenCmp(null); setOpenTrend(null); setOpenAged(null); setClosedPay({}); setPayPage({}); setOpenPayRow(null); setItemPick(''); setPartyPick(''); setCatPick(''); setSourcePick(''); }, [tabKey, report.id]);
  // Payables is an "all open bills as of today" view — a bill due last month is
  // still payable. So entering the Payables tab defaults the period to All
  // (the user can still narrow it). Only nudges on tab entry, not every render.
  useEffect(() => {
    if ((tabKey === 'payables' || tabKey === 'receivables') && period.navProps.period === 'month') period.navProps.setPeriod('all');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKey]);
  // A new period invalidates the cached per-category breakdowns.
  useEffect(() => { setOpenCat(null); setCatItems({}); }, [winKey, company]);

  useEffect(() => {
    if (cache[cacheKey] !== undefined) return;
    let alive = true;
    setLoading(true); setError(null);
    Promise.resolve(tab.load(win))
      .then((rows) => { if (alive) setCache((c) => ({ ...c, [cacheKey]: rows })); })
      .catch(() => { if (alive) setError('Could not load the data.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  // item-rate endpoint, loaded for the ratetrend AND topitems reports (both
  // read invoice/bill line rates the list payloads don't carry).
  useEffect(() => {
    // Clear any stale error from a previously-viewed report FIRST, so switching
    // to a report that needs no fetch (e.g. By category) never inherits it.
    setError(null);
    if (report.kind !== 'ratetrend' && report.kind !== 'topitems') { setTrendData(null); return; }
    let alive = true; setTrendData(null);
    const params = new URLSearchParams({ side: report.side });
    // A rate/qty trend needs several months to be meaningful. For a single-month
    // tab window we widen to the last 6 months; a wider tab window is used as-is.
    // Either way we ALWAYS send a bounded window so the server aggregates a
    // period, not the whole FY (what made each call take 6s+).
    const tw = trendWindow();
    if (tw.from) params.set('from', tw.from);
    if (tw.to) params.set('to', tw.to);
    if (company) params.set('company', company);
    apiClient.get(`/api/purchase/item-rate-trend/?${params.toString()}`)
      .then(({ data }) => { if (alive) setTrendData(data); })
      .catch(() => { if (alive) setError('Could not load the item data.'); });
    return () => { alive = false; };
    // Depend on the STABLE winKey string, not period.navProps (a fresh object
    // each render that re-fired this effect in a loop — the repeated calls).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report.id, winKey, company]);

  // Vendor comparison, loaded for its report (purchase side, mode flag).
  useEffect(() => {
    if (report.kind !== 'vendorcmp') { setCmpData(null); return; }
    let alive = true; setCmpData(null); setError(null);
    const params = new URLSearchParams({ side: 'purchase', mode: 'vendor-comparison' });
    const tw = trendWindow();
    if (tw.from) params.set('from', tw.from);
    if (tw.to) params.set('to', tw.to);
    if (company) params.set('company', company);
    apiClient.get(`/api/purchase/item-rate-trend/?${params.toString()}`)
      .then(({ data }) => { if (alive) setCmpData(data); })
      .catch(() => { if (alive) setError('Could not load the vendor comparison.'); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report.id, winKey, company]);

  // Item x vendor x month pivot (trend + comparison clubbed). Same endpoint,
  // mode=pivot, loaded only for the pivot report.
  useEffect(() => {
    if (report.kind !== 'pivot') { setPivotData(null); return; }
    let alive = true; setPivotData(null); setError(null);
    const params = new URLSearchParams({ side: 'purchase', mode: 'pivot' });
    const tw = trendWindow();
    if (tw.from) params.set('from', tw.from);
    if (tw.to) params.set('to', tw.to);
    if (company) params.set('company', company);
    apiClient.get(`/api/purchase/item-rate-trend/?${params.toString()}`)
      .then(({ data }) => { if (alive) setPivotData(data); })
      .catch(() => { if (alive) setError('Could not load the item pivot.'); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report.id, winKey, company]);

  // Payables payment calendar — LEDGER-TIED. Fetches the authoritative per-bill
  // balances (vendor outstanding allocated oldest-first) instead of summing the
  // slim list's per-bill balance_due, which ignored on-account payments and
  // over-stated dues (audit: +₹8.9cr UAI / +₹16.2cr SSB). As-of today, so the
  // period filter doesn't apply here. Company id comes off any loaded bill row.
  useEffect(() => {
    if (!(tabKey === 'payables' && report.kind === 'paycal')) { setCalData(null); return; }
    let alive = true; setCalData(null); setError(null);
    const params = new URLSearchParams();
    // `company` is the GLOBAL company ID (header filter), which is exactly what
    // the endpoint wants — pass it straight through.
    if (company) params.set('company', company);
    if (msmePick === 'msme') params.set('msme', 'true');
    else if (msmePick === 'non') params.set('msme', 'false');
    apiClient.get(`/api/purchase/payables-calendar/?${params.toString()}`)
      .then(({ data }) => { if (alive) setCalData(data); })
      .catch(() => { if (alive) setError('Could not load the payment calendar.'); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKey, report.id, company, msmePick, raw]);

  // Sales total for the "expense per ₹1L sales" ratio (the Expense tab's raw is
  // bills only, so sales come from their own list, scoped to the same window).
  useEffect(() => {
    if (report.kind !== 'ratio') return;
    let alive = true;
    fetchAll('/api/sales/invoices/', period.range, 'invoice_date')
      .then((rows) => {
        if (!alive) return;
        const total = rows
          .filter((r) => (!company || r.company_name === company) && period.match(r.invoice_date))
          .reduce((s, r) => s + num(r.grand_total), 0);
        setSalesForPeriod(total);
      })
      .catch(() => { if (alive) setSalesForPeriod(0); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report.id, company, winKey]);

  // Outstanding-as-of-today reports (ageing, over-credit-terms) must look across
  // ALL open invoices/bills, not just the chosen period — a bill from 3 months
  // ago that is still unpaid belongs in ageing. So these fetch unwindowed and
  // ignore the period filter.
  const needsOpen = report.kind === 'aged' || report.kind === 'creditbreach';

  // Authoritative per-vendor Paid / Outstanding (Tally-style: counts ALL
  // PaymentMade incl. on-account advances + debit notes + opening — NOT the
  // bill's amount_paid cache). From the Purchase Dashboard's vendor_breakdown.
  // Used to override the Top-vendors report's Paid/Outstanding so they tie to
  // the dashboard and Tally.
  const [vendorPay, setVendorPay] = useState(null);   // { vendorName: {paid, outstanding} }
  const wantVendorPay = tabKey === 'purchase' && report.id === 'summary';
  useEffect(() => {
    if (!wantVendorPay) { setVendorPay(null); return; }
    let alive = true; setVendorPay(null);
    const params = new URLSearchParams({ period: 'all' });
    if (company) { const row = (Array.isArray(raw) ? raw : []).find((r) => r.company_name === company); if (row && row.company) params.set('company', row.company); }
    apiClient.get(`/api/purchase/dashboard/?${params.toString()}`)
      .then(({ data }) => {
        if (!alive) return;
        const map = {};
        (data.vendor_breakdown || []).forEach((v) => { map[(v.vendor_name || '').trim()] = { paid: num(v.paid), outstanding: num(v.outstanding) }; });
        setVendorPay(map);
      })
      .catch(() => { if (alive) setVendorPay({}); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantVendorPay, company, cacheKey]);
  // Variance needs the current AND previous window, so it fetches its own span
  // (the tab's windowed `raw` only holds the current period).
  useEffect(() => {
    if (report.kind !== 'variance') { setVarianceBills(null); return; }
    const w = period.range;
    if (!w || !w.from || !w.to) { setVarianceBills([]); return; }
    const from = new Date(w.from), to = new Date(w.to);
    const prevFrom = new Date(from.getTime() - (to - from) - 86400000);
    const iso = (d) => d.toISOString().slice(0, 10);
    let alive = true; setVarianceBills(null);
    fetchAll('/api/purchase/bills/?slim=list', { from: iso(prevFrom), to: w.to }, 'bill_date')
      .then((rows) => { if (alive) setVarianceBills(rows); })
      .catch(() => { if (alive) setVarianceBills([]); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report.id, winKey, company]);

  const companies = useMemo(() => {
    if (tab.noCompanyGroup || !raw || !Array.isArray(raw)) return [];
    return [...new Set(raw.map((r) => tab.companyOf(r)).filter(Boolean))].sort();
  }, [raw, tab]);

  // ── Which filter dropdowns this report shows ────────────────────────────────
  // Item filter: item-trend / top-items / vendor-comparison.
  // Party filter: vendor (purchase) on top-vendors/ageing/vendor-comparison;
  //               customer (sales) on the sales ranked/ageing/collection reports.
  const showItemFilter = ['ratetrend', 'topitems', 'vendorcmp', 'pivot'].includes(report.kind);
  const partyLabel = (tabKey === 'sales' || tabKey === 'receivables') ? 'Customer' : 'Vendor';
  const showPartyFilter =
    (tabKey === 'purchase' && ['summary', 'aged', 'vendorcmp', 'pivot'].includes(report.kind)) ||
    (tabKey === 'payables' && ['paycal', 'aged'].includes(report.kind)) ||
    (tabKey === 'receivables' && ['paycal', 'aged'].includes(report.kind)) ||
    (tabKey === 'sales' && ['summary', 'aged', 'collection', 'creditbreach'].includes(report.kind));
  // Category filter — the real purchase categories, on the Purchase tab's
  // row-level reports (not the By-category bars, which are already per category).
  const PURCHASE_CATS = [['RM', 'RM'], ['PACKING', 'Packing'], ['MAIZE', 'Maize'], ['FRUIT', 'Fruit']];
  const showCatFilter = tabKey === 'purchase' && ['summary', 'aged', 'ratetrend', 'topitems', 'pivot'].includes(report.kind);
  // MSME vendor filter — Purchase tab only (the bill row carries vendor_is_msme).
  // Most useful on Payables ageing (45-day MSMED limit), offered on the other
  // vendor-level lists too.
  const showMsmeFilter =
    (tabKey === 'purchase' && ['summary', 'aged', 'topitems'].includes(report.kind)) ||
    (tabKey === 'payables' && ['paycal', 'aged'].includes(report.kind));

  // Item options — from the loaded trend/cmp payload (those reports' own data).
  const itemOptions = useMemo(() => {
    const src = report.kind === 'vendorcmp' ? cmpData : report.kind === 'pivot' ? pivotData : trendData;
    if (!src || !src.items) return [];
    return [...new Set(src.items.map((it) => it.item).filter(Boolean))].sort();
  }, [report.kind, trendData, cmpData, pivotData]);

  // trend/cmp items after the item-pick filter — used by render AND export.
  const trendItems = useMemo(() => {
    if (!trendData) return [];
    let items = trendData.items;
    if (catPick) items = items.filter((it) => (it.category || '').toUpperCase() === catPick);
    if (itemPick) items = items.filter((it) => it.item === itemPick);
    return items;
  }, [trendData, itemPick, catPick]);
  const cmpItems = useMemo(() => {
    if (!cmpData) return [];
    let items = itemPick ? cmpData.items.filter((it) => it.item === itemPick) : cmpData.items;
    if (partyPick) {
      // Vendor filter on vendor-comparison: keep only items that vendor supplied,
      // and within each item show that vendor's row (keep others for context).
      items = items.filter((it) => (it.vendors || []).some((v) => v.vendor === partyPick));
    }
    return items;
  }, [cmpData, itemPick, partyPick]);
  const pivotItems = useMemo(() => {
    if (!pivotData) return [];
    let items = pivotData.items;
    if (catPick) items = items.filter((it) => (it.category || '').toUpperCase() === catPick);
    if (itemPick) items = items.filter((it) => it.item === itemPick);
    if (partyPick) items = items.filter((it) => (it.vendors || []).some((v) => v.vendor === partyPick));
    return items;
  }, [pivotData, itemPick, catPick, partyPick]);

  // Party options — vendor/customer names present in the relevant data.
  // filtered rows (company + period + tab filter + branch exclusion + party pick)
  const filtered = useMemo(() => {
    if (!raw || !Array.isArray(raw)) return [];
    let src = tab.filter ? raw.filter(tab.filter) : raw;
    if (tab.excludeBranch && tab.isBranch) src = src.filter((r) => !tab.isBranch(r));
    return src.filter((r) => {
      // Company filter: the GLOBAL header filter gives a company ID, but a row
      // carries both its id (r.company) and name (company_name). Match on the
      // id, falling back to the name so either shape works.
      if (company && String(r.company || '') !== String(company)
          && tab.companyOf(r) !== company) return false;
      if (partyPick && tab.keyOf(r) !== partyPick) return false;
      if (catPick && (r.purchase_category || '').toUpperCase() !== catPick) return false;
      if (sourcePick && !matchesSource(r, sourcePick)) return false;
      // MSME vendor filter (Purchase tab only): the slim bill row carries
      // vendor_is_msme straight off the vendor master, the same flag the
      // Analytics dashboard's ?msme= toggle keys on.
      if (msmePick === 'msme' && !r.vendor_is_msme) return false;
      if (msmePick === 'non' && r.vendor_is_msme) return false;
      return period.match(tab.dateOf(r));
    });
  }, [raw, tab, company, period, partyPick, catPick, sourcePick, msmePick]);

  // Party (vendor/customer) options — the full list to choose from, so it is
  // NOT narrowed by the current party pick. Declared after `filtered` so it
  // can reuse the same company/period scope without the party filter.
  const partyOptions = useMemo(() => {
    if (report.kind === 'vendorcmp' || report.kind === 'pivot') {
      const src = report.kind === 'pivot' ? pivotData : cmpData;
      if (!src || !src.items) return [];
      const s = new Set();
      src.items.forEach((it) => (it.vendors || []).forEach((v) => s.add(v.vendor)));
      return [...s].filter(Boolean).sort();
    }
    // Every row-list report (including ageing now) draws from the same windowed
    // `filtered` set, so the options match what's shown.
    return [...new Set(filtered.map((r) => tab.keyOf(r)).filter((n) => n && n !== '—'))].sort();
  }, [report.kind, cmpData, pivotData, filtered, tab]);

  // grouped (original logic, + cumulative concentration)
  const grouped = useMemo(() => {
    if (!tab.cols) return { rows: [], totals: {} };
    const by = new Map(); const totals = {};
    for (const r of filtered) {
      const key = tab.keyOf(r);
      const g = by.get(key) || { _key: key, _raw: r };
      for (const c of tab.cols) {
        g[c.k] = (g[c.k] || 0) + c.agg(r);
        totals[c.k] = (totals[c.k] || 0) + c.agg(r);
      }
      by.set(key, g);
    }
    // Top-vendors: replace the bill-cache Paid/Outstanding with the
    // authoritative Tally-style figures (PaymentMade incl. on-account), matched
    // by vendor name. Keeps Taxable/GST/Total/# from the bills.
    if (vendorPay && tabKey === 'purchase' && report.id === 'summary') {
      totals.paid = 0; totals.outstanding = 0;
      for (const g of by.values()) {
        const vp = vendorPay[(g._key || '').trim()];
        if (vp) { g.paid = vp.paid; g.outstanding = Math.max(0, vp.outstanding); }
        totals.paid += g.paid || 0; totals.outstanding += g.outstanding || 0;
      }
    }
    const sortCol = tab.cols.find((c) => c.k === 'total') || tab.cols[tab.cols.length - 1];
    const rows = [...by.values()].sort((a, b) => (b[sortCol.k] || 0) - (a[sortCol.k] || 0));
    const grand = rows.reduce((s, g) => s + (g[sortCol.k] || 0), 0);
    let run = 0;
    rows.forEach((g) => { run += (g[sortCol.k] || 0); g._conc = grand ? (run / grand) * 100 : 0; });
    return { rows, totals };
  }, [filtered, tab, vendorPay, tabKey, report.id]);

  // by-month graph (original)
  const byMonth = useMemo(() => {
    if (!tab.cols) return { rows: [], max: 0, total: 0, label: 'Total' };
    const col = tab.cols.find((c) => c.k === 'total') || tab.cols.find((c) => c.k === 'amount') || tab.cols.find((c) => c.money);
    const by = new Map(); let total = 0;
    for (const r of filtered) {
      const k = monthKey(tab.dateOf(r));
      if (!k) continue;
      const v = col ? col.agg(r) : 0;
      const g = by.get(k) || { ym: k, value: 0, count: 0 };
      g.value += v; g.count += 1; total += v;
      by.set(k, g);
    }
    const rows = [...by.values()].sort((a, b) => a.ym.localeCompare(b.ym));
    const max = rows.reduce((m, r) => Math.max(m, r.value), 0);
    return { rows, max, total, label: col ? col.label : 'Total' };
  }, [filtered, tab]);

  useEffect(() => { setPage(1); }, [grouped.rows]);
  // Any filter change resets to page 1 so you never sit on an empty page.
  useEffect(() => { setPage(1); }, [dueWithin, upcomingWithin, catPick, partyPick, itemPick, sourcePick, msmePick, winKey, company]);

  // Top-10 collapse for summary tables (page size = rpp so it fits with the graph)
  const totalPages = Math.max(1, Math.ceil(grouped.rows.length / rpp));
  const cp = Math.min(page, totalPages);
  const summaryRows = (report.top10 && !expanded && grouped.rows.length > 10)
    ? grouped.rows.slice(0, 10)
    : grouped.rows.slice((cp - 1) * rpp, cp * rpp);
  const othersAgg = useMemo(() => {
    if (!(report.top10 && !expanded && grouped.rows.length > 10)) return null;
    const rest = grouped.rows.slice(10); const o = {};
    (tab.cols || []).forEach((c) => { if (c.money) o[c.k] = rest.reduce((s, r) => s + (r[c.k] || 0), 0); });
    return { count: rest.length, ...o };
  }, [report, expanded, grouped.rows, tab]);

  const LIST_ROUTE = { sales: '/sales/invoices', purchase: '/purchase/bills', expense: '/purchase/bills' };
  const drillMonth = (ym) => {
    const route = LIST_ROUTE[tabKey];
    if (!route) return;
    const [y, m] = ym.split('-').map(Number);
    const from = `${ym}-01`;
    const to = `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
    navigate(`${route}?period=custom&cfrom=${from}&cto=${to}`);
  };

  // deep-link scope (only params the target pages read)
  const scopeQS = () => {
    const np = period.navProps; const p = new URLSearchParams();
    if (np.period && np.period !== 'all') { p.set('period', np.period); if (np.anchor && np.period !== 'custom') p.set('anchor', np.anchor); }
    if (np.period === 'custom') { if (np.customFrom) p.set('cfrom', np.customFrom); if (np.customTo) p.set('cto', np.customTo); }
    if (company) p.set('company_name', company);
    return p.toString();
  };
  const withScope = (path) => { const q = scopeQS(); return q ? `${path}${path.includes('?') ? '&' : '?'}${q}` : path; };
  const partyHref = (key) => (tab.link ? withScope(tab.link(key)) : null);
  // Each category bar opens that category's actual bills (the Bills page reads
  // ?purchase_category=), scoped to the same company & period — so a click
  // shows the rows behind the number. 'Unclassified' has no category filter, so
  // it opens the Bills list scoped to the period instead.
  const categoryHref = (cat) => {
    const c = (cat || '').toUpperCase();
    const base = (c && c !== 'UNCLASSIFIED')
      ? `/purchase/bills?purchase_category=${encodeURIComponent(c)}`
      : '/purchase/bills';
    return withScope(base);
  };

  // Source rows for ageing / payment-calendar / over-credit-terms. Uses the same
  // period-windowed `filtered` as every other report (so the date filter applies
  // and there's no slow second fetch), then drops opening-balance carriers: their
  // per-row balance is settled in the vendor running ledger, not on the carrier,
  // so they'd otherwise haunt "what's still owed" at their full opening amount.
  const openSrc = () => filtered.filter((r) => !isOpeningCarrier(r));

  // ── ageing rows ────────────────────────────────────────────────────────────
  const agedRows = () => {
    const today = new Date();
    const by = new Map(); const totals = { out: 0 }; BUCKETS.forEach((b) => (totals[b.k] = 0));
    for (const r of openSrc()) {
      // Freight has no stored balance/due date — derive balance = cost − paid
      // and age against the freight date.
      const out = report.useFreightDue
        ? (num(r.total_freight_cost) || num(r.payable_amount)) - num(r.total_paid)
        : num(r[report.ageField]);
      if (out <= 0) continue;
      const dueIso = report.useDue && tab.dueOf ? (tab.dueOf(r) || tab.dateOf(r)) : tab.dateOf(r);
      const d = daysOverdue(dueIso, today);   // >0 overdue, <=0 due in |d| days
      // Upcoming filter wins when set: show bills DUE in the next N days (not yet
      // overdue) — d between -N and 0. Else the overdue window (d in 1..dueWithin)
      // when picked. Default (both 0) = everything outstanding (all buckets).
      if (upcomingWithin) {
        if (!(d <= 0 && d >= -upcomingWithin)) continue;
      } else if (dueWithin) {
        if (!(d > 0 && d <= dueWithin)) continue;
      }
      const key = tab.keyOf(r);
      const g = by.get(key) || { _key: key, out: 0, days: 0 };
      g.out += out; g.days = Math.max(g.days, d);
      g[ageBucket(d)] = (g[ageBucket(d)] || 0) + out;
      by.set(key, g);
    }
    const rows = [...by.values()].sort((a, b) => b.out - a.out);
    rows.forEach((g) => { totals.out += g.out; BUCKETS.forEach((b) => (totals[b.k] += g[b.k] || 0)); });
    return { rows, totals };
  };
  // The individual open bills behind one party's ageing row — for the inline
  // expand. Each: {no, date, due, out, days}. Sorted oldest-first.
  const agedPartyBills = (key) => {
    const today = new Date();
    const out = [];
    for (const r of openSrc()) {
      if (tab.keyOf(r) !== key) continue;
      const bal = num(r[report.ageField]);
      if (bal <= 0) continue;                 // includes PARTIAL bills (remaining balance)
      const dueIso = report.useDue && tab.dueOf ? (tab.dueOf(r) || tab.dateOf(r)) : tab.dateOf(r);
      const d = daysOverdue(dueIso, today);
      // Drill shows the vendor's WHOLE outstanding — every unpaid/partial bill —
      // NOT just the top "Due in N days" window, so partial bills aren't hidden.
      out.push({
        no: r.vendor_invoice_no || r.bill_no || r.invoice_no || '—',
        date: r.bill_date || r.invoice_date || '',
        due: dueIso || '',
        out: bal,
        days: d,
        _r: r,
      });
    }
    return out.sort((a, b) => b.days - a.days);
  };

  // ── payment calendar ───────────────────────────────────────────────────────
  // Every open bill placed in a forward bucket by its due date relative to today
  // (Overdue / Today / Next 7 / Next 15 / Next 30 / Later). Within a bucket,
  // soonest-due first. Empty buckets are dropped. Totals ride along for the
  // header strip. Reuses the SAME filtered+windowed rows as ageing, so company /
  // vendor / MSME / source / period filters all apply here too.
  const payCalendar = () => {
    const today = new Date();
    const groups = {}; PAY_BUCKETS.forEach((b) => (groups[b.k] = { items: [], total: 0 }));
    let grand = 0, overdueTot = 0, next30 = 0;

    // Two sources, one shape {vendor, msme, no, date, due, out, id}:
    //  • Payables → the ledger-tied endpoint (authoritative balance allocated
    //    oldest-first, ties to the vendor ledger / Tally).
    //  • Receivables → the slim invoice rows (outstanding is reliable there; the
    //    sales ledger already nets receipts into ReceivableLedger.balance).
    const ledgerTied = tabKey === 'payables';
    let srcItems;
    if (ledgerTied) {
      srcItems = ((calData && calData.bills) || []).map((r) => ({
        vendor: r.vendor_name || '—', msme: r.vendor_is_msme === true,
        no: r.vendor_invoice_no || r.bill_no || '—',
        cat: r.purchase_category || '',
        date: r.bill_date || '', due: r.due_date || r.bill_date || '',
        out: num(r.balance), id: r.bill_id,
      }));
    } else {
      srcItems = openSrc().map((r) => {
        const dueIso = report.useDue && tab.dueOf ? (tab.dueOf(r) || tab.dateOf(r)) : tab.dateOf(r);
        return {
          vendor: tab.keyOf(r), msme: r.vendor_is_msme === true,
          no: r.vendor_invoice_no || r.bill_no || r.invoice_no || '—',
          date: tab.dateOf(r) || '', due: dueIso || '',
          out: num(r[report.ageField]), id: r.id,
        };
      });
    }

    for (const it of srcItems) {
      if (it.out <= 0) continue;                    // includes partials (remaining balance)
      const dd = payDaysUntilDue(it.due, today);     // days UNTIL due: >0 future, 0 today, <0 overdue, null = undated
      const k = payBucketKey(dd);
      groups[k].items.push({ ...it, dd });
      groups[k].total += it.out; grand += it.out;
      if (dd !== null && dd < 0) overdueTot += it.out;
      if (dd !== null && dd >= 0 && dd <= 30) next30 += it.out;
    }
    const sections = PAY_BUCKETS
      .map((b) => ({ ...b, ...groups[b.k] }))
      .filter((s) => s.items.length);
    // Soonest-due first; undated rows (dd === null) sort to the end of their
    // bucket (Later) rather than jumping ahead of real dates.
    const sortKey = (x) => (x.dd === null ? Infinity : x.dd);
    sections.forEach((s) => s.items.sort((a, b) => sortKey(a) - sortKey(b)));
    const count = Object.values(groups).reduce((n, g) => n + g.items.length, 0);
    return { sections, grand, overdueTot, next30, count };
  };

  // Expand one calendar row to the bill/invoice's line items + money facts.
  // The list feed is slim (no lines), so fetch the detail on demand and cache
  // it by record id. Normalises purchase bills and sales invoices to one shape:
  // { lines:[{name, qty, uom, rate, amount}], total, paid, balance }.
  const togglePayRow = (id) => {
    if (!id) return;
    if (openPayRow === id) { setOpenPayRow(null); return; }
    setOpenPayRow(id);
    if (payRowDetail[id]) return;                       // cached
    setPayRowDetail((d) => ({ ...d, [id]: { loading: true } }));
    const inflowTab = report.inflow === true;
    const url = inflowTab ? `/api/sales/invoices/${id}/` : `/api/purchase/bills/${id}/`;
    apiClient.get(url)
      .then(({ data }) => {
        const rawLines = report.inflow ? (data.invoice_lines || []) : (data.bill_lines || []);
        const lines = rawLines.map((l) => ({
          name: l.item_name || l.display_name || l.product_name || l.description || '—',
          qty: num(l.quantity ?? l.qty),
          uom: l.uom || l.quantity_uom || '',
          rate: num(l.rate),
          amount: num(l.amount ?? l.line_total ?? l.total),
        }));
        const total = num(data.total_amount ?? data.grand_total);
        const paid = num(data.amount_paid ?? data.received);
        const balance = num(data.balance_due ?? data.outstanding);
        setPayRowDetail((d) => ({ ...d, [id]: { lines, total, paid, balance } }));
      })
      .catch(() => setPayRowDetail((d) => ({ ...d, [id]: { error: true } })));
  };

  const barRows = () => {
    const m = new Map();
    for (const r of filtered) m.set(report.catOf(r), (m.get(report.catOf(r)) || 0) + num(r.total_amount));
    return [...m.entries()].map(([cat, amount]) => ({ cat, amount })).sort((a, b) => b.amount - a.amount);
  };

  // Expand a category bar: fetch its item → vendor breakdown once (cached) and
  // show Items / Vendors tabs. Uses the existing by-category items endpoint,
  // scoped to the same window; company id comes off any filtered bill row.
  const toggleCat = (cat) => {
    if (openCat === cat) { setOpenCat(null); return; }
    setOpenCat(cat); setCatTab('items');
    if (catItems[cat]) return;                       // already loaded
    setCatItems((c) => ({ ...c, [cat]: { loading: true } }));
    const params = new URLSearchParams();
    params.set('category', cat === 'Unclassified' ? '' : cat);
    if (win && win.from) params.set('from', win.from);
    if (win && win.to) params.set('to', win.to);
    if (company) { const row = filtered.find((r) => r.company_name === company); if (row && row.company) params.set('company', row.company); }
    apiClient.get(`/api/purchase/by-category/items/?${params.toString()}`)
      .then(({ data }) => {
        const items = (data.items || []).map((it) => ({ name: it.display || it.item, amount: num(it.amount) }))
          .sort((a, b) => b.amount - a.amount);
        const vmap = new Map();
        (data.items || []).forEach((it) => (it.vendors || []).forEach((v) => vmap.set(v.vendor, (vmap.get(v.vendor) || 0) + num(v.amount))));
        const vendors = [...vmap.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);
        setCatItems((c) => ({ ...c, [cat]: { items, vendors } }));
      })
      .catch(() => setCatItems((c) => ({ ...c, [cat]: { error: true } })));
  };
  const moneyTrendRows = () => {
    if (!raw || Array.isArray(raw)) return [];
    const key = (iso) => { const k = monthKey(iso); return k || null; };
    const buckets = new Map();
    const bump = (iso, f, v) => { const k = key(iso); if (!k) return; const b = buckets.get(k) || { sales: 0, purchase: 0, expense: 0, freight: 0 }; b[f] += v; buckets.set(k, b); };
    const coOk = (r) => !company || r.company_name === company;
    raw.invoices.filter(coOk).forEach((r) => bump(r.invoice_date, 'sales', num(r.grand_total)));
    raw.bills.filter(coOk).forEach((r) => {
      const t = num(r.total_amount);
      if (isExpenseLike(r)) bump(r.bill_date, 'expense', t);
      else bump(r.bill_date, 'purchase', t);
    });
    raw.freight.filter(coOk).forEach((r) => bump(r.freight_date || r.created_date, 'freight', num(r.total_freight_cost) || num(r.payable_amount)));
    return [...buckets.keys()].filter(Boolean).sort().slice(-12).map((k) => {
      const b = buckets.get(k);
      return { label: monthLabel(k), ...b, net: b.sales - b.purchase - b.expense - b.freight };
    });
  };

  // Collection / DSO — invoiced vs received per customer + collection ratio.
  const collectionRows = () => {
    const by = new Map();
    for (const r of filtered) {
      const key = tab.keyOf(r);
      const g = by.get(key) || { _key: key, invoiced: 0, received: 0, out: 0 };
      g.invoiced += num(r.grand_total); g.received += num(r.received); g.out += num(r.outstanding);
      by.set(key, g);
    }
    const rows = [...by.values()].map((g) => ({ ...g, ratio: g.invoiced ? (g.received / g.invoiced) * 100 : 0 }))
      .sort((a, b) => b.out - a.out);
    const totals = rows.reduce((t, r) => ({ invoiced: t.invoiced + r.invoiced, received: t.received + r.received, out: t.out + r.out }), { invoiced: 0, received: 0, out: 0 });
    return { rows, totals };
  };

  // Over credit terms — customers with outstanding on invoices now PAST their
  // due date. The invoice's due_date already encodes the customer's credit terms
  // (Net 30 / 45 / Custom — the ERP applies them at invoice creation), so an
  // overdue invoice is one beyond the agreed terms. No customer-master fetch:
  // the terms are baked into due_date on the invoice list.
  const creditRows = () => {
    const today = new Date();
    const by = new Map();
    for (const r of openSrc()) {
      const out = num(r.outstanding);
      if (out <= 0) continue;
      const dueIso = r.due_date || r.invoice_date;        // fall back to invoice date
      const days = daysOverdue(dueIso, today);
      if (days <= 0) continue;                            // not yet past terms
      const key = tab.keyOf(r);
      const g = by.get(key) || { _key: key, overdue: 0, out: 0, days: 0 };
      g.overdue += out;                                   // outstanding past its due date
      g.out += out;
      g.days = Math.max(g.days, days);
      by.set(key, g);
    }
    return [...by.values()].sort((a, b) => b.overdue - a.overdue);
  };

  // Expense variance — this period vs the previous window of the same length.
  const varianceRows = () => {
    const bills = varianceBills;
    if (!bills || !Array.isArray(bills)) return { rows: [], curTot: 0, prevTot: 0 };
    const vwin = period.range;                   // {from, to} ISO for the current period
    if (!vwin || !vwin.from || !vwin.to) return { rows: [], curTot: 0, prevTot: 0 };
    const from = new Date(vwin.from), to = new Date(vwin.to);
    const span = to - from;
    const prevTo = new Date(from.getTime() - 86400000);
    const prevFrom = new Date(prevTo.getTime() - span);
    const inRange = (iso, a, b) => { const d = new Date(iso); return d >= a && d <= b; };
    const headOf = (r) => r.expense_subcategory || r.expense_group || r.purchase_category || 'Uncategorised';
    const coOk = (r) => !company || r.company_name === company;
    const src = bills.filter(isExpenseLike).filter(coOk);
    const by = new Map();
    for (const r of src) {
      const h = headOf(r); const amt = num(r.total_amount);
      const g = by.get(h) || { _key: h, cur: 0, prev: 0 };
      if (inRange(r.bill_date, from, to)) g.cur += amt;
      else if (inRange(r.bill_date, prevFrom, prevTo)) g.prev += amt;
      by.set(h, g);
    }
    const rows = [...by.values()].filter((g) => g.cur || g.prev)
      .map((g) => ({ ...g, change: g.prev ? ((g.cur - g.prev) / g.prev) * 100 : (g.cur ? 100 : 0) }))
      .sort((a, b) => b.cur - a.cur);
    const curTot = rows.reduce((s, r) => s + r.cur, 0);
    const prevTot = rows.reduce((s, r) => s + r.prev, 0);
    return { rows, curTot, prevTot };
  };

  // Expense per ₹1L sales — one ratio for the period (expense vs sales).
  const ratioRow = () => {
    if (!raw || !Array.isArray(raw)) return null;
    const coOk = (r) => !company || r.company_name === company;
    const exp = (tab.filter ? raw.filter(tab.filter) : raw).filter(coOk)
      .filter((r) => period.match(r.bill_date)).reduce((s, r) => s + num(r.total_amount), 0);
    return { expense: exp, sales: salesForPeriod, ratio: salesForPeriod ? (exp / (salesForPeriod / 100000)) : 0 };
  };

  // Data-health — bills needing attention, from the slim list fields.
  const healthRows = () => {
    // No Tally in this standalone, so the "not matched to Tally" check is dropped.
    const noInv = filtered.filter((r) => !(r.vendor_invoice_no || '').trim());
    const unclassified = filtered.filter((r) => !(r.purchase_category || '').trim() || r.purchase_category === 'Unclassified');
    const noDue = filtered.filter((r) => !(r.due_date || '').trim());
    const sum = (arr) => arr.reduce((s, r) => s + num(r.total_amount), 0);
    const ids = (arr) => arr.map((r) => r.id).filter(Boolean);
    // `dq` = the data-quality code the Bills page filters on (?dq=), so clicking
    // a row opens exactly the flagged bills, ready to fix.
    return [
      { issue: 'Bills missing an invoice number', dq: 'no_invoice', count: noInv.length, value: sum(noInv), ids: ids(noInv), sev: noInv.length ? 'warn' : 'ok' },
      { issue: 'Unclassified category', dq: 'unclassified', count: unclassified.length, value: sum(unclassified), ids: ids(unclassified), sev: unclassified.length ? 'warn' : 'ok' },
      { issue: 'Bills missing a due date', dq: 'no_due', count: noDue.length, value: sum(noDue), ids: ids(noDue), sev: noDue.length ? 'warn' : 'ok' },
    ];
  };

  // Freight % of value — freight vs the goods value it carried, per transporter.
  // The carried-value field isn't on the freight list payload, so this shows the
  // freight total and the share only where a carried value is present.
  const freightPctRows = () => {
    const by = new Map();
    for (const r of filtered) {
      const key = tab.keyOf(r);
      const cost = num(r.total_freight_cost) || num(r.payable_amount);
      const carried = num(r.linked_value) || num(r.goods_value) || num(r.bill_value) || 0;
      const g = by.get(key) || { _key: key, cost: 0, carried: 0 };
      g.cost += cost; g.carried += carried;
      by.set(key, g);
    }
    return [...by.values()].map((g) => ({ ...g, pct: g.carried ? (g.cost / g.carried) * 100 : null }))
      .sort((a, b) => b.cost - a.cost);
  };

  // ── export (Excel + PDF) ────────────────────────────────────────────────────
  const buildExport = () => {
    if (report.kind === 'summary') {
      const cols = [{ field: '_key', header: tab.party }, ...tab.cols.map((c) => ({ field: c.k, header: c.label }))];
      const data = grouped.rows.map((r) => {
        const o = { _key: r._key };
        tab.cols.forEach((c) => { o[c.k] = c.money ? num(r[c.k]).toFixed(2) : r[c.k]; });
        return o;
      });
      return { cols, data };
    }
    if (report.kind === 'aged') {
      const { rows } = agedRows();
      const cols = [{ field: '_key', header: tab.party }, { field: 'out', header: 'Outstanding' }, ...BUCKETS.map((b) => ({ field: b.k, header: b.label }))];
      return { cols, data: rows.map((r) => ({ _key: r._key, out: num(r.out).toFixed(2), ...Object.fromEntries(BUCKETS.map((b) => [b.k, num(r[b.k]).toFixed(2)])) })) };
    }
    if (report.kind === 'paycal') {
      const { sections } = payCalendar();
      const catCol = tabKey === 'payables';
      const cols = [
        { field: 'bucket', header: 'When due' }, { field: 'vendor', header: tab.party },
        { field: 'no', header: tabKey === 'receivables' ? 'Invoice' : 'Bill' },
        ...(catCol ? [{ field: 'cat', header: 'Category' }] : []),
        { field: 'date', header: catCol ? 'Bill date' : 'Invoice date' },
        { field: 'due', header: 'Due date' },
        { field: 'days', header: 'Days to due' }, { field: 'out', header: 'Amount' },
      ];
      const data = [];
      sections.forEach((s) => s.items.forEach((it) => data.push({
        bucket: s.title, vendor: it.vendor, no: it.no,
        ...(catCol ? { cat: catLabel(it.cat) } : {}),
        date: it.date, due: it.due,
        days: it.dd === null ? '' : it.dd, out: num(it.out).toFixed(2),
      })));
      return { cols, data };
    }
    if (report.kind === 'bars') {
      return { cols: [{ field: 'cat', header: 'Category' }, { field: 'amount', header: 'Amount' }], data: barRows().map((r) => ({ cat: r.cat, amount: r.amount.toFixed(2) })) };
    }
    if (report.kind === 'ratetrend' && trendData) {
      const cols = [{ field: 'item', header: 'Item' }, { field: 'uom', header: 'UOM' }, ...trendData.months.map((m) => ({ field: m, header: monthShort(m) })), { field: 'change', header: 'Change %' }];
      const data = trendItems.map((it) => {
        const o = { item: it.item, uom: it.uom, change: it.change_pct != null ? `${Number(it.change_pct).toFixed(1)}%` : '' };
        it.points.forEach((p) => { o[p.month] = p.rate != null ? p.rate : ''; });
        return o;
      });
      return { cols, data };
    }
    if (report.kind === 'moneytrend') {
      const rows = moneyTrendRows();
      return { cols: [{ field: 'month', header: 'Month' }, { field: 'sales', header: 'Sales' }, { field: 'purchase', header: 'Purchase' }, { field: 'expense', header: 'Expense' }, { field: 'freight', header: 'Freight' }, { field: 'net', header: 'Net' }],
        data: rows.map((r) => ({ month: r.label, sales: r.sales.toFixed(2), purchase: r.purchase.toFixed(2), expense: r.expense.toFixed(2), freight: r.freight.toFixed(2), net: r.net.toFixed(2) })) };
    }
    if (report.kind === 'topitems' && trendData) {
      const items = [...trendItems].sort((a, b) => num(b.total_value) - num(a.total_value));
      return { cols: [{ field: 'item', header: 'Item' }, { field: 'uom', header: 'UOM' }, { field: 'qty', header: 'Qty' }, { field: 'value', header: report.valueLabel }],
        data: items.map((it) => ({ item: it.item, uom: it.uom, qty: num(it.total_qty).toFixed(2), value: num(it.total_value).toFixed(2) })) };
    }
    if (report.kind === 'collection') {
      const { rows } = collectionRows();
      return { cols: [{ field: '_key', header: tab.party }, { field: 'invoiced', header: 'Invoiced' }, { field: 'received', header: 'Received' }, { field: 'out', header: 'Outstanding' }, { field: 'ratio', header: 'Collected %' }],
        data: rows.map((r) => ({ _key: r._key, invoiced: r.invoiced.toFixed(2), received: r.received.toFixed(2), out: r.out.toFixed(2), ratio: `${r.ratio.toFixed(0)}%` })) };
    }
    if (report.kind === 'creditbreach') {
      const rows = creditRows();
      return { cols: [{ field: '_key', header: tab.party }, { field: 'overdue', header: 'Overdue' }, { field: 'days', header: 'Max days past due' }],
        data: rows.map((r) => ({ _key: r._key, overdue: r.overdue.toFixed(2), days: r.days })) };
    }
    if (report.kind === 'variance') {
      const { rows } = varianceRows();
      return { cols: [{ field: '_key', header: 'Head' }, { field: 'cur', header: 'This period' }, { field: 'prev', header: 'Last period' }, { field: 'change', header: 'Change %' }],
        data: rows.map((r) => ({ _key: r._key, cur: r.cur.toFixed(2), prev: r.prev.toFixed(2), change: `${r.change.toFixed(0)}%` })) };
    }
    if (report.kind === 'ratio') {
      const r = ratioRow(); if (!r) return { cols: [], data: [] };
      return { cols: [{ field: 'metric', header: 'Metric' }, { field: 'value', header: 'Value' }],
        data: [{ metric: 'Expense', value: r.expense.toFixed(2) }, { metric: 'Sales', value: r.sales.toFixed(2) }, { metric: 'Expense per ₹1L sales', value: r.ratio.toFixed(2) }] };
    }
    if (report.kind === 'health') {
      const rows = healthRows();
      return { cols: [{ field: 'issue', header: 'Issue' }, { field: 'count', header: 'Count' }, { field: 'value', header: 'Value' }],
        data: rows.map((r) => ({ issue: r.issue, count: r.count, value: r.value.toFixed(2) })) };
    }
    if (report.kind === 'freightpct') {
      const rows = freightPctRows();
      return { cols: [{ field: '_key', header: tab.party }, { field: 'cost', header: 'Freight' }, { field: 'carried', header: 'Value carried' }, { field: 'pct', header: 'Freight %' }],
        data: rows.map((r) => ({ _key: r._key, cost: r.cost.toFixed(2), carried: r.carried.toFixed(2), pct: r.pct != null ? `${r.pct.toFixed(1)}%` : '' })) };
    }
    if (report.kind === 'vendorcmp' && cmpData) {
      const cols = [{ field: 'item', header: 'Item' }, { field: 'vendor', header: 'Vendor' }, { field: 'qty', header: 'Qty' }, { field: 'rate', header: 'Rate' }, { field: 'cheapest', header: 'Cheapest?' }];
      const data = [];
      cmpItems.forEach((it) => {
        it.vendors.forEach((v, i) => {
          data.push({ item: i === 0 ? it.item : '', vendor: v.vendor, qty: num(v.qty).toFixed(2), rate: num(v.rate).toFixed(2), cheapest: i === 0 ? 'cheapest' : '' });
        });
      });
      return { cols, data };
    }
    if (report.kind === 'pivot' && pivotData) {
      // Flatten to one row per item x vendor, a Rate column per month + totals.
      const months = pivotData.months || [];
      const cols = [
        { field: 'item', header: 'Item' },
        { field: 'vendor', header: 'Vendor' },
        ...months.map((m) => ({ field: `m_${m}`, header: monthShort(m) })),
        { field: 'avg_rate', header: 'Avg rate' },
        { field: 'total_qty', header: 'Total qty' },
        { field: 'cheapest', header: 'Cheapest?' },
      ];
      const data = [];
      pivotItems.forEach((it) => {
        it.vendors.forEach((v, i) => {
          const row = { item: i === 0 ? it.item : '', vendor: v.vendor };
          months.forEach((m) => { const c = v.cells[m]; row[`m_${m}`] = c && c.rate != null ? c.rate.toFixed(2) : ''; });
          row.avg_rate = v.avg_rate != null ? v.avg_rate.toFixed(2) : '';
          row.total_qty = num(v.total_qty).toFixed(2);
          row.cheapest = v.vendor === it.cheapest_vendor ? 'cheapest' : '';
          data.push(row);
        });
      });
      return { cols, data };
    }
    return { cols: [], data: [] };
  };
  const bannerLines = () => {
    const co = company ? niceCompany(company) : 'All Companies';
    const per = period.navProps.period === 'fy' ? 'FY (to date)' : period.navProps.period === 'all' ? 'All Time' : period.navProps.period;
    return [`${co} · ${per}`, `${tab.label} — ${report.name}`, `As of ${new Date().toLocaleDateString('en-IN')}`];
  };
  const doExcel = () => {
    const { cols, data } = buildExport();
    if (!data.length) return;
    exportToExcel(data, cols, `report-${tabKey}-${report.id}-${new Date().toISOString().slice(0, 10)}`, 'Report', null, bannerLines());
  };
  const doPdf = () => {
    const { cols, data } = buildExport();
    if (!data.length) return;
    const landscape = report.kind === 'aged' || report.kind === 'ratetrend' || report.kind === 'moneytrend' || report.kind === 'pivot';
    const chartSvg = report.kind === 'moneytrend' ? (document.querySelector('#trendChart svg')?.outerHTML || '') : '';
    const thead = `<tr>${cols.map((c, i) => `<th style="text-align:${i === 0 ? 'left' : 'right'}">${c.header}</th>`).join('')}</tr>`;
    const tbody = data.map((r) => `<tr>${cols.map((c, i) => `<td style="text-align:${i === 0 ? 'left' : 'right'}">${r[c.field] ?? ''}</td>`).join('')}</tr>`).join('');
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<!doctype html><html><head><title>${tab.label} — ${report.name}</title>
      <style>@page{size:A4 ${landscape ? 'landscape' : 'portrait'};margin:12mm}
      body{font-family:Arial,sans-serif;color:#1e293b}h2{margin:0 0 2px;font-size:18px}
      .meta{color:#64748b;font-size:12px;margin-bottom:12px;line-height:1.5}
      table{width:100%;border-collapse:collapse;font-size:11px}
      th{background:#f1f5f9;padding:6px 8px;border:1px solid #e2e8f0;font-size:10px;text-transform:uppercase;color:#475569}
      td{padding:5px 8px;border:1px solid #eef2f7}svg{max-width:100%}</style></head>
      <body><h2>${tab.label} — ${report.name}</h2><div class="meta">${bannerLines().join('<br>')}</div>
      ${chartSvg ? `<div style="margin:8px 0 16px">${chartSvg}</div>` : ''}
      <table><thead>${thead}</thead><tbody>${tbody}</tbody></table>
      <div style="margin-top:10px;color:#94a3b8;font-size:10px">Lancer ERP · Reports</div>
      <script>window.onload=function(){window.print();}<\/script></body></html>`);
    w.document.close();
  };

  const nameCell = (key) => {
    const href = partyHref(key);
    return href
      ? <a href={href} className="text-blue-700 hover:underline" onClick={(e) => { e.preventDefault(); navigate(href.replace(window.location.origin, '')); }}>{key}</a>
      : <span>{key}</span>;
  };

  return (
    <MainLayout>
      <div className="space-y-3 sm:space-y-4">
        <PageHeader compact title={tabKey === 'payables' ? 'Payables Report' : 'Purchase Report'}
          subtitle={tabKey === 'payables'
            ? 'What to pay and when — payment calendar + vendor ageing'
            : 'Purchase spend — top vendors, payables ageing, by category and bill data-health'}
          breadcrumbs={[{ label: 'Purchase', href: '/purchase/dashboard' }, { label: tab.label }]} icon={BarChart3}
          actions={{ right: (
            <div className="flex gap-1.5">
              <button type="button" onClick={doExcel} title="Download Excel"
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700">
                <Download size={14} /> Excel
              </button>
              <button type="button" onClick={doPdf} title="Download PDF"
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800">
                <Download size={14} /> PDF
              </button>
            </div>
          ) }} />

        {/* Top-tab bar — only when there's more than one module tab. The
            standalone is purchase-only (single tab), so it's hidden and the page
            opens straight on the Purchase sub-reports. */}
        {TABS.length > 1 && (
        <div className="flex gap-1 border-b border-slate-200 flex-wrap">
          {TABS.map((t) => (
            <button key={t.key} type="button" onClick={() => { setTabKey(t.key); setReportId((t.reports && t.reports[0] && t.reports[0].id) || 'summary'); }}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px rounded-t-md transition-all duration-150 ${tabKey === t.key ? 'border-blue-600 text-blue-700 bg-blue-50/50' : 'border-transparent text-slate-500 hover:text-blue-600 hover:bg-slate-50'}`}>
              {t.label}
            </button>
          ))}
        </div>
        )}

        {/* Filters FIRST (period + report-specific controls), with export tucked
            tight on its own right-aligned line just below them. */}
        <div className="space-y-2">
        <div className={CTRL_ROW}>
          {/* Date filter (All / Today / Week / Month / FY / Custom) — applies to
              every report, ageing included: ageing shows the open bills DATED in
              the chosen window. Pick "All" to age across all history. */}
          <PeriodNavigator allowAll {...period.navProps} />
          {report.kind === 'aged' && (
            <CustomSelect value={String(dueWithin)} onChange={(e) => setDueWithin(Number(e.target.value))} title="Overdue" className={`${CTRL_FIELD} max-w-[150px]`}>
              <option value="0">All overdue</option>
              <option value="7">Overdue ≤ 7 days</option>
              <option value="15">Overdue ≤ 15 days</option>
              <option value="30">Overdue ≤ 30 days</option>
              <option value="60">Overdue ≤ 60 days</option>
              <option value="90">Overdue ≤ 90 days</option>
            </CustomSelect>
          )}
          {report.kind === 'aged' && (
            <CustomSelect value={String(upcomingWithin)} onChange={(e) => setUpcomingWithin(Number(e.target.value))} title="Upcoming" className={`${CTRL_FIELD} max-w-[180px]`}>
              <option value="0">— Upcoming due —</option>
              <option value="7">Due in next 7 days</option>
              <option value="15">Due in next 15 days</option>
              <option value="30">Due in next 30 days</option>
              <option value="45">Due in next 45 days</option>
            </CustomSelect>
          )}
          {/* Company comes from the global header filter — no local dropdown. */}
          {showItemFilter && itemOptions.length > 0 && (
            <CustomSelect value={itemPick} onChange={(e) => setItemPick(e.target.value)} title="Item" className={`${CTRL_FIELD} max-w-[230px]`}>
              <option value="">All items</option>
              {itemOptions.map((it) => <option key={it} value={it}>{it}</option>)}
            </CustomSelect>
          )}
          {showPartyFilter && partyOptions.length > 0 && (
            <CustomSelect value={partyPick} onChange={(e) => setPartyPick(e.target.value)} title={partyLabel} className={`${CTRL_FIELD} max-w-[230px]`}>
              <option value="">All {partyLabel.toLowerCase()}s</option>
              {partyOptions.map((p) => <option key={p} value={p}>{p}</option>)}
            </CustomSelect>
          )}
          {showCatFilter && (
            <CustomSelect value={catPick} onChange={(e) => setCatPick(e.target.value)} title="Category" className={`${CTRL_FIELD} max-w-[170px]`}>
              <option value="">All categories</option>
              {PURCHASE_CATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </CustomSelect>
          )}
          {showMsmeFilter && (
            <CustomSelect value={msmePick} onChange={(e) => setMsmePick(e.target.value)} title="MSME vendors" className={`${CTRL_FIELD} max-w-[150px]`}>
              <option value="">MSME: All</option>
              <option value="msme">MSME only</option>
              <option value="non">Non-MSME</option>
            </CustomSelect>
          )}
          {/* No Tally source filter — this standalone has no Tally integration. */}
          {/* Excel / PDF live in the page header actions (top-right) — see
              PageHeader actions.right — so they never crowd the filter row. */}
        </div>
        </div>

        {/* Report chips — AFTER the filter row, so the page reads filter → tabs. */}
        {tab.reports.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {tab.reports.map((r) => (
              <button key={r.id} type="button" onClick={() => setReportId(r.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-full border transition ${report.id === r.id ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-500 border-slate-200 hover:border-blue-300'}`}>
                {r.name}
              </button>
            ))}
          </div>
        )}

        <ListState error={error} onRetry={() => setCache((c) => ({ ...c, [tabKey]: undefined }))}>
          {/* ── SUMMARY (original table + by-month graph) ── */}
          {report.kind === 'summary' && (
            <>
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-blue-700">
                <span className="h-3 w-1 rounded-full bg-blue-500" />
                {report.name}
              </p>
              <div className="block overflow-x-auto border border-slate-200 rounded-xl shadow-sm bg-white">
                <table className="w-full min-w-[640px] text-[13px]">
                  <thead>
                    <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b border-primary-100">
                      <th className="px-3 py-2 text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wider">{tab.party}</th>
                      {tab.cols.map((c) => <th key={c.k} className="px-3 py-2 text-right text-[11px] font-semibold text-slate-500 uppercase tracking-wider">{c.label}</th>)}
                      <th className="px-3 py-2 text-right text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Share %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {loading && Array.from({ length: 8 }).map((_, i) => (
                      <tr key={`sk${i}`} className="animate-pulse">
                        <td className="px-3 py-2.5"><div className="h-3 w-44 rounded bg-slate-200" /></td>
                        {tab.cols.map((c, j) => <td key={j} className="px-3 py-2.5"><div className="h-3 w-16 rounded bg-slate-100 ml-auto" /></td>)}
                        <td className="px-3 py-2.5"><div className="h-3 w-10 rounded bg-slate-100 ml-auto" /></td>
                      </tr>
                    ))}
                    {!loading && grouped.rows.length === 0 && (
                      <tr><td colSpan={tab.cols.length + 2} className="px-3 py-10 text-center text-sm text-slate-400">No data for this period.</td></tr>
                    )}
                    {!loading && summaryRows.map((r) => (
                      <tr key={r._key} className="transition-colors hover:bg-blue-50/60">
                        <td className="px-3 py-2 font-medium text-slate-800">{nameCell(r._key)}</td>
                        {tab.cols.map((c) => (
                          <td key={c.k} className={`px-3 py-2 text-right tabular-nums ${c.tone ? TONE[c.tone] : 'text-slate-700'}`}>
                            {c.money ? formatCurrency(r[c.k] || 0) : (r[c.k] || 0).toLocaleString('en-IN')}
                          </td>
                        ))}
                        <td className="px-3 py-2 text-right">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="inline-block h-1.5 w-12 rounded-full bg-indigo-100 overflow-hidden"><span className="block h-full bg-indigo-500" style={{ width: `${Math.min(100, r._conc || 0)}%` }} /></span>
                            <span className="text-slate-500 text-xs">{pctTxt(r._conc)}</span>
                          </span>
                        </td>
                      </tr>
                    ))}
                    {!loading && othersAgg && (
                      <tr className="text-slate-500 italic">
                        <td className="px-3 py-2">Others · {othersAgg.count}</td>
                        {tab.cols.map((c) => <td key={c.k} className="px-3 py-2 text-right tabular-nums">{c.money ? INR(othersAgg[c.k]) : ''}</td>)}
                        <td />
                      </tr>
                    )}
                  </tbody>
                  {grouped.rows.length > 0 && (
                    <tfoot>
                      <tr className="bg-slate-50 font-bold text-slate-800 border-t border-slate-200">
                        <td className="px-3 py-2">Total · {grouped.rows.length}</td>
                        {tab.cols.map((c) => (
                          <td key={c.k} className={`px-3 py-2 text-right tabular-nums ${c.tone ? TONE[c.tone] : ''}`}>
                            {c.money ? formatCurrency(grouped.totals[c.k] || 0) : (grouped.totals[c.k] || 0).toLocaleString('en-IN')}
                          </td>
                        ))}
                        <td />
                      </tr>
                    </tfoot>
                  )}
                </table>
                {report.top10 && grouped.rows.length > 10 && !expanded && (
                  <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-slate-100 text-xs text-slate-500 bg-white">
                    <span>Top 10 of {grouped.rows.length}</span>
                    <button type="button" onClick={() => setExpanded(true)} className="inline-flex items-center gap-1 text-blue-700 hover:underline"><ChevronDown size={14} /> Show all</button>
                  </div>
                )}
                {report.top10 && grouped.rows.length > 10 && expanded && (
                  <>
                    <div className="px-3 pt-2 bg-white"><button type="button" onClick={() => setExpanded(false)} className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline"><ChevronUp size={14} /> Show top 10 only</button></div>
                    <Pager page={page} setPage={setPage} total={grouped.rows.length} size={rpp} />
                  </>
                )}
              </div>

              {/* by-month interactive graph (original) */}
              {byMonth.rows.length > 0 && tabKey !== 'freight' && (() => {
                const clickable = !!LIST_ROUTE[tabKey];
                const hm = byMonth.rows.find((r) => r.ym === hoverYm);
                return (
                  <div className="rounded-xl border border-slate-200 shadow-sm bg-white p-3 sm:p-4">
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-blue-700">
                        <BarChart3 size={13} className="text-blue-500" />{tab.label} by month</p>
                      {hm ? (
                        <p className="text-[11px] text-slate-600">
                          <span className="font-semibold text-slate-800">{monthLabel(hm.ym)}</span>
                          {' · '}{formatCurrency(hm.value)}{' · '}{hm.count} doc(s)
                          {byMonth.total ? ` · ${Math.round((hm.value / byMonth.total) * 100)}%` : ''}
                        </p>
                      ) : (
                        <p className="text-[11px] text-slate-400">{byMonth.label} · {fmtCr(byMonth.total)} total</p>
                      )}
                    </div>
                    <div className="space-y-0.5">
                      {byMonth.rows.map((m) => {
                        const pb = byMonth.max ? Math.max(2, Math.round((m.value / byMonth.max) * 100)) : 0;
                        const hovered = hoverYm === m.ym;
                        return (
                          <div key={m.ym}
                            onMouseEnter={() => setHoverYm(m.ym)} onMouseLeave={() => setHoverYm(null)}
                            onClick={clickable ? () => drillMonth(m.ym) : undefined}
                            role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}
                            onKeyDown={clickable ? (e) => { if (e.key === 'Enter') drillMonth(m.ym); } : undefined}
                            title={clickable ? `View ${monthLabel(m.ym)} ${tab.label.toLowerCase()}` : `${monthLabel(m.ym)} · ${formatCurrency(m.value)}`}
                            className={`flex items-center gap-2 rounded px-1 py-0.5 transition-colors ${hovered ? 'bg-blue-50' : ''} ${clickable ? 'cursor-pointer' : ''}`}>
                            <span className={`w-16 sm:w-20 shrink-0 text-[11px] tabular-nums transition-colors ${hovered ? 'text-blue-700 font-medium' : 'text-slate-500'}`}>{monthLabel(m.ym)}</span>
                            <div className="flex-1 h-5 bg-slate-100/80 rounded-md overflow-hidden min-w-[60px]">
                              <div className={`h-full rounded-md bg-gradient-to-r transition-all duration-500 ease-out ${hovered ? 'from-sky-500 to-blue-600 shadow-sm' : 'from-sky-400 to-blue-500'}`}
                                style={{ width: `${pb}%` }} />
                            </div>
                            <span className={`w-24 sm:w-28 shrink-0 text-right text-[11px] font-medium tabular-nums transition-colors ${hovered ? 'text-blue-700' : 'text-slate-700'}`}>{formatCurrency(m.value)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </>
          )}

          {/* ── AGEING ── */}
          {report.kind === 'aged' && (loading || !raw) && (
            <div className="py-16 text-center text-slate-400">Loading…</div>
          )}
          {report.kind === 'aged' && !loading && raw && (() => {
            const { rows, totals } = agedRows();
            return (
              <div className="overflow-x-auto border border-slate-200 rounded-xl shadow-sm bg-white">
                <table className="w-full text-[13px]">
                  <thead><tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-[11px] uppercase tracking-wider text-slate-500 border-b border-primary-100">
                    <th className="px-3 py-2 text-left font-semibold">{tab.party}</th>
                    <th className="px-3 py-2 text-right font-semibold">Oldest</th>
                    <th className="px-3 py-2 text-right font-semibold">Outstanding</th>
                    {BUCKETS.map((b) => <th key={b.k} className="px-3 py-2 text-right font-semibold">{b.label}</th>)}
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.length === 0 && <tr><td colSpan={BUCKETS.length + 3} className="px-3 py-10 text-center text-sm text-slate-400">Nothing outstanding for this period.</td></tr>}
                    {pageSlice(rows, page).map((r) => {
                      const open = openAged === r._key;
                      const bills = open ? agedPartyBills(r._key) : [];
                      return (
                        <Fragment key={r._key}>
                          <tr className={`cursor-pointer select-none ${open ? 'bg-blue-50/50' : 'hover:bg-blue-50/60'}`} onClick={() => setOpenAged(open ? null : r._key)}>
                            <td className="px-3 py-2 font-medium text-slate-800">
                              <span className={`inline-block mr-1.5 text-slate-400 transition-transform ${open ? 'rotate-90 text-blue-600' : ''}`}>▶</span>
                              {r._key}
                            </td>
                            <td className="px-3 py-2 text-right"><span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-bold ${r.days > 90 ? 'bg-rose-100 text-rose-700' : r.days > 60 ? 'bg-amber-100 text-amber-700' : r.days <= 0 ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500'}`}>{r.days > 0 ? `${r.days}d` : r.days === 0 ? 'today' : `in ${-r.days}d`}</span></td>
                            <td className="px-3 py-2 text-right tabular-nums text-rose-600">{INR(r.out)}</td>
                            {BUCKETS.map((b) => <td key={b.k} className={`px-3 py-2 text-right tabular-nums ${b.tone ? TONE[b.tone] : 'text-slate-700'}`}>{r[b.k] ? INR(r[b.k]) : '—'}</td>)}
                          </tr>
                          {open && (
                            <tr>
                              <td colSpan={BUCKETS.length + 3} className="p-0">
                                <div className="bg-slate-50/70 border-y border-dashed border-slate-200 px-6 py-2">
                                  <table className="w-full text-[12.5px]">
                                    <thead><tr className="text-[10px] uppercase tracking-wide text-slate-500">
                                      <th className="px-2 py-1 text-left font-semibold">{tabKey === 'sales' ? 'Invoice' : 'Bill'} No</th>
                                      <th className="px-2 py-1 text-left font-semibold">Date</th>
                                      <th className="px-2 py-1 text-left font-semibold">Due</th>
                                      <th className="px-2 py-1 text-right font-semibold">Outstanding</th>
                                      <th className="px-2 py-1 text-right font-semibold">Days</th>
                                    </tr></thead>
                                    <tbody className="divide-y divide-slate-100">
                                      {bills.length === 0 && <tr><td colSpan={5} className="px-2 py-3 text-center text-xs text-slate-400">No open bills.</td></tr>}
                                      {bills.map((b, i) => (
                                        <tr key={i} className="hover:bg-white">
                                          <td className="px-2 py-1 font-medium text-slate-700">{b.no}</td>
                                          <td className="px-2 py-1 text-slate-500">{b.date || '—'}</td>
                                          <td className="px-2 py-1 text-slate-500">{b.due || '—'}</td>
                                          <td className="px-2 py-1 text-right tabular-nums text-rose-600">{INR(b.out)}</td>
                                          <td className="px-2 py-1 text-right"><span className={`${b.days > 90 ? 'text-rose-600' : b.days > 60 ? 'text-amber-600' : b.days <= 0 ? 'text-emerald-700' : 'text-slate-500'} font-semibold`}>{b.days > 0 ? `${b.days}d` : b.days === 0 ? 'today' : `in ${-b.days}d`}</span></td>
                                        </tr>
                                      ))}
                                    </tbody>
                                    {bills.length > 0 && (
                                      <tfoot><tr className="border-t border-slate-200 font-semibold text-slate-700">
                                        <td className="px-2 py-1" colSpan={3}>All open · {bills.length} bill{bills.length > 1 ? 's' : ''}</td>
                                        <td className="px-2 py-1 text-right tabular-nums text-rose-600">{INR(bills.reduce((s, b) => s + b.out, 0))}</td>
                                        <td />
                                      </tr></tfoot>
                                    )}
                                  </table>
                                  <a href={withScope(tab.link ? tab.link(r._key) : '#')} className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline mt-2"
                                    onClick={(e) => { e.preventDefault(); if (tab.link) navigate(withScope(tab.link(r._key)).replace(window.location.origin, '')); }}>Open in {tabKey === 'sales' ? 'Invoices' : 'Bills'} →</a>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                  <tfoot><tr className="bg-slate-50 font-bold text-slate-800 border-t border-slate-200">
                    <td className="px-3 py-2">Total · {rows.length}</td><td />
                    <td className="px-3 py-2 text-right tabular-nums text-rose-600">{INR(totals.out)}</td>
                    {BUCKETS.map((b) => <td key={b.k} className={`px-3 py-2 text-right tabular-nums ${b.tone ? TONE[b.tone] : ''}`}>{INR(totals[b.k])}</td>)}
                  </tr></tfoot>
                </table>
                <Pager page={page} setPage={setPage} total={rows.length} />
              </div>
            );
          })()}

          {/* ── PAYMENT / COLLECTION CALENDAR (Payables / Receivables) ── */}
          {report.kind === 'paycal' && (tabKey === 'payables' ? !calData : (loading || !raw)) && (
            <div className="border border-slate-200 rounded-xl bg-white p-10 text-center text-sm text-slate-400">Loading {report.inflow ? 'receivables' : 'payables'}…</div>
          )}
          {report.kind === 'paycal' && (tabKey === 'payables' ? !!calData : (!loading && raw)) && (() => {
            const { sections, grand, overdueTot, next30, count } = payCalendar();
            const inflow = report.inflow === true;             // Receivables (money IN) vs Payables (OUT)
            const noun = inflow ? 'invoice' : 'bill';
            const amtTone = inflow ? 'text-emerald-700' : 'text-rose-700';
            const showCat = !inflow;                            // Category column — Payables only (bills carry it)
            const nCols = showCat ? 7 : 6;                      // table width, for the expand row colSpan
            const dueTag = (dd) => {
              if (dd === null) return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-500">no due date</span>;
              if (dd < 0) return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-rose-50 text-rose-600">{-dd}d overdue</span>;
              if (dd === 0) return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-orange-50 text-orange-700">today</span>;
              if (dd <= 7) return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700">in {dd}d</span>;
              if (dd <= 30) return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-blue-50 text-blue-700">in {dd}d</span>;
              return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-500">in {dd}d</span>;
            };
            return (
              <div className="space-y-3">
                {/* running totals banner — uses the app's indigo theme (matches
                    the active tabs / buttons), not a stray green. */}
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl px-5 py-3.5 text-white bg-indigo-700">
                  <div>
                    <div className="text-[11px] uppercase tracking-wider font-semibold text-indigo-200">{inflow ? 'Total to collect' : 'Total to clear'}</div>
                    <div className="text-xl font-extrabold">{INR(grand)}</div>
                  </div>
                  <div className="text-xs text-indigo-100">
                    Overdue <b className="text-white">{INR(overdueTot)}</b>
                    <span className="mx-1.5 text-indigo-300">·</span>
                    Next 30 days <b className="text-white">{INR(next30)}</b>
                    <span className="mx-1.5 text-indigo-300">·</span>
                    {count} {noun}{count === 1 ? '' : 's'}
                  </div>
                </div>

                {sections.length === 0 && (
                  <div className="border border-slate-200 rounded-xl bg-white p-10 text-center text-sm text-slate-400">Nothing outstanding for this selection.</div>
                )}

                {sections.map((s) => {
                  // Collapsed by DEFAULT — a bucket opens only once the user
                  // clicks it (its key is toggled into `closedPay`, which now
                  // means "opened"). So the page shows just the bucket summary
                  // rows and expands the bills on demand.
                  const closed = !closedPay[s.k];
                  const secPage = payPage[s.k] || 1;
                  const pageItems = pageSlice(s.items, secPage);  // 10 per page (PAGE_SIZE)
                  return (
                    <div key={s.k} className={`border rounded-xl bg-white overflow-hidden shadow-sm ${s.danger ? 'border-rose-200' : 'border-slate-200'}`}>
                      <div
                        className={`flex items-center gap-3 px-4 py-3 cursor-pointer select-none ${s.danger ? 'bg-rose-50 hover:bg-rose-100/70' : 'hover:bg-slate-50'}`}
                        onClick={() => setClosedPay((c) => ({ ...c, [s.k]: !c[s.k] }))}>
                        <span className={`text-slate-400 text-xs transition-transform ${closed ? '-rotate-90' : ''}`}>▼</span>
                        <span className={`h-2.5 w-2.5 rounded-full ${s.dot}`} />
                        <span className="font-bold text-sm text-slate-800">{s.title}</span>
                        <span className="text-xs text-slate-400">— {s.when}</span>
                        <span className="text-xs text-slate-400">· {s.items.length} {noun}{s.items.length === 1 ? '' : 's'}</span>
                        <span className={`ml-auto font-bold text-[15px] tabular-nums ${s.danger ? 'text-rose-600' : 'text-slate-800'}`}>{INR(s.total)}</span>
                      </div>
                      {!closed && (
                        <div className="border-t border-slate-200">
                          <div className="overflow-x-auto">
                            <table className="w-full text-[13px]">
                              <thead><tr className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200">
                                <th className="px-4 py-2 text-left font-semibold">{tab.party}</th>
                                <th className="px-4 py-2 text-left font-semibold">{inflow ? 'Invoice' : 'Bill'}</th>
                                {showCat && <th className="px-4 py-2 text-left font-semibold">Category</th>}
                                <th className="px-4 py-2 text-left font-semibold">{inflow ? 'Invoice date' : 'Bill date'}</th>
                                <th className="px-4 py-2 text-left font-semibold">Due date</th>
                                <th className="px-4 py-2 text-left font-semibold">When</th>
                                <th className="px-4 py-2 text-right font-semibold">Amount</th>
                              </tr></thead>
                              <tbody className="divide-y divide-slate-100">
                                {pageItems.map((it, i) => {
                                  const rid = it.id;
                                  const rowOpen = openPayRow && openPayRow === rid;
                                  const det = rid ? payRowDetail[rid] : null;
                                  return (
                                  <Fragment key={rid || i}>
                                  <tr className={`cursor-pointer select-none ${rowOpen ? 'bg-blue-50/50' : 'hover:bg-slate-50'}`} onClick={() => togglePayRow(it.id)}>
                                    <td className="px-4 py-2 font-medium text-slate-800">
                                      <span className={`inline-block mr-1.5 text-slate-400 transition-transform ${rowOpen ? 'rotate-90 text-blue-600' : ''}`}>▶</span>
                                      {it.vendor}
                                      {!inflow && it.msme && <span className="ml-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full text-indigo-700 bg-indigo-50 border border-indigo-200">MSME</span>}
                                    </td>
                                    <td className="px-4 py-2">
                                      <a href={partyHref(it.vendor) || '#'} className="text-blue-600 font-semibold hover:underline"
                                        onClick={(e) => { e.stopPropagation(); e.preventDefault(); const h = partyHref(it.vendor); if (h) navigate(h.replace(window.location.origin, '')); }}>{it.no}</a>
                                    </td>
                                    {showCat && <td className="px-4 py-2">{it.cat ? <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${catTone(it.cat)}`}>{catLabel(it.cat)}</span> : <span className="text-slate-300">—</span>}</td>}
                                    <td className="px-4 py-2 text-slate-500">{it.date || '—'}</td>
                                    <td className="px-4 py-2 text-slate-500">{it.due || '—'}</td>
                                    <td className="px-4 py-2">{dueTag(it.dd)}</td>
                                    <td className={`px-4 py-2 text-right tabular-nums font-bold ${amtTone}`}>{INR(it.out)}</td>
                                  </tr>
                                  {rowOpen && (
                                    <tr>
                                      <td colSpan={nCols} className="p-0">
                                        <div className="bg-slate-50/70 border-y border-dashed border-slate-200 px-6 py-3">
                                          {det && det.loading && <div className="text-xs text-slate-400 py-2">Loading {inflow ? 'invoice' : 'bill'} details…</div>}
                                          {det && det.error && <div className="text-xs text-rose-500 py-2">Couldn’t load details.</div>}
                                          {det && !det.loading && !det.error && (
                                            <>
                                              <table className="w-full text-[12.5px] mb-2">
                                                <thead><tr className="text-[10px] uppercase tracking-wide text-slate-500">
                                                  <th className="px-2 py-1 text-left font-semibold">Item</th>
                                                  <th className="px-2 py-1 text-right font-semibold">Rate</th>
                                                  <th className="px-2 py-1 text-right font-semibold">Qty</th>
                                                  <th className="px-2 py-1 text-right font-semibold">Amount</th>
                                                </tr></thead>
                                                <tbody className="divide-y divide-slate-100">
                                                  {det.lines.length === 0 && <tr><td colSpan={4} className="px-2 py-2 text-center text-xs text-slate-400">No line items on this {inflow ? 'invoice' : 'bill'}.</td></tr>}
                                                  {det.lines.map((l, li) => (
                                                    <tr key={li} className="hover:bg-white">
                                                      <td className="px-2 py-1 text-slate-700">{l.name}</td>
                                                      <td className="px-2 py-1 text-right tabular-nums text-slate-600">{l.rate ? INR(l.rate) : '—'}</td>
                                                      <td className="px-2 py-1 text-right tabular-nums text-slate-600">{l.qty ? `${l.qty.toLocaleString('en-IN')}${l.uom ? ' ' + l.uom : ''}` : '—'}</td>
                                                      <td className="px-2 py-1 text-right tabular-nums font-medium text-slate-700">{INR(l.amount)}</td>
                                                    </tr>
                                                  ))}
                                                </tbody>
                                              </table>
                                              <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-slate-600">
                                                <span>Total <b className="text-slate-800 tabular-nums">{INR(det.total)}</b></span>
                                                <span>Paid <b className="text-emerald-700 tabular-nums">{INR(det.paid)}</b></span>
                                                <span>Balance <b className={`tabular-nums ${inflow ? 'text-emerald-700' : 'text-rose-700'}`}>{INR(det.balance)}</b></span>
                                                <span>{inflow ? 'Invoice' : 'Bill'} date <b className="text-slate-800">{it.date || '—'}</b></span>
                                                <span>Due <b className="text-slate-800">{it.due || '—'}</b></span>
                                              </div>
                                            </>
                                          )}
                                        </div>
                                      </td>
                                    </tr>
                                  )}
                                  </Fragment>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                          {s.items.length > PAGE_SIZE && (
                            <Pager page={secPage} setPage={(p) => setPayPage((pp) => ({ ...pp, [s.k]: typeof p === 'function' ? p(pp[s.k] || 1) : p }))} total={s.items.length} />
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* ── CATEGORY BARS ── */}
          {report.kind === 'bars' && (() => {
            const rows = barRows(); const max = Math.max(1, ...rows.map((r) => r.amount));
            const miniList = (list, tone) => {
              if (!list || !list.length) return <div className="px-1 py-6 text-center text-xs text-slate-400">None.</div>;
              const m = Math.max(1, ...list.map((x) => x.amount));
              const tot = list.reduce((s, x) => s + x.amount, 0);
              return (
                <div className="flex flex-col gap-1.5">
                  {list.slice(0, 8).map((x) => (
                    <div key={x.name} className="flex items-center gap-2 text-[12.5px]">
                      <div className="w-32 shrink-0 text-slate-600 truncate" title={x.name}>{x.name}</div>
                      <div className="flex-1 h-2.5 bg-indigo-50 rounded overflow-hidden"><div className={`h-full ${tone === 'v' ? 'bg-violet-500' : 'bg-blue-500'}`} style={{ width: `${(x.amount / m) * 100}%` }} /></div>
                      <div className="w-24 text-right tabular-nums text-slate-600">{INR(x.amount)}</div>
                      <div className="w-9 text-right text-slate-400 text-[11px]">{tot ? Math.round((x.amount / tot) * 100) : 0}%</div>
                    </div>
                  ))}
                  {list.length > 8 && <div className="text-[11px] text-slate-400 mt-1">+{list.length - 8} more</div>}
                </div>
              );
            };
            return (
              <div className="border border-slate-200 rounded-xl shadow-sm bg-white overflow-hidden">
                {rows.length === 0 && <div className="px-3 py-10 text-center text-sm text-slate-400">No data for this period.</div>}
                {rows.map((r) => {
                  const open = openCat === r.cat;
                  const d = catItems[r.cat];
                  return (
                    <div key={r.cat} className="border-t border-slate-100 first:border-t-0">
                      {/* category row — click to expand */}
                      <div className={`flex items-center gap-3 px-4 py-2 text-[13px] cursor-pointer select-none ${open ? 'bg-blue-50/40' : 'hover:bg-slate-50'}`}
                        onClick={() => toggleCat(r.cat)}>
                        <span className={`text-slate-400 transition-transform ${open ? 'rotate-90 text-blue-600' : ''}`}>▶</span>
                        <div className="w-36 shrink-0 font-medium text-slate-800">{r.cat}</div>
                        <div className="flex-1 h-3.5 bg-indigo-50 rounded overflow-hidden"><div className="h-full bg-gradient-to-r from-sky-400 to-blue-500" style={{ width: `${(r.amount / max) * 100}%` }} /></div>
                        <div className="w-32 text-right tabular-nums text-slate-700">{INR(r.amount)}</div>
                        <a href={categoryHref(r.cat)} className="w-12 text-right text-[11px] text-blue-700 hover:underline"
                          onClick={(e) => { e.stopPropagation(); e.preventDefault(); navigate(categoryHref(r.cat).replace(window.location.origin, '')); }}>bills →</a>
                      </div>
                      {/* expanded panel — Items / Vendors tabs */}
                      {open && (
                        <div className="bg-slate-50/60 border-t border-dashed border-slate-200 px-5 py-3">
                          {d?.loading && <div className="py-6 text-center text-xs text-slate-400">Loading breakdown…</div>}
                          {d?.error && <div className="py-6 text-center text-xs text-rose-500">Could not load this category.</div>}
                          {d && !d.loading && !d.error && (
                            <>
                              <div className="inline-flex gap-0.5 bg-slate-200/70 rounded-lg p-0.5 mb-3">
                                {['items', 'vendors'].map((t) => (
                                  <button key={t} type="button" onClick={() => setCatTab(t)}
                                    className={`px-3 py-1 text-xs font-semibold rounded-md capitalize ${catTab === t ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500'}`}>{t}</button>
                                ))}
                              </div>
                              {catTab === 'items' ? miniList(d.items, 'i') : miniList(d.vendors, 'v')}
                              <a href={categoryHref(r.cat)} className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline mt-3"
                                onClick={(e) => { e.preventDefault(); navigate(categoryHref(r.cat).replace(window.location.origin, '')); }}>See all bills in {r.cat} →</a>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* ── ITEM QTY & RATE TREND ── */}
          {report.kind === 'ratetrend' && (
            !trendData
              ? <div className="py-16 text-center text-slate-400">Loading item trend…</div>
              : (
                <div className="overflow-x-auto border border-slate-200 rounded-xl shadow-sm bg-white">
                  <table className="w-full text-[13px]">
                    <thead><tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-[11px] uppercase tracking-wider text-slate-500 border-b border-primary-100">
                      <th className="px-3 py-2 text-left font-semibold">Item</th><th />
                      {trendData.months.map((m) => <th key={m} className="px-3 py-2 text-right font-semibold whitespace-nowrap">{monthShort(m)}</th>)}
                      <th className="px-3 py-2 text-right font-semibold">Change</th>
                    </tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {trendItems.length === 0 && <tr><td colSpan={trendData.months.length + 3} className="px-3 py-10 text-center text-sm text-slate-400">No line items in this window.</td></tr>}
                      {pageSlice(trendItems, page, rpp).map((it) => {
                        const chg = it.change_pct != null ? Number(it.change_pct) : null;
                        const open = openTrend === it.item;
                        return (
                          <Fragment key={it.item}>
                            {/* Rate row — always shown, click to expand the Qty row. */}
                            <tr className="hover:bg-blue-50/60 cursor-pointer select-none" onClick={() => setOpenTrend(open ? null : it.item)}>
                              <td className="px-3 py-2 font-medium text-slate-800">
                                <span className={`inline-block mr-1.5 text-slate-400 transition-transform ${open ? 'rotate-90 text-blue-600' : ''}`}>▶</span>
                                {it.item} <span className="text-slate-400 text-xs">{it.uom}</span>{it.category && <span className={`ml-2 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide border ${catChipCls(it.category)}`}>{it.category}</span>}
                              </td>
                              <td className="px-2 py-2 text-left text-[11px] text-slate-400">Rate</td>
                              {it.points.map((p, i) => <td key={i} className={`px-3 py-2 text-right tabular-nums ${i === it.points.length - 1 && it.dropped ? 'text-rose-600 font-semibold' : 'text-slate-700'}`}>{p.rate != null ? `₹${Number(p.rate).toFixed(2)}` : '—'}</td>)}
                              <td className={`px-3 py-2 text-right tabular-nums font-semibold ${chg == null ? 'text-slate-400' : chg < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>
                                {chg == null ? '—' : <span className="inline-flex items-center gap-1">{chg < 0 ? <><AlertTriangle size={12} /> ▼</> : '▲'} {Math.abs(chg).toFixed(1)}%</span>}
                              </td>
                            </tr>
                            {/* Qty row — only when the item is expanded. */}
                            {open && (
                              <tr className="bg-slate-50/60">
                                <td className="px-3 py-1" />
                                <td className="px-2 py-1 text-left text-[11px] text-slate-400">Qty</td>
                                {it.points.map((p, i) => <td key={i} className="px-3 py-1 text-right tabular-nums text-[11px] text-slate-500">{p.qty != null ? Number(p.qty).toLocaleString('en-IN') : '—'}</td>)}
                                <td />
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                  <Pager page={page} setPage={setPage} total={trendItems.length} size={rpp} />
                </div>
              )
          )}

          {/* ── MONEY TREND ── */}
          {report.kind === 'moneytrend' && (() => {
            const rows = moneyTrendRows();
            const chart = rows.map((r) => ({ month: r.label, Sales: Math.round(r.sales), Purchase: Math.round(r.purchase), Expense: Math.round(r.expense), Freight: Math.round(r.freight) }));
            return (
              <>
                <div className="border border-slate-200 rounded-xl shadow-sm bg-white p-4" id="trendChart">
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={chart} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                      <XAxis dataKey="month" fontSize={11} />
                      <YAxis fontSize={11} tickFormatter={(v) => formatCurrency(v, { notation: 'compact' })} />
                      <Tooltip formatter={(v) => INR(v)} />
                      <Legend />
                      <Line type="monotone" dataKey="Sales" stroke="#2563eb" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="Purchase" stroke="#7c3aed" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="Expense" stroke="#b45309" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="Freight" stroke="#059669" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="h-3" />
                <div className="overflow-x-auto border border-slate-200 rounded-xl shadow-sm bg-white">
                  <table className="w-full text-[13px]">
                    <thead><tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-[11px] uppercase tracking-wider text-slate-500 border-b border-primary-100">
                      <th className="px-3 py-2 text-left font-semibold">Month</th>
                      {['Sales', 'Purchase', 'Expense', 'Freight', 'Net'].map((h) => <th key={h} className="px-3 py-2 text-right font-semibold">{h}</th>)}
                    </tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {rows.map((r) => (
                        <tr key={r.label} className="hover:bg-blue-50/60">
                          <td className="px-3 py-2 font-medium text-slate-800">{r.label}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{INR(r.sales)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{INR(r.purchase)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{INR(r.expense)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{INR(r.freight)}</td>
                          <td className={`px-3 py-2 text-right tabular-nums ${r.net >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>{INR(r.net)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            );
          })()}

          {/* ── TOP ITEMS (products / purchased items), ranked by value ── */}
          {report.kind === 'topitems' && (
            !trendData
              ? <div className="py-16 text-center text-slate-400">Loading items…</div>
              : (() => {
                const items = [...trendItems].sort((a, b) => num(b.total_value) - num(a.total_value));
                const grand = items.reduce((s, it) => s + num(it.total_value), 0);
                // Cumulative share up to AND including each item, by full-list rank
                // (so it stays correct across pages).
                const concByItem = new Map(); let acc = 0;
                items.forEach((it) => { acc += num(it.total_value); concByItem.set(it.item, grand ? (acc / grand) * 100 : 0); });
                const shown = (!expanded && items.length > 10) ? items.slice(0, 10) : pageSlice(items, page);
                return (
                  <>
                    <div className="overflow-x-auto border border-slate-200 rounded-xl shadow-sm bg-white">
                      <table className="w-full text-[13px]">
                        <thead><tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-[11px] uppercase tracking-wider text-slate-500 border-b border-primary-100">
                          <th className="px-3 py-2 text-left font-semibold">Item</th>
                          <th className="px-3 py-2 text-right font-semibold">Qty</th>
                          <th className="px-3 py-2 text-right font-semibold">{report.valueLabel}</th>
                          <th className="px-3 py-2 text-right font-semibold">Share %</th>
                        </tr></thead>
                        <tbody className="divide-y divide-slate-100">
                          {items.length === 0 && <tr><td colSpan={4} className="px-3 py-10 text-center text-sm text-slate-400">No line items in this window.</td></tr>}
                          {shown.map((it) => { const conc = concByItem.get(it.item) || 0; return (
                            <tr key={it.item} className="hover:bg-blue-50/60">
                              <td className="px-3 py-2 font-medium text-slate-800">{it.item} <span className="text-slate-400 text-xs">{it.uom}</span>{it.category && <span className={`ml-2 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide border ${catChipCls(it.category)}`}>{it.category}</span>}</td>
                              <td className="px-3 py-2 text-right tabular-nums text-slate-700">{num(it.total_qty).toLocaleString('en-IN')}</td>
                              <td className="px-3 py-2 text-right tabular-nums text-slate-800">{INR(it.total_value)}</td>
                              <td className="px-3 py-2 text-right"><span className="inline-flex items-center gap-1.5"><span className="inline-block h-1.5 w-12 rounded-full bg-indigo-100 overflow-hidden"><span className="block h-full bg-indigo-500" style={{ width: `${Math.min(100, conc)}%` }} /></span><span className="text-slate-500 text-xs">{pctTxt(conc)}</span></span></td>
                            </tr>
                          ); })}
                        </tbody>
                        <tfoot><tr className="bg-slate-50 font-bold text-slate-800 border-t border-slate-200">
                          <td className="px-3 py-2">Total · {items.length}</td><td /><td className="px-3 py-2 text-right tabular-nums">{INR(grand)}</td><td />
                        </tr></tfoot>
                      </table>
                    </div>
                    {items.length > 10 && !expanded && (
                      <button type="button" onClick={() => setExpanded(true)} className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:underline">
                        <ChevronDown size={14} /> Show all {items.length}
                      </button>
                    )}
                    {items.length > 10 && expanded && (
                      <div className="mt-2 border border-slate-200 rounded-xl bg-white overflow-hidden">
                        <div className="px-3 pt-2"><button type="button" onClick={() => setExpanded(false)} className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline"><ChevronUp size={14} /> Show top 10 only</button></div>
                        <Pager page={page} setPage={setPage} total={items.length} />
                      </div>
                    )}
                  </>
                );
              })()
          )}

          {/* ── COLLECTION / DSO ── */}
          {report.kind === 'collection' && (() => {
            const { rows, totals } = collectionRows();
            return (
              <div className="overflow-x-auto border border-slate-200 rounded-xl shadow-sm bg-white">
                <table className="w-full text-[13px]">
                  <thead><tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-[11px] uppercase tracking-wider text-slate-500 border-b border-primary-100">
                    <th className="px-3 py-2 text-left font-semibold">{tab.party}</th>
                    <th className="px-3 py-2 text-right font-semibold">Invoiced</th>
                    <th className="px-3 py-2 text-right font-semibold">Received</th>
                    <th className="px-3 py-2 text-right font-semibold">Outstanding</th>
                    <th className="px-3 py-2 text-right font-semibold">Collected %</th>
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.length === 0 && <tr><td colSpan={5} className="px-3 py-10 text-center text-sm text-slate-400">No data for this period.</td></tr>}
                    {pageSlice(rows, page).map((r) => (
                      <tr key={r._key} className="hover:bg-blue-50/60">
                        <td className="px-3 py-2 font-medium text-slate-800">{nameCell(r._key)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{INR(r.invoiced)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{INR(r.received)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-rose-600">{INR(r.out)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${r.ratio >= 90 ? 'text-emerald-700' : r.ratio >= 60 ? 'text-amber-600' : 'text-rose-600'}`}>{r.ratio.toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr className="bg-slate-50 font-bold text-slate-800 border-t border-slate-200">
                    <td className="px-3 py-2">Total · {rows.length}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{INR(totals.invoiced)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-700">{INR(totals.received)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-rose-600">{INR(totals.out)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{totals.invoiced ? Math.round((totals.received / totals.invoiced) * 100) : 0}%</td>
                  </tr></tfoot>
                </table>
                <Pager page={page} setPage={setPage} total={rows.length} />
              </div>
            );
          })()}

          {/* ── CREDIT-LIMIT BREACH ── */}
          {report.kind === 'creditbreach' && (loading || !raw) && (
            <div className="py-16 text-center text-slate-400">Loading…</div>
          )}
          {report.kind === 'creditbreach' && !loading && raw && (() => {
            const rows = creditRows();
            const total = rows.reduce((s, r) => s + r.overdue, 0);
            return (
              <div className="overflow-x-auto border border-slate-200 rounded-xl shadow-sm bg-white">
                <table className="w-full text-[13px]">
                  <thead><tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-[11px] uppercase tracking-wider text-slate-500 border-b border-primary-100">
                    <th className="px-3 py-2 text-left font-semibold">{tab.party}</th>
                    <th className="px-3 py-2 text-right font-semibold">Overdue (past terms)</th>
                    <th className="px-3 py-2 text-right font-semibold">Max days past due</th>
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.length === 0 && <tr><td colSpan={3} className="px-3 py-10 text-center text-sm text-slate-400">No customer is past their credit terms for this period.</td></tr>}
                    {pageSlice(rows, page).map((r) => (
                      <tr key={r._key} className="hover:bg-blue-50/60">
                        <td className="px-3 py-2 font-medium text-slate-800">{nameCell(r._key)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-rose-600 font-semibold">{INR(r.overdue)}</td>
                        <td className="px-3 py-2 text-right">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-bold ${r.days > 90 ? 'bg-rose-100 text-rose-700' : r.days > 30 ? 'bg-amber-100 text-amber-700' : 'text-slate-500'}`}>{r.days}d</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {rows.length > 0 && (
                    <tfoot><tr className="bg-slate-50 font-bold text-slate-800 border-t border-slate-200">
                      <td className="px-3 py-2">Total · {rows.length}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-rose-600">{INR(total)}</td>
                      <td />
                    </tr></tfoot>
                  )}
                </table>
                <Pager page={page} setPage={setPage} total={rows.length} />
              </div>
            );
          })()}

          {/* ── EXPENSE VARIANCE ── */}
          {report.kind === 'variance' && (() => {
            const { rows, curTot, prevTot } = varianceRows();
            return (
              <div className="overflow-x-auto border border-slate-200 rounded-xl shadow-sm bg-white">
                <table className="w-full text-[13px]">
                  <thead><tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-[11px] uppercase tracking-wider text-slate-500 border-b border-primary-100">
                    <th className="px-3 py-2 text-left font-semibold">Head</th>
                    <th className="px-3 py-2 text-right font-semibold">This period</th>
                    <th className="px-3 py-2 text-right font-semibold">Last period</th>
                    <th className="px-3 py-2 text-right font-semibold">Change %</th>
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.length === 0 && <tr><td colSpan={4} className="px-3 py-10 text-center text-sm text-slate-400">Pick a bounded period (Month / FY / Custom) to compare against the previous one.</td></tr>}
                    {pageSlice(rows, page).map((r) => (
                      <tr key={r._key} className="hover:bg-blue-50/60">
                        <td className="px-3 py-2 font-medium text-slate-800">{r._key}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{INR(r.cur)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-500">{INR(r.prev)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums font-semibold ${r.change > 0 ? 'text-rose-600' : 'text-emerald-700'}`}>{r.change > 0 ? '▲' : '▼'} {Math.abs(r.change).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                  {rows.length > 0 && (
                    <tfoot><tr className="bg-slate-50 font-bold text-slate-800 border-t border-slate-200">
                      <td className="px-3 py-2">Total · {rows.length}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{INR(curTot)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-500">{INR(prevTot)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${curTot > prevTot ? 'text-rose-600' : 'text-emerald-700'}`}>{prevTot ? `${curTot > prevTot ? '▲' : '▼'} ${Math.abs(((curTot - prevTot) / prevTot) * 100).toFixed(0)}%` : '—'}</td>
                    </tr></tfoot>
                  )}
                </table>
                <Pager page={page} setPage={setPage} total={rows.length} />
              </div>
            );
          })()}

          {/* ── EXPENSE PER ₹1L SALES ── */}
          {report.kind === 'ratio' && (() => {
            const r = ratioRow();
            if (!r) return <div className="py-16 text-center text-slate-400">No data.</div>;
            return (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[{ l: 'Expense', v: INR(r.expense), t: 'text-slate-800' }, { l: 'Sales', v: INR(r.sales), t: 'text-slate-800' }, { l: 'Expense per ₹1L sales', v: INR(r.ratio), t: 'text-amber-600' }].map((c) => (
                  <div key={c.l} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">{c.l}</div>
                    <div className={`text-2xl font-bold mt-1 ${c.t}`}>{c.v}</div>
                  </div>
                ))}
              </div>
            );
          })()}

          {/* ── DATA-HEALTH ── */}
          {report.kind === 'health' && (() => {
            const rows = healthRows();
            return (
              <div className="overflow-x-auto border border-slate-200 rounded-xl shadow-sm bg-white">
                <table className="w-full text-[13px]">
                  <thead><tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-[11px] uppercase tracking-wider text-slate-500 border-b border-primary-100">
                    <th className="px-3 py-2 text-left font-semibold">Issue</th>
                    <th className="px-3 py-2 text-right font-semibold">Count</th>
                    <th className="px-3 py-2 text-right font-semibold">Value</th>
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((r) => {
                      const clickable = r.count > 0;
                      const go = () => {
                        const q = new URLSearchParams();
                        q.set('dq', r.dq);
                        if (company) q.set('company', company);
                        navigate(`/purchase/bills?${q.toString()}`);
                      };
                      return (
                        <tr key={r.issue}
                          className={`${clickable ? 'hover:bg-blue-50/60 cursor-pointer' : 'opacity-60'}`}
                          onClick={clickable ? go : undefined}
                          title={clickable ? 'Open these bills to fix them' : 'No bills with this issue'}>
                          <td className="px-3 py-2 font-medium text-slate-800">
                            {r.issue}
                            {clickable && <span className="ml-2 text-[11px] text-blue-600">— fix →</span>}
                          </td>
                          <td className="px-3 py-2 text-right"><span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-bold ${r.sev === 'bad' ? 'bg-rose-100 text-rose-700' : r.sev === 'warn' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>{r.count}</span></td>
                          <td className="px-3 py-2 text-right tabular-nums text-rose-600">{r.value ? INR(r.value) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })()}

          {/* ── FREIGHT % OF VALUE ── */}
          {report.kind === 'freightpct' && (() => {
            const rows = freightPctRows();
            const anyCarried = rows.some((r) => r.carried > 0);
            return (
              <>
                {!anyCarried && <p className="text-xs text-amber-600 mb-2">The freight list doesn\'t carry the goods value per slip yet, so the share can\'t be computed. Freight totals are shown; wiring the carried value is a follow-up.</p>}
                <div className="overflow-x-auto border border-slate-200 rounded-xl shadow-sm bg-white">
                  <table className="w-full text-[13px]">
                    <thead><tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-[11px] uppercase tracking-wider text-slate-500 border-b border-primary-100">
                      <th className="px-3 py-2 text-left font-semibold">{tab.party}</th>
                      <th className="px-3 py-2 text-right font-semibold">Freight</th>
                      <th className="px-3 py-2 text-right font-semibold">Value carried</th>
                      <th className="px-3 py-2 text-right font-semibold">Freight %</th>
                    </tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {rows.length === 0 && <tr><td colSpan={4} className="px-3 py-10 text-center text-sm text-slate-400">No freight for this period.</td></tr>}
                      {pageSlice(rows, page).map((r) => (
                        <tr key={r._key} className="hover:bg-blue-50/60">
                          <td className="px-3 py-2 font-medium text-slate-800">{nameCell(r._key)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{INR(r.cost)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-500">{r.carried ? INR(r.carried) : '—'}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-amber-600">{r.pct != null ? `${r.pct.toFixed(1)}%` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <Pager page={page} setPage={setPage} total={rows.length} />
                </div>
              </>
            );
          })()}
          {/* ── VENDOR COMPARISON (same item) — collapsible per item ── */}
          {report.kind === 'vendorcmp' && (
            !cmpData
              ? <div className="py-16 text-center text-slate-400">Loading vendor comparison…</div>
              : (
                <div className="border border-slate-200 rounded-xl shadow-sm bg-white overflow-hidden">
                  {cmpItems.length === 0 && <div className="px-3 py-10 text-center text-sm text-slate-400">No items bought from more than one vendor in this window.</div>}
                  {pageSlice(cmpItems, page, rpp).map((it) => {
                    const open = openCmp === it.item;
                    const spread = it.spread_pct != null ? Number(it.spread_pct) : null;
                    return (
                      <div key={it.item} className="border-t border-slate-100 first:border-t-0">
                        {/* collapsed row: item + category + cheapest + spread */}
                        <div className={`flex items-center gap-3 px-4 py-2.5 text-[13px] cursor-pointer select-none ${open ? 'bg-blue-50/40' : 'hover:bg-slate-50'}`}
                          onClick={() => setOpenCmp(open ? null : it.item)}>
                          <span className={`text-slate-400 transition-transform ${open ? 'rotate-90 text-blue-600' : ''}`}>▶</span>
                          <span className="font-semibold text-slate-800">{it.item}</span>
                          <span className="text-slate-400 text-xs">{it.uom}</span>
                          {it.category && <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide border ${catChipCls(it.category)}`}>{it.category}</span>}
                          <span className="ml-auto text-[12px] text-slate-500">{it.vendors.length} vendors</span>
                          {it.cheapest_vendor && <span className="text-[12px] text-emerald-700 font-medium hidden sm:inline">cheapest: {it.cheapest_vendor}</span>}
                          {spread != null && spread > 0 && <span className={`text-[11px] font-semibold ${spread > 50 ? 'text-rose-600' : 'text-amber-600'}`}>spread {spread.toFixed(0)}%</span>}
                        </div>
                        {/* expanded: the per-vendor table */}
                        {open && (
                          <div className="bg-slate-50/60 border-t border-dashed border-slate-200">
                            <table className="w-full text-[13px]">
                              <thead><tr className="text-[11px] uppercase tracking-wide text-slate-500">
                                <th className="px-5 py-1.5 text-left font-semibold">Vendor</th>
                                <th className="px-3 py-1.5 text-right font-semibold">Qty ({it.uom || 'unit'})</th>
                                <th className="px-3 py-1.5 text-right font-semibold">Value</th>
                                <th className="px-5 py-1.5 text-right font-semibold">Rate</th>
                              </tr></thead>
                              <tbody className="divide-y divide-slate-100">
                                {it.vendors.map((v) => {
                                  const isCheapest = v.vendor === it.cheapest_vendor;
                                  return (
                                    <tr key={v.vendor} className={isCheapest ? 'bg-emerald-50/50' : 'hover:bg-white'}>
                                      <td className="px-5 py-1.5 font-medium text-slate-800">{v.vendor}{isCheapest && <span className="ml-2 text-[10px] uppercase tracking-wide text-emerald-700 font-bold">cheapest</span>}</td>
                                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{num(v.qty).toLocaleString('en-IN')}</td>
                                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{INR(v.value)}</td>
                                      <td className={`px-5 py-1.5 text-right tabular-nums font-semibold ${isCheapest ? 'text-emerald-700' : 'text-slate-700'}`}>₹{num(v.rate).toFixed(2)}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <Pager page={page} setPage={setPage} total={cmpItems.length} size={rpp} />
                </div>
              )
          )}

          {/* ── ITEM × VENDOR PIVOT (rate trend + vendor comparison clubbed) ── */}
          {report.kind === 'pivot' && (
            !pivotData
              ? <div className="py-16 text-center text-slate-400">Loading item pivot…</div>
              : (
                <div className="border border-slate-200 rounded-xl shadow-sm bg-white overflow-hidden">
                  {pivotItems.length === 0 && <div className="px-3 py-10 text-center text-sm text-slate-400">No items bought from more than one vendor in this window.</div>}
                  {pageSlice(pivotItems, page, rpp).map((it) => {
                    const open = openCmp === it.item;
                    const months = pivotData.months || [];
                    const spread = it.spread_pct != null ? Number(it.spread_pct) : null;
                    const chg = it.change_pct != null ? Number(it.change_pct) : null;
                    return (
                      <div key={it.item} className="border-t border-slate-100 first:border-t-0">
                        {/* collapsed row: item + category + #vendors + cheapest + spread + trend */}
                        <div className={`flex items-center gap-3 px-4 py-2.5 text-[13px] cursor-pointer select-none ${open ? 'bg-blue-50/40' : 'hover:bg-slate-50'}`}
                          onClick={() => setOpenCmp(open ? null : it.item)}>
                          <span className={`text-slate-400 transition-transform ${open ? 'rotate-90 text-blue-600' : ''}`}>▶</span>
                          <span className="font-semibold text-slate-800">{it.item}</span>
                          {it.uom && <span className="text-slate-400 text-xs">{it.uom}</span>}
                          {it.category && <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide border ${catChipCls(it.category)}`}>{it.category}</span>}
                          <span className="ml-auto text-[12px] text-slate-500">{it.vendors.length} vendors</span>
                          {it.cheapest_vendor && <span className="text-[12px] text-emerald-700 font-medium hidden sm:inline">cheapest: {it.cheapest_vendor}</span>}
                          {spread != null && spread > 0 && <span className={`text-[11px] font-semibold ${spread > 50 ? 'text-rose-600' : 'text-amber-600'}`}>spread {spread.toFixed(0)}%</span>}
                          {chg != null && <span className={`text-[11px] font-semibold ${chg < 0 ? 'text-emerald-700' : chg > 0 ? 'text-rose-600' : 'text-slate-400'}`}>{chg > 0 ? '▲' : chg < 0 ? '▼' : ''} {Math.abs(chg).toFixed(1)}%</span>}
                        </div>
                        {/* expanded: vendor (rows) × month (cols) rate grid + month-avg trend */}
                        {open && (
                          <div className="bg-slate-50/60 border-t border-dashed border-slate-200 overflow-x-auto">
                            <table className="w-full text-[13px] min-w-[560px]">
                              <thead><tr className="text-[11px] uppercase tracking-wide text-slate-500">
                                <th className="px-5 py-1.5 text-left font-semibold sticky left-0 bg-slate-50/60">Vendor</th>
                                {months.map((m) => <th key={m} className="px-3 py-1.5 text-right font-semibold whitespace-nowrap">{monthShort(m)}</th>)}
                                <th className="px-3 py-1.5 text-right font-semibold">Avg rate</th>
                                <th className="px-5 py-1.5 text-right font-semibold">Total qty</th>
                              </tr></thead>
                              <tbody className="divide-y divide-slate-100">
                                {it.vendors.map((v) => {
                                  const isCheapest = v.vendor === it.cheapest_vendor;
                                  return (
                                    <tr key={v.vendor} className={isCheapest ? 'bg-emerald-50/50' : 'hover:bg-white'}>
                                      <td className={`px-5 py-1.5 font-medium text-slate-800 sticky left-0 ${isCheapest ? 'bg-emerald-50/50' : 'bg-slate-50/60'}`}>
                                        {v.vendor}{isCheapest && <span className="ml-2 text-[10px] uppercase tracking-wide text-emerald-700 font-bold">cheapest</span>}
                                      </td>
                                      {months.map((m) => {
                                        const c = v.cells[m];
                                        return (
                                          <td key={m} className="px-3 py-1.5 text-right tabular-nums text-slate-700">
                                            {c && c.rate != null
                                              ? <span title={c.qty != null ? `Qty ${Number(c.qty).toLocaleString('en-IN')}` : ''}>₹{Number(c.rate).toFixed(2)}</span>
                                              : <span className="text-slate-300">—</span>}
                                          </td>
                                        );
                                      })}
                                      <td className={`px-3 py-1.5 text-right tabular-nums font-semibold ${isCheapest ? 'text-emerald-700' : 'text-slate-700'}`}>{v.avg_rate != null ? `₹${Number(v.avg_rate).toFixed(2)}` : '—'}</td>
                                      <td className="px-5 py-1.5 text-right tabular-nums text-slate-600">{num(v.total_qty).toLocaleString('en-IN')}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                              <tfoot><tr className="bg-white border-t border-slate-200 text-[12px] font-semibold text-slate-600">
                                <td className="px-5 py-1.5 text-left sticky left-0 bg-white">Month avg</td>
                                {months.map((m) => {
                                  const a = it.month_avg ? it.month_avg[m] : null;
                                  return <td key={m} className="px-3 py-1.5 text-right tabular-nums">{a && a.rate != null ? `₹${Number(a.rate).toFixed(2)}` : '—'}</td>;
                                })}
                                <td className={`px-3 py-1.5 text-right tabular-nums ${chg == null ? 'text-slate-400' : chg < 0 ? 'text-emerald-700' : 'text-rose-600'}`} colSpan={2}>
                                  {chg == null ? '—' : `${chg > 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(1)}%`}
                                </td>
                              </tr></tfoot>
                            </table>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <Pager page={page} setPage={setPage} total={pivotItems.length} size={rpp} />
                </div>
              )
          )}
        </ListState>
      </div>
    </MainLayout>
  );
}
