import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ProductsCell from '../../../components/common/ProductsCell';
import { Pencil, Trash2, Truck, FileText, Users, CheckCircle2, Eye, RefreshCw } from 'lucide-react';
import MobileListCards from '../components/MobileListCards';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import UnifiedFilterPanel, { useUnifiedFilter } from '../components/UnifiedFilterPanel';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';
import ListState from '@/components/common/ListState.jsx';

const RECEIPT_APPROVE_ROLES = new Set(['admin', 'administrator', 'purchase manager']);

const FILTER_FIELDS = [
  { value: 'receipt_advice_no', label: 'Receipt No', type: 'text' },
  { value: 'vendor_name', label: 'Vendor', type: 'text' },
  { value: 'warehouse_name', label: 'Warehouse', type: 'text' },
  { value: 'receipt_date', label: 'Receipt Date', type: 'date' },
  { value: 'qc_status', label: 'QC Status', type: 'select', options: [
    { value: 'PENDING', label: 'Pending' }, { value: 'PASS', label: 'Passed' },
    { value: 'FAIL', label: 'Failed' }, { value: 'HOLD', label: 'On Hold' },
  ]},
  { value: 'receipt_status', label: 'Status', type: 'select', options: [
    { value: 'Full', label: 'Full' }, { value: 'Partial', label: 'Partial' },
    { value: 'Completed', label: 'Completed' },
  ]},
];

export default function ReceiptAdviceList() {
  const navigate = useNavigate();
  // ?slim=1 asks for the ten columns this table renders instead of the whole
  // receipt. The full response was 4,435 KB for 1,848 rows - six nested
  // lists per row that nothing here reads. Every key used below is in the
  // slim field list; adding a column means adding it there too.
  const { data, isLoading, error, refetch } = useApiData('/api/purchase/receipts/?slim=1');
  // ?slim=1 -> id + receipt_advice + status only. Two reasons:
  //  1. this page only asks "does a bill point at this receipt, and is it
  //     paid" - it was pulling ~1.1 MB of full bill rows to read two fields;
  //  2. receipt_advice is NOT in the default list serializer, so the lookups
  //     below always missed and every receipt offered "Create Bill" - even
  //     the ones already billed, which invites a duplicate. The slim feed
  //     carries the field, so the check works again.
  const { data: billsData } = useApiData('/api/purchase/bills/?slim=1');
  const { data: freightData } = useApiData('/api/purchase/freight/?slim=1');
  const { data: wageData } = useApiData('/api/purchase/wage-entries/?slim=1');
  const [showFilters, setShowFilters] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const filter = useUnifiedFilter(FILTER_FIELDS);
  const { isAdmin, isSuperuser, role, canCreate, canEdit, canDelete, canApprove, canExport, canCreateFreight, canCreateBill, canCreateWage } = usePermissions();
  const { isHidden } = useFieldPermissions('Receipt Advice');
  const _roleName = (role?.role_name || role?.name || '').trim().toLowerCase();
  // Approve gate respects the RBAC tick (canApprove on Receipt Advice).
  // The legacy hardcoded role-name fallback is preserved as an additional
  // OR so existing rollouts don't lose access mid-flight.
  const canApproveReceipt = isAdmin || isSuperuser || canApprove('Receipt Advice') || RECEIPT_APPROVE_ROLES.has(_roleName);
  // Each inline conversion button has its own dedicated flag on the
  // Receipt Advice row in the admin grid — admins can grant Bill, Wage
  // and Freight independently of the broader Convert / Create perms.
  const canConvertReceiptToBill = canCreateBill('Receipt Advice');
  const canCreateWages = canCreateWage('Receipt Advice');
  const canCreateReceiptFreight = canCreateFreight('Receipt Advice');
  const canEditReceipt = canEdit('Receipt Advice');
  const canDeleteReceipt = canDelete('Receipt Advice');
  const canCreateReceipt = canCreate('Receipt Advice');
  const canExportReceipt = canExport('Receipt Advice');

  // Build map of receipt ID → freight info (quantity-based comparison).
  // Also remember the first freight's id so the receipt row can link
  // straight to it, and whether ANY linked freight has Terms = Paid
  // (which means "settled at source" — no further payment is needed).
  const receiptFreightMap = {};
  (freightData || []).forEach(f => {
    if (f.receipt_advice && f.status !== 'CANCELLED') {
      const existing = receiptFreightMap[f.receipt_advice];
      const freightQty = (existing?.freightQty || 0) + (Number(f.quantity_basis) || 0);
      const totalPaid = (existing?.totalPaid || 0) + (Number(f.total_paid) || 0);
      const totalPayable = (existing?.totalPayable || 0) + (Number(f.payable_amount) || Number(f.total_freight_cost) || 0);
      const isPrepaid = (existing?.isPrepaid || false) || ((f.freight_terms || '').toUpperCase() === 'PAID');
      receiptFreightMap[f.receipt_advice] = {
        status: f.status,
        freightQty,
        totalPaid,
        totalPayable,
        isPrepaid,
        freightId: existing?.freightId || f.id,
      };
    }
  });

  // Build map of receipt ID → wage entry status
  const receiptWageMap = {};
  (wageData || []).forEach(w => {
    if (w.receipt && w.status !== 'CANCELLED') {
      receiptWageMap[w.receipt] = w.status;
    }
  });

  // Build set of receipt IDs that have a PAID bill
  const paidReceiptIds = new Set(
    (billsData || []).filter(b => b.status === 'PAID').map(b => b.receipt_advice)
  );
  // Build set of receipt IDs that have any bill
  const billedReceiptIds = new Set(
    (billsData || []).filter(b => b.receipt_advice).map(b => b.receipt_advice)
  );

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Are you sure you want to delete ${row.receipt_advice_no}? This action cannot be undone.`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/receipts/${row.id}/`);
      toast.success(`${row.receipt_advice_no} deleted successfully`);
      refetch();
    } catch (err) {
      const msg = err.response?.data?.detail || err.response?.data?.error || 'Failed to delete';
      // If the delete was blocked by the negative-stock guard, offer a force-delete
      // path that bypasses the check (creates negative balances if downstream
      // documents already consumed this stock).
      if (/negative stock|would leave negative/i.test(msg)) {
        const forceMsg =
          `${msg}\n\n` +
          `Force-delete anyway?\n` +
          `This will reverse the receipt even though ${row.receipt_advice_no}'s stock has ` +
          `already been consumed downstream. Your stock ledger will go negative until you ` +
          `also reverse the consuming documents (transfers, sales DCs, adjustments, etc.).`;
        if (!(await confirm({ message: forceMsg, isDangerous: true, confirmLabel: 'Delete' }))) {
          toast.error(msg);
          return;
        }
        try {
          await apiClient.delete(`/api/purchase/receipts/${row.id}/?force=true`);
          toast.success(`${row.receipt_advice_no} force-deleted (ledger may have negative balances)`);
          refetch();
          return;
        } catch (err2) {
          toast.error(err2.response?.data?.detail || err2.response?.data?.error || 'Force delete failed');
          return;
        }
      }
      toast.error(msg);
    }
  };

  const handleApprove = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Approve ${row.receipt_advice_no}? Bill and Wages can only be created after approval.` }))) return;
    try {
      await apiClient.post(`/api/purchase/receipts/${row.id}/approve/`);
      toast.success(`${row.receipt_advice_no} approved`);
      refetch();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to approve');
    }
  };

  const columns = [
    { key: 'receipt_advice_no', label: 'Receipt No', sortable: true },
    { key: 'linked_po_numbers', label: 'PO No', sortable: true,
      render: (value, row) => {
        if (!Array.isArray(value) || value.length === 0) return (value || '-');
        const poIds = Array.isArray(row.linked_pos) ? row.linked_pos : [];
        return value.map((poNo, i) => (
          <span key={i}>{i > 0 && ', '}{poIds[i] ? (
            <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/orders/${poIds[i]}`); }} className="text-primary-600 hover:text-primary-800 hover:underline font-medium">{poNo}</button>
          ) : poNo}</span>
        ));
      },
    },
    { key: 'vendor_name', label: 'Vendor', sortable: true },
    { key: 'product_names', label: 'Products', sortable: false, render: (value) => <ProductsCell names={value} /> },
    { key: 'warehouse_name', label: 'Warehouse', sortable: true },
    {
      key: 'receipt_date', label: 'Receipt Date', sortable: true,
      render: (value) => value ? formatDate(value) : '-',
    },
    { key: 'linked_pr_numbers', label: 'PR No', sortable: false,
      render: (value, row) => {
        if (!Array.isArray(value) || value.length === 0) return '-';
        const prIds = Array.isArray(row.linked_pr_ids) ? row.linked_pr_ids : [];
        return value.map((prNo, i) => (
          <span key={i}>{i > 0 && ', '}{prIds[i] ? (
            <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/requests/${prIds[i]}`); }} className="text-primary-600 hover:text-primary-800 hover:underline font-medium">{prNo}</button>
          ) : prNo}</span>
        ));
      },
    },
    { key: 'total_received', label: 'Total Qty', sortable: true },
    {
      key: 'receipt_status', label: 'Status',
      render: (value) => <StatusBadge status={value || 'Pending'} />,
    },
    {
      key: 'freight', label: '', sortable: false,
      render: (_, row) => {
        const isApproved = row.approval_status === 'APPROVED';
        const freightInfo = receiptFreightMap[row.id];
        const receiptQty = Number(row.total_received) || 0;
        const freightQty = freightInfo?.freightQty || 0;
        // Treat the freight as "done" if EITHER it's fully paid in money
        // OR Freight Terms = Paid (settled at source). The earlier check
        // missed the prepaid case because totalPaid is 0 by definition.
        const fullyPaid =
          freightInfo && (
            freightInfo.isPrepaid ||
            (freightQty >= receiptQty && freightInfo.totalPayable > 0 && freightInfo.totalPaid >= freightInfo.totalPayable)
          );
        // ANY existing non-cancelled freight against this receipt blocks
        // creating another one — clicking takes the user to the freight.
        const hasFreight = !!freightInfo;
        return (
        <div className="flex items-center gap-1.5">
          {fullyPaid ? (
            <button
              onClick={(e) => { e.stopPropagation(); if (freightInfo?.freightId) navigate(`/freight/purchase/${freightInfo.freightId}`); }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-medium rounded-lg hover:bg-emerald-100"
              title={freightInfo?.isPrepaid ? 'Freight Terms = Paid (settled at source)' : 'Freight fully paid'}
            >
              <Truck size={13} /> Freight Paid
            </button>
          ) : hasFreight ? (
            <button
              onClick={(e) => { e.stopPropagation(); if (freightInfo?.freightId) navigate(`/freight/purchase/${freightInfo.freightId}`); }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 text-blue-700 border border-blue-200 text-xs font-medium rounded-lg hover:bg-blue-100"
              title="Freight already created — click to view"
            >
              <Truck size={13} /> Freight Created
            </button>
          ) : !isApproved ? (
            <span
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 text-slate-400 text-xs font-medium rounded-lg cursor-not-allowed"
              title="Approve receipt to enable"
            >
              <Truck size={13} /> Freight
            </span>
          ) : canCreateReceiptFreight ? (
            <button onClick={(e) => { e.stopPropagation(); navigate(`/freight/inward/new?receipt_id=${row.id}`); }} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-orange-600 text-white text-xs font-medium rounded-lg hover:bg-orange-700 transition">
              <Truck size={13} /> Freight
            </button>
          ) : null}
          {(() => {
            if (!canConvertReceiptToBill) return null;
            if (!isApproved) {
              return (
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 text-slate-400 text-xs font-medium rounded-lg cursor-not-allowed" title="Approve receipt to enable">
                  <FileText size={13} /> Bill
                </span>
              );
            }
            const bill = (billsData || []).find(b => b.receipt_advice === row.id);
            if (bill?.status === 'PAID') {
              return (
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 text-slate-400 text-xs font-medium rounded-lg cursor-not-allowed">
                  <FileText size={13} />
                  Paid
                </span>
              );
            }
            if (bill && ['OPEN', 'PARTIALLY_PAID'].includes(bill.status)) {
              return (
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-100 text-amber-700 text-xs font-medium rounded-lg cursor-default">
                  <FileText size={13} />
                  Awaiting Payment
                </span>
              );
            }
            // A bill ALREADY exists (e.g. still DRAFT) — don't offer to create
            // another. Show a disabled "Bill Created" chip that opens the bill.
            if (bill) {
              return (
                <button type="button" onClick={(e) => { e.stopPropagation(); navigate(`/purchase/bills/${bill.id}`); }}
                  title="A bill has already been created for this receipt — click to open it"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 text-slate-500 text-xs font-medium rounded-lg hover:bg-slate-200 transition">
                  <FileText size={13} />
                  Bill Created
                </button>
              );
            }
            return (
              <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/bills/new?receipt_id=${row.id}`); }} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white text-xs font-medium rounded-lg hover:bg-emerald-700 transition">
                <FileText size={13} />
                Bill
              </button>
            );
          })()}
        </div>
        ); },
    },
    {
      key: 'wages', label: '', sortable: false,
      render: (_, row) => {
        const isApproved = row.approval_status === 'APPROVED';
        if (!isApproved) {
          return (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 text-slate-400 text-xs font-medium rounded-lg cursor-not-allowed" title="Approve receipt to enable">
              <Users size={13} /> Wages
            </span>
          );
        }
        const wageStatus = receiptWageMap[row.id];
        if (wageStatus === 'CLOSED') {
          return <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 text-slate-400 text-xs font-medium rounded-lg cursor-not-allowed"><Users size={13} /> Wages Closed</span>;
        }
        if (wageStatus) {
          return <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-green-100 text-green-700 text-xs font-medium rounded-lg cursor-not-allowed"><Users size={13} /> Wages Created</span>;
        }
        if (!canCreateWages) return null;
        return (
          <button onClick={(e) => { e.stopPropagation(); navigate(`/freight/wages/new?receipt_id=${row.id}`); }} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 text-white text-xs font-medium rounded-lg hover:bg-purple-700 transition">
            <Users size={13} /> Wages
          </button>
        );
      },
    },
    {
      key: 'actions', label: '', sortable: false,
      render: (_, row) => {
        const isApproved = row.approval_status === 'APPROVED';
        return (
          <div className="flex items-center gap-1">
            {isApproved ? (
              <span className="inline-flex items-center gap-1 px-2 py-1 bg-emerald-50 text-emerald-700 text-xs font-medium rounded border border-emerald-200" title="Approved">
                <CheckCircle2 size={13} /> Approved
              </span>
            ) : canApproveReceipt ? (
              <button onClick={(e) => handleApprove(e, row)} className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-600 text-white text-xs font-medium rounded hover:bg-emerald-700 transition" title="Approve receipt">
                <CheckCircle2 size={13} /> Approve
              </button>
            ) : null}
            {canEditReceipt && (
              <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/receipts/${row.id}`); }} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition" title="Edit">
                <Pencil size={15} />
              </button>
            )}
            {canDeleteReceipt && (
              <button onClick={(e) => handleDelete(e, row)} className="p-1.5 text-red-500 hover:bg-red-50 rounded transition" title="Delete">
                <Trash2 size={15} />
              </button>
            )}
          </div>
        );
      },
    },
  ];

  // Drop any column that maps to a HIDDEN field for this user's role.
  // Derive the catalog key by stripping a trailing _name/_code/_display
  // when that yields a known catalog key (e.g. vendor_name -> vendor),
  // else use the column key as-is. The primary identifier/link column
  // (receipt_advice_no), the actions column, and any non-catalog key
  // are always kept.
  const NEVER_HIDE_COLS = new Set(['receipt_advice_no', 'actions']);
  const RECEIPT_CATALOG_KEYS = new Set([
    'receipt_advice_no', 'receipt_date', 'vendor', 'warehouse', 'godown',
    'vehicle_number', 'driver_name', 'driver_phone', 'qc_routing', 'qc_status',
    'approval_status', 'advance_amount', 'freight_value', 'freight_terms',
    'invoice_no', 'invoice_date', 'invoice_amount', 'remarks',
  ]);
  const catalogKeyForColumn = (key) => {
    for (const suffix of ['_name', '_code', '_display']) {
      if (key.endsWith(suffix)) {
        const base = key.slice(0, -suffix.length);
        if (RECEIPT_CATALOG_KEYS.has(base)) return base;
      }
    }
    return key;
  };
  const visibleColumns = columns.filter((c) => {
    if (NEVER_HIDE_COLS.has(c.key)) return true;
    return !isHidden(catalogKeyForColumn(c.key));
  });

  const filteredData = (() => {
    let result = filter.filterData(data || []);
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      result = result.filter(row =>
        Object.values(row).some(v => v != null && typeof v !== 'object' && String(v).toLowerCase().includes(s))
      );
    }
    return result;
  })();

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Receipt Advice"
        subtitle="Manage goods receipt against purchase orders"
        breadcrumbs={[{ label: 'Sourcing' }, { label: 'Receipts' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreateReceipt ? { createLink: '/purchase/receipts/new', createLabel: 'New Receipt' } : {}),
        }}
      />
      <UnifiedFilterPanel filterFields={FILTER_FIELDS} filter={filter} showFilters={showFilters} onClose={() => setShowFilters(false)} />
      <ListState error={error} onRetry={refetch}>
      <MobileListCards
        rows={filteredData}
        isLoading={isLoading}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search receipt no, vendor, PO…"
        emptyMessage="No receipt advices found"
        config={{
          title: (row) => row.receipt_advice_no,
          subtitle: (row) => row.vendor_name,
          badge: (row) => ({ label: row.receipt_status || 'Pending', cls: row.receipt_status === 'Received' ? 'bg-emerald-100 text-emerald-700 border-emerald-300' : 'bg-amber-100 text-amber-700 border-amber-300' }),
          fields: (row) => [
            { label: 'Date',      value: formatDate(row.receipt_date) },
            { label: 'Warehouse', value: row.warehouse_name },
            { label: 'POs',       value: (row.linked_po_numbers || []).join(', ') || null },
            { label: 'Qty',       value: row.total_received },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/purchase/receipts/${row.id}`) },
          ],
        }}
        onRowClick={(row) => navigate(`/purchase/receipts/${row.id}`)}
      />
      <div className="hidden sm:block">
        <DataTable persistKey="purchase-receipts" exportFileName="receipt-advices" canExport={canExport('Receipt Advice')} columns={visibleColumns} data={filteredData} isLoading={isLoading} onRowClick={(row) => navigate(`/purchase/receipts/${row.id}`)} />
      </div>
      </ListState>
    </MainLayout>
  );
}
