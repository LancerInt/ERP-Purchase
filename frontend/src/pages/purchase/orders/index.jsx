import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ProductsCell from '../../../components/common/ProductsCell';
import { Eye, Pencil, PackageCheck, Trash2, RefreshCw, MailCheck, Mail } from 'lucide-react';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import FilterPanel, { matchesSelect } from '@/components/common/FilterPanel';
import MobileListCards from '../components/MobileListCards';
import ListState from '@/components/common/ListState.jsx';
import { confirm } from '@/components/common/confirm';
import { formatDate, formatCurrency } from '@/utils/formatters';
import { useUrlFilters } from '../../../hooks/useUrlState.js';

const FILTER_FIELDS = [
  { value: 'po_no', label: 'PO Number', type: 'text' },
  { value: 'vendor_name', label: 'Vendor', type: 'text' },
  { value: 'company_name', label: 'Company', type: 'text' },
  { value: 'warehouse_name', label: 'Warehouse', type: 'text' },
  { value: 'po_date', label: 'PO Date', type: 'date' },
  { value: 'status', label: 'Status', type: 'select', options: [
    { value: 'DRAFT', label: 'Draft' }, { value: 'APPROVED', label: 'Approved' },
    { value: 'ISSUED', label: 'Issued' }, { value: 'CLOSED', label: 'Closed' },
    { value: 'CANCELLED', label: 'Cancelled' }, { value: 'SPLIT', label: 'Split' },
  ]},
];

export default function PurchaseOrderList() {
  const navigate = useNavigate();
  // ?slim=1 -> the list columns only. The full PO carries po_lines (the line
  // items of every PO) - 347 KB of a 761 KB page, 46% of it - plus the
  // printable-PO document fields. This table shows PO headers and reads
  // none of that. Opt-in, so the detail/create paths are untouched.
  const { data, isLoading, error, refetch } = useApiData('/api/purchase/orders/?slim=1');
  const { canCreate, canEdit, canDelete, canExport } = usePermissions();
  const { isHidden } = useFieldPermissions('Purchase Order');
  const [showFilters, setShowFilters] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  // Filters live in the URL so Back / refresh / sharing restore the filtered
  // view (and a PO opened from here returns to it on Back).
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    po_no: '', vendor_name: '', company_name: '', warehouse_name: '', po_date: '', status: '',
  });
  // Simple-mode dropdown filters (replaces the field/operator/value rule
  // builder). Enum fields keep their fixed options; free-text fields
  // (PO no, vendor, company, warehouse) become multi-select dropdowns
  // populated from the loaded data.
  const filters = useMemo(() => {
    const distinct = (key) => [...new Set((data || []).map((r) => r[key]).filter((v) => v != null && v !== ''))]
      .sort().map((v) => ({ value: String(v), label: String(v) }));
    return FILTER_FIELDS.map((f) =>
      f.type === 'select' ? { key: f.value, label: f.label, type: 'select', options: f.options }
      : f.type === 'date' ? { key: f.value, label: f.label, type: 'date' }
      : { key: f.value, label: f.label, type: 'select', options: distinct(f.value) }
    );
  }, [data]);

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Are you sure you want to delete ${row.po_no}? This action cannot be undone.`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/orders/${row.id}/`);
      toast.success(`${row.po_no} deleted successfully`);
      refetch();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to delete');
    }
  };

  const columns = [
    { key: 'po_no', label: 'PO Number', sortable: true },
    { key: 'linked_pr_numbers', label: 'PR No', sortable: false, render: (value, row) => {
      if (!Array.isArray(value) || value.length === 0) return '-';
      const prIds = Array.isArray(row.linked_prs) ? row.linked_prs : [];
      return value.map((prNo, i) => (
        <span key={i}>{i > 0 && ', '}{prIds[i] ? (
          <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/requests/${prIds[i]}`); }} className="text-primary-600 hover:text-primary-800 hover:underline font-medium">{prNo}</button>
        ) : prNo}</span>
      ));
    }},
    { key: 'product_names', label: 'Products', sortable: false, render: (value) => <ProductsCell names={value} /> },
    { key: 'vendor_name', label: 'Vendor', sortable: true },
    { key: 'company_name', label: 'Company', sortable: true },
    { key: 'warehouse_name', label: 'Warehouse', sortable: true },
    { key: 'po_date', label: 'PO Date', sortable: true, render: (value) => value ? formatDate(value) : '-' },
    { key: 'total_order_value', label: 'Amount', sortable: true, render: (value) => value ? formatCurrency(value) : '₹0' },
    { key: 'fulfillment_status', label: 'Status', sortable: true, render: (_value, row) => <StatusBadge status={row.fulfillment_status || row.status} /> },
    { key: 'email_sent', label: 'Mail', sortable: true, render: (value) => value ? (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-100 text-emerald-700 border border-emerald-200 rounded text-xs font-medium">
        <MailCheck size={12} /> Sent
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-100 text-slate-500 border border-slate-200 rounded text-xs font-medium">
        <Mail size={12} /> Not sent
      </span>
    ) },
    {
      key: 'receipt', label: '', sortable: false,
      // Receipt button gating:
      //   - PO must be APPROVED / ISSUED (and not fully received).
      //   - email_sent gate prevents starting a receipt against a PO
      //     the vendor hasn't seen yet — but once any receipt has been
      //     raised (fulfillment_status === 'PARTIALLY_RECEIVED'), the
      //     vendor has clearly already shipped, so don't keep blocking
      //     follow-up receipts on the email flag.
      render: (_, row) => {
        const inProgress = row.status === 'APPROVED' || row.status === 'ISSUED';
        const startedReceiving = row.fulfillment_status === 'PARTIALLY_RECEIVED';
        if (canCreate('Receipt Advice') && inProgress && !row.is_fully_received && (row.email_sent || startedReceiving)) {
          return (
            <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/receipts/new?po_id=${row.id}`); }} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white text-xs font-medium rounded-lg hover:bg-indigo-700 transition">
              <PackageCheck size={13} />
              Receipt
            </button>
          );
        }
        return null;
      },
    },
    {
      key: 'actions', label: '', sortable: false,
      render: (_, row) => (
        <div className="flex items-center gap-1">
          {canEdit('Purchase Order') && (
            <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/orders/${row.id}`); }} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition" title="Edit">
              <Pencil size={15} />
            </button>
          )}
          {canDelete('Purchase Order') && (
            <button onClick={(e) => handleDelete(e, row)} className="p-1.5 text-red-500 hover:bg-red-50 rounded transition" title="Delete">
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ),
    },
  ];

  // Drop columns that map to a HIDDEN 'Purchase Order' field. Derive the
  // catalog key from each column's key: strip a trailing _name/_code/_display
  // if that yields a catalog key, else use the key as-is. Never drop the
  // actions column or the primary identifier (po_no).
  const PO_CATALOG_KEYS = new Set([
    'po_no', 'vendor', 'company', 'warehouse', 'linked_rfq', 'linked_prs',
    'po_date', 'expected_delivery_start', 'expected_delivery_end',
    'freight_terms', 'payment_terms', 'currency', 'broker_name',
    'terms_and_conditions', 'status',
  ]);
  const PROTECTED_COLUMN_KEYS = new Set(['actions', 'po_no']);
  const deriveCatalogKey = (colKey) => {
    if (PO_CATALOG_KEYS.has(colKey)) return colKey;
    const stripped = colKey.replace(/_(name|code|display)$/, '');
    if (stripped !== colKey && PO_CATALOG_KEYS.has(stripped)) return stripped;
    return null;
  };
  const visibleColumns = columns.filter((col) => {
    if (PROTECTED_COLUMN_KEYS.has(col.key)) return true;
    const catalogKey = deriveCatalogKey(col.key);
    if (!catalogKey) return true;
    return !isHidden(catalogKey);
  });

  const filteredData = (() => {
    let result = (data || []).filter((row) =>
      filters.every((f) => {
        const sel = filterValues[f.key];
        if (f.type === 'date') return !sel || String(row[f.key] || '').slice(0, 10) === String(sel).slice(0, 10);
        return matchesSelect(row[f.key], sel);
      })
    );
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      result = result.filter(row =>
        Object.values(row).some(v => v != null && typeof v !== 'object' && String(v).toLowerCase().includes(s))
      );
    }
    // Reverse-chronological — newest first (latest PO on page 1). Fall
    // back to po_no when po_date ties so same-day POs stay in a clean
    // 00051, 00050, 00049… sequence instead of a jumbled order.
    result = [...result].sort((a, b) => {
      const da = new Date(a.po_date || 0).getTime();
      const db = new Date(b.po_date || 0).getTime();
      if (db !== da) return db - da;
      return String(b.po_no || '').localeCompare(String(a.po_no || ''));
    });
    return result;
  })();

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Purchase Orders"
        subtitle="Manage all purchase orders"
        breadcrumbs={[{ label: 'Sourcing' }, { label: 'Orders (PO)' }]}
        actions={{
          ...(canCreate('Purchase Order') ? { createLink: '/purchase/orders/new', createLabel: 'New PO' } : {}),
          onFilter: () => setShowFilters(!showFilters),
        }}
      />
      {showFilters && (
        <FilterPanel
          filters={filters}
          values={filterValues}
          onChange={(key, value) => setFilterValue(key, value)}
          onReset={clearFilters}
          onClose={() => setShowFilters(false)}
        />
      )}

      <ListState error={error} onRetry={refetch}>
      {/* Mobile card list — same shape as Sales lists. The desktop
          DataTable below is hidden on phones to avoid the horizontal
          scroll that made columns like Vendor / Amount / Status hard
          to scan on a narrow viewport. */}
      <MobileListCards
        rows={filteredData}
        isLoading={isLoading}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search PO no, vendor, warehouse…"
        emptyMessage="No purchase orders found"
        config={{
          title: (row) => row.po_no,
          subtitle: (row) => row.vendor_name,
          badge: (row) => {
            const status = row.fulfillment_status || row.status;
            const map = {
              DRAFT:     { label: 'Draft',     cls: 'bg-slate-100 text-slate-700 border-slate-200' },
              APPROVED:  { label: 'Approved',  cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
              ISSUED:    { label: 'Issued',    cls: 'bg-blue-100 text-blue-800 border-blue-300' },
              PARTIAL:   { label: 'Partial',   cls: 'bg-amber-100 text-amber-800 border-amber-300' },
              CLOSED:    { label: 'Closed',    cls: 'bg-slate-200 text-slate-700 border-slate-300' },
              CANCELLED: { label: 'Cancelled', cls: 'bg-red-100 text-red-700 border-red-300' },
              // Split — distinct from Cancelled. Purple for visual
              // separation; obligation lives on the child DRAFT POs.
              SPLIT:     { label: 'Split',     cls: 'bg-purple-100 text-purple-800 border-purple-300' },
            };
            return map[status] || { label: status || '-', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
          },
          fields: (row) => [
            { label: 'Date',     value: row.po_date ? formatDate(row.po_date) : null },
            { label: 'Company',  value: row.company_name },
            { label: 'Warehouse', value: row.warehouse_name },
            { label: 'Amount',   value: row.total_order_value != null ? formatCurrency(row.total_order_value) : null, cls: 'text-slate-800 font-medium' },
            { label: 'Mail',     value: row.email_sent ? 'Sent' : 'Not sent', cls: row.email_sent ? 'text-emerald-700 font-medium' : 'text-slate-400' },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/purchase/orders/${row.id}`) },
            {
              icon: PackageCheck,
              label: 'Receipt',
              cls: 'text-indigo-700 hover:bg-indigo-50',
              hidden: !(canCreate('Receipt Advice') && (row.status === 'APPROVED' || row.status === 'ISSUED') && !row.is_fully_received && (row.email_sent || row.fulfillment_status === 'PARTIALLY_RECEIVED')),
              onClick: () => navigate(`/purchase/receipts/new?po_id=${row.id}`),
            },
          ],
        }}
        onRowClick={(row) => navigate(`/purchase/orders/${row.id}`)}
      />

      <div className="hidden sm:block">
        <DataTable isLoading={isLoading} exportFileName="purchase-orders" columns={visibleColumns} data={filteredData} onRowClick={(row) => navigate(`/purchase/orders/${row.id}`)} searchable exportable pagination canExport={canExport('Purchase Order')} persistKey="purchase-orders" />
      </div>
      </ListState>
    </MainLayout>
  );
}
