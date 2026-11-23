import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useMemo } from 'react';
import { X, Check, Plus, AlertTriangle } from 'lucide-react';

/**
 * Modal shown after Gemini extraction when one or more extracted line items
 * don't match the selected RFQ's products. Clean, minimal layout.
 *
 * Per-row choices:
 *   - 'rfq'     — replace with one of the RFQ's products
 *   - 'create'  — create a new product master record (inline form)
 */
const UOM_OPTIONS = ['PCS', 'KG', 'LTR', 'MTR', 'SQM', 'CUM', 'BOX', 'PACK', 'MTS'];

// Vendor docs spell UOMs lots of different ways ("MT", "Nos", "kgs",
// "Litre"…) but the Product master only accepts the canonical codes
// above. Map common aliases to the canonical form so "Create new"
// doesn't fail with `uom: "MT" is not a valid choice`.
const UOM_ALIASES = {
  // Metric Ton
  'MT': 'MTS', 'MTON': 'MTS', 'TON': 'MTS', 'TONS': 'MTS',
  'TONNE': 'MTS', 'TONNES': 'MTS', 'METRIC TON': 'MTS', 'METRIC TONS': 'MTS',
  // Pieces / numbers
  'NO': 'PCS', 'NOS': 'PCS', 'NUMBER': 'PCS', 'NUMBERS': 'PCS',
  'PC': 'PCS', 'PIECE': 'PCS', 'PIECES': 'PCS', 'UNIT': 'PCS', 'UNITS': 'PCS',
  // Kilogram
  'KGS': 'KG', 'KILO': 'KG', 'KILOS': 'KG', 'KILOGRAM': 'KG', 'KILOGRAMS': 'KG',
  // Litres
  'L': 'LTR', 'LT': 'LTR', 'LIT': 'LTR', 'LITER': 'LTR', 'LITERS': 'LTR',
  'LITRE': 'LTR', 'LITRES': 'LTR',
  // Meters
  'M': 'MTR', 'MTRS': 'MTR', 'METER': 'MTR', 'METERS': 'MTR', 'METRE': 'MTR', 'METRES': 'MTR',
};

function normaliseUom(value) {
  const raw = (value || '').toString().trim().toUpperCase();
  if (!raw) return '';
  if (UOM_OPTIONS.includes(raw)) return raw;
  if (UOM_ALIASES[raw]) return UOM_ALIASES[raw];
  return raw;  // unknown — surface for the user; dropdown will fall back to first option
}
const GOODS_SUB_TYPES = [
  ['RAW_MATERIAL', 'Raw Material'],
  ['PACKING_MATERIAL', 'Packing Material'],
  ['FINISHED_GOOD', 'Finished Good'],
  ['SEMI_FINISHED', 'Semi Finished'],
  ['TRADED_PRODUCTS', 'Traded Products'],
  ['CAPITAL_GOOD', 'Capital Good'],
  ['MACHINE_SPARES', 'Machine Spares'],
  ['CONSUMABLES', 'Consumables'],
];

function makeNewProductFromExtract(m) {
  const fallbackSku = `NEW-${Date.now().toString().slice(-6)}-${m.idx}`;
  // Normalise extracted UOM via the alias map. If it's still not a valid
  // option after normalisation, drop back to KG so the dropdown shows a
  // sensible default and the backend doesn't 400. Users can change it.
  const rawUom = normaliseUom(m.extracted_uom);
  const uom = UOM_OPTIONS.includes(rawUom) ? rawUom : 'KG';
  return {
    product_name: m.extracted_name && m.extracted_name !== '(no name extracted)' ? m.extracted_name : '',
    sku_code: m.extracted_code || fallbackSku,
    product_type: 'GOODS',
    goods_sub_type: 'RAW_MATERIAL',
    uom,
  };
}

function defaultChoiceFor(m) {
  if (m.suggested_product && (m.suggested_score || 0) >= 0.60) return 'rfq';
  return 'create';
}

export default function ProductMismatchModal({
  open,
  mismatches,
  vendorId,
  vendorName,
  rfqProducts: liveRfqProducts,
  onResolve,
  onClose,
}) {
  const [choices, setChoices] = useState({});

  // Prefer the live `rfqProducts` prop (current parent state) over whatever
  // was captured into `m.all_rfq_products` at queue-creation time. This way,
  // if the RFQ products endpoint finished AFTER the modal opened (race we
  // saw on deploy), the latest list is shown on the next render.
  const resolvedRfqProducts = useMemo(() => {
    if (Array.isArray(liveRfqProducts) && liveRfqProducts.length > 0) return liveRfqProducts;
    return (mismatches[0]?.all_rfq_products) || [];
  }, [liveRfqProducts, mismatches]);

  useEffect(() => {
    if (!open) return;
    const init = {};
    mismatches.forEach((m) => {
      const c = defaultChoiceFor(m);
      init[m.idx] = {
        choice: c,
        productId: c === 'rfq' && m.suggested_product ? m.suggested_product.product : '',
        newProduct: makeNewProductFromExtract(m),
        remember: false,
      };
    });
    setChoices(init);
  }, [open, mismatches]);

  const setRow = (idx, patch) => setChoices((c) => ({ ...c, [idx]: { ...c[idx], ...patch } }));
  const setNewProductField = (idx, field, value) => setChoices((c) => ({
    ...c, [idx]: { ...c[idx], newProduct: { ...c[idx].newProduct, [field]: value } },
  }));

  const canApply = useMemo(() => {
    return mismatches.every((m) => {
      const c = choices[m.idx];
      if (!c) return false;
      if (c.choice === 'rfq' && !c.productId) return false;
      if (c.choice === 'create') {
        const np = c.newProduct || {};
        if (!np.product_name || !np.sku_code || !np.uom || !np.product_type) return false;
      }
      return true;
    });
  }, [choices, mismatches]);

  if (!open) return null;

  const handleApply = () => {
    const resolutions = mismatches.map((m) => {
      const c = choices[m.idx];
      return {
        idx: m.idx,
        choice: c.choice,
        productId: c.choice === 'rfq' ? c.productId : null,
        newProduct: c.choice === 'create' ? c.newProduct : null,
        remember: !!c.remember && c.choice === 'rfq',
        extracted_name: m.extracted_name,
      };
    });
    onResolve(resolutions);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[88dvh] flex flex-col" role="dialog" aria-modal="true" aria-label="Match products">

        {/* Header. Sub-text switches when every row is just an "off-RFQ"
            confirmation (product found in master but not on the RFQ) — the
            line is already auto-filled, the user just needs to confirm or
            swap to an RFQ product. */}
        {(() => {
          const allOffRfq = mismatches.length > 0 && mismatches.every(m => m.off_rfq);
          const anyOffRfq = mismatches.some(m => m.off_rfq);
          return (
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-slate-100">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  {allOffRfq
                    ? `Confirm ${mismatches.length} off-RFQ product${mismatches.length > 1 ? 's' : ''}`
                    : `Match ${mismatches.length} product${mismatches.length > 1 ? 's' : ''}`}
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {allOffRfq
                    ? `These products exist in your master but are not on this RFQ. Keep them or swap to an RFQ product.`
                    : (anyOffRfq
                      ? `Some products are off-RFQ. Keep the master match or swap to an RFQ product for each row.`
                      : `The vendor's product names don't match this RFQ exactly. Choose what to do for each.`)}
                </p>
              </div>
              <button onClick={onClose} aria-label="Close" title="Close" className="p-1 rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                <X size={18} />
              </button>
            </div>
          );
        })()}

        {/* Body */}
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 space-y-5">
          {resolvedRfqProducts.length === 0 && (
            <div className="px-3 py-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-start gap-2">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              <span>No RFQ products to compare against. Select an RFQ first, or create / keep these as vendor lines.</span>
            </div>
          )}

          {mismatches.map((m, i) => {
            const c = choices[m.idx] || { choice: 'create', productId: '', newProduct: makeNewProductFromExtract(m), remember: false };
            const score = m.suggested_score != null ? Math.round(m.suggested_score * 100) : null;
            // Live fallback — if the row's captured `suggested_product` is
            // empty but the parent now has RFQ products, surface the first
            // one as a "closest" candidate so the user has something to
            // anchor against. (Handles the race where products loaded after
            // the modal opened.)
            const suggested = m.suggested_product || (resolvedRfqProducts[0] ? {
              product: resolvedRfqProducts[0].product,
              product_name: resolvedRfqProducts[0].product_name,
              sku_code: resolvedRfqProducts[0].sku_code,
            } : null);
            return (
              <div key={m.idx} className="border-b border-slate-100 last:border-b-0 pb-5 last:pb-0">

                {/* Row number + comparison */}
                <div className="flex items-start gap-3">
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-slate-100 text-slate-600 text-xs font-medium flex-shrink-0 mt-0.5">
                    {i + 1}
                  </span>
                  <div className="flex-1 grid grid-cols-2 md:grid-cols-2 gap-4">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-slate-400 font-medium">Vendor doc</p>
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
                      {/* Column heading + similarity caption swap based on
                          whether the row is an "off-RFQ" master match. In
                          that case the suggested product is from the global
                          Product master (NOT on this RFQ), so saying
                          "100% similar to an RFQ product" is misleading. */}
                      <p className="text-[10px] uppercase tracking-wide text-slate-400 font-medium">
                        {m.off_rfq ? 'Product master (off RFQ)' : 'RFQ closest'}
                      </p>
                      {suggested ? (
                        <>
                          <p className="text-sm font-medium text-slate-900 mt-0.5 break-words">{suggested.product_name}</p>
                          {suggested.sku_code && (
                            <p className="text-xs text-slate-500 mt-0.5">SKU <span className="font-mono">{suggested.sku_code}</span></p>
                          )}
                          {m.off_rfq ? (
                            <p className="text-xs mt-0.5 text-blue-600 italic">
                              Exact master match — not on this RFQ. Keep it, or pick an RFQ product below.
                            </p>
                          ) : (
                            <>
                              {score != null && m.suggested_product && (
                                <p className={`text-xs mt-0.5 ${
                                  score >= 75 ? 'text-emerald-600'
                                    : score >= 60 ? 'text-amber-600'
                                    : score >= 30 ? 'text-red-500'
                                    : 'text-slate-400 italic'
                                }`}>
                                  {score >= 30 ? `${score}% similar` : 'Very different — pick from dropdown below'}
                                </p>
                              )}
                              {!m.suggested_product && (
                                <p className="text-xs mt-0.5 text-slate-400 italic">No close match — pick from dropdown below.</p>
                              )}
                            </>
                          )}
                        </>
                      ) : (
                        <p className="text-sm text-slate-400 italic mt-0.5">No RFQ products to compare.</p>
                      )}
                      {resolvedRfqProducts.length > 1 && (
                        <details className="mt-1 text-xs">
                          <summary className="cursor-pointer text-slate-500 hover:text-slate-700">
                            All RFQ products ({resolvedRfqProducts.length})
                          </summary>
                          <ul className="mt-1 pl-2 space-y-0.5 text-slate-600 max-h-32 overflow-auto">
                            {resolvedRfqProducts.map((p) => (
                              <li key={p.product} className="truncate">• {p.product_name}{p.sku_code ? ` (${p.sku_code})` : ''}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  </div>
                </div>

                {/* Action picker — simple radio row */}
                <div className="mt-3 ml-9 flex flex-wrap gap-1.5">
                  <RadioPill
                    active={c.choice === 'rfq'}
                    onClick={() => setRow(m.idx, { choice: 'rfq', productId: c.productId || m.suggested_product?.product || '' })}
                  >
                    Use RFQ product
                  </RadioPill>
                  <RadioPill
                    active={c.choice === 'create'}
                    onClick={() => setRow(m.idx, { choice: 'create' })}
                  >
                    + Create new
                  </RadioPill>
                </div>

                {/* Conditional sub-form */}
                <div className="mt-3 ml-9">
                  {c.choice === 'rfq' && (
                    <div className="space-y-2">
                      <CustomSelect
                        value={c.productId}
                        onChange={(e) => setRow(m.idx, { productId: e.target.value })}
                        className="w-full px-2.5 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                      >
                        <option value="">Select RFQ product…</option>
                        {resolvedRfqProducts.map((p) => (
                          <option key={p.product} value={p.product}>
                            {p.product_name}{p.sku_code ? ` · ${p.sku_code}` : ''}
                          </option>
                        ))}
                      </CustomSelect>
                    </div>
                  )}

                  {c.choice === 'create' && (
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <input
                        type="text"
                        placeholder="Product name *"
                        value={c.newProduct?.product_name || ''}
                        onChange={(e) => setNewProductField(m.idx, 'product_name', e.target.value)}
                        className="px-2.5 py-1.5 border border-slate-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                      <input
                        type="text"
                        placeholder="SKU *"
                        value={c.newProduct?.sku_code || ''}
                        onChange={(e) => setNewProductField(m.idx, 'sku_code', e.target.value)}
                        className="px-2.5 py-1.5 border border-slate-300 rounded font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                      <CustomSelect
                        value={c.newProduct?.product_type || 'GOODS'}
                        onChange={(e) => setNewProductField(m.idx, 'product_type', e.target.value)}
                        className="px-2.5 py-1.5 border border-slate-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      >
                        <option value="GOODS">Goods</option>
                        <option value="SERVICES">Services</option>
                        <option value="MACHINERY">Machinery</option>
                      </CustomSelect>
                      <CustomSelect
                        value={c.newProduct?.uom || 'KG'}
                        onChange={(e) => setNewProductField(m.idx, 'uom', e.target.value)}
                        className="px-2.5 py-1.5 border border-slate-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      >
                        {UOM_OPTIONS.map((u) => <option key={u} value={u}>{u}</option>)}
                      </CustomSelect>
                      {c.newProduct?.product_type === 'GOODS' && (
                        <CustomSelect
                          value={c.newProduct?.goods_sub_type || 'RAW_MATERIAL'}
                          onChange={(e) => setNewProductField(m.idx, 'goods_sub_type', e.target.value)}
                          className="col-span-2 px-2.5 py-1.5 border border-slate-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        >
                          {GOODS_SUB_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </CustomSelect>
                      )}
                    </div>
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
      className={`px-3 py-1 rounded-full text-xs font-medium border transition ${
        active
          ? 'bg-slate-900 text-white border-slate-900'
          : 'bg-white text-slate-600 border-slate-300 hover:border-slate-400 hover:text-slate-800'
      }`}
    >
      {children}
    </button>
  );
}
