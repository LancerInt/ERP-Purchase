import { confirm } from '@/components/common/confirm';
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Eye, Pencil, Trash2, Settings2, GitBranch, ShoppingCart, Search, ChevronLeft, ChevronRight, ChevronDown, Mail, RefreshCw, FileUp } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import BackToModule from '../../../components/common/BackToModule';
import DataTable from '../../../components/common/DataTable';
import ListState from '@/components/common/ListState.jsx';
import StatusBadge from '../../../components/common/StatusBadge';
import { applyAdvancedFilters, matchesSelect } from '../../../components/common/FilterPanel';
import { useConfigureFields } from '../../../components/common/ConfigureFields';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import { CTRL_H } from '@/components/common/controls';

// A multi-select from the old filter panel is stored as an array; a single
// picker can only honestly show one value, so anything else reads blank.
const pickOf = (v) => (Array.isArray(v) ? (v.length === 1 ? v[0] : '') : (v || ''));
import ExpandableLines, { CPO_LINE_COLUMNS, CPO_EXPORT_LINES } from '../../../components/common/ExpandableLines';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import { useFlowDashboard } from '../../../components/common/FlowDashboardPopup';
import ListAttachments, { useListAttachments } from '../components/ListAttachments';
import { formatDate } from '@/utils/formatters';

export default function CustomerPOList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete, canCreateSo, canViewInbox, canView, canExport } = usePermissions();
  // Dedicated permission for the "Inbox" header button + route guard
  // on /sales/customer-po/inbox. Backed by can_view_inbox on the
  // Customer PO row in the admin grid.
  const canSeeInbox = canViewInbox('Customer PO');
  // Dedicated permission for the "Create SO" row-action + mobile card
  // button. Backed by RolePermission.can_create_so on the Customer PO
  // row in the Sales Module Permissions admin grid.
  const canCreateSOPerm = canCreateSo('Customer PO');
  // Flow icon button. Reuses the existing View permission on the
  // Sales Flow Dashboard module (Page Permissions tab). If admin
  // unticks View there, the sidebar entry, the page, and these row
  // shortcuts all disappear together.
  const canSeeFlow = canView('Sales Flow Dashboard');
  // Cross-module nav: the "Linked SO" column shows clickable SO numbers
  // that route to /sales/orders/<id>. Gate on Sales Order view perm.
  const canSeeSO = canView('Sales Order');
  const { data, isLoading, error, refetch } = useApiData('/api/sales/customer-po/');
  const [sp, setSp] = useSearchParams();
  // Same arrangement as Sales Invoices, Dispatch Challans and Sales Orders:
  // the filters live in the address, so opening a PO and pressing Back brings
  // the list back exactly as it was.
  const period = usePeriodFilter(sp.get('period') || 'all', {
    anchor: sp.get('anchor'),
    customFrom: sp.get('cfrom'),
    customTo: sp.get('cto'),
  });
  const [page, setPage] = useState(() => Math.max(1, parseInt(sp.get('page'), 10) || 1));
  const [searchTerm, setSearchTerm] = useState(sp.get('q') || '');
  const [activeFilters, setActiveFilters] = useState(() => {
    const f = {};
    if (sp.get('company')) f.company_name = sp.get('company');
    if (sp.get('customer')) f.customer_name = sp.get('customer');
    return f;
  });
  const [fieldsOpen, setFieldsOpen] = useState(false);   // Fields dropdown
  const [advRules, setAdvRules] = useState([]);
  const [advLogic, setAdvLogic] = useState('AND');
  const { openFlow, FlowPopup } = useFlowDashboard();
  const { attachmentMap } = useListAttachments('CUSTOMER_PO');

  const filterColumns = [
    { field: 'upload_id', header: 'PO No', type: 'text' },
    { field: 'po_number', header: 'Customer PO No', type: 'text' },
    { field: 'po_date', header: 'PO Date', type: 'date' },
    { field: 'customer_name', header: 'Customer', type: 'text' },
    { field: 'company_name', header: 'Company', type: 'text' },
    { field: 'destination', header: 'Destination', type: 'text' },
    { field: 'status', header: 'Status', type: 'select', filterOptions: [
      { value: 'DRAFT', label: 'Draft' }, { value: 'CONFIRMED', label: 'Confirmed' },
      { value: 'CONVERTED', label: 'Converted' }, { value: 'CANCELLED', label: 'Cancelled' },
    ]},
  ];

  const handleDelete = async (id, no) => {
    if (!(await confirm({ message: `Delete Customer PO ${no}?`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try { await apiClient.delete(`/api/sales/customer-po/${id}/`); toast.success('Deleted'); refetch(); }
    catch (err) { toast.error(err.response?.data?.detail || 'Failed'); }
  };

  const fmtDate = (v) => v ? formatDate(v) : '-';

  const Link = ({ to, children }) => (
    <button onClick={(e) => { e.stopPropagation(); navigate(to); }} className="text-blue-700 hover:text-blue-900 hover:underline font-medium text-xs whitespace-nowrap">{children}</button>
  );
  const termLabel = (v) => ({ TO_PAY: 'To Pay', PAID: 'Paid', NET_15: 'Net 15', NET_30: 'Net 30', NET_45: 'Net 45', EX_FACTORY: 'Ex-Factory', DOOR_DELIVERY: 'Door Delivery', CIF: 'CIF', FOB: 'FOB' }[v] || v || '-');

  const columns = [
    // Order Details
    { field: 'upload_id', header: 'PO No', sortable: true, width: '150px',
      render: (v, row) => <Link to={`/sales/customer-po/${row.id}`}>{v}</Link> },
    { field: 'po_number', header: 'Customer PO No', sortable: true, width: '130px' },
    { field: 'po_date', header: 'PO Date', sortable: true, width: '95px', render: (v) => fmtDate(v) },
    { field: 'customer_name', header: 'Customer', sortable: true, width: '140px' },
    { field: 'company_name', header: 'Company', sortable: true, width: '140px' },
    { field: 'delivery_type', header: 'Delivery Terms', sortable: true, width: '95px', render: (v) => termLabel(v) },
    // Terms
    { field: 'freight_terms', header: 'Freight Terms', sortable: true, width: '90px', render: (v) => termLabel(v) },
    { field: 'payment_terms', header: 'Payment Terms', sortable: true, width: '90px', render: (v) => termLabel(v) },
    { field: 'currency', header: 'Currency', sortable: true, width: '70px' },
    // Shipping
    { field: 'required_ship_date', header: 'Ship Date', sortable: true, width: '95px', render: (v) => fmtDate(v) },
    { field: 'delivery_due_date', header: 'Due Date', sortable: true, width: '95px', render: (v) => fmtDate(v) },
    { field: 'destination', header: 'Destination', sortable: true, width: '120px' },
    { field: 'dispatched_through', header: 'Dispatched Through', sortable: true, width: '120px' },
    // Consignee
    { field: 'consignee_name', header: 'Consignee Name', sortable: true, width: '130px' },
    { field: 'consignee_gstin', header: 'Consignee GSTIN', sortable: true, width: '130px' },
    { field: 'billing_gstin', header: 'Billing GSTIN', sortable: true, width: '130px' },
    // Additional
    { field: 'special_instructions', header: 'Special Instructions', sortable: false, width: '150px' },
    { field: 'remarks', header: 'Remarks', sortable: false, width: '150px' },
    { field: 'status', header: 'Status', sortable: true, width: '100px', render: (v) => <StatusBadge status={v} /> },
    { field: 'po_status', header: 'PO Status', sortable: true, width: '130px',
      render: (v) => {
        const map = {
          PENDING: { label: 'Pending', cls: 'bg-slate-100 text-slate-700' },
          SO_CREATED: { label: 'SO Created', cls: 'bg-blue-100 text-blue-700' },
          PARTIAL_DC: { label: 'Partial DC', cls: 'bg-orange-100 text-orange-700' },
          DC_CREATED: { label: 'DC Created', cls: 'bg-amber-100 text-amber-700' },
          CLOSED: { label: 'Closed', cls: 'bg-green-100 text-green-700' },
        };
        const m = map[v] || { label: v || '-', cls: 'bg-slate-100 text-slate-600' };
        return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${m.cls}`}>{m.label}</span>;
      }
    },
    // Linked SOs — hyperlink when the user can view Sales Orders;
    // plain text otherwise so the SO number is still visible for
    // reference without exposing a click-through they can't load.
    { field: 'linked_sos', header: 'Linked SO', sortable: false, width: '130px',
      render: (v, row) => {
        const sos = v || [];
        if (sos.length > 0) {
          return (
            <div className="flex flex-wrap gap-1">
              {sos.map(so => canSeeSO
                ? <Link key={so.id} to={`/sales/orders/${so.id}`}>{so.so_no}</Link>
                : <span key={so.id} className="text-slate-700">{so.so_no}</span>)}
            </div>
          );
        }
        if (row.linked_so_number) {
          return canSeeSO
            ? <Link to={`/sales/orders/${row.linked_sales_order}`}>{row.linked_so_number}</Link>
            : <span className="text-slate-700">{row.linked_so_number}</span>;
        }
        return '-';
      }
    },
    { field: 'attachments', header: 'Photo Attachments', sortable: false, width: '140px',
      render: (_, row) => <ListAttachments attachments={attachmentMap[row.id]} /> },
    { field: 'actions', header: 'Actions', sortable: false, width: '170px', render: (_, row) => {
      const hasLinkedSO = (row.linked_sos?.length > 0) || row.linked_sales_order;
      // canCreateSO combines status gate (CPO must be confirmed and
      // not already linked) with the role-permission gate. Both must
      // be true for the truck-style "Create Sales Order" icon to show.
      const canCreateSO = canCreateSOPerm && row.status === 'CONFIRMED' && !hasLinkedSO;
      return (
        <div className="flex items-center gap-1">
          {canCreateSO && (
            <button onClick={(e) => { e.stopPropagation(); navigate(`/sales/orders/new?cpo_id=${row.id}&company=${row.company}&customer=${row.customer}`); }}
              className="p-1.5 text-green-600 hover:bg-green-50 rounded" title="Create Sales Order"><ShoppingCart size={15} /></button>
          )}
          {canSeeFlow && hasLinkedSO && (
            <button onClick={(e) => { e.stopPropagation(); openFlow(row.linked_sos?.[0]?.id || row.linked_sales_order); }}
              className="p-1.5 text-purple-600 hover:bg-purple-50 rounded" title="Flow"><GitBranch size={15} /></button>
          )}
          <button onClick={(e) => { e.stopPropagation(); navigate(`/sales/customer-po/${row.id}`); }} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded" title="View"><Eye size={15} /></button>
          {/* Edit/Delete only while the PO is still DRAFT — once it is
              CONFIRMED / CONVERTED / CANCELLED the document is committed
              and is read-only from the UI (matches the SO / DC / Invoice
              post-approval lock applied across the sales module). */}
          {canEdit('Customer PO') && row.status === 'DRAFT' && (
            <button onClick={(e) => { e.stopPropagation(); navigate(`/sales/customer-po/${row.id}/edit`); }} className="p-1.5 text-amber-600 hover:bg-amber-50 rounded" title="Edit"><Pencil size={15} /></button>
          )}
          {canDelete('Customer PO') && row.status === 'DRAFT' && (
            <button onClick={(e) => { e.stopPropagation(); handleDelete(row.id, row.upload_id); }} className="p-1.5 text-red-500 hover:bg-red-50 rounded" title="Delete"><Trash2 size={15} /></button>
          )}
        </div>
      );
    }},
  ];

  const { visibleColumns, mergedColumns, handleConfigApply, visibleFieldKeys } = useConfigureFields(columns, 'customer_po_fields', data);

  // Customer / Company filter options are derived from the already-loaded
  // PO list — so the dropdown only ever offers names that actually
  // have at least one row on this page (no dead options).
  const customerOptions = useMemo(() => {
    const names = [...new Set((data || []).map(r => r.customer_name).filter(Boolean))].sort();
    return names.map(n => ({ value: n, label: n }));
  }, [data]);
  const companyOptions = useMemo(() => {
    const names = [...new Set((data || []).map(r => r.company_name).filter(Boolean))].sort();
    return names.map(n => ({ value: n, label: n }));
  }, [data]);

  const filterOptions = [
    { key: 'status', label: 'Status', options: [
      { value: 'DRAFT', label: 'Draft' }, { value: 'CONFIRMED', label: 'Confirmed' },
      { value: 'CONVERTED', label: 'Converted' }, { value: 'CANCELLED', label: 'Cancelled' },
    ]},
    { key: 'po_status', label: 'PO Status', single: true, options: [
      { value: 'PENDING', label: 'Pending' },
      { value: 'CLOSED', label: 'Closed' },
    ]},
    { key: 'customer_name', label: 'Customer', type: 'select', options: customerOptions },
    { key: 'company_name', label: 'Company', type: 'select', options: companyOptions },
  ];

  // A filter change makes the page number meaningless, so reset to 1 -
  // except on the first render, where a page restored from the URL on Back
  // must survive.
  const firstPageReset = useRef(true);
  const pageResetSig = JSON.stringify([period.navProps, activeFilters, searchTerm]);
  useEffect(() => {
    if (firstPageReset.current) { firstPageReset.current = false; return; }
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageResetSig]);

  // Keep the address in step. replace:true so picking a filter is not a
  // history entry for Back to crawl through.
  useEffect(() => {
    const pp = new URLSearchParams(sp);
    const put = (k, v, keep) => { if (keep) pp.set(k, v); else pp.delete(k); };
    const np = period.navProps;
    const co = pickOf(activeFilters.company_name);
    const cu = pickOf(activeFilters.customer_name);
    put('period', np.period, np.period && np.period !== 'all');
    put('anchor', np.anchor, np.period !== 'all' && np.period !== 'custom');
    put('cfrom', np.customFrom, np.period === 'custom');
    put('cto', np.customTo, np.period === 'custom');
    put('company', co, !!co);
    put('customer', cu, !!cu);
    put('q', searchTerm, !!searchTerm.trim());
    put('page', String(page), page > 1);
    const next = pp.toString();
    if (next !== sp.toString()) setSp(pp, { replace: true });
  }, [period.navProps, activeFilters, searchTerm, page, sp, setSp]);

  const filteredData = (() => {
    // Add a flat product_names field from parsed_lines so DataTable's internal search can find it
    let result = (data || []).map(item => ({
      ...item,
      product_names: (item.parsed_lines || []).map(l => l.product_name || '').filter(Boolean),
    })).filter((item) => {
      const t = searchTerm.toLowerCase();
      const isPendingFilter = activeFilters.po_status === 'PENDING';
      // Product-name search source: when filtering by Pending and the user types a
      // product term, only match products that are still pending dispatch.
      const productSource = isPendingFilter && t
        ? (item.pending_products || [])
        : (item.product_names || []);
      const productNames = productSource.join(' ').toLowerCase();
      const s = !t || [
        item.upload_id, item.po_number, item.customer_name, item.company_name,
        item.destination, item.delivery_type, item.freight_terms,
        item.po_date, item.status, item.po_status,
      ].some(v => v != null && String(v).toLowerCase().includes(t)) || productNames.includes(t);
      const f = matchesSelect(item.status, activeFilters.status);
      const pf = !activeFilters.po_status
        || (isPendingFilter ? item.po_status !== 'CLOSED' : item.po_status === activeFilters.po_status);
      const cf = matchesSelect(item.customer_name, activeFilters.customer_name);
      const cof = matchesSelect(item.company_name, activeFilters.company_name);
      return s && f && pf && cf && cof && period.match(item.po_date || item.upload_date);
    });
    if (advRules.length > 0) result = applyAdvancedFilters(result, advRules, advLogic);
    // Order chronologically — oldest first (PO date, Apr 1 -> today) — so the
    // list reads like a date-sequenced register. Falls back to upload_date when
    // a row has no parsed PO date so it still sorts sensibly.
    const dkey = (r) => new Date(r.po_date || r.upload_date || 0).getTime();
    result = [...result].sort((a, b) => dkey(a) - dkey(b));
    return result;
  })();

  return (
    <MainLayout>
      <div className="space-y-3 sm:space-y-6">
        {/* Mobile-friendly list header — stacks the title above the
            action row on sub-sm widths, and the action buttons wrap
            instead of fighting for space. Title shrinks to text-2xl
            below sm so it never wraps to two lines on phones. */}
        <div className="flex flex-wrap items-center justify-between gap-x-2 sm:gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1 sm:min-w-[15rem] flex items-center gap-1.5">
            <BackToModule />
            <div className="min-w-0">
              <h1 className="text-xl sm:text-3xl font-bold text-slate-900 truncate lg:whitespace-normal lg:overflow-visible">Customer PO</h1>
              <p className="hidden sm:block text-slate-600 mt-1 text-sm sm:text-base">Manage customer purchase orders</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3 shrink-0">
            {/* PO Email Inbox now lives on its own page at
                /sales/customer-po/inbox so the Customer PO list isn't
                forced to host the inbox panel above the table. The
                button below is the entry point — gated on the
                dedicated can_view_inbox permission. */}
            {canSeeInbox && (
              <button onClick={() => navigate('/sales/customer-po/inbox')} title="Email Inbox" aria-label="Email Inbox"
                className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-3 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
                <Mail size={18} /> <span className="hidden sm:inline">Email Inbox</span>
              </button>
            )}
            {canCreate('Customer PO') && (
              <button onClick={() => navigate('/sales/customer-po/bulk')} title="Bulk Upload" aria-label="Bulk Upload"
                className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-3 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
                <FileUp size={18} /> <span className="hidden sm:inline">Bulk Upload</span>
              </button>
            )}
            {canCreate('Customer PO') && (
              <button onClick={() => navigate('/sales/customer-po/new')} className="flex items-center gap-2 px-3 sm:px-6 py-2 sm:py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm sm:text-base font-medium"><Plus size={18} /> <span className="hidden xs:inline">Create </span>Customer PO</button>
            )}
          </div>
        </div>
        {/* PO Email Inbox lives at /sales/customer-po/inbox now —
            accessed via the "Email Inbox" button in the header above.
            The "Process Mail" flow from there still routes back to
            the Create page with ?inbox_id=...&attachment_id=...,
            unchanged. */}
        {/* The same filter row the other sales lists carry: when, which
            company, which customer, which columns. This page had no period
            filter at all before -- there was no way to narrow POs by date. */}
        <div className="flex flex-wrap items-center gap-2">
          <PeriodNavigator allowAll {...period.navProps} />
          <CustomSelect value={pickOf(activeFilters.company_name)} title="Company"
            onChange={(e) => setActiveFilters((p) => ({ ...p, company_name: e.target.value }))}
            className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white max-w-[230px]">
            <option value="">All Companies</option>
            {companyOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </CustomSelect>
          <CustomSelect value={pickOf(activeFilters.customer_name)} title="Customer"
            onChange={(e) => setActiveFilters((p) => ({ ...p, customer_name: e.target.value }))}
            className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white max-w-[230px]">
            <option value="">All Customers</option>
            {customerOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </CustomSelect>

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
                <div className="fixed inset-0 z-20" onClick={() => setFieldsOpen(false)} />
                <div className="absolute z-30 mt-1 w-60 max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg py-1">
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

          {(period.range || pickOf(activeFilters.company_name) || pickOf(activeFilters.customer_name)) && (
            <>
              <span className="text-xs text-slate-500 tabular-nums">
                {filteredData.length.toLocaleString('en-IN')} of {(data || []).length.toLocaleString('en-IN')} POs
              </span>
              <button type="button" className="text-xs text-slate-500 hover:text-slate-800 underline"
                onClick={() => { period.navProps.setPeriod('all'); setActiveFilters((p) => ({ ...p, company_name: '', customer_name: '' })); }}>
                Clear
              </button>
            </>
          )}
        </div>
        <ListState error={error} onRetry={refetch}>
        {/* Mobile-only card list (sub-sm breakpoint).
            The desktop DataTable below is hidden on mobile because its
            wide column count + horizontal scroll is uncomfortable on a
            phone. The mobile view shares `searchTerm` / `activeFilters`
            / `filteredData` with the desktop view so the underlying
            data is identical — the difference is purely presentational.
            Pagination is computed inline (10 rows / page) rather than
            piped through DataTable, because DataTable is hidden here.
            Desktop layout, behaviour, and the DataTable component are
            untouched. */}
        <MobileCardList
          rows={filteredData}
          isLoading={isLoading}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          filterOptions={filterOptions}
          activeFilters={activeFilters}
          onFilterChange={setActiveFilters}
          attachmentMap={attachmentMap}
          onView={(row) => navigate(`/sales/customer-po/${row.id}`)}
          onEdit={(row) => navigate(`/sales/customer-po/${row.id}/edit`)}
          onDelete={(row) => handleDelete(row.id, row.upload_id)}
          onCreateSO={(row) => navigate(`/sales/orders/new?cpo_id=${row.id}&company=${row.company}&customer=${row.customer}`)}
          onOpenFlow={canSeeFlow ? ((soId) => openFlow(soId)) : null}
          canEdit={canEdit('Customer PO')}
          canDelete={canDelete('Customer PO')}
          canCreateSOPerm={canCreateSOPerm}
          fmtDate={fmtDate}
        />

        {/* Desktop / tablet table view — hidden on mobile.
            DataTable already handles its own search / sort / pagination
            / export inside; we don't change any of that. */}
        <div className="hidden sm:block bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
          <DataTable columns={visibleColumns} data={filteredData} isLoading={isLoading} page={page} pageSize={10} totalRecords={filteredData.length}
            onPageChange={setPage} onSort={() => {}} onSearch={setSearchTerm} extraSearchFields={['product_names']} searchPlaceholder="Search PO no, customer, product..."
            onFilterChange={setActiveFilters} onRowClick={(row) => navigate(`/sales/customer-po/${row.id}`, { state: { backTo: `${window.location.pathname}${window.location.search}` } })}
            exportFileName="customer-po" emptyMessage="No customer POs found"
            canExport={canExport('Customer PO')}
            exportLineConfig={CPO_EXPORT_LINES}
            expandableContent={(row) => <ExpandableLines apiUrl={`/api/sales/customer-po/${row.id}/`} linesKey="parsed_lines" columns={CPO_LINE_COLUMNS} />}
            expandAsModal
            expandModalTitle={(row) => `Line Items — ${row.po_number || row.upload_id || 'Customer PO'}`} />
        </div>
        </ListState>
      </div>
      {FlowPopup}
    </MainLayout>
  );
}

// ── Mobile-only card list ───────────────────────────────────────────
// Renders below sm: (640px). One Customer PO per card with the fields
// that fit in a phone-width column — heavy stuff like consignee GSTIN
// and freight terms stay on the desktop DataTable. Vertical scroll
// only, no horizontal panning. Tap a card to open the detail page.
const MOBILE_PAGE_SIZE = 10;

const PO_STATUS_LABELS = {
  PENDING:    { label: 'Pending',     cls: 'bg-slate-100 text-slate-700 border-slate-200' },
  SO_CREATED: { label: 'SO Created',  cls: 'bg-blue-100 text-blue-700 border-blue-200' },
  PARTIAL_DC: { label: 'Partial DC',  cls: 'bg-orange-100 text-orange-700 border-orange-200' },
  DC_CREATED: { label: 'DC Created',  cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  CLOSED:     { label: 'Closed',      cls: 'bg-green-100 text-green-700 border-green-200' },
};

function MobileCardList({
  rows, isLoading, searchTerm, onSearchChange, activeFilters, onFilterChange,
  filterOptions = [], attachmentMap, onView, onEdit, onDelete, onCreateSO, onOpenFlow,
  canEdit, canDelete, canCreateSOPerm, fmtDate,
}) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(rows.length / MOBILE_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = rows.slice((safePage - 1) * MOBILE_PAGE_SIZE, safePage * MOBILE_PAGE_SIZE);

  return (
    <div className="sm:hidden space-y-3">
      {/* Compact search + status filter on a single card so the
          mobile UI doesn't lose them when DataTable's own toolbar
          gets hidden. */}
      <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-2">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            type="search"
            value={searchTerm}
            onChange={(e) => { onSearchChange(e.target.value); setPage(1); }}
            placeholder="Search PO no, customer, product…"
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        {filterOptions.map(f => (
          <CustomSelect
            key={f.key}
            value={activeFilters[f.key] || ''}
            onChange={(e) => {
              const value = e.target.value;
              onFilterChange(prev => ({ ...prev, [f.key]: value || undefined }));
              setPage(1);
            }}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <option value="">{f.label}: All</option>
            {f.options.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </CustomSelect>
        ))}
      </div>

      {/* Empty / loading states keep parity with the desktop view's
          messaging so users on either device see the same vocabulary. */}
      {!isLoading && rows.length === 0 && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6 text-center text-sm text-slate-500">
          No customer POs found.
        </div>
      )}

      <div className="grid grid-cols-2 gap-2.5">
        {pageRows.map(row => (
          <MobilePOCard
            key={row.id}
            row={row}
            attachmentMap={attachmentMap}
            onView={() => onView(row)}
            onEdit={() => onEdit(row)}
            onDelete={() => onDelete(row)}
            onCreateSO={() => onCreateSO(row)}
            onOpenFlow={onOpenFlow}
            canEdit={canEdit}
            canDelete={canDelete}
            canCreateSOPerm={canCreateSOPerm}
            fmtDate={fmtDate}
          />
        ))}
      </div>

      {/* Mobile pagination — minimal: page indicator + prev / next.
          Hidden when there's only one page so the UI stays compact. */}
      {totalPages > 1 && (
        <div className="bg-white rounded-lg border border-slate-200 p-3 flex items-center justify-between text-sm">
          <span className="text-slate-600">
            Page {safePage} of {totalPages}
            <span className="text-slate-400 ml-1">· {rows.length} record{rows.length === 1 ? '' : 's'}</span>
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              className="p-2 rounded border border-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Previous page"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
              className="p-2 rounded border border-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Next page"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MobilePOCard({ row, attachmentMap, onView, onEdit, onDelete, onCreateSO, onOpenFlow, canEdit, canDelete, canCreateSOPerm, fmtDate }) {
  const hasLinkedSO = (row.linked_sos?.length > 0) || row.linked_sales_order;
  // Status gate + role permission. canCreateSOPerm is the `canCreateSo`
  // call on Customer PO threaded down from the parent. Defaults to true
  // for back-compat with any caller that hasn't passed the flag.
  const canCreateSO = (canCreateSOPerm !== false) && row.status === 'CONFIRMED' && !hasLinkedSO;
  const isDraft = row.status === 'DRAFT';
  const poStatusMeta = PO_STATUS_LABELS[row.po_status] || { label: row.po_status || '-', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
  const statusMeta = {
    DRAFT:     { label: 'Draft',     cls: 'bg-slate-100 text-slate-700 border-slate-300' },
    CONFIRMED: { label: 'Confirmed', cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
    CONVERTED: { label: 'Converted', cls: 'bg-blue-100 text-blue-800 border-blue-300' },
    CANCELLED: { label: 'Cancelled', cls: 'bg-red-100 text-red-700 border-red-300' },
  }[row.status] || { label: row.status || '-', cls: 'bg-slate-100 text-slate-700 border-slate-300' };

  return (
    <div className="bg-white rounded-lg border border-slate-200 overflow-hidden active:bg-slate-50">
      {/* Tappable header — opens detail */}
      <button
        type="button"
        onClick={onView}
        className="w-full text-left px-2.5 py-2.5"
      >
        <div className="flex items-start justify-between gap-1.5 mb-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-blue-700 truncate">{row.upload_id}</p>
            {row.po_number && (
              <p className="text-xs text-slate-500 mt-0.5 truncate">PO #{row.po_number}</p>
            )}
          </div>
          <span className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${statusMeta.cls}`}>
            {statusMeta.label}
          </span>
        </div>

        <div className="space-y-1 text-xs">
          {row.customer_name && (
            <div className="flex items-baseline gap-2">
              <span className="text-[10px] uppercase tracking-wide text-slate-400 shrink-0">Customer</span>
              <span className="flex-1 min-w-0 truncate text-right text-slate-800">{row.customer_name}</span>
            </div>
          )}
          {row.company_name && (
            <div className="flex items-baseline gap-2">
              <span className="text-[10px] uppercase tracking-wide text-slate-400 shrink-0">Company</span>
              <span className="flex-1 min-w-0 truncate text-right text-slate-700">{row.company_name}</span>
            </div>
          )}
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] uppercase tracking-wide text-slate-400 shrink-0">PO Date</span>
            <span className="flex-1 min-w-0 truncate text-right text-slate-700">{fmtDate(row.po_date)}</span>
          </div>
          {row.destination && (
            <div className="flex items-baseline gap-2">
              <span className="text-[10px] uppercase tracking-wide text-slate-400 shrink-0">Dest.</span>
              <span className="flex-1 min-w-0 truncate text-right text-slate-700">{row.destination}</span>
            </div>
          )}
        </div>

        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${poStatusMeta.cls}`}>
            {poStatusMeta.label}
          </span>
          {(row.linked_sos || []).length > 0 && (
            <span className="text-[11px] text-blue-700">
              SO: {(row.linked_sos || []).map(s => s.so_no).join(', ')}
            </span>
          )}
        </div>
      </button>

      {/* Action row — distinct touch targets, easy to tap with a thumb. */}
      <div className="border-t border-slate-100 px-1.5 py-1.5 flex items-center gap-1 flex-wrap">
        <button
          type="button"
          onClick={onView}
          className="flex-1 min-w-[52px] inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 rounded"
        >
          <Eye size={14} /> View
        </button>
        {canCreateSO && (
          <button
            type="button"
            onClick={onCreateSO}
            className="flex-1 min-w-[52px] inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium text-green-700 hover:bg-green-50 rounded"
          >
            <ShoppingCart size={14} /> Create SO
          </button>
        )}
        {hasLinkedSO && onOpenFlow && (
          <button
            type="button"
            onClick={() => onOpenFlow(row.linked_sos?.[0]?.id || row.linked_sales_order)}
            className="flex-1 min-w-[52px] inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium text-purple-700 hover:bg-purple-50 rounded"
          >
            <GitBranch size={14} /> Flow
          </button>
        )}
        {canEdit && isDraft && (
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50 rounded"
            aria-label="Edit"
          >
            <Pencil size={14} />
          </button>
        )}
        {canDelete && isDraft && (
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 rounded"
            aria-label="Delete"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
