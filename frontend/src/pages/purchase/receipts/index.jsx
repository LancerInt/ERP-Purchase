import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import ProductsCell from '../../../components/common/ProductsCell';
import { Pencil, Trash2, Truck, FileText, Users, CheckCircle2, Eye, X, Loader2 } from 'lucide-react';
import MobileListCards from '../components/MobileListCards';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';
import ListState from '@/components/common/ListState.jsx';
import exportToExcel from '../../../utils/exportExcel.js';

const RECEIPT_APPROVE_ROLES = new Set(['admin', 'administrator', 'purchase manager']);

export default function ReceiptAdviceList() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useApiData('/api/purchase/receipts/?slim=1');
  const { data: billsData } = useApiData('/api/purchase/bills/?slim=1');
  const { data: freightData } = useApiData('/api/purchase/freight/?slim=1');
  const { data: wageData } = useApiData('/api/purchase/wage-entries/?slim=1');
  const [searchTerm, setSearchTerm] = useState('');
  const [datePeriod, setDatePeriod] = useState('All');
  const [customRange, setCustomRange] = useState({ from: '', to: '' });
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 13;

  const { isAdmin, isSuperuser, role, canCreate, canEdit, canDelete, canApprove, canExport, canCreateFreight, canCreateBill, canCreateWage } = usePermissions();
  const { isHidden } = useFieldPermissions('Receipt Advice');
  const _roleName = (role?.role_name || role?.name || '').trim().toLowerCase();
  const canApproveReceipt = isAdmin || isSuperuser || canApprove('Receipt Advice') || RECEIPT_APPROVE_ROLES.has(_roleName);
  const canConvertReceiptToBill = canCreateBill('Receipt Advice');
  const canCreateWages = canCreateWage('Receipt Advice');
  const canCreateReceiptFreight = canCreateFreight('Receipt Advice');
  const canEditReceipt = canEdit('Receipt Advice');
  const canDeleteReceipt = canDelete('Receipt Advice');
  const canCreateReceipt = canCreate('Receipt Advice');
  const canExportReceipt = canExport('Receipt Advice');

  // Build map of receipt ID → freight info
  const receiptFreightMap = {};
  (freightData || []).forEach(f => {
    if (f.receipt_advice && f.status !== 'CANCELLED') {
      const existing = receiptFreightMap[f.receipt_advice];
      const freightQty = (existing?.freightQty || 0) + (Number(f.quantity_basis) || 0);
      const totalPaid = (existing?.totalPaid || 0) + (Number(f.total_paid) || 0);
      const totalPayable = (existing?.totalPayable || 0) + (Number(f.payable_amount) || Number(f.total_freight_cost) || 0);
      const isPrepaid = (existing?.isPrepaid || false) || ((f.freight_terms || '').toUpperCase() === 'PAID');
      receiptFreightMap[f.receipt_advice] = {
        status: f.status, freightQty, totalPaid, totalPayable, isPrepaid,
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

  const paidReceiptIds = new Set(
    (billsData || []).filter(b => b.status === 'PAID').map(b => b.receipt_advice)
  );
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

  // Column visibility
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
  const colHidden = (colKey) => {
    if (colKey === 'receipt_advice_no' || colKey === 'actions') return false;
    return isHidden(catalogKeyForColumn(colKey));
  };

  const filteredData = useMemo(() => {
    let result = data || [];

    if (datePeriod !== 'All') {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      let from = null, to = null;
      if (datePeriod === 'Today') { from = today; to = today; }
      else if (datePeriod === 'Week') { from = new Date(today); from.setDate(today.getDate() - today.getDay()); to = today; }
      else if (datePeriod === 'Month') { from = new Date(today.getFullYear(), today.getMonth(), 1); to = today; }
      else if (datePeriod === 'FY') {
        const fyStart = today.getMonth() >= 3 ? new Date(today.getFullYear(), 3, 1) : new Date(today.getFullYear() - 1, 3, 1);
        from = fyStart; to = today;
      } else if (datePeriod === 'Custom') {
        if (customRange.from) from = new Date(customRange.from);
        if (customRange.to) to = new Date(customRange.to);
      }
      if (from || to) {
        result = result.filter(row => {
          if (!row.receipt_date) return false;
          const d = new Date(row.receipt_date);
          if (from && d < from) return false;
          if (to) { const end = new Date(to); end.setDate(end.getDate() + 1); if (d >= end) return false; }
          return true;
        });
      }
    }

    if (statusFilter !== 'ALL') {
      result = result.filter(row => row.receipt_status === statusFilter);
    }

    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      result = result.filter(row =>
        Object.values(row).some(v => v != null && typeof v !== 'object' && String(v).toLowerCase().includes(s))
      );
    }
    return result;
  }, [data, datePeriod, customRange, statusFilter, searchTerm]);

  const totalPages = Math.max(1, Math.ceil(filteredData.length / PAGE_SIZE));
  const pagedData = filteredData.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [filteredData.length]);

  const handleExport = useCallback(() => {
    const rows = filteredData.map(r => ({
      'Receipt No': r.receipt_advice_no,
      'PO No': (r.linked_po_numbers || []).join(', '),
      'Vendor': r.vendor_name,
      'Warehouse': r.warehouse_name,
      'Receipt Date': r.receipt_date ? formatDate(r.receipt_date) : '',
      'Total Qty': r.total_received,
      'Status': r.receipt_status,
    }));
    exportToExcel(rows, null, 'receipt-advices');
  }, [filteredData]);

  const renderPoLinks = (row) => {
    const value = row.linked_po_numbers;
    if (!Array.isArray(value) || value.length === 0) return (value || '-');
    const poIds = Array.isArray(row.linked_pos) ? row.linked_pos : [];
    return value.map((poNo, i) => (
      <span key={i}>{i > 0 && ', '}{poIds[i] ? (
        <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/orders/${poIds[i]}`); }} className="text-primary-600 hover:underline font-medium">{poNo}</button>
      ) : poNo}</span>
    ));
  };

  const renderPrLinks = (row) => {
    const value = row.linked_pr_numbers;
    if (!Array.isArray(value) || value.length === 0) return '-';
    const prIds = Array.isArray(row.linked_pr_ids) ? row.linked_pr_ids : [];
    return value.map((prNo, i) => (
      <span key={i}>{i > 0 && ', '}{prIds[i] ? (
        <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/requests/${prIds[i]}`); }} className="text-primary-600 hover:underline font-medium">{prNo}</button>
      ) : prNo}</span>
    ));
  };

  const thCls = "text-left px-2 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap";

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Receipt Advice"
        subtitle="Manage goods receipt against purchase orders"
        breadcrumbs={[{ label: 'Sourcing' }, { label: 'Receipts' }]}
        actions={{
          ...(canCreateReceipt ? { createLink: '/purchase/receipts/new', createLabel: 'New Receipt' } : {}),
        }}
      />

      {/* Toolbar */}
      <div className="hidden sm:flex items-center gap-2 px-1 py-1.5">
        {['All', 'Today', 'Week', 'Month', 'FY', 'Custom'].map((p) => (
          <button
            key={p}
            onClick={() => setDatePeriod(p)}
            className={`px-3 py-1 text-[12px] font-medium rounded-md border transition ${
              datePeriod === p
                ? 'bg-primary-600 text-white border-primary-600'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {p}
          </button>
        ))}
        {datePeriod === 'Custom' && (
          <>
            <input type="date" value={customRange.from} onChange={(e) => setCustomRange(r => ({ ...r, from: e.target.value }))} className="h-[30px] text-[11px] border border-slate-200 rounded-md px-2 bg-white" />
            <span className="text-[10px] text-slate-400">to</span>
            <input type="date" value={customRange.to} onChange={(e) => setCustomRange(r => ({ ...r, to: e.target.value }))} className="h-[30px] text-[11px] border border-slate-200 rounded-md px-2 bg-white" />
          </>
        )}
        <div className="flex-1" />
        <div className="relative">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search receipts…"
            className="h-[30px] w-[160px] text-[12px] border border-slate-200 rounded-md pl-3 pr-7 bg-white focus:ring-1 focus:ring-primary-400 focus:border-primary-400 placeholder-slate-400"
          />
          {searchTerm && (
            <button onClick={() => setSearchTerm('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600">
              <X size={10} />
            </button>
          )}
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-[32px] border border-slate-200 rounded-md bg-white cursor-pointer pl-3 pr-8"
          style={{ fontSize: 13, fontWeight: 500, color: '#1e293b' }}
        >
          <option value="ALL">Status</option>
          <option value="Full">Full</option>
          <option value="Partial">Partial</option>
          <option value="Completed">Completed</option>
        </select>
        {canExportReceipt && (
          <button onClick={handleExport} className="h-[30px] px-3 text-[11px] font-medium text-slate-600 border border-slate-200 rounded-md hover:bg-slate-50">
            Export
          </button>
        )}
      </div>

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

      {/* Desktop table */}
      <div className="hidden sm:block">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={20} className="animate-spin text-primary-500" />
          </div>
        ) : pagedData.length === 0 ? (
          <div className="text-center py-12 text-slate-400 text-[12px]">No receipt advices found</div>
        ) : (
          <>
            <div className="border border-slate-200 rounded-md overflow-hidden bg-white">
              <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className={thCls}>Receipt No</th>
                    {!colHidden('linked_po_numbers') && <th className={thCls}>PO No</th>}
                    {!colHidden('vendor_name') && <th className={thCls}>Vendor</th>}
                    {!colHidden('product_names') && <th className={thCls} style={{ width: 150 }}>Products</th>}
                    {!colHidden('warehouse_name') && <th className={thCls}>Warehouse</th>}
                    {!colHidden('receipt_date') && <th className={thCls}>Receipt Date</th>}
                    {!colHidden('linked_pr_numbers') && <th className={thCls}>PR No</th>}
                    <th className={thCls}>Total Qty</th>
                    {!colHidden('receipt_status') && <th className={thCls}>Status</th>}
                    <th className={thCls}>Freight</th>
                    <th className={thCls}>Bill</th>
                    <th className={thCls}>Wages</th>
                    <th className={thCls}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedData.map(row => {
                    const isApproved = row.approval_status === 'APPROVED';
                    const freightInfo = receiptFreightMap[row.id];
                    const receiptQty = Number(row.total_received) || 0;
                    const freightQty = freightInfo?.freightQty || 0;
                    const fullyPaid = freightInfo && (
                      freightInfo.isPrepaid ||
                      (freightQty >= receiptQty && freightInfo.totalPayable > 0 && freightInfo.totalPaid >= freightInfo.totalPayable)
                    );
                    const hasFreight = !!freightInfo;
                    const wageStatus = receiptWageMap[row.id];
                    const bill = (billsData || []).find(b => b.receipt_advice === row.id);

                    return (
                      <tr
                        key={row.id}
                        onClick={() => navigate(`/purchase/receipts/${row.id}`)}
                        className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors"
                      >
                        <td className="px-2 py-2 font-semibold text-slate-800">{row.receipt_advice_no}</td>
                        {!colHidden('linked_po_numbers') && <td className="px-2 py-2 text-slate-600">{renderPoLinks(row)}</td>}
                        {!colHidden('vendor_name') && <td className="px-2 py-2 text-slate-600 truncate">{row.vendor_name || '—'}</td>}
                        {!colHidden('product_names') && <td className="px-2 py-2 truncate" style={{ maxWidth: 150 }}><ProductsCell names={row.product_names} /></td>}
                        {!colHidden('warehouse_name') && <td className="px-2 py-2 text-slate-600">{row.warehouse_name || '—'}</td>}
                        {!colHidden('receipt_date') && <td className="px-2 py-2 text-slate-500">{row.receipt_date ? formatDate(row.receipt_date) : '—'}</td>}
                        {!colHidden('linked_pr_numbers') && <td className="px-2 py-2 text-slate-600">{renderPrLinks(row)}</td>}
                        <td className="px-2 py-2 text-slate-700">{row.total_received || '—'}</td>
                        {!colHidden('receipt_status') && <td className="px-2 py-2"><StatusBadge status={row.receipt_status || 'Pending'} /></td>}

                        {/* Freight */}
                        <td className="px-2 py-1.5" onClick={e => e.stopPropagation()}>
                          {fullyPaid ? (
                            <button onClick={() => { if (freightInfo?.freightId) navigate(`/freight/purchase/${freightInfo.freightId}`); }}
                              className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-medium rounded hover:bg-emerald-100"
                              title={freightInfo?.isPrepaid ? 'Freight Terms = Paid' : 'Freight fully paid'}>
                              <Truck size={11} /> Paid
                            </button>
                          ) : hasFreight ? (
                            <button onClick={() => { if (freightInfo?.freightId) navigate(`/freight/purchase/${freightInfo.freightId}`); }}
                              className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-medium rounded hover:bg-blue-100">
                              <Truck size={11} /> Created
                            </button>
                          ) : !isApproved ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-100 text-slate-400 text-[10px] font-medium rounded cursor-not-allowed">
                              <Truck size={11} /> Freight
                            </span>
                          ) : canCreateReceiptFreight ? (
                            <button onClick={() => navigate(`/freight/inward/new?receipt_id=${row.id}`)}
                              className="inline-flex items-center gap-1 px-2 py-0.5 bg-orange-600 text-white text-[10px] font-medium rounded hover:bg-orange-700">
                              <Truck size={11} /> Freight
                            </button>
                          ) : null}
                        </td>

                        {/* Bill */}
                        <td className="px-2 py-1.5" onClick={e => e.stopPropagation()}>
                          {!canConvertReceiptToBill ? null : !isApproved ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-100 text-slate-400 text-[10px] font-medium rounded cursor-not-allowed">
                              <FileText size={11} /> Bill
                            </span>
                          ) : bill?.status === 'PAID' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-100 text-slate-400 text-[10px] font-medium rounded cursor-not-allowed">
                              <FileText size={11} /> Paid
                            </span>
                          ) : bill && ['OPEN', 'PARTIALLY_PAID'].includes(bill.status) ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-100 text-amber-700 text-[10px] font-medium rounded cursor-default">
                              <FileText size={11} /> Awaiting
                            </span>
                          ) : bill ? (
                            <button onClick={() => navigate(`/purchase/bills/${bill.id}`)}
                              className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-100 text-slate-500 text-[10px] font-medium rounded hover:bg-slate-200">
                              <FileText size={11} /> Created
                            </button>
                          ) : (
                            <button onClick={() => navigate(`/purchase/bills/new?receipt_id=${row.id}`)}
                              className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-600 text-white text-[10px] font-medium rounded hover:bg-emerald-700">
                              <FileText size={11} /> Bill
                            </button>
                          )}
                        </td>

                        {/* Wages */}
                        <td className="px-2 py-1.5" onClick={e => e.stopPropagation()}>
                          {!isApproved ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-100 text-slate-400 text-[10px] font-medium rounded cursor-not-allowed">
                              <Users size={11} /> Wages
                            </span>
                          ) : wageStatus === 'CLOSED' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-100 text-slate-400 text-[10px] font-medium rounded cursor-not-allowed">
                              <Users size={11} /> Closed
                            </span>
                          ) : wageStatus ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 text-green-700 text-[10px] font-medium rounded cursor-not-allowed">
                              <Users size={11} /> Created
                            </span>
                          ) : canCreateWages ? (
                            <button onClick={() => navigate(`/freight/wages/new?receipt_id=${row.id}`)}
                              className="inline-flex items-center gap-1 px-2 py-0.5 bg-purple-600 text-white text-[10px] font-medium rounded hover:bg-purple-700">
                              <Users size={11} /> Wages
                            </button>
                          ) : null}
                        </td>

                        {/* Actions */}
                        <td className="px-2 py-1.5">
                          <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                            {isApproved ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-emerald-50 text-emerald-700 text-[10px] font-medium rounded border border-emerald-200">
                                <CheckCircle2 size={11} /> OK
                              </span>
                            ) : canApproveReceipt ? (
                              <button onClick={(e) => handleApprove(e, row)} className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-600 text-white text-[10px] font-medium rounded hover:bg-emerald-700">
                                <CheckCircle2 size={11} /> Approve
                              </button>
                            ) : null}
                            {canEditReceipt && (
                              <button onClick={() => navigate(`/purchase/receipts/${row.id}`)} className="p-1 text-blue-600 hover:bg-blue-50 rounded" title="Edit">
                                <Pencil size={13} />
                              </button>
                            )}
                            {canDeleteReceipt && (
                              <button onClick={(e) => handleDelete(e, row)} className="p-1 text-red-500 hover:bg-red-50 rounded" title="Delete">
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between px-1 py-2 text-[11px] text-slate-500">
              <span>{(page - 1) * PAGE_SIZE + 1}-{Math.min(page * PAGE_SIZE, filteredData.length)} of {filteredData.length}</span>
              <div className="flex items-center gap-1">
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                  const p = totalPages <= 5 ? i + 1 : page <= 3 ? i + 1 : page >= totalPages - 2 ? totalPages - 4 + i : page - 2 + i;
                  return (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      className={`w-7 h-7 rounded text-[11px] font-medium ${p === page ? 'bg-primary-600 text-white' : 'hover:bg-slate-100 text-slate-600'}`}
                    >
                      {p}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
      </ListState>
    </MainLayout>
  );
}
