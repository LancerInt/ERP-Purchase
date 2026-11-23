import CustomSelect from "@/components/ui/CustomSelect";
import { useState } from 'react';
import toast from 'react-hot-toast';

// Two-letter ISO 3166-2:IN codes. Kept in sync with the backend
// state_resolver.STATE_NAMES — adding a code here without adding it
// there means the resolver can't pick the corresponding line during
// CPO extraction.
export const INDIA_STATE_OPTIONS = [
  { code: 'AP', name: 'Andhra Pradesh' },
  { code: 'AR', name: 'Arunachal Pradesh' },
  { code: 'AS', name: 'Assam' },
  { code: 'BR', name: 'Bihar' },
  { code: 'CG', name: 'Chhattisgarh' },
  { code: 'GA', name: 'Goa' },
  { code: 'GJ', name: 'Gujarat' },
  { code: 'HR', name: 'Haryana' },
  { code: 'HP', name: 'Himachal Pradesh' },
  { code: 'JH', name: 'Jharkhand' },
  { code: 'KA', name: 'Karnataka' },
  { code: 'KL', name: 'Kerala' },
  { code: 'MP', name: 'Madhya Pradesh' },
  { code: 'MH', name: 'Maharashtra' },
  { code: 'MN', name: 'Manipur' },
  { code: 'ML', name: 'Meghalaya' },
  { code: 'MZ', name: 'Mizoram' },
  { code: 'NL', name: 'Nagaland' },
  { code: 'OD', name: 'Odisha' },
  { code: 'PB', name: 'Punjab' },
  { code: 'RJ', name: 'Rajasthan' },
  { code: 'SK', name: 'Sikkim' },
  { code: 'TN', name: 'Tamil Nadu' },
  { code: 'TG', name: 'Telangana' },
  { code: 'TR', name: 'Tripura' },
  { code: 'UP', name: 'Uttar Pradesh' },
  { code: 'UK', name: 'Uttarakhand' },
  { code: 'WB', name: 'West Bengal' },
  { code: 'AN', name: 'Andaman and Nicobar' },
  { code: 'CH', name: 'Chandigarh' },
  { code: 'DN', name: 'Dadra and Nagar Haveli' },
  { code: 'DD', name: 'Daman and Diu' },
  { code: 'DL', name: 'Delhi' },
  { code: 'JK', name: 'Jammu and Kashmir' },
  { code: 'LA', name: 'Ladakh' },
  { code: 'LD', name: 'Lakshadweep' },
  { code: 'PY', name: 'Puducherry' },
];

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

const REGION_OPTIONS = [
  ['',          '— None —'],
  ['SOUTH',     'South'],
  ['NORTH',     'North'],
  ['EAST',      'East'],
  ['WEST',      'West'],
  ['NORTHEAST', 'North-East'],
  ['CENTRAL',   'Central'],
  ['PAN_INDIA', 'Pan India'],
];

/**
 * Shared form used by both new + edit pages. Renders the name / region
 * / notes inputs plus a checkbox grid for picking member states.
 * `value` is the current form state, `onChange(next)` is called with
 * the next state object on every edit.
 */
export default function StateGroupForm({ value, onChange }) {
  const toggleState = (code) => {
    const set = new Set(value.member_states || []);
    if (set.has(code)) set.delete(code); else set.add(code);
    onChange({ ...value, member_states: Array.from(set) });
  };

  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            required
            className={inputClass}
            placeholder="e.g. Tamilnadu, Pondicherry & Karnataka"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Region</label>
          <CustomSelect
            value={value.region || ''}
            onChange={(e) => onChange({ ...value, region: e.target.value })}
            className={inputClass}
          >
            {REGION_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </CustomSelect>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">
          Member States <span className="text-red-500">*</span>
          <span className="ml-2 text-xs text-slate-500">
            ({(value.member_states || []).length} selected)
          </span>
        </label>
        <div className="border border-slate-200 rounded-lg p-3 max-h-64 overflow-y-auto grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 bg-slate-50">
          {INDIA_STATE_OPTIONS.map(({ code, name }) => {
            const checked = (value.member_states || []).includes(code);
            return (
              <label key={code} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-white px-2 py-1 rounded">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleState(code)}
                  className="rounded"
                />
                <span className="font-mono text-xs text-slate-500">{code}</span>
                <span className="text-slate-700">{name}</span>
              </label>
            );
          })}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
        <textarea
          value={value.notes || ''}
          onChange={(e) => onChange({ ...value, notes: e.target.value })}
          rows={3}
          className={inputClass}
        />
      </div>
    </div>
  );
}

export function validateStateGroup(v) {
  if (!v.name || !v.name.trim()) {
    toast.error('Name is required');
    return false;
  }
  if (!v.member_states || v.member_states.length === 0) {
    toast.error('Pick at least one state');
    return false;
  }
  return true;
}
