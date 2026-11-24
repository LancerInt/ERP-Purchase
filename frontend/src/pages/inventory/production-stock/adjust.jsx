import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Save, Loader2, Trash2, ArrowLeft, Plus, AlertTriangle, Wrench,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import CustomSelect from '@/components/ui/CustomSelect';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';

// Stock Adjustment / Opening Balance form.
//
// Posts one ProductionStockMovement per line via
//   POST /api/inventory/production-stock/adjust/
//
// Two modes drive most of the UI:
//   * OPENING     — cutover seed, direction locked to IN, backend
//                   enforces one-per (godown, product, batch).
//   * ADJUSTMENT  — regular manual correction, direction can be
//                   IN (add stock) or OUT (remove stock).

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const numClass = `${inputClass} tabular-nums text-right`;
const labelClass = 'block text-xs font-medium text-slate-600 mb-1';
const isoToday = () => new Date().toISOString().slice(0, 10);

let _cid = 0;
const cid = () => `cid-${++_cid}`;

const fmt3 = (v) => Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const fmt0 = (v) => Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
// Compact one-liner "3,000 kg / 100 L / 5 pcs" — used inside the
// correction banner so the operator sees exactly what they're
// correcting without needing to open the drill-down again.
const fmtQtySummary = (m) => {
  if (!m) return '';
  const bits = [];
  if (Number(m.qty_kg)     > 0) bits.push(`${fmt3(m.qty_kg)} kg`);
  if (Number(m.qty_litres) > 0) bits.push(`${fmt3(m.qty_litres)} L`);
  if (Number(m.qty_count)  > 0) bits.push(`${fmt0(m.qty_count)} pcs`);
  return bits.join(' / ');
};

const newLine = () => ({
  cid: cid(),
  product: '',
  batch_no: '',
  direction: 'IN',
  qty_kg: '',
  qty_ltr: '',
  qty_count: '',
  remarks: '',
});

export default function ProductionStockAdjustForm() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const correctFromId = searchParams.get('correct_from') || '';

  // Header state
  const [entryType, setEntryType] = useState('ADJUSTMENT'); // ADJUSTMENT | OPENING
  const [movementDate, setMovementDate] = useState(isoToday());
  const [warehouseId, setWarehouseId] = useState('');
  const [godownId, setGodownId] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState([newLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  // When the operator arrives here from the drill-down modal's
  // "Post correction" button, the source movement is fetched once
  // and pinned in the header banner so the operator can see WHAT
  // they're correcting while entering the delta qty.
  const [correcting, setCorrecting] = useState(null);
  const [correctingLoading, setCorrectingLoading] = useState(!!correctFromId);

  // Lookups
  const { raw: warehousesRaw } = useLookup('/api/warehouses/');
  const warehouses = useMemo(() => {
    const seen = new Set();
    const out = [];
    (warehousesRaw || []).forEach((w) => {
      const k = (w.name || '').trim().toLowerCase();
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push({ value: w.id, label: w.name });
    });
    return out;
  }, [warehousesRaw]);

  const { raw: godownsRaw } = useLookup(
    warehouseId ? `/api/godowns/?warehouse=${warehouseId}` : null,
  );
  const godowns = useMemo(() =>
    (godownsRaw || []).map((g) => ({ value: g.id, label: g.godown_name || g.name || 'Godown' })),
  [godownsRaw]);

  const { raw: catalogRaw } = useLookup('/api/purchase/items/');
  const products = useMemo(() =>
    (catalogRaw || [])
      .filter((it) => it.item_type === 'PRODUCT')
      .map((it) => ({
        value: it.item_id,
        label: `${it.item_name}${it.item_code ? `  (${it.item_code})` : ''}`,
      }))
      .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase())),
  [catalogRaw]);

  // When switching to OPENING, force every line's direction to IN —
  // the backend rejects OPENING with OUT anyway, but this keeps the
  // UI honest so the operator doesn't click Save and then read an error.
  useEffect(() => {
    if (entryType === 'OPENING') {
      setLines((prev) => prev.map((l) => ({ ...l, direction: 'IN' })));
    }
  }, [entryType]);

  // Correction pre-fill — fetch the source movement and seed the form
  // so the operator only has to type the delta qty.
  useEffect(() => {
    if (!correctFromId) return;
    let cancelled = false;
    apiClient.get(`/api/inventory/production-stock/${correctFromId}/`)
      .then((res) => {
        if (cancelled) return;
        const m = res.data || {};
        setCorrecting(m);
        setEntryType('ADJUSTMENT');
        setWarehouseId(m.warehouse || '');
        setGodownId(m.godown || '');
        // Opposite direction of the original — an OPENING (IN) with
        // wrong qty gets nudged back with an OUT adjustment; an
        // ADJUSTMENT OUT that was excessive gets undone with an IN.
        const oppositeDir = m.direction === 'IN' ? 'OUT' : 'IN';
        setLines([{
          ...newLine(),
          product: m.product || '',
          batch_no: m.batch_no || '',
          direction: oppositeDir,
          remarks: `Corrects ${m.source_type_display || m.source_type} of ${m.movement_date || ''}`,
        }]);
        setReason(
          `Corrects ${m.source_type_display || m.source_type} of ${m.movement_date || ''} `
          + `(${m.product_name || m.product}${m.batch_no ? ' / ' + m.batch_no : ''})`
        );
        setReference(m.source_document_ref || `SRC:${correctFromId.slice(0, 8)}`);
      })
      .catch((err) => {
        if (!cancelled) setError(`Could not load source movement — ${getApiErrorMessage(err)}`);
      })
      .finally(() => { if (!cancelled) setCorrectingLoading(false); });
    return () => { cancelled = true; };
  }, [correctFromId]);

  const updateLine = (cidKey, patch) => {
    setLines((prev) => prev.map((l) => (l.cid === cidKey ? { ...l, ...patch } : l)));
  };
  const removeLine = (cidKey) => {
    setLines((prev) => (prev.length <= 1 ? prev : prev.filter((l) => l.cid !== cidKey)));
  };
  const addLine = () => setLines((prev) => [...prev, newLine()]);

  const handleSave = async () => {
    setError(null);

    // Client-side gates — the backend re-validates, but catching here
    // gives the operator immediate feedback instead of a round-trip.
    if (!warehouseId || !godownId) {
      setError('Warehouse and godown are required.');
      return;
    }
    if (!movementDate) {
      setError('Movement date is required.');
      return;
    }
    if (!reason.trim()) {
      setError('Reason is required — describe why this entry is being posted.');
      return;
    }
    const cleaned = lines
      .map((l) => ({
        product: (l.product || '').trim(),
        batch_no: (l.batch_no || '').trim(),
        direction: entryType === 'OPENING' ? 'IN' : (l.direction || 'IN'),
        qty_kg: (l.qty_kg || '0').toString().trim() || '0',
        qty_ltr: (l.qty_ltr || '0').toString().trim() || '0',
        qty_count: (l.qty_count || '0').toString().trim() || '0',
        remarks: (l.remarks || '').trim(),
      }))
      .filter((l) => l.product);
    if (cleaned.length === 0) {
      setError('Add at least one line with a product selected.');
      return;
    }
    const anyEmpty = cleaned.some((l) =>
      Number(l.qty_kg) === 0 && Number(l.qty_ltr) === 0 && Number(l.qty_count) === 0
    );
    if (anyEmpty) {
      setError('Every line needs at least one non-zero qty (kg / L / pcs).');
      return;
    }

    setSaving(true);
    try {
      const res = await apiClient.post('/api/inventory/production-stock/adjust/', {
        entry_type: entryType,
        movement_date: movementDate,
        warehouse: warehouseId,
        godown: godownId,
        reason: reason.trim(),
        reference: reference.trim(),
        lines: cleaned,
      });
      toast.success(`Posted ${res.data?.created || cleaned.length} movement${(res.data?.created || 1) === 1 ? '' : 's'}.`);
      navigate('/inventory/production-stock');
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const isOpening = entryType === 'OPENING';

  return (
    <MainLayout>
      <PageHeader
        title={isOpening ? 'Set Opening Balance' : 'New Stock Adjustment'}
        subtitle={isOpening
          ? 'One-time baseline seed for a godown/product — cannot be reversed by a subsequent OPENING entry.'
          : 'Manual correction — added to the Production Stock ledger in the Adjustments pane.'}
        breadcrumbs={[
          { label: 'Inventory' },
          { label: 'Production Stock', to: '/inventory/production-stock' },
          { label: isOpening ? 'Set Opening' : 'New Adjustment' },
        ]}
        actions={{
          right: (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/inventory/production-stock')}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                <ArrowLeft size={14} /> Back
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-60"
              >
                {saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />}
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          ),
        }}
      />

      {/* Correction banner — pinned at the top when we arrived via
          the drill-down modal's "Post correction adjustment" button. */}
      {correctFromId && (
        <div className="mb-4 rounded-lg border border-primary-200 bg-primary-50 p-3">
          {correctingLoading ? (
            <div className="text-xs text-primary-800 flex items-center gap-2">
              <Loader2 className="animate-spin" size={12} /> Loading source movement…
            </div>
          ) : correcting ? (
            <div className="flex items-start gap-2 text-primary-900">
              <Wrench size={16} className="mt-0.5 shrink-0" />
              <div className="flex-1 text-[12px]">
                <div className="font-semibold">Correction adjustment</div>
                <div className="opacity-90 mt-0.5">
                  Correcting <span className="font-medium">{correcting.source_type_display || correcting.source_type}</span>{' '}
                  of <span className="font-medium">{correcting.product_name}</span>
                  {correcting.batch_no && <span className="font-mono ml-1 text-[11px]">{correcting.batch_no}</span>}{' '}
                  posted on <span className="font-medium">{correcting.movement_date}</span>{' '}
                  (<span className="font-medium">{correcting.direction} {fmtQtySummary(correcting)}</span>).
                  Enter the delta qty below — a{' '}
                  <span className="font-medium">{lines[0]?.direction || 'OUT'}</span>{' '}
                  adjustment brings the baseline back to what it should have been.
                </div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-red-700">Source movement could not be loaded. You can still post a manual adjustment.</div>
          )}
        </div>
      )}

      {/* Type selector */}
      <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3">
        <div className="text-[10px] font-medium text-slate-500 uppercase tracking-wide mb-2">Entry type</div>
        <div className="inline-flex p-0.5 rounded-lg bg-slate-100 gap-0.5">
          {[
            { v: 'ADJUSTMENT', label: 'Manual Adjustment' },
            { v: 'OPENING',    label: 'Opening Balance' },
          ].map((t) => (
            <button
              key={t.v}
              type="button"
              onClick={() => setEntryType(t.v)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md ${entryType === t.v ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-600 hover:text-slate-800'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {isOpening && (
          <div className="mt-3 flex items-start gap-2 p-2.5 rounded-md bg-amber-50 border border-amber-200 text-[12px] text-amber-800">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">This is a one-time cutover seed.</div>
              <div className="opacity-90">
                Direction is locked to IN. Opening entries always appear in the
                pivot's <strong>Opening</strong> column — never as a day-cell —
                regardless of the movement date you pick here. The backend rejects
                a second OPENING for the same (godown, product, batch); use Manual
                Adjustment to correct a mistake.
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Header block */}
      <div className="mb-4 rounded-lg border border-slate-200 bg-white p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <div>
            <label className={labelClass}>
              {isOpening ? 'Cutover date' : 'Movement date'} <span className="text-red-500">*</span>
            </label>
            <CustomDatePicker
              value={movementDate}
              onChange={(e) => setMovementDate(e?.target?.value ?? '')}
            />
            {isOpening && (
              <div className="text-[10px] text-slate-400 mt-1">
                Timestamp only — the value always flows into the Opening column.
              </div>
            )}
          </div>
          <div>
            <label className={labelClass}>Warehouse <span className="text-red-500">*</span></label>
            <CustomSelect
              value={warehouseId}
              onChange={(e) => { setWarehouseId(e.target.value); setGodownId(''); }}
            >
              <option value="">Select warehouse…</option>
              {warehouses.map((w) => (
                <option key={w.value} value={w.value}>{w.label}</option>
              ))}
            </CustomSelect>
          </div>
          <div>
            <label className={labelClass}>Godown <span className="text-red-500">*</span></label>
            <CustomSelect
              value={godownId}
              onChange={(e) => setGodownId(e.target.value)}
              disabled={!warehouseId}
            >
              <option value="">{warehouseId ? 'Select godown…' : 'Pick warehouse first'}</option>
              {godowns.map((g) => (
                <option key={g.value} value={g.value}>{g.label}</option>
              ))}
            </CustomSelect>
          </div>
          <div className="lg:col-span-2">
            <label className={labelClass}>
              Reason <span className="text-red-500">*</span>{' '}
              <span className="text-slate-400 font-normal">
                — copied onto every line's remarks when the line doesn't have its own.
              </span>
            </label>
            <textarea
              className={`${inputClass} min-h-[38px] resize-y`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={isOpening
                ? 'e.g. Cutover baseline from physical stock count on 15-Aug-2026'
                : 'e.g. Physical count on 18-Aug shows 3 kg short of ledger'}
              rows={2}
            />
          </div>
          <div>
            <label className={labelClass}>Reference <span className="text-slate-400 font-normal">(optional)</span></label>
            <input
              type="text"
              className={inputClass}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="STOCK-COUNT-2026-08-18"
            />
          </div>
        </div>
      </div>

      {/* Lines */}
      <div className="mb-4 rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="px-4 py-2.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-slate-800">Movement lines</div>
            <div className="text-[11px] text-slate-500">
              One row per (product, batch, direction). Fill kg / L / pcs matching the product's UOM.
            </div>
          </div>
          <button
            type="button"
            onClick={addLine}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-primary-700 bg-primary-50 rounded-md hover:bg-primary-100"
          >
            <Plus size={14} /> Add line
          </button>
        </div>
        {/* Desktop (lg+): compact table. Mobile / tablet: stacked
            cards so every field is full-tap-width and no horizontal
            scroll is needed to fill a form. */}
        <div className="hidden lg:block overflow-x-auto">
          <table className="min-w-full text-xs" style={{ fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200 bg-white">
                <th className="px-3 py-2" style={{ minWidth: 240 }}>Product <span className="text-red-500">*</span></th>
                <th className="px-2 py-2" style={{ minWidth: 140 }}>Batch</th>
                {!isOpening && <th className="px-2 py-2" style={{ minWidth: 100 }}>Direction</th>}
                <th className="px-2 py-2 text-right" style={{ minWidth: 110 }}>Qty (kg)</th>
                <th className="px-2 py-2 text-right" style={{ minWidth: 110 }}>Qty (L)</th>
                <th className="px-2 py-2 text-right" style={{ minWidth: 110 }}>Qty (pcs)</th>
                <th className="px-2 py-2" style={{ minWidth: 200 }}>Remarks</th>
                <th className="px-2 py-2 w-10" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.cid} className="border-b border-slate-100 align-top">
                  <td className="px-3 py-2">
                    <CustomSelect
                      value={l.product}
                      onChange={(e) => updateLine(l.cid, { product: e.target.value })}
                    >
                      <option value="">Select product…</option>
                      {products.map((p) => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </CustomSelect>
                  </td>
                  <td className="px-2 py-2">
                    <input
                      type="text"
                      className={`${inputClass} font-mono`}
                      value={l.batch_no}
                      onChange={(e) => updateLine(l.cid, { batch_no: e.target.value })}
                      placeholder="Optional"
                    />
                  </td>
                  {!isOpening && (
                    <td className="px-2 py-2">
                      <CustomSelect
                        value={l.direction}
                        onChange={(e) => updateLine(l.cid, { direction: e.target.value })}
                      >
                        <option value="IN">IN (add stock)</option>
                        <option value="OUT">OUT (remove stock)</option>
                      </CustomSelect>
                    </td>
                  )}
                  <td className="px-2 py-2">
                    <input type="number" step="0.001" min="0" className={numClass}
                      value={l.qty_kg}
                      onChange={(e) => updateLine(l.cid, { qty_kg: e.target.value })}
                      placeholder="0" />
                  </td>
                  <td className="px-2 py-2">
                    <input type="number" step="0.001" min="0" className={numClass}
                      value={l.qty_ltr}
                      onChange={(e) => updateLine(l.cid, { qty_ltr: e.target.value })}
                      placeholder="0" />
                  </td>
                  <td className="px-2 py-2">
                    <input type="number" step="1" min="0" className={numClass}
                      value={l.qty_count}
                      onChange={(e) => updateLine(l.cid, { qty_count: e.target.value })}
                      placeholder="0" />
                  </td>
                  <td className="px-2 py-2">
                    <input type="text" className={inputClass}
                      value={l.remarks}
                      onChange={(e) => updateLine(l.cid, { remarks: e.target.value })}
                      placeholder="Line-level note (optional)" />
                  </td>
                  <td className="px-2 py-2 text-center">
                    <button type="button" onClick={() => removeLine(l.cid)} disabled={lines.length <= 1}
                      className="text-slate-400 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed"
                      title={lines.length <= 1 ? 'At least one line required' : 'Remove this line'}>
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile / tablet card layout */}
        <div className="lg:hidden divide-y divide-slate-100">
          {lines.map((l, idx) => (
            <div key={l.cid} className="p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                  Line #{idx + 1}
                </span>
                <button type="button" onClick={() => removeLine(l.cid)} disabled={lines.length <= 1}
                  className="p-1 text-red-500 hover:bg-red-50 rounded disabled:opacity-30 disabled:cursor-not-allowed"
                  title={lines.length <= 1 ? 'At least one line required' : 'Remove this line'}>
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="space-y-2">
                <div>
                  <label className={labelClass}>Product <span className="text-red-500">*</span></label>
                  <CustomSelect
                    value={l.product}
                    onChange={(e) => updateLine(l.cid, { product: e.target.value })}
                  >
                    <option value="">Select product…</option>
                    {products.map((p) => (<option key={p.value} value={p.value}>{p.label}</option>))}
                  </CustomSelect>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={labelClass}>Batch</label>
                    <input type="text" className={`${inputClass} font-mono`}
                      value={l.batch_no}
                      onChange={(e) => updateLine(l.cid, { batch_no: e.target.value })}
                      placeholder="Optional" />
                  </div>
                  {!isOpening && (
                    <div>
                      <label className={labelClass}>Direction</label>
                      <CustomSelect
                        value={l.direction}
                        onChange={(e) => updateLine(l.cid, { direction: e.target.value })}
                      >
                        <option value="IN">IN (add)</option>
                        <option value="OUT">OUT (remove)</option>
                      </CustomSelect>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className={labelClass}>Qty (kg)</label>
                    <input type="number" step="0.001" min="0" className={numClass}
                      value={l.qty_kg}
                      onChange={(e) => updateLine(l.cid, { qty_kg: e.target.value })}
                      placeholder="0" />
                  </div>
                  <div>
                    <label className={labelClass}>Qty (L)</label>
                    <input type="number" step="0.001" min="0" className={numClass}
                      value={l.qty_ltr}
                      onChange={(e) => updateLine(l.cid, { qty_ltr: e.target.value })}
                      placeholder="0" />
                  </div>
                  <div>
                    <label className={labelClass}>Qty (pcs)</label>
                    <input type="number" step="1" min="0" className={numClass}
                      value={l.qty_count}
                      onChange={(e) => updateLine(l.cid, { qty_count: e.target.value })}
                      placeholder="0" />
                  </div>
                </div>
                <div>
                  <label className={labelClass}>Remarks</label>
                  <input type="text" className={inputClass}
                    value={l.remarks}
                    onChange={(e) => updateLine(l.cid, { remarks: e.target.value })}
                    placeholder="Line-level note (optional)" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}
    </MainLayout>
  );
}
