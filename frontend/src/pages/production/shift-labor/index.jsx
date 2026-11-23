import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { RefreshCw, Save, Loader2, Trash2, Users } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import CustomSelect from '@/components/ui/CustomSelect';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatDate } from '../../../utils/formatters.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useLookup from '../../../hooks/useLookup.js';
import { confirm } from '@/components/common/confirm';

// One-page Shift Labor: filter bar on top, inline "Add today's row" form
// under it, list of recent rows below. Editing an existing row is done in
// place (click Edit → the form loads that row's values, Save updates).

const isoToday = () => new Date().toISOString().slice(0, 10);
const isoOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

const SHIFT_OPTIONS = [
  { value: 'DAY', label: 'Day' },
  { value: 'NIGHT', label: 'Night' },
];

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const numClass = `${inputClass} tabular-nums`;
const labelClass = 'block text-xs font-medium text-slate-600 mb-1';

export default function ShiftLaborPage() {
  const { canCreate, canEdit, canDelete } = usePermissions();
  const editable = canCreate('Shift Labor');

  const { raw: warehousesRaw } = useLookup('/api/warehouses/');
  const warehouses = useMemo(() => {
    const seen = new Set();
    return (warehousesRaw || [])
      .filter((w) => {
        const k = (w.name || '').trim().toLowerCase();
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((w) => ({ value: w.id, label: w.name }));
  }, [warehousesRaw]);

  const [dateFrom, setDateFrom] = useState(isoOffset(-6));
  const [dateTo, setDateTo] = useState(isoToday());
  const [warehouseFilter, setWarehouseFilter] = useState('');

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
      if (warehouseFilter) params.set('warehouse', warehouseFilter);
      params.set('page_size', '500');
      const res = await apiClient.get(`/api/production/shift-labor/?${params.toString()}`);
      setRows(res.data?.results || res.data || []);
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [dateFrom, dateTo, warehouseFilter]);

  // Inline editor state — either creating new or editing an existing row.
  const emptyForm = {
    id: null,
    entry_date: isoToday(),
    shift: 'DAY',
    warehouse: '',
    tamil_labor: 0,
    hindi_labor: 0,
    ladies: 0,
    supervisor: 0,
    remarks: '',
  };
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));

  const startEdit = (row) => {
    setForm({
      id: row.id,
      entry_date: row.entry_date,
      shift: row.shift,
      warehouse: row.warehouse,
      tamil_labor: row.tamil_labor || 0,
      hindi_labor: row.hindi_labor || 0,
      ladies: row.ladies || 0,
      supervisor: row.supervisor || 0,
      remarks: row.remarks || '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSave = async () => {
    if (!form.warehouse) { toast.error('Pick a warehouse.'); return; }
    setSaving(true);
    try {
      const payload = {
        entry_date: form.entry_date,
        shift: form.shift,
        warehouse: form.warehouse,
        tamil_labor: Number(form.tamil_labor) || 0,
        hindi_labor: Number(form.hindi_labor) || 0,
        ladies: Number(form.ladies) || 0,
        supervisor: Number(form.supervisor) || 0,
        remarks: form.remarks,
      };
      if (form.id) {
        await apiClient.patch(`/api/production/shift-labor/${form.id}/`, payload);
        toast.success('Shift labor updated.');
      } else {
        await apiClient.post('/api/production/shift-labor/', payload);
        toast.success('Shift labor saved.');
      }
      setForm(emptyForm);
      load();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row) => {
    if (!(await confirm({ message: `Remove ${row.shift_display} labor for ${formatDate(row.entry_date)} at ${row.warehouse_name}?` }))) return;
    try {
      await apiClient.delete(`/api/production/shift-labor/${row.id}/`);
      toast.success('Removed.');
      load();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Shift Labor"
        subtitle="Daily plant-wide labor tally per shift — replaces the T.L / H.L / Ladies count at the bottom of the paper DPR"
        breadcrumbs={[{ label: 'Production' }, { label: 'Shift Labor' }]}
      />

      {editable && (
        <div className="mb-4 bg-white rounded-lg border border-slate-200 p-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">{form.id ? 'Edit shift labor row' : 'Add today\'s labor count'}</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
            <div>
              <label className={labelClass}>Date</label>
              <CustomDatePicker value={form.entry_date} onChange={(v) => set('entry_date', v)} />
            </div>
            <div>
              <label className={labelClass}>Shift</label>
              <CustomSelect value={form.shift} onChange={(e) => set('shift', e.target.value)}>
                {SHIFT_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
              </CustomSelect>
            </div>
            <div className="col-span-2">
              <label className={labelClass}>Warehouse</label>
              <CustomSelect value={form.warehouse} onChange={(e) => set('warehouse', e.target.value)} placeholder="Pick warehouse">
                <option value="">Pick warehouse</option>
                {warehouses.map((w) => (<option key={w.value} value={w.value}>{w.label}</option>))}
              </CustomSelect>
            </div>
            <div>
              <label className={labelClass}>Tamil</label>
              <input type="number" min="0" step="1" className={numClass} value={form.tamil_labor} onChange={(e) => set('tamil_labor', e.target.value)} />
            </div>
            <div>
              <label className={labelClass}>Hindi</label>
              <input type="number" min="0" step="1" className={numClass} value={form.hindi_labor} onChange={(e) => set('hindi_labor', e.target.value)} />
            </div>
            <div>
              <label className={labelClass}>Ladies</label>
              <input type="number" min="0" step="1" className={numClass} value={form.ladies} onChange={(e) => set('ladies', e.target.value)} />
            </div>
            <div>
              <label className={labelClass}>Supervisor (T.L)</label>
              <input type="number" min="0" step="1" className={numClass} value={form.supervisor} onChange={(e) => set('supervisor', e.target.value)} />
            </div>
            <div className="sm:col-span-3 lg:col-span-6">
              <label className={labelClass}>Remarks</label>
              <input type="text" className={inputClass} value={form.remarks} onChange={(e) => set('remarks', e.target.value)} placeholder="Optional note (e.g. Half day, wood-shifting work)" />
            </div>
            <div className="sm:col-span-1 lg:col-span-2 flex items-end gap-2">
              <button
                onClick={handleSave} disabled={saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-60"
              >
                {saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />}
                {form.id ? 'Update' : 'Save'}
              </button>
              {form.id && (
                <button
                  onClick={() => setForm(emptyForm)}
                  className="inline-flex items-center px-3 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            One row per (warehouse × date × shift). Editing an existing row updates it in place.
          </p>
        </div>
      )}

      <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3 flex flex-wrap items-end gap-3">
        <div className="min-w-[150px]">
          <label className={labelClass}>From</label>
          <CustomDatePicker value={dateFrom} onChange={setDateFrom} />
        </div>
        <div className="min-w-[150px]">
          <label className={labelClass}>To</label>
          <CustomDatePicker value={dateTo} onChange={setDateTo} />
        </div>
        <div className="min-w-[200px]">
          <label className={labelClass}>Warehouse</label>
          <CustomSelect value={warehouseFilter} onChange={(e) => setWarehouseFilter(e.target.value)}>
            <option value="">All Warehouses</option>
            {warehouses.map((w) => (<option key={w.value} value={w.value}>{w.label}</option>))}
          </CustomSelect>
        </div>
        <button onClick={load} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="bg-white rounded-lg border border-slate-200 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2.5">Date</th>
              <th className="px-3 py-2.5">Shift</th>
              <th className="px-3 py-2.5">Warehouse</th>
              <th className="px-3 py-2.5 text-right">Tamil</th>
              <th className="px-3 py-2.5 text-right">Hindi</th>
              <th className="px-3 py-2.5 text-right">Ladies</th>
              <th className="px-3 py-2.5 text-right">T.L</th>
              <th className="px-3 py-2.5 text-right">Total Labor</th>
              <th className="px-3 py-2.5">Remarks</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={10} className="px-3 py-4 sm:py-5 text-center text-slate-400"><Loader2 className="inline animate-spin" size={16} /> Loading…</td></tr>
            ) : error ? (
              <tr><td colSpan={10} className="px-3 py-4 sm:py-5 text-center text-red-500">{error}</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={10} className="px-3 py-10 text-center text-slate-400">
                <Users size={28} className="mx-auto mb-2 text-slate-300" />
                No shift-labor rows in this period.
              </td></tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2.5 tabular-nums">{formatDate(row.entry_date)}</td>
                  <td className="px-3 py-2.5">{row.shift_display}</td>
                  <td className="px-3 py-2.5">{row.warehouse_name}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{row.tamil_labor}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{row.hindi_labor}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{row.ladies}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{row.supervisor}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-medium">{row.total_labor}</td>
                  <td className="px-3 py-2.5 text-slate-600 max-w-[240px] truncate">{row.remarks || '—'}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1">
                      {canEdit('Shift Labor') && (
                        <button onClick={() => startEdit(row)} className="text-xs px-2 py-1 rounded bg-slate-100 hover:bg-slate-200">Edit</button>
                      )}
                      {canDelete('Shift Labor') && (
                        <button onClick={() => handleDelete(row)} className="p-1.5 text-red-600 hover:bg-red-50 rounded" title="Remove"><Trash2 size={14} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </MainLayout>
  );
}
