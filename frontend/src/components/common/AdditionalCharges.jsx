import { Plus, Trash2 } from 'lucide-react';
import CustomSelect from '@/components/ui/CustomSelect';

// Preset charge types; "OTHER" reveals a free-text label input so the user can
// record any one-off charge with a unique name.
export const CHARGE_TYPES = [
  { value: 'SHIPPING', label: 'Shipping Charges' },
  { value: 'COURIER', label: 'Courier Charges' },
  { value: 'PACKING', label: 'Packing Charges' },
  { value: 'HANDLING', label: 'Handling Charges' },
  { value: 'INSURANCE', label: 'Insurance' },
  { value: 'OTHER', label: 'Other (specify)' },
];

export const blankCharge = () => ({ type: 'SHIPPING', label: '', amount: '', add_to_total: true });

// Sum of charges the user flagged to roll into the document total.
export const sumAddToTotal = (charges = []) =>
  (charges || []).reduce((s, c) => s + (c.add_to_total ? (parseFloat(c.amount) || 0) : 0), 0);

// Any charge carrying a positive amount — gates the mandatory remarks.
export const chargesHaveValue = (charges = []) =>
  (charges || []).some(c => parseFloat(c.amount) > 0);

/**
 * Reusable "Additional Charges" block — a charge-type dropdown (with a custom
 * "Other" label), an amount, and an "Add to total" toggle per row. When any
 * charge has a value, a mandatory Remarks field appears.
 *
 * Controlled: pass `charges` (array) + `remarks` (string); receive updates via
 * `onChange({ charges, remarks })`. Use `sumAddToTotal(charges)` to fold the
 * flagged charges into the host's grand total.
 */
export default function AdditionalCharges({ charges = [], remarks = '', onChange, currencySymbol = '₹', className = '' }) {
  const update = (nextCharges, nextRemarks = remarks) => onChange?.({ charges: nextCharges, remarks: nextRemarks });
  const setRow = (idx, field, value) => update(charges.map((c, i) => (i === idx ? { ...c, [field]: value } : c)));
  const addRow = () => update([...charges, blankCharge()]);
  const removeRow = (idx) => update(charges.filter((_, i) => i !== idx));

  const addToTotal = sumAddToTotal(charges);

  return (
    <div className={`bg-white rounded-lg border border-slate-200 p-2.5 sm:p-3 ${className}`}>
      <div className="flex items-center justify-between mb-2 pb-1 border-b">
        <h3 className="text-xs font-semibold text-slate-800">Additional Charges</h3>
        <button type="button" onClick={addRow} className="flex items-center gap-1 px-2 py-1 text-xs text-primary-600 border border-primary-300 rounded hover:bg-primary-50">
          <Plus size={13} /> Add Charge
        </button>
      </div>

      {charges.length === 0 ? (
        <p className="text-[10px] text-slate-400">No additional charges. Click "Add Charge" to record shipping, courier or other charges.</p>
      ) : (
        <div className="space-y-1.5">
          {charges.map((c, idx) => (
            <div key={idx} className="flex flex-wrap items-center gap-1.5">
              <CustomSelect value={c.type} onChange={(e) => setRow(idx, 'type', e.target.value)} className="border border-slate-300 rounded px-2 py-1 text-xs min-w-[140px]">
                {CHARGE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </CustomSelect>
              {c.type === 'OTHER' && (
                <input type="text" value={c.label} onChange={(e) => setRow(idx, 'label', e.target.value)} placeholder="Charge name" className="border border-slate-300 rounded px-2 py-1 text-xs flex-1 min-w-[100px]" />
              )}
              <div className="relative">
                <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs">{currencySymbol}</span>
                <input type="number" min="0" step="any" value={c.amount} onChange={(e) => setRow(idx, 'amount', e.target.value)} placeholder="0.00" className="border border-slate-300 rounded pl-5 pr-2 py-1 text-xs w-28 text-right" />
              </div>
              <label className="flex items-center gap-1 text-[10px] text-slate-600 cursor-pointer select-none">
                <input type="checkbox" checked={!!c.add_to_total} onChange={(e) => setRow(idx, 'add_to_total', e.target.checked)} className="rounded border-slate-300 text-primary-600 focus:ring-primary-500 w-3.5 h-3.5" />
                Add to total
              </label>
              {idx === 0 && chargesHaveValue(charges) && (
                <input type="text" value={remarks} onChange={(e) => update(charges, e.target.value)}
                  placeholder="Charges remarks (required)"
                  className="border border-slate-300 rounded px-2 py-1 text-xs w-[40%] focus:ring-1 focus:ring-primary-500 focus:border-primary-500" />
              )}
              <button type="button" onClick={() => removeRow(idx)} className="p-0.5 text-red-500 hover:bg-red-50 rounded" title="Remove"><Trash2 size={13} /></button>
            </div>
          ))}
          {addToTotal > 0 && (
            <p className="text-[10px] text-slate-500">{currencySymbol}{addToTotal.toFixed(2)} will be added to the total. Unchecked charges are kept for the record only.</p>
          )}
        </div>
      )}
    </div>
  );
}
