import { confirm } from '@/components/common/confirm';
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronDown, Plus, Eye, Pencil, Trash2, Settings2, GitBranch, RefreshCw, FileDown, X } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import { Button } from '../../../components/ui';
import CustomDatePicker from '../../../components/ui/CustomDatePicker';
import DataTable from '../../../components/common/DataTable';
import { applyAdvancedFilters, matchesSelect } from '../../../components/common/FilterPanel';
import { useConfigureFields } from '../../../components/common/ConfigureFields';
import useApiData from '../../../hooks/useApiData.js';
import TallyImportButton from '../../../components/common/TallyImportButton';
import SyncStatusBar from '../../../components/common/SyncStatusBar';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import apiClient from '../../../utils/api.js';
import { exportServerSide } from '../../../utils/exportExcel.js';
import { useFlowDashboard } from '../../../components/common/FlowDashboardPopup';
import { INVOICE_EXPORT_LINES } from '../../../components/common/ExpandableLines';
import ListAttachments, { useListAttachments } from '../components/ListAttachments';
import MobileListCards from '../components/MobileListCards';
import InvoiceQuickView from './InvoiceQuickView.jsx';
import ListState from '@/components/common/ListState.jsx';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import { CTRL_H, CTRL_FIELD, CTRL_GHOST, CTRL_ROW } from '@/components/common/controls';
import CustomSelect from '@/components/ui/CustomSelect';

// FilterPanel stores a multi-select as an array; the inline single pickers can
// only honestly represent one value, so a multi-selection reads as blank ("All")
// rather than silently claiming to be whichever entry happened to be first.
const pickOf = (v) => (Array.isArray(v) ? (v.length === 1 ? v[0] : '') : (v || ''));

// Payment status read off the receivable balance — the one definition shared by
// the Payment column, the status filter and the quick-view card, so they can
// never drift apart. Paid = nothing left owing; Partial = some received, a
// balance remains; Unpaid = the whole amount is still outstanding. Mirrors the
// Purchase Bills list's paymentStatus().
const PAYMENT_STATES = ['Paid', 'Partial', 'Unpaid'];
const paymentStatus = (r) => {
  const total = Number(r.grand_total) || 0;
  const bal = Number(r.outstanding);
  if (Number.isFinite(bal) && bal <= 0 && total > 0) return 'Paid';
  if (Number.isFinite(bal) && bal > 0 && bal < total) return 'Partial';
  return 'Unpaid';
};
const PAYMENT_STATE_CLS = {
  Paid: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Partial: 'bg-amber-50 text-amber-700 border-amber-200',
  Unpaid: 'bg-rose-50 text-rose-700 border-rose-200',
};

// How many days an invoice is past its due date — 0 when settled, undated or
// not yet due. `due_date` is the receivable due date (credit-terms/manual), the
// same one the dashboard ages by, so this matches the Overdue column there.
const daysOverdue = (r) => {
  if (!(Number(r.outstanding) > 0) || !r.due_date) return 0;
  const d = Math.floor((Date.now() - new Date(`${r.due_date}T00:00:00`).getTime()) / 86400000);
  return d > 0 ? d : 0;
};

// Outstanding age-band deep link from the Sales Analytics "Outstanding by Age"
// drawer: /sales/invoices?age=d31_60&company=…  The band's member invoices come
// from the same receivables_ageing endpoint the drawer reads, so the list shows
// exactly the invoices the drawer counted.
const AGE_BAND_LABELS = {
  d1_30: 'Up to 30 days',
  d31_60: '31–60 days',
  d61_90: '61–90 days',
  d91_180: '91–180 days',
  d180_plus: '180+ days',
};

export default function SalesInvoiceList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete, canView, canExport } = usePermissions();
  const { isHidden } = useFieldPermissions('Sales Invoice');
  // Flow icon — reuses Sales Flow Dashboard view permission.
  const canSeeFlow = canView('Sales Flow Dashboard');
  const [sp, setSp] = useSearchParams();
  // Clicking a row opens a read-only side card (InvoiceQuickView) as an in-layout
  // page instead of navigating to the full /sales/invoices/:id page — the same
  // pattern the Bills list uses. Driven by the URL (?quick=<id>) so browser Back
  // and a refresh restore the open card (and Back returns to the list). Absent =
  // card closed. The card fetches the invoice by id itself, so a refresh with the
  // param set loads it without waiting on the list data.
  const quickId = sp.get('quick');
  const openQuick = (id) => setSp((prev) => { const p = new URLSearchParams(prev); p.set('quick', String(id)); return p; });
  const closeQuick = () => setSp((prev) => { const p = new URLSearchParams(prev); p.delete('quick'); return p; }, { replace: true });
  const { data, isLoading, error, refetch } = useApiData('/api/sales/invoices/');
  // Bump so the "Last synced" strip re-fetches after an import/revert.
  const [syncTick, setSyncTick] = useState(0);
  const afterSync = () => { refetch(); setSyncTick((t) => t + 1); };
  // Page lives in the URL, so opening a record and pressing Back returns
  // to the page you were on (52), not page 1.
  const [page, setPage] = useState(() => Math.max(1, parseInt(sp.get('page'), 10) || 1));
  const [sortBy, setSortBy] = useState(sp.get('sort') || 'invoice_date');
  const [sortOrder, setSortOrder] = useState(sp.get('dir') || 'desc');  // newest first
  const [searchTerm, setSearchTerm] = useState(sp.get('q') || '');
  const [activeFilters, setActiveFilters] = useState(() => {
    const f = {};
    if (sp.get('company')) f.company_name = sp.get('company');
    if (sp.get('customer')) f.customer_name = sp.get('customer');
    if (sp.get('status')) f.status = sp.get('status');
    if (sp.get('payment')) f.payment = sp.get('payment');
    return f;
  });
  const [fieldsOpen, setFieldsOpen] = useState(false);   // Fields dropdown
  const [advRules, setAdvRules] = useState([]);
  const [advLogic, setAdvLogic] = useState('AND');
  // Same period control as Sales Analytics. Invoice date was only reachable
  // through the advanced rule builder before, which meant "show me August" took
  // four clicks and a typed date; month / FY / custom are now one pick.
  // The list's filters live in the address, not only in memory. Opening an
  // invoice and pressing Back used to rebuild this page from scratch, so FY
  // 2026-27 and the customer you had picked were gone and you were looking at
  // "All" again. Reading them from the URL makes Back, refresh and a shared
  // link all reproduce the same list.
  const period = usePeriodFilter(sp.get('period') || 'all', {
    anchor: sp.get('anchor'),
    customFrom: sp.get('cfrom'),
    customTo: sp.get('cto'),
  });
  // Outstanding age-band deep link. Only a known band key arms the filter; an
  // absent/unknown `age` leaves the page exactly as it was. The scope params
  // (company/customer/warehouse/product/from/to) match the drawer's own call so
  // the set of invoices lines up with what the drawer showed.
  const ageBand = sp.get('age');
  const ageBandActive = !!AGE_BAND_LABELS[ageBand];
  // "Overdue only" deep link from the dashboard's Overdue column (item 18):
  // keep only invoices actually past their due date.
  const overdueOnly = sp.get('overdue') === '1';
  const clearOverdue = () => { const p = new URLSearchParams(sp); p.delete('overdue'); setSp(p, { replace: true }); };
  const [ageIds, setAgeIds] = useState(null);   // Set<string> | null (not yet loaded / inactive)
  const [ageLoading, setAgeLoading] = useState(false);
  useEffect(() => {
    if (!ageBandActive) { setAgeIds(null); return; }
    let cancelled = false;
    setAgeLoading(true);
    const qp = new URLSearchParams({ type: 'receivables_ageing', band: ageBand });
    const company = sp.get('company');
    const customer = sp.get('customer');
    const warehouse = sp.get('warehouse');
    const product = sp.get('product');
    const from = sp.get('from');
    const to = sp.get('to');
    if (company) qp.set('company', company);
    if (customer) qp.set('customer', customer);
    if (warehouse) qp.set('warehouse', warehouse);
    if (product) qp.set('product', product);
    if (from && to) { qp.set('period', 'custom'); qp.set('from', from); qp.set('to', to); }
    apiClient.get(`/api/sales/dashboard/records/?${qp.toString()}`)
      .then((r) => {
        if (cancelled) return;
        const ids = new Set();
        for (const row of (r.data?.rows || [])) {
          // Opening-balance carriers have no invoice_id — skip them.
          if (row.invoice_id != null && row.invoice_id !== '') ids.add(String(row.invoice_id));
        }
        setAgeIds(ids);
      })
      .catch(() => { if (!cancelled) setAgeIds(new Set()); })   // fail safe: empty set, don't crash
      .finally(() => { if (!cancelled) setAgeLoading(false); });
    return () => { cancelled = true; };
    // sp is stable per render of these values; depend on the raw strings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ageBand, ageBandActive, sp.get('company'), sp.get('customer'), sp.get('warehouse'), sp.get('product'), sp.get('from'), sp.get('to')]);

  const clearAgeBand = () => {
    const p = new URLSearchParams(sp);
    p.delete('age');
    setSp(p, { replace: true });
  };

  const [showTally, setShowTally] = useState(false);
  const [tallyType, setTallyType] = useState('sales');
  const [tallyFrom, setTallyFrom] = useState('');
  const [tallyTo, setTallyTo] = useState('');
  const [tallyBusy, setTallyBusy] = useState(false);

  const downloadTally = async () => {
    setTallyBusy(true);
    try {
      const params = new URLSearchParams({ type: tallyType });
      if (tallyFrom) params.append('from', tallyFrom);
      if (tallyTo) params.append('to', tallyTo);
      const res = await apiClient.get(`/api/sales/invoices/tally-export/?${params}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tally-${tallyType}.xml`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      setShowTally(false);
      toast.success('Tally XML downloaded.');
    } catch {
      toast.error('Tally export failed.');
    } finally {
      setTallyBusy(false);
    }
  };
  const { openFlow, FlowPopup } = useFlowDashboard();
  const { attachmentMap } = useListAttachments('SALES_INVOICE');

  const filterColumns = [
    { field: 'invoice_no', header: 'Invoice No', type: 'text' },
    { field: 'invoice_date', header: 'Date', type: 'date' },
    { field: 'company_name', header: 'Company', type: 'text' },
    { field: 'customer_name', header: 'Customer', type: 'text' },
    { field: 'destination', header: 'Destination', type: 'text' },
    { field: 'grand_total', header: 'Grand Total', type: 'number' },
    { field: 'status', header: 'Status', type: 'select', filterOptions: [
      { value: 'DRAFT', label: 'Draft' }, { value: 'CONFIRMED', label: 'Confirmed' },
      { value: 'CANCELLED', label: 'Cancelled' }, { value: 'SENT', label: 'Sent' },
    ]},
  ];

  const handleDelete = async (id, invoiceNo) => {
    if (!(await confirm({ message: `Delete Invoice ${invoiceNo}? This cannot be undone.`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/sales/invoices/${id}/`);
      toast.success(`Invoice ${invoiceNo} deleted`);
      refetch();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to delete');
    }
  };

  const Link = ({ to, children }) => (
    <button onClick={(e) => { e.stopPropagation(); navigate(to); }} className="text-blue-700 hover:text-blue-900 hover:underline font-medium text-xs whitespace-nowrap">{children}</button>
  );
  const fmtDate = (v) => v ? formatDate(v) : '-';
  // 2-digit year, e.g. 02-Nov-26 — the list is dense, the century is implied.
  const fmtDateShort = (v) => {
    if (!v) return '-';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return fmtDate(v);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '-');
  };
  const fmtCurrency = (v) => v != null ? formatCurrency(v) : '-';
  // Rupees, no paise — for the summary tiles where the headline figure reads
  // cleaner whole.
  const fmtMoney0 = (v) => '₹' + Math.round(Number(v) || 0).toLocaleString('en-IN');
  // Short company tag (SS / UAI) in place of the full legal name.
  const companyPill = (name) => {
    if (!name) return '-';
    const n = String(name).toUpperCase();
    if (n.includes('UNITED AGRO')) return 'UAI';
    if (n.includes('BIOCHEM')) return 'SS';
    return String(name).split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
  };

  const columns = [
    { field: 'invoice_no', header: 'Invoice No', sortable: true, width: '140px',
      render: (v, row) => <Link to={`/sales/invoices/${row.id}`}>{v}</Link> },
    { field: 'invoice_date', header: 'Date', sortable: true, width: '100px', render: (v) => fmtDateShort(v) },
    { field: 'company_name', header: 'Company', sortable: true, width: '90px',
      render: (v) => <span title={v || ''} className="inline-block px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[11px] font-semibold border border-slate-200">{companyPill(v)}</span> },
    { field: 'customer_name', header: 'Customer', sortable: true, width: '180px' },
    { field: 'subtotal', header: 'Taxable', sortable: true, width: '110px', render: (v) => fmtCurrency(v) },
    { field: 'cgst_total', header: 'CGST', sortable: true, width: '100px', render: (v) => fmtCurrency(v) },
    { field: 'sgst_total', header: 'SGST', sortable: true, width: '100px', render: (v) => fmtCurrency(v) },
    { field: 'igst_total', header: 'IGST', sortable: true, width: '100px', render: (v) => fmtCurrency(v) },
    { field: 'grand_total', header: 'Grand Total', sortable: true, width: '120px',
      render: (v) => <span className="font-bold">{fmtCurrency(v)}</span> },
    { field: 'outstanding', header: 'Balance', sortable: true, width: '120px',
      render: (v, row) => {
        const bal = Number(v) || 0;
        const od = daysOverdue(row);
        return (
          <span className="inline-flex flex-col items-start leading-tight">
            <span className={bal > 0 ? 'text-rose-600 font-medium' : 'text-emerald-700 font-medium'}>{fmtCurrency(bal)}</span>
            {od > 0 && (
              <span className="text-[10px] text-rose-500" title={`Past due by ${od} day${od > 1 ? 's' : ''} (due ${row.due_date})`}>
                {od} day{od > 1 ? 's' : ''} overdue
              </span>
            )}
          </span>
        );
      } },
    { field: 'payment_status', header: 'Payment', sortable: false, width: '90px',
      render: (_v, row) => {
        const label = paymentStatus(row);
        return <span className={`text-[11px] font-medium border rounded px-1.5 py-0.5 whitespace-nowrap ${PAYMENT_STATE_CLS[label]}`}>{label}</span>;
      } },
  ];

  // Strip columns the user's role HIDES via field permissions. keyFor maps a
  // column's field to its catalog key ('Sales Invoice'): drop a trailing
  // companion suffix (company_name → company) and translate a couple of
  // display-only column names to their catalog FK key. The financial *_total
  // keys are catalog keys themselves, so they're matched directly. Never drop
  // the actions column or the primary identifier link (invoice_no).
  const COLUMN_KEY_ALIASES = { dc_nos: 'dc_reference', so_no: 'so_reference' };
  const keyForColumn = (field) =>
    COLUMN_KEY_ALIASES[field] || (field || '').replace(/_(name|code|display)$/, '');
  const fieldGatedColumns = columns.filter((c) => {
    if (c.field === 'actions' || c.field === 'invoice_no') return true;
    return !isHidden(keyForColumn(c.field));
  });

  // `…_v3`: the column set changed again (Round Off/Items/Status dropped,
  // Balance + Payment added). Bumping the key retires stale saved preferences
  // once, so the default column set is what shows instead of an old customised
  // set that still lists the removed columns. Users can still hide/show columns
  // from the Fields dropdown.
  const { visibleColumns, mergedColumns, handleConfigApply, visibleFieldKeys } = useConfigureFields(fieldGatedColumns, 'sales_invoice_fields_v3', data);

  const customerFilterOptions = [...new Set((data || []).map(i => i.customer_name).filter(Boolean))]
    .sort().map(n => ({ value: n, label: n }));
  const companyFilterOptions = [...new Set((data || []).map(i => i.company_name).filter(Boolean))]
    .sort().map(n => ({ value: n, label: n }));

  const filterOptions = [
    {
      key: 'status',
      label: 'Status',
      options: [
        { value: 'DRAFT', label: 'Draft' },
        { value: 'CONFIRMED', label: 'Confirmed' },
        { value: 'SENT', label: 'Sent' },
        { value: 'CANCELLED', label: 'Cancelled' },
      ],
    },
    { key: 'customer_name', label: 'Customer', type: 'select', options: customerFilterOptions },
    { key: 'company_name',  label: 'Company',  type: 'select', options: companyFilterOptions },
  ];

  // Keep the address in step. `replace: true` on purpose -- picking a filter
  // is not a destination, and each one adding a history entry would make Back
  // walk you through every click instead of leaving the page. Only meaningful
  // values are written, so an untouched list keeps a clean URL.
  // A filter change invalidates the page number (you can't be on page 52 of
  // a three-page result), so reset to 1 — except on the first render, which
  // is where a Back-restored page must be left intact.
  const firstFilterRun = useRef(true);
  const filterSig = JSON.stringify([period.navProps, activeFilters, searchTerm, sortBy, sortOrder]);
  useEffect(() => {
    if (firstFilterRun.current) { firstFilterRun.current = false; return; }
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterSig]);

  useEffect(() => {
    const p = new URLSearchParams(sp);
    const put = (k, v, keep) => { if (keep) p.set(k, v); else p.delete(k); };
    const np = period.navProps;
    put('period', np.period, np.period && np.period !== 'all');
    put('anchor', np.anchor, np.period !== 'all' && np.period !== 'custom');
    put('cfrom', np.customFrom, np.period === 'custom');
    put('cto', np.customTo, np.period === 'custom');
    put('company', pickOf(activeFilters.company_name), !!pickOf(activeFilters.company_name));
    put('customer', pickOf(activeFilters.customer_name), !!pickOf(activeFilters.customer_name));
    put('status', pickOf(activeFilters.status), !!pickOf(activeFilters.status));
    put('payment', pickOf(activeFilters.payment), !!pickOf(activeFilters.payment));
    put('q', searchTerm, !!searchTerm.trim());
    put('sort', sortBy, sortBy !== 'invoice_date');
    // Must track the default above: `put` omits a param when the third
    // argument is false, so comparing against the wrong default would
    // write ?dir=desc into every URL and drop ?dir=asc when chosen.
    put('dir', sortOrder, sortOrder !== 'desc');
    put('page', String(page), page > 1);
    const next = p.toString();
    if (next !== sp.toString()) setSp(p, { replace: true });
  }, [period.navProps, activeFilters, searchTerm, sortBy, sortOrder, page, sp, setSp]);

  const filteredData = (() => {
    let result = (data || []).filter((item) => {
      const term = searchTerm.toLowerCase();
      const productNames = (item.product_names || []).join(' ').toLowerCase();
      const matchesSearch = !term || [
        item.invoice_no, item.invoice_date, item.customer_name, item.company_name,
        item.dc_no, item.destination, item.grand_total, item.status,
      ].some(v => v != null && String(v).toLowerCase().includes(term)) || productNames.includes(term);
      const matchesStatus = matchesSelect(item.status, activeFilters.status);
      const matchesPayment = !activeFilters.payment || paymentStatus(item) === activeFilters.payment;
      const matchesCustomer = matchesSelect(item.customer_name, activeFilters.customer_name);
      const matchesCompany = matchesSelect(item.company_name, activeFilters.company_name);
      // Outstanding age-band deep link: keep only invoices the drawer counted
      // in this band (matched by id). While the band set is still loading,
      // ageIds is null and nothing is narrowed yet.
      const matchesAgeBand = !ageBandActive || !ageIds || ageIds.has(String(item.id));
      const matchesOverdue = !overdueOnly || daysOverdue(item) > 0;
      return matchesSearch && matchesStatus && matchesPayment && matchesCustomer && matchesCompany && matchesAgeBand
        && matchesOverdue && period.match(item.invoice_date);
    });
    if (advRules.length > 0) result = applyAdvancedFilters(result, advRules, advLogic);

    // Apply the sort the header arrow has been claiming. Numeric values
    // (amounts) compare as numbers; everything else compares as text with
    // numeric collation, which also orders the ISO dates correctly because
    // YYYY-MM-DD sorts chronologically as a string. Blanks go last in both
    // directions, so an empty cell never displaces a real one at the top.
    if (sortBy) {
      const dir = sortOrder === 'desc' ? -1 : 1;
      const blank = (v) => v === null || v === undefined || v === '';
      result = [...result].sort((a, b) => {
        const av = a[sortBy], bv = b[sortBy];
        if (blank(av) && blank(bv)) return 0;
        if (blank(av)) return 1;
        if (blank(bv)) return -1;
        const an = Number(av), bn = Number(bv);
        if (!Number.isNaN(an) && !Number.isNaN(bn)) return (an - bn) * dir;
        return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
      });
    }
    return result;
  })();

  // (Summary band removed on user request — no per-page totals computed here.)

  // When a row is opened, show the quick-view as a normal in-layout page (the
  // sidebar stays, no backdrop) with a Back button, instead of an overlay card.
  if (quickId) {
    return (
      <MainLayout>
        <div className="p-2 sm:p-3">
          <InvoiceQuickView
            id={quickId}
            inline
            showBack
            canEdit={canEdit('Sales Invoice')}
            onClose={closeQuick}
            onOpenFull={(id) => navigate(`/sales/invoices/${id}`)}
            onEdit={(id) => navigate(`/sales/invoices/${id}/edit`)}
          />
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="space-y-3 sm:space-y-4">
        <PageHeader
          compact
          title="Sales Invoices"
          subtitle="Manage GST sales invoices"
          breadcrumbs={[{ label: 'Invoices' }]}
        />
        {/* Period + customer bar, matching Sales Analytics. The customer select
            is bound to the SAME activeFilters state the Filters panel writes, so
            the quick pick and the panel can never disagree. A multi-value
            selection made in the panel shows blank here rather than lying
            about which one is active. */}
        <div className={CTRL_ROW}>
          <PeriodNavigator allowAll {...period.navProps} />
          {/* Which company's documents. The filter itself already existed --
              it was only reachable through the Filters panel that used to sit
              in the header, so removing that panel left it working but with
              nothing to drive it. This writes the same
              activeFilters.company_name the panel wrote. */}
          <CustomSelect value={pickOf(activeFilters.company_name)} title="Company"
            onChange={(e) => setActiveFilters((p) => ({ ...p, company_name: e.target.value }))}
            className={`${CTRL_FIELD} max-w-[230px]`}>
            <option value="">All Companies</option>
            {companyFilterOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </CustomSelect>
          <CustomSelect value={pickOf(activeFilters.customer_name)} title="Customer"
            onChange={(e) => setActiveFilters((p) => ({ ...p, customer_name: e.target.value }))}
            className={`${CTRL_FIELD} max-w-[230px]`}>
            <option value="">All Customers</option>
            {customerFilterOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </CustomSelect>
          <CustomSelect value={pickOf(activeFilters.status)} title="Status"
            onChange={(e) => setActiveFilters((p) => ({ ...p, status: e.target.value }))}
            className={`${CTRL_FIELD} max-w-[160px]`}>
            <option value="">All Status</option>
            <option value="DRAFT">Draft</option>
            <option value="CONFIRMED">Confirmed</option>
            <option value="SENT">Sent</option>
            <option value="CANCELLED">Cancelled</option>
          </CustomSelect>
          <CustomSelect value={pickOf(activeFilters.payment)} title="Payment status"
            onChange={(e) => setActiveFilters((p) => ({ ...p, payment: e.target.value }))}
            className={`${CTRL_FIELD} max-w-[150px]`}>
            <option value="">All Payments</option>
            {PAYMENT_STATES.map((st) => <option key={st} value={st}>{st}</option>)}
          </CustomSelect>
          {/* Filters and Fields sit HERE, beside the period and customer
              pickers they belong with, rather than up in the header among the
              Tally / New Invoice actions -- those act on the page, these
              narrow the list. Same handlers and same state as before; only
              their position and size changed, sized to this row instead of the
              taller header buttons. */}
          {/* Fields as a dropdown: the columns are a short list of on/off
              choices, so a panel that has to be opened, changed and applied was
              more ceremony than the choice deserves. Ticking a box applies it
              immediately through the same handleConfigApply the old dialog
              called, so the stored preference behaves exactly as before.
              The Filters button that sat here is gone -- the period and
              customer pickers beside this cover what it was used for. */}
          {ageBandActive && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">
              Age: {AGE_BAND_LABELS[ageBand]}
              {!ageLoading && ageIds && <span className="tabular-nums text-amber-600">({filteredData.length})</span>}
              <button type="button" onClick={clearAgeBand}
                title="Clear age filter" aria-label="Clear age filter"
                className="-my-1 -mr-1.5 p-1.5 rounded-full text-amber-500 hover:text-amber-800 hover:bg-amber-100">
                <X size={13} />
              </button>
            </span>
          )}

          {overdueOnly && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-800">
              Overdue only
              <span className="tabular-nums text-rose-600">({filteredData.length})</span>
              <button type="button" onClick={clearOverdue}
                title="Clear overdue filter" aria-label="Clear overdue filter"
                className="-my-1 -mr-1.5 p-1.5 rounded-full text-rose-500 hover:text-rose-800 hover:bg-rose-100">
                <X size={13} />
              </button>
            </span>
          )}

          <div className="relative">
            <button type="button" onClick={() => setFieldsOpen(o => !o)}
              title="Choose columns" aria-label="Choose columns"
              aria-haspopup="true" aria-expanded={fieldsOpen}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition ${CTRL_H} ${fieldsOpen ? 'bg-primary-50 text-primary-700 border-primary-300' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}>
              <Settings2 size={15} /> Fields
              <ChevronDown size={13} className={`transition-transform ${fieldsOpen ? 'rotate-180' : ''}`} />
            </button>
            {fieldsOpen && (
              <>
                {/* Click anywhere else to close. Sits behind the menu, so it
                    catches the outside click without swallowing the ticks. */}
                <div className="fixed inset-0 z-20" onClick={() => setFieldsOpen(false)} />
                <div className="absolute right-0 z-30 mt-1 w-60 max-w-[calc(100vw-1.5rem)] max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg py-1">
                  {mergedColumns.map((c) => {
                    const on = visibleFieldKeys.includes(c.field);
                    return (
                      <label key={c.field}
                        className="flex items-center gap-2 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 cursor-pointer">
                        <input type="checkbox" checked={on} className="accent-primary-600"
                          onChange={() => handleConfigApply(
                            on ? visibleFieldKeys.filter((k) => k !== c.field)
                               : [...visibleFieldKeys, c.field])} />
                        <span className="truncate">{c.header || c.field}</span>
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {(period.range || pickOf(activeFilters.company_name) || pickOf(activeFilters.customer_name) || pickOf(activeFilters.status) || pickOf(activeFilters.payment)) && (
            <>
              <span className="text-xs text-slate-500 tabular-nums">
                {filteredData.length.toLocaleString('en-IN')} of {(data || []).length.toLocaleString('en-IN')} invoices
              </span>
              <button type="button" className="text-xs text-slate-500 hover:text-slate-800 underline"
                onClick={() => { period.navProps.setPeriod('all'); setActiveFilters((p) => ({ ...p, company_name: '', customer_name: '', status: '', payment: '' })); }}>
                Clear
              </button>
            </>
          )}
        </div>

        {/* Summary band removed on user request — the filter row + the invoice
            table are enough; the tiles duplicated Analytics and added scroll. */}

        <ListState error={error} onRetry={refetch}>
        <MobileListCards
          rows={filteredData}
          isLoading={isLoading}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          searchPlaceholder="Search invoice, customer, DC…"
          onRowClick={(row) => navigate(`/sales/invoices/${row.id}`)}
          emptyMessage="No sales invoices found"
          config={{
            title: (row) => row.invoice_no || `Invoice #${row.id}`,
            subtitle: (row) => row.customer_name || row.buyer_name,
            badge: (row) => {
              const s = row.status;
              const map = {
                DRAFT:     { label: 'Draft',     cls: 'bg-slate-100 text-slate-700 border-slate-300' },
                CONFIRMED: { label: 'Confirmed', cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
                CANCELLED: { label: 'Cancelled', cls: 'bg-red-100 text-red-700 border-red-300' },
              };
              return map[s] || { label: s || '-', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
            },
            fields: (row) => [
              { label: 'Date',  value: fmtDate(row.invoice_date) },
              { label: 'Total', value: row.grand_total != null ? formatCurrency(row.grand_total) : null, cls: 'text-slate-800 font-medium' },
              { label: 'Balance', value: row.outstanding != null ? formatCurrency(row.outstanding) : null, cls: Number(row.outstanding) > 0 ? 'text-rose-600 font-medium' : 'text-emerald-700 font-medium' },
            ],
            actions: (row) => [
              { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/sales/invoices/${row.id}`) },
            ],
          }}
        />

        {/* No outer card/padding: DataTable already renders its own bordered
            card, so wrapping it in a second padded card (as before) double-boxed
            the table and made it read looser than the Bills list. Bare wrapper
            matches Bills — the table sits edge-to-edge and reads equally tight. */}
        <div className="hidden sm:block">
          <DataTable
            dense
            exportFileName="sales-invoices"
            canExport={canExport('Sales Invoice')}
            exportLineConfig={INVOICE_EXPORT_LINES}
            onExport={async (rows) => {
              try { await exportServerSide('/api/sales/invoices/export/', rows, 'sales-invoices'); }
              catch { toast.error('Export failed'); }
            }}
            columns={visibleColumns}
            data={filteredData}
            isLoading={isLoading}
            page={page}
            pageSize={10}
            totalRecords={filteredData.length}
            onPageChange={setPage}
            onSort={(f, o) => { setSortBy(f); setSortOrder(o); }}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onSearch={setSearchTerm}
            searchPlaceholder="Search by invoice no, customer, DC no or product..."
            extraSearchFields={['product_names']}
            onFilterChange={setActiveFilters}
            onRowClick={(row) => openQuick(row.id)}
            emptyMessage="No sales invoices found"
          />
        </div>
        </ListState>
      </div>
      {showTally && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowTally(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-base font-semibold text-slate-800 flex items-center gap-2"><FileDown size={18} className="text-blue-600" /> Export to Tally</h2>
              <button onClick={() => setShowTally(false)} className="p-1 text-slate-400 hover:text-slate-700"><X size={18} /></button>
            </div>
            <p className="text-xs text-slate-500 mb-4">Downloads a Tally voucher XML to import via Gateway of Tally → Import → Vouchers. Leave dates blank for everything.</p>
            <div className="flex gap-2 mb-4">
              {['sales', 'receipts'].map((t) => (
                <button key={t} onClick={() => setTallyType(t)}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border capitalize transition ${tallyType === t ? 'bg-blue-600 text-white border-blue-600' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
                  {t === 'sales' ? 'Sales invoices' : 'Customer receipts'}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3 mb-5">
              <div>
                <label className="block text-xs text-slate-500 mb-1">From</label>
                <CustomDatePicker value={tallyFrom} onChange={(e) => setTallyFrom(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">To</label>
                <CustomDatePicker value={tallyTo} onChange={(e) => setTallyTo(e.target.value)} />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowTally(false)} className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-300 text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={downloadTally} disabled={tallyBusy}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
                <FileDown size={16} /> {tallyBusy ? 'Preparing…' : 'Download XML'}
              </button>
            </div>
          </div>
        </div>
      )}
      {FlowPopup}
    </MainLayout>
  );
}
