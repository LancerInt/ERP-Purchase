import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import { useUrlState } from '../../../hooks/useUrlState.js';
import apiClient from '../../../utils/api.js';
import toast from 'react-hot-toast';
import { Trash2, Eye, IndianRupee, Clock, CheckCircle, ArrowDownLeft, ArrowUpRight, Paperclip, X } from 'lucide-react';
import MobileListCards from '../components/MobileListCards';
import { confirm } from '@/components/common/confirm';
import { formatDate, formatCurrency } from '@/utils/formatters';

const fmt = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtDate = (d) => d ? formatDate(d) : '-';

export default function FreightPaymentList() {
  const navigate = useNavigate();
  const { canCreate, canDelete, canExport } = usePermissions();
  // Field-level column visibility for the Freight Payment list.
  const { isHidden } = useFieldPermissions('Freight Payment');
  const [purchasePayments, setPurchasePayments] = useState([]);
  const [salesPayments, setSalesPayments] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  // Domain filters live in the URL so Back / refresh / sharing restore them.
  const [typeFilter, setTypeFilter] = useUrlState('type', '');
  const [modeFilter, setModeFilter] = useUrlState('mode', '');
  // Standard period navigator (All / Today / Week / Month / FY / Custom).
  const period = usePeriodFilter('all');
  const [search, setSearch] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const [pendingFreight, setPendingFreight] = useState([]);
  // Map: freight_id -> array of attachments (combined freight + receipt)
  const [attachmentsByFreight, setAttachmentsByFreight] = useState({});
  // Modal state
  const [attachmentModal, setAttachmentModal] = useState(null); // { freightNo, files }

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const [pRes, sRes, fRes] = await Promise.all([
        apiClient.get('/api/purchase/freight-payments/').catch(() => ({ data: [] })),
        apiClient.get('/api/sales/freight-payments/').catch(() => ({ data: [] })),
        apiClient.get('/api/purchase/freight/').catch(() => ({ data: [] })),
      ]);
      setPurchasePayments(pRes.data?.results || pRes.data || []);
      setSalesPayments(sRes.data?.results || sRes.data || []);
      // Filter freight that is approved but not fully paid. Skip
      // freights with Freight Terms = 'PAID' — those were settled at
      // source (no payment is recorded here, no "Pay" CTA should show).
      const allFreight = fRes.data?.results || fRes.data || [];
      const waiting = allFreight.filter(f =>
        ['APPROVED', 'IN_TRANSIT', 'COMPLETED'].includes(f.status) &&
        (f.freight_terms || '').toUpperCase() !== 'PAID' &&
        (Number(f.total_paid) || 0) < (Number(f.payable_amount) || Number(f.total_freight_cost) || 0)
      );
      setPendingFreight(waiting);

      // Build map of freight_id -> receipt_advice_id
      const freightToReceipt = {};
      allFreight.forEach(f => {
        if (f.id) freightToReceipt[f.id] = f.receipt_advice;
      });

      // Fetch freight attachments (receipt attachments are now permanently copied to freight)
      const allFreightIds = new Set([
        ...(pRes.data?.results || pRes.data || []).map(p => p.freight).filter(Boolean),
        ...allFreight.map(f => f.id).filter(Boolean),
      ]);
      const attachMap = {};
      await Promise.all([...allFreightIds].map(async (fid) => {
        try {
          const freightAttRes = await apiClient.get(`/api/purchase/attachments/?module=FREIGHT&record_id=${fid}`);
          const freightAtts = freightAttRes.data?.results || freightAttRes.data || [];
          if (freightAtts.length > 0) attachMap[fid] = freightAtts;
        } catch { /* ignore */ }
      }));
      setAttachmentsByFreight(attachMap);
    } catch { /* ignore */ }
    finally { setIsLoading(false); }
  };

  useEffect(() => { fetchData(); }, []);

  // Normalize both into unified format
  const unifiedData = useMemo(() => {
    const pNorm = purchasePayments.map(p => ({
      id: p.id,
      direction: 'Purchase',
      direction_key: 'purchase',
      freight_id: p.freight,
      freight_no: p.freight_no || '-',
      payment_date: p.payment_date || '',
      receipt_date: p.receipt_date || '',
      amount_paid: Number(p.amount_paid) || 0,
      payment_mode: p.payment_mode || '-',
      paid_to: p.paid_to || p.transporter_name || p.vendor_name || '-',
      reference_no: p.reference_no || '-',
      notes: p.notes || '-',
      total_freight: Number(p.total_freight_amount) || 0,
      freight_status: p.freight_status || '-',
      created_by: p.created_by_name || '-',
      created_at: p.created_at || '',
    }));

    const sNorm = salesPayments.map(p => ({
      id: p.id,
      direction: 'Sales',
      direction_key: 'sales',
      // Sales payment list returns `freight` (FK uuid) + `freight_id`
      // (also the uuid) + `advice_no` (the readable FA-… number).
      // Pull the readable advice_no into freight_no so the table column
      // shows e.g. "FA-2026-00003" instead of the raw uuid or "-".
      freight_id: p.freight_id || p.freight,
      freight_no: p.advice_no || p.freight_no || p.freight_advice_no || '-',
      payment_date: p.payment_date || '',
      amount_paid: Number(p.amount_paid) || 0,
      payment_mode: p.payment_mode || '-',
      paid_to: p.paid_to || p.transporter_name || '-',
      reference_no: p.reference_no || '-',
      notes: p.remarks || '-',
      total_freight: Number(p.total_freight_amount) || 0,
      freight_status: p.freight_status || '-',
      created_by: p.created_by_name || '-',
      created_at: p.created_at || '',
    }));

    // Add waiting-for-payment freight records. The FreightAdviceInbound
    // model carries the readable number in `advice_no` — fall back to
    // freight_no (legacy) before resorting to a UUID slice, so the
    // column shows "FA-2026-00001" instead of "FA-ba8ed7bc".
    const waitingNorm = pendingFreight.map(f => ({
      id: `waiting-${f.id}`,
      direction: 'Purchase',
      direction_key: 'purchase',
      freight_id: f.id,
      freight_no: f.advice_no || f.freight_no || `FA-${f.id.substring(0, 8)}`,
      payment_date: f.approved_at || f.created_at || '',
      receipt_date: f.receipt_date || f.created_date || f.created_at || '',
      amount_paid: 0,
      payment_mode: '-',
      paid_to: f.transporter_name || f.vendor_name || '-',
      reference_no: '-',
      notes: '-',
      total_freight: Number(f.payable_amount) || Number(f.total_freight_cost) || 0,
      balance: (Number(f.payable_amount) || Number(f.total_freight_cost) || 0) - (Number(f.total_paid) || 0),
      freight_status: 'Waiting for Payment',
      created_by: '-',
      created_at: f.created_at || '',
      _isWaiting: true,
    }));

    return [...waitingNorm, ...pNorm, ...sNorm].sort((a, b) => (b.payment_date || '').localeCompare(a.payment_date || ''));
  }, [purchasePayments, salesPayments, pendingFreight]);

  // Apply filters
  const filtered = useMemo(() => {
    let result = unifiedData;
    if (typeFilter) result = result.filter(p => p.direction === typeFilter);
    if (modeFilter) result = result.filter(p => p.payment_mode === modeFilter);
    result = result.filter(p => period.match(p.payment_date));
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(p =>
        (p.freight_no || '').toLowerCase().includes(s) ||
        (p.paid_to || '').toLowerCase().includes(s) ||
        (p.reference_no || '').toLowerCase().includes(s) ||
        (p.notes || '').toLowerCase().includes(s)
      );
    }
    return result;
  }, [unifiedData, typeFilter, modeFilter, period, search]);

  // Summary
  const summary = useMemo(() => {
    const totalPaid = filtered.reduce((s, p) => s + p.amount_paid, 0);
    const purchaseTotal = filtered.filter(p => p.direction === 'Purchase').reduce((s, p) => s + p.amount_paid, 0);
    const salesTotal = filtered.filter(p => p.direction === 'Sales').reduce((s, p) => s + p.amount_paid, 0);
    return { total: filtered.length, totalPaid, purchaseTotal, salesTotal };
  }, [filtered]);

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Delete this payment of ${fmt(row.amount_paid)}?`, isDangerous: true }))) return;
    try {
      const api = row.direction_key === 'purchase' ? '/api/purchase/freight-payments' : '/api/sales/freight-payments';
      await apiClient.delete(`${api}/${row.id}/`);
      toast.success('Payment deleted');
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to delete');
    }
  };

  const columns = [
    { key: 'direction', label: 'Type', sortable: true, render: v => (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold ${v === 'Purchase' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'}`}>
        {v === 'Purchase' ? <ArrowDownLeft size={12} /> : <ArrowUpRight size={12} />}
        {v}
      </span>
    )},
    { key: 'payment_date', label: 'Date', sortable: true, render: v => fmtDate(v) },
    { key: 'due_date', label: 'Due Date', sortable: true, render: (_, row) => {
      const baseDate = row.receipt_date || row.payment_date;
      if (!baseDate) return '-';
      const due = new Date(baseDate);
      due.setDate(due.getDate() + 15);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const isOverdue = due < today;
      return <span className={isOverdue ? 'text-red-600 font-medium' : 'text-slate-700'}>{fmtDate(due.toISOString())}</span>;
    }},
    { key: 'freight_no', label: 'Freight No', sortable: true, render: (v, row) => (
      <button onClick={(e) => { e.stopPropagation(); navigate(`/freight/${row.direction_key}/${row.freight_id}`); }} className="text-primary-600 hover:underline font-medium">{v}</button>
    )},
    { key: 'paid_to', label: 'Paid To', sortable: true },
    { key: 'amount_paid', label: 'Amount', sortable: true, render: (v, row) => row._isWaiting ? (
      <span className="font-semibold text-amber-600">{fmt(row.balance)} <span className="text-xs font-normal text-slate-400">due</span></span>
    ) : <span className="font-semibold text-emerald-700">{fmt(v)}</span> },
    { key: 'freight_status', label: 'Status', sortable: true, render: (v, row) => row._isWaiting ? (
      <span className="px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-700">Waiting for Payment</span>
    ) : <span className="px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-emerald-700">Paid</span> },
    { key: 'payment_mode', label: 'Mode', sortable: true, render: (v, row) => row._isWaiting ? '-' : (
      <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">{v}</span>
    )},
    { key: 'reference_no', label: 'Reference', sortable: true },
    { key: 'attachments', label: '', sortable: false, render: (_, row) => {
      const files = attachmentsByFreight[row.freight_id] || [];
      if (files.length === 0) return <span className="text-slate-300 text-xs">-</span>;
      return (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setAttachmentModal({ freightNo: row.freight_no, files });
          }}
          className="relative p-1.5 text-slate-500 hover:text-primary-600 hover:bg-slate-100 rounded transition"
          title={`${files.length} attachment${files.length > 1 ? 's' : ''}`}
        >
          <Paperclip size={16} />
          <span className="absolute -top-1 -right-1 bg-primary-600 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">{files.length}</span>
        </button>
      );
    }},
    { key: 'created_by', label: 'Created By', sortable: true },
    { key: 'actions', label: '', sortable: false, render: (_, row) => (
      <div className="flex items-center gap-1">
        {row._isWaiting && (
          <button onClick={(e) => { e.stopPropagation(); navigate(`/freight/payments/new?type=purchase&freight_id=${row.freight_id}`); }} className="px-2.5 py-1 bg-emerald-600 text-white text-xs font-medium rounded-lg hover:bg-emerald-700">
            Pay
          </button>
        )}
        <button onClick={(e) => { e.stopPropagation(); navigate(`/freight/${row.direction_key}/${row.freight_id}`); }} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded" title="View Freight">
          <Eye size={15} />
        </button>
        {canDelete('Freight Payment') && (
          <button onClick={(e) => handleDelete(e, row)} className="p-1.5 text-red-500 hover:bg-red-50 rounded" title="Delete">
            <Trash2 size={15} />
          </button>
        )}
      </div>
    )},
  ];

  // Hide columns the 'Freight Payment' field-permission map marks HIDDEN.
  // The freight identifier/link, attachments and row actions stay.
  const NEVER_HIDE = new Set(['direction', 'freight_no', 'due_date', 'freight_status', 'attachments', 'created_by', 'actions']);
  const keyFor = (col) => col.key.replace(/_(name|code|display)$/, '');
  const visibleColumns = columns.filter(c => NEVER_HIDE.has(c.key) || !isHidden(keyFor(c)));

  const inputClass = 'px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

  return (
    <MainLayout>
      <PageHeader
        title="Freight Payments"
        subtitle="Track all freight payment records"
        breadcrumbs={[{ label: 'Freight', href: '/freight/inward' }, { label: 'Payments' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreate('Freight Payment') ? { createLink: '/freight/payments/new', createLabel: 'New Payment' } : {}),
        }}
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4 mb-3 sm:mb-6">
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-slate-500 uppercase font-medium">Total Payments</p>
              <p className="text-xl font-bold text-slate-900 mt-1">{summary.total}</p>
            </div>
            <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center">
              <Clock size={20} className="text-slate-600" />
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-slate-500 uppercase font-medium">Total Paid</p>
              <p className="text-xl font-bold text-emerald-700 mt-1">{fmt(summary.totalPaid)}</p>
            </div>
            <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center">
              <IndianRupee size={20} className="text-emerald-600" />
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-blue-500 uppercase font-medium">Purchase Payments</p>
              <p className="text-xl font-bold text-blue-700 mt-1">{fmt(summary.purchaseTotal)}</p>
            </div>
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <ArrowDownLeft size={20} className="text-blue-600" />
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-emerald-500 uppercase font-medium">Sales Payments</p>
              <p className="text-xl font-bold text-emerald-700 mt-1">{fmt(summary.salesTotal)}</p>
            </div>
            <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center">
              <ArrowUpRight size={20} className="text-emerald-600" />
            </div>
          </div>
        </div>
      </div>

      {/* Period + search — always visible. */}
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4 mb-3 sm:mb-4 flex flex-wrap items-center gap-3">
        <PeriodNavigator allowAll {...period.navProps} />
        <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Freight no, party, ref..." className={`${inputClass} flex-1 min-w-[180px]`} />
      </div>

      {/* Filters — toggled by header Filters button. */}
      {showFilters && (
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4 mb-3 sm:mb-4">
        <div className="grid grid-cols-2 gap-2 sm:gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Freight Type</label>
            <CustomSelect value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className={inputClass + ' w-full'}>
              <option value="">All Types</option>
              <option value="Purchase">Purchase</option>
              <option value="Sales">Sales</option>
            </CustomSelect>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Payment Mode</label>
            <CustomSelect value={modeFilter} onChange={e => setModeFilter(e.target.value)} className={inputClass + ' w-full'}>
              <option value="">All Modes</option>
              <option value="CASH">Cash</option>
              <option value="BANK">Bank Transfer</option>
              <option value="UPI">UPI</option>
              <option value="CHEQUE">Cheque</option>
              <option value="NEFT">NEFT</option>
              <option value="RTGS">RTGS</option>
              <option value="OTHER">Other</option>
            </CustomSelect>
          </div>
        </div>
      </div>
      )}

      {isLoading && <div className="text-center py-8 text-slate-500">Loading...</div>}

      <MobileListCards
        rows={filtered}
        isLoading={isLoading}
        emptyMessage="No freight payments found"
        config={{
          title: (row) => row.payment_no || row.advice_no || row.id,
          subtitle: (row) => row.vendor_name || row.transporter_name,
          badge: (row) => {
            const dir = row.direction_key;
            return dir === 'inward'
              ? { label: 'Inward',  cls: 'bg-blue-100 text-blue-800 border-blue-300' }
              : dir === 'outward'
                ? { label: 'Outward', cls: 'bg-purple-100 text-purple-800 border-purple-300' }
                : { label: row.status || '-', cls: 'bg-slate-100 text-slate-700 border-slate-200' };
          },
          fields: (row) => [
            { label: 'Date',   value: row.payment_date ? formatDate(row.payment_date) : null },
            { label: 'Amount', value: row.amount_paid != null ? formatCurrency(row.amount_paid) : null, cls: 'font-medium' },
            { label: 'Status', value: row.status },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/freight/${row.direction_key}/${row.freight_id}`) },
          ],
        }}
        onRowClick={(row) => navigate(`/freight/${row.direction_key}/${row.freight_id}`)}
      />

      <div className="hidden sm:block">
        <DataTable persistKey="freight-payments"
          exportFileName="freight-payments"
          canExport={canExport('Freight Payment')}
          columns={visibleColumns}
          data={filtered}
          onRowClick={(row) => navigate(`/freight/${row.direction_key}/${row.freight_id}`)}
          searchable
          exportable
          pagination
        />
      </div>

      {/* Attachments Modal */}
      {attachmentModal && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={() => setAttachmentModal(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Freight payment attachments"
            className="bg-white rounded-xl shadow-2xl max-w-md w-full max-h-[80dvh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <div className="flex items-center gap-2 text-slate-800 font-semibold">
                <Paperclip size={16} className="text-primary-600" />
                <span>Attachments — {attachmentModal.freightNo}</span>
              </div>
              <button
                onClick={() => setAttachmentModal(null)}
                aria-label="Close"
                title="Close"
                className="p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded"
              >
                <X size={18} />
              </button>
            </div>
            <div className="p-4 overflow-y-auto space-y-2">
              {attachmentModal.files.map(f => {
                const sizeKB = f.file_size ? (Number(f.file_size) / 1024).toFixed(1) : null;
                const moduleLabel = f.module === 'RECEIPT' ? 'Receipt' : f.module === 'FREIGHT' ? 'Freight' : f.module;
                return (
                  <div key={f.id} className="flex items-center gap-3 p-3 border border-slate-200 rounded-lg hover:bg-slate-50">
                    <div className="w-9 h-9 rounded bg-slate-100 flex items-center justify-center flex-shrink-0">
                      <Paperclip size={16} className="text-slate-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-800 truncate" title={f.file_name}>{f.file_name}</p>
                      <p className="text-xs text-slate-500">
                        {moduleLabel}{f.file_type ? ` • ${f.file_type}` : ''}{sizeKB ? ` • ${sizeKB} KB` : ''}
                      </p>
                    </div>
                    <a
                      href={f.file}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3 py-1.5 bg-primary-600 text-white text-xs font-medium rounded hover:bg-primary-700"
                    >
                      View
                    </a>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  );
}
