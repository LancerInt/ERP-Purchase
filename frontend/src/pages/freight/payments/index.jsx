import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ListState from '@/components/common/ListState.jsx';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import apiClient from '../../../utils/api.js';
import toast from 'react-hot-toast';
import { Trash2, Eye, Paperclip, X } from 'lucide-react';
import MobileListCards from '../../purchase/components/MobileListCards';
import { confirm } from '@/components/common/confirm';
import { formatDate, formatCurrency } from '@/utils/formatters';

// Type chips split the list the way Payments Made does: a running count per
// bucket, All first, then the freight-payment statuses. "Waiting" is the
// approved-but-unpaid freight advices surfaced as to-pay rows.
const TYPE_CHIPS = [
  { key: 'all', label: 'All' },
  { key: 'paid', label: 'Paid' },
  { key: 'partial', label: 'Partial' },
  { key: 'unpaid', label: 'Unpaid' },
  { key: 'waiting', label: 'Waiting' },
];

// Bucket a normalized row into one of the TYPE_CHIPS keys.
function bucketOf(row) {
  if (row._isWaiting) return 'waiting';
  const total = Number(row.total_freight) || 0;
  const paid = Number(row.amount_paid) || 0;
  if (total > 0 && paid > 0 && paid < total) return 'partial';
  if (paid <= 0) return 'unpaid';
  return 'paid';
}

export default function FreightPaymentList() {
  const navigate = useNavigate();
  const { canDelete, canExport } = usePermissions();
  // Field-level column visibility for the Freight Payment list.
  const { isHidden } = useFieldPermissions('Freight Payment');

  const [purchasePayments, setPurchasePayments] = useState([]);
  const [pendingFreight, setPendingFreight] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // Map: freight_id -> array of attachments (combined freight + receipt)
  const [attachmentsByFreight, setAttachmentsByFreight] = useState({});
  // Attachments modal state: { freightNo, files }
  const [attachmentModal, setAttachmentModal] = useState(null);

  // Standard period navigator (All / Today / Week / Month / FY / Custom).
  const period = usePeriodFilter('all');
  const [typeFilter, setTypeFilter] = useState('all');

  const fetchData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      // Recorded freight payments + freight advices (to surface
      // approved-but-unpaid ones). Sales freight dropped: /api/sales/
      // freight-payments/ 404s here and there is no outward freight.
      const [pRes, fRes] = await Promise.all([
        apiClient.get('/api/purchase/freight-payments/?page_size=500').catch(() => ({ data: [] })),
        apiClient.get('/api/purchase/freight/').catch(() => ({ data: [] })),
      ]);
      const payments = pRes.data?.results || pRes.data || [];
      setPurchasePayments(payments);

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

      // Fetch freight attachments (receipt attachments are now permanently
      // copied to freight). One lookup per freight id across payments + advices.
      const allFreightIds = new Set([
        ...payments.map(p => p.freight).filter(Boolean),
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
    } catch (err) {
      setError(err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  // Normalize recorded payments + waiting-for-payment advices into one shape.
  const unifiedData = useMemo(() => {
    const pNorm = purchasePayments.map(p => ({
      id: p.id,
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

    // Add waiting-for-payment freight records. The FreightAdviceInbound
    // model carries the readable number in `advice_no` — fall back to
    // freight_no (legacy) before resorting to a UUID slice, so the
    // column shows "FA-2026-00001" instead of "FA-ba8ed7bc".
    const waitingNorm = pendingFreight.map(f => ({
      id: `waiting-${f.id}`,
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

    return [...waitingNorm, ...pNorm].sort((a, b) => (b.payment_date || '').localeCompare(a.payment_date || ''));
  }, [purchasePayments, pendingFreight]);

  // Period filter first, then the Type chips split within that (mirrors
  // Payments Made's baseData → typeCounts → filteredData flow).
  const baseData = useMemo(
    () => unifiedData.filter(row => period.match(row.payment_date)),
    [unifiedData, period]
  );

  const typeCounts = useMemo(() => baseData.reduce((acc, row) => {
    const k = bucketOf(row);
    acc[k] = (acc[k] || 0) + 1;
    acc.all = (acc.all || 0) + 1;
    return acc;
  }, {}), [baseData]);

  const filteredData = useMemo(
    () => (typeFilter === 'all' ? baseData : baseData.filter(row => bucketOf(row) === typeFilter)),
    [baseData, typeFilter]
  );

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Delete this payment of ${formatCurrency(row.amount_paid)}?`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/freight-payments/${row.id}/`);
      toast.success('Payment deleted');
      fetchData();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to delete');
    }
  };

  const columns = [
    { key: 'freight_no', label: 'Freight No', sortable: true, render: (v, row) => (
      <button onClick={(e) => { e.stopPropagation(); navigate(`/freight/purchase/${row.freight_id}`); }} className="text-primary-600 hover:text-primary-800 hover:underline font-medium">{v}</button>
    )},
    { key: 'paid_to', label: 'Transporter', sortable: true, render: (v) => v || '-' },
    { key: 'payment_date', label: 'Payment Date', sortable: true, render: (v) => v ? formatDate(v) : '-' },
    { key: 'amount_paid', label: 'Amount', sortable: true, render: (v, row) => row._isWaiting ? (
      <span className="font-semibold text-amber-600">{formatCurrency(row.balance)} <span className="text-xs font-normal text-slate-400">due</span></span>
    ) : <span className="font-semibold text-emerald-700">{formatCurrency(v)}</span> },
    { key: 'payment_mode', label: 'Mode', sortable: true, render: (v, row) => row._isWaiting ? '-' : (
      <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">{v}</span>
    )},
    { key: 'reference_no', label: 'Reference', sortable: true, render: (v) => v || '-' },
    { key: 'freight_status', label: 'Status', sortable: true, render: (v, row) => row._isWaiting ? (
      <span className="px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-700">Waiting for Payment</span>
    ) : <StatusBadge status={row.freight_status && row.freight_status !== '-' ? row.freight_status : 'Paid'} /> },
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
    { key: 'actions', label: '', sortable: false, render: (_, row) => (
      <div className="flex items-center gap-1">
        {row._isWaiting && (
          <button onClick={(e) => { e.stopPropagation(); navigate(`/freight/payments/new?type=purchase&freight_id=${row.freight_id}`); }} className="px-2.5 py-1 bg-emerald-600 text-white text-xs font-medium rounded-lg hover:bg-emerald-700">
            Pay
          </button>
        )}
        <button onClick={(e) => { e.stopPropagation(); navigate(`/freight/purchase/${row.freight_id}`); }} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded" title="View Freight">
          <Eye size={15} />
        </button>
        {canDelete('Freight Payment') && !row._isWaiting && (
          <button onClick={(e) => handleDelete(e, row)} className="p-1.5 text-red-500 hover:bg-red-50 rounded" title="Delete">
            <Trash2 size={15} />
          </button>
        )}
      </div>
    )},
  ];

  // Hide columns the 'Freight Payment' field-permission map marks HIDDEN.
  // The freight identifier/link, status, attachments and row actions stay.
  const NEVER_HIDE = new Set(['freight_no', 'freight_status', 'attachments', 'actions']);
  const keyFor = (col) => col.key.replace(/_(name|code|display)$/, '');
  const visibleColumns = columns.filter(c => NEVER_HIDE.has(c.key) || !isHidden(keyFor(c)));

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Freight Payments"
        subtitle="Payments made to transporters"
        breadcrumbs={[{ label: 'Freight' }, { label: 'Freight Payments' }]}
      />

      {/* Period + Type chips on one compact filter row (mirrors Payments Made). */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <PeriodNavigator allowAll {...period.navProps} />
        {TYPE_CHIPS.map((c) => {
          const n = typeCounts[c.key] || 0;
          const active = typeFilter === c.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setTypeFilter(c.key)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${active ? 'bg-primary-600 text-white border-primary-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}
            >
              {c.label} <span className={active ? 'text-primary-100' : 'text-slate-400'}>({n})</span>
            </button>
          );
        })}
      </div>

      {/* Summary strip — count + total paid (same markup as Payments Made). */}
      {filteredData.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-x-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2">
          <div>
            <span className="text-[11px] text-slate-500">Payments</span>
            <p className="text-sm font-bold text-slate-900 tabular-nums">{filteredData.length}</p>
          </div>
          <div>
            <span className="text-[11px] text-slate-500">Total Paid</span>
            <p className="text-sm font-bold text-slate-900 tabular-nums">{formatCurrency(filteredData.reduce((s, r) => s + (Number(r.amount_paid) || 0), 0))}</p>
          </div>
        </div>
      )}

      <ListState error={error} onRetry={fetchData}>
        <MobileListCards
          rows={filteredData}
          isLoading={isLoading}
          emptyMessage="No freight payments found"
          config={{
            title: (row) => row.freight_no || `Payment #${row.id?.toString().slice(0, 8)}`,
            subtitle: (row) => row.paid_to,
            badge: (row) => row._isWaiting
              ? { label: 'Waiting', cls: 'bg-amber-100 text-amber-700 border-amber-300' }
              : { label: row.freight_status && row.freight_status !== '-' ? row.freight_status : 'Paid', cls: 'bg-slate-100 text-slate-700 border-slate-200' },
            fields: (row) => [
              { label: 'Date',   value: row.payment_date ? formatDate(row.payment_date) : null },
              { label: 'Mode',   value: row._isWaiting ? null : row.payment_mode },
              { label: 'Amount', value: row._isWaiting
                  ? (row.balance != null ? `${formatCurrency(row.balance)} due` : null)
                  : (row.amount_paid != null ? formatCurrency(row.amount_paid) : null), cls: 'font-medium' },
            ],
            actions: (row) => [
              ...(row._isWaiting ? [{ label: 'Pay', cls: 'text-emerald-700 hover:bg-emerald-50', onClick: () => navigate(`/freight/payments/new?type=purchase&freight_id=${row.freight_id}`) }] : []),
              { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/freight/purchase/${row.freight_id}`) },
            ],
          }}
          onRowClick={(row) => navigate(`/freight/purchase/${row.freight_id}`)}
        />
        <div className="hidden sm:block">
          <DataTable
            persistKey="freight-payments"
            exportFileName="freight-payments"
            canExport={canExport('Freight Payment')}
            columns={visibleColumns}
            data={filteredData}
            isLoading={isLoading}
            onRowClick={(row) => navigate(`/freight/purchase/${row.freight_id}`)}
          />
        </div>
      </ListState>

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
