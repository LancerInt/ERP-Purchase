import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Trash2, X } from 'lucide-react';

import CustomSelect from '../../../../components/ui/CustomSelect';
import apiClient from '../../../../utils/api.js';
import { getApiErrorMessage } from '../../../../utils/formHelpers.js';
import { confirm } from '../../../../components/common/confirm';

const inputClass = 'w-full px-2 py-1 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const cellClass = 'p-1.5 border-b border-slate-100';

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
  sle_wash: '', weight_kg: '',
  assay_value_entered: '', assay_unit_entered: 'PPM',
  aza_status: 'TESTED',
});

/**
 * LLEWashesPanel — one LLE row per SLE row (Section 8.5: strict 1:1).
 *
 * Left column shows the SLE wash letter; picker only offers SLE washes
 * that don't yet have an LLE. Enter Qty + PPM → aza_kg auto-computed.
 */
export default function LLEWashesPanel({ batchId, onSaved, readOnly = false }) {
  const [sleRows, setSleRows] = useState([]);
  const [lleRows, setLleRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(emptyDraft());
  const [draftCleared, setDraftCleared] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [sle, lle] = await Promise.all([
        apiClient.get(`/api/production/extraction-sle-washes/?batch=${batchId}`),
        apiClient.get(`/api/production/extraction-lle-washes/?batch=${batchId}`),
      ]);
      const s = sle.data?.results || (Array.isArray(sle.data) ? sle.data : []);
      const l = lle.data?.results || (Array.isArray(lle.data) ? lle.data : []);
      setSleRows(s);
      setLleRows(l);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { if (batchId) load(); }, [batchId]);

  const linkedSleIds = new Set(lleRows.map((r) => r.sle_wash));
  const availableSle = sleRows.filter((s) => !linkedSleIds.has(s.id));

  // Auto-fill the draft row:
  //   - unit / status: carry over from the last saved LLE wash
  // sle_wash is intentionally NOT auto-picked. After saving one LLE,
  // the next auto-picked row looked like an extra data entry to
  // operators. Now they consciously pick the paired SLE each time.
  useEffect(() => {
    if (loading) return;
    if (draftCleared) return;
    const last = lleRows[lleRows.length - 1];
    setDraft((d) => ({
      ...d,
      assay_unit_entered: d.assay_unit_entered || last?.assay_unit_entered || 'PPM',
      aza_status: d.aza_status || last?.aza_status || 'TESTED',
    }));
  }, [loading, lleRows, draftCleared]);

  const updateDraft = (field) => (val) => setDraft((d) => ({ ...d, [field]: val }));

  const handleAdd = async () => {
    if (!draft.sle_wash) return toast.error('Pick an SLE wash to pair with.');
    if (!draft.weight_kg) return toast.error('LLE weight (Qty) required.');
    setSaving(true);
    try {
      await apiClient.post('/api/production/extraction-lle-washes/', draft);
      const pairedLetter = sleRows.find((s) => s.id === draft.sle_wash)?.wash_letter;
      toast.success(`LLE-${pairedLetter} added.`);
      setDraft(emptyDraft());
      setDraftCleared(false);
      load();
      onSaved?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to save LLE wash.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row) => {
    if (!(await confirm({ message: `Delete LLE-${row.sle_wash_letter}?` }))) return;
    try {
      await apiClient.delete(`/api/production/extraction-lle-washes/${row.id}/`);
      load();
      onSaved?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete.');
    }
  };

  if (loading) return <div className="text-sm text-slate-500 p-4">Loading LLE washes…</div>;

  if (sleRows.length === 0) {
    return (
      <div className="text-sm text-slate-500 p-4 bg-slate-50 rounded border border-dashed border-slate-300">
        No SLE washes yet. Add SLE washes first — each LLE is paired 1:1 with an SLE (per Section 8.5).
      </div>
    );
  }

  const draftAza = computeAza(draft.weight_kg, draft.assay_value_entered, draft.assay_unit_entered);
  const totalWeight = lleRows.reduce((s, r) => s + Number(r.weight_kg || 0), 0);
  const totalAza = lleRows.reduce((s, r) => s + Number(r.aza_kg || 0), 0);

  return (
    <div>
      <div className="mb-3 flex items-baseline gap-4 sm:gap-5 text-sm">
        <div><span className="text-slate-500">LLE washes:</span> <span className="font-semibold">{lleRows.length}</span> / {sleRows.length}</div>
        <div><span className="text-slate-500">Total weight (kg):</span> <span className="font-semibold">{totalWeight.toLocaleString()}</span></div>
        <div><span className="text-slate-500">Total aza (kg):</span> <span className="font-semibold">{totalAza.toFixed(4)}</span></div>
      </div>

      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 uppercase text-[10px]">
            <tr>
              <th className={`${cellClass} text-left`}>Paired SLE</th>
              <th className={`${cellClass} text-right`}>Qty (kg)</th>
              <th className={`${cellClass} text-right`}>PPM</th>
              <th className={`${cellClass} text-left`}>Unit</th>
              <th className={`${cellClass} text-right`}>Aza (kg)</th>
              <th className={`${cellClass} text-left`}>Status</th>
              <th className={cellClass}></th>
            </tr>
          </thead>
          <tbody>
            {lleRows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className={`${cellClass} font-mono font-semibold`}>SLE-{r.sle_wash_letter} → LLE-{r.sle_wash_letter}</td>
                <td className={`${cellClass} text-right font-mono`}>{Number(r.weight_kg).toLocaleString()}</td>
                <td className={`${cellClass} text-right font-mono`}>{r.assay_value_entered}</td>
                <td className={cellClass}>{r.assay_unit_entered_display || r.assay_unit_entered}</td>
                <td className={`${cellClass} text-right font-mono font-semibold text-primary-700`}>{Number(r.aza_kg).toFixed(4)}</td>
                <td className={cellClass}>
                  <span className="text-xs px-2 py-0.5 bg-slate-100 rounded">{r.aza_status}</span>
                </td>
                <td className={`${cellClass} text-right`}>
                  {!readOnly && (
                    <button onClick={() => handleDelete(r)} className="p-1 text-slate-400 hover:text-red-600" title="Delete">
                      <Trash2 size={14} />
                    </button>
                  )}
                </td>
              </tr>
            ))}

            {!readOnly && availableSle.length > 0 && (
              <tr className="bg-primary-50/30">
                <td className={cellClass}>
                  <CustomSelect
                    name="sle_wash" value={draft.sle_wash}
                    onChange={(e) => updateDraft('sle_wash')(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">Pick SLE…</option>
                    {availableSle.map((s) => (
                      <option key={s.id} value={s.id}>SLE-{s.wash_letter}</option>
                    ))}
                  </CustomSelect>
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
      {availableSle.length === 0 && lleRows.length > 0 && (
        <p className="text-xs text-emerald-700 mt-2">All SLE washes paired with an LLE.</p>
      )}
    </div>
  );
}
