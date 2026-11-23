// Shared vocabulary for the "All products" filter on Purchase Dashboard,
// Purchase Analytics and Sales Analytics. The control itself is
// components/common/ProductPicker.jsx.
//
// A filter value is either ONE product (a uuid) or a whole CATEGORY
// ("cat:RAW_MATERIAL", expanded server-side by resolve_product_filter in
// purchase/dashboard_views.py and product_scope in sales/dashboard_views.py).
// Categories exist because "what did we spend on packing this year" is a real
// question and no single product answers it.

export const CAT_PREFIX = 'cat:';

// Order is deliberate: what these dashboards are usually asked about first,
// not the model's declaration order.
export const PRODUCT_CATEGORIES = [
  ['RAW_MATERIAL', 'Raw Material'],
  ['PACKING_MATERIAL', 'Packing Material'],
  ['CONSUMABLES', 'Consumables'],
  ['MACHINE_SPARES', 'Machine Spares'],
  ['CAPITAL_GOOD', 'Capital Good'],
  ['SEMI_FINISHED', 'Semi Finished'],
  ['FINISHED_GOOD', 'Finished Good'],
  ['TRADED_PRODUCTS', 'Traded Products'],
];

const LABEL_OF = new Map(PRODUCT_CATEGORIES);
const byName = (a, b) => a.label.localeCompare(b.label);

/**
 * Split the product master into {byCat, loose, all}.
 *
 * Every row carries its category LABEL and SKU as well as its name, because
 * a product name alone is often not identifiable — "Bucket Bolt" could be
 * anything; "Bucket Bolt / Packing Material · PK-025" could not. The picker
 * shows both and searches both.
 */
export function bucketiseProducts(rows) {
  const byCat = new Map(PRODUCT_CATEGORIES.map(([k]) => [k, []]));
  const loose = [];
  for (const p of rows || []) {
    const label = p.product_name || p.name || '';
    if (!label) continue;
    const item = {
      value: p.id,
      label,
      sku: p.sku_code || '',
      catLabel: LABEL_OF.get(p.goods_sub_type) || '',
    };
    (byCat.get(p.goods_sub_type) || loose).push(item);
  }
  for (const list of byCat.values()) list.sort(byName);
  loose.sort(byName);
  const all = [...PRODUCT_CATEGORIES.flatMap(([k]) => byCat.get(k) || []), ...loose]
    .sort(byName);
  return { byCat, loose, all };
}

/**
 * What the CLOSED control should read for the applied value.
 *
 * This matters more than it looks. The control and the numbers beside it
 * must never disagree: a dashboard filtered to one product while its own
 * filter says "All products" is the same defect class as an overdue list
 * showing a bill that owes nothing. So an id we cannot resolve says so
 * rather than silently falling back to "All products".
 */
export function resolveProductLabel(value, { byCat, all, groups } = {}) {
  const v = String(value ?? '');
  if (!v) return 'All products';
  // A GROUP (a product family): several ids joined by commas. Its name lives
  // with the caller, not in the master, so it has to be matched first —
  // otherwise the id-lookup below misses and the control reads "1 product"
  // for something that has a perfectly good name.
  const g = (groups || []).find((x) => String(x.value) === v);
  if (g) return g.label;
  if (v.startsWith(CAT_PREFIX)) {
    const key = v.slice(CAT_PREFIX.length);
    const n = (byCat?.get(key) || []).length;
    const label = LABEL_OF.get(key) || 'Uncategorised';
    return n ? `${label} — all ${n}` : label;
  }
  const hit = (all || []).find((p) => String(p.value) === v);
  if (hit) return hit.label;
  // Several ids, but no group matched them — say how many rather than
  // claiming one.
  const n = v.split(',').filter(Boolean).length;
  if (n > 1) return `${n} products`;
  // Master still loading, or a product that no longer exists: either way,
  // saying "1 product" is honest where "All products" would be a lie.
  return '1 product';
}
