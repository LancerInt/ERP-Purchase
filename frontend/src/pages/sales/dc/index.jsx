import { confirm } from '@/components/common/confirm';
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronDown, Plus, Eye, Pencil, Trash2, Settings2, GitBranch, ShoppingCart, Truck, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import BackToModule from '../../../components/common/BackToModule';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import { applyAdvancedFilters, matchesSelect } from '../../../components/common/FilterPanel';
import { useConfigureFields } from '../../../components/common/ConfigureFields';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import { CTRL_H } from '@/components/common/controls';
import CustomSelect from '@/components/ui/CustomSelect';
import ExpandableLines, { DC_LINE_COLUMNS, DC_EXPORT_LINES } from '../../../components/common/ExpandableLines';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import { exportServerSide } from '../../../utils/exportExcel.js';
import { useFlowDashboard } from '../../../components/common/FlowDashboardPopup';
import ListAttachments, { useListAttachments } from '../components/ListAttachments';
import MobileListCards from '../components/MobileListCards';
import ListState from '@/components/common/ListState.jsx';

// A multi-select from the old filter panel is stored as an array; a single
// picker can only honestly show one value, so anything else reads blank.
const pickOf = (v) => (Array.isArray(v) ? (v.length === 1 ? v[0] : '') : (v || ''));
import { formatDate } from '@/utils/formatters';

export default function DispatchChallanList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete, canView, canCreateFreight, canExport } = usePermissions();
  // Flow icon button — reuses Sales Flow Dashboard view permission.
  // Untick that perm and this row-action disappears wherever it lives.
  const canSeeFlow = canView('Sales Flow Dashboard');
  // Cross-module navigation gates. A clickable link/button to another
  // sales module is hidden when the user can't view the destination —
  // showing it would route them straight to a 403 page. Where the
  // value still needs to surface (e.g. an SO number tag on a DC row),
  // we render it as plain text instead of a Link so the data is
  // visible but the navigation is suppressed.
  const canSeeSO = canView('Sales Order');
  const canSeeCPO = canView('Customer PO');
  // Orange "Freight" pill on each released DC row — gated by the
  // dedicated can_create_freight flag on Dispatch Challan.
  const canSeeFreightBtn = canCreateFreight('Dispatch Challan');
  const { data, isLoading, error, refetch } = useApiData('/api/sales/dc/');
  const [sp, setSp] = useSearchParams();
  // Same arrangement as Sales Invoices: the filters live in the address, so
  // opening a challan and pressing Back brings the list back as it was.
  const period = usePeriodFilter(sp.get('period') || 'all', {
    anchor: sp.get('anchor'),
    customFrom: sp.get('cfrom'),
    customTo: sp.get('cto'),
  });
  const [page, setPage] = useState(() => Math.max(1, parseInt(sp.get('page'), 10) || 1));
  const [sortBy, setSortBy] = useState(sp.get('sort') || 'dispatch_date');
  const [sortOrder, setSortOrder] = useState(sp.get('dir') || 'asc');   // oldest first (Apr 1 → today)
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
  const { attachmentMap } = useListAttachments('DISPATCH_CHALLAN');

  const filterColumns = [
    { field: 'dc_no', header: 'DC Number', type: 'text' },
    { field: 'dispatch_date', header: 'Dispatch Date', type: 'date' },
    { field: 'warehouse_name', header: 'Warehouse', type: 'text' },
    { field: 'total_dispatch_qty', header: 'Total Qty', type: 'number' },
    { field: 'status', header: 'Status', type: 'select', filterOptions: [
      { value: 'DRAFT', label: 'Draft' }, { value: 'RELEASED', label: 'Released' },
      { value: 'DELIVERED', label: 'Delivered' }, { value: 'CLOSED', label: 'Closed' },
    ]},
  ];

  const handleDelete = async (id, dcNo) => {
    if (!(await confirm({ message: `Delete Dispatch Challan ${dcNo}? This cannot be undone.`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/sales/dc/${id}/`);
      toast.success(`DC ${dcNo} deleted`);
      refetch();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to delete');
    }
  };

  const Link = ({ to, children }) => (
    <button onClick={(e) => { e.stopPropagation(); navigate(to); }} className="text-blue-700 hover:text-blue-900 hover:underline font-medium text-xs whitespace-nowrap">{children}</button>
  );
  const fmtDate = (v) => v ? formatDate(v) : '-';
  const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

  const columns = [
    { field: 'dc_no', header: 'DC Number', sortable: true, width: '150px',
      render: (v, row) => <Link to={`/sales/dc/${row.id}`}>{v}</Link> },
    { field: 'linked_so_no', header: 'SO No', sortable: true, width: '120px',
      render: (v, row) => {
        if (!v || !row.linked_so_id) return <span className="text-xs text-slate-400">-</span>;
        // Render as plain text when the user can't view Sales Orders —
        // they should still see the number for reference, just not
        // click into a page they're not allowed to load.
        return canSeeSO
          ? <Link to={`/sales/orders/${row.linked_so_id}`}>{v}</Link>
          : <span>{v}</span>;
      } },
    { field: 'customer_po_numbers', header: 'Customer PO', sortable: false, width: '160px',
      render: (v) => {
        const cpos = v || [];
        if (cpos.length === 0) return <span className="text-xs text-slate-400">-</span>;
        return (
          <div className="flex flex-wrap gap-1">
            {cpos.map(cpo => {
              const label = cpo.po_number || cpo.upload_id;
              return canSeeCPO
                ? <Link key={cpo.id} to={`/sales/customer-po/${cpo.id}`}>{label}</Link>
                : <span key={cpo.id} className="text-slate-700">{label}</span>;
            })}
          </div>
        );
      }
    },
    { field: 'dispatch_date', header: 'Dispatch Date', sortable: true, width: '110px', render: (v) => fmtDate(v) },
    { field: 'company_name', header: 'Company', sortable: true, width: '140px',
      render: (v) => v || <span className="text-xs text-slate-400">-</span> },
    { field: 'warehouse_name', header: 'Warehouse', sortable: true, width: '110px' },
    { field: 'transporter_name', header: 'Transporter', sortable: true, width: '120px' },
    { field: 'lorry_no', header: 'Lorry No', sortable: true, width: '100px' },
    { field: 'driver_contact', header: 'Driver Contact', sortable: true, width: '110px' },
    { field: 'total_dispatch_qty', header: 'Total Qty', sortable: true, width: '90px', render: (v) => fmtQty(v) },
    { field: 'destination', header: 'Destination', sortable: true, width: '120px' },
    { field: 'status', header: 'Status', sortable: true, width: '100px', render: (v) => <StatusBadge status={v} /> },
    {
      field: 'freight',
      header: '',
      sortable: false,
      width: '100px',
      render: (_, row) => {
        if (row.has_freight) return <span className="inline-flex items-center gap-1 px-2 py-0.5 text-emerald-700 bg-emerald-50 border border-emerald-200 rounded text-xs font-medium" title="Freight already created"><Truck size={12} /> Linked</span>;
        if (row.status !== 'RELEASED') return <span className="text-xs text-slate-400">-</span>;
        // Ex-Factory DCs never get an outward freight — surface that
        // here instead of a clickable button so the user understands
        // why the option is missing.
        if (row.delivery_terms === 'EX_FACTORY') {
          return (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 text-amber-800 bg-amber-50 border border-amber-200 rounded text-xs font-medium"
              title="Ex-Factory delivery — customer collects at the gate. No freight billed."
            >
              Ex-Factory
            </span>
          );
        }
        // Gated on the dedicated can_create_freight perm on Dispatch
        // Challan. When the role doesn't have it, show a static
        // "Pending" pill so the column doesn't visually collapse —
        // users with view-only access still understand that this DC
        // is waiting for someone authorized to raise its freight.
        if (!canSeeFreightBtn) {
          return (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-slate-500 bg-slate-50 border border-slate-200 rounded text-xs font-medium" title="Outward freight not yet raised">
              <Truck size={12} /> Pending
            </span>
          );
        }
        return (
          <button onClick={(e) => { e.stopPropagation(); navigate(`/freight/outward/new?dc_id=${row.id}`); }}
            className="inline-flex items-center gap-1 px-2.5 py-1 bg-orange-600 text-white text-xs font-medium rounded-lg hover:bg-orange-700 transition" title="Create Freight">
            <Truck size={13} /> Freight
          </button>
        );
      },
    },
    { field: 'attachments', header: 'Photo Attachments', sortable: false, width: '140px',
      render: (_, row) => <ListAttachments attachments={attachmentMap[row.id]} /> },
    {
      field: 'actions',
      header: 'Actions',
      sortable: false,
      width: '150px',
      render: (_, row) => (
        <div className="flex items-center gap-1">
          {canSeeSO && row.linked_so_id && (
            <button onClick={(e) => { e.stopPropagation(); navigate(`/sales/orders/${row.linked_so_id}`); }}
              className="p-1.5 text-blue-700 hover:bg-blue-50 rounded transition" title="View Sales Order"><ShoppingCart size={15} /></button>
          )}
          {canSeeFlow && row.linked_so_id && (
            <button onClick={(e) => { e.stopPropagation(); openFlow(row.linked_so_id); }}
              className="p-1.5 text-purple-600 hover:bg-purple-50 rounded transition" title="Flow"><GitBranch size={15} /></button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); navigate(`/sales/dc/${row.id}`); }}
            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
            title="View Details"
          >
            <Eye size={15} />
          </button>
          {/* Edit stays DRAFT-only — once the DC is RELEASED the line
              items are locked. Delete is allowed at any status; the
              backend cascades downstream invoice / receivable / freight
              rows and soft-deletes the OUT ledger entries in one go. */}
          {canEdit('Dispatch Challan') && row.status === 'DRAFT' && (
            <button
              onClick={(e) => { e.stopPropagation(); navigate(`/sales/dc/${row.id}/edit`); }}
              className="p-1.5 text-amber-600 hover:bg-amber-50 rounded transition"
              title="Edit"
            >
              <Pencil size={15} />
            </button>
          )}
          {canDelete('Dispatch Challan') && (
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(row.id, row.dc_no); }}
              className="p-1.5 text-red-500 hover:bg-red-50 rounded transition"
              title="Delete"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ),
    },
  ];

  const { visibleColumns, mergedColumns, handleConfigApply, visibleFieldKeys } = useConfigureFields(columns, 'dc_fields', data);

  const warehouseFilterOptions = [...new Set((data || []).map(i => i.warehouse_name).filter(Boolean))]
    .sort().map(w => ({ value: w, label: w }));
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
        { value: 'RELEASED', label: 'Released' },
        { value: 'DELIVERED', label: 'Delivered' },
        { value: 'CLOSED', label: 'Closed' },
      ],
    },
    { key: 'customer_name', label: 'Customer', type: 'select', options: customerFilterOptions },
    { key: 'company_name',  label: 'Company',  type: 'select', options: companyFilterOptions },
    {
      key: 'warehouse_name',
      label: 'Warehouse',
      options: warehouseFilterOptions,
    },
  ];

  const filteredData = (() => {
    let result = (data || []).filter((item) => {
      const term = searchTerm.toLowerCase();
      const productNames = (item.product_names || []).join(' ').toLowerCase();
      const matchesSearch = !term || [
        item.dc_no, item.dc_date, item.customer_name, item.company_name,
        item.warehouse_name, item.so_no, item.total_dispatch_qty, item.status,
      ].some(v => v != null && String(v).toLowerCase().includes(term)) || productNames.includes(term);
      const matchesStatus = matchesSelect(item.status, activeFilters.status);
      const matchesWarehouse = matchesSelect(item.warehouse_name, activeFilters.warehouse_name);
      const matchesCustomer = matchesSelect(item.customer_name, activeFilters.customer_name);
      const matchesCompany = matchesSelect(item.company_name, activeFilters.company_name);
      return matchesSearch && matchesStatus && matchesWarehouse && matchesCustomer && matchesCompany
        && period.match(item.dispatch_date);
    });
    if (advRules.length > 0) result = applyAdvancedFilters(result, advRules, advLogic);

    // Apply the sort the header arrow was already claiming. Nothing reordered
    // the rows before: DataTable does not sort internally and this only
    // filtered, so clicking a column moved the arrow and left the list alone.
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

  // Keep the address in step. replace:true so picking a filter does not leave
  // a history entry for Back to crawl through.
  // A filter change makes the page number meaningless, so reset to 1 -
  // except on the first render, where a page restored from the URL on Back
  // must survive.
  const firstPageReset = useRef(true);
  const pageResetSig = JSON.stringify([period.navProps, activeFilters, searchTerm, sortBy, sortOrder]);
  useEffect(() => {
    if (firstPageReset.current) { firstPageReset.current = false; return; }
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageResetSig]);

  useEffect(() => {
    const p = new URLSearchParams(sp);
    const put = (k, v, keep) => { if (keep) p.set(k, v); else p.delete(k); };
    const np = period.navProps;
    const cust = pickOf(activeFilters.customer_name);
    put('period', np.period, np.period && np.period !== 'all');
    put('anchor', np.anchor, np.period !== 'all' && np.period !== 'custom');
    put('cfrom', np.customFrom, np.period === 'custom');
    put('cto', np.customTo, np.period === 'custom');
    const co = pickOf(activeFilters.company_name);
    put('company', co, !!co);
    put('customer', cust, !!cust);
    put('q', searchTerm, !!searchTerm.trim());
    put('sort', sortBy, sortBy !== 'dispatch_date');
    put('dir', sortOrder, sortOrder !== 'asc');
    put('page', String(page), page > 1);
    const next = p.toString();
    if (next !== sp.toString()) setSp(p, { replace: true });
  }, [period.navProps, activeFilters, searchTerm, sortBy, sortOrder, page, sp, setSp]);

  return (
    <MainLayout>
      <div className="space-y-3 sm:space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-x-2 sm:gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1 sm:min-w-[15rem] flex items-center gap-1.5">
            <BackToModule />
            <div className="min-w-0">
              <h1 className="text-xl sm:text-3xl font-bold text-slate-900 truncate lg:whitespace-normal lg:overflow-visible">Dispatch Challans</h1>
              <p className="hidden sm:block text-slate-600 mt-1 text-sm sm:text-base">Manage dispatch challans and track deliveries</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3 shrink-0">
            {canCreate('Dispatch Challan') && (
              <button onClick={() => navigate('/sales/dc/new')} className="flex items-center gap-2 px-3 sm:px-6 py-2 sm:py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm sm:text-base font-medium"><Plus size={18} /> New DC</button>
            )}
          </div>
        </div>
        {/* The same filter row Sales Invoices carries: when, who, and which
            columns -- all beside each other, none of it in the header. */}
        <div className="flex flex-wrap items-center gap-2">
          <PeriodNavigator allowAll {...period.navProps} />
          {/* Which company's documents. The filter itself already existed --
              it was only reachable through the Filters panel that used to sit
              in the header, so removing that panel left it working but with
              nothing to drive it. This writes the same
              activeFilters.company_name the panel wrote. */}
          <CustomSelect value={pickOf(activeFilters.company_name)} title="Company"
            onChange={(e) => setActiveFilters((p) => ({ ...p, company_name: e.target.value }))}
            className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white max-w-[230px]">
            <option value="">All Companies</option>
            {companyFilterOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </CustomSelect>
          <CustomSelect value={pickOf(activeFilters.customer_name)} title="Customer"
            onChange={(e) => setActiveFilters((p) => ({ ...p, customer_name: e.target.value }))}
            className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white max-w-[230px]">
            <option value="">All Customers</option>
            {customerFilterOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
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
                {filteredData.length.toLocaleString('en-IN')} of {(data || []).length.toLocaleString('en-IN')} challans
              </span>
              <button type="button" className="text-xs text-slate-500 hover:text-slate-800 underline"
                onClick={() => { period.navProps.setPeriod('all'); setActiveFilters((p) => ({ ...p, company_name: '', customer_name: '' })); }}>
                Clear
              </button>
            </>
          )}
        </div>

        <ListState error={error} onRetry={refetch}>
        <MobileListCards
          rows={filteredData}
          isLoading={isLoading}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          searchPlaceholder="Search DC, warehouse, invoice…"
          onRowClick={(row) => navigate(`/sales/dc/${row.id}`, { state: { backTo: `${window.location.pathname}${window.location.search}` } })}
          emptyMessage="No dispatch challans found"
          config={{
            title: (row) => row.dc_no || `DC #${row.id}`,
            subtitle: (row) => row.warehouse_name,
            badge: (row) => {
              const s = row.status;
              const map = {
                DRAFT:       { label: 'Draft',     cls: 'bg-slate-100 text-slate-700 border-slate-300' },
                CONFIRMED:   { label: 'Confirmed', cls: 'bg-blue-100 text-blue-800 border-blue-300' },
                DISPATCHED:  { label: 'Dispatched',cls: 'bg-amber-100 text-amber-800 border-amber-300' },
                DELIVERED:   { label: 'Delivered', cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
                CANCELLED:   { label: 'Cancelled', cls: 'bg-red-100 text-red-700 border-red-300' },
              };
              return map[s] || { label: s || '-', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
            },
            fields: (row) => [
              { label: 'Date',      value: fmtDate(row.dispatch_date) },
              { label: 'Transporter', value: row.transporter_name },
              { label: 'Lorry',     value: row.lorry_no },
            ],
            actions: (row) => [
              { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/sales/dc/${row.id}`) },
            ],
          }}
        />

        <div className="hidden sm:block bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
          <DataTable
            exportFileName="dispatch-challans"
            canExport={canExport('Dispatch Challan')}
            exportLineConfig={DC_EXPORT_LINES}
            onExport={async (rows) => {
              try { await exportServerSide('/api/sales/dc/export/', rows, 'dispatch-challans'); }
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
            extraSearchFields={['product_names']}
            searchPlaceholder="Search by DC number, warehouse, invoice or product..."
            onFilterChange={setActiveFilters}
            onRowClick={(row) => navigate(`/sales/dc/${row.id}`, { state: { backTo: `${window.location.pathname}${window.location.search}` } })}
            emptyMessage="No dispatch challans found"
            expandableContent={(row) => <ExpandableLines apiUrl={`/api/sales/dc/${row.id}/`} linesKey="dc_lines" columns={DC_LINE_COLUMNS} />}
            expandAsModal
            expandModalTitle={(row) => `Line Items — ${row.dc_no || 'Dispatch Challan'}`}
          />
        </div>
        </ListState>
      </div>
      {FlowPopup}
    </MainLayout>
  );
}
