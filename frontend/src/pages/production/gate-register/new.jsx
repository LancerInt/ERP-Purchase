import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Save, Loader2, Trash2, ArrowLeft } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import CustomSelect from '@/components/ui/CustomSelect';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { confirm } from '@/components/common/confirm';

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const labelClass = 'block text-xs font-medium text-slate-600 mb-1';

const DIRECTION_OPTIONS = [
  { value: 'INWARD', label: 'Inward (Unloading)' },
  { value: 'OUTWARD', label: 'Outward (Loading)' },
];
const SHIFT_OPTIONS = [
  { value: 'DAY', label: 'Day' },
  { value: 'NIGHT', label: 'Night' },
];
const UOM_OPTIONS = [
  { value: 'MT', label: 'MT (metric tonne)' },
  { value: 'KG', label: 'KG' },
  { value: 'LTR', label: 'LTR (litres)' },
  { value: 'NOS', label: 'NOS (numbers)' },
  { value: 'BAG', label: 'BAG' },
  { value: 'BOX', label: 'BOX' },
  { value: 'DRUM', label: 'DRUM' },
];

const isoToday = () => new Date().toISOString().slice(0, 10);

export default function GateEntryForm() {
  const navigate = useNavigate();
  const { id } = useParams();
  const isEdit = Boolean(id && id !== 'new');
  const { canCreate, canEdit, canDelete } = usePermissions();
  const editable = isEdit ? canEdit('Gate Register') : canCreate('Gate Register');

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

  const [form, setForm] = useState({
    entry_date: isoToday(),
    shift: 'DAY',
    direction: 'INWARD',
    warehouse: '',
    vehicle_number: '',
    party_name: '',
    product_description: '',
    quantity: '',
    uom: 'MT',
    remarks: '',
  });
  const [entryNo, setEntryNo] = useState('');
  const [createdByName, setCreatedByName] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(isEdit);

  useEffect(() => {
    if (!isEdit) return;
    let cancelled = false;
    setLoading(true);
    apiClient.get(`/api/production/gate-entries/${id}/`)
      .then((res) => {
        if (cancelled) return;
        const d = res.data || {};
        setEntryNo(d.entry_no || '');
        setCreatedByName(d.created_by_name || '');
        setForm({
          entry_date: d.entry_date || isoToday(),
          shift: d.shift || 'DAY',
          direction: d.direction || 'INWARD',
          warehouse: d.warehouse || '',
          vehicle_number: d.vehicle_number || '',
          party_name: d.party_name || '',
          product_description: d.product_description || '',
          quantity: d.quantity ?? '',
          uom: d.uom || 'MT',
          remarks: d.remarks || '',
        });
      })
      .catch((err) => toast.error(getApiErrorMessage(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [id, isEdit]);

  const set = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));

  const validate = () => {
    if (!form.warehouse) return 'Pick a warehouse.';
    if (!form.vehicle_number.trim()) return 'Enter the vehicle number.';
    if (!form.party_name.trim()) return 'Enter the party name.';
    if (!form.product_description.trim()) return 'Enter the item description.';
    const q = Number(form.quantity);
    if (!q || q <= 0) return 'Quantity must be greater than zero.';
    if (!form.uom.trim()) return 'Enter the UOM (MT / KG / LTR / NOS / …).';
    return null;
  };

  const handleSave = async () => {
    const err = validate();
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      const payload = { ...form, quantity: Number(form.quantity) };
      if (isEdit) {
        await apiClient.patch(`/api/production/gate-entries/${id}/`, payload);
        toast.success('Gate entry updated.');
      } else {
        const res = await apiClient.post('/api/production/gate-entries/', payload);
        toast.success(`Saved as ${res.data?.entry_no || 'gate entry'}.`);
      }
      navigate('/production/gate-register');
    } catch (er) {
      toast.error(getApiErrorMessage(er));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: `Remove ${entryNo}? This soft-deletes the entry.` }))) return;
    try {
      await apiClient.delete(`/api/production/gate-entries/${id}/`);
      toast.success('Removed.');
      navigate('/production/gate-register');
    } catch (er) {
      toast.error(getApiErrorMessage(er));
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title={isEdit ? `Gate Entry ${entryNo || ''}` : 'New Gate Entry'}
        subtitle="Record one vehicle in / out of the factory gate"
        breadcrumbs={[
          { label: 'Production' },
          { label: 'Gate Register', href: '/production/gate-register' },
          { label: isEdit ? (entryNo || 'Edit') : 'New' },
        ]}
      />

      {loading ? (
        <div className="text-center py-12"><Loader2 className="inline animate-spin" size={22} /></div>
      ) : (
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6 max-w-4xl">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Date <span className="text-red-500">*</span></label>
              <CustomDatePicker value={form.entry_date} onChange={(v) => set('entry_date', v)} disabled={!editable} />
            </div>
            <div>
              <label className={labelClass}>Shift <span className="text-red-500">*</span></label>
              <CustomSelect value={form.shift} onChange={(e) => set('shift', e.target.value)} disabled={!editable}>
                {SHIFT_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
              </CustomSelect>
            </div>

            <div>
              <label className={labelClass}>Direction <span className="text-red-500">*</span></label>
              <CustomSelect value={form.direction} onChange={(e) => set('direction', e.target.value)} disabled={!editable}>
                {DIRECTION_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
              </CustomSelect>
            </div>
            <div>
              <label className={labelClass}>Warehouse <span className="text-red-500">*</span></label>
              <CustomSelect value={form.warehouse} onChange={(e) => set('warehouse', e.target.value)} disabled={!editable} placeholder="Pick warehouse">
                <option value="">Pick warehouse</option>
                {warehouses.map((w) => (<option key={w.value} value={w.value}>{w.label}</option>))}
              </CustomSelect>
            </div>

            <div>
              <label className={labelClass}>Vehicle Number <span className="text-red-500">*</span></label>
              <input
                type="text" className={inputClass} value={form.vehicle_number}
                onChange={(e) => set('vehicle_number', e.target.value.toUpperCase())}
                placeholder="e.g. TN60AC2793" disabled={!editable}
              />
            </div>
            <div>
              <label className={labelClass}>Party Name <span className="text-red-500">*</span></label>
              <input
                type="text" className={inputClass} value={form.party_name}
                onChange={(e) => set('party_name', e.target.value)}
                placeholder="e.g. Kumaran, Shre Shrely Surfactants, SLP factory" disabled={!editable}
              />
            </div>

            <div className="sm:col-span-2">
              <label className={labelClass}>Item Description <span className="text-red-500">*</span></label>
              <input
                type="text" className={inputClass} value={form.product_description}
                onChange={(e) => set('product_description', e.target.value)}
                placeholder="e.g. Humic Granules, Tween 85, OS Fruit" disabled={!editable}
              />
              <p className="mt-1 text-[11px] text-slate-500">Free text — matches how the operator writes it in the gate register.</p>
            </div>

            <div>
              <label className={labelClass}>Quantity <span className="text-red-500">*</span></label>
              <input
                type="number" step="0.001" min="0" className={inputClass} value={form.quantity}
                onChange={(e) => set('quantity', e.target.value)}
                placeholder="24.8" disabled={!editable}
              />
            </div>
            <div>
              <label className={labelClass}>UOM <span className="text-red-500">*</span></label>
              <CustomSelect
                value={form.uom}
                onChange={(e) => set('uom', e.target.value)}
                disabled={!editable}
              >
                {UOM_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
              </CustomSelect>
            </div>

            <div className="sm:col-span-2">
              <label className={labelClass}>Remarks</label>
              <textarea
                rows={2} className={inputClass} value={form.remarks}
                onChange={(e) => set('remarks', e.target.value)}
                placeholder="Any note the gate operator wants to capture (optional)" disabled={!editable}
              />
            </div>

            {isEdit && createdByName && (
              <div className="sm:col-span-2 text-[11px] text-slate-500">
                First recorded by <span className="font-medium text-slate-700">{createdByName}</span>.
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
            <button
              onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/production/gate-register')}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200"
            >
              <ArrowLeft size={14} /> Back
            </button>
            {editable && (
              <button
                onClick={handleSave} disabled={saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-60"
              >
                {saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />}
                {isEdit ? 'Save changes' : 'Save entry'}
              </button>
            )}
            {isEdit && canDelete('Gate Register') && (
              <button
                onClick={handleDelete}
                className="ml-auto inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg"
              >
                <Trash2 size={14} /> Remove entry
              </button>
            )}
          </div>
        </div>
      )}
    </MainLayout>
  );
}
