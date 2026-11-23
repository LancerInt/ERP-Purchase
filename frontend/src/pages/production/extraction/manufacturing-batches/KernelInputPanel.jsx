import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import CustomSelect from '../../../../components/ui/CustomSelect';
import CustomDatePicker from '../../../../components/ui/CustomDatePicker';
import CustomTimePicker from '../../../../components/ui/CustomTimePicker';
import apiClient from '../../../../utils/api.js';
import { getApiErrorMessage } from '../../../../utils/formHelpers.js';
import usePermissions from '../../../../hooks/usePermissions.js';

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const readOnlyClass = `${inputClass} bg-slate-100 cursor-not-allowed text-slate-700`;

const ASSAY_UNIT_OPTIONS = [
  { value: 'PERCENTAGE', label: 'Percentage (%)' },
  { value: 'DECIMAL',    label: 'Decimal fraction' },
  { value: 'PPM',        label: 'Parts per million (PPM)' },
];

const AZA_STATUS_OPTIONS = [
  { value: 'TESTED',       label: 'Tested' },
  { value: 'ESTIMATED',    label: 'Estimated' },
  { value: 'ASSUMED_ZERO', label: 'Assumed zero' },
  { value: 'NOT_TESTED',   label: 'Not tested' },
];

/**
 * KernelInputPanel — embedded on the batch detail page.
 *
 * Fetches the batch's KernelInput (if any) via ?batch=<id>. If none
 * exists, shows the empty form; otherwise pre-fills for editing.
 *
 * Live-computes the three derived fields as the user types so they
 * see the result BEFORE saving; server recomputes on save for authority.
 *
 * Formulas (Section 7.4 / 7.6 / 7.7):
 *   adjusted_kernel_kg = gross_kernel_kg * (1 - (adm + moi) / 100)
 *   assay_decimal      = value / 100  (%)   OR value / 1_000_000  (ppm)   OR value  (decimal)
 *   initial_aza_kg     = adjusted_kernel_kg * assay_decimal
 */
export default function KernelInputPanel({ batchId, batch, onSaved, readOnly = false }) {
  const { canEdit, canCreate } = usePermissions();
  const editable = !readOnly && (canEdit('Manufacturing Batch') || canCreate('Manufacturing Batch'));

  const [existing, setExisting] = useState(null);  // KernelInput row if it exists
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Server-generated NK-YYYY-NNNN preview populated on load for new
  // batches so the field isn't blank (which invites operators to type
  // over it and break the sequence). Compared on save — if the value
  // is unchanged, we send blank and let the server generate fresh
  // (avoids a race with any concurrent operator loading the same
  // preview).
  const [autoLotPreview, setAutoLotPreview] = useState('');
  const [formData, setFormData] = useState({
    kernel_lot_no: '',
    supplier: '',
    received_on: '',
    gross_kernel_kg: '',
    admixture_pct: '',
    moisture_pct: '',
    assay_value_entered: '',
    assay_unit_entered: 'PERCENTAGE',
    aza_status: 'TESTED',
    sample_no: '',
    sampled_at: '',
    lab_tested_on: '',
    remarks: '',
  });

  // Load existing kernel input for this batch, if any.
  useEffect(() => {
    if (!batchId) return;
    let cancelled = false;
    setLoading(true);
    apiClient.get(`/api/production/extraction-kernel-inputs/?batch=${batchId}`)
      .then((res) => {
        if (cancelled) return;
        const rows = Array.isArray(res.data) ? res.data : (res.data?.results || []);
        if (rows.length) {
          const k = rows[0];
          setExisting(k);
          // Backend DecimalField(decimal_places=N) round-trips
          // "5000.000" — parseFloat + String drops the trailing
          // zeros so the form shows a clean "5000".
          const cleanNum = (v) => {
            if (v === null || v === undefined || v === '') return '';
            const n = parseFloat(v);
            return Number.isFinite(n) ? String(n) : '';
          };
          setFormData({
            kernel_lot_no: k.kernel_lot_no || '',
            supplier: k.supplier || '',
            received_on: k.received_on || '',
            gross_kernel_kg: cleanNum(k.gross_kernel_kg),
            admixture_pct: cleanNum(k.admixture_pct),
            moisture_pct: cleanNum(k.moisture_pct),
            assay_value_entered: cleanNum(k.assay_value_entered),
            assay_unit_entered: k.assay_unit_entered || 'PERCENTAGE',
            aza_status: k.aza_status || 'TESTED',
            sample_no: k.sample_no || '',
            sampled_at: k.sampled_at ? k.sampled_at.slice(0, 16) : '',
            lab_tested_on: k.lab_tested_on || '',
            remarks: k.remarks || '',
          });
        } else {
          // No existing KernelInput yet — this is the first save. Two
          // convenience prefills before the operator touches anything:
          //   1) Gross Kernel from the batch header's planned qty
          //      (weighbridge often differs by a small margin but the
          //      plan is a good starting point).
          //   2) Kernel Lot No preview from the server so the field
          //      isn't blank (an empty field invited operators to
          //      type over it and break the NK-YYYY-NNNN sequence).
          //      The preview goes into both formData and the
          //      autoLotPreview slot; if it's still unchanged at save
          //      time we send blank so the server generates fresh
          //      (no race with concurrent operators loading the
          //      same preview).
          const patch = {};
          if (batch?.planned_kernel_qty_kg) {
            patch.gross_kernel_kg = String(batch.planned_kernel_qty_kg);
          }
          apiClient.get('/api/production/extraction-kernel-inputs/next-lot-no/')
            .then((r) => {
              const next = r?.data?.next_lot_no || '';
              if (cancelled || !next) return;
              setAutoLotPreview(next);
              setFormData((f) => ({ ...f, ...patch, kernel_lot_no: next }));
            })
            .catch(() => {
              // Preview is optional — if the endpoint fails, fall back
              // to the old placeholder behaviour (blank field).
              if (!cancelled && Object.keys(patch).length) {
                setFormData((f) => ({ ...f, ...patch }));
              }
            });
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [batchId, batch?.planned_kernel_qty_kg]);

  const update = (field) => (val) => setFormData((f) => ({ ...f, [field]: val }));

  // Live-computed preview values — matches the server-side formula.
  const derived = useMemo(() => {
    const gross = Number(formData.gross_kernel_kg) || 0;
    const adm   = Number(formData.admixture_pct) || 0;
    const moi   = Number(formData.moisture_pct) || 0;
    const val   = Number(formData.assay_value_entered) || 0;
    const unit  = formData.assay_unit_entered;

    const adjusted = gross > 0 ? gross * (1 - (adm + moi) / 100) : 0;
    let assayDec = 0;
    if (unit === 'PERCENTAGE') assayDec = val / 100;
    else if (unit === 'PPM')   assayDec = val / 1_000_000;
    else if (unit === 'DECIMAL') assayDec = val;
    const azaKg = adjusted * assayDec;
    return {
      adjusted_kernel_kg: adjusted,
      assay_decimal: assayDec,
      initial_aza_kg: azaKg,
    };
  }, [formData]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    // kernel_lot_no is optional at the API level — server auto-fills
    // `NK-{YYYY}-{NNNN}` when left blank.
    if (!formData.gross_kernel_kg) return toast.error('Gross kernel quantity is required.');

    setSaving(true);
    try {
      // If the operator never overrode the auto-generated preview,
      // send blank so the server generates a fresh number at save
      // time. Guards against a race where two operators loaded the
      // same preview and only one save can win the unique constraint.
      // If the value was manually edited (supplier's own lot), send
      // it as-is.
      const lotToSend = (
        autoLotPreview && formData.kernel_lot_no === autoLotPreview
          ? ''
          : (formData.kernel_lot_no || '')
      );
      const payload = {
        batch: batchId,
        kernel_lot_no: lotToSend,  // server auto-fills if blank on create
        supplier: formData.supplier || '',
        received_on: formData.received_on || null,
        gross_kernel_kg: formData.gross_kernel_kg,
        admixture_pct: formData.admixture_pct || 0,
        moisture_pct: formData.moisture_pct || 0,
        assay_value_entered: formData.assay_value_entered || null,
        assay_unit_entered: formData.assay_unit_entered || '',
        aza_status: formData.aza_status,
        sample_no: formData.sample_no || '',
        sampled_at: formData.sampled_at || null,
        lab_tested_on: formData.lab_tested_on || null,
        remarks: formData.remarks || '',
      };
      let res;
      if (existing) {
        res = await apiClient.patch(`/api/production/extraction-kernel-inputs/${existing.id}/`, payload);
      } else {
        res = await apiClient.post('/api/production/extraction-kernel-inputs/', payload);
      }
      toast.success(existing ? 'Kernel input updated.' : 'Kernel input saved.');
      setExisting(res.data);
      onSaved?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to save kernel input.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="text-sm text-slate-500 p-4 sm:p-5">Loading kernel input…</div>;
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Kernel Lot No
          </label>
          <input
            type="text" value={formData.kernel_lot_no} disabled={!editable}
            onChange={(e) => update('kernel_lot_no')(e.target.value)}
            className={editable ? inputClass : readOnlyClass}
            placeholder="NK-YYYY-NNNN"
          />
          <p className="text-xs text-slate-500 mt-1">
            {autoLotPreview && formData.kernel_lot_no === autoLotPreview
              ? 'Auto-generated preview — the final number is assigned on save. Overwrite here if you have the supplier\'s actual lot number.'
              : 'Overwrite with the supplier\'s actual lot number, or leave the auto-generated NK-YYYY-NNNN in place.'}
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Supplier</label>
          <input
            type="text" value={formData.supplier} disabled={!editable}
            onChange={(e) => update('supplier')(e.target.value)}
            className={editable ? inputClass : readOnlyClass}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Received On</label>
          <CustomDatePicker
            name="received_on"
            value={formData.received_on}
            disabled={!editable}
            onChange={(e) => update('received_on')(e.target.value)}
            className={editable ? inputClass : readOnlyClass}
          />
        </div>
      </div>

      <div className="border-t border-slate-100 pt-5">
        <h4 className="text-sm font-semibold text-slate-700 mb-3">Kernel Adjustment (Section 7.4)</h4>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Gross Kernel Qty (kg) <span className="text-red-500">*</span>
            </label>
            <input
              type="number" step="0.001" min="0.001" value={formData.gross_kernel_kg}
              disabled={!editable}
              onChange={(e) => update('gross_kernel_kg')(e.target.value)}
              className={editable ? inputClass : readOnlyClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Admixture (%)</label>
            <input
              type="number" step="0.01" min="0" max="100" value={formData.admixture_pct}
              disabled={!editable}
              onChange={(e) => update('admixture_pct')(e.target.value)}
              className={editable ? inputClass : readOnlyClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Moisture (%)</label>
            <input
              type="number" step="0.01" min="0" max="100" value={formData.moisture_pct}
              disabled={!editable}
              onChange={(e) => update('moisture_pct')(e.target.value)}
              className={editable ? inputClass : readOnlyClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Adjusted Kernel (kg) <span className="text-xs text-slate-400">auto</span>
            </label>
            <input
              type="text" readOnly
              value={derived.adjusted_kernel_kg ? derived.adjusted_kernel_kg.toFixed(3) : '—'}
              className={readOnlyClass}
            />
          </div>
        </div>
      </div>

      <div className="border-t border-slate-100 pt-5">
        <h4 className="text-sm font-semibold text-slate-700 mb-3">Azadirachtin Assay (Section 7.5–7.7)</h4>
        {/* 5-column on wide screens so the two derived fields
            (Assay Decimal + Initial Aza) sit side-by-side with the
            three inputs above them. Stacks to 2-col on medium and
            1-col on mobile. Matches the "input, input, input, auto"
            rhythm of the Kernel Adjustment row above. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Assay Value</label>
            <input
              type="number" step="0.000001" min="0" value={formData.assay_value_entered}
              disabled={!editable}
              onChange={(e) => update('assay_value_entered')(e.target.value)}
              className={editable ? inputClass : readOnlyClass}
              placeholder="e.g. 0.2549"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Assay Unit</label>
            <CustomSelect
              name="assay_unit_entered"
              value={formData.assay_unit_entered}
              onChange={(e) => update('assay_unit_entered')(e.target.value)}
              disabled={!editable}
              className={editable ? inputClass : readOnlyClass}
            >
              {ASSAY_UNIT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </CustomSelect>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Aza Status</label>
            <CustomSelect
              name="aza_status"
              value={formData.aza_status}
              onChange={(e) => update('aza_status')(e.target.value)}
              disabled={!editable}
              className={editable ? inputClass : readOnlyClass}
            >
              {AZA_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </CustomSelect>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Assay Decimal <span className="text-xs text-slate-400">auto</span>
            </label>
            <input
              type="text" readOnly
              value={derived.assay_decimal ? derived.assay_decimal.toExponential(4) : '—'}
              className={readOnlyClass}
              title="Normalized kg-aza per kg-material — derived from Assay Value + Unit."
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Initial Aza (kg) <span className="text-xs text-slate-400">auto</span>
            </label>
            <input
              type="text" readOnly
              value={derived.initial_aza_kg ? derived.initial_aza_kg.toFixed(6) : '—'}
              className={readOnlyClass}
              title="Adjusted Kernel × Assay Decimal."
            />
          </div>
        </div>
      </div>

      <div className="border-t border-slate-100 pt-5">
        <h4 className="text-sm font-semibold text-slate-700 mb-3">Sample &amp; Lab</h4>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Sample No</label>
            <input
              type="text" value={formData.sample_no} disabled={!editable}
              onChange={(e) => update('sample_no')(e.target.value)}
              className={editable ? inputClass : readOnlyClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Sampled At</label>
            {/* CustomDatePicker for the date half + a small native time
                input for the time half — matches the rest of the app's
                date-picker UX. Halves are split/joined on read/write
                so the stored form remains "YYYY-MM-DDTHH:MM" per the
                backend's DateTimeField. */}
            {(() => {
              const v = formData.sampled_at || '';
              const [d, t] = String(v).split('T');
              const date = d || '';
              const time = (t || '').slice(0, 5);
              const join = (dd, tt) => dd ? `${dd}T${(tt || '00:00').slice(0, 5)}` : '';
              return (
                <div className="flex gap-1.5">
                  <CustomDatePicker
                    value={date}
                    onChange={(e) => update('sampled_at')(join(e.target.value, time))}
                    disabled={!editable}
                    className={`flex-1 ${editable ? 'border border-slate-300 rounded-lg px-3 py-2 text-sm' : `${readOnlyClass}`}`}
                  />
                  <CustomTimePicker
                    value={time} disabled={!editable}
                    onChange={(e) => update('sampled_at')(join(date, e.target.value))}
                    className="w-28"
                  />
                </div>
              );
            })()}
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Lab Tested On</label>
            <CustomDatePicker
              name="lab_tested_on"
              value={formData.lab_tested_on}
              disabled={!editable}
              onChange={(e) => update('lab_tested_on')(e.target.value)}
              className={editable ? inputClass : readOnlyClass}
            />
          </div>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Remarks</label>
        <textarea
          rows={3} value={formData.remarks} disabled={!editable}
          onChange={(e) => update('remarks')(e.target.value)}
          className={editable ? inputClass : readOnlyClass}
        />
      </div>

      {editable && (
        <div className="flex justify-end pt-2">
          <button
            type="submit" disabled={saving}
            className="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg disabled:opacity-50"
          >
            {saving ? 'Saving…' : existing ? 'Update Kernel Input' : 'Save Kernel Input'}
          </button>
        </div>
      )}
    </form>
  );
}
