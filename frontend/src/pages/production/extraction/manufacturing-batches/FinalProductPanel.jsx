import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Trash2 } from 'lucide-react';

import CustomSelect from '../../../../components/ui/CustomSelect';
import CustomDatePicker from '../../../../components/ui/CustomDatePicker';
import apiClient from '../../../../utils/api.js';
import { getApiErrorMessage } from '../../../../utils/formHelpers.js';
import { confirm } from '../../../../components/common/confirm';

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const readOnlyClass = `${inputClass} bg-slate-100 cursor-not-allowed text-slate-700`;

const ASSAY_UNITS = [
  { value: 'PERCENTAGE', label: 'Percentage (%)' },
  { value: 'PPM', label: 'PPM' },
  { value: 'DECIMAL', label: 'Decimal' },
];
const STATUS_OPTIONS = [
  { value: 'PACKED',     label: 'Packed' },
  { value: 'QC_HOLD',    label: 'QC hold' },
  { value: 'RELEASED',   label: 'Released' },
  { value: 'DISPATCHED', label: 'Dispatched' },
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
 * FinalProductPanel — LIQUID-route final lots sourced from ATFE runs
 * at this batch's warehouse. Phase 1 doesn't include the DRY_POWDER
 * route (that comes with S3 precipitation in Phase 2).
 */
export default function FinalProductPanel({ batch, onSaved, readOnly = false }) {
  const [lots, setLots] = useState([]);
  const [atfes, setAtfes] = useState([]);
  const [liquidProductId, setLiquidProductId] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({
    source_atfe: '',
    quantity_kg: '', volume_l: '', specific_gravity: '',
    assay_value_entered: '', assay_unit_entered: 'PERCENTAGE',
    packed_on: new Date().toISOString().slice(0, 10),
    storage_location: '', container_numbers: '',
    status: 'PACKED', remarks: '',
  });

  const load = async () => {
    if (!batch?.warehouse) return;
    setLoading(true);
    try {
      const [lotsRes, atfeRes, prodRes] = await Promise.all([
        apiClient.get(`/api/production/extraction-final-lots/?warehouse=${batch.warehouse}`),
        apiClient.get(`/api/production/extraction-atfe-runs/?warehouse=${batch.warehouse}`),
        // The Product master row for LIQUID concentrate is seeded as
        // AZAX-LIQ. `sku_code` isn't in ProductViewSet.filterset_fields
        // but IS in search_fields, so use ?search=. Widen page_size in
        // case another product's name contains the substring.
        apiClient.get('/api/products/?search=AZAX-LIQ&page_size=50'),
      ]);
      setLots(lotsRes.data?.results || lotsRes.data || []);
      setAtfes(atfeRes.data?.results || atfeRes.data || []);
      const prods = prodRes.data?.results || prodRes.data || [];
      const liq = prods.find((p) => p.sku_code === 'AZAX-LIQ');
      if (liq) setLiquidProductId(liq.id);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [batch?.warehouse]);

  const update = (field) => (val) => setDraft((d) => ({ ...d, [field]: val }));

  // When the user picks a source ATFE, auto-fill the output fields
  // from that ATFE run's product data (Qty, Volume, SG, Assay). The
  // operator can still override any value before saving (e.g. if the
  // packed weight differs slightly from ATFE output due to sampling).
  const handleAtfePick = (atfeId) => {
    const a = atfes.find((x) => x.id === atfeId);
    setDraft((d) => ({
      ...d,
      source_atfe: atfeId,
      quantity_kg: d.quantity_kg || (a?.product_weight_kg ?? ''),
      volume_l: d.volume_l || (a?.product_volume_l ?? ''),
      specific_gravity: d.specific_gravity || (a?.product_specific_gravity ?? ''),
      assay_value_entered: d.assay_value_entered || (a?.product_assay_value_entered ?? ''),
      assay_unit_entered: d.assay_unit_entered || (a?.product_assay_unit_entered || 'PERCENTAGE'),
    }));
  };

  const draftAza = computeAza(draft.quantity_kg, draft.assay_value_entered, draft.assay_unit_entered);

  const handleCreate = async () => {
    if (!liquidProductId) return toast.error('Product master "AZAX-LIQ" not found. Run seed_extraction_products.');
    if (!draft.source_atfe) return toast.error('Pick a source ATFE run.');
    if (!draft.quantity_kg) return toast.error('Quantity required.');
    setSaving(true);
    try {
      const res = await apiClient.post('/api/production/extraction-final-lots/', {
        route: 'LIQUID',
        product: liquidProductId,
        warehouse: batch.warehouse,
        // Direct FK to the manufacturing batch — required so
        // BatchSignOff can post the inventory-ledger IN row against
        // this lot at SLPP-FG when the batch is signed off.
        batch: batch.id,
        ...draft,
      });
      toast.success(`${res.data.lot_no} created.`);
      setCreating(false);
      setDraft((d) => ({ ...d, source_atfe: '', quantity_kg: '', assay_value_entered: '' }));
      load();
      onSaved?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to create lot.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row) => {
    if (!(await confirm({ message: `Delete lot ${row.lot_no}?` }))) return;
    try {
      await apiClient.delete(`/api/production/extraction-final-lots/${row.id}/`);
      load();
      onSaved?.();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete.');
    }
  };

  if (loading) return <div className="text-sm text-slate-500 p-4">Loading final product lots…</div>;

  return (
    <div>
      <div className="flex justify-between items-baseline mb-3">
        <div className="text-sm text-slate-500">
          {lots.length} final product lot{lots.length !== 1 && 's'} at this warehouse.
          <span className="text-xs ml-2">(LIQUID route only — DRY_POWDER via S3 precipitation is Phase 2.)</span>
        </div>
        {!readOnly && !creating && (
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-600 hover:bg-primary-700 text-white text-sm font-medium rounded-lg"
          >
            <Plus size={14} /> New Lot
          </button>
        )}
      </div>

      {lots.length > 0 && (
        <div className="overflow-x-auto border border-slate-200 rounded-lg mb-4">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 uppercase text-[10px]">
              <tr>
                <th className="p-2 text-left">Lot No</th>
                <th className="p-2 text-left">Product</th>
                <th className="p-2 text-right">Qty (kg)</th>
                <th className="p-2 text-right">Aza (kg)</th>
                <th className="p-2 text-left">Packed</th>
                <th className="p-2 text-left">Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {lots.map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="p-2 font-mono">{r.lot_no}</td>
                  <td className="p-2">{r.product_name}</td>
                  <td className="p-2 text-right font-mono">{Number(r.quantity_kg).toLocaleString()}</td>
                  <td className="p-2 text-right font-mono font-semibold text-primary-700">
                    {Number(r.aza_kg || 0).toFixed(4)}
                  </td>
                  <td className="p-2 text-xs text-slate-500">{r.packed_on || '-'}</td>
                  <td className="p-2">
                    <span className="text-xs px-2 py-0.5 bg-slate-100 rounded">{r.status_display}</span>
                  </td>
                  <td className="p-2 text-right">
                    {!readOnly && (
                      <button onClick={() => handleDelete(r)} className="p-1 text-slate-400 hover:text-red-600">
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

      {creating && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-4">
          <h4 className="text-sm font-semibold text-slate-700">Create new Final Product Lot</h4>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Source ATFE Run *</label>
              <CustomSelect
                name="source_atfe" value={draft.source_atfe}
                onChange={(e) => handleAtfePick(e.target.value)}
                className={inputClass}
              >
                <option value="">Pick ATFE…</option>
                {atfes.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.run_no} — {Number(a.product_weight_kg).toLocaleString()} kg
                  </option>
                ))}
              </CustomSelect>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Quantity (kg) *</label>
              <input type="number" step="0.001" min="0" value={draft.quantity_kg}
                onChange={(e) => update('quantity_kg')(e.target.value)}
                className={inputClass} placeholder="300"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Volume (L)</label>
              <input type="number" step="0.001" min="0" value={draft.volume_l}
                onChange={(e) => update('volume_l')(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Assay value</label>
              <input type="number" step="0.0001" min="0" value={draft.assay_value_entered}
                onChange={(e) => update('assay_value_entered')(e.target.value)}
                className={inputClass} placeholder="3.33"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Unit</label>
              <CustomSelect
                name="assay_unit_entered" value={draft.assay_unit_entered}
                onChange={(e) => update('assay_unit_entered')(e.target.value)}
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
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Packed on</label>
              <CustomDatePicker
                name="packed_on" value={draft.packed_on}
                onChange={(e) => update('packed_on')(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Storage location</label>
              <input type="text" value={draft.storage_location}
                onChange={(e) => update('storage_location')(e.target.value)}
                className={inputClass} placeholder="Warehouse zone / rack"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Container numbers</label>
              <input type="text" value={draft.container_numbers}
                onChange={(e) => update('container_numbers')(e.target.value)}
                className={inputClass} placeholder="Comma-separated"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
              <CustomSelect
                name="status" value={draft.status}
                onChange={(e) => update('status')(e.target.value)}
                className={inputClass}
              >
                {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </CustomSelect>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              onClick={() => setCreating(false)}
              className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >Cancel</button>
            <button
              onClick={handleCreate} disabled={saving}
              className="px-3 py-1.5 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg disabled:opacity-50"
            >{saving ? 'Saving…' : 'Create Lot'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
