import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import CustomSelect from '../../../../components/ui/CustomSelect';
import apiClient from '../../../../utils/api.js';
import { getApiErrorMessage } from '../../../../utils/formHelpers.js';

const inputClass = 'w-full px-2 py-1 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const readOnlyClass = `${inputClass} bg-slate-100 cursor-not-allowed text-slate-700`;

const ASSAY_UNITS = [
  { value: 'PPM', label: 'PPM' },
  { value: 'PERCENTAGE', label: '%' },
];
const AZA_STATUSES = [
  { value: 'TESTED', label: 'Tested' },
  { value: 'ESTIMATED', label: 'Estimated' },
  { value: 'ASSUMED_ZERO', label: 'Assumed 0' },
  { value: 'NOT_TESTED', label: 'Not tested' },
];

const computeAza = (weight, val, unit) => {
  const w = Number(weight) || 0;
  const v = Number(val) || 0;
  if (unit === 'PPM') return w * v / 1_000_000;
  if (unit === 'PERCENTAGE') return w * v / 100;
  return 0;
};

/**
 * SpentKernelForm — compact form embedded under the SLE Washes panel.
 * One SpentKernel row per batch. Matches Excel report cols AB (ppm)
 * + AC (Qty).
 */
export default function SpentKernelForm({ batchId, onSaved, readOnly = false }) {
  const [existing, setExisting] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    quantity_kg: '', moisture_pct: '',
    assay_value_entered: '', assay_unit_entered: 'PPM',
    aza_status: 'TESTED', disposal_details: '',
  });

  useEffect(() => {
    if (!batchId) return;
    // Fetch both the existing Spent Kernel (if any) and the batch's
    // Kernel Input so we can pre-fill Qty from adjusted_kernel_kg
    // when no Spent Kernel exists yet — typical case is spent kernel
    // weight equals the adjusted kernel input weight.
    Promise.all([
      apiClient.get(`/api/production/extraction-spent-kernels/?batch=${batchId}`),
      apiClient.get(`/api/production/extraction-kernel-inputs/?batch=${batchId}`),
    ]).then(([spentRes, kernelRes]) => {
      const rows = spentRes.data?.results || spentRes.data || [];
      const kernels = kernelRes.data?.results || kernelRes.data || [];
      const kernelInput = kernels[0];

      // Backend DecimalField(decimal_places=N) round-trips "4750.000"
      // — parseFloat + String drops the trailing zeros so the form
      // shows a clean "4750".
      const cleanNum = (v) => {
        if (v === null || v === undefined || v === '') return '';
        const n = parseFloat(v);
        return Number.isFinite(n) ? String(n) : '';
      };
      if (rows.length) {
        const r = rows[0];
        setExisting(r);
        setForm({
          quantity_kg: cleanNum(r.quantity_kg),
          moisture_pct: cleanNum(r.moisture_pct),
          assay_value_entered: cleanNum(r.assay_value_entered),
          assay_unit_entered: r.assay_unit_entered || 'PPM',
          aza_status: r.aza_status || 'TESTED',
          disposal_details: r.disposal_details || '',
        });
      } else if (kernelInput?.adjusted_kernel_kg) {
        // Pre-fill Qty from the batch's adjusted kernel weight so the
        // operator doesn't have to look it up and retype it. They can
        // still edit before saving if the actual spent weight differs.
        setForm((f) => ({
          ...f,
          quantity_kg: cleanNum(kernelInput.adjusted_kernel_kg),
        }));
      }
    });
  }, [batchId]);

  const update = (field) => (val) => setForm((f) => ({ ...f, [field]: val }));
  const previewAza = computeAza(form.quantity_kg, form.assay_value_entered, form.assay_unit_entered);

  const handleSave = async () => {
    if (!form.quantity_kg) return toast.error('Quantity required.');
    setSaving(true);
    try {
      const payload = { batch: batchId, ...form };
      let res;
      if (existing) {
        res = await apiClient.patch(`/api/production/extraction-spent-kernels/${existing.id}/`, payload);
      } else {
        res = await apiClient.post('/api/production/extraction-spent-kernels/', payload);
      }
      setExisting(res.data);
      toast.success(existing ? 'Spent kernel updated.' : 'Spent kernel saved.');
      onSaved?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 pt-4 border-t border-slate-200">
      <h4 className="text-sm font-semibold text-slate-700 mb-3">Spent Kernel (SLE residue)</h4>
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Qty (kg) *</label>
          <input type="number" step="0.001" min="0" value={form.quantity_kg}
            onChange={(e) => update('quantity_kg')(e.target.value)}
            className={inputClass} placeholder="4720.5"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Moisture % <span className="text-slate-400 font-normal">(optional, reference only)</span>
          </label>
          <input type="number" step="0.01" min="0" max="100" value={form.moisture_pct}
            onChange={(e) => update('moisture_pct')(e.target.value)}
            className={inputClass}
            title="Moisture content of the discarded spent kernel — kept for reference / GMP records. Does NOT feed into any calc (residual aza uses Qty × Assay directly)."
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Assay</label>
          <input type="number" step="0.001" min="0" value={form.assay_value_entered}
            onChange={(e) => update('assay_value_entered')(e.target.value)}
            className={inputClass} placeholder="84"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Unit</label>
          <CustomSelect
            name="assay_unit_entered" value={form.assay_unit_entered}
            onChange={(e) => update('assay_unit_entered')(e.target.value)}
            className={inputClass}
          >
            {ASSAY_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
          </CustomSelect>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Residual Aza (kg) <span className="text-slate-400">auto</span>
          </label>
          <input type="text" readOnly value={previewAza ? previewAza.toFixed(6) : '—'}
            className={readOnlyClass}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Status</label>
          <CustomSelect
            name="aza_status" value={form.aza_status}
            onChange={(e) => update('aza_status')(e.target.value)}
            className={inputClass}
          >
            {AZA_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </CustomSelect>
        </div>
      </div>
      {!readOnly && (
        <div className="mt-3 flex justify-end">
          <button
            onClick={handleSave} disabled={saving}
            className="px-3 py-1.5 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg disabled:opacity-50"
          >
            {saving ? 'Saving…' : existing ? 'Update Spent Kernel' : 'Save Spent Kernel'}
          </button>
        </div>
      )}
    </div>
  );
}
