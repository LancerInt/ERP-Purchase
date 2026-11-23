import { confirm } from '@/components/common/confirm';
import CustomSelect from "@/components/ui/CustomSelect";
/**
 * Factory Stock Check section on the Sales Order detail page.
 *
 * Renders the matrix from the user's reference photos (files/sales
 * order/*.jpeg) — ordered SO lines × packing material columns, each
 * cell holding NEED / AVAILABLE / REQUIREMENT. REQUIREMENT is computed
 * client-side (AVAILABLE - NEED); negative cells are highlighted red.
 *
 * Two persistence paths:
 *   1. Edit cells inline → Save → POSTs the JSON matrix to
 *        /api/sales/orders/<id>/stock-check/
 *   2. Download Template → fetches /stock-check-template/, which
 *        returns a per-SO pre-filled XLSX matching the same matrix.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Package, Plus, Trash2, Download, Save, AlertTriangle, CheckCircle2, Loader2, X, Lock, ClipboardCheck, Check,
} from 'lucide-react';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { formatDateTime } from '@/utils/formatters';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';

const fmtQty = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0.000';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
};

const fmtDateTime = (iso) => {
  if (!iso) return '';
  return formatDateTime(iso);
};

// Color palette for material column headers — cycled in order. Matches
// the standalone Excel template's block colors so the digital UI feels
// familiar to factory members who started with the spreadsheet. The
// order block (Packing Size / Order / Finished / Remaining) gets its
// own neutral slate so it doesn't compete with the material blocks for
// visual weight.
const ORDER_HEADER_CLS = 'bg-slate-700 text-white';
const MATERIAL_HEADER_COLORS = [
  'bg-sky-600 text-white',
  'bg-violet-600 text-white',
  'bg-emerald-600 text-white',
  'bg-pink-600 text-white',
  'bg-orange-600 text-white',
  'bg-amber-600 text-white',
];

// ── Matrix shape (frontend) ──────────────────────────────────────────
// We keep the matrix as:
//   columns:  ordered list of material names (the union across all
//             lines). Empty cells render but are treated as 0.
//   rows:     one per SO line, holding finished_goods_qty + a map of
//             material_name → { need, available, uom, note }.
// On save we serialize back to the per-line { materials: [...] } shape
// the backend expects.

function buildMatrixFromServer(payload) {
  const columns = [];
  // Meta for each material column: { name -> { productId, uom } }.
  // Surfaces the master-product FK + UOM in a single place so the
  // per-row [+ Add] button can hydrate a fresh cell with the correct
  // link / unit when the user opts a previously-skipped row into the
  // material later. Populated from the first row that carries the
  // material — subsequent rows usually have the same meta.
  const materialMeta = {};
  const lines = (payload?.lines || []).map(line => {
    const materialMap = {};
    (line.materials || []).forEach(m => {
      if (!columns.includes(m.material_name)) columns.push(m.material_name);
      if (!materialMeta[m.material_name]) {
        materialMeta[m.material_name] = {
          productId: m.material_product || null,
          uom: m.material_uom || 'NOS',
        };
      }
      materialMap[m.material_name] = {
        id: m.id,
        need: m.need_qty != null ? String(m.need_qty) : '0',
        available: m.available_qty != null ? String(m.available_qty) : '0',
        // Live closing stock from the InventoryLedger — server-derived,
        // read-only on the UI. The save payload deliberately leaves
        // it out so a stale browser tab can't overwrite the ledger
        // number with a typed value.
        closing_stock: m.closing_stock != null ? String(m.closing_stock) : '0',
        uom: m.material_uom || 'NOS',
        note: m.note || '',
        // Preserve the master-product FK so re-saves don't break the
        // link when the user only edits NEED / AVAILABLE values.
        productId: m.material_product || null,
      };
    });
    return {
      so_line: line.so_line,
      line_no: line.line_no,
      product_name: line.product_name,
      product_sku: line.product_sku,
      product_id: line.product_id || '',
      // BOM gap flag from the backend — drives the per-row
      // "Create BOM Template" notice + button on the matrix.
      bom_missing: !!line.bom_missing,
      quantity_ordered: line.quantity_ordered,
      uom: line.uom,
      finished_goods_qty: line.finished_goods_qty != null ? String(line.finished_goods_qty) : '0',
      // Live closing stock for the SO line's FINISHED product at the
      // SO's warehouse — shown on the order row as "Available Stock".
      // Read-only, not echoed back on save.
      product_closing_stock: line.product_closing_stock != null
        ? String(line.product_closing_stock) : '0',
      line_notes: line.line_notes || '',
      materials: materialMap,
    };
  });
  // Top-level warehouse id/name from the matrix payload — needed by the
  // per-row Create BOM link's `?warehouse=` query param.
  return {
    columns,
    materialMeta,
    lines,
    warehouse: payload?.warehouse || '',
    warehouse_name: payload?.warehouse_name || '',
  };
}

function serializeMatrixForSave(matrix) {
  return matrix.lines.map(line => ({
    so_line: line.so_line,
    finished_goods_qty: line.finished_goods_qty || '0',
    line_notes: line.line_notes || '',
    materials: matrix.columns
      .map(name => {
        const cell = line.materials[name];
        if (!cell) return null;
        const need = Number(cell.need) || 0;
        const avail = Number(cell.available) || 0;
        // Drop empty cells (need=0 + avail=0 + no note + no product) so
        // we don't pollute the DB with zero rows. A cell that only
        // carries a product FK and no qty is also dropped — the column
        // header is re-derived from cells with actual values.
        if (need === 0 && avail === 0 && !cell.note && !cell.productId) return null;
        return {
          material_name: name,
          material_product: cell.productId || null,
          material_uom: cell.uom || 'NOS',
          need_qty: String(need),
          available_qty: String(avail),
          note: cell.note || '',
        };
      })
      .filter(Boolean),
  }));
}

// ── Cell components ──────────────────────────────────────────────────

function NumCell({ value, onChange, dimmed = false, readOnly = false, max }) {
  if (readOnly) {
    // Static display — either the viewer lacks edit permission OR the
    // row is locked because Remaining hit 0. We render the same look in
    // both cases since "you can't change this" is the same affordance.
    return (
      <div className="w-full px-2 py-1 text-sm text-right tabular-nums border border-slate-200 rounded bg-slate-50 text-slate-700">
        {fmtQty(value)}
      </div>
    );
  }
  return (
    <input
      type="number"
      step="0.001"
      min="0"
      max={max != null ? max : undefined}
      value={value}
      onChange={(e) => {
        let v = e.target.value;
        // Hard cap at `max` if provided. We clamp here rather than
        // relying on the browser's `max` attribute alone because
        // type=number still lets the user paste a larger value.
        if (max != null && v !== '') {
          const n = Number(v);
          const mn = Number(max);
          if (Number.isFinite(n) && Number.isFinite(mn) && n > mn) {
            v = String(mn);
          }
        }
        onChange(v);
      }}
      className={`w-full px-2 py-1 text-sm text-right tabular-nums border border-slate-200 rounded
        focus:outline-none focus:ring-1 focus:ring-indigo-500 ${dimmed ? 'bg-slate-50 text-slate-400' : 'bg-white'}`}
    />
  );
}

// AvailableCell — like NumCell, but with an "+ add" affordance so the
// user can pour incoming stock into the existing Available without
// doing mental math. Workflow the cell solves:
//
//   1. Need = 100, Available starts at 60, Requirement = -40 (shortage).
//   2. 40 more units arrive at the godown.
//   3. User clicks the small "+" icon, types "40", presses Enter.
//      The cell sets Available = 60 + 40 = 100. No need to clear the
//      cell first or do "100 − 60" in their head.
//
// The cell still supports direct typing for corrections — e.g. if the
// initial 60 was wrong and the user wants to overwrite, they type
// over the value as before. The "+" path is purely an addition helper.
// IncrementalCell — same component drives both AVAILABLE and FINISHED
// cells in the matrix. The popover title / placeholders read off the
// `label` prop ("Available", "Finished") and the `capLabel` prop
// (the label the cap represents — "Need" for available, "Ordered"
// for finished) so the messaging stays accurate either way.
function AvailableCell({ value, onChange, readOnly = false, max = null, label = 'Available', capLabel = 'Need' }) {
  const [adding, setAdding] = useState(false);
  const [increment, setIncrement] = useState('');

  // Cap = the Need value for this cell. When set and Available already
  // meets it, the row is "demand satisfied" and we forbid further adds:
  //   • The "+" trigger button is disabled with a tooltip.
  //   • Direct edits to the Available input get clamped to the cap.
  //   • The popover's Add button refuses anything that would overshoot.
  // `max=null` (no cap) preserves the historical free-edit behaviour for
  // rows where Need hasn't been entered yet.
  // Normalise the cap to 3dp up front. `max` (Need / Ordered qty) often
  // arrives as a Decimal string ("3.000") that converts to a float with
  // tiny drift (2.9999996…); rounding here keeps every downstream
  // comparison clean so typing the exact cap value isn't snapped below it.
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.round(Number(max) * 1000) / 1000 : null;
  const curVal = Number(value) || 0;
  const atCap = cap !== null && curVal >= cap;
  const remainingHeadroom = cap !== null ? Math.max(0, cap - curVal) : null;

  if (readOnly) {
    return (
      <div className="w-full px-2 py-1 text-sm text-right tabular-nums border border-slate-200 rounded bg-slate-50 text-slate-700">
        {fmtQty(value)}
      </div>
    );
  }

  // Round to the same precision the inputs use (step="0.001"). Plain
  // JS float math drifts at the 4th-7th decimal place when you do
  // 224.999 + 25 etc., which on this matrix used to surface as
  // "Finished = 249.999, Remaining = 0.001" even though the user
  // typed exactly +25. Rounding to 3dp normalises the commit so the
  // saved value matches what the user sees.
  const round3 = (n) => {
    if (!Number.isFinite(n)) return n;
    return Math.round(n * 1000) / 1000;
  };

  const commitAdd = () => {
    const inc = Number(increment) || 0;
    if (inc <= 0) {
      setIncrement('');
      setAdding(false);
      return;
    }
    // Hard cap: clamp the result at the Need value so the user can't
    // accidentally over-stock a row whose requirement has been met.
    const proposed = round3(curVal + inc);
    const next = cap !== null ? Math.min(proposed, round3(cap)) : proposed;
    onChange(String(next));
    setIncrement('');
    setAdding(false);
  };

  const cancelAdd = () => { setIncrement(''); setAdding(false); };

  // Direct-edit clamp — used by the non-popover input. If the user
  // pastes / types a value above the Need cap, snap it back to the cap.
  // Also rounds to 3dp so a paste of "249.99999" becomes "250.000".
  const clampDirect = (raw) => {
    if (raw === '') return raw;
    const n = Number(raw);
    if (!Number.isFinite(n)) return raw;
    const r = round3(n);
    // Epsilon-tolerant: typing the exact cap value (e.g. the full ordered
    // qty) must NOT be snapped below it by float drift, which was turning
    // a typed "3" into "2.999". Only clamp when genuinely over the cap.
    if (cap !== null && r > cap + 1e-6) return String(round3(cap));
    // Preserve whatever the user is typing if they haven't yet hit
    // the cap — only snap when there's actual drift to fix.
    return r !== n ? String(r) : raw;
  };

  // Tailwind utility chain that strips the native number-input spinner
  // arrows. The arrows eat ~16px of column width in WebKit and Firefox
  // — fine on a 200px field, fatal in this 110px material cell where
  // they were squeezing the Check / Cancel buttons off-screen.
  const NO_SPINNER = '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0';

  if (adding) {
    // Increment mode. The cell itself is ~110px wide which can't
    // comfortably hold input + check + cancel + spinner. Solution:
    // render a small floating POPOVER that escapes the cell, sized
    // generously (~240px) and positioned above the table so the
    // controls have room to breathe. The narrow underlying cell
    // continues to show the current Available (greyed out) so the
    // user sees the "before" value while typing the delta.
    const computedNext = (() => {
      const inc = Number(increment) || 0;
      if (!Number.isFinite(curVal) || !Number.isFinite(inc) || inc <= 0) return null;
      const proposed = round3(curVal + inc);
      // When capped, show the clamped value so the user sees the
      // actual result that'll be saved (not the over-cap dream).
      return cap !== null ? Math.min(proposed, round3(cap)) : proposed;
    })();
    const overCap = cap !== null && (curVal + (Number(increment) || 0)) > cap;
    return (
      <div className="relative">
        {/* Greyed-out display of the current Available so the cell
            doesn't visually collapse while the popover is open. */}
        <div className="w-full px-2 py-1 text-sm text-right tabular-nums border border-emerald-300 rounded bg-emerald-50 text-emerald-700">
          {fmtQty(value)}
        </div>
        {/* Floating popover — anchored to the right edge of the cell,
            sized 240px so input + label + buttons all fit. z-20 puts
            it above the matrix's sticky-header z-10. The transparent
            full-page backdrop click closes the popover so the user
            can dismiss by clicking outside. */}
        <div
          className="fixed inset-0 z-40"
          onClick={cancelAdd}
          aria-hidden="true"
        />
        <div className="absolute z-50 right-0 top-full mt-1 w-[240px] rounded-lg border border-emerald-300 bg-white shadow-lg p-3">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[10px] font-semibold text-emerald-700 uppercase tracking-wide">Add to {label}</p>
            <button
              type="button"
              onClick={cancelAdd}
              aria-label="Close"
              title="Close (Esc)"
              className="text-slate-400 hover:text-slate-700 p-0.5"
            >
              <X size={12} />
            </button>
          </div>
          <p className="text-[10px] text-slate-500 mb-2 tabular-nums">
            Current: <span className="text-slate-800 font-medium">{fmtQty(value)}</span>
            {cap !== null && (
              <> · {capLabel} cap: <span className="text-slate-800 font-medium">{fmtQty(cap)}</span></>
            )}
          </p>
          <input
            type="number"
            step="0.001"
            min="0"
            max={remainingHeadroom != null ? remainingHeadroom : undefined}
            autoFocus
            value={increment}
            onChange={(e) => setIncrement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitAdd(); }
              if (e.key === 'Escape') { e.preventDefault(); cancelAdd(); }
            }}
            placeholder={remainingHeadroom != null
              ? `Up to ${fmtQty(remainingHeadroom)}`
              : 'Quantity to add'}
            disabled={atCap}
            className={`w-full px-2 py-1.5 text-sm text-right tabular-nums border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-emerald-300 disabled:bg-slate-100 disabled:cursor-not-allowed ${NO_SPINNER}`}
          />
          {atCap && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-2">
              {capLabel} fully met — no further additions allowed.
            </p>
          )}
          {!atCap && overCap && (
            <p className="text-[11px] text-amber-700 mt-2">
              Capped at {capLabel} ({fmtQty(cap)}). Will save the clamped value.
            </p>
          )}
          {computedNext != null && (
            <p className="text-[11px] text-emerald-700 mt-2 tabular-nums">
              New {label}: <span className="font-semibold">{fmtQty(computedNext)}</span>
            </p>
          )}
          <div className="flex items-center gap-2 mt-3">
            <button
              type="button"
              onClick={cancelAdd}
              className="flex-1 px-2 py-1.5 text-xs font-medium border border-slate-300 text-slate-700 rounded hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={commitAdd}
              disabled={atCap || !(Number(increment) > 0)}
              className="flex-1 px-2 py-1.5 text-xs font-medium text-white bg-emerald-600 rounded hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center justify-center gap-1"
            >
              <Check size={12} /> Add
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-stretch gap-0.5">
      <input
        type="number"
        step="0.001"
        min="0"
        max={cap !== null ? cap : undefined}
        value={value}
        onChange={(e) => onChange(clampDirect(e.target.value))}
        title={atCap ? `${capLabel} fully met (${fmtQty(cap)}) — capped.` : ''}
        className={`flex-1 min-w-0 px-2 py-1 text-sm text-right tabular-nums border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500 bg-white ${NO_SPINNER}`}
      />
      <button
        type="button"
        onClick={() => setAdding(true)}
        disabled={atCap}
        title={atCap
          ? `${capLabel} fully met (${fmtQty(cap)}) — no further additions allowed.`
          : `Add to ${label} — folds the entered qty into the existing ${label}`}
        className="px-1.5 text-emerald-700 border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 rounded flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}

// Read-only AVAILABLE display — the value is fetched server-side from
// the InventoryLedger at the SO's warehouse and stamped onto each
// material row before the matrix is serialized. The factory cannot
// type into this cell; it always reflects live on-hand stock.
function AvailableDisplay({ value }) {
  return (
    <div className="px-2 py-1 text-sm text-right tabular-nums rounded border bg-sky-50 border-sky-200 text-sky-900 font-medium">
      {fmtQty(value)}
    </div>
  );
}

function ReqCell({ need, available }) {
  // Round to 3dp to match the input step. Without this, a row whose
  // Available was built up via "+ add" operations can show a phantom
  // -0.001 or +0.001 in the requirement column even though the user's
  // arithmetic was exact.
  const rawReq = (Number(available) || 0) - (Number(need) || 0);
  const req = Math.round(rawReq * 1000) / 1000;
  const isShort = req < 0;
  const isMatch = req === 0;
  const cls = isShort
    ? 'text-red-700 bg-red-50 border-red-200 font-semibold'
    : isMatch
      ? 'text-slate-600 bg-slate-50 border-slate-200'
      : 'text-emerald-700 bg-emerald-50 border-emerald-200 font-medium';
  return (
    <div className={`px-2 py-1 text-sm text-right tabular-nums rounded border ${cls}`}>
      {fmtQty(req)}
    </div>
  );
}

// ── Add/Remove material column dialog ────────────────────────────────
// Product picker sourced from /api/products/. Filter input runs against
// product name + SKU so the factory can type "5kg bucket" or "PCK-001"
// to find the row. The picker is keyboard-friendly — arrow keys move,
// Enter confirms, Esc dismisses.

// Category tabs for the picker. "All" shows every active product so
// the dropdown is never empty for masters that haven't tagged
// goods_sub_type yet. The narrower tabs (Packing Material, Raw
// Material, Consumables) become useful once products are categorised
// — counts on each tab let the user see at a glance whether that
// scoping will help. FINISHED_GOOD is deliberately omitted: the
// finished products are the SO line items themselves, not inputs to
// the matrix.
const FACTORY_CATEGORY_OPTIONS = [
  { value: '',                 label: 'All' },
  { value: 'PACKING_MATERIAL', label: 'Packing Material' },
  { value: 'RAW_MATERIAL',     label: 'Raw Material' },
  { value: 'CONSUMABLES',      label: 'Consumables' },
];

function AddMaterialDialog({ onAdd, onClose, existingColumnNames }) {
  // We rely on the same lookup the rest of the sales module uses, so
  // the product list is already cached most of the time.
  const { options: productOptions, raw: rawProducts } = useLookup('/api/products/');
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState('');
  // Default scope to "All" so the picker is never empty when the
  // master hasn't been categorised yet. Once products get a
  // goods_sub_type the user can click into the narrower tab — counts
  // are visible right on each tab.
  const [category, setCategory] = useState('');

  // Filter against name + SKU. Exclude products that are already
  // present as a column on this matrix so the factory can't add the
  // same material twice. Also restrict to the selected category so the
  // dropdown isn't polluted with finished-good rows.
  const taken = useMemo(() => new Set((existingColumnNames || []).map(n => n.toUpperCase().trim())), [existingColumnNames]);
  const filteredProducts = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return rawProducts
      .filter(p => {
        // Category gate — empty string means "All" so we accept every
        // product regardless of goods_sub_type.
        if (category && p.goods_sub_type !== category) return false;
        const name = (p.product_name || '').toString();
        const sku = (p.sku_code || '').toString();
        const tradeName = (p.product_trade_name || '').toString();
        if (taken.has(name.toUpperCase().trim())) return false;
        if (!term) return true;
        return (
          name.toLowerCase().includes(term)
          || sku.toLowerCase().includes(term)
          || tradeName.toLowerCase().includes(term)
        );
      })
      .slice(0, 200);   // hard cap — the user can keep typing to narrow
  }, [rawProducts, filter, taken, category]);

  // Pre-flight count per category. The "All" bucket is the total
  // product count; narrower buckets carry their goods_sub_type tally.
  const countsByCategory = useMemo(() => {
    const c = { '': rawProducts.length };
    FACTORY_CATEGORY_OPTIONS.forEach(o => { if (o.value) c[o.value] = 0; });
    rawProducts.forEach(p => {
      if (c[p.goods_sub_type] !== undefined) c[p.goods_sub_type] += 1;
    });
    return c;
  }, [rawProducts]);

  const selectedProduct = useMemo(
    () => rawProducts.find(p => p.id === selectedId),
    [rawProducts, selectedId],
  );

  const handleConfirm = () => {
    if (!selectedProduct) return;
    onAdd({
      name: selectedProduct.product_name || selectedProduct.sku_code || 'Unnamed',
      productId: selectedProduct.id,
      uom: selectedProduct.uom || 'NOS',
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full max-h-[90dvh] sm:max-h-[80dvh] flex flex-col" role="dialog" aria-modal="true" aria-label="Add packing material column" onClick={e => e.stopPropagation()}>
        <div className="px-4 sm:px-6 py-4 border-b flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900">Add packing material column</h3>
          <button onClick={onClose} aria-label="Close" title="Close" className="text-slate-400 hover:text-slate-700"><X size={18} /></button>
        </div>
        <div className="p-4 sm:p-6 space-y-3 overflow-y-auto">
          <label className="block text-sm font-medium text-slate-700">Pick from Product master</label>

          {/* Category tabs — restrict the picker to product types
              actually used as inputs by the factory. PACKING_MATERIAL
              is selected by default; the user can switch to RAW or
              CONSUMABLES if their matrix tracks those too. Finished
              goods are deliberately not offered here — they're the
              line items the matrix is ABOUT, not the materials it
              consumes. */}
          <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden text-xs">
            {FACTORY_CATEGORY_OPTIONS.map((opt, i) => {
              const count = countsByCategory[opt.value] || 0;
              const isSel = category === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => { setCategory(opt.value); setSelectedId(''); }}
                  disabled={count === 0 && !isSel}
                  className={`px-3 py-1.5 ${i > 0 ? 'border-l' : ''}
                    ${isSel ? 'bg-indigo-600 text-white' : 'text-slate-700 hover:bg-slate-50'}
                    disabled:opacity-50 disabled:cursor-not-allowed`}
                  title={count === 0 ? 'No products in this category yet' : ''}
                >
                  {opt.label}
                  <span className={`ml-1.5 ${isSel ? 'text-white/70' : 'text-slate-400'}`}>({count})</span>
                </button>
              );
            })}
          </div>

          <input
            type="text"
            autoFocus
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Search by name, SKU or trade name…"
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && selectedId) handleConfirm();
            }}
          />
          <div className="border border-slate-200 rounded-lg max-h-72 overflow-y-auto bg-white">
            {filteredProducts.length === 0 ? (
              <p className="px-3 py-4 sm:py-6 text-center text-sm text-slate-400">
                {rawProducts.length === 0
                  ? 'Loading products…'
                  : filter
                    ? 'No products match this search.'
                    : category && (countsByCategory[category] || 0) === 0
                      ? `No products in the "${FACTORY_CATEGORY_OPTIONS.find(o => o.value === category)?.label}" category yet — switch to "All" or tag products in Product master.`
                      : 'All products are already added as columns.'}
              </p>
            ) : (
              <ul>
                {filteredProducts.map(p => {
                  const isSel = p.id === selectedId;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(p.id)}
                        onDoubleClick={() => { setSelectedId(p.id); setTimeout(handleConfirm, 0); }}
                        className={`w-full text-left px-3 py-2 text-sm border-b border-slate-100 last:border-b-0 transition
                          ${isSel ? 'bg-indigo-50 text-indigo-900' : 'hover:bg-slate-50'}`}
                      >
                        <div className="font-medium">{p.product_name || '(unnamed)'}</div>
                        <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
                          {p.sku_code && <span className="font-mono">{p.sku_code}</span>}
                          {p.uom && <span>· {p.uom}</span>}
                          {p.goods_sub_type && <span>· {p.goods_sub_type.replace(/_/g, ' ').toLowerCase()}</span>}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <p className="text-xs text-slate-500">
            The column will appear for every line on the matrix. Fill NEED + AVAILABLE only on the lines that actually consume this material — leave the others at 0.
          </p>
        </div>
        <div className="px-4 sm:px-6 py-4 border-t bg-slate-50 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-white">Cancel</button>
          <button
            onClick={handleConfirm}
            disabled={!selectedId}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50">
            Add column
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Inline category → product picker ─────────────────────────────────
// Sits above the matrix as a compact row of two dropdowns and an Add
// button: pick a Category, the Product dropdown filters to that
// category, click Add to append the material as a new column. This is
// the fast path for users who already know the product they want —
// the original modal (AddMaterialDialog) stays available for cases
// where they need to search by SKU / trade name.
function InlineAddMaterialRow({ existingColumnNames, onAdd }) {
  const { raw: rawProducts } = useLookup('/api/products/');
  const [category, setCategory] = useState('');
  // Set of product ids the user has ticked. Multi-select so several
  // products can be batched into a single "Add" click — common case
  // when the user is acknowledging a fresh SO and needs every
  // packing-material column at once.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);

  // Same exclusion rule as the modal — don't let the user pick a
  // product that's already a column on this matrix.
  const taken = useMemo(
    () => new Set((existingColumnNames || []).map(n => n.toUpperCase().trim())),
    [existingColumnNames],
  );

  // Products available for the currently-selected category and
  // current search term. Empty category = all categories.
  const filteredProducts = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return rawProducts
      .filter(p => {
        if (category && p.goods_sub_type !== category) return false;
        const name = (p.product_name || '').toString();
        const sku = (p.sku_code || '').toString();
        const trade = (p.product_trade_name || '').toString();
        if (taken.has(name.toUpperCase().trim())) return false;
        if (!term) return true;
        return (
          name.toLowerCase().includes(term)
          || sku.toLowerCase().includes(term)
          || trade.toLowerCase().includes(term)
        );
      })
      .slice(0, 500);
  }, [rawProducts, category, taken, filter]);

  // Clear ticks whenever the category changes — the previously-picked
  // products may not exist under the new filter and we don't want
  // hidden checked items to silently land on the matrix on Add.
  useEffect(() => { setSelectedIds(new Set()); }, [category]);

  // Click-outside dismissal for the dropdown panel.
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggleSelected = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      filteredProducts.forEach(p => next.add(p.id));
      return next;
    });
  };

  const clearAll = () => setSelectedIds(new Set());

  const handleAdd = () => {
    if (selectedIds.size === 0) return;
    // Add every ticked product as its own column on the matrix. Each
    // call to onAdd seeds a NEED/AVAILABLE/REMAINING triplet for every
    // existing line, matching the layout of any previously-added
    // material column. Order preserved from the filtered list so the
    // user gets a predictable left-to-right append.
    filteredProducts.forEach(p => {
      if (!selectedIds.has(p.id)) return;
      onAdd({
        name: p.product_name || p.sku_code || 'Unnamed',
        productId: p.id,
        uom: p.uom || 'NOS',
      });
    });
    setSelectedIds(new Set());
    setFilter('');
    setOpen(false);
  };

  const selectedCount = selectedIds.size;
  const triggerLabel = selectedCount === 0
    ? '— Select product(s) —'
    : `${selectedCount} selected`;

  return (
    <div className="mb-3 p-3 bg-indigo-50/40 border border-indigo-200 rounded-lg flex flex-col sm:flex-row sm:items-end gap-3">
      <div className="flex-1 min-w-0">
        <label className="block text-[11px] font-medium text-slate-600 uppercase tracking-wide mb-1">
          Category
        </label>
        <CustomSelect
          value={category}
          onChange={e => setCategory(e.target.value)}
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-indigo-500"
        >
          {FACTORY_CATEGORY_OPTIONS.map(opt => (
            <option key={opt.value || 'all'} value={opt.value}>{opt.label}</option>
          ))}
        </CustomSelect>
      </div>
      <div className="flex-1 min-w-0 relative" ref={wrapperRef}>
        <label className="block text-[11px] font-medium text-slate-600 uppercase tracking-wide mb-1">
          Product(s)
        </label>
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white text-left focus:ring-2 focus:ring-indigo-500 flex items-center justify-between gap-2"
        >
          <span className={selectedCount === 0 ? 'text-slate-400' : 'text-slate-800'}>
            {triggerLabel}
          </span>
          <span className="text-slate-400 text-xs">{open ? '▴' : '▾'}</span>
        </button>
        {open && (
          <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-slate-300 rounded-lg shadow-lg p-2">
            <input
              type="text"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Search by name, SKU or trade name…"
              autoFocus
              className="w-full mb-2 px-2 py-1.5 text-sm border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
            <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1 px-1">
              <span>
                {filteredProducts.length} product{filteredProducts.length === 1 ? '' : 's'}
                {selectedCount > 0 && ` · ${selectedCount} selected`}
              </span>
              <div className="flex gap-2">
                {filteredProducts.length > 0 && (
                  <button type="button" onClick={selectAllVisible}
                    className="text-indigo-600 hover:underline">Select all</button>
                )}
                {selectedCount > 0 && (
                  <button type="button" onClick={clearAll}
                    className="text-slate-500 hover:underline">Clear</button>
                )}
              </div>
            </div>
            <div className="max-h-60 overflow-y-auto border border-slate-100 rounded">
              {filteredProducts.length === 0 ? (
                <p className="px-3 py-4 sm:py-6 text-center text-xs text-slate-400">
                  {rawProducts.length === 0
                    ? 'Loading products…'
                    : filter
                      ? 'No products match this search.'
                      : 'No products available in this category.'}
                </p>
              ) : (
                <ul>
                  {filteredProducts.map(p => {
                    const checked = selectedIds.has(p.id);
                    return (
                      <li key={p.id}>
                        <label className={`flex items-center gap-2 px-2 py-1.5 text-sm cursor-pointer border-b border-slate-50 last:border-b-0 ${checked ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleSelected(p.id)}
                            className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          />
                          <span className="flex-1 min-w-0">
                            <span className="block font-medium text-slate-800 truncate">
                              {p.product_name || '(unnamed)'}
                            </span>
                            <span className="block text-[11px] text-slate-500 truncate">
                              {p.sku_code || ''}
                              {p.uom ? ` · ${p.uom}` : ''}
                              {p.goods_sub_type ? ` · ${p.goods_sub_type.replace(/_/g, ' ').toLowerCase()}` : ''}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={handleAdd}
        disabled={selectedCount === 0}
        className="inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
      >
        <Plus size={14} />
        {selectedCount > 1 ? `Add ${selectedCount} materials` : 'Add material'}
      </button>
    </div>
  );
}

// ── Main section ─────────────────────────────────────────────────────

export default function StockCheckSection({ soId, soNo, onAllFinishedChange, soStatus = '' }) {
  // Permission gate — only users with the "Acknowledge" capability on
  // the Sales Order module (typically the Factory role) may
  // acknowledge / submit the matrix. Everyone else sees the
  // matrix read-only without the action buttons. Backend enforces the
  // same gate via check_permission(..., 'acknowledge') so a stale
  // session can't bypass the UI. Pre-migration 0010 this was a
  // can_confirm check; now it's a dedicated flag so admins can grant
  // factory acknowledgement separately from generic Confirm.
  const { canAcknowledge, canCreateBom } = usePermissions();
  const canFactoryAcknowledge = canAcknowledge('Sales Order');
  // Per-row "Create BOM Template" button gate. The button only shows
  // up on matrix rows whose product has no BOM at the SO's warehouse;
  // a role without can_create_bom on the Sales Order module sees the
  // "BOM missing" notice but no button.
  const canFactoryCreateBom = canCreateBom('Sales Order');

  const [matrix, setMatrix] = useState({ columns: [], materialMeta: {}, lines: [] });
  const [header, setHeader] = useState({
    acknowledged_at: null,
    acknowledged_by_name: '',
    submitted_at: null,
    submitted_by_name: '',
    factory_remarks: '',
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isAcking, setIsAcking] = useState(false);
  // Tracks whether the matrix has user edits that haven't been saved
  // yet. Used to keep Submit clickable when the user edits an
  // already-submitted matrix — otherwise the `allFinished` gate (which
  // is computed from local state) auto-disables Submit the moment the
  // user types the final quantity, silently losing the typed value on
  // refresh because it was never POSTed.
  const [dirty, setDirty] = useState(false);

  const absorbResponse = (data) => {
    setMatrix(buildMatrixFromServer(data));
    setHeader({
      acknowledged_at: data.acknowledged_at,
      acknowledged_by_name: data.acknowledged_by_name || '',
      submitted_at: data.submitted_at,
      submitted_by_name: data.submitted_by_name || '',
      factory_remarks: data.factory_remarks || '',
    });
    // Server state is now the source of truth — drop the dirty flag
    // so Submit returns to disabled until the user edits again.
    setDirty(false);
  };

  const loadMatrix = async () => {
    setIsLoading(true);
    try {
      const res = await apiClient.get(`/api/sales/orders/${soId}/stock-check/`);
      absorbResponse(res.data);
    } catch (err) {
      // 404 is fine — no SO line yet. The serializer also handles
      // empty SOs by returning lines=[].
      const msg = err.response?.data?.detail;
      if (msg) toast.error(msg);
    } finally {
      setIsLoading(false);
    }
  };

  // Factory accepts ownership of the SO — unlocks the matrix below.
  // Doesn't write any cell data; subsequent Save Draft / Submit do.
  const handleAcknowledge = async () => {
    setIsAcking(true);
    try {
      const res = await apiClient.post(`/api/sales/orders/${soId}/stock-check/`, {
        acknowledge: true,
      });
      absorbResponse(res.data);
      toast.success('Sales Order acknowledged. You can now fill the stock check.');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsAcking(false);
    }
  };

  useEffect(() => { if (soId) loadMatrix(); }, [soId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cell editing ──
  const setFinished = (lineIdx, val) => {
    setMatrix(prev => ({
      ...prev,
      lines: prev.lines.map((l, i) => i === lineIdx ? { ...l, finished_goods_qty: val } : l),
    }));
    setDirty(true);
  };
  const setCell = (lineIdx, matName, field, val) => {
    setMatrix(prev => ({
      ...prev,
      lines: prev.lines.map((l, i) => {
        if (i !== lineIdx) return l;
        const existing = l.materials[matName] || { need: '0', available: '0', uom: 'NOS', note: '' };
        return { ...l, materials: { ...l.materials, [matName]: { ...existing, [field]: val } } };
      }),
    }));
    setDirty(true);
  };

  const addColumn = ({ name, productId, uom }) => {
    if (matrix.columns.includes(name)) {
      toast.error(`"${name}" column already exists.`);
      return;
    }
    // Add the column to the header row + remember its meta (product
    // FK and UOM) but DON'T seed cells on every line. A material
    // typically applies to only one of the SO line products (e.g.
    // "Bag Anandham Gold - 40 Kg" is used by exactly one of the
    // Nimbecidine variants), so pre-filling NEED/AVAILABLE/REMAINING
    // on every row just creates noise the user has to skip past.
    // Lines that don't have the material show a small [+ Add] button
    // instead — clicking it activates the cells for that row only.
    setMatrix(prev => ({
      ...prev,
      columns: [...prev.columns, name],
      materialMeta: {
        ...(prev.materialMeta || {}),
        [name]: { productId: productId || null, uom: uom || 'NOS' },
      },
      // Lines untouched — each row decides whether to opt in.
      lines: prev.lines,
    }));
    setDirty(true);
  };

  // Per-row "this material applies to me" toggle. activateCell seeds
  // the cell with 0/0 + the material's meta so the user immediately
  // gets editable NEED/AVAILABLE inputs. deactivateCell removes it
  // again (for "I added this row by mistake, remove just this cell").
  const activateCell = (lineIdx, matName) => {
    setMatrix(prev => {
      const meta = (prev.materialMeta || {})[matName]
        || { productId: null, uom: 'NOS' };
      return {
        ...prev,
        lines: prev.lines.map((l, i) => {
          if (i !== lineIdx) return l;
          // Already present? No-op so a stray double-click doesn't
          // overwrite an in-progress entry with zeros.
          if (l.materials[matName]) return l;
          return {
            ...l,
            materials: {
              ...l.materials,
              [matName]: {
                need: '0',
                available: '0',
                uom: meta.uom,
                productId: meta.productId,
                note: '',
              },
            },
          };
        }),
      };
    });
    setDirty(true);
  };

  const deactivateCell = (lineIdx, matName) => {
    setMatrix(prev => ({
      ...prev,
      lines: prev.lines.map((l, i) => {
        if (i !== lineIdx) return l;
        const next = { ...l.materials };
        delete next[matName];
        return { ...l, materials: next };
      }),
    }));
    setDirty(true);
  };

  const removeColumn = async (name) => {
    if (!(await confirm({ message: `Remove "${name}" column from every line? Cells with values will be deleted on save.`, isDangerous: true }))) return;
    setMatrix(prev => ({
      ...prev,
      columns: prev.columns.filter(c => c !== name),
      materialMeta: (() => {
        const m = { ...(prev.materialMeta || {}) };
        delete m[name];
        return m;
      })(),
      lines: prev.lines.map(l => {
        const next = { ...l.materials };
        delete next[name];
        return { ...l, materials: next };
      }),
    }));
    setDirty(true);
  };

  // ── Save ──
  const handleSave = async (submit = false) => {
    setIsSaving(true);
    try {
      const payload = {
        factory_remarks: header.factory_remarks,
        submit,
        lines: serializeMatrixForSave(matrix),
      };
      const res = await apiClient.post(`/api/sales/orders/${soId}/stock-check/`, payload);
      absorbResponse(res.data);
      toast.success(submit ? 'Stock check submitted.' : 'Draft saved.');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  // ── Download template ──
  const handleDownload = async () => {
    setIsDownloading(true);
    try {
      const res = await apiClient.get(`/api/sales/orders/${soId}/stock-check-template/`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${soNo || 'so'}_stock_check.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast.success('Template downloaded.');
    } catch {
      toast.error('Failed to download template.');
    } finally {
      setIsDownloading(false);
    }
  };

  // ── DC gating ──
  // A line is "fully finished" when its finished_goods_qty meets the
  // SO's quantity_ordered. The Done badge + read-only lock only fire
  // AFTER the matrix has been Submitted — until then the user can
  // freely type, retype, and correct typos even if Remaining = 0 in
  // the meantime. Locking mid-keystroke would block the user from
  // fixing a fat-finger entry.
  //
  // Gate driven by `header.submitted_at` (set by the backend once
  // /stock-check/ is posted with submit=true).
  const isSubmitted = !!header.submitted_at;
  const isLineFullyFinished = (line) => {
    const ordered = Number(line.quantity_ordered) || 0;
    const finished = Number(line.finished_goods_qty) || 0;
    return ordered > 0 && finished >= ordered;
  };
  const isLineLocked = (line) => isSubmitted && isLineFullyFinished(line);
  // Create-DC button on the SO detail page lights up only when the
  // matrix is submitted AND every line is finished. Lighting it up
  // on live (draft) values would let the user create a DC against
  // unsaved numbers.
  const allFinished = useMemo(() => (
    isSubmitted
      && matrix.lines.length > 0
      && matrix.lines.every(isLineFullyFinished)
  ), [isSubmitted, matrix.lines]);

  // The Create-DC button lights up once the factory has ENTERED physical
  // stock for every line — the physical quantity no longer has to equal the
  // SO quantity (a partial physical stock is enough to start a dispatch).
  // Dispatch qty itself is still capped at the SO/pending quantity in the DC
  // modal, so a DC can never exceed what was ordered.
  const readyForDispatch = useMemo(() => (
    isSubmitted
      && matrix.lines.length > 0
      && matrix.lines.every(line => (Number(line.finished_goods_qty) || 0) > 0)
  ), [isSubmitted, matrix.lines]);

  // Bubble the "every line finished" flag up to the parent (SO detail
  // page). The detail page renders its own Create-Dispatch-Challan
  // button in the header — it needs to know when the matrix says
  // "ready to ship" so it can light up. We avoid `onAllFinishedChange`
  // in the deps so a callback identity change doesn't re-fire.
  //
  // Gated on `!dirty` so the DC button only lights up after the typed
  // Finished value has actually been POSTed and confirmed by the
  // server. Without the gate the button appeared mid-keystroke — the
  // moment local state made every line look fully finished — letting
  // the user create a DC against numbers that hadn't yet been saved.
  useEffect(() => {
    if (typeof onAllFinishedChange === 'function') {
      onAllFinishedChange(readyForDispatch && !dirty);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyForDispatch, dirty]);

  // ── Shortfall summary ──
  const shortfalls = useMemo(() => {
    const list = [];
    matrix.lines.forEach(line => {
      matrix.columns.forEach(matName => {
        const cell = line.materials[matName];
        if (!cell) return;
        const need = Number(cell.need) || 0;
        const avail = Number(cell.available) || 0;
        const req = avail - need;
        if (req < 0) {
          list.push({
            line_no: line.line_no,
            product_name: line.product_name,
            material_name: matName,
            need, available: avail, shortfall: -req,
          });
        }
      });
    });
    return list;
  }, [matrix]);

  if (isLoading) {
    return (
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
        <div className="h-32 bg-slate-100 rounded animate-pulse" />
      </div>
    );
  }

  const hasLines = matrix.lines.length > 0;
  const acknowledged = !!header.acknowledged_at;
  const submitted = !!header.submitted_at;

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3 mb-4 sm:mb-5 pb-2 border-b">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-indigo-100 text-indigo-700">
              <Package size={15} />
            </span>
            Factory Stock Check
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            For each finished product the SO contains, declare packing-material need vs. available stock. Negative cells show shortfalls to procure.
          </p>
          {acknowledged && (
            <p className="text-xs text-sky-700 mt-1 inline-flex items-center gap-1">
              <ClipboardCheck size={12} /> Acknowledged on {fmtDateTime(header.acknowledged_at)}
              {header.acknowledged_by_name && ` by ${header.acknowledged_by_name}`}
            </p>
          )}
          {submitted && (
            <p className="text-xs text-emerald-700 mt-1 inline-flex items-center gap-1">
              <CheckCircle2 size={12} /> Submitted on {fmtDateTime(header.submitted_at)}
              {header.submitted_by_name && ` by ${header.submitted_by_name}`}
            </p>
          )}
        </div>
        {/* Action bar — gated four ways:
              1. SO not yet APPROVED → nothing acknowledgable. Show a
                 small "Awaiting approval" hint instead.
              2. SO APPROVED + pre-acknowledgement + has Confirm
                 permission → "Acknowledge Sales Order".
              3. Pre-acknowledgement WITHOUT permission → nothing
                 here; the body below shows a "no permission" message.
              4. Post-acknowledgement → full set (Download /
                 Add Material / Submit). Save Draft was removed —
                 Submit is the only commit path now.
            soStatus is passed from the parent SO detail page; we
            only allow the acknowledge step when the SO has been
            APPROVED upstream. */}
        <div className="flex flex-wrap items-center gap-2">
          {!acknowledged && hasLines && canFactoryAcknowledge && soStatus === 'APPROVED' && (
            <button onClick={handleAcknowledge} disabled={isAcking}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-sky-600 text-white rounded-lg hover:bg-sky-700 disabled:opacity-50 font-semibold">
              {isAcking ? <Loader2 size={14} className="animate-spin" /> : <ClipboardCheck size={14} />}
              Acknowledge Sales Order
            </button>
          )}
          {acknowledged && (
            <>
              <button onClick={handleDownload} disabled={isDownloading || !hasLines}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                {isDownloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                Download Template
              </button>
              {canFactoryAcknowledge && (
                <>
                  {/* "Add Material Column" button was removed — the
                      inline category → product picker below the action
                      row (InlineAddMaterialRow) is the single path for
                      appending columns now. It's faster for users who
                      already know which product they want and avoids
                      the extra modal step. The AddMaterialDialog
                      component is still in this file in case we need
                      to re-introduce the modal flow later. */}
                  {/* Save Draft was removed — Submit is the single
                      commit path now. Submitted values are then
                      locked per row (see isLineLocked). Disabled when
                      the matrix is closed (every line fully finished)
                      AND there are no unsaved edits to persist; the
                      moment the user types anything new the `dirty`
                      flag flips and Submit re-enables so the typed
                      value can be POSTed. Without the dirty guard,
                      Submit auto-disabled the instant the user typed
                      the final quantity into Finished — the typed
                      value never reached the server and a refresh
                      silently dropped it. */}
                  <button onClick={() => handleSave(true)} disabled={isSaving || !hasLines || (allFinished && !dirty)}
                    title={allFinished && !dirty ? 'Matrix closed — no unsaved changes' : ''}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed">
                    {isSaving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                    Submit
                  </button>
                </>
              )}
              {/* Create-Dispatch-Challan button lives on the SO detail
                  page header now — see [id].jsx. The button there is
                  gated on (allFinished && totalPending > 0) so it
                  disappears as soon as the SO is fully dispatched.
                  This section just owns the matrix state and bubbles
                  `allFinished` up via `onAllFinishedChange`. */}
            </>
          )}
        </div>
      </div>

      {!hasLines && (
        <div className="p-4 sm:p-6 bg-slate-50 rounded-lg text-center text-sm text-slate-500">
          This Sales Order has no product lines yet. Add lines to start the stock check.
        </div>
      )}

      {/* Pre-acknowledgement gate. Three variants:
            • SO not yet APPROVED → "Waiting for SO approval" notice;
              no acknowledge CTA, the matrix stays closed.
            • SO APPROVED + user HAS confirm permission → action card
              with the CTA and a 3-step explainer. The Acknowledge
              button in the header above is the actionable element.
            • SO APPROVED + user LACKS confirm permission → read-only
              "Awaiting" card explaining a Factory role is needed. */}
      {hasLines && !acknowledged && soStatus !== 'APPROVED' && (
        <div className="border-2 border-dashed border-slate-300 bg-slate-50 rounded-lg p-4 sm:p-8 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-slate-100 text-slate-500 mb-3">
            <Lock size={24} />
          </div>
          <h3 className="text-base font-semibold text-slate-900 mb-1">
            Waiting for Sales Order approval
          </h3>
          <p className="text-sm text-slate-600 max-w-md mx-auto">
            Factory Stock Check opens for acknowledgement once the Sales Order is <strong>Approved</strong>.
            {soStatus
              ? <> Current status: <strong>{soStatus}</strong>.</>
              : null}
            {' '}Get the SO approved on this page first, then a factory user can acknowledge and start filling the matrix.
          </p>
        </div>
      )}
      {hasLines && !acknowledged && soStatus === 'APPROVED' && canFactoryAcknowledge && (
        <div className="border-2 border-dashed border-sky-300 bg-sky-50 rounded-lg p-4 sm:p-8 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-sky-100 text-sky-700 mb-3">
            <Lock size={24} />
          </div>
          <h3 className="text-base font-semibold text-slate-900 mb-1">
            Awaiting factory acknowledgement
          </h3>
          <p className="text-sm text-slate-600 max-w-md mx-auto mb-4">
            The stock-check matrix unlocks once a factory member acknowledges this Sales Order. Click <strong>Acknowledge Sales Order</strong> above to take ownership and start declaring packing-material stock for each line.
          </p>
          <div className="text-xs text-slate-500 grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl mx-auto">
            <div className="p-3 bg-white rounded border border-sky-200">
              <p className="font-semibold text-slate-700 mb-0.5">1. Acknowledge</p>
              <p>Factory accepts ownership of this SO.</p>
            </div>
            <div className="p-3 bg-white rounded border border-sky-200">
              <p className="font-semibold text-slate-700 mb-0.5">2. Fill matrix</p>
              <p>For each finished product, enter packing-material need vs. stock.</p>
            </div>
            <div className="p-3 bg-white rounded border border-sky-200">
              <p className="font-semibold text-slate-700 mb-0.5">3. Submit</p>
              <p>Send the completed sheet back to sales for review.</p>
            </div>
          </div>
        </div>
      )}

      {hasLines && !acknowledged && soStatus === 'APPROVED' && !canFactoryAcknowledge && (
        <div className="border-2 border-dashed border-slate-300 bg-slate-50 rounded-lg p-4 sm:p-8 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-slate-100 text-slate-500 mb-3">
            <Lock size={24} />
          </div>
          <h3 className="text-base font-semibold text-slate-900 mb-1">
            Awaiting factory acknowledgement
          </h3>
          <p className="text-sm text-slate-600 max-w-md mx-auto">
            This Sales Order hasn't been acknowledged by the factory yet. A user with the <strong>Acknowledge</strong> permission on the Sales Order module (typically the Factory role) needs to acknowledge before the stock-check matrix opens for editing.
          </p>
          <p className="text-xs text-slate-400 mt-3">
            Admins can grant this permission via Settings → Roles &amp; Permissions.
          </p>
        </div>
      )}

      {hasLines && acknowledged && (
        <>
          {/* Inline category → product picker. Faster than the
              modal-based "Add Material Column" button for users who
              already know which product they want — pick a category,
              the product dropdown filters automatically, click Add. */}
          {/* Manual category/product picker removed — material rows
              now come from the per-product BOM keyed to the SO's
              warehouse. When a product has no BOM the matrix shows a
              "Create BOM Template" button on that row (gated by
              `can_create_bom` on the Sales Order module). */}
          {/* Mobile-only stacked layout. The desktop matrix below is
              horizontally scrollable, which on a phone forces the
              user to scroll sideways through tiny cells and constantly
              lose the row they're working on. This card layout keeps
              everything visible per product, with each material as a
              labelled sub-section. Editing affordances (NumCell,
              AvailableCell, ReqCell, Add/Remove buttons) are reused
              from the desktop table so behavior stays identical. */}
          <div className="sm:hidden space-y-3 mb-4">
            {matrix.lines.map((line, lineIdx) => {
              const lineLocked = isLineLocked(line);
              const rowReadOnly = !canFactoryAcknowledge || lineLocked;
              const remaining = Math.round(
                ((Number(line.quantity_ordered) || 0)
                  - (Number(line.finished_goods_qty) || 0)) * 1000,
              ) / 1000;
              return (
                <div
                  key={`m-${line.so_line}`}
                  className={`border rounded-lg overflow-hidden ${lineLocked ? 'bg-emerald-50/30 border-emerald-200' : 'border-slate-200 bg-white'}`}
                >
                  {/* Card header — product identity + Done pill. */}
                  <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-800 break-words">{line.product_name}</p>
                      {line.product_sku && <p className="text-[11px] text-slate-500 mt-0.5">{line.product_sku}</p>}
                    </div>
                    {lineLocked && (
                      <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700 border border-emerald-200" title="Fully finished — line locked">
                        <Lock size={9} /> Done
                      </span>
                    )}
                  </div>

                  {/* Order / Available Stock / Finished / Remaining
                      quad, stacked. Available Stock is the SO line's
                      FINISHED product's live closing stock from the
                      InventoryLedger at the SO's warehouse — same
                      number the matrix shows in each material's
                      Closing Stock column, just applied to the
                      finished good instead of a packing material. */}
                  <div className="px-3 py-2 grid grid-cols-2 gap-2 text-xs border-b border-slate-100">
                    <div>
                      <span className="text-slate-400 uppercase tracking-wide text-[10px]">Sales Order Qty</span>
                      <p className="mt-0.5 text-slate-800 font-medium tabular-nums">
                        {fmtQty(line.quantity_ordered)}
                        <span className="text-[10px] text-slate-400 ml-1">{line.uom}</span>
                      </p>
                    </div>
                    <div>
                      <span className="text-slate-400 uppercase tracking-wide text-[10px]">Inventory Stock</span>
                      <div className="mt-0.5">
                        <AvailableDisplay value={line.product_closing_stock} />
                      </div>
                    </div>
                    <div>
                      <span className="text-slate-400 uppercase tracking-wide text-[10px]">Physical Stock</span>
                      <div className="mt-0.5">
                        <AvailableCell
                          value={line.finished_goods_qty}
                          onChange={(v) => setFinished(lineIdx, v)}
                          readOnly={rowReadOnly}
                          max={line.quantity_ordered}
                          label="Finished"
                          capLabel="Order"
                        />
                      </div>
                    </div>
                    <div>
                      <span className="text-slate-400 uppercase tracking-wide text-[10px]">Remaining</span>
                      <div className={`mt-0.5 px-2 py-1 text-xs text-right tabular-nums rounded border ${
                        remaining <= 0
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-700 font-semibold'
                          : 'bg-slate-50 border-slate-200 text-slate-700'
                      }`}>
                        {fmtQty(remaining)}
                      </div>
                    </div>
                  </div>

                  {/* Per-material sections — one block per column, with
                      NEED/AVAILABLE/REMAINING shown side-by-side and
                      labels above each input. Add/Remove affordances
                      mirror the desktop table's behaviour. */}
                  <div className="px-3 py-2 space-y-2">
                    {matrix.columns.length === 0 && line.bom_missing && (
                      <div className="py-1">
                        <p className="text-[11px] text-amber-600 italic mb-1.5">
                          No BOM template for this product at this warehouse.
                        </p>
                        {canFactoryCreateBom && line.product_id ? (
                          <a
                            href={`/production/bom/new?finished_product=${line.product_id}&warehouse=${matrix.warehouse}`}
                            className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs text-indigo-700 border border-dashed border-indigo-300 rounded hover:bg-indigo-50"
                          >
                            <Plus size={12} /> Create BOM Template
                          </a>
                        ) : !canFactoryCreateBom ? (
                          <p className="text-[11px] text-slate-400 italic">
                            Ask an admin with the "Create BOM" permission to seed it.
                          </p>
                        ) : null}
                      </div>
                    )}
                    {matrix.columns.length === 0 && !line.bom_missing && (
                      <p className="text-[11px] text-slate-400 italic py-1">
                        No materials defined yet.
                      </p>
                    )}
                    {matrix.columns.map((name) => {
                      const cell = line.materials[name];
                      if (!cell) {
                        if (rowReadOnly) {
                          return (
                            <div key={`m-${name}`} className="text-[11px] text-slate-300 italic">{name}: —</div>
                          );
                        }
                        return (
                          <button
                            key={`m-${name}`}
                            type="button"
                            onClick={() => activateCell(lineIdx, name)}
                            className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs text-indigo-700 border border-dashed border-indigo-300 rounded hover:bg-indigo-50"
                            title={`Add ${name} to this row`}
                          >
                            <Plus size={12} /> Add {name}
                          </button>
                        );
                      }
                      return (
                        <div key={`m-${name}`} className="border border-slate-200 rounded p-2 bg-slate-50/50">
                          <div className="flex items-center justify-between gap-2 mb-1.5">
                            <p className="text-[11px] font-semibold text-slate-700 truncate">{name}</p>
                            {!rowReadOnly
                              && (Number(cell.need) || 0) === 0
                              && (Number(cell.available) || 0) === 0 && (
                              <button
                                type="button"
                                onClick={() => deactivateCell(lineIdx, name)}
                                className="text-[10px] text-slate-400 hover:text-red-600 shrink-0"
                                title={`Remove ${name} from this row`}
                              >
                                remove
                              </button>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-1.5">
                            <div>
                              <span className="text-[9px] text-slate-500 uppercase tracking-wide">Required</span>
                              <div className="mt-0.5">
                                <NumCell
                                  value={cell.need}
                                  onChange={(v) => setCell(lineIdx, name, 'need', v)}
                                  readOnly={rowReadOnly || (isSubmitted && (Number(cell.need) || 0) > 0)}
                                />
                              </div>
                            </div>
                            <div>
                              <span className="text-[9px] text-slate-500 uppercase tracking-wide">Physical Stock</span>
                              <div className="mt-0.5">
                                <AvailableCell
                                  value={cell.available}
                                  onChange={(v) => setCell(lineIdx, name, 'available', v)}
                                  readOnly={rowReadOnly}
                                  max={Number(cell.need) || 0}
                                />
                              </div>
                            </div>
                            <div>
                              <span className="text-[9px] text-slate-500 uppercase tracking-wide">Inventory Stock</span>
                              <div className="mt-0.5">
                                <AvailableDisplay value={cell.closing_stock} />
                              </div>
                            </div>
                            <div>
                              <span className="text-[9px] text-slate-500 uppercase tracking-wide">Remaining</span>
                              <div className="mt-0.5">
                                <ReqCell need={cell.need} available={cell.available} />
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Matrix — desktop / tablet. Hidden on mobile in favour of
              the stacked card layout above. */}
          <div className="hidden sm:block overflow-x-auto border rounded-lg -mx-4 sm:mx-0 px-4 sm:px-0">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {/* Order block — single neutral colour so it reads as
                      "context columns" distinct from the per-material
                      blocks. */}
                  <th className={`${ORDER_HEADER_CLS} px-3 py-2 text-left font-medium sticky left-0 z-10 min-w-[220px]`}>Product</th>
                  <th className={`${ORDER_HEADER_CLS} px-2 py-2 text-right font-medium min-w-[120px]`}>Sales Order Qty</th>
                  <th className={`${ORDER_HEADER_CLS} px-2 py-2 text-right font-medium min-w-[120px]`}>Inventory Stock</th>
                  <th className={`${ORDER_HEADER_CLS} px-2 py-2 text-right font-medium min-w-[120px]`}>Physical Stock</th>
                  <th className={`${ORDER_HEADER_CLS} px-2 py-2 text-right font-medium min-w-[110px]`}>Remaining</th>
                  {/* Each material block cycles through the palette so
                      the NEED/AVAIL/CLOSING/REQ quad's header is
                      visually grouped to its 4 columns. */}
                  {matrix.columns.map((name, colIdx) => {
                    const tone = MATERIAL_HEADER_COLORS[colIdx % MATERIAL_HEADER_COLORS.length];
                    return (
                      <th key={name} colSpan={4} className={`${tone} px-2 py-2 border-l border-white/20 text-center font-medium min-w-[360px]`}>
                        <span className="inline-flex items-center gap-1">
                          {name}
                        </span>
                      </th>
                    );
                  })}
                </tr>
                <tr className="bg-slate-100">
                  <th className="sticky left-0 bg-slate-100 z-10" />
                  <th className="px-2 py-1 text-right text-xs text-slate-500 font-medium">UOM</th>
                  <th />
                  <th />
                  <th />
                  {matrix.columns.map((name) => (
                    <th key={name} colSpan={4} className="px-1 py-1 border-l">
                      <div className="grid grid-cols-4 gap-1 text-xs text-slate-500 font-medium">
                        <span className="text-center">REQUIRED</span>
                        <span className="text-center">PHYSICAL STOCK</span>
                        <span className="text-center">INVENTORY STOCK</span>
                        <span className="text-center">REMAINING</span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.lines.map((line, lineIdx) => {
                  const lineLocked = isLineLocked(line);
                  // Row inputs go read-only either because the viewer
                  // lacks edit permission OR because the line has hit
                  // remaining = 0 (the SO line is "done" — no further
                  // edits allowed; the row is preserved as a record).
                  const rowReadOnly = !canFactoryAcknowledge || lineLocked;
                  // Round to 3dp to avoid float drift surfacing as
                  // "Remaining = 0.001" when the user's adds should
                  // have hit zero exactly. AvailableCell rounds on
                  // commit too; this is the display-side mirror so
                  // pre-existing saved rows look right.
                  const remaining = Math.round(
                    ((Number(line.quantity_ordered) || 0)
                      - (Number(line.finished_goods_qty) || 0)) * 1000
                  ) / 1000;
                  return (
                    <tr
                      key={line.so_line}
                      className={`border-t ${lineLocked ? 'bg-emerald-50/40' : 'hover:bg-slate-50/50'}`}
                    >
                      <td className={`px-3 py-2 sticky left-0 z-10 border-r ${lineLocked ? 'bg-emerald-50' : 'bg-white'}`}>
                        <div className="flex items-center gap-1.5">
                          <div className="min-w-0">
                            <div className="font-medium text-slate-800">{line.product_name}</div>
                            {line.product_sku && <div className="text-xs text-slate-400">{line.product_sku}</div>}
                            {/* BOM gap notice — only on rows whose
                                product has no BOM at this warehouse.
                                The button is gated by can_create_bom on
                                the Sales Order module; users without it
                                see the notice only. */}
                            {line.bom_missing && (
                              <div className="mt-1">
                                <div className="text-[10px] text-amber-600 italic">
                                  No BOM at this warehouse
                                </div>
                                {canFactoryCreateBom && line.product_id && (
                                  <a
                                    href={`/production/bom/new?finished_product=${line.product_id}&warehouse=${matrix.warehouse}`}
                                    className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 text-[11px] text-indigo-700 border border-dashed border-indigo-300 rounded hover:bg-indigo-50"
                                  >
                                    <Plus size={10} /> Create BOM
                                  </a>
                                )}
                              </div>
                            )}
                          </div>
                          {lineLocked && (
                            <span
                              className="ml-auto inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700 border border-emerald-200"
                              title="Fully finished — line locked"
                            >
                              <Lock size={9} /> Done
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-slate-700">
                        {fmtQty(line.quantity_ordered)}<span className="text-xs text-slate-400 ml-1">{line.uom}</span>
                      </td>
                      <td className="px-2 py-2">
                        {/* Available Stock = the SO line's finished
                            product's live closing stock from the
                            InventoryLedger at this SO's warehouse.
                            Read-only — the factory cannot type into
                            it. Same data source as each material's
                            Closing Stock column, just applied to the
                            finished good. */}
                        <AvailableDisplay value={line.product_closing_stock} />
                      </td>
                      <td className="px-2 py-2">
                        {/* Finished column uses the same incremental
                            cell as Available so the factory can pour
                            in a fresh batch ("just made 200 more")
                            without having to retype the running
                            total. Capped at the SO's ordered qty so
                            a row can never finish more than was
                            ordered (a useful guard for the user's
                            own data-entry mistakes — over-production
                            is a real-world thing but doesn't belong
                            on this row). */}
                        <AvailableCell
                          value={line.finished_goods_qty}
                          onChange={(v) => setFinished(lineIdx, v)}
                          readOnly={rowReadOnly}
                          max={line.quantity_ordered}
                          label="Finished"
                          capLabel="Order"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <div className={`px-2 py-1 text-sm text-right tabular-nums rounded border ${
                          remaining <= 0
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-700 font-semibold'
                            : 'bg-slate-50 border-slate-200 text-slate-700'
                        }`}>
                          {fmtQty(remaining)}
                        </div>
                      </td>
                      {matrix.columns.map((name) => {
                        const cell = line.materials[name];
                        // Row hasn't opted into this material — render
                        // an [+ Add] affordance instead of the full
                        // NEED/AVAIL/CLOSING/REQ quad. That keeps
                        // the matrix visually quiet for rows that
                        // don't consume the material, and stops the
                        // user having to skip past dummy 0/0 cells.
                        if (!cell) {
                          if (rowReadOnly) {
                            return (
                              <td key={name} colSpan={4} className="px-1 py-2 border-l text-center text-slate-300 text-xs">
                                —
                              </td>
                            );
                          }
                          return (
                            <td key={name} colSpan={4} className="px-1 py-2 border-l">
                              <button
                                type="button"
                                onClick={() => activateCell(lineIdx, name)}
                                title={`Add ${name} to this row`}
                                className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 text-xs text-indigo-700 border border-dashed border-indigo-300 rounded hover:bg-indigo-50"
                              >
                                <Plus size={12} /> Add
                              </button>
                            </td>
                          );
                        }
                        return (
                          <td key={name} colSpan={4} className="px-1 py-2 border-l">
                            <div className="grid grid-cols-4 gap-1">
                              {/* NEED is locked once the matrix has
                                  been Submitted AND a value has been
                                  entered. Editing Need after submit
                                  would silently rewrite the recorded
                                  requirement. */}
                              <NumCell
                                value={cell.need}
                                onChange={(v) => setCell(lineIdx, name, 'need', v)}
                                readOnly={rowReadOnly || (isSubmitted && (Number(cell.need) || 0) > 0)}
                              />
                              {/* AVAILABLE — typed by the factory: how
                                  much of this material they have ready
                                  to consume against the NEED. Capped at
                                  NEED so demand-met cells can't grow
                                  unbounded. */}
                              <AvailableCell
                                value={cell.available}
                                onChange={(v) => setCell(lineIdx, name, 'available', v)}
                                readOnly={rowReadOnly}
                                max={Number(cell.need) || 0}
                              />
                              {/* CLOSING STOCK — read-only, from the
                                  InventoryLedger at the SO's warehouse.
                                  Independent of the typed AVAILABLE so
                                  the factory can see system stock vs.
                                  what they're actually committing. */}
                              <AvailableDisplay value={cell.closing_stock} />
                              <ReqCell need={cell.need} available={cell.available} />
                            </div>
                            {/* Tiny "remove this cell from this row"
                                affordance — for cases where the user
                                added the cell by mistake. Only visible
                                while the row is editable AND no values
                                have been entered yet, so we never
                                silently delete typed data. */}
                            {!rowReadOnly
                              && (Number(cell.need) || 0) === 0
                              && (Number(cell.available) || 0) === 0
                              && (
                              <div className="mt-1 text-right">
                                <button
                                  type="button"
                                  onClick={() => deactivateCell(lineIdx, name)}
                                  title={`Remove ${name} from this row`}
                                  className="text-[10px] text-slate-400 hover:text-red-600"
                                >
                                  remove
                                </button>
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Shortfall summary */}
          {shortfalls.length > 0 && (
            <div className="mt-4 p-3 sm:p-4 rounded-lg border border-red-200 bg-red-50">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle size={16} className="text-red-700" />
                <h3 className="text-sm font-semibold text-red-800">{shortfalls.length} material shortfall{shortfalls.length > 1 ? 's' : ''}</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs sm:text-sm">
                  <thead className="border-b border-red-200">
                    <tr className="text-left text-red-700">
                      <th className="px-2 sm:px-3 py-1 font-medium whitespace-nowrap">Line</th>
                      <th className="px-2 sm:px-3 py-1 font-medium whitespace-nowrap">Product</th>
                      <th className="px-2 sm:px-3 py-1 font-medium whitespace-nowrap">Material</th>
                      <th className="px-2 sm:px-3 py-1 font-medium text-right whitespace-nowrap">Required</th>
                      <th className="px-2 sm:px-3 py-1 font-medium text-right whitespace-nowrap">Inventory Stock</th>
                      <th className="px-2 sm:px-3 py-1 font-medium text-right whitespace-nowrap">Short by</th>
                    </tr>
                  </thead>
                  <tbody className="text-red-900">
                    {shortfalls.map((s, i) => (
                      <tr key={i} className="border-b border-red-100 last:border-b-0">
                        <td className="px-2 sm:px-3 py-1 tabular-nums">{s.line_no}</td>
                        <td className="px-2 sm:px-3 py-1">{s.product_name}</td>
                        <td className="px-2 sm:px-3 py-1 font-medium">{s.material_name}</td>
                        <td className="px-2 sm:px-3 py-1 text-right tabular-nums whitespace-nowrap">{fmtQty(s.need)}</td>
                        <td className="px-2 sm:px-3 py-1 text-right tabular-nums whitespace-nowrap">{fmtQty(s.available)}</td>
                        <td className="px-2 sm:px-3 py-1 text-right tabular-nums font-semibold whitespace-nowrap">{fmtQty(s.shortfall)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Factory remarks — read-only for users without confirm
              permission (e.g. sales) so they can review what the
              factory wrote without being able to edit it. */}
          <div className="mt-4">
            <label className="block text-xs text-slate-500 font-medium uppercase tracking-wide mb-1">Factory remarks</label>
            {canFactoryAcknowledge ? (
              <textarea
                rows={2}
                value={header.factory_remarks}
                onChange={(e) => { setHeader(prev => ({ ...prev, factory_remarks: e.target.value })); setDirty(true); }}
                placeholder="Notes for sales — e.g. 'Will need 200 extra 25KG drums by Tue; the 5KG bucket line is good.'"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500"
              />
            ) : (
              <div className="w-full border border-slate-200 bg-slate-50 rounded-lg px-3 py-2 text-sm text-slate-700 min-h-[3.5rem] whitespace-pre-wrap">
                {header.factory_remarks || <span className="text-slate-400">No remarks yet.</span>}
              </div>
            )}
          </div>
        </>
      )}

    </div>
  );
}
