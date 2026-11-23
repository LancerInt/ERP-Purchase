import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Trash2, X } from 'lucide-react';

import CustomSelect from '../../../../components/ui/CustomSelect';
import CustomDatePicker from '../../../../components/ui/CustomDatePicker';
import apiClient from '../../../../utils/api.js';
import { getApiErrorMessage } from '../../../../utils/formHelpers.js';
import { confirm } from '../../../../components/common/confirm';

const inputClass = 'w-full px-2 py-1 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const readOnlyClass = `${inputClass} bg-slate-100 cursor-not-allowed text-slate-700`;
const cellClass = 'p-1.5 border-b border-slate-100';

const WASH_LETTERS = ['A','B','C','D','E','F','G','H','I','J'];
const ASSAY_UNITS = [
  { value: 'PPM', label: 'PPM' },
  { value: 'PERCENTAGE', label: '%' },
  { value: 'DECIMAL', label: 'Decimal' },
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
  if (unit === 'DECIMAL') return w * v;
  return 0;
};

const emptyDraft = () => ({
  wash_letter: '', wash_sequence: '', equipment: '',
  // kernel_qty_kg is auto-filled by the backend from the batch's
  // KernelInput.adjusted_kernel_kg — no field on the form.
  s1_qty_kg: '',
  weight_kg: '', assay_value_entered: '', assay_unit_entered: 'PPM',
  aza_status: 'TESTED', sample_no: '', remarks: '',
});

/**
 * SLEWashesPanel — table of wash rows for one batch.
 *
 * Each existing row is displayed inline (values shown, aza_kg computed).
 * A "New Wash" draft row lets the operator add A, B, C, ... in sequence.
 * The next wash_letter + wash_sequence auto-fill from what's already
 * saved so operators just tab through the numbers.
 */
export default function SLEWashesPanel({ batchId, batch, onSaved, readOnly = false }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(emptyDraft());
  // Flag set by the Clear button to suppress auto-fill until the next
  // save. Otherwise the useEffect would immediately re-populate the
  // fields the operator just cleared.
  const [draftCleared, setDraftCleared] = useState(false);
  // Once actual washes hit the planned count we hide the draft row so
  // the grid doesn't dangle a blank line. Chemistry sometimes needs
  // one more; this flag lets "+ Add another wash beyond plan" reopen
  // the row past the cap. Reset on save so the next batch of extras
  // still needs a click.
  const [showBeyondPlan, setShowBeyondPlan] = useState(false);

  const load = () => {
    setLoading(true);
    apiClient.get(`/api/production/extraction-sle-washes/?batch=${batchId}`)
      .then((res) => {
        const list = res.data?.results || (Array.isArray(res.data) ? res.data : []);
        setRows(list);
      })
      .finally(() => setLoading(false));
  };
  useEffect(() => { if (batchId) load(); }, [batchId]);

  // Auto-fill the draft row based on what's already saved.
  //   - wash_letter: next unused letter in A..J
  //   - wash_sequence: rows.length + 1
  //   - weight_kg / unit / status: carry over from the LAST saved wash
  //     since these are typically constant across a batch (e.g. every
  //     SLE wash in the Excel report uses 20,000 kg + PPM + Tested).
  // We only fill when the draft field is currently blank — so if the
  // operator has already typed a different value we don't overwrite it.
  useEffect(() => {
    if (loading) return;
    if (draftCleared) return;   // operator explicitly cleared the draft
    const usedLetters = new Set(rows.map((r) => r.wash_letter));
    const nextLetter = WASH_LETTERS.find((l) => !usedLetters.has(l)) || '';
    const nextSeq = (rows.length || 0) + 1;
    const last = rows[rows.length - 1];
    // Backend DecimalField(decimal_places=3) round-trips "3550.000"
    // — strip trailing zeros so the input shows a clean "3550" instead
    // of "3550.000". parseFloat drops trailing zeros; String() gives
    // us back a display-friendly form. Falls back to empty on nulls.
    const cleanNum = (v) => {
      if (v === null || v === undefined || v === '') return '';
      const n = parseFloat(v);
      return Number.isFinite(n) ? String(n) : '';
    };
    setDraft((d) => ({
      ...d,
      wash_letter: d.wash_letter || nextLetter,
      wash_sequence: d.wash_sequence || nextSeq,
      weight_kg: d.weight_kg || cleanNum(last?.weight_kg),
      assay_unit_entered: d.assay_unit_entered || last?.assay_unit_entered || 'PPM',
      aza_status: d.aza_status || last?.aza_status || 'TESTED',
    }));
  }, [rows, loading, draftCleared]);

  const updateDraft = (field) => (val) => setDraft((d) => ({ ...d, [field]: val }));

  const handleAdd = async () => {
    if (!draft.wash_letter) return toast.error('Wash letter required.');
    if (!draft.wash_sequence) return toast.error('Wash sequence required.');
    if (!draft.weight_kg) return toast.error('Wash weight (Qty) required.');

    setSaving(true);
    try {
      await apiClient.post('/api/production/extraction-sle-washes/', {
        batch: batchId,
        ...draft,
      });
      toast.success(`SLE-${draft.wash_letter} added.`);
      setDraft(emptyDraft());
      setDraftCleared(false);   // re-enable auto-fill for the next draft
      setShowBeyondPlan(false); // next "beyond plan" wash needs a fresh click
      load();
      onSaved?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to save wash.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row) => {
    if (!(await confirm({ message: `Delete SLE-${row.wash_letter}?` }))) return;
    try {
      await apiClient.delete(`/api/production/extraction-sle-washes/${row.id}/`);
      toast.success(`SLE-${row.wash_letter} deleted.`);
      load();
      onSaved?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete.');
    }
  };

  if (loading) return <div className="text-sm text-slate-500 p-4">Loading SLE washes…</div>;

  // Live-preview aza for the draft row (matches server-side compute).
  const draftAza = computeAza(draft.weight_kg, draft.assay_value_entered, draft.assay_unit_entered);
  const totalWeight = rows.reduce((s, r) => s + Number(r.weight_kg || 0), 0);
  const totalAza = rows.reduce((s, r) => s + Number(r.aza_kg || 0), 0);

  // Planned-vs-actual wash count — advisory only (chemistry sometimes
  // needs one extra wash for stubborn batches). Coloured hint if we're
  // over the plan; muted "of N" annotation while under. No hard block.
  const planned = Number(batch?.planned_wash_count) || 0;
  const actual = rows.length;
  let plannedHint = null;
  if (planned > 0) {
    if (actual > planned) {
      plannedHint = { text: `Over plan by ${actual - planned}`, cls: 'text-amber-700 bg-amber-50 border-amber-300' };
    } else if (actual < planned) {
      plannedHint = { text: `${planned - actual} of ${planned} remaining`, cls: 'text-slate-600 bg-slate-100 border-slate-200' };
    } else {
      plannedHint = { text: 'At plan', cls: 'text-emerald-700 bg-emerald-50 border-emerald-300' };
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-baseline gap-4 sm:gap-5 text-sm flex-wrap">
        <div>
          <span className="text-slate-500">Washes saved:</span>{' '}
          <span className="font-semibold">{actual}</span>
          {planned > 0 && <span className="text-slate-400 font-normal"> / planned {planned}</span>}
        </div>
        {plannedHint && (
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${plannedHint.cls}`}>
            {plannedHint.text}
          </span>
        )}
        <div><span className="text-slate-500">Total weight (kg):</span> <span className="font-semibold">{totalWeight.toLocaleString()}</span></div>
        <div><span className="text-slate-500">Total aza (kg):</span> <span className="font-semibold">{totalAza.toFixed(4)}</span></div>
      </div>

      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 uppercase text-[10px]">
            <tr>
              <th className={`${cellClass} text-left`}>Wash</th>
              <th className={`${cellClass} text-left`}>Seq</th>
              <th className={`${cellClass} text-right`}>Qty (kg)</th>
              <th className={`${cellClass} text-right`}>Assay</th>
              <th className={`${cellClass} text-left`}>Unit</th>
              <th className={`${cellClass} text-right`}>Aza (kg)</th>
              <th className={`${cellClass} text-left`}>Status</th>
              <th className={`${cellClass} text-left`}>Sample</th>
              <th className={`${cellClass}`}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className={`${cellClass} font-mono font-semibold`}>SLE-{r.wash_letter}</td>
                <td className={cellClass}>{r.wash_sequence}</td>
                <td className={`${cellClass} text-right font-mono`}>{Number(r.weight_kg).toLocaleString()}</td>
                <td className={`${cellClass} text-right font-mono`}>{r.assay_value_entered}</td>
                <td className={cellClass}>{r.assay_unit_entered_display || r.assay_unit_entered}</td>
                <td className={`${cellClass} text-right font-mono font-semibold text-primary-700`}>{Number(r.aza_kg).toFixed(4)}</td>
                <td className={cellClass}>
                  <span className="text-xs px-2 py-0.5 bg-slate-100 rounded">{r.aza_status}</span>
                </td>
                <td className={`${cellClass} text-slate-500`}>{r.sample_no || '-'}</td>
                <td className={`${cellClass} text-right`}>
                  {!readOnly && (
                    <button onClick={() => handleDelete(r)} className="p-1 text-slate-400 hover:text-red-600" title="Delete">
                      <Trash2 size={14} />
                    </button>
                  )}
                </td>
              </tr>
            ))}

            {/* Draft (new wash) row — hidden when the batch is signed off,
                and hidden once we've reached the planned wash count so the
                grid doesn't dangle an orphan blank row after the last +Add.
                Operator can still add an extra wash beyond plan via the
                "Add another wash" button that flips showBeyondPlan on. */}
            {!readOnly && (!(planned > 0 && actual >= planned) || showBeyondPlan) && (
            <tr className="bg-primary-50/30">
              <td className={cellClass}>
                <CustomSelect
                  name="wash_letter" value={draft.wash_letter}
                  onChange={(e) => updateDraft('wash_letter')(e.target.value)}
                  className={inputClass}
                >
                  <option value="">--</option>
                  {WASH_LETTERS.map((l) => <option key={l} value={l}>SLE-{l}</option>)}
                </CustomSelect>
              </td>
              <td className={cellClass}>
                <input type="number" min="1" max="10" value={draft.wash_sequence}
                  onChange={(e) => updateDraft('wash_sequence')(e.target.value)}
                  className={inputClass} style={{ width: 60 }}
                />
              </td>
              <td className={cellClass}>
                <input type="number" step="0.001" min="0" value={draft.weight_kg}
                  onChange={(e) => updateDraft('weight_kg')(e.target.value)}
                  className={`${inputClass} text-right`} placeholder="kg"
                />
              </td>
              <td className={cellClass}>
                <input type="number" step="0.0001" min="0" value={draft.assay_value_entered}
                  onChange={(e) => updateDraft('assay_value_entered')(e.target.value)}
                  className={`${inputClass} text-right`} placeholder="ppm"
                />
              </td>
              <td className={cellClass}>
                <CustomSelect
                  name="assay_unit_entered" value={draft.assay_unit_entered}
                  onChange={(e) => updateDraft('assay_unit_entered')(e.target.value)}
                  className={inputClass}
                >
                  {ASSAY_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                </CustomSelect>
              </td>
              <td className={`${cellClass} text-right font-mono text-slate-500`}>
                {draftAza ? draftAza.toFixed(4) : '—'}
              </td>
              <td className={cellClass}>
                <CustomSelect
                  name="aza_status" value={draft.aza_status}
                  onChange={(e) => updateDraft('aza_status')(e.target.value)}
                  className={inputClass}
                >
                  {AZA_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </CustomSelect>
              </td>
              <td className={cellClass}>
                <input type="text" value={draft.sample_no}
                  onChange={(e) => updateDraft('sample_no')(e.target.value)}
                  className={inputClass} placeholder="SMP-…"
                />
              </td>
              <td className={`${cellClass} text-right`}>
                <div className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => { setDraft(emptyDraft()); setDraftCleared(true); }}
                    className="p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded"
                    title="Clear draft (won't save)"
                  >
                    <X size={14} />
                  </button>
                  <button
                    onClick={handleAdd} disabled={saving}
                    className="inline-flex items-center gap-1 px-2 py-1 bg-primary-600 hover:bg-primary-700 text-white text-xs font-medium rounded disabled:opacity-50"
                    title="Add wash"
                  >
                    <Plus size={14} /> Add
                  </button>
                </div>
              </td>
            </tr>
            )}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <p className="text-xs text-slate-500 mt-2">
          Enter Qty (wash output weight in kg), assay value and unit — <strong>Aza (kg) is auto-computed</strong> on save.
          Add washes A, B, C… in order. Delete a row and re-add if you need to correct it.
        </p>
      )}
      {/* At/over plan the draft row goes away, but chemistry sometimes
          needs one more wash. This button reopens the draft row past
          the cap; flag resets on save. */}
      {!readOnly && planned > 0 && actual >= planned && !showBeyondPlan && (
        <button
          type="button"
          onClick={() => { setShowBeyondPlan(true); setDraft(emptyDraft()); }}
          className="mt-3 text-xs text-primary-600 hover:text-primary-800 hover:underline"
        >
          + Add another wash beyond plan
        </button>
      )}
    </div>
  );
}
