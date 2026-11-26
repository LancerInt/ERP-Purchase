import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import ProductsCell from '../../../components/common/ProductsCell';
import { Eye, Pencil, PackageCheck, Trash2, MailCheck, Mail, X, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import MobileListCards from '../components/MobileListCards';
import ListState from '@/components/common/ListState.jsx';
import { confirm } from '@/components/common/confirm';
import { formatDate, formatCurrency } from '@/utils/formatters';
import exportToExcel from '../../../utils/exportExcel.js';

export default function PurchaseOrderList() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useApiData('/api/purchase/orders/?slim=1');
  const { canCreate, canEdit, canDelete, canExport } = usePermissions();
  const { isHidden } = useFieldPermissions('Purchase Order');
  const [searchTerm, setSearchTerm] = useState('');
  const [datePeriod, setDatePeriod] = useState('All');
  const [customRange, setCustomRange] = useState({ from: '', to: '' });
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 17;

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

  const PO_CATALOG_KEYS = new Set([
    'po_no', 'vendor', 'company', 'warehouse', 'linked_rfq', 'linked_prs',
    'po_date', 'expected_delivery_start', 'expected_delivery_end',
    'freight_terms', 'payment_terms', 'currency', 'broker_name',
    'terms_and_conditions', 'status',
  ]);
  const deriveCatalogKey = (colKey) => {
    if (PO_CATALOG_KEYS.has(colKey)) return colKey;
    const stripped = colKey.replace(/_(name|code|display)$/, '');
    if (stripped !== colKey && PO_CATALOG_KEYS.has(stripped)) return stripped;
    return null;
  };
  const colHidden = (colKey) => {
    if (colKey === 'po_no' || colKey === 'actions' || colKey === 'receipt') return false;
    const ck = deriveCatalogKey(colKey);
    return ck ? isHidden(ck) : false;
  };

  const filteredData = useMemo(() => {
    let result = [...(data || [])];
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
          if (!row.po_date) return false;
          const d = new Date(row.po_date);
          if (from && d < from) return false;
          if (to) { const end = new Date(to); end.setDate(end.getDate() + 1); if (d >= end) return false; }
          return true;
        });
      }
    }
    if (statusFilter !== 'ALL') {
      result = result.filter(row => (row.fulfillment_status || row.status) === statusFilter);
    }
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      result = result.filter(row =>
        Object.values(row).some(v => v != null && typeof v !== 'object' && String(v).toLowerCase().includes(s))
      );
    }
    result.sort((a, b) => {
      const da = new Date(a.po_date || 0).getTime();
      const db = new Date(b.po_date || 0).getTime();
      if (db !== da) return db - da;
      return String(b.po_no || '').localeCompare(String(a.po_no || ''));
    });
    return result;
  }, [data, datePeriod, customRange, statusFilter, searchTerm]);

  const totalPages = Math.max(1, Math.ceil(filteredData.length / PAGE_SIZE));
  const pagedData = filteredData.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [filteredData.length]);

  const handleExport = useCallback(() => {
    const rows = filteredData.map(r => ({
      'PO Number': r.po_no,
      'PR No': (r.linked_pr_numbers || []).join(', '),
      'Vendor': r.vendor_name,
      'Company': r.company_name,
      'Warehouse': r.warehouse_name,
      'PO Date': r.po_date ? formatDate(r.po_date) : '',
      'Amount': r.total_order_value || 0,
      'Status': r.fulfillment_status || r.status,
      'Mail': r.email_sent ? 'Sent' : 'Not sent',
    }));
    exportToExcel(rows, null, 'purchase-orders');
  }, [filteredData]);

  const renderPrLinks = (row) => {
    const value = row.linked_pr_numbers;
    if (!Array.isArray(value) || value.length === 0) return '-';
    const prIds = Array.isArray(row.linked_prs) ? row.linked_prs : [];
    return value.map((prNo, i) => (
      <span key={i}>{i > 0 && ', '}{prIds[i] ? (
        <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/requests/${prIds[i]}`); }} className="text-primary-600 hover:text-primary-800 hover:underline font-medium">{prNo}</button>
      ) : prNo}</span>
    ));
  };

  const thCls = "text-left px-2 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap";

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Purchase Orders"
        subtitle="Manage all purchase orders"
        breadcrumbs={[{ label: 'Sourcing' }, { label: 'Orders (PO)' }]}
        actions={{
          ...(canCreate('Purchase Order') ? { createLink: '/purchase/orders/new', createLabel: 'New PO' } : {}),
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
            placeholder="Search POs…"
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
          <option value="DRAFT">Draft</option>
          <option value="APPROVED">Approved</option>
          <option value="ISSUED">Issued</option>
          <option value="PARTIALLY_RECEIVED">Partial</option>
          <option value="RECEIVED">Received</option>
          <option value="CLOSED">Closed</option>
          <option value="CANCELLED">Cancelled</option>
          <option value="SPLIT">Split</option>
        </select>
        {canExport('Purchase Order') && (
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
        searchPlaceholder="Search PO no, vendor, warehouse…"
        emptyMessage="No purchase orders found"
        config={{
          title: (row) => row.po_no,
          subtitle: (row) => row.vendor_name,
          meta: (row) => row.po_date ? formatDate(row.po_date) : null,
          badge: (row) => {
            const status = row.fulfillment_status || row.status;
            const map = {
              DRAFT:     { label: 'Draft',     cls: 'bg-slate-100 text-slate-700 border-slate-200' },
              APPROVED:  { label: 'Approved',  cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
              ISSUED:    { label: 'Issued',    cls: 'bg-blue-100 text-blue-800 border-blue-300' },
              PARTIAL:   { label: 'Partial',   cls: 'bg-amber-100 text-amber-800 border-amber-300' },
              CLOSED:    { label: 'Closed',    cls: 'bg-slate-200 text-slate-700 border-slate-300' },
              CANCELLED: { label: 'Cancelled', cls: 'bg-red-100 text-red-700 border-red-300' },
              SPLIT:     { label: 'Split',     cls: 'bg-purple-100 text-purple-800 border-purple-300' },
            };
            return map[status] || { label: status || '-', cls: 'bg-slate-100 text-slate-600 border-slate-200' };
          },
          fields: (row) => [
            { label: 'Company',   value: row.company_name },
            { label: 'Warehouse', value: row.warehouse_name },
            { label: 'Amount',    value: row.total_order_value != null ? formatCurrency(row.total_order_value) : null, cls: 'text-slate-800 font-medium' },
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

      {/* Desktop table */}
      <div className="hidden sm:block">
        <div className="border border-slate-200 rounded-md overflow-hidden bg-white">
          <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className={thCls}>PO Number</th>
                {!colHidden('linked_pr_numbers') && <th className={thCls}>PR No</th>}
                {!colHidden('product_names') && <th className={thCls} style={{ width: 160 }}>Products</th>}
                {!colHidden('vendor_name') && <th className={thCls}>Vendor</th>}
                {!colHidden('company_name') && <th className={thCls}>Company</th>}
                {!colHidden('warehouse_name') && <th className={thCls}>Warehouse</th>}
                {!colHidden('po_date') && <th className={thCls}>PO Date</th>}
                {!colHidden('total_order_value') && <th className={thCls}>Amount</th>}
                {!colHidden('fulfillment_status') && <th className={thCls}>Status</th>}
                {!colHidden('email_sent') && <th className={thCls}>Mail</th>}
                <th className={thCls}></th>
                <th className={thCls}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={12} className="text-center py-8"><Loader2 size={20} className="animate-spin text-primary-500 inline" /></td></tr>
              ) : pagedData.length === 0 ? (
                <tr><td colSpan={12} className="text-center py-8 text-slate-400 text-[12px]">No purchase orders found</td></tr>
              ) : pagedData.map(row => {
                const inProgress = row.status === 'APPROVED' || row.status === 'ISSUED';
                const startedReceiving = row.fulfillment_status === 'PARTIALLY_RECEIVED';
                return (
                  <tr
                    key={row.id}
                    onClick={() => navigate(`/purchase/orders/${row.id}`)}
                    className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors"
                  >
                    <td className="px-2 py-2 font-semibold text-slate-800">{row.po_no}</td>
                    {!colHidden('linked_pr_numbers') && <td className="px-2 py-2">{renderPrLinks(row)}</td>}
                    {!colHidden('product_names') && <td className="px-2 py-2 truncate" style={{ maxWidth: 160 }}><ProductsCell names={row.product_names} /></td>}
                    {!colHidden('vendor_name') && <td className="px-2 py-2 text-slate-600 truncate">{row.vendor_name || '—'}</td>}
                    {!colHidden('company_name') && <td className="px-2 py-2 text-slate-600 truncate">{row.company_name || '—'}</td>}
                    {!colHidden('warehouse_name') && <td className="px-2 py-2 text-slate-600 truncate">{row.warehouse_name || '—'}</td>}
                    {!colHidden('po_date') && <td className="px-2 py-2 text-slate-500">{row.po_date ? formatDate(row.po_date) : '—'}</td>}
                    {!colHidden('total_order_value') && <td className="px-2 py-2 text-slate-700 font-medium">{row.total_order_value ? formatCurrency(row.total_order_value) : '₹0'}</td>}
                    {!colHidden('fulfillment_status') && <td className="px-2 py-2"><StatusBadge status={row.fulfillment_status || row.status} /></td>}
                    {!colHidden('email_sent') && (
                      <td className="px-2 py-2">
                        {row.email_sent ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-emerald-100 text-emerald-700 border border-emerald-200 rounded text-[10px] font-medium">
                            <MailCheck size={11} /> Sent
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-slate-100 text-slate-500 border border-slate-200 rounded text-[10px] font-medium">
                            <Mail size={11} /> Not sent
                          </span>
                        )}
                      </td>
                    )}
                    <td className="px-2 py-1.5" onClick={e => e.stopPropagation()}>
                      {canCreate('Receipt Advice') && inProgress && !row.is_fully_received && (row.email_sent || startedReceiving) ? (
                        <button onClick={() => navigate(`/purchase/receipts/new?po_id=${row.id}`)} className="inline-flex items-center gap-1 px-2 py-1 bg-indigo-600 text-white text-[11px] font-medium rounded-md hover:bg-indigo-700 transition">
                          <PackageCheck size={12} /> Receipt
                        </button>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                        {canEdit('Purchase Order') && (
                          <button onClick={() => navigate(`/purchase/orders/${row.id}`)} className="p-1 text-blue-600 hover:bg-blue-50 rounded transition" title="Edit">
                            <Pencil size={14} />
                          </button>
                        )}
                        {canDelete('Purchase Order') && (
                          <button onClick={(e) => handleDelete(e, row)} className="p-1 text-red-500 hover:bg-red-50 rounded transition" title="Delete">
                            <Trash2 size={14} />
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
        {filteredData.length > 0 && (
          <div className="flex items-center justify-between px-1 py-2 text-[11px] text-slate-500">
            <span>{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filteredData.length)} of {filteredData.length}</span>
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
        )}
      </div>
      </ListState>
    </MainLayout>
  );
}
