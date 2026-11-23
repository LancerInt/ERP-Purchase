import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { RefreshCw, Plus, Edit, Trash2, Loader2, CheckCircle2, Undo2, X as XIcon } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import CustomSelect from '@/components/ui/CustomSelect';
import Modal from '../../../components/ui/Modal';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatDate } from '../../../utils/formatters.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useLookup from '../../../hooks/useLookup.js';
import { confirm } from '@/components/common/confirm';

const labelClass = 'block text-xs font-medium text-slate-600 mb-1';
const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const isoToday = () => new Date().toISOString().slice(0, 10);
const isoOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

const ACTIVITY_OPTIONS = [
  { value: '',                label: 'All activities' },
  { value: 'LOTTING',         label: 'Lotting' },
  { value: 'BUNDLING',        label: 'Bundling' },
  { value: 'INTER_SHIFTING',  label: 'Inter-shifting' },
  { value: 'INTER_TRANSFER',  label: 'Inter-transfer' },
  { value: 'CLEANING',        label: 'Cleaning' },
  { value: 'OTHER',           label: 'Other' },
];

const PAYMENT_OPTIONS = [
  { value: '',       label: 'All payment status' },
  { value: 'UNPAID', label: 'Unpaid' },
  { value: 'PAID',   label: 'Paid' },
];

const nfmt = (v) => Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

export default function AdditionalWagesList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete } = usePermissions();
  const canAdd = canCreate('Wage Voucher');
  const canEditRow = canEdit('Wage Voucher');
  const canDel = canDelete('Wage Voucher');

  const [dateFrom, setDateFrom] = useState(isoOffset(-29));
  const [dateTo, setDateTo] = useState(isoToday());
  const [warehouseId, setWarehouseId] = useState('');
  const [activity, setActivity] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('UNPAID');

  const { raw: warehousesRaw } = useLookup('/api/warehouses/');
  const warehouses = useMemo(() => {
    const seen = new Set();
    const out = [{ value: '', label: 'All Warehouses' }];
    (warehousesRaw || []).forEach((w) => {
      const k = (w.name || '').trim().toLowerCase();
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push({ value: w.id, label: w.name });
    });
    return out;
  }, [warehousesRaw]);

  const [rows, setRows] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  // Bulk-select for mark-paid — track a Set of picked entry ids.
  const [selected, setSelected] = useState(() => new Set());

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
      if (warehouseId) params.set('warehouse', warehouseId);
      if (activity) params.set('activity_type', activity);
      if (paymentStatus) params.set('payment_status', paymentStatus);
      params.set('page_size', '500');
      const res = await apiClient.get(`/api/production/additional-wages/?${params.toString()}`);
      setRows(res.data?.results || res.data || []);
      setSelected(new Set());  // clear stale selection whenever the list reloads
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [dateFrom, dateTo, warehouseId, activity, paymentStatus]);

  const handleDelete = async (row) => {
    if (!(await confirm({ message: `Remove ${row.entry_no}?` }))) return;
    try {
      await apiClient.delete(`/api/production/additional-wages/${row.id}/`);
      toast.success('Removed.');
      load();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    }
  };

  const toggleRow = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAllUnpaid = () => {
    const eligible = rows.filter((r) => r.payment_status === 'UNPAID').map((r) => r.id);
    const allSelected = eligible.length > 0 && eligible.every((id) => selected.has(id));
    setSelected(allSelected ? new Set() : new Set(eligible));
  };

  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.id)),
    [rows, selected],
  );
  const selectedTotal = useMemo(
    () => selectedRows.reduce((s, r) => s + (Number(r.wage_total) || 0), 0),
    [selectedRows],
  );

  // Mark-paid modal state.
  const [payModal, setPayModal] = useState(false);
  const [payDate, setPayDate] = useState(isoToday());
  const [payReference, setPayReference] = useState('');
  const [paySubmitting, setPaySubmitting] = useState(false);

  const openPayModal = () => {
    if (!selected.size) {
      toast.error('Pick at least one row.');
      return;
    }
    // Guard against picking already-PAID rows (filter dropdown lets
    // the operator switch to PAID while a stale selection persists).
    const anyPaid = selectedRows.some((r) => r.payment_status === 'PAID');
    if (anyPaid) {
      toast.error('Deselect the already-PAID rows first.');
      return;
    }
    setPayDate(isoToday());
    setPayReference('');
    setPayModal(true);
  };

  const submitMarkPaid = async () => {
    setPaySubmitting(true);
    try {
      const res = await apiClient.post('/api/production/additional-wages/mark-paid/', {
        ids: Array.from(selected),
        paid_at: payDate || isoToday(),
        paid_reference: payReference || '',
      });
      const { updated = 0, skipped_already_paid = 0 } = res.data || {};
      toast.success(
        `${updated} marked paid${skipped_already_paid ? ` · ${skipped_already_paid} skipped (already paid)` : ''}.`,
      );
      setPayModal(false);
      load();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setPaySubmitting(false);
    }
  };

  const markOneUnpaid = async (row) => {
    if (!(await confirm({ message: `Revert ${row.entry_no} back to UNPAID?` }))) return;
    try {
      await apiClient.post('/api/production/additional-wages/mark-unpaid/', { ids: [row.id] });
      toast.success('Reverted to unpaid.');
      load();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    }
  };

  // Rollups shown in the filter bar / selection banner.
  const totalAmount = useMemo(
    () => rows.reduce((s, r) => s + (Number(r.wage_total) || 0), 0),
    [rows],
  );
  const totalUnpaid = useMemo(
    () => rows.filter((r) => r.payment_status === 'UNPAID')
      .reduce((s, r) => s + (Number(r.wage_total) || 0), 0),
    [rows],
  );

  const eligibleUnpaidIds = useMemo(
    () => rows.filter((r) => r.payment_status === 'UNPAID').map((r) => r.id),
    [rows],
  );
  const allEligibleSelected =
    eligibleUnpaidIds.length > 0 && eligibleUnpaidIds.every((id) => selected.has(id));

  const columns = [
    {
      key: '_select', label: (
        <input
          type="checkbox"
          checked={allEligibleSelected}
          onChange={toggleAllUnpaid}
          disabled={eligibleUnpaidIds.length === 0}
          title={eligibleUnpaidIds.length ? 'Select all unpaid on this page' : 'No unpaid rows to select'}
        />
      ),
      render: (_, row) => (
        row.payment_status === 'UNPAID' ? (
          <input
            type="checkbox"
            checked={selected.has(row.id)}
            onChange={() => toggleRow(row.id)}
          />
        ) : <span className="text-slate-300 text-xs">—</span>
      ),
    },
    { key: 'entry_no', label: 'Entry No', sortable: true },
    {
      key: 'entry_date', label: 'Date', sortable: true,
      render: (v) => (v ? formatDate(v) : '—'),
    },
    { key: 'activity_type_display', label: 'Activity', sortable: true },
    {
      key: 'reference', label: 'Reference',
      render: (v, r) => (
        <span className="text-xs text-slate-700">
          {v || <span className="text-slate-300">—</span>}
          {r.production_entry_batch && (
            <span className="ml-1.5 inline-block px-1.5 py-0.5 rounded text-[10px] bg-slate-200 text-slate-700 tabular-nums">
              {r.production_entry_batch}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'quantity', label: 'Qty', sortable: true,
      render: (v, r) => (
        Number(v) > 0
          ? <>{nfmt(v)} <span className="text-[10px] text-slate-400">{r.quantity_uom || ''}</span></>
          : <span className="text-slate-300">—</span>
      ),
    },
    {
      key: 'wage_mode', label: 'Mode',
      render: (v) => (
        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] ${
          v === 'GROUP' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'
        }`}>
          {v === 'GROUP' ? 'Group' : 'Per head'}
        </span>
      ),
    },
    {
      key: 'persons_count', label: 'Persons', sortable: true,
      render: (v) => Number(v) > 0 ? v : <span className="text-slate-300">—</span>,
    },
    { key: 'contractor_name', label: 'Contractor', render: (v) => v || <span className="text-slate-300">—</span> },
    {
      key: 'wage_total', label: 'Wage (₹)', sortable: true,
      render: (v) => <span className="tabular-nums font-medium">{nfmt(v)}</span>,
    },
    {
      key: 'payment_status', label: 'Payment',
      render: (v, r) => (
        v === 'PAID' ? (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-emerald-100 text-emerald-800">
            <CheckCircle2 size={10} /> Paid{r.paid_at ? ` · ${formatDate(r.paid_at)}` : ''}
          </span>
        ) : (
          <span className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-800">
            Unpaid
          </span>
        )
      ),
    },
    {
      key: 'actions', label: '',
      render: (_, row) => (
        <div className="flex items-center gap-1 justify-end">
          {row.payment_status === 'PAID' && canEditRow && (
            <button
              onClick={() => markOneUnpaid(row)}
              className="p-1.5 text-amber-600 hover:bg-amber-50 rounded"
              title="Revert to unpaid"
            ><Undo2 size={14} /></button>
          )}
          {canEditRow && (
            <button
              onClick={() => navigate(`/production/additional-wages/${row.id}`)}
              className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"
              title="Edit"
            ><Edit size={14} /></button>
          )}
          {canDel && (
            <button
              onClick={() => handleDelete(row)}
              className="p-1.5 text-red-600 hover:bg-red-50 rounded"
              title="Remove"
            ><Trash2 size={14} /></button>
          )}
        </div>
      ),
    },
  ];

  return (
    <MainLayout>
      <PageHeader
        title="Additional Wages"
        subtitle="Lotting, bundling, cleaning, inter-shifting / transfer wages — activities outside a single Production Entry"
        breadcrumbs={[{ label: 'Shifting Purpose' }, { label: 'Additional Wages' }]}
        actions={{
          right: canAdd && (
            <button
              onClick={() => navigate('/production/additional-wages/new')}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700"
            >
              <Plus size={14} /> New entry
            </button>
          ),
        }}
      />

      <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[160px]">
          <label className={labelClass}>From date</label>
          <CustomDatePicker value={dateFrom} onChange={(e) => setDateFrom(e?.target?.value ?? '')} />
        </div>
        <div className="min-w-[160px]">
          <label className={labelClass}>To date</label>
          <CustomDatePicker value={dateTo} onChange={(e) => setDateTo(e?.target?.value ?? '')} />
        </div>
        <div className="min-w-[180px]">
          <label className={labelClass}>Warehouse</label>
          <CustomSelect value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            {warehouses.map((w) => (<option key={w.value} value={w.value}>{w.label}</option>))}
          </CustomSelect>
        </div>
        <div className="min-w-[180px]">
          <label className={labelClass}>Activity</label>
          <CustomSelect value={activity} onChange={(e) => setActivity(e.target.value)}>
            {ACTIVITY_OPTIONS.map((a) => (<option key={a.value} value={a.value}>{a.label}</option>))}
          </CustomSelect>
        </div>
        <div className="min-w-[170px]">
          <label className={labelClass}>Payment status</label>
          <CustomSelect value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)}>
            {PAYMENT_OPTIONS.map((p) => (<option key={p.value} value={p.value}>{p.label}</option>))}
          </CustomSelect>
        </div>
        <button
          onClick={load}
          disabled={isLoading}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200"
        >
          {isLoading ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />} Refresh
        </button>
        <div className="ml-auto text-xs text-slate-500 text-right">
          {rows.length} entries · <span className="font-semibold text-slate-800">₹{nfmt(totalAmount)}</span> total
          {totalUnpaid > 0 && (
            <div className="text-amber-700">
              ₹{nfmt(totalUnpaid)} still unpaid
            </div>
          )}
        </div>
      </div>

      {/* Selection action bar — surfaces the bulk Mark-paid button
          whenever any UNPAID rows are ticked. */}
      {selected.size > 0 && (
        <div className="mb-4 rounded-lg border border-emerald-300 bg-emerald-50 p-3 flex flex-wrap items-center gap-3">
          <CheckCircle2 size={16} className="text-emerald-700 shrink-0" />
          <p className="text-sm text-emerald-900 flex-1 min-w-[240px]">
            <span className="font-semibold">{selected.size}</span> selected
            · <span className="font-semibold">₹{nfmt(selectedTotal)}</span> to be paid
          </p>
          <button
            onClick={openPayModal}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-emerald-600 text-white rounded hover:bg-emerald-700"
          >
            <CheckCircle2 size={12} /> Mark {selected.size} paid
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100 rounded"
          >
            <XIcon size={12} /> Clear
          </button>
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>
      )}

      <DataTable
        columns={columns}
        data={rows}
        isLoading={isLoading}
        emptyMessage="No additional wage entries in this window."
      />

      {/* Mark-paid modal — one payment date + one reference applies to
          every selected row. Contractor-mixing is fine here (the
          reference typically identifies the accountant's own voucher
          / bank UTR, not the payee). */}
      <Modal
        isOpen={payModal}
        onClose={() => setPayModal(false)}
        title={`Mark ${selected.size} entries paid`}
        size="sm"
      >
        <div className="p-4 space-y-3">
          <div>
            <label className={labelClass}>Paid on <span className="text-red-500">*</span></label>
            <CustomDatePicker value={payDate} onChange={(e) => setPayDate(e?.target?.value ?? '')} />
          </div>
          <div>
            <label className={labelClass}>Reference (UTR / voucher no / cheque no)</label>
            <input
              type="text" className={inputClass}
              value={payReference}
              onChange={(e) => setPayReference(e.target.value)}
              placeholder="Optional — e.g. UTR2026081712345 / Cash voucher CV-0042"
            />
          </div>
          <div className="text-xs text-slate-500">
            Total: <span className="font-semibold text-slate-800">₹{nfmt(selectedTotal)}</span> across {selected.size} entries
          </div>
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              onClick={() => setPayModal(false)}
              disabled={paySubmitting}
              className="px-3 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200"
            >
              Cancel
            </button>
            <button
              onClick={submitMarkPaid}
              disabled={paySubmitting || !payDate}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-60"
            >
              {paySubmitting ? <Loader2 className="animate-spin" size={14} /> : <CheckCircle2 size={14} />}
              Confirm paid
            </button>
          </div>
        </div>
      </Modal>
    </MainLayout>
  );
}
