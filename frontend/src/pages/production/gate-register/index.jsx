import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { RefreshCw, Eye, Trash2, ArrowDownRight, ArrowUpRight, Truck } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import CustomSelect from '@/components/ui/CustomSelect';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatDate } from '../../../utils/formatters.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useLookup from '../../../hooks/useLookup.js';
import { confirm } from '@/components/common/confirm';

const isoToday = () => new Date().toISOString().slice(0, 10);
const isoOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

const DIRECTION_OPTIONS = [
  { value: '', label: 'All directions' },
  { value: 'INWARD', label: 'Inward (Unloading)' },
  { value: 'OUTWARD', label: 'Outward (Loading)' },
];
const SHIFT_OPTIONS = [
  { value: '', label: 'All shifts' },
  { value: 'DAY', label: 'Day' },
  { value: 'NIGHT', label: 'Night' },
];

export default function GateRegisterList() {
  const navigate = useNavigate();
  const { canCreate, canDelete, canExport } = usePermissions();

  // Filters live in the URL so Back / refresh / sharing restore the filtered view.
  const [searchParams, setSearchParams] = useSearchParams();
  const [dateFrom, setDateFrom] = useState(searchParams.get('dateFrom') || isoOffset(-6));
  const [dateTo, setDateTo] = useState(searchParams.get('dateTo') || isoToday());
  const [warehouseId, setWarehouseId] = useState(searchParams.get('warehouseId') || '');
  const [direction, setDirection] = useState(searchParams.get('direction') || '');
  const [shift, setShift] = useState(searchParams.get('shift') || '');

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

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
      if (warehouseId) params.set('warehouse', warehouseId);
      if (direction) params.set('direction', direction);
      if (shift) params.set('shift', shift);
      params.set('page_size', '500');
      const res = await apiClient.get(`/api/production/gate-entries/?${params.toString()}`);
      setRows(res.data?.results || res.data || []);
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [dateFrom, dateTo, warehouseId, direction, shift]);

  // Mirror the active filters into the URL (replace — a filter change isn't a
  // separate history entry; only opening a record is).
  useEffect(() => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      const put = (k, val) => { if (val) p.set(k, val); else p.delete(k); };
      put('dateFrom', dateFrom);
      put('dateTo', dateTo);
      put('warehouseId', warehouseId);
      put('direction', direction);
      put('shift', shift);
      return p;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, warehouseId, direction, shift]);

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Remove gate entry ${row.entry_no}? This soft-deletes the row.` }))) return;
    try {
      await apiClient.delete(`/api/production/gate-entries/${row.id}/`);
      toast.success('Gate entry removed.');
      load();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    }
  };

  const columns = [
    {
      key: 'entry_no', label: 'Entry No', sortable: true,
      render: (v, row) => (
        <button onClick={(e) => { e.stopPropagation(); navigate(`/production/gate-register/${row.id}`); }}
          className="text-primary-600 hover:text-primary-800 hover:underline font-medium">{v || '-'}</button>
      ),
    },
    { key: 'entry_date', label: 'Date', sortable: true, render: (v) => (v ? formatDate(v) : '-') },
    { key: 'shift_display', label: 'Shift', render: (v) => v || '-' },
    {
      key: 'direction', label: 'Direction', render: (_, row) => {
        const inward = row.direction === 'INWARD';
        return (
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${inward ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
            {inward ? <ArrowDownRight size={12} /> : <ArrowUpRight size={12} />}
            {inward ? 'Inward' : 'Outward'}
          </span>
        );
      },
    },
    { key: 'vehicle_number', label: 'Vehicle', render: (v) => v || '-' },
    { key: 'party_name', label: 'Party', render: (v) => v || '-' },
    { key: 'product_description', label: 'Item', render: (v) => v || '-' },
    {
      key: 'quantity', label: 'Qty', sortable: true,
      render: (v, row) => `${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${row.uom || ''}`.trim(),
    },
    { key: 'warehouse_name', label: 'Warehouse', render: (v) => v || '-' },
    { key: 'created_by_name', label: 'Entered by', render: (v) => v || '-' },
    {
      key: 'actions', label: '', sortable: false,
      render: (_, row) => (
        <div className="flex items-center gap-1">
          <button onClick={(e) => { e.stopPropagation(); navigate(`/production/gate-register/${row.id}`); }} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition" title="View / Edit">
            <Eye size={15} />
          </button>
          {canDelete('Gate Register') && (
            <button onClick={(e) => handleDelete(e, row)} className="p-1.5 text-red-600 hover:bg-red-50 rounded transition" title="Remove entry">
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <MainLayout>
      <PageHeader
        title="Gate Register"
        subtitle="Factory gate loading / unloading log — replaces the paper truck register"
        breadcrumbs={[{ label: 'Production' }, { label: 'Gate Register' }]}
        actions={{
          ...(canCreate('Gate Register')
            ? { createLink: '/production/gate-register/new', createLabel: 'New Gate Entry' }
            : {}),
        }}
      />

      <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[150px]">
          <label className="block text-xs font-medium text-slate-600 mb-1">From</label>
          <CustomDatePicker value={dateFrom} onChange={setDateFrom} />
        </div>
        <div className="min-w-[150px]">
          <label className="block text-xs font-medium text-slate-600 mb-1">To</label>
          <CustomDatePicker value={dateTo} onChange={setDateTo} />
        </div>
        <div className="min-w-[200px]">
          <label className="block text-xs font-medium text-slate-600 mb-1">Warehouse</label>
          <CustomSelect value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            {warehouses.map((w) => (<option key={w.value} value={w.value}>{w.label}</option>))}
          </CustomSelect>
        </div>
        <div className="min-w-[160px]">
          <label className="block text-xs font-medium text-slate-600 mb-1">Direction</label>
          <CustomSelect value={direction} onChange={(e) => setDirection(e.target.value)}>
            {DIRECTION_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
          </CustomSelect>
        </div>
        <div className="min-w-[140px]">
          <label className="block text-xs font-medium text-slate-600 mb-1">Shift</label>
          <CustomSelect value={shift} onChange={(e) => setShift(e.target.value)}>
            {SHIFT_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
          </CustomSelect>
        </div>
        <button onClick={load} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error && !isLoading ? (
        <div className="text-center py-8">
          <p className="text-red-500 mb-3">{error}</p>
          <button onClick={load} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700">
            <RefreshCw size={15} /> Retry
          </button>
        </div>
      ) : rows.length === 0 && !isLoading ? (
        <div className="text-center py-12 text-slate-500 bg-white rounded-lg border border-slate-200">
          <Truck size={40} className="mx-auto mb-3 text-slate-300" />
          <p className="text-sm">No gate entries in this period.</p>
        </div>
      ) : (
        <DataTable persistKey="gate-register"
          columns={columns}
          data={rows}
          isLoading={isLoading}
          canExport={canExport('Gate Register')}
          exportFileName="gate-register"
          onRowClick={(row) => navigate(`/production/gate-register/${row.id}`)}
        />
      )}
    </MainLayout>
  );
}
