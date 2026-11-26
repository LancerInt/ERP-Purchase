import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useMemo } from 'react';
import { X, Check, Trash2, Plus, AlertTriangle } from 'lucide-react';

/**
 * Modal shown after Gemini receipt extraction when one or more extracted
 * line items don't exactly match a known product.
 *
 * Two modes:
 *   - mode='po'      → compare against the selected PO's products
 *                      Pills: 'po' (pick PO product) | 'remove'
 *   - mode='direct'  → compare against the full Product master
 *                      Pills: 'master' (pick master product) | 'create' | 'remove'
 *
 * Smart default per row:
 *   - candidate present → choose 'po' / 'master' with closest pre-selected
 *   - no candidate      → choose 'remove' (or 'create' in direct mode if
 *                         the vendor at least gave us a name to seed with)
 */

const UOM_OPTIONS = ['PCS', 'KG', 'LTR', 'MTR', 'SQM', 'CUM', 'BOX', 'PACK', 'MTS'];

// Vendor docs spell UOMs lots of different ways. Map common aliases to
// the canonical Product master codes so "Create new" doesn't fail with
// `uom: "MT" is not a valid choice`.
const UOM_ALIASES = {
  'MT': 'MTS', 'MTON': 'MTS', 'TON': 'MTS', 'TONS': 'MTS',
  'TONNE': 'MTS', 'TONNES': 'MTS', 'METRIC TON': 'MTS', 'METRIC TONS': 'MTS',
  'NO': 'PCS', 'NOS': 'PCS', 'NUMBER': 'PCS', 'NUMBERS': 'PCS',
  'PC': 'PCS', 'PIECE': 'PCS', 'PIECES': 'PCS', 'UNIT': 'PCS', 'UNITS': 'PCS',
  'KGS': 'KG', 'KILO': 'KG', 'KILOS': 'KG', 'KILOGRAM': 'KG', 'KILOGRAMS': 'KG',
  'L': 'LTR', 'LT': 'LTR', 'LIT': 'LTR', 'LITER': 'LTR', 'LITERS': 'LTR',
  'LITRE': 'LTR', 'LITRES': 'LTR',
  'M': 'MTR', 'MTRS': 'MTR', 'METER': 'MTR', 'METERS': 'MTR', 'METRE': 'MTR', 'METRES': 'MTR',
};

function normaliseUom(value) {
  const raw = (value || '').toString().trim().toUpperCase();
  if (!raw) return '';
  if (UOM_OPTIONS.includes(raw)) return raw;
  if (UOM_ALIASES[raw]) return UOM_ALIASES[raw];
  return raw;
}
const GOODS_SUB_TYPES = [
  ['RAW_MATERIAL', 'Raw Material'],
  ['PACKING_MATERIAL', 'Packing Material'],
  ['FRUIT', 'Fruit'],
  ['MAIZE', 'Maize'],
  ['FINISHED_GOOD', 'Finished Good'],
  ['SEMI_FINISHED', 'Semi Finished'],
  ['TRADED_PRODUCTS', 'Traded Products'],
  ['CAPITAL_GOOD', 'Capital Good'],
  ['MACHINE_SPARES', 'Machine Spares'],
  ['CONSUMABLES', 'Consumables'],
];

function makeNewProductFromExtract(m) {
  const fallbackSku = `NEW-${Date.now().toString().slice(-6)}-${m.idx}`;
  // Normalise extracted UOM via the alias map. If still not a valid
  // option after normalisation, drop back to KG so the dropdown shows
  // a sensible default and the backend doesn't 400.
  const rawUom = normaliseUom(m.extracted_uom);
  const uom = UOM_OPTIONS.includes(rawUom) ? rawUom : 'KG';
  return {
    product_name: m.extracted_name && m.extracted_name !== '(name not extracted)' ? m.extracted_name : '',
    sku_code: m.extracted_code || fallbackSku,
    product_type: 'GOODS',
    goods_sub_type: 'RAW_MATERIAL',
    uom,
  };
}

export default function ReceiptMismatchModal({
  open,
  mismatches,
  poProducts,
  masterProducts,
  mode = 'po',
  onResolve,
  onClose,
}) {
  const isDirect = mode === 'direct';
  const [choices, setChoices] = useState({});

  // In direct mode the user picks from the Product master. The
  // `masterProducts` prop is the raw array; we normalise to the same
  // shape as PO products ({id, name, sku, uom}) so the dropdown render
  // stays uniform.
  const resolvedMasterProducts = useMemo(() => {
    if (!isDirect) return [];
    if (!Array.isArray(masterProducts)) return [];
    return masterProducts.map((p) => ({
      id: p.id,
      name: p.product_name || '',
      sku: p.sku_code || '',
      uom: p.uom || '',
    }));
  }, [isDirect, masterProducts]);

  const resolvedPoProducts = useMemo(() => {
    if (isDirect) return [];
    if (Array.isArray(poProducts) && poProducts.length > 0) return poProducts;
    return mismatches[0]?.all_po_products || [];
  }, [isDirect, poProducts, mismatches]);

  // Source of truth for the "pick" dropdown — PO or master depending on mode.
  const pickSource = isDirect ? resolvedMasterProducts : resolvedPoProducts;
  const pickChoice = isDirect ? 'master' : 'po';

  useEffect(() => {
    if (!open) return;
    const init = {};
    mismatches.forEach((m) => {
      const hasCandidate = !!m.suggested || pickSource.length > 0;
      const preselectId = m.suggested?.id || pickSource[0]?.id || '';
      // Default choice — pick if we have a candidate, else 'remove'.
      // (The 'create' option was removed from the UI; new products are
      // added via the Product master page now.)
      const defaultChoice = hasCandidate ? pickChoice : 'remove';
      init[m.idx] = {
        choice: defaultChoice,
        productId: hasCandidate ? preselectId : '',
        newProduct: makeNewProductFromExtract(m),
      };
    });
    setChoices(init);
    // pickSource is derived from props; intentionally exclude it from
    // deps to avoid re-initialising state on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mismatches, poProducts, masterProducts]);

  const setRow = (idx, patch) => setChoices((c) => ({ ...c, [idx]: { ...c[idx], ...patch } }));
  const setNewProductField = (idx, field, value) => setChoices((c) => ({
    ...c,
    [idx]: { ...c[idx], newProduct: { ...c[idx].newProduct, [field]: value } },
  }));

  const canApply = useMemo(() => {
    return mismatches.every((m) => {
      const c = choices[m.idx];
      if (!c) return false;
      if (c.choice === pickChoice && !c.productId) return false;
      if (c.choice === 'create') {
        const np = c.newProduct || {};
        if (!np.product_name || !np.sku_code || !np.uom || !np.product_type) return false;
      }
      return true;
    });
  }, [choices, mismatches, pickChoice]);

  if (!open) return null;

  const handleApply = () => {
    const resolutions = mismatches.map((m) => {
      const c = choices[m.idx];
      const selected = c.choice === pickChoice
        ? pickSource.find((p) => String(p.id) === String(c.productId))
        : null;
      return {
        idx: m.idx,
        choice: c.choice, // 'po' | 'master' | 'create' | 'remove'
        productId: c.choice === pickChoice ? (c.productId || null) : null,
        product: selected || null,
        newProduct: c.choice === 'create' ? c.newProduct : null,
        extracted_name: m.extracted_name,
      };
    });
    onResolve(resolutions);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[88dvh] flex flex-col" role="dialog" aria-modal="true" aria-label="Match products">

        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-slate-100">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Match {mismatches.length} product{mismatches.length > 1 ? 's' : ''}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {isDirect
                ? `The vendor invoice has products that aren't an exact match in your Product master. Pick the matching master product, create a new one, or remove the line.`
                : `The vendor invoice has products that don't match this PO exactly. Pick what to do for each.`}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" title="Close" className="p-1 rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 space-y-5">
          {pickSource.length === 0 && (
            <div className="px-3 py-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-start gap-2">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              <span>
                {isDirect
                  ? 'No products in master yet. Add one via the Product master page, or remove these lines.'
                  : 'No PO products to compare against. Select a PO at the top of the form, or remove these lines.'}
              </span>
            </div>
          )}

          {mismatches.map((m, i) => {
            const c = choices[m.idx] || {
              choice: 'remove',
              productId: '',
              newProduct: makeNewProductFromExtract(m),
            };
            const score = m.suggested_score != null ? Math.round(m.suggested_score * 100) : null;
            const suggested = m.suggested || (pickSource[0] ? {
              id: pickSource[0].id,
              name: pickSource[0].name,
              sku: pickSource[0].sku,
              uom: pickSource[0].uom,
            } : null);
            return (
              <div key={m.idx} className="border-b border-slate-100 last:border-b-0 pb-5 last:pb-0">

                {/* Number + side-by-side comparison */}
                <div className="flex items-start gap-3">
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-slate-100 text-slate-600 text-xs font-medium flex-shrink-0 mt-0.5">
                    {i + 1}
                  </span>
                  <div className="flex-1 grid grid-cols-2 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-slate-400 font-medium">Vendor invoice</p>
                      <p className="text-sm font-medium text-slate-900 mt-0.5 break-words">{m.extracted_name || '(name not extracted)'}</p>
                      {m.extracted_code && (
                        <p className="text-xs text-slate-500 mt-0.5">SKU <span className="font-mono">{m.extracted_code}</span></p>
                      )}
                      {(m.extracted_qty || m.extracted_rate) && (
                        <p className="text-xs text-slate-500 mt-0.5">
                          {m.extracted_qty && <>Qty {m.extracted_qty}{m.extracted_uom ? ` ${m.extracted_uom}` : ''}</>}
                          {m.extracted_qty && m.extracted_rate && ' · '}
                          {m.extracted_rate && <>₹{m.extracted_rate}</>}
                        </p>
                      )}
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-slate-400 font-medium">
                        {isDirect ? 'Product master closest' : 'PO closest'}
                      </p>
                      {suggested ? (
                        <>
                          <p className="text-sm font-medium text-slate-900 mt-0.5 break-words">{suggested.name}</p>
                          {suggested.sku && (
                            <p className="text-xs text-slate-500 mt-0.5">SKU <span className="font-mono">{suggested.sku}</span></p>
                          )}
                          {score != null && m.suggested && (
                            <p className={`text-xs mt-0.5 ${
                              score >= 75 ? 'text-emerald-600'
                                : score >= 50 ? 'text-amber-600'
                                : score >= 25 ? 'text-red-500'
                                : 'text-slate-400 italic'
                            }`}>
                              {score >= 25 ? `${score}% similar` : 'Very different — pick from dropdown below'}
                            </p>
                          )}
                          {!m.suggested && (
                            <p className="text-xs mt-0.5 text-slate-400 italic">No close match — pick from dropdown below.</p>
                          )}
                        </>
                      ) : (
                        <p className="text-sm text-slate-400 italic mt-0.5">
                          {isDirect ? 'No master products to compare.' : 'No PO products to compare.'}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Action pills — only Pick + Remove. "Create new" was
                    removed per user request; new products should be
                    added via the Product master page first, not
                    inline from this modal. */}
                <div className="mt-3 ml-9 flex flex-wrap gap-1.5">
                  <RadioPill
                    active={c.choice === pickChoice}
                    onClick={() => setRow(m.idx, { choice: pickChoice, productId: c.productId || m.suggested?.id || '' })}
                  >
                    {isDirect ? 'Use master product' : 'Use PO product'}
                  </RadioPill>
                  <RadioPill
                    active={c.choice === 'remove'}
                    onClick={() => setRow(m.idx, { choice: 'remove', productId: '' })}
                  >
                    <Trash2 size={11} /> Remove line
                  </RadioPill>
                </div>

                {/* Sub-form */}
                <div className="mt-3 ml-9">
                  {c.choice === pickChoice && (
                    <>
                      <CustomSelect
                        value={c.productId}
                        onChange={(e) => setRow(m.idx, { productId: e.target.value })}
                        className="w-full px-2.5 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                      >
                        <option value="">{isDirect ? 'Select master product…' : 'Select PO product…'}</option>
                        {pickSource.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}{p.sku ? ` · ${p.sku}` : ''}{p.quantity_ordered ? ` — ${p.quantity_ordered} ${p.uom || ''} ordered` : ''}
                          </option>
                        ))}
                      </CustomSelect>
                      {pickSource.length > 1 && (
                        <details className="mt-1 text-xs">
                          <summary className="cursor-pointer text-slate-500 hover:text-slate-700">
                            {isDirect ? `All master products (${pickSource.length})` : `All PO products (${pickSource.length})`}
                          </summary>
                          <ul className="mt-1 pl-2 space-y-0.5 text-slate-600 max-h-32 overflow-auto">
                            {pickSource.map((p) => (
                              <li key={p.id} className="truncate">
                                • {p.name}{p.sku ? ` (${p.sku})` : ''}
                                {p.quantity_ordered ? <span className="text-slate-400"> — {p.quantity_ordered} {p.uom || ''}</span> : null}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </>
                  )}
                  {c.choice === 'create' && (
                    <div className="grid grid-cols-2 md:grid-cols-2 gap-2 px-3 py-2 border border-slate-200 rounded bg-slate-50/50">
                      <div>
                        <label className="text-[10px] uppercase tracking-wide text-slate-500 font-medium">Product Name *</label>
                        <input
                          type="text"
                          value={c.newProduct?.product_name || ''}
                          onChange={(e) => setNewProductField(m.idx, 'product_name', e.target.value)}
                          className="w-full mt-0.5 px-2 py-1 border border-slate-300 rounded text-sm"
                          placeholder="e.g. Acetone"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] uppercase tracking-wide text-slate-500 font-medium">SKU Code *</label>
                        <input
                          type="text"
                          value={c.newProduct?.sku_code || ''}
                          onChange={(e) => setNewProductField(m.idx, 'sku_code', e.target.value)}
                          className="w-full mt-0.5 px-2 py-1 border border-slate-300 rounded text-sm font-mono"
                          placeholder="auto-generated if blank"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] uppercase tracking-wide text-slate-500 font-medium">Type *</label>
                        <CustomSelect
                          value={c.newProduct?.product_type || 'GOODS'}
                          onChange={(e) => setNewProductField(m.idx, 'product_type', e.target.value)}
                          className="w-full mt-0.5 px-2 py-1 border border-slate-300 rounded text-sm"
                        >
                          <option value="GOODS">Goods</option>
                          <option value="SERVICES">Services</option>
                          <option value="MACHINERY">Machinery</option>
                        </CustomSelect>
                      </div>
                      <div>
                        <label className="text-[10px] uppercase tracking-wide text-slate-500 font-medium">UOM *</label>
                        <CustomSelect
                          value={c.newProduct?.uom || 'KG'}
                          onChange={(e) => setNewProductField(m.idx, 'uom', e.target.value)}
                          className="w-full mt-0.5 px-2 py-1 border border-slate-300 rounded text-sm"
                        >
                          {UOM_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                        </CustomSelect>
                      </div>
                      {(c.newProduct?.product_type || 'GOODS') === 'GOODS' && (
                        <div className="col-span-2 md:col-span-2">
                          <label className="text-[10px] uppercase tracking-wide text-slate-500 font-medium">Sub Type</label>
                          <CustomSelect
                            value={c.newProduct?.goods_sub_type || 'RAW_MATERIAL'}
                            onChange={(e) => setNewProductField(m.idx, 'goods_sub_type', e.target.value)}
                            className="w-full mt-0.5 px-2 py-1 border border-slate-300 rounded text-sm"
                          >
                            {GOODS_SUB_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                          </CustomSelect>
                        </div>
                      )}
                      <p className="col-span-2 md:col-span-2 text-[11px] text-slate-500 italic">
                        Created in the Product master and used on this receipt line.
                      </p>
                    </div>
                  )}
                  {c.choice === 'remove' && (
                    <p className="text-xs text-slate-500 italic">
                      This extracted line will be dropped from the receipt.
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 sm:px-6 py-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!canApply}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded bg-slate-900 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            <Check size={14} /> Save
          </button>
        </div>
      </div>
    </div>
  );
}

function RadioPill({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium border transition ${
        active
          ? 'bg-slate-900 text-white border-slate-900'
          : 'bg-white text-slate-600 border-slate-300 hover:border-slate-400 hover:text-slate-800'
      }`}
    >
      {children}
    </button>
  );
}
