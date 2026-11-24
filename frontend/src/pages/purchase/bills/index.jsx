import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useGlobalCompany } from '@/hooks/useGlobalCompany.js';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import { Button } from '../../../components/ui';
import { Pencil, Trash2, Eye, RefreshCw, CheckCheck, FilePen, BarChart3 } from 'lucide-react';
import ManualBillModal from './ManualBillModal';
import MobileListCards from '../components/MobileListCards';
import BillQuickView, { billSource } from './BillQuickView.jsx';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import { confirm } from '@/components/common/confirm';
import { formatDate, formatCurrency } from '@/utils/formatters';
import ListState from '@/components/common/ListState.jsx';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import { CTRL_ROW, CTRL_FIELD } from '@/components/common/controls';
import CustomSelect from '@/components/ui/CustomSelect';
import MultiSelect from '@/components/ui/MultiSelect';

// Journal / GST Journal vouchers are expense bookings (rent 194I, professional
// 194J, freight/contract 194C — where TDS is deducted), not goods purchases. The
// Expenses tab groups them; Purchases hides them so the two views don't overlap.
// A bill is an Expense when the operator flagged it so at scan time (is_expense —
// works even for bills matched to a Tally "GST Purchase" voucher), OR its Tally
// voucher type is itself a journal. We match on "contains 'journal'" so every
// operator spelling counts — "Journal", "GST Journal", "GST - Journal", …
const isExpenseBill = (r) => r.is_expense === true
  || (r.tally_voucher_type || '').toLowerCase().includes('journal');

// Tally's "Purchase Accounts" is ONLY RM + Packing; Freight, Machinery and the
// Expenses spend-category are booked under separate expense/other accounts. So for
// the Purchases vs Expenses split we count those categories as expenses too — a bill
// is a real Purchase only when it isn't a journal AND its spend category is RM /
// Packing, or it isn't classified yet (untagged bills are assumed pending-purchase
// and move to Expenses once tagged Freight/Expenses/Machinery). Mirrors the Total
// Purchase card's "Purchase = RM+Packing" vs "Expenses = Freight+more" split.
const EXPENSE_CATS = ['FREIGHT', 'EXPENSES', 'LAB_EXPENSE', 'MACHINERY'];
const isExpenseLike = (r) =>
  isExpenseBill(r) || EXPENSE_CATS.includes((r.purchase_category || '').toUpperCase());

// Payment status read off the balance — the one definition shared by the Status
// column, the status filter, and its dropdown so they can never drift apart.
// Paid = nothing left owing; Partial = some paid, a balance remains; Unpaid =
// the whole amount is still outstanding.
const PAYMENT_STATES = ['Paid', 'Partial', 'Unpaid'];
const paymentStatus = (r) => {
  const total = Number(r.total_amount) || 0;
  const bal = Number(r.balance_due);
  if (Number.isFinite(bal) && bal <= 0 && total > 0) return 'Paid';
  if (Number.isFinite(bal) && bal > 0 && bal < total) return 'Partial';
  return 'Unpaid';
};
const PAYMENT_STATE_CLS = {
  Paid: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Partial: 'bg-amber-50 text-amber-700 border-amber-200',
  Unpaid: 'bg-rose-50 text-rose-700 border-rose-200',
};

// Spend-category chip styling (matches the Purchase by Category page tones).
const CAT_META = {
  RM:          { label: 'RM',          cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  MAIZE:       { label: 'Maize',       cls: 'bg-lime-50 text-lime-700 border-lime-200' },
  BOUGHT_NOTE: { label: 'Bought Note', cls: 'bg-teal-50 text-teal-700 border-teal-200' },
  PACKING:     { label: 'Packing',     cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  FREIGHT:     { label: 'Freight',     cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  EXPENSES:    { label: 'Expenses',    cls: 'bg-violet-50 text-violet-700 border-violet-200' },
  FRUIT: { label: 'Fruit Purchase', cls: 'bg-lime-50 text-lime-700 border-lime-200' },
  LAB_EXPENSE: { label: 'Lab Expense', cls: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200' },
  MACHINERY:   { label: 'Machinery',   cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  BRANCH:      { label: 'Branch',      cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
};

// Direct/Indirect expense bucket chip — same tones the Expense analytics page uses,
// so a bill reads the same here as on the dashboard it was tagged under.
const bucketPill = (b) =>
  b === 'DIRECT'
    ? <span className="inline-flex items-center rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-[10px] font-bold text-teal-700">Direct</span>
    : b === 'INDIRECT'
      ? <span className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-bold text-violet-700">Indirect</span>
      : <span className="text-[11px] text-slate-400">—</span>;

// Labels for the ?age= aging-bucket deep link (from Analytics → Outstanding by
// Age). Keys match the dashboard panel's bucket keys exactly.
const AGE_BUCKET_LABELS = {
  '0_30': '0–30 days',
  '31_60': '31–60 days',
  '61_90': '61–90 days',
  '91_180': '91–180 days',
  '180p': '180+ days',
};

// The TDS column shows what Tally ACTUALLY deducted (tds_deducted). A vendor-level
// check proved Tally's 194Q is correct almost everywhere, so there is NO per-bill
// "missed 194Q" flag: it was ~95% false — the deductions exist, they just aren't
// linked to individual bills, which a per-bill test can't see.
const TDS_FILTERS = [
  { value: 'all', label: 'All TDS' },
  { value: 'DEDUCTED', label: 'TDS deducted' },
  { value: 'NONE', label: 'No TDS deducted' },
];
const fmtTds = (v) => (Number(v) ? `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '');

// Short company tag for the row's company picker. The two companies this ERP
// runs are SS Biochem and United Agro; anything else falls back to its first
// word so a third company still gets a usable chip instead of a blank one.
const shortCompany = (name) =>
  /biochem/i.test(name || '') ? 'SS'
    : /united\s*agro/i.test(name || '') ? 'UAI'
      : ((name || '').split(/[\s,]+/)[0] || '');

// Line quantities arrive as raw decimals (35.1400000000000). Trim the noise
// without rounding a real value away: up to 3 dp, trailing zeros dropped.
const fmtQty = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v == null ? '' : v);
  return n.toLocaleString('en-IN', { maximumFractionDigits: 3 });
};

// Whole-rupee money for the summary band — grouped Indian digits, no paise,
// so the headline figures read clean (₹1,31,42,698) like the ledger summary.
const fmtMoney0 = (v) => `₹${Math.round(Number(v) || 0).toLocaleString('en-IN')}`;

// Colour key for the GST column's place-of-supply shading, shown once by the
// pager instead of a tag on every row. Dots match the GST-cell text colours.
const GST_LEGEND = (
  <div className="flex items-center gap-3 text-[11px] text-slate-500">
    <span className="font-medium text-slate-400">GST</span>
    <span className="inline-flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-amber-500" />IGST</span>
    <span className="inline-flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-sky-500" />CGST+SGST</span>
    <span className="inline-flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-slate-500" />Unknown</span>
  </div>
);

export default function VendorBillList({ expenseOnly = false } = {}) {
  const navigate = useNavigate();
  // ?slim=list -> this table's columns only; drops the fields it never
  // reads (tds_amount, rm_category, purchase_category_display,
  // category_source, updated_at). Keeps created_at for the Entry Date column.
  // A different flag value from ?slim=1, which on this endpoint means the
  // Receipts page's link feed.
  const { canCreate, canEdit, canDelete, canExport } = usePermissions();
  const { isHidden } = useFieldPermissions('Vendor Bill');
  const [searchParams, setSearchParams] = useSearchParams();
  // Clicking a row opens a read-only side card (BillQuickView) as an in-layout
  // page instead of navigating away to the full /purchase/bills/:id page. Driven
  // by the URL (?quick=<id>) so browser Back and a refresh restore the open card
  // (and Back returns to the list). Absent = card closed. The card fetches the
  // bill by id itself, so a refresh with the param set loads it without waiting
  // on the list data. The full page is still a click away (and edits happen there).
  const quickId = searchParams.get('quick');
  const openQuick = (id) => setSearchParams((prev) => { const p = new URLSearchParams(prev); p.set('quick', String(id)); return p; });
  const closeQuick = () => setSearchParams((prev) => { const p = new URLSearchParams(prev); p.delete('quick'); return p; }, { replace: true });
  const [searchTerm, setSearchTerm] = useState('');
  // ── Every filter on this page lives in the ADDRESS, not only in memory ──
  //
  // Opening a bill and coming back used to rebuild this page from scratch:
  // the month you had picked, the company, the vendor and the bill type were
  // all gone and you were looking at an unfiltered list again — so narrowing
  // to (say) United Agro / August / Purchases had to be redone after every
  // single bill you looked at. Each control is seeded from the query string
  // and written back to it below, so Back, a refresh, the table's own pager
  // and a pasted link all reproduce the SAME list. DataTable already keeps
  // its search + page there (persistKey), so the two halves now agree.
  //
  // Branch-transfer filter: all | purchases (no DC) | transfers (only DC).
  // Default to "purchases" so the Bills page opens like Tally's GST-purchase ledger —
  // real purchase bills only, no cancelled duplicates / expenses / transfers / opening.
  // Pick "All bill types" from the dropdown to see everything (incl cancelled).
  //
  // EXCEPT when a category is deep-linked from Analytics / Purchase-by-Category
  // (?purchase_category=EXPENSES / FREIGHT / MACHINERY): the "purchases" view drops
  // expense-like bills, so it would render that category's link as 0 rows. When a
  // category link is present, start on "all" and let the category filter alone
  // decide — so the drill shows exactly that category. Plain opens (no link) still
  // default to "purchases".
  // Expense Bills page (expenseOnly): this list is permanently the Expenses view,
  // so the bill-type is pinned to 'expenses' and its dropdown is hidden. A Bucket
  // picker (All / Direct / Indirect) takes its place, keyed on each row's
  // expense_group — the same Direct/Indirect split the Expense analytics uses.
  const [txFilter, setTxFilter] = useState(() => {
    if (expenseOnly) return 'expenses';
    if (searchParams.get('type')) return searchParams.get('type');
    const cat = (searchParams.get('purchase_category') || '').toUpperCase();
    // Expense/freight categories need 'all' to show (they're excluded from 'purchases').
    // Real purchase categories (RM/Maize/Packing/Fruit/Bought Note) stay on 'purchases'
    // so transfers don't bleed in.
    if (cat && EXPENSE_CATS.includes(cat)) return 'all';
    if (searchParams.has('expense_subcategory')) return 'all';
    return 'purchases';
  });
  // Expense bucket filter (Expense Bills page only): '' = all, DIRECT, INDIRECT.
  // Seeded from ?bucket= so the Direct/Indirect nav redirects and bookmarks land
  // on the right view.
  const [bucketPick, setBucketPick] = useState(
    expenseOnly ? (searchParams.get('bucket') || '').toUpperCase() : '');
  // Expense category filter (Expense Bills page only): the Tally expense
  // sub-category — Machinery, Fuel, Lab, Labour Wages, Rent, … The options are
  // the distinct expense_subcategory values present in the loaded bills (free
  // text from Tally's ledger tree, not a fixed enum), so the list always matches
  // the data. Seeded from ?subcat= for deep links / bookmarks.
  const [subcatPick, setSubcatPick] = useState(
    expenseOnly ? (searchParams.get('subcat') || '') : '');
  // TDS status filter (all | MISMATCH | OK | NONE_DUE | MISSING_DATA) — e.g. pull
  // up every bill whose computed TDS differs from what was deducted.
  const [tdsFilter, setTdsFilter] = useState(searchParams.get('tds') || 'all');
  // Sync state — filter by how the bill lines up across the ERP and Tally, the
  // same read the Source column shows (In sync / Not in Tally / Not in ERP).
  const [syncPick, setSyncPick] = useState(searchParams.get('sync') || '');
  // Source (origin) — where the bill was born: ERP (scanned / emailed) vs Tally
  // (imported voucher), the LEFT badge of the Source column. Pairs with syncPick,
  // which filters the right (sync) badge.
  const [sourcePick, setSourcePick] = useState(searchParams.get('origin') || '');

  // The Freight row on Purchase-by-Category has no standalone "Freight" bills —
  // its value is on-bill INWARD FREIGHT (the other_charges line) riding on
  // RM/Packing invoices. So ?purchase_category=FREIGHT opens a FREIGHT VIEW: list
  // every bill that CARRIES freight and surface the Freight (other_charges)
  // column, instead of matching the (near-empty) FREIGHT category exactly.
  const isFreightView = searchParams.get('purchase_category') === 'FREIGHT';
  // Same idea for Branch Transfer: branch_transfer_q() on the backend (and this
  // row's own is_branch_transfer flag) count THREE things as a transfer — a
  // "DC/"-prefixed invoice no, a vendor flagged is_branch, OR purchase_category
  // literally 'BRANCH' — but only the last of those actually sets
  // purchase_category='BRANCH' on the bill. Matching purchase_category alone
  // (below) silently dropped the other two kinds, so the Branch Transfer card
  // on Purchase-by-Category could open to "no data found" despite real transfer
  // bills existing for the period.
  const isBranchView = searchParams.get('purchase_category') === 'BRANCH';
  // Same period + entity filters as Purchase Analytics, so a figure seen on a
  // tile can be opened here for the SAME window instead of being re-derived by
  // hand through the rule builder. Starts on 'All' — a list must not hide rows
  // before anyone asks it to.
  const period = usePeriodFilter(searchParams.get('period') || 'all', {
    anchor: searchParams.get('anchor'),
    customFrom: searchParams.get('cfrom'),
    customTo: searchParams.get('cto'),
  });

  // Fetch only the period on screen.
  //
  // This page filtered by its period chip in the BROWSER, after downloading
  // every bill: 4,049 sent so it could show the 27 in the current month. The
  // same window now goes to the server, so it sends the 27.
  //
  // Only the date window moved. Search, sorting, the pickers, Approve All and
  // the drill-downs that have to tally with the Analytics cards all still run
  // over the rows in hand, exactly as before - so none of those rules needed
  // rewriting, and none of them can quietly disagree with the card they were
  // opened from.
  //
  // No range (the "All" chip) sends no dates and gets everything, as today.
  // The endpoint string carries the window, so changing period refetches, and
  // useApiData caches each window separately - going back to a month you have
  // already looked at is instant.
  // Product picker — filtered on the SERVER (the slim row carries no line
  // items), so it rides in the endpoint and refetches when it changes.
  const [productPick, setProductPick] = useState(searchParams.get('product') || '');
  // Aging-bucket deep link from the Analytics "Outstanding by Age" panel:
  // ?age=0_30|31_60|61_90|91_180|180p. Filtered on the SERVER (same bill_date
  // windows the dashboard aging buckets use), so it rides in the endpoint and
  // refetches when it changes; pairs with ?st=Unpaid to land on that bucket's
  // unpaid bills.
  const ageParam = searchParams.get('age') || '';
  // ?overdue=1 (from the Purchase Analytics Vendor-details Overdue cell) narrows
  // the list to bills still carrying a balance AND past their due date, matching
  // the Sales invoices list's overdue filter.
  const overdueOnly = searchParams.get('overdue') === '1';
  const clearOverdue = () => { const p = new URLSearchParams(searchParams); p.delete('overdue'); setSearchParams(p, { replace: true }); };
  const billsEndpoint = (() => {
    // ?source=tally|scan from the URL (carried over from the Analytics tile) so
    // the list is scoped to the SAME source the dashboard counted — the backend
    // honours it (VendorBillViewSet) so the count ties the tile.
    const srcParam = (searchParams.get('source') || '').toLowerCase();
    const base = '/api/purchase/bills/?slim=list'
      + (productPick ? `&product=${encodeURIComponent(productPick)}` : '')
      + (ageParam ? `&age=${encodeURIComponent(ageParam)}` : '')
      + (['tally', 'scan'].includes(srcParam) ? `&source=${srcParam}` : '');
    const r = period.range;
    if (!r) return base;
    // effWindow hands back ISO strings (YYYY-MM-DD), not Date objects - and
    // null, not an empty window, for 'all'. Custom can carry empty pickers, so
    // each end is sent only when it has a value.
    const iso = (v) => (typeof v === 'string' ? v.slice(0, 10) : '');
    const from = iso(r.from);
    const to = iso(r.to);
    return base
      + (from ? `&bill_date_from=${from}` : '')
      + (to ? `&bill_date_to=${to}` : '');
  })();
  const { data, isLoading, error, refetch } = useApiData(billsEndpoint);
  const [vendorPick, setVendorPick] = useState(searchParams.get('vend') || '');
  // Category / Warehouse / Status pickers, asked for alongside the vendor one.
  // Each reads from the URL so a filtered view can be shared or reloaded, the
  // same way vendor and company already do.
  // Category is MULTI-select — several spend categories at once. Stored in the
  // URL as a comma-joined list so a filtered view still shares/reloads.
  const [catPick, setCatPick] = useState(() => (searchParams.get('cat') || '').split(',').filter(Boolean));
  const [whPick, setWhPick] = useState(searchParams.get('wh') || '');
  const [statusPick, setStatusPick] = useState(searchParams.get('st') || '');
  const { company: globalCompany } = useGlobalCompany();
  const [companyPick, setCompanyPick] = useState(searchParams.get('company') || globalCompany || '');
  // Follow the global sticky company filter (header chips) when it changes.
  useEffect(() => { setCompanyPick(globalCompany || ''); }, [globalCompany]);
  const [manualBillOpen, setManualBillOpen] = useState(false);
  // Deep-link from Analytics: /purchase/bills?vendor=<name> pre-filters the list.
  // Kept on `vendor` (a free-text search seed) while the row's own dropdown uses
  // `vend` — the two carry different things and must not overwrite each other.
  const vendorParam = searchParams.get('vendor');
  useEffect(() => {
    if (vendorParam) setSearchTerm(vendorParam);
  }, [vendorParam]);

  // Freight-link pick mode: arrived from the Scan freight popup ("Open Bills to
  // pick"). Clicking a bill links the freight to it and returns to Scan Inbox.
  const linkFreightId = searchParams.get('linkFreight');
  const linkFreightNo = searchParams.get('freightNo') || '';
  const linkMode = !!linkFreightId;
  const linkFreightToBill = async (row) => {
    try {
      await apiClient.post(`/api/purchase/scan/bills/${linkFreightId}/link_bill/`, { bill_id: row.id });
      toast.success(`Freight ${linkFreightNo} linked to bill ${row.bill_no}.`);
      navigate('/purchase/scan');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not link the freight.');
    }
  };

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Are you sure you want to delete ${row.bill_no}? This action cannot be undone.`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/bills/${row.id}/`);
      toast.success(`${row.bill_no} deleted successfully`);
      refetch();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to delete');
    }
  };

  // Bulk-approve every DRAFT bill in the CURRENT (client-filtered) view. A draft
  // is invisible to the payment matcher, so its payment shows "—" unlinked;
  // posting the drafts lets those payments attach. We send the visible drafts'
  // ids so the batch matches exactly what the operator sees.
  const handleApproveAll = async () => {
    const ids = (filteredData || []).filter((r) => r.status === 'DRAFT').map((r) => r.id);
    if (!ids.length) { toast('No draft bills in the current view.'); return; }
    if (!(await confirm({ message: `Approve all ${ids.length} draft bill(s) shown here? They move Draft → Open (posted), so payments can link to them.`, confirmLabel: 'Approve All' }))) return;
    try {
      const { data: res } = await apiClient.post('/api/purchase/bills/approve-all/', { ids });
      toast.success(`Approved ${res.approved} bill${res.approved === 1 ? '' : 's'}`);
      refetch();
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.detail || 'Failed to approve bills');
    }
  };

  const columns = [
    {
      key: 'bill_date', label: 'Bill Date', sortable: true,
      // Short 2-digit year ('02-Sep-26') — the century is never in doubt here and
      // the saved width lets the Status/Source columns sit on screen.
      render: (value) => value ? formatDate(value, 'dd-MMM-yy') : '-',
      // Label for the totals row (DataTable renders a <tfoot> when any column
      // defines `footer`). Sums ALL filtered bills (the grand total across pages),
      // so this is the whole-filter total the Analytics card should match.
      footer: (_rows, all) => <span className="text-[11px] font-semibold text-slate-500">Total · {all.length} bills</span>,
    },

    {
      // Just the vendor's own invoice number. The Scan/Tally match state that used
      // to ride here as a badge now lives in its own Source column, so this cell
      // stays clean and the match state can be scanned down a dedicated column.
      key: 'vendor_invoice_no', label: 'Invoice No', sortable: true,
      render: (value, row) => {
        const inv = value || row.bill_no || '-';
        const cat = CAT_META[(row.purchase_category || '').toUpperCase()];
        return (
          <span className="inline-flex items-center gap-1.5">
            <span>{inv}</span>
            {cat && <span className={`text-[10px] leading-none font-medium px-1.5 py-0.5 rounded border ${cat.cls}`}>{cat.label}</span>}
          </span>
        );
      },
    },
    { key: 'vendor_name', label: 'Vendor', sortable: true },

    // Expense Bills page only: show which Tally bucket (Direct / Indirect) each
    // expense booking falls under. Dropped entirely on the normal Bills page.
    ...(expenseOnly ? [{
      key: 'expense_group', label: 'Bucket', sortable: true,
      render: (value) => bucketPill(value),
    }] : []),

    {
      // Destination warehouse — read off the bill's ship-to address in review
      // (Email Inbox), or picked; blank for older/imported bills.
      key: 'warehouse_name', label: 'Warehouse', sortable: true,
      render: (value) => value
        ? <span title={value} className="text-[11px] font-medium text-slate-600 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 whitespace-nowrap">{value}</span>
        : <span className="text-[11px] text-slate-400">—</span>,
    },

    {
      // Entry Date = the day the bill was actually entered into the ERP (Scan
      // confirm / Email approve / import), NOT the invoice's own bill_date.
      key: 'created_at', label: 'Entry Date', sortable: true,
      render: (value) => value ? formatDate(value, 'dd-MMM-yy') : '-',
    },
    {
      // Summed line quantity with its unit. 'mixed units' where a bill's lines
      // use more than one -- adding 3 PCS to 2 MTS is a meaningless number, so
      // the list says so instead of printing one.
      key: 'quantity', label: 'Quantity', sortable: true,
      render: (value, row) => {
        if (row.quantity_uom === 'MIXED') {
          return <span className="text-[11px] text-slate-400" title="This bill's lines use more than one unit, so they cannot be summed">mixed units</span>;
        }
        if (value == null) return <span className="text-[11px] text-slate-400">—</span>;
        return (
          <span className="whitespace-nowrap tabular-nums">
            {fmtQty(value)}
            {row.quantity_uom ? <span className="text-slate-400 ml-1">{row.quantity_uom}</span> : null}
          </span>
        );
      },
    },
    {
      // Effective per-unit rate, EX-GST (subtotal / quantity) -- a purchase rate
      // is quoted before tax. Blank where it cannot be derived honestly: no
      // lines, no quantity, mixed units, or no subtotal.
      key: 'rate', label: 'Rate', sortable: true,
      render: (value) => value != null
        ? <span className="whitespace-nowrap tabular-nums">{formatCurrency(value)}</span>
        : <span className="text-[11px] text-slate-400">—</span>,
    },

    {
      // Taxable value — what's on the bill BEFORE GST (VendorBill.subtotal).
      key: 'subtotal', label: 'Taxable', sortable: true,
      render: (value) => value != null ? formatCurrency(value) : '-',
      footer: (_rows, all) => formatCurrency(all.reduce((s, r) => s + (Number(r.subtotal) || 0), 0)),
    },
    {
      // Booked GST on the bill (VendorBill.tax_amount) — the tax between the
      // taxable base and the gross total. Its own column now, to read
      // Taxable · GST · TDS · Total across like the Ledgerline reference.
      key: 'tax_amount', label: 'GST', sortable: true,
      // Shade the single GST figure by place of supply instead of adding three
      // CGST/SGST/IGST columns, and instead of a per-row tag (which read as
      // clutter down the column): inter-state (IGST) is amber, intra-state
      // (CGST+SGST) is sky, unknown is normal dark. A colour legend by the
      // pager (footerExtra below) names the colours once. Basis comes from the
      // row's gst_basis (derived server-side); hover still shows the words.
      render: (value, row) => {
        if (!(Number(value) > 0)) return <span className="text-[11px] text-slate-400">—</span>;
        const cls = row.gst_basis === 'inter' ? 'text-amber-700'
          : row.gst_basis === 'intra' ? 'text-sky-700'
            : 'text-slate-700';
        const title = row.gst_basis === 'inter' ? 'Inter-state — IGST'
          : row.gst_basis === 'intra' ? 'Intra-state — CGST + SGST'
            : 'Supply type unknown';
        return <span className={`whitespace-nowrap tabular-nums ${cls}`} title={title}>{formatCurrency(value)}</span>;
      },
      footer: (_rows, all) => formatCurrency(all.reduce((s, r) => s + (Number(r.tax_amount) || 0), 0)),
    },
    {
      // TDS actually deducted on the bill (the linked TDS Payable), falling back
      // to the computed figure where nothing is deducted yet.
      key: 'tds_deducted', label: 'TDS', sortable: true,
      render: (value, row) => {
        const deducted = Number(value) || 0;
        if (deducted > 0) {
          return <span title={`TDS deducted in Tally${row.computed_tds_section ? ` · ${row.computed_tds_section}` : ''}`}
            className="text-[11px] font-medium text-slate-700 whitespace-nowrap tabular-nums">{fmtTds(deducted)}</span>;
        }
        const computed = Number(row.computed_tds_amount) || 0;
        if (computed > 0) {
          return <span title={`${row.computed_tds_section || '194Q'} TDS`}
            className="text-[11px] font-medium text-slate-700 whitespace-nowrap tabular-nums">{fmtTds(computed)}</span>;
        }
        return <span className="text-[11px] text-slate-300" title="No TDS deducted">—</span>;
      },
    },
    {
      // Gross bill value, GST included (VendorBill.total_amount).
      key: 'total_amount', label: 'Total', sortable: true,
      render: (value) => value ? formatCurrency(value) : '-',
      footer: (_rows, all) => formatCurrency(all.reduce((s, r) => s + (Number(r.total_amount) || 0), 0)),
    },

    {
      // On-bill inward freight (other_charges). Only shown in the Freight view
      // (?purchase_category=FREIGHT) — see visibleColumns below.
      key: 'other_charges', label: 'Freight', sortable: true,
      render: (value) => Number(value) > 0
        ? <span className="whitespace-nowrap tabular-nums font-medium text-orange-600">{formatCurrency(value)}</span>
        : <span className="text-[11px] text-slate-400">—</span>,
    },

    {
      key: 'balance_due', label: 'Balance', sortable: true,
      render: (value) => {
        const bal = Number(value) || 0;
        return (
          <span className={bal > 0 ? 'text-red-600 font-medium' : 'text-green-600 font-medium'}>
            {'\u20B9'}{bal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </span>
        );
      },
    },

    {
      key: 'status_display', label: 'Status', sortable: false,
      // Payment status, read straight off the balance — not the bill's lifecycle
      // state. Shares paymentStatus() with the filter so the two always agree.
      render: (_value, row) => {
        const label = paymentStatus(row);
        return <span className={`text-[11px] font-medium border rounded px-1.5 py-0.5 whitespace-nowrap ${PAYMENT_STATE_CLS[label]}`}>{label}</span>;
      },
    },

    {
      // Source — where the bill came from (ERP vs Tally) and whether the two
      // sides agree, the way the Ledgerline reference shows it. Same read as the
      // Invoice-No match badge, surfaced as its own column so it can be scanned
      // down the list. `non-catalog` key, so field-permissions leave it alone.
      key: 'source', label: 'Source', sortable: false,
      render: (_v, row) => {
        const { origin, sync } = billSource(row);
        return (
          <div className="flex items-center gap-1 whitespace-nowrap">
            {origin && (
              <span title={origin.title}
                className={`text-[10px] font-medium border rounded px-1 py-0.5 ${origin.cls}`}>{origin.label}</span>
            )}
            {sync && (
              <span title={sync.title}
                className={`text-[10px] font-medium border rounded px-1 py-0.5 ${sync.cls}`}>{sync.label}</span>
            )}
          </div>
        );
      },
    },

    {
      key: 'actions', label: '', sortable: false,
      render: (_, row) => (
        <div className="flex items-center gap-1">
          {canEdit('Vendor Bill') && row.status === 'DRAFT' && (
            <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/bills/${row.id}`); }} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition" title="Edit">
              <Pencil size={15} />
            </button>
          )}
          {canDelete('Vendor Bill') && row.status === 'DRAFT' && (
            <button onClick={(e) => handleDelete(e, row)} className="p-1.5 text-red-500 hover:bg-red-50 rounded transition" title="Delete">
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ),
    },
];

  // Catalog keys for the 'Vendor Bill' header module. A column is hidden
  // when its derived key (raw, or with a trailing _name/_code/_display
  // stripped if that yields a catalog key) is gated. The primary
  // identifier (bill_no), row actions, and any non-catalog key are kept.
  const VENDOR_BILL_FIELD_KEYS = new Set([
    'bill_no', 'vendor', 'purchase_order', 'receipt_advice', 'vendor_invoice_no',
    'bill_date', 'due_date', 'subtotal', 'discount_amount', 'tax_amount',
    'total_amount', 'status', 'notes', 'terms_and_conditions',
  ]);
  const NEVER_HIDE_COLUMNS = new Set(['actions', 'vendor_invoice_no']);
  const visibleColumns = columns.filter((col) => {
    // The Freight (other_charges) column is meaningful only in the Freight view.
    if (col.key === 'other_charges') return isFreightView;
    if (NEVER_HIDE_COLUMNS.has(col.key)) return true;
    let key = col.key;
    if (!VENDOR_BILL_FIELD_KEYS.has(key)) {
      const stripped = key.replace(/_(name|code|display)$/, '');
      if (VENDOR_BILL_FIELD_KEYS.has(stripped)) key = stripped;
    }
    if (!VENDOR_BILL_FIELD_KEYS.has(key)) return true; // non-catalog stays
    return !isHidden(key);
  });

  // Picker values come from the WHOLE table, not the rows on screen.
  //
  // They used to be built from `data`, which worked only while `data` held
  // every bill. Now that the list is bounded to the period being viewed, that
  // would offer the vendors of this month alone - so a vendor with no October
  // bill would simply disappear from the dropdown, and the filter would look
  // broken rather than empty.
  //
  // Distinct values only, no rows, and it does not move with the period, so it
  // is fetched once and reused.
  // Fetched directly, not through useApiData: that hook expects a paginated
  // list and hands back [] for a plain object, which would have left every
  // picker silently empty.
  const [opts, setOpts] = useState({});
  useEffect(() => {
    let alive = true;
    apiClient.get('/api/purchase/bills/filter-options/')
      .then(({ data: d }) => { if (alive) setOpts(d || {}); })
      .catch(() => { /* pickers stay empty; the list itself is unaffected */ });
    return () => { alive = false; };
  }, []);
  const vendorOptions = opts.vendors || [];
  // {id, name} pairs. The ID is what gets filtered and put in the URL —
  // Purchase by Category and Creditors both key on it, so this is the one token
  // that travels between them — and the NAME is only the chip label.
  const companyOptions = (opts.companies || []).map((c) => ({ id: c.value, name: c.label }));
  const warehouseOptions = opts.warehouses || [];
  // {value: product id, label: name} — only products that appear on bills.
  const productOptions = opts.products || [];
  // Expense-category options (Expense Bills page): the distinct expense_subcategory
  // values in the loaded bills, sorted — Machinery, Fuel, Lab, Labour Wages, Rent…
  // Derived from the data (not the filter-options API) so it always matches what's
  // on screen, the same way the Expense analytics sub-category picker is built.
  const subcatOptions = expenseOnly
    ? [...new Set((data || []).map((r) => r.expense_subcategory).filter(Boolean))].sort()
    : [];

  // Sales-side offset (linked vendor-customers) moved OUT of this list: it only
  // applies to a couple of parties yet changed the headline figures for the
  // whole bills view. It now lives in its own Vendor-Customer report.

  // Deep-link from the Purchase by Category page: ?purchase_category=RM (or an
  // empty value for the Unclassified bucket). null = param absent = no filter.
  const catParam = searchParams.has('purchase_category')
    ? (searchParams.get('purchase_category') || '')
    : null;
  // Deep-link from the by-Category Expenses drawer: ?expense_subcategory=<sub>
  // (e.g. "Labour & Wages", "Freight Inward"). null = absent = no filter.
  const subcatParam = searchParams.has('expense_subcategory')
    ? (searchParams.get('expense_subcategory') || '')
    : null;

  // Keep the address in step with the controls. `replace: true` on purpose —
  // picking a filter is not a destination, and one history entry per click
  // would make Back walk you through every pick instead of leaving the page.
  // Only meaningful values are written, so an untouched list keeps a clean URL.
  // The existing params are copied first so DataTable's own `q` / `page` (and
  // the ?vendor= / ?purchase_category= deep links) survive untouched.
  useEffect(() => {
    const p = new URLSearchParams(searchParams);
    const put = (k, v, keep) => { if (keep) p.set(k, v); else p.delete(k); };
    const np = period.navProps;
    put('period', np.period, np.period && np.period !== 'all');
    put('anchor', np.anchor, np.period !== 'all' && np.period !== 'custom');
    put('cfrom', np.customFrom, np.period === 'custom');
    put('cto', np.customTo, np.period === 'custom');
    put('company', companyPick, !!companyPick);
    put('vend', vendorPick, !!vendorPick);
    put('cat', catPick.join(','), catPick.length > 0);
    put('wh', whPick, !!whPick);
    put('st', statusPick, !!statusPick);
    // On the Expense Bills page the type is pinned to 'expenses' (never written),
    // and the Bucket picker owns ?bucket= instead.
    put('type', txFilter, !expenseOnly && txFilter !== 'purchases');
    put('bucket', bucketPick, expenseOnly && !!bucketPick);
    put('subcat', subcatPick, expenseOnly && !!subcatPick);
    put('tds', tdsFilter, tdsFilter !== 'all');
    put('sync', syncPick, !!syncPick);
    put('origin', sourcePick, !!sourcePick);
    put('product', productPick, !!productPick);
    // Nothing here writes `q` or `page`, so the strings can only differ when a
    // filter on this row actually moved — and a narrower list must start at its
    // beginning, or picking August while sitting on page 7 leaves you staring
    // at the end of a two-page result.
    if (p.toString() !== searchParams.toString()) {
      p.delete('page');
      setSearchParams(p, { replace: true });
    }
  }, [period.navProps, companyPick, vendorPick, catPick, whPick, statusPick,
      txFilter, bucketPick, subcatPick, expenseOnly, tdsFilter, syncPick, sourcePick, productPick,
      searchParams, setSearchParams]);

  const filteredData = (() => {
    let result = [...(data || [])];
    // Bill date drives the period, matching what the Analytics tiles count.
    result = result.filter((r) => period.match(r.bill_date));
    if (catParam !== null) {
      // Match the Purchase by Category card exactly: real purchases only —
      // cancelled and opening-balance carriers are excluded there, so drop them
      // here too or the drilled count would run ABOVE the card it opened from.
      result = result.filter((r) =>
        (isFreightView
          // Freight view: every bill CARRYING on-bill freight, plus any real
          // FREIGHT-category bill — mirrors the Freight row's value on the card.
          ? (Number(r.other_charges) > 0 || (r.purchase_category || '') === 'FREIGHT')
          : isBranchView
            // Branch view: the same three-way test the card's total was built
            // from, not just the literal flag — see isBranchView above.
            ? r.is_branch_transfer
            : (r.purchase_category || '') === catParam)
        && r.status !== 'CANCELLED'
        && r.is_active !== false                       // the list keeps soft-deleted bills; the card drops them
        && !(r.tally_guid || '').startsWith('OPENING'));
    }
    if (subcatParam !== null) {
      // Drill from the Expenses Direct/Indirect sub-category rows — same
      // exclusions as the card so the count matches what was clicked.
      result = result.filter((r) =>
        (r.expense_subcategory || '') === subcatParam
        && r.status !== 'CANCELLED'
        && r.is_active !== false
        && !(r.tally_guid || '').startsWith('OPENING'));
    }
    if (companyPick) result = result.filter((r) => String(r.company || '') === companyPick);
    if (vendorPick) result = result.filter((r) => r.vendor_name === vendorPick);
    if (catPick.length) result = result.filter((r) =>
      catPick.includes(r.purchase_category || '')
      || (catPick.includes('BRANCH') && r.is_branch_transfer));
    if (whPick) result = result.filter((r) => String(r.warehouse || '') === whPick);
    if (statusPick) result = result.filter((r) => paymentStatus(r) === statusPick);
    if (overdueOnly) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      result = result.filter((r) => Number(r.balance_due) > 0 && r.due_date && new Date(r.due_date) < today);
    }
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      // Four fields, as asked for: bill date, invoice number, vendor, total.
      //
      // This used to read EVERY value on the row, which meant the search box
      // also matched things nobody searches by - warehouse codes, GST numbers,
      // internal ids, the tally guid - and a short number could land on a row
      // for no visible reason. Category, warehouse and status now have their
      // own pickers beside the vendor one, so they do not need to be in here.
      const hay = (v) => String(v ?? '').toLowerCase();
      result = result.filter((row) =>
        hay(row.bill_date).includes(s)
        || hay(row.vendor_invoice_no).includes(s)
        || hay(row.bill_no).includes(s)
        || hay(row.vendor_name).includes(s)
        || hay(row.total_amount).includes(s)
      );
    }
    // "Purchases" = the real GST-purchase bills, the way Tally's ledger shows them:
    // drop branch transfers, expense/journal bookings, CANCELLED duplicates, and the
    // opening-balance carrier — so a vendor's Purchases view matches its Tally GST
    // Purchase register to the row (e.g. Shree Kumaran April = 12 bills). Cancelled
    // bills stay visible under "All" for the audit trail.
    if (txFilter === 'purchases') result = result.filter((r) =>
      !r.is_branch_transfer && !isExpenseLike(r)
      && r.status !== 'CANCELLED'
      && String(r.vendor_invoice_no || '').trim().toUpperCase() !== 'OPENING');
    else if (txFilter === 'transfers') result = result.filter((r) => r.is_branch_transfer);
    else if (txFilter === 'expenses') result = result.filter((r) =>
      // An expense bill = flagged is_expense OR booked as a Tally journal. The
      // old expenseOnly test (category_source==='voucher_type') only matched
      // TALLY-imported journals and silently dropped SCANNED expense bills
      // (Oct onwards carry category_source='expense_flag'), so October went
      // missing from the Expense Bills page.
      isExpenseBill(r) && !r.is_branch_transfer);
    // Expense Bills page: narrow the expenses to one Tally bucket (Direct / Indirect).
    if (bucketPick) result = result.filter((r) => (r.expense_group || '') === bucketPick);
    // Expense Bills page: narrow to one expense sub-category (Machinery / Fuel / …).
    if (subcatPick) result = result.filter((r) => (r.expense_subcategory || '') === subcatPick);
    if (tdsFilter === 'DEDUCTED') result = result.filter((r) => (Number(r.tds_deducted) || 0) > 0);
    else if (tdsFilter === 'NONE') result = result.filter((r) => (Number(r.tds_deducted) || 0) === 0);
    // Sync state — matches the Source column's badge (In sync / Not in Tally /
    // Not in ERP). A bill with no sync badge is only ever kept by "Any".
    if (syncPick) result = result.filter((r) => (billSource(r).sync?.label || '') === syncPick);
    // Source (origin) — matches the Source column's LEFT badge (ERP vs Tally).
    if (sourcePick) result = result.filter((r) => (billSource(r).origin?.label || '') === sourcePick);
    // Reverse-chronological — newest first (latest bill on page 1), matching
    // the PO list and VendorBill's own default ordering. It used to sort
    // oldest-first, which buried the current month on the LAST page — with
    // 800+ imported bills that meant paging to 83 to see this week's work.
    // Fall back to bill_no when bill_date ties so the many same-day imported
    // bills keep a clean descending sequence instead of an arbitrary order.
    result = [...result].sort((a, b) => {
      const da = new Date(a.bill_date || 0).getTime();
      const db = new Date(b.bill_date || 0).getTime();
      if (db !== da) return db - da;
      return String(b.bill_no || '').localeCompare(String(a.bill_no || ''));
    });
    return result;
  })();

  // Quantity & Rate are per-line goods figures — empty for expense/journal bills
  // (fuel, rent, services carry no line quantity). When the FILTERED set has no
  // quantities at all (e.g. the "Fuel - Vehicles" expense view), drop both columns
  // instead of showing a wall of "—"; they stay for goods bills that do have them.
  const hasAnyQty = filteredData.some(
    (r) => r.quantity != null || r.rate != null || r.quantity_uom === 'MIXED');
  const tableColumns = hasAnyQty
    ? visibleColumns
    : visibleColumns.filter((c) => c.key !== 'quantity' && c.key !== 'rate');

  // Summary band — one glance at the money behind the list, computed over the
  // SAME filtered rows the table shows, so it moves with every period / company
  // / type filter above. GST is the booked tax (tax_amount), kept separate from
  // the taxable base; Outstanding is the unpaid balance still owed.
  const sumOf = (f) => filteredData.reduce((s, r) => s + (Number(r[f]) || 0), 0);
  const summary = {
    count: filteredData.length,
    taxable: sumOf('subtotal'),
    gst: sumOf('tax_amount'),
    // TDS over the filtered rows — the actually-deducted figure, falling back to
    // the computed one where nothing is deducted yet, so it matches the TDS column.
    tds: filteredData.reduce((s, r) => {
      const deducted = Number(r.tds_deducted) || 0;
      return s + (deducted > 0 ? deducted : (Number(r.computed_tds_amount) || 0));
    }, 0),
    total: sumOf('total_amount'),
    outstanding: sumOf('balance_due'),
  };

  // When a row is opened, show the quick-view as a normal in-layout page (the
  // sidebar stays, no backdrop) with a Back button, instead of an overlay card.
  if (quickId) {
    return (
      <MainLayout>
        <div className="p-2 sm:p-3">
          <BillQuickView
            id={quickId}
            inline
            showBack
            canEdit={canEdit('Vendor Bill')}
            onClose={closeQuick}
            onOpenFull={(id) => navigate(`/purchase/bills/${id}`)}
            onEdit={(id) => navigate(`/purchase/bills/${id}`)}
          />
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      {linkMode && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm">
          <span className="text-indigo-800">🔗 <b>Linking freight {linkFreightNo || ''}</b> — click a bill below to attach the freight to it.</span>
          <button onClick={() => navigate('/purchase/scan')} className="text-indigo-600 font-semibold hover:underline">Cancel</button>
        </div>
      )}
      {isFreightView && (
        <div className="mb-3 rounded-lg border border-orange-200 bg-orange-50 px-4 py-2.5 text-sm text-orange-800">
          🚚 <b>Freight charges</b> — inward freight bundled on purchase (RM&nbsp;/&nbsp;Packing) invoices. The goods value stays in its own category; the transport is listed here. The <b>Freight</b> column is each bill&apos;s freight amount.
        </div>
      )}
      <PageHeader
        compact
        title={expenseOnly ? 'Expense Bills' : 'Vendor Bills'}
        subtitle={expenseOnly
          ? 'Direct & indirect expense bookings (journals / GST journals)'
          : 'Manage vendor invoices and bills'}
        breadcrumbs={[{ label: 'Purchase', href: '/purchase/dashboard' }, { label: expenseOnly ? 'Expense Bills' : 'Bills' }]}
        actions={expenseOnly ? {
          right: (
            <div className="flex items-center gap-1.5">
              {/* Company quick-switch chips — same pattern as Purchase Analytics.
                  Drive the existing companyPick filter; click the active one to
                  clear. The company dropdown below still works too. */}
              {companyOptions.map((c) => {
                const active = String(companyPick || '') === String(c.id);
                const chip = /biochem/i.test(c.name) ? 'SS Biochem'
                  : /united\s*agro/i.test(c.name) ? 'United Agro' : c.name;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCompanyPick(active ? '' : String(c.id))}
                    title={c.name}
                    className={`px-2 py-1.5 rounded-lg text-xs font-semibold border transition whitespace-nowrap ${active
                      ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                      : 'bg-white text-slate-700 border-slate-200 hover:border-indigo-300 hover:text-indigo-600'}`}
                  >
                    {chip}
                  </button>
                );
              })}
              <Button
                variant="outline"
                icon={BarChart3}
                responsiveLabel
                onClick={() => navigate('/expenses/analytics')}
                aria-label="Analytics"
                title="Expense Analytics"
              >
                Analytics
              </Button>
            </div>
          ),
        } : {}}
      />
      {catParam !== null && (
        <div className="flex items-center gap-2 mb-3 text-sm">
          <span className="text-slate-500">Category:</span>
          <span className={`text-[11px] font-medium border rounded px-1.5 py-0.5 ${CAT_META[catParam]?.cls || 'bg-slate-50 text-slate-600 border-slate-200'}`}>
            {CAT_META[catParam]?.label || 'Unclassified'}
          </span>
          <button onClick={() => navigate('/purchase/bills')} className="text-xs text-indigo-600 hover:underline">clear ✕</button>
        </div>
      )}
      {subcatParam !== null && (
        <div className="flex items-center gap-2 mb-3 text-sm">
          <span className="text-slate-500">Expense:</span>
          <span className="text-[11px] font-medium border rounded px-1.5 py-0.5 bg-violet-50 text-violet-700 border-violet-200">
            {subcatParam || 'Untagged'}
          </span>
          <button onClick={() => navigate('/purchase/bills')} className="text-xs text-indigo-600 hover:underline">clear ✕</button>
        </div>
      )}
      {ageParam && AGE_BUCKET_LABELS[ageParam] && (
        <div className="flex items-center gap-2 mb-3 text-sm">
          <span className="text-slate-500">Age:</span>
          <span className="text-[11px] font-medium border rounded px-1.5 py-0.5 bg-orange-50 text-orange-700 border-orange-200">
            {AGE_BUCKET_LABELS[ageParam]}
          </span>
          <button
            onClick={() => { const p = new URLSearchParams(searchParams); p.delete('age'); setSearchParams(p, { replace: true }); }}
            className="text-xs text-indigo-600 hover:underline">clear ✕</button>
        </div>
      )}
      {overdueOnly && (
        <div className="flex items-center gap-2 mb-3 text-sm">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium border rounded px-1.5 py-0.5 bg-red-50 text-red-700 border-red-200">
            Overdue only
            <button onClick={clearOverdue} title="Clear overdue filter" aria-label="Clear overdue filter"
              className="hover:text-red-900">✕</button>
          </span>
        </div>
      )}
      {/* One filter row: when -> who -> what kind. The bill-type segments used
          to sit on a second row of their own, which read as a separate control
          when they narrow the very same list — and at py-1.5 they did not share
          a baseline with anything beside them. Everything here is one height
          now and wraps together on a narrow screen. */}
      <div className={`${CTRL_ROW} mb-3`}>
        <PeriodNavigator allowAll {...period.navProps} />
        {/* Company — SS / UAI. A bill carries no company of its own; it belongs
            to the one its VENDOR is registered under, which is what the row's
            company_name is. A dropdown, matching the vendor picker beside it,
            and carrying the SAME short tags the Company column shows so the
            filter and the column read as one thing. The VALUE is the company
            id, which is the token Purchase by Category and Creditors also key
            on — the label is only what you read. */}
        {companyOptions.length > 0 && (
          <CustomSelect value={companyPick} onChange={(e) => setCompanyPick(e.target.value)}
            title="Company — a bill belongs to the company its vendor is registered under"
            className={`${CTRL_FIELD} max-w-[230px]`}>
            <option value="">All Companies</option>
            {companyOptions.map((c) => (
              <option key={c.id} value={c.id}>{shortCompany(c.name)}</option>
            ))}
          </CustomSelect>
        )}
        <CustomSelect value={vendorPick} onChange={(e) => setVendorPick(e.target.value)} title="Vendor"
          className={`${CTRL_FIELD} max-w-[230px]`}>
          <option value="">All Vendors</option>
          {vendorOptions.map((v) => <option key={v} value={v}>{v}</option>)}
        </CustomSelect>
        {expenseOnly ? (
          /* Expense Bills: Direct vs Indirect takes the spend-category slot (the
             goods categories below never apply to expense journals), and a Category
             picker for the Tally expense sub-head (Machinery / Fuel / Lab / …). */
          <>
            <CustomSelect value={bucketPick} onChange={(e) => setBucketPick(e.target.value)} title="Expense bucket"
              className={`${CTRL_FIELD} max-w-[160px]`}>
              <option value="">All expenses</option>
              <option value="DIRECT">Direct</option>
              <option value="INDIRECT">Indirect</option>
            </CustomSelect>
            <CustomSelect value={subcatPick} onChange={(e) => setSubcatPick(e.target.value)} title="Expense category"
              disabled={subcatOptions.length === 0}
              className={`${CTRL_FIELD} max-w-[200px]`}>
              <option value="">All Categories</option>
              {subcatOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </CustomSelect>
          </>
        ) : (
          /* Multi-select: pick several goods spend categories at once (freight,
             expenses, branch are their own heads, picked elsewhere). Bought Note
             and Fruit Purchase are real purchase_category values — see CAT_META. */
          <MultiSelect value={catPick} onChange={setCatPick} title="Spend category"
            placeholder="All Categories" className="max-w-[190px] w-[190px]"
            options={[
              { value: 'RM', label: 'Raw Material' },
              { value: 'PACKING', label: 'Packing' },
              { value: 'MAIZE', label: 'Maize' },
              { value: 'BOUGHT_NOTE', label: 'Bought Note' },
              { value: 'FRUIT', label: 'Fruit Purchase' },
            ]} />
        )}
        <CustomSelect value={whPick} onChange={(e) => setWhPick(e.target.value)} title="Warehouse"
          className={`${CTRL_FIELD} max-w-[190px]`}>
          <option value="">All Warehouses</option>
          {warehouseOptions.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
        </CustomSelect>
        {/* Product — bills carrying a line for this product. Server-side filter. */}
        <CustomSelect value={productPick} onChange={(e) => setProductPick(e.target.value)} title="Product"
          className={`${CTRL_FIELD} max-w-[230px]`}>
          <option value="">All Products</option>
          {productOptions.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </CustomSelect>
        <CustomSelect value={statusPick} onChange={(e) => setStatusPick(e.target.value)} title="Payment status"
          className={`${CTRL_FIELD} max-w-[160px]`}>
          <option value="">All Status</option>
          {PAYMENT_STATES.map((st) => <option key={st} value={st}>{st}</option>)}
        </CustomSelect>
        {/* TDS deducted in Tally — filter by whether a bill carries a deduction. */}
        <CustomSelect value={tdsFilter} onChange={(e) => setTdsFilter(e.target.value)}
          title="Filter by TDS: bills with TDS deducted in Tally, or none"
          className={`${CTRL_FIELD} max-w-[170px]`}>
          {TDS_FILTERS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
        </CustomSelect>
        {/* Sync state — pairs with the Source column: show only bills in a given
            state across the ERP and Tally. */}
        <CustomSelect value={syncPick} onChange={(e) => setSyncPick(e.target.value)}
          title="Filter by how the bill lines up across the ERP and Tally"
          className={`${CTRL_FIELD} max-w-[170px]`}>
          <option value="">Any sync state</option>
          <option value="In sync">In sync</option>
          <option value="Not in Tally">Not in Tally</option>
          <option value="Not in ERP">Not in ERP</option>
        </CustomSelect>
        {/* Source — the LEFT badge of the Source column: where the bill was born
            (ERP = scanned / emailed, Tally = imported voucher). */}
        <CustomSelect value={sourcePick} onChange={(e) => setSourcePick(e.target.value)}
          title="Filter by source: entered in the ERP vs imported from Tally"
          className={`${CTRL_FIELD} max-w-[150px]`}>
          <option value="">All sources</option>
          <option value="ERP">ERP</option>
          <option value="Tally">Tally</option>
        </CustomSelect>
        {/* Clear now resets the bill type too — once it sits on this row,
            leaving it behind would look like the filter had not cleared. */}
        {(period.range || vendorPick || companyPick || catPick.length || whPick || statusPick
          || bucketPick || subcatPick || (!expenseOnly && txFilter !== 'purchases')
          || tdsFilter !== 'all' || syncPick || sourcePick || productPick) && (
          <>
            <span className="text-xs text-slate-500 tabular-nums">
              {filteredData.length.toLocaleString('en-IN')} of {(data || []).length.toLocaleString('en-IN')} bills
            </span>
            <button type="button"
              onClick={() => { period.navProps.setPeriod('all'); setVendorPick(''); setCompanyPick(''); setCatPick([]); setWhPick(''); setStatusPick(''); setBucketPick(''); setSubcatPick(''); if (!expenseOnly) setTxFilter('purchases'); setTdsFilter('all'); setSyncPick(''); setSourcePick(''); setProductPick(''); }}
              className="text-xs text-slate-500 hover:text-slate-800 underline">Clear</button>
          </>
        )}
      </div>
      {/* Summary band — Vouchers · Taxable · GST · Total · Outstanding, over the
          filtered rows. Hairline-divided cells (metric-band) that pack onto one
          strip and reflow two-up on phones, so the headline money is always in
          view above the ledger without a row of padded cards. */}
      {!expenseOnly && (
      <div className="metric-band mb-3">
        <div className="px-3 py-2">
          <p className="text-[11px] text-slate-500">Vouchers</p>
          <p className="text-sm font-bold text-slate-900 tabular-nums">{summary.count.toLocaleString('en-IN')}</p>
        </div>
        <div className="px-3 py-2">
          <p className="text-[11px] text-slate-500">Taxable value</p>
          <p className="text-sm font-bold text-slate-900 money">{fmtMoney0(summary.taxable)}</p>
        </div>
        <div className="px-3 py-2">
          <p className="text-[11px] text-slate-500">GST</p>
          <p className="text-sm font-bold text-slate-900 money">{fmtMoney0(summary.gst)}</p>
        </div>
        <div className="px-3 py-2">
          <p className="text-[11px] text-slate-500">TDS</p>
          <p className="text-sm font-bold text-slate-900 money">{fmtMoney0(summary.tds)}</p>
        </div>
        <div className="px-3 py-2">
          <p className="text-[11px] text-slate-500">Total value</p>
          <p className="text-sm font-bold text-slate-900 money">{fmtMoney0(summary.total)}</p>
        </div>
        <div className="px-3 py-2">
          <p className="text-[11px] text-slate-500">Outstanding</p>
          <p className={`text-sm font-bold money ${summary.outstanding > 0 ? 'text-rose-600' : 'text-slate-900'}`}>{fmtMoney0(summary.outstanding)}</p>
        </div>
      </div>
      )}
      <ListState error={error} onRetry={refetch}>
      <MobileListCards
        rows={filteredData}
        isLoading={isLoading}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search bill no, vendor, ref…"
        emptyMessage="No bills found"
        config={{
          title: (row) => row.bill_no || row.invoice_no,
          subtitle: (row) => row.vendor_name,
          badge: (row) => {
            const s = (row.status === 'PAID' || row.status === 'PARTIALLY_PAID') ? 'OPEN' : (row.status_display || row.status);
            const map = {
              OPEN:   { label: 'Open',  cls: 'bg-red-100 text-red-700 border-red-300' },
              UNPAID: { label: 'Unpaid', cls: 'bg-red-100 text-red-700 border-red-300' },
              DRAFT:  { label: 'Draft',  cls: 'bg-slate-100 text-slate-700 border-slate-200' },
            };
            return map[s] || { label: s || '-', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
          },
          fields: (row) => [
            { label: 'Company', value: row.company_name ? shortCompany(row.company_name) : null },
            { label: 'Date',    value: formatDate(row.bill_date) },
            { label: 'Due',     value: formatDate(row.due_date) },
            { label: 'Total',   value: row.total_amount ? formatCurrency(row.total_amount) : null, cls: 'font-medium' },
            { label: 'Balance', value: row.balance_due != null ? formatCurrency(row.balance_due) : null, cls: Number(row.balance_due) > 0 ? 'text-red-600 font-medium' : 'text-emerald-700 font-medium' },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/purchase/bills/${row.id}`) },
          ],
        }}
      />
      <div className="hidden sm:block">
        <DataTable dense persistKey="purchase-bills" exportFileName="vendor-bills" canExport={canExport('Vendor Bill')} columns={tableColumns} data={filteredData} isLoading={isLoading} pageSize={15} footerExtra={GST_LEGEND} onRowClick={(row) => (linkMode ? linkFreightToBill(row) : openQuick(row.id))} />
      </div>
      </ListState>
      <ManualBillModal isOpen={manualBillOpen} onClose={() => setManualBillOpen(false)} />
    </MainLayout>
  );
}
