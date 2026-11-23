import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Trash2 } from 'lucide-react';

import CustomSelect from '../../../../components/ui/CustomSelect';
import CustomDatePicker from '../../../../components/ui/CustomDatePicker';
import CustomTimePicker from '../../../../components/ui/CustomTimePicker';
import apiClient from '../../../../utils/api.js';
import { getApiErrorMessage } from '../../../../utils/formHelpers.js';
import { confirm } from '../../../../components/common/confirm';

// Split a "YYYY-MM-DDTHH:MM" datetime string into its date and time
// halves so we can drive a CustomDatePicker (date) + native time input
// pair from a single stored value. Empty string in → both empty out.
const _splitDT = (v) => {
  if (!v) return { date: '', time: '' };
  const [d, t] = String(v).split('T');
  return { date: d || '', time: (t || '').slice(0, 5) };
};

// Recombine the two halves back into the "YYYY-MM-DDTHH:MM" shape the
// backend TimingFieldsMixin expects. If only the date is set, defaults
// the time to 00:00 so the field round-trips as a valid datetime.
const _joinDT = (date, time) => {
  if (!date) return '';
  return `${date}T${(time || '00:00').slice(0, 5)}`;
};

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const readOnlyClass = `${inputClass} bg-slate-100 cursor-not-allowed text-slate-700`;

const ASSAY_UNITS = [
  { value: 'PERCENTAGE', label: 'Percentage (%)' },
  { value: 'PPM', label: 'PPM' },
  { value: 'DECIMAL', label: 'Decimal' },
];
const AZA_STATUSES = [
  { value: 'TESTED', label: 'Tested' },
  { value: 'ESTIMATED', label: 'Estimated' },
  { value: 'ASSUMED_ZERO', label: 'Assumed zero' },
  { value: 'NOT_TESTED', label: 'Not tested' },
];

const computeAza = (weight, val, unit) => {
  const w = Number(weight) || 0;
  const v = Number(val) || 0;
  if (unit === 'PPM') return w * v / 1_000_000;
  if (unit === 'PERCENTAGE') return w * v / 100;
  if (unit === 'DECIMAL') return w * v;
  return 0;
};

/**
 * Shared panel for FFE and ATFE runs, differentiated by `stage` prop.
 *
 * Shows a list of existing runs on this batch + a form to create one.
 * Feed selection is a checkbox list of available LLE (for FFE) or FFE
 * (for ATFE) rows for this batch. Feed totals auto-compute + display
 * before save.
 */
export default function FFEATFEPanel({ batchId, batch, stage, onSaved, readOnly = false }) {
  // stage: 'ffe' or 'atfe'
  const isFFE = stage === 'ffe';
  const label = isFFE ? 'FFE' : 'ATFE';
  const endpoint = isFFE ? 'extraction-ffe-runs' : 'extraction-atfe-runs';
  const feedEndpoint = isFFE ? 'extraction-lle-washes' : 'extraction-ffe-runs';
  const feedField = isFFE ? 'source_lle_wash_ids' : 'source_ffe_run_ids';

  const [runs, setRuns] = useState([]);
  const [feeds, setFeeds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selectedFeedIds, setSelectedFeedIds] = useState([]);

  const emptyDraft = {
    // Operational details — every FFE/ATFE run is expected to capture
    // start/end + equipment for the batch report (Section 19.1 timing).
    equipment: '',
    started_at: '',
    ended_at: '',
    // For FFE the output is "concentrate_*", for ATFE it's "product_*"
    output_volume_l: '',
    output_specific_gravity: '',
    output_weight: '',
    output_assay_value: '',
    output_assay_unit: 'PERCENTAGE',
    output_aza_status: 'TESTED',
    recovered_solvent_kg: '',
    cleaning_recovery_kg: '',
    remarks: '',
  };
  const [draft, setDraft] = useState(emptyDraft);

  const load = async () => {
    setLoading(true);
    try {
      const [runsRes, feedsRes] = await Promise.all([
        apiClient.get(`/api/production/${endpoint}/?warehouse=${batch.warehouse}`),
        apiClient.get(isFFE
          ? `/api/production/${feedEndpoint}/?batch=${batchId}`
          : `/api/production/${feedEndpoint}/?warehouse=${batch.warehouse}`),
      ]);
      setRuns(runsRes.data?.results || runsRes.data || []);
      setFeeds(feedsRes.data?.results || feedsRes.data || []);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { if (batchId && batch?.warehouse) load(); }, [batchId, batch?.warehouse]);

  const updateDraft = (field) => (val) => setDraft((d) => ({ ...d, [field]: val }));

  const toggleFeed = (id) => {
    setSelectedFeedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  const feedTotal = useMemo(() => {
    const rows = feeds.filter((f) => selectedFeedIds.includes(f.id));
    const wKey = isFFE ? 'weight_kg' : 'concentrate_weight_kg';
    const aKey = isFFE ? 'aza_kg' : 'concentrate_aza_kg';
    return {
      weight: rows.reduce((s, r) => s + Number(r[wKey] || 0), 0),
      aza: rows.reduce((s, r) => s + Number(r[aKey] || 0), 0),
    };
  }, [feeds, selectedFeedIds, isFFE]);

  const draftAza = computeAza(draft.output_weight, draft.output_assay_value, draft.output_assay_unit);

  const handleCreate = async () => {
    if (selectedFeedIds.length === 0) return toast.error(`Select at least one ${isFFE ? 'LLE wash' : 'FFE run'} as feed.`);
    if (!draft.output_weight) return toast.error(`${isFFE ? 'Concentrate' : 'Product'} weight required.`);

    setSaving(true);
    try {
      const payload = {
        warehouse: batch.warehouse,
        [feedField]: selectedFeedIds,
        equipment: draft.equipment || '',
        started_at: draft.started_at || null,
        ended_at: draft.ended_at || null,
        recovered_solvent_kg: draft.recovered_solvent_kg || null,
        cleaning_recovery_kg: draft.cleaning_recovery_kg || null,
        remarks: draft.remarks || '',
      };
      if (isFFE) {
        Object.assign(payload, {
          concentrate_weight_kg: draft.output_weight,
          concentrate_volume_l: draft.output_volume_l || null,
          concentrate_specific_gravity: draft.output_specific_gravity || null,
          concentrate_assay_value_entered: draft.output_assay_value || null,
          concentrate_assay_unit_entered: draft.output_assay_unit,
          concentrate_aza_status: draft.output_aza_status,
        });
      } else {
        Object.assign(payload, {
          product_weight_kg: draft.output_weight,
          product_volume_l: draft.output_volume_l || null,
          product_specific_gravity: draft.output_specific_gravity || null,
          product_assay_value_entered: draft.output_assay_value || null,
          product_assay_unit_entered: draft.output_assay_unit,
          product_aza_status: draft.output_aza_status,
          selected_route: 'LIQUID',
        });
      }
      const res = await apiClient.post(`/api/production/${endpoint}/`, payload);
      toast.success(`${res.data.run_no} created.`);
      setCreating(false);
      setSelectedFeedIds([]);
      setDraft(emptyDraft);
      load();
      onSaved?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || `Failed to create ${label} run.`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row) => {
    if (!(await confirm({ message: `Delete ${row.run_no}?` }))) return;
    try {
      await apiClient.delete(`/api/production/${endpoint}/${row.id}/`);
      load();
      onSaved?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete.');
    }
  };

  if (loading) return <div className="text-sm text-slate-500 p-4">Loading {label} runs…</div>;

  return (
    <div>
      <div className="flex justify-between items-baseline mb-3">
        <div className="text-sm text-slate-500">
          {runs.length} {label} run{runs.length !== 1 && 's'} at this warehouse.
        </div>
        {!readOnly && !creating && (
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-lg"
          >
            <Plus size={14} /> New {label} Run
          </button>
        )}
      </div>

      {/* Existing runs list */}
      {runs.length > 0 && (
        <div className="overflow-x-auto border border-slate-200 rounded-lg mb-4">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 uppercase text-[10px]">
              <tr>
                <th className="p-2 text-left">Run No</th>
                <th className="p-2 text-right">Feed (kg)</th>
                <th className="p-2 text-right">Feed Aza (kg)</th>
                <th className="p-2 text-right">Output (kg)</th>
                <th className="p-2 text-right">Output Aza (kg)</th>
                <th className="p-2 text-left">Aza Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="p-2 font-mono">{r.run_no}</td>
                  <td className="p-2 text-right font-mono">{Number(r.total_input_weight_kg || 0).toLocaleString()}</td>
                  <td className="p-2 text-right font-mono">{Number(r.total_input_aza_kg || 0).toFixed(4)}</td>
                  <td className="p-2 text-right font-mono">
                    {Number(isFFE ? r.concentrate_weight_kg : r.product_weight_kg).toLocaleString()}
                  </td>
                  <td className="p-2 text-right font-mono font-semibold text-primary-700">
                    {Number(isFFE ? r.concentrate_aza_kg : r.product_aza_kg).toFixed(4)}
                  </td>
                  <td className="p-2">
                    <span className="text-xs px-2 py-0.5 bg-slate-100 rounded">
                      {isFFE ? r.concentrate_aza_status : r.product_aza_status}
                    </span>
                  </td>
                  <td className="p-2 text-right">
                    {!readOnly && (
                      <button onClick={() => handleDelete(r)} className="p-1 text-slate-400 hover:text-red-600" title="Delete">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create form */}
      {creating && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-4">
          <h4 className="text-sm font-semibold text-slate-700">Create new {label} run</h4>

          {/* Feed selection with a Select-all toggle. `allSelected` is
              true only when every visible feed is in selectedFeedIds
              (so a partial selection shows the box empty and clicking
              selects all — matching the standard tri-state behaviour
              without pulling in an indeterminate style). */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Feed ({isFFE ? 'LLE washes' : 'FFE runs'}) — pick one or more
            </label>
            {feeds.length === 0 ? (
              <div className="text-sm text-slate-400 italic p-3 bg-white border border-slate-200 rounded">
                No {isFFE ? 'LLE washes' : 'FFE runs'} available. Complete the previous stage first.
              </div>
            ) : (
              <>
                {(() => {
                  const allSelected = feeds.length > 0 && feeds.every((f) => selectedFeedIds.includes(f.id));
                  const someSelected = selectedFeedIds.length > 0 && !allSelected;
                  return (
                    <label className="flex items-center gap-2 px-3 py-1.5 mb-1 bg-slate-100 border border-slate-200 rounded text-sm text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(el) => { if (el) el.indeterminate = someSelected; }}
                        onChange={() => setSelectedFeedIds(allSelected ? [] : feeds.map((f) => f.id))}
                      />
                      <span className="font-medium">
                        {allSelected ? 'Clear all' : 'Select all'} ({feeds.length})
                      </span>
                    </label>
                  );
                })()}
                <div className="bg-white border border-slate-200 rounded max-h-40 overflow-y-auto">
                  {feeds.map((f) => {
                    const label_ = isFFE
                      ? `LLE-${f.sle_wash_letter} — ${Number(f.weight_kg).toLocaleString()} kg / ${Number(f.aza_kg).toFixed(4)} kg aza`
                      : `${f.run_no} — ${Number(f.concentrate_weight_kg).toLocaleString()} kg / ${Number(f.concentrate_aza_kg).toFixed(4)} kg aza`;
                    return (
                      <label key={f.id} className="flex items-center gap-2 px-3 py-2 hover:bg-slate-50 cursor-pointer border-b border-slate-100 last:border-b-0">
                        <input
                          type="checkbox"
                          checked={selectedFeedIds.includes(f.id)}
                          onChange={() => toggleFeed(f.id)}
                        />
                        <span className="text-sm">{label_}</span>
                      </label>
                    );
                  })}
                </div>
              </>
            )}
            <p className="text-xs text-slate-500 mt-1">
              Selected: <strong>{selectedFeedIds.length}</strong> · Total feed: <strong>{feedTotal.weight.toLocaleString()} kg</strong> / <strong>{feedTotal.aza.toFixed(4)} kg aza</strong>
            </p>
          </div>

          {/* Operational details — equipment, start/end. Ops fills these
              off the batch report; they land on the FFE/ATFE row via
              the TimingFieldsMixin (Section 19.1). */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Equipment</label>
              <input type="text" value={draft.equipment}
                onChange={(e) => updateDraft('equipment')(e.target.value)}
                className={inputClass} placeholder={isFFE ? 'FFE-1' : 'ATFE-1'}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Started at</label>
              {/* Custom on-brand calendar + a small native time input
                  beside it — matches the date-picker UX used elsewhere
                  in the app (PR/PO/receipt forms). Two halves get
                  joined back to "YYYY-MM-DDTHH:MM" before save. */}
              {(() => {
                const { date, time } = _splitDT(draft.started_at);
                return (
                  <div className="flex gap-1.5">
                    <CustomDatePicker
                      value={date}
                      onChange={(e) => updateDraft('started_at')(_joinDT(e.target.value, time))}
                      className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm"
                    />
                    <CustomTimePicker
                      value={time}
                      onChange={(e) => updateDraft('started_at')(_joinDT(date, e.target.value))}
                      className="w-28"
                    />
                  </div>
                );
              })()}
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Ended at</label>
              {(() => {
                const { date, time } = _splitDT(draft.ended_at);
                return (
                  <div className="flex gap-1.5">
                    <CustomDatePicker
                      value={date}
                      onChange={(e) => updateDraft('ended_at')(_joinDT(e.target.value, time))}
                      className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm"
                    />
                    <CustomTimePicker
                      value={time}
                      onChange={(e) => updateDraft('ended_at')(_joinDT(date, e.target.value))}
                      className="w-28"
                    />
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Output — weight is the aza-driving figure (required).
              Volume + Specific Gravity are captured for the batch
              report but don't feed the aza calc; they help the lab
              cross-check density (weight = volume × SG). */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {isFFE ? 'Concentrate' : 'Product'} volume (L)
                <span className="text-xs text-slate-400 font-normal ml-1">optional</span>
              </label>
              <input type="number" step="0.001" min="0" value={draft.output_volume_l}
                onChange={(e) => updateDraft('output_volume_l')(e.target.value)}
                className={inputClass} placeholder={isFFE ? '85' : '42'}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {isFFE ? 'Concentrate' : 'Product'} weight (kg) *
              </label>
              <input type="number" step="0.001" min="0" value={draft.output_weight}
                onChange={(e) => updateDraft('output_weight')(e.target.value)}
                className={inputClass} placeholder={isFFE ? '102' : '50'}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Specific gravity
                <span className="text-xs text-slate-400 font-normal ml-1">optional</span>
              </label>
              <input type="number" step="0.0001" min="0" value={draft.output_specific_gravity}
                onChange={(e) => updateDraft('output_specific_gravity')(e.target.value)}
                className={inputClass} placeholder={isFFE ? '1.20' : '1.19'}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Assay value</label>
              <input type="number" step="0.0001" min="0" value={draft.output_assay_value}
                onChange={(e) => updateDraft('output_assay_value')(e.target.value)}
                className={inputClass} placeholder={isFFE ? '4.10' : '20.0'}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Unit</label>
              <CustomSelect
                name="output_assay_unit" value={draft.output_assay_unit}
                onChange={(e) => updateDraft('output_assay_unit')(e.target.value)}
                className={inputClass}
              >
                {ASSAY_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
              </CustomSelect>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Aza (kg) <span className="text-xs text-slate-400">auto</span>
              </label>
              <input type="text" readOnly value={draftAza ? draftAza.toFixed(4) : '—'}
                className={readOnlyClass}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Aza status</label>
              <CustomSelect
                name="output_aza_status" value={draft.output_aza_status}
                onChange={(e) => updateDraft('output_aza_status')(e.target.value)}
                className={inputClass}
              >
                {AZA_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </CustomSelect>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Recovered solvent (kg)</label>
              <input type="number" step="0.001" min="0" value={draft.recovered_solvent_kg}
                onChange={(e) => updateDraft('recovered_solvent_kg')(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Cleaning recovery (kg)</label>
              <input type="number" step="0.001" min="0" value={draft.cleaning_recovery_kg}
                onChange={(e) => updateDraft('cleaning_recovery_kg')(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Remarks</label>
            <textarea rows={2} value={draft.remarks}
              onChange={(e) => updateDraft('remarks')(e.target.value)}
              className={inputClass}
            />
          </div>

          <div className="flex justify-end gap-2">
            <button
              onClick={() => { setCreating(false); setSelectedFeedIds([]); setDraft(emptyDraft); }}
              className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >Cancel</button>
            <button
              onClick={handleCreate} disabled={saving}
              className="px-3 py-1.5 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg disabled:opacity-50"
            >{saving ? 'Saving…' : `Create ${label} Run`}</button>
          </div>
        </div>
      )}
    </div>
  );
}
