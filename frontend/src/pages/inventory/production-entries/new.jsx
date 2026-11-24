import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Save, Loader2, Trash2, ArrowLeft, Plus, Minus, ArrowUpRight, Layers, ChevronDown, ChevronRight, Users } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import CustomSelect from '@/components/ui/CustomSelect';
import CreatableSelect from '@/components/ui/CreatableSelect';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFormDraft from '../../../hooks/useFormDraft.js';
import { confirm } from '@/components/common/confirm';

// Output-first Production Entry form.
//
// Structure:
//   Entry (date, company, warehouse, godown)
//   └─ Output 1 (product X, qty)   ← what was produced
//      └─ Input A (product, qty)   ← raw materials consumed to make X
//      └─ Input B (product, qty)
//   └─ Output 2 (product Y, qty)
//      └─ Input C (product, qty)
//
// Backend stores INPUT lines with a parent_line FK pointing at the
// OUTPUT line — full traceability of which raw materials produced which
// output, all in one entry.

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const numClass = `${inputClass} tabular-nums text-right`;
const labelClass = 'block text-xs font-medium text-slate-600 mb-1';
const isoToday = () => new Date().toISOString().slice(0, 10);

// Client-side unique key generator for new rows (before they get
// server ids). Random string instead of a monotonic counter so
// cids from a restored draft can NEVER collide with cids generated
// after the restore — the module-scoped counter would restart at 0
// on page reload and a subsequent addOutput() would silently reuse
// an old key, wrecking React's reconciliation.
const cid = () => `cid-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 6)}`;

// UOM options — matches master.Product.UOM_CHOICES so any value that
// autofills from the Product master shows correctly in the dropdown.
// GM / ML / BAG / DRUM / ROLL added because the paper DPR uses them
// even when the master doesn't list them.
const UOM_OPTIONS = [
  'KG', 'GM', 'MTS',
  'LTR', 'ML',
  'PCS', 'NOS', 'BAG', 'BOX', 'PACK', 'DRUM', 'ROLL',
  'MTR', 'SQM', 'CUM',
];
// Merge the current value into the option list if it isn't already
// there — otherwise a legacy value silently disappears from the picker.
const uomOptionsWith = (current) => {
  const key = (current || '').trim();
  if (!key || UOM_OPTIONS.includes(key)) return UOM_OPTIONS;
  return [key, ...UOM_OPTIONS];
};

// Product-category filter options shown next to the Product picker.
// Values mirror Product.goods_sub_type on the master. Two lists —
// Outputs (what was produced) can only be Semi-Finished or Finished
// Goods; material inputs cover the intermediate consumables list.
const OUTPUT_CATEGORIES = [
  { value: 'SEMI_FINISHED',    label: 'Semi Finished' },
  { value: 'FINISHED_GOOD',    label: 'Finished Good' },
];
const INPUT_CATEGORIES = [
  { value: '',                 label: 'All' },
  { value: 'RAW_MATERIAL',     label: 'Raw Material' },
  { value: 'PACKING_MATERIAL', label: 'Packing Material' },
  { value: 'SEMI_FINISHED',    label: 'Semi Finished' },
  { value: 'FINISHED_GOOD',    label: 'Finished Good' },
];

const newInput = () => ({ cid: cid(), id: null, category: '', product: '', qty_kg: '', qty_litres: '', qty_count: '', uom: '', batch_no: '', remarks: '', packed_from: '', damage_qty_kg: '', damage_qty_litres: '', damage_qty_count: '', damage_reason: '' });

// ── Unit conversion helpers ─────────────────────────────────────────
// MTS_PER_KG   → 1 metric ton = 1000 kg. Same idea for GM / ML / CUM
//                below — the qty_kg / qty_litres columns on the DB
//                are always in native units (kg and L), so anything
//                the operator types in a bigger/smaller UOM has to
//                be scaled BEFORE it lands in state (and unscaled
//                for display). Without this the "7 MTS" typed by an
//                operator whose UOM dropdown reads MTS was silently
//                stored as 7 kg.
// kgToLtr / ltrToKg — SG-driven conversion for products purchased
//                in kg but consumed in litres.
const MTS_PER_KG = 1000;
const kgToLtr = (kg, sg) => (Number(sg) > 0 ? Number(kg) / Number(sg) : null);
const ltrToKg = (ltr, sg) => (Number(sg) > 0 ? Number(ltr) * Number(sg) : null);
const fmt3 = (n) => {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '0';
  return v.toFixed(3);
};

// Multiplier that converts a value TYPED in the operator's UOM to
// the DB unit (KG for weight / LTR for volume). Anything not in
// the table stays 1:1 — safe default for unknown UOMs.
const KG_FROM_UOM = { KG: 1, MTS: 1000, GM: 0.001 };
const LTR_FROM_UOM = { LTR: 1, ML: 0.001, CUM: 1000 };

// Display <-> DB conversions for the qty inputs. Storage is always
// canonical (KG, LTR); display re-scales based on the picked UOM.
// Blank input maps to blank state so an unfocused-but-untouched
// input doesn't render "0" out of nowhere.
const displayFromKg = (kg, uom) => {
  const f = KG_FROM_UOM[uom];
  if (f == null) return kg === '' || kg == null ? '' : String(kg);
  if (kg === '' || kg == null) return '';
  const v = Number(kg) / f;
  return Number.isFinite(v) ? String(v) : '';
};
const kgFromDisplay = (displayValue, uom) => {
  if (displayValue === '' || displayValue == null) return '';
  const f = KG_FROM_UOM[uom] ?? 1;
  const v = Number(displayValue);
  if (!Number.isFinite(v)) return '';
  return String(v * f);
};
const displayFromLtr = (ltr, uom) => {
  const f = LTR_FROM_UOM[uom];
  if (f == null) return ltr === '' || ltr == null ? '' : String(ltr);
  if (ltr === '' || ltr == null) return '';
  const v = Number(ltr) / f;
  return Number.isFinite(v) ? String(v) : '';
};
const ltrFromDisplay = (displayValue, uom) => {
  if (displayValue === '' || displayValue == null) return '';
  const f = LTR_FROM_UOM[uom] ?? 1;
  const v = Number(displayValue);
  if (!Number.isFinite(v)) return '';
  return String(v * f);
};

// Suffix shown in the qty input matches the operator's picked UOM
// (falls back to the DB unit when the row hasn't picked one yet).
const kgSuffix = (uom) => (uom && KG_FROM_UOM[uom] ? uom : 'KG');
const ltrSuffix = (uom) => (uom && LTR_FROM_UOM[uom] ? uom : 'LTR');

// Fallback pack-size parser — scrapes the FIRST "<number> <unit>"
// pattern out of a product name so the auto-fill still works when
// the operator hasn't populated pack_size_kg / pack_size_ltr on
// the master. Deliberately picks the FIRST match so a name like
// "STH 5 KG Pouch in 25 KG Bag" resolves to the primary pack
// (5 kg per pouch) not the outer wrapper (25 kg).
//
// Recognises common shop-floor spellings: `5 KG`, `5kg`, `500 ML`,
// `1 MTS`, `100 g`, `12 L`, `1 CUM`. Returns {kg, ltr} in canonical
// DB units; either or both can be 0 when nothing matched.
const guessPackSizeFromName = (name) => {
  if (!name) return { kg: 0, ltr: 0 };
  const m = String(name).match(/(\d+(?:\.\d+)?)\s*(KG|MTS|MT|GM|LTR|LT|ML|CUM|G|L)\b/i);
  if (!m) return { kg: 0, ltr: 0 };
  const n = Number(m[1]);
  const u = m[2].toUpperCase();
  if (!Number.isFinite(n) || n <= 0) return { kg: 0, ltr: 0 };
  if (u === 'KG')                   return { kg: n,          ltr: 0 };
  if (u === 'MTS' || u === 'MT')    return { kg: n * 1000,   ltr: 0 };
  if (u === 'GM'  || u === 'G')     return { kg: n / 1000,   ltr: 0 };
  if (u === 'LTR' || u === 'LT' || u === 'L') return { kg: 0, ltr: n };
  if (u === 'ML')                   return { kg: 0,          ltr: n / 1000 };
  if (u === 'CUM')                  return { kg: 0,          ltr: n * 1000 };
  return { kg: 0, ltr: 0 };
};

// Resolve pack size for a product — the master's explicit value
// wins; falls back to the name-parsed value so a well-named SKU
// works without any setup.
const packSizeKgOf = (product) => {
  if (!product) return 0;
  const explicit = Number(product.pack_size_kg) || 0;
  if (explicit > 0) return explicit;
  return guessPackSizeFromName(product.product_name).kg || 0;
};
const packSizeLtrOf = (product) => {
  if (!product) return 0;
  const explicit = Number(product.pack_size_ltr) || 0;
  if (explicit > 0) return explicit;
  return guessPackSizeFromName(product.product_name).ltr || 0;
};
const newOutput = () => ({ cid: cid(), id: null, category: '', product: '', godown: '', qty_kg: '', qty_litres: '', qty_count: '', uom: '', batch_no: '', remarks: '', damage_qty_kg: '', damage_qty_litres: '', damage_qty_count: '', damage_reason: '', inputs: [newInput()] });

// Volume-family UOMs on the master. Every product tagged with one
// of these gets a Qty (LTR) field on the production form.
const VOLUME_UOMS = new Set(['LTR', 'ML', 'CUM']);
// Weight-family UOMs on the master. These get a Qty (KG) field —
// the operator always types kilograms even if the master says MTS.
const WEIGHT_UOMS = new Set(['KG', 'MTS']);
// Everything else on the master (PCS / NOS / BAG / PACK / BOX /
// MTR / SQM) is treated as a discrete count on the shop floor
// so a "5 drums" entry is stored as qty_count = 5, not
// qty_kg = 5 (which would poison the weight-based reports).
//
// mode:  'sg'    → SG-applicable: both KG (mass) + LTR (derived volume)
//        'ltr'   → Volume: single Qty (LTR) field
//        'kg'    → Weight: single Qty (KG) field
//        'count' → Discrete count: single Qty (PCS-labelled) field
//                  writing to qty_count.
const resolveQtyMode = (product) => {
  if (!product) return 'kg';
  if (product.sg_applicable) return 'sg';
  const u = String(product.uom || '').toUpperCase();
  if (VOLUME_UOMS.has(u)) return 'ltr';
  if (WEIGHT_UOMS.has(u)) return 'kg';
  return 'count';
};
// One row on the dynamic Labor block. `cid` is a client-only React
// key that we strip before sending to the backend. Row shape
// stored in labor_rows JSONField:
//   { label, mode, count, rate, group_total, contractor }
// mode='HEAD'  → per-person wage: total = count × rate
// mode='GROUP' → flat wage paid to the whole group: total = group_total
//                (count is still recorded for headcount reporting)
// contractor  → optional Vendor uuid — the payee. Required for GROUP
//               (needed for the wage-payment settlement flow),
//               optional for HEAD (staff can be paid directly).
// mode='PIECE' → piece-rate contractor paid per unit of output
//                 (e.g. "Cake Expeller — ₹875/MT × 60.4 MTs").
//                 total = qty × rate, with qty_uom describing the
//                 unit ('MTS', 'NOS', 'BAG', …) — free text so the
//                 operator can match whatever the contract says.
const newLaborRow = () => ({
  cid: cid(),
  label: '',
  mode: 'HEAD',
  count: '',
  rate: '',
  group_total: '',
  qty: '',
  qty_uom: 'MTS',
  contractor: '',
});

export default function ProductionEntryForm() {
  const navigate = useNavigate();
  const { id } = useParams();
  const isEdit = Boolean(id && id !== 'new');
  const { canCreate, canEdit, canDelete } = usePermissions();
  const editable = isEdit ? canEdit('Production Entry') : canCreate('Production Entry');

  const { raw: companiesRaw } = useLookup('/api/companies/');
  const companies = useMemo(
    () => (companiesRaw || []).map((c) => ({ value: c.id, label: c.legal_name || c.name })),
    [companiesRaw],
  );
  const { raw: warehousesRaw } = useLookup('/api/warehouses/');

  const [header, setHeader] = useState({
    entry_date: isoToday(),
    entry_type: 'PRODUCTION',
    // TVP-SS packing sessions record ONE physical stage per entry
    // (Filling → Labeling → Boxing → Pelleting → Completed). Other
    // packing sites pack in one shot (MIXED). PRODUCTION entries
    // never carry a stage. Backend validates this.
    packing_stage: '',
    company: '',
    warehouse: '',
    godown: '',
    remarks: '',
    // Optional labor block — dynamic list, each row = { label, count, rate }.
    // No fixed categories anymore; the operator adds whichever labor
    // pools they actually used on the shop floor for this batch.
    labor_rows: [],
    labor_remarks: '',
  });
  const [laborOpen, setLaborOpen] = useState(false);
  const setHeaderField = (k, v) => setHeader((prev) => ({ ...prev, [k]: v }));

  // Labor category suggestions — distinct labels used on past
  // entries. Feeds a <datalist> so the operator picks from what's
  // been used before instead of retyping; still allows free-typing
  // to add a brand-new category (which will show up next session).
  const [laborCategorySuggestions, setLaborCategorySuggestions] = useState([]);
  useEffect(() => {
    let cancelled = false;
    apiClient.get('/api/inventory/production-entries/labor-categories/')
      .then((res) => { if (!cancelled) setLaborCategorySuggestions(Array.isArray(res.data) ? res.data : []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  // Merge fetched suggestions with any labels already typed on this
  // form's labor rows — so a category typed on row 1 immediately
  // shows up in row 2's dropdown without a save + reload.
  const effectiveLaborCategories = useMemo(() => {
    const s = new Set(laborCategorySuggestions);
    (header.labor_rows || []).forEach((r) => {
      const l = (r.label || '').trim();
      if (l) s.add(l);
    });
    return Array.from(s).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }, [laborCategorySuggestions, header.labor_rows]);

  // Dynamic Labor block helpers. Each row is a plain object on
  // header.labor_rows; the cid is a React key that gets stripped
  // before the payload is sent to the backend.
  const addLaborRow = () => setHeader((prev) => ({
    ...prev, labor_rows: [...prev.labor_rows, newLaborRow()],
  }));
  const removeLaborRow = (rowCid) => setHeader((prev) => ({
    ...prev, labor_rows: prev.labor_rows.filter((r) => r.cid !== rowCid),
  }));
  const updateLaborRow = (rowCid, key, value) => setHeader((prev) => ({
    ...prev,
    labor_rows: prev.labor_rows.map((r) => r.cid === rowCid ? { ...r, [key]: value } : r),
  }));
  // Per-row wage compute — mirrors the backend labor_total logic
  // so the operator sees the same footer total the server will save.
  const laborRowTotal = (r) => {
    const mode = (r?.mode || 'HEAD').toUpperCase();
    if (mode === 'GROUP') return Number(r.group_total) || 0;
    if (mode === 'PIECE') return (Number(r.qty) || 0) * (Number(r.rate) || 0);
    return (Number(r.count) || 0) * (Number(r.rate) || 0);
  };
  const laborTotal = useMemo(
    () => (header.labor_rows || []).reduce((s, r) => s + laborRowTotal(r), 0),
    [header.labor_rows],
  );
  const laborHeadcount = useMemo(
    () => (header.labor_rows || []).reduce((s, r) => s + (Number(r.count) || 0), 0),
    [header.labor_rows],
  );

  const warehouses = useMemo(() => {
    const seen = new Set();
    return (warehousesRaw || [])
      .filter((w) => !header.company || String(w.company) === String(header.company))
      .filter((w) => {
        const k = (w.name || '').trim().toLowerCase();
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((w) => ({ value: w.id, label: w.name }));
  }, [warehousesRaw, header.company]);

  const { raw: godownsRaw } = useLookup(header.warehouse ? `/api/godowns/?warehouse=${header.warehouse}` : null);
  const godowns = useMemo(
    () => (godownsRaw || []).map((g) => ({ value: g.id, label: g.godown_name || g.name || 'Godown' })),
    [godownsRaw],
  );

  const { raw: catalogRaw } = useLookup('/api/purchase/items/');
  const products = useMemo(
    () =>
      (catalogRaw || [])
        .filter((it) => it.item_type === 'PRODUCT')
        .map((it) => ({
          id: it.item_id,
          product_name: it.item_name,
          sku_code: it.item_code,
          uom: it.uom,
          sg_applicable: it.sg_applicable || false,
          // Category == Product.goods_sub_type on the master. Used by
          // the per-row Category filter on Output + material dropdowns
          // to narrow the picker to just Raw Materials, Finished Goods, etc.
          category: it.category || '',
          // Pack size drives the packing-entry auto-fill; SG lets the
          // form KG↔LTR-convert when the input needs a different unit
          // than the output specifies.
          pack_size_kg:     Number(it.pack_size_kg  || 0) || 0,
          pack_size_ltr:    Number(it.pack_size_ltr || 0) || 0,
          specific_gravity: Number(it.specific_gravity || 0) || 0,
        })),
    [catalogRaw],
  );
  // Fast id → category lookup used to auto-set a row's category when
  // an existing entry is loaded in edit mode (server rows carry
  // `product` but not `category` — we derive it from the master).
  const productCategoryById = useMemo(() => {
    const m = new Map();
    products.forEach((p) => { if (p.category) m.set(p.id, p.category); });
    return m;
  }, [products]);
  // Full product record by id — used to drive the per-row Qty mode
  // (KG / LTR / PCS / SG) so the form shows only the field(s) that
  // match the picked product. Prevents "typed litres into kg" errors.
  const productById = useMemo(() => {
    const m = new Map();
    products.forEach((p) => m.set(p.id, p));
    return m;
  }, [products]);

  // Vendor picker for the Labor block's per-row Contractor. Reused
  // across rows so payment can later roll up per contractor via the
  // existing wage-payment flow — a GROUP row without a contractor
  // has nowhere to send the money.
  const { raw: vendorsRaw } = useLookup('/api/vendors/');
  const vendorOptions = useMemo(
    () => (vendorsRaw || [])
      .map((v) => ({ value: v.id, label: v.vendor_name || v.name || v.legal_name || '' }))
      .filter((o) => o.label)
      .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase())),
    [vendorsRaw],
  );

  // outputs state — declared BEFORE the godown cache block below so
  // the useMemo/useEffect that reference `outputs` don't hit a temporal
  // dead zone during the first render pass.
  const [outputs, setOutputs] = useState([newOutput()]);
  // Batch number is picked manually by the operator on each Output.
  // No auto-generation on load — the field is a plain text input the
  // user fills in (typically after they know which product / date /
  // sequence they want to stamp).

  // Per-godown Production Stock cache. Each output can have its own
  // godown; the batch picker + stock hint on that output's materials
  // must reflect stock at THAT godown, not a shared header godown.
  // Keyed by godown_id, value is the raw balance rows returned by the
  // balance endpoint (one per product × batch).
  const [stockByGodown, setStockByGodown] = useState(new Map());
  // Fetch balance for any godown that's used in the entry but not
  // cached yet. Runs whenever the header godown or any output's godown
  // changes (via the useEffect deps below).
  const godownsInUse = useMemo(() => {
    const s = new Set();
    if (header.godown) s.add(header.godown);
    outputs.forEach((o) => { if (o.godown) s.add(o.godown); });
    return s;
  }, [header.godown, outputs]);
  useEffect(() => {
    const missing = Array.from(godownsInUse).filter((gid) => !stockByGodown.has(gid));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(missing.map((gid) =>
      apiClient.get(`/api/inventory/production-stock/balance/?godown=${gid}`)
        .then((res) => [gid, res.data || []])
        .catch(() => [gid, []]),
    )).then((pairs) => {
      if (cancelled) return;
      setStockByGodown((prev) => {
        const next = new Map(prev);
        pairs.forEach(([gid, rows]) => next.set(gid, rows));
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [godownsInUse, stockByGodown]);
  // For an output's godown, bucket its balance rows by product_id.
  // Returns an empty Map when godownId is falsy so callers can .get()
  // safely without an outer null-check.
  const EMPTY_MAP = useMemo(() => new Map(), []);
  const stockByProductForGodown = (godownId) => {
    if (!godownId) return EMPTY_MAP;
    const rows = stockByGodown.get(godownId) || [];
    const m = new Map();
    rows.forEach((r) => {
      const arr = m.get(r.product_id) || [];
      arr.push(r);
      m.set(r.product_id, arr);
    });
    return m;
  };
  // Convenience: rolled-up per product (sum across batches) at that
  // godown — powers the "Stock KG / Stock LTR" hint columns.
  const stockLookupForGodown = (godownId) => {
    if (!godownId) return EMPTY_MAP;
    const byProduct = stockByProductForGodown(godownId);
    const m = new Map();
    byProduct.forEach((batches, productId) => {
      const kg = batches.reduce((s, b) => s + Number(b.qty_kg || 0), 0);
      const lt = batches.reduce((s, b) => s + Number(b.qty_litres || 0), 0);
      const ct = batches.reduce((s, b) => s + Number(b.qty_count || 0), 0);
      m.set(productId, { qty_kg: kg, qty_litres: lt, qty_count: ct });
    });
    return m;
  };
  // Per-output collapse state — a Set of cids currently collapsed.
  // Kept as transient UI state (not sent to the backend).
  const [collapsedCids, setCollapsedCids] = useState(() => new Set());
  const isCollapsed = (outCid) => collapsedCids.has(outCid);
  const toggleCollapse = (outCid) => {
    setCollapsedCids((prev) => {
      const next = new Set(prev);
      if (next.has(outCid)) next.delete(outCid); else next.add(outCid);
      return next;
    });
  };
  const collapseAll = () => setCollapsedCids(new Set(outputs.map((o) => o.cid)));
  const expandAll = () => setCollapsedCids(new Set());
  // Raw-materials sub-collapse — independent of the output-card collapse.
  // Lets the operator keep an output's product/qty visible while hiding
  // its long list of raw materials.
  const [materialsCollapsedCids, setMaterialsCollapsedCids] = useState(() => new Set());
  const areMaterialsCollapsed = (outCid) => materialsCollapsedCids.has(outCid);
  const toggleMaterialsCollapse = (outCid) => {
    setMaterialsCollapsedCids((prev) => {
      const next = new Set(prev);
      if (next.has(outCid)) next.delete(outCid); else next.add(outCid);
      return next;
    });
  };
  const [entryNo, setEntryNo] = useState('');
  const [createdByName, setCreatedByName] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  // Packable source outputs — populated only when entry_type=PACKING
  // and the header warehouse is set. Cached across all input rows so
  // switching between rows doesn't refetch. Key = product_id → array
  // of {line_id, entry_no, batch_no, remaining_*} rows.
  const [packableByProduct, setPackableByProduct] = useState(new Map());

  // ── Draft auto-save (localStorage, opt-in restore) ──────────────
  // Bundle every field the operator has touched into ONE serialisable
  // object the draft hook can persist. UI-only state (collapse sets)
  // is deliberately excluded — restoring "which cards were folded"
  // isn't worth the schema fragility.
  //
  // ⚠ Bump DRAFT_SCHEMA_VERSION every time we add / rename a top-
  // level field on this bundle so old drafts get discarded cleanly
  // instead of crashing the restore.
  const DRAFT_SCHEMA_VERSION = 1;
  const draftBundle = useMemo(() => ({
    header,
    outputs,
    laborOpen,
  }), [header, outputs, laborOpen]);

  // Apply a restored draft — pushes each slice back into its own
  // setState. Wrapped in useCallback so the hook's identity is stable
  // and its `restore()` result doesn't re-render on every parent render.
  const applyRestoredDraft = useCallback((restored) => {
    if (!restored || typeof restored !== 'object') return;
    if (restored.header && typeof restored.header === 'object') setHeader(restored.header);
    if (Array.isArray(restored.outputs) && restored.outputs.length) setOutputs(restored.outputs);
    if (typeof restored.laborOpen === 'boolean') setLaborOpen(restored.laborOpen);
    toast.success('Draft restored — pick up where you left off.');
  }, []);

  // "Is the current state worth autosaving?" — true when the operator
  // has typed at least one thing beyond the initial empty scaffold.
  // Feeds `writeGate` on the draft hook so opening the form to peek
  // (or closing without typing) never overwrites yesterday's real
  // draft with an empty one. Manual "Save now" bypasses this gate.
  //
  // Deliberately EXCLUDED from the "meaningful" test:
  //   * entry_date  — defaults to today via isoToday()
  //   * entry_type  — defaults to 'PRODUCTION'
  //   * company     — silently prefilled from the operator's
  //                   stakeholder profile
  //   * warehouse   — silently prefilled from the operator's
  //                   stakeholder profile
  // Counting any of these would fire a "draft saved" on a fresh
  // page load before the operator has typed anything real, and
  // restoring that draft would give them nothing back.
  //
  // What DOES count: godown, product picks, qtys, batch, remarks,
  // packing_stage, labor rows, damage, packing-source materials —
  // i.e. anything the operator physically had to enter.
  const isMeaningful = useMemo(() => {
    if ((header.godown || '').trim())        return true;
    if ((header.remarks || '').trim())       return true;
    if ((header.labor_remarks || '').trim()) return true;
    if ((header.packing_stage || '').trim()) return true;
    if ((header.labor_rows || []).some((r) => (
      (r.label || '').trim()
      || Number(r.count) > 0
      || Number(r.group_total) > 0
      || Number(r.qty) > 0
      || Number(r.rate) > 0
    ))) return true;
    if ((outputs || []).some((o) => (
      (o.product || '').trim()
      || (o.godown || '').trim()
      || (o.batch_no || '').trim()
      || (o.remarks || '').trim()
      || Number(o.qty_kg) > 0 || Number(o.qty_litres) > 0 || Number(o.qty_count) > 0
      || Number(o.damage_qty_kg) > 0 || Number(o.damage_qty_litres) > 0 || Number(o.damage_qty_count) > 0
      || (o.inputs || []).some((i) => (
        (i.product || '').trim()
        || (i.packed_from || '').trim()
        || (i.batch_no || '').trim()
        || (i.remarks || '').trim()
        || Number(i.qty_kg) > 0 || Number(i.qty_litres) > 0 || Number(i.qty_count) > 0
        || Number(i.damage_qty_kg) > 0 || Number(i.damage_qty_litres) > 0 || Number(i.damage_qty_count) > 0
      ))
    ))) return true;
    return false;
  }, [header, outputs]);

  const draft = useFormDraft({
    key: isEdit ? `production-entry:edit:${id}` : 'production-entry:new',
    version: DRAFT_SCHEMA_VERSION,
    state: draftBundle,
    onRestore: applyRestoredDraft,
    // Only meaningful while the form is being edited — read-only /
    // loading modes shouldn't persist a half-loaded snapshot.
    enabled: editable && !loading,
    // Autosave only fires when there's real content. Empty form
    // state never overwrites a stored draft (that was the bug —
    // the restore banner would come back with nothing to restore).
    writeGate: isMeaningful,
  });
  const [packableLoading, setPackableLoading] = useState(false);

  // Prefill company + warehouse from the operator's stakeholder
  // profile so the "primary location" doesn't have to be picked on
  // every entry. NEW entries only — edit mode reads header values
  // from the loaded record. The prefill uses a functional update so
  // it never clobbers a value the operator has already typed in the
  // narrow window before the fetch returns.
  useEffect(() => {
    if (isEdit) return;
    let cancelled = false;
    apiClient.get('/api/users/me/')
      .then((res) => {
        if (cancelled) return;
        const { default_company, default_warehouse } = res.data || {};
        if (!default_company && !default_warehouse) return;
        setHeader((prev) => ({
          ...prev,
          company: prev.company || (default_company ? String(default_company) : ''),
          warehouse: prev.warehouse || (default_warehouse ? String(default_warehouse) : ''),
        }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isEdit]);

  // Fetch packable OUTPUT lines (produced-but-not-yet-fully-packed
  // bulk) whenever entry_type flips to PACKING or the header
  // warehouse/godown changes. Skipped for PRODUCTION entries so
  // the picker doesn't waste a request when it wouldn't be shown.
  // Header warehouse alone is enough — godown filtering happens
  // per-input-row against the row's effective godown.
  useEffect(() => {
    if (header.entry_type !== 'PACKING' || !header.warehouse) {
      setPackableByProduct(new Map());
      return;
    }
    let cancelled = false;
    setPackableLoading(true);
    const params = new URLSearchParams({
      warehouse: header.warehouse,
      entry_type: 'PRODUCTION',
    });
    if (header.godown) params.set('godown', header.godown);
    apiClient.get(`/api/inventory/production-entries/packable-outputs/?${params.toString()}`)
      .then((res) => {
        if (cancelled) return;
        const map = new Map();
        (res.data || []).forEach((row) => {
          const arr = map.get(row.product_id) || [];
          arr.push(row);
          map.set(row.product_id, arr);
        });
        setPackableByProduct(map);
      })
      .catch(() => { if (!cancelled) setPackableByProduct(new Map()); })
      .finally(() => { if (!cancelled) setPackableLoading(false); });
    return () => { cancelled = true; };
  }, [header.entry_type, header.warehouse, header.godown]);

  useEffect(() => {
    if (!isEdit) return;
    let cancelled = false;
    setLoading(true);
    apiClient.get(`/api/inventory/production-entries/${id}/`)
      .then((res) => {
        if (cancelled) return;
        const d = res.data || {};
        setEntryNo(d.entry_no || '');
        setCreatedByName(d.created_by_name || '');
        // Prefer the new dynamic labor_rows; fall back to converting
        // the legacy fixed slots into rows so a historical entry
        // still surfaces its labor in the new UI.
        let loadedRows = Array.isArray(d.labor_rows) ? d.labor_rows : [];
        if (!loadedRows.length) {
          const legacy = [
            ['Tamil',      d.labor_tamil_count,      d.labor_tamil_rate],
            ['Hindi',      d.labor_hindi_count,      d.labor_hindi_rate],
            ['Ladies',     d.labor_ladies_count,     d.labor_ladies_rate],
            ['Supervisor', d.labor_supervisor_count, d.labor_supervisor_rate],
          ];
          loadedRows = legacy
            .filter(([, c]) => Number(c) > 0)
            .map(([label, c, r]) => ({ label, count: c || 0, rate: r || 0 }));
        }
        const laborRowsWithCids = loadedRows.map((r) => ({
          cid: cid(),
          label: r.label || '',
          mode: (r.mode || 'HEAD').toUpperCase(),
          count: r.count ?? '',
          rate: r.rate ?? '',
          group_total: r.group_total ?? '',
          qty: r.qty ?? '',
          qty_uom: r.qty_uom || 'MTS',
          contractor: r.contractor || '',
        }));
        setHeader({
          entry_date: d.entry_date || isoToday(),
          entry_type: d.entry_type || 'PRODUCTION',
          packing_stage: d.packing_stage || '',
          company: d.company || '',
          warehouse: d.warehouse || '',
          godown: d.godown || '',
          remarks: d.remarks || '',
          labor_rows: laborRowsWithCids,
          labor_remarks: d.labor_remarks || '',
        });
        // Auto-expand the labor block if the loaded entry has any
        // headcount recorded — otherwise leave it collapsed.
        if (laborRowsWithCids.some((r) => Number(r.count) > 0 || Number(r.group_total) > 0 || Number(r.qty) > 0)) setLaborOpen(true);
        const outs = d.outputs || [];
        setOutputs(outs.length ? outs.map((o) => ({
          cid: cid(),
          id: o.id,
          product: o.product || '',
          // Legacy entries may not have a per-output godown; inherit
          // the header godown so the operator sees the right value
          // instead of a blank picker.
          godown: o.godown || d.godown || '',
          qty_kg: o.qty_kg || '',
          qty_litres: o.qty_litres || '',
          qty_count: o.qty_count || '',
          uom: o.uom || '',
          batch_no: o.batch_no || '',
          remarks: o.remarks || '',
          damage_qty_kg:     o.damage_qty_kg || '',
          damage_qty_litres: o.damage_qty_litres || '',
          damage_qty_count:  o.damage_qty_count || '',
          damage_reason:     o.damage_reason || '',
          inputs: (o.inputs || []).length ? o.inputs.map((i) => ({
            cid: cid(),
            id: i.id,
            product: i.product || '',
            qty_kg: i.qty_kg || '',
            qty_litres: i.qty_litres || '',
            qty_count: i.qty_count || '',
            uom: i.uom || '',
            batch_no: i.batch_no || '',
            remarks: i.remarks || '',
            packed_from: i.packed_from || '',
            damage_qty_kg:     i.damage_qty_kg || '',
            damage_qty_litres: i.damage_qty_litres || '',
            damage_qty_count:  i.damage_qty_count || '',
            damage_reason:     i.damage_reason || '',
          })) : [newInput()],
        })) : [newOutput()]);
      })
      .catch((err) => toast.error(getApiErrorMessage(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [id, isEdit]);

  // ── Output helpers ─────────────────────────────────────────────────
  // Compute the auto-filled input rows for a PACKING output row.
  // Called inline from updateOutput whenever the output's qty or
  // product changes — every input row gets its qty updated based on:
  //   * Bulk rows (packed_from set) → output_count × pack_size, with
  //     KG↔LTR conversion via SG when the input's native unit
  //     differs from what the pack size is expressed in.
  //   * Packaging rows (no packed_from, count-mode) → 1:1 with
  //     output_count.
  //   * Everything else → left untouched.
  //
  // Deliberately overwrites existing qty (auto-fill wins over stale
  // typing). If the operator wants a different value they can edit
  // after the auto-fill lands.
  const autoFillPackingInputRows = (outRow, outProduct) => {
    // Canonicalise the output's totals across all three units. Fills
    // in whichever the operator didn't type using the OUTPUT
    // product's pack_size (e.g. entered `7 MTS` → derive count = 7000
    // ÷ pack_size_kg). This gives us reliable outKg / outLtr /
    // outCount for the auto-fill downstream, regardless of which
    // qty field the operator populated first. Uses the master value
    // when present, else parses from the product name (so a SKU
    // named "5 KG Pouch" auto-resolves to 5 kg without any setup).
    const outPsKg  = packSizeKgOf(outProduct);
    const outPsLtr = packSizeLtrOf(outProduct);
    let outKg    = Number(outRow.qty_kg)     || 0;
    let outLtr   = Number(outRow.qty_litres) || 0;
    let outCount = Number(outRow.qty_count)  || 0;
    if (outKg    === 0 && outCount > 0 && outPsKg  > 0) outKg    = outCount * outPsKg;
    if (outCount === 0 && outKg    > 0 && outPsKg  > 0) outCount = outKg    / outPsKg;
    if (outLtr   === 0 && outCount > 0 && outPsLtr > 0) outLtr   = outCount * outPsLtr;
    if (outCount === 0 && outLtr   > 0 && outPsLtr > 0) outCount = outLtr   / outPsLtr;
    // Nothing to derive from — bail before we overwrite manual
    // entries the operator may have already typed.
    if (outKg <= 0 && outLtr <= 0 && outCount <= 0) return outRow.inputs;

    return (outRow.inputs || []).map((i) => {
      if (!i.product) return i;
      const inpProduct = productById.get(i.product);
      if (!inpProduct) return i;
      const inpMode = resolveQtyMode(inpProduct);
      const inpPsKg  = packSizeKgOf(inpProduct);
      const inpPsLtr = packSizeLtrOf(inpProduct);
      const sg = Number(inpProduct.specific_gravity)
              || Number(outProduct.specific_gravity)
              || 0;

      // Packaging input (no bulk source link). The packaging
      // material's OWN pack_size is the authority: "5 kg pouch" =>
      // pack_size_kg=5, so 7000 kg output ÷ 5 = 1400 pouches. Same
      // pattern for the 25 kg outer bag => 7000 ÷ 25 = 280. Falls
      // back to 1:1 with outCount only when the packaging has no
      // pack_size set (labels, generic wrappers). Math.ceil rounds
      // up so a partial pack still gets a full unit of packaging.
      if (!i.packed_from) {
        if (inpMode === 'count') {
          // Same-unit division first (KG output → KG packaging,
          // LTR output → LTR packaging). Handles 7000 kg ÷ 5 kg
          // = 1400 pouches and 6000 L ÷ 0.5 L = 12000 bottles.
          if (inpPsKg  > 0 && outKg  > 0) return { ...i, qty_count: String(Math.ceil(outKg  / inpPsKg))  };
          if (inpPsLtr > 0 && outLtr > 0) return { ...i, qty_count: String(Math.ceil(outLtr / inpPsLtr)) };
          // Cross-unit fallback via SG — packing a KG-only output
          // into ML bottles (or an LTR-only output into KG bags)
          // for SG-applicable products. Skips when SG is unknown
          // to avoid guessing at a conversion factor.
          if (inpPsKg  > 0 && outLtr > 0 && sg > 0) {
            const kgFromLtr = ltrToKg(outLtr, sg);
            if (kgFromLtr) return { ...i, qty_count: String(Math.ceil(kgFromLtr / inpPsKg)) };
          }
          if (inpPsLtr > 0 && outKg > 0 && sg > 0) {
            const ltrFromKg = kgToLtr(outKg, sg);
            if (ltrFromKg) return { ...i, qty_count: String(Math.ceil(ltrFromKg / inpPsLtr)) };
          }
          // Last resort: 1:1 with pack-unit count (labels, generic
          // wrappers with no pack_size and no unit conversion).
          if (outCount > 0)              return { ...i, qty_count: String(Math.round(outCount)) };
          return i;
        }
        if (inpMode === 'kg')  return { ...i, qty_kg:     fmt3(outKg  || outCount) };
        if (inpMode === 'ltr') return { ...i, qty_litres: fmt3(outLtr || outCount) };
        if (inpMode === 'sg')  return { ...i, qty_kg:     fmt3(outKg  || outCount),
                                              qty_litres: fmt3(outLtr || outCount) };
        return i;
      }

      // Bulk consumption row (packed_from set). Same product /
      // material as the output — total drawn from the source batch
      // = total being packed. No pack_size math needed.
      const next = { ...i };
      if (inpMode === 'sg') {
        if (outKg  > 0) next.qty_kg     = fmt3(outKg);
        if (outLtr > 0) next.qty_litres = fmt3(outLtr);
        if (outKg  > 0 && outLtr === 0 && sg > 0) next.qty_litres = fmt3(kgToLtr(outKg,  sg));
        if (outLtr > 0 && outKg  === 0 && sg > 0) next.qty_kg     = fmt3(ltrToKg(outLtr, sg));
      } else if (inpMode === 'kg') {
        if (outKg > 0)                    next.qty_kg = fmt3(outKg);
        else if (outLtr > 0 && sg > 0)    next.qty_kg = fmt3(ltrToKg(outLtr, sg));
      } else if (inpMode === 'ltr') {
        if (outLtr > 0)                   next.qty_litres = fmt3(outLtr);
        else if (outKg > 0 && sg > 0)     next.qty_litres = fmt3(kgToLtr(outKg, sg));
      } else if (inpMode === 'count') {
        next.qty_count = String(Math.round(outCount || 0));
      }
      return next;
    });
  };

  const updateOutput = (outCid, key, value) => {
    setOutputs((prev) => prev.map((o) => {
      if (o.cid !== outCid) return o;
      const next = { ...o, [key]: value };
      if (key === 'product') {
        const p = products.find((pp) => pp.id === value);
        if (p && !next.uom) next.uom = p.uom || '';
        // Sync category to the picked product's category — keeps the
        // filter dropdown in agreement with the selected product.
        if (p && p.category) next.category = p.category;
      }
      if (key === 'category') {
        // If the picked category no longer matches the current
        // product, clear the product so the operator can pick fresh
        // from the narrowed list.
        const picked = products.find((pp) => pp.id === next.product);
        if (value && picked && picked.category !== value) {
          next.product = '';
        }
      }
      // Packing auto-fill — when the operator sets the output's qty
      // on a PACKING entry with a packed-SKU product, walk every
      // input row and pre-fill:
      //   * Bulk (packed_from set): expected qty = out_count × pack_size,
      //     with a KG↔LTR conversion via SG when the input consumes
      //     in a different unit than the pack size.
      //   * Packaging (no packed_from, count-mode): 1:1 with out_count.
      // Runs on ANY output-qty change (qty_count / qty_kg / qty_litres)
      // AND on product/packed_from changes, so late edits stay in sync.
      if (
        header.entry_type === 'PACKING'
        && (['qty_count', 'qty_kg', 'qty_litres', 'product'].includes(key))
      ) {
        const outProduct = productById.get(next.product);
        if (outProduct) {
          next.inputs = autoFillPackingInputRows(next, outProduct);
        }
      }
      return next;
    }));
  };
  // Add a new output. Copies the godown from the previous output so
  // consecutive same-godown outputs are one tap. Operator overrides
  // when they actually shift to a different godown. Batch No is
  // manual — no auto-stamp anymore.
  const addOutput = () => {
    const fresh = newOutput();
    setOutputs((prev) => {
      if (prev.length) {
        const lastGodown = prev[prev.length - 1].godown;
        if (lastGodown) fresh.godown = lastGodown;
      }
      return [...prev, fresh];
    });
  };
  const removeOutput = (outCid) => {
    setOutputs((prev) => prev.length <= 1 ? [newOutput()] : prev.filter((o) => o.cid !== outCid));
    // Drop the collapse flag so a fresh output with the same cid
    // (unlikely but possible) doesn't inherit a stale collapsed state.
    setCollapsedCids((prev) => {
      if (!prev.has(outCid)) return prev;
      const next = new Set(prev);
      next.delete(outCid);
      return next;
    });
    setMaterialsCollapsedCids((prev) => {
      if (!prev.has(outCid)) return prev;
      const next = new Set(prev);
      next.delete(outCid);
      return next;
    });
  };

  // ── Input helpers (scoped to a specific output) ────────────────────
  const updateInput = (outCid, inCid, key, value) => {
    setOutputs((prev) => prev.map((o) => {
      if (o.cid !== outCid) return o;
      const patchedInputs = o.inputs.map((i) => {
        if (i.cid !== inCid) return i;
        const next = { ...i, [key]: value };
        if (key === 'product') {
          const p = products.find((pp) => pp.id === value);
          if (p && !next.uom) next.uom = p.uom || '';
          // Sync category — keeps the row's category filter in
          // agreement with the picked product so it doesn't look
          // stale after a fresh selection.
          if (p && p.category) next.category = p.category;
          // Clear a stale packed_from — picking a new product
          // invalidates any prior source-line selection which
          // was pinned to the old product.
          if (next.packed_from) next.packed_from = '';
        }
        if (key === 'category') {
          const picked = products.find((pp) => pp.id === next.product);
          if (value && picked && picked.category !== value) {
            next.product = '';
            next.batch_no = ''; // batch is product-scoped — reset too
            next.packed_from = '';
          }
        }
        // Selecting a "Packed from" source line pins product +
        // batch_no + uom to the source's own values so the
        // hard-FK + soft batch string can never disagree. When
        // the operator clears the picker, product / batch stay
        // where they were — they can edit freely.
        if (key === 'packed_from' && value) {
          const arr = packableByProduct.get(next.product) || [];
          const src = arr.find((r) => r.line_id === value);
          if (src) {
            next.product = src.product_id || next.product;
            next.batch_no = src.batch_no || '';
            if (!next.uom) next.uom = src.product_uom || '';
            const p = products.find((pp) => pp.id === src.product_id);
            if (p && p.category) next.category = p.category;
          }
        }
        return next;
      });
      const nextOutput = { ...o, inputs: patchedInputs };
      // Re-run the packing auto-fill for this output when the input
      // row change was one that affects the derived qty (picking a
      // product, changing packed_from). Skips on qty-* edits so the
      // operator's manual override isn't clobbered by the auto-fill
      // right after they type it.
      if (
        header.entry_type === 'PACKING'
        && (key === 'product' || key === 'packed_from' || key === 'category')
      ) {
        const outProduct = productById.get(nextOutput.product);
        if (outProduct) {
          nextOutput.inputs = autoFillPackingInputRows(nextOutput, outProduct);
        }
      }
      return nextOutput;
    }));
  };
  const addInput = (outCid) => setOutputs((prev) => prev.map((o) =>
    o.cid !== outCid ? o : { ...o, inputs: [...o.inputs, newInput()] },
  ));
  const removeInput = (outCid, inCid) => setOutputs((prev) => prev.map((o) => {
    if (o.cid !== outCid) return o;
    return { ...o, inputs: o.inputs.length <= 1 ? [newInput()] : o.inputs.filter((i) => i.cid !== inCid) };
  }));

  // Group the flat packable-outputs list by source entry so the
  // header picker offers one row per source (not one per output).
  // Each option label crams the ledger identity + first product +
  // residual qty into one line so the operator picks without
  // hunting through details.
  const packableEntries = useMemo(() => {
    const map = new Map();
    packableByProduct.forEach((rows) => {
      rows.forEach((r) => {
        const existing = map.get(r.entry_id) || {
          entry_id: r.entry_id,
          entry_no: r.entry_no,
          entry_date: r.entry_date,
          outputs: [],
        };
        existing.outputs.push(r);
        map.set(r.entry_id, existing);
      });
    });
    return Array.from(map.values())
      .map((e) => {
        const first = e.outputs[0] || {};
        const rem = [];
        if (Number(first.remaining_kg)    > 0) rem.push(`${Number(first.remaining_kg).toFixed(2)} kg`);
        if (Number(first.remaining_ltr)   > 0) rem.push(`${Number(first.remaining_ltr).toFixed(2)} L`);
        if (Number(first.remaining_count) > 0) rem.push(`${Number(first.remaining_count).toFixed(0)} pcs`);
        const suffix = e.outputs.length > 1 ? ` + ${e.outputs.length - 1} more` : '';
        return {
          ...e,
          label: `${e.entry_no} · ${e.entry_date} · ${first.product_name || 'product'} · ${rem.join(' / ')} left${suffix}`,
        };
      })
      .sort((a, b) => (a.entry_date || '').localeCompare(b.entry_date || ''));
  }, [packableByProduct]);

  // Line IDs already added via the header picker (found on any
  // input row across every output). Used to (a) hide already-picked
  // sources from the dropdown and (b) render the "Added:" chip row
  // so the operator sees at a glance what's been dropped in.
  const pickedSourceLineIds = useMemo(() => {
    const set = new Set();
    outputs.forEach((o) => (o.inputs || []).forEach((i) => {
      if (i.packed_from) set.add(i.packed_from);
    }));
    return set;
  }, [outputs]);

  // Same shape as packableEntries but with entries that have ALL
  // their outputs already added filtered out (nothing left to pick
  // from them). Partially-added entries stay visible because their
  // remaining outputs are still valid picks.
  const packableEntriesAvailable = useMemo(() => (
    packableEntries
      .map((e) => ({
        ...e,
        outputs: e.outputs.filter((o) => !pickedSourceLineIds.has(o.line_id)),
      }))
      .filter((e) => e.outputs.length > 0)
  ), [packableEntries, pickedSourceLineIds]);

  // Flat list of picked source lines (for the chip row) — resolved
  // back to the packableEntries snapshot so the display keeps its
  // entry-no + qty context even after the source is filtered from
  // the dropdown.
  const pickedSourceSummaries = useMemo(() => {
    const map = new Map();
    packableEntries.forEach((e) => e.outputs.forEach((o) => {
      if (pickedSourceLineIds.has(o.line_id)) {
        map.set(o.line_id, { ...o, entry_no: e.entry_no, entry_date: e.entry_date });
      }
    }));
    return Array.from(map.values());
  }, [packableEntries, pickedSourceLineIds]);

  // Bulk-fill: append one INPUT row per source output to Output #1,
  // preserving any existing rows the operator already filled AND
  // skipping any source line that's already been added (defense in
  // depth — the dropdown filters these too, so this only trips on
  // a double-fire). Each pre-filled row carries the packed_from FK
  // so downstream validation and the pack-progress rollup work
  // without further input from the operator.
  const onPickPackingSource = (entryId) => {
    if (!entryId) return;
    const entry = packableEntries.find((e) => e.entry_id === entryId);
    if (!entry) return;
    const productCategoryOfSource = (src) => {
      const p = products.find((pp) => pp.id === src.product_id);
      return p?.category || '';
    };
    const freshSources = entry.outputs.filter((src) => !pickedSourceLineIds.has(src.line_id));
    if (freshSources.length === 0) {
      toast('That source is already added to this entry.');
      return;
    }
    setOutputs((prev) => prev.map((o, idx) => {
      if (idx !== 0) return o;
      const auto = freshSources.map((src) => ({
        ...newInput(),
        category: productCategoryOfSource(src),
        product: src.product_id,
        uom: src.product_uom || '',
        batch_no: src.batch_no || '',
        packed_from: src.line_id,
      }));
      const kept = (o.inputs || []).filter((i) => i.product);
      const patched = { ...o, inputs: [...kept, ...auto] };
      // If the output already has qty set + a packed SKU picked,
      // immediately auto-fill the qty on the freshly-added rows so
      // the operator doesn't need a second click.
      const outProduct = productById.get(patched.product);
      if (outProduct) {
        patched.inputs = autoFillPackingInputRows(patched, outProduct);
      }
      return patched;
    }));
    toast.success(`Added ${freshSources.length} source material line${freshSources.length === 1 ? '' : 's'} to Output #1.`);
  };

  // Remove a picked source (called from the "Added:" chip's × button).
  // Drops every input row across every output whose packed_from
  // matches. Same behaviour as clicking the row's trash icon —
  // shortcut so the operator doesn't have to hunt for the row.
  const onRemovePackingSource = (lineId) => {
    setOutputs((prev) => prev.map((o) => ({
      ...o,
      inputs: (o.inputs || []).filter((i) => i.packed_from !== lineId),
    })).map((o) => (
      // Preserve the "at least one input row" invariant per output.
      (o.inputs || []).length === 0 ? { ...o, inputs: [newInput()] } : o
    )));
  };

  // ── Duplicate-product filter ───────────────────────────────────────
  // Within the same list, hide products already picked in siblings.
  // Output pickers: hide products picked as OTHER outputs.
  // Input pickers: hide products picked as OTHER inputs of the same output.
  // The `category` argument (when non-empty) narrows the list further to
  // just products whose goods_sub_type matches — drives the per-row
  // Category filter on Output and material rows.
  const productsForOutput = (currentCid, category) => {
    const takenIds = new Set(outputs.filter((o) => o.cid !== currentCid && o.product).map((o) => o.product));
    return products.filter((p) => !takenIds.has(p.id) && (!category || p.category === category));
  };
  const productsForInput = (outCid, currentInCid, category) => {
    const out = outputs.find((o) => o.cid === outCid);
    if (!out) return products;
    const takenIds = new Set(out.inputs.filter((i) => i.cid !== currentInCid && i.product).map((i) => i.product));
    return products.filter((p) => !takenIds.has(p.id) && (!category || p.category === category));
  };

  // "Has some quantity" — treats a row as filled if ANY of the three
  // quantity fields (kg / litres / count) is positive.
  const hasQty = (row) => (
    Number(row.qty_kg) > 0 || Number(row.qty_litres) > 0 || Number(row.qty_count) > 0
  );

  // Live balance check — totals inputs vs outputs per unit (kg / ltr
  // / pcs). When BOTH sides use a unit we compute a delta % so the
  // operator sees at a glance whether their entry conserves mass /
  // volume / count. Mixed-unit entries (e.g. kg raw materials →
  // ltr output for an SG-applicable solvent) just show the raw
  // numbers side by side — the delta is meaningless across units.
  //
  // Yield tolerance is intentionally lenient (BALANCE_TOLERANCE_PCT)
  // — chemistry legitimately loses mass to evaporation, so this is
  // a "did the operator typo 60 instead of 600?" catch, not a
  // process-audit tool. Save is never blocked; a warning toast
  // fires when a same-unit delta exceeds tolerance so the operator
  // can double-check before committing.
  const BALANCE_TOLERANCE_PCT = 5;
  const balance = useMemo(() => {
    const totals = {
      kg:  { in: 0, out: 0 },
      ltr: { in: 0, out: 0 },
      pcs: { in: 0, out: 0 },
    };
    outputs.forEach((out) => {
      if (!out.product || !hasQty(out)) return;
      totals.kg.out  += Number(out.qty_kg)     || 0;
      totals.ltr.out += Number(out.qty_litres) || 0;
      totals.pcs.out += Number(out.qty_count)  || 0;
      (out.inputs || []).forEach((inp) => {
        if (!inp.product || !hasQty(inp)) return;
        totals.kg.in  += Number(inp.qty_kg)     || 0;
        totals.ltr.in += Number(inp.qty_litres) || 0;
        totals.pcs.in += Number(inp.qty_count)  || 0;
      });
    });
    return totals;
  }, [outputs]);
  const balanceRows = useMemo(() => (
    [['kg', 'KG'], ['ltr', 'LTR'], ['pcs', 'PCS']]
      .map(([key, label]) => {
        const { in: ins, out: outs } = balance[key];
        if (ins === 0 && outs === 0) return null;
        // Delta only meaningful when both sides have activity.
        // Positive = output exceeds input (impossible unless a
        // second-source input isn't captured); negative = yield loss.
        const delta = (ins > 0 && outs > 0)
          ? ((outs - ins) / ins) * 100
          : null;
        return { key, label, ins, outs, delta };
      })
      .filter(Boolean)
  ), [balance]);
  const hasBalanceActivity = balanceRows.length > 0;
  // Cross-unit transformation detector — a unit bucket with one-sided
  // activity (e.g. 800 LTR in, 0 LTR out) means material crossed unit
  // families: liquid absorbed into a solid product, solids dissolved
  // into a liquid, etc. The other buckets' deltas then can't be read
  // as conservation-of-mass (the KG bucket legitimately gains what the
  // LTR bucket lost), so the red out-of-range treatment is suppressed
  // in favour of a neutral explanation.
  const hasCrossUnitFlow = useMemo(() => (
    balanceRows.length > 1 &&
    balanceRows.some((r) => (r.ins > 0) !== (r.outs > 0))
  ), [balanceRows]);

  // When a raw-material product is picked, auto-select the batch if
  // there's exactly ONE with positive stock at the effective godown.
  // Preserves batch traceability — otherwise the input would save
  // with batch_no='' and the Consumed report would show the material
  // as "unbatched" instead of linking back to the produced batch.
  // Multi-batch products stay blank so the operator makes an explicit
  // FIFO/QC choice.
  const autoPickBatchForInput = (outCid, inCid, productId) => {
    const out = outputs.find((o) => o.cid === outCid);
    if (!out || !productId) {
      updateInput(outCid, inCid, 'batch_no', '');
      return;
    }
    const effectiveGodown = out.godown || header.godown;
    if (!effectiveGodown) {
      updateInput(outCid, inCid, 'batch_no', '');
      return;
    }
    const batches = stockByProductForGodown(effectiveGodown).get(productId) || [];
    const withStock = batches.filter((b) => b.batch_no && (
      Number(b.qty_kg) > 0 || Number(b.qty_litres) > 0 || Number(b.qty_count) > 0
    ));
    updateInput(outCid, inCid, 'batch_no', withStock.length === 1 ? withStock[0].batch_no : '');
  };

  // ── Save / Delete ──────────────────────────────────────────────────
  const validate = () => {
    if (!header.company) return 'Pick a Company.';
    if (!header.warehouse) return 'Pick a Warehouse.';
    const validOutputs = outputs.filter((o) => o.product && hasQty(o));
    if (!validOutputs.length) return 'Add at least one Output with a product and qty.';
    // Godown is now line-level — every real output must pick one.
    const missingGodown = validOutputs.filter((o) => !o.godown);
    if (missingGodown.length) return 'Every output must pick a Godown.';
    // GROUP-mode labor rows need a contractor — that's the payee
    // when the wage-payment settlement fires. HEAD-mode is optional
    // (staff can be paid directly). Empty rows aren't flagged.
    const groupNoContractor = (header.labor_rows || []).filter((r) => {
      const mode = (r.mode || 'HEAD').toUpperCase();
      const filled = (r.label || '').trim() || Number(r.count) > 0 || Number(r.group_total) > 0;
      return filled && mode === 'GROUP' && !r.contractor;
    });
    if (groupNoContractor.length) {
      return 'Every Group-wage labor row needs a Contractor (the payee).';
    }
    return null;
  };

  const handleSave = async () => {
    const err = validate();
    if (err) { toast.error(err); return; }
    // Zero-qty input row check — an input row with a product +
    // batch picked but qty=0 would be silently dropped by the payload
    // filter below (which requires hasQty), and the operator would
    // save without ever consuming the material they picked. Block so
    // the mistake surfaces immediately.
    const zeroQtyRows = [];
    outputs.forEach((o) => (o.inputs || []).forEach((i) => {
      if (!i.product) return;
      if (!i.packed_from && !i.batch_no) return;  // no batch → soft row, skip
      if (hasQty(i)) return;
      const pname = productById.get(i.product)?.product_name || 'material';
      zeroQtyRows.push(`${pname}${i.batch_no ? ` / ${i.batch_no}` : ''}`);
    }));
    if (zeroQtyRows.length) {
      toast.error(
        'These rows are pinned to a batch but have qty=0 — enter a qty or remove them: '
        + zeroQtyRows.join(', ')
      );
      return;
    }

    // Damage-needs-reason check — any non-zero damage_qty must carry
    // a reason so the ADJUSTMENT movement's remarks are meaningful.
    // Otherwise the drill-down modal reads "[DAMAGE-OUT] PE-2026-…"
    // with no explanation and a reviewer six months out has to guess.
    const damageNoReason = [];
    const damageOn = (r) => (
      Number(r.damage_qty_kg) > 0
      || Number(r.damage_qty_litres) > 0
      || Number(r.damage_qty_count) > 0
    );
    outputs.forEach((o) => {
      if (o.product && damageOn(o) && !(o.damage_reason || '').trim()) {
        const pname = productById.get(o.product)?.product_name || 'output';
        damageNoReason.push(`${pname} (production damage)`);
      }
      (o.inputs || []).forEach((i) => {
        if (i.product && damageOn(i) && !(i.damage_reason || '').trim()) {
          const pname = productById.get(i.product)?.product_name || 'material';
          damageNoReason.push(`${pname} (packing damage)`);
        }
      });
    });
    if (damageNoReason.length) {
      toast.error(
        'Damage recorded without a reason on: ' + damageNoReason.join(', ')
        + '. Enter a short reason (spillage, mis-print, etc.).'
      );
      return;
    }

    // Client-side over-pack gate. Walks every input row that names
    // a batch (via packed_from or manual batch_no) and compares the
    // typed qty to the ledger balance the row already surfaces in
    // the STOCK cell. Blocks Save so the operator doesn't round-trip
    // to hit the backend's identical guard.
    const overPackErrs = [];
    outputs.forEach((o) => (o.inputs || []).forEach((i) => {
      if (!i.product) return;
      if (!i.packed_from && !i.batch_no) return;  // unknown ceiling — server-side gate handles
      // Reconstruct the same stockRow lookup the row render uses so
      // this check matches what the operator sees on-screen.
      let stk = null;
      if (i.packed_from) {
        const src = (packableByProduct.get(i.product) || [])
          .find((r) => r.line_id === i.packed_from);
        if (src) stk = {
          qty_kg:     Number(src.remaining_kg    || 0),
          qty_litres: Number(src.remaining_ltr   || 0),
          qty_count:  Number(src.remaining_count || 0),
        };
      }
      if (!stk) {
        const effGd = o.godown || header.godown;
        const bList = stockByProductForGodown(effGd).get(i.product) || [];
        const b = bList.find((bb) => bb.batch_no === i.batch_no);
        if (b) stk = { qty_kg: b.qty_kg, qty_litres: b.qty_litres, qty_count: b.qty_count };
      }
      if (!stk) return;
      const pname = productById.get(i.product)?.product_name || 'product';
      const bLbl = i.batch_no ? ` / batch ${i.batch_no}` : '';
      if (Number(i.qty_kg     || 0) > Number(stk.qty_kg     || 0)) {
        overPackErrs.push(`${pname}${bLbl}: ${i.qty_kg} kg > ${Number(stk.qty_kg).toFixed(3)} kg available`);
      }
      if (Number(i.qty_litres || 0) > Number(stk.qty_litres || 0)) {
        overPackErrs.push(`${pname}${bLbl}: ${i.qty_litres} L > ${Number(stk.qty_litres).toFixed(3)} L available`);
      }
      if (Number(i.qty_count  || 0) > Number(stk.qty_count  || 0)) {
        overPackErrs.push(`${pname}${bLbl}: ${i.qty_count} pcs > ${Number(stk.qty_count).toFixed(0)} pcs available`);
      }
    }));
    if (overPackErrs.length) {
      toast.error('Fix the highlighted over-consumption first: ' + overPackErrs.join(' | '));
      return;
    }
    // Soft balance warning — never blocks. Fires once per save with
    // the affected units listed so the operator knows what to check.
    // Deliberately toast.warning-style (not error) since chemistry
    // legitimately loses mass to evaporation and the operator has
    // full authority to save regardless.
    const oor = balanceRows.filter((r) => r.delta != null && Math.abs(r.delta) > BALANCE_TOLERANCE_PCT);
    if (oor.length && !hasCrossUnitFlow) {
      toast(
        `Balance is off by more than ${BALANCE_TOLERANCE_PCT}% on: ` +
        oor.map((r) => `${r.label} (${r.delta > 0 ? '+' : ''}${r.delta.toFixed(1)}%)`).join(', ') +
        '. Saving anyway.',
        { icon: '⚠️' },
      );
    }
    setSaving(true);
    try {
      // Build the nested payload the backend expects.
      const outputsPayload = outputs
        .filter((o) => o.product && hasQty(o))
        .map((o) => ({
          product: o.product,
          godown: o.godown,  // required — validated above
          qty_kg: Number(o.qty_kg) || 0,
          qty_litres: Number(o.qty_litres) || 0,
          qty_count: Number(o.qty_count) || 0,
          uom: o.uom || '',
          batch_no: o.batch_no || '',
          remarks: o.remarks || '',
          damage_qty_kg:     Number(o.damage_qty_kg)     || 0,
          damage_qty_litres: Number(o.damage_qty_litres) || 0,
          damage_qty_count:  Number(o.damage_qty_count)  || 0,
          damage_reason:     (o.damage_reason || '').trim(),
          inputs: (o.inputs || [])
            .filter((i) => i.product && hasQty(i))
            .map((i) => ({
              product: i.product,
              qty_kg: Number(i.qty_kg) || 0,
              qty_litres: Number(i.qty_litres) || 0,
              qty_count: Number(i.qty_count) || 0,
              uom: i.uom || '',
              batch_no: (i.batch_no || '').trim(),
              remarks: i.remarks || '',
              // Hard link to the source OUTPUT line — omit when the
              // operator picked product/batch manually so the payload
              // stays lean and the serializer doesn't need to resolve
              // a non-existent FK.
              packed_from: i.packed_from || null,
              damage_qty_kg:     Number(i.damage_qty_kg)     || 0,
              damage_qty_litres: Number(i.damage_qty_litres) || 0,
              damage_qty_count:  Number(i.damage_qty_count)  || 0,
              damage_reason:     (i.damage_reason || '').trim(),
            })),
        }));
      const payload = { ...header, outputs: outputsPayload };
      // Header godown was removed from the UI — line-level godown on
      // each output is the source of truth. The backend serializer
      // auto-populates entry.godown from the first output's godown
      // during validate(), but only when it isn't already set;
      // DRF's PrimaryKeyRelatedField rejects `''` as "may not be
      // null" BEFORE validate() runs, so we drop the empty header
      // field entirely instead of sending an empty string.
      if (!payload.godown) delete payload.godown;
      // Strip the client-only `cid` from each labor row and drop
      // rows that would be pure noise (no label AND no count AND no
      // group-total). Persist the wage mode + only the fields that
      // apply — a HEAD row saves count/rate; a GROUP row saves
      // count (for headcount) + group_total; the unused wage field
      // is zeroed so a mode switch doesn't leave stale data behind.
      payload.labor_rows = (payload.labor_rows || [])
        .filter((r) => (
          (r.label || '').trim()
          || Number(r.count) > 0
          || Number(r.group_total) > 0
          || Number(r.qty) > 0
        ))
        .map((r) => {
          const mode = (r.mode || 'HEAD').toUpperCase();
          return {
            label: (r.label || '').trim(),
            mode,
            count: Number(r.count) || 0,
            rate: mode === 'GROUP' ? 0 : (Number(r.rate) || 0),
            group_total: mode === 'GROUP' ? (Number(r.group_total) || 0) : 0,
            // Piece-rate fields — only meaningful for PIECE mode.
            // Zeroed for HEAD / GROUP so the ledger's row totals
            // don't accidentally pick up stale values from a mode
            // switch mid-edit.
            qty: mode === 'PIECE' ? (Number(r.qty) || 0) : 0,
            qty_uom: mode === 'PIECE' ? (r.qty_uom || 'MTS') : '',
            contractor: r.contractor || null,
          };
        });
      if (isEdit) {
        await apiClient.patch(`/api/inventory/production-entries/${id}/`, payload);
        toast.success('Production entry updated.');
      } else {
        const res = await apiClient.post('/api/inventory/production-entries/', payload);
        toast.success(`Saved as ${res.data?.entry_no || 'production entry'}.`);
      }
      // Save landed — drop the draft so the next "New" form starts
      // clean instead of offering to restore work that's already
      // committed. Happens AFTER navigate would leave, but clearing
      // is synchronous localStorage so it completes fine.
      draft.clear();
      navigate('/inventory/production-entries');
    } catch (er) {
      toast.error(getApiErrorMessage(er));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: `Remove ${entryNo}? Its stock movements will be reversed.` }))) return;
    try {
      await apiClient.delete(`/api/inventory/production-entries/${id}/`);
      toast.success('Removed.');
      navigate('/inventory/production-entries');
    } catch (er) {
      toast.error(getApiErrorMessage(er));
    }
  };

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <MainLayout>
      <PageHeader
        title={isEdit ? `Production Entry ${entryNo || ''}` : 'New Production Entry'}
        subtitle="Each Output records the product produced and the raw materials consumed to make it"
        breadcrumbs={[
          { label: 'Inventory' },
          { label: 'Production Entries', href: '/inventory/production-entries' },
          { label: isEdit ? (entryNo || 'Edit') : 'New' },
        ]}
      />

      {loading ? (
        <div className="text-center py-12"><Loader2 className="inline animate-spin" size={22} /></div>
      ) : (
        <>
          {/* Draft-restore banner — only shown when a persisted draft
              was found on mount. Operator explicitly picks Restore or
              Discard; the hook never auto-populates. Silently gone
              after either action; also cleared on successful Save. */}
          {draft.hasDraft && (
            <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3">
              <div className="flex flex-col sm:flex-row items-start gap-2 sm:gap-3">
                <div className="flex items-start gap-2 flex-1 min-w-0">
                  <span className="mt-0.5 text-amber-600 shrink-0" aria-hidden="true">📝</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-amber-900">
                      Unsaved draft found — from {draft.draftAge}
                    </div>
                    <div className="text-xs text-amber-800/90 mt-0.5">
                      Looks like you started filling this form earlier and didn't
                      finish. Restore to pick up where you left off, or discard
                      to start fresh.
                    </div>
                  </div>
                </div>
                {/* Button pair — stacks full-width under text on mobile,
                    sits inline on the right on ≥sm screens. Both buttons
                    grow to equal width on phones for easy tap targets. */}
                <div className="flex items-center gap-2 w-full sm:w-auto sm:shrink-0">
                  <button
                    type="button"
                    onClick={draft.discard}
                    className="flex-1 sm:flex-none px-3 py-1.5 text-xs font-medium text-amber-900 bg-white border border-amber-300 rounded-md hover:bg-amber-100"
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    onClick={draft.restore}
                    className="flex-1 sm:flex-none px-3 py-1.5 text-xs font-medium text-white bg-amber-600 border border-amber-700 rounded-md hover:bg-amber-700"
                  >
                    Restore draft
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Live draft-saved indicator. Shows only when the hook is
              enabled AND a save has actually landed since mount, so
              the operator gets tangible confirmation that their work
              is being persisted (no more "did it save?" anxiety).
              Manual "Save now" button lets them force a write right
              before an intentional refresh. */}
          {draft.enabled && (draft.lastSavedAt > 0 || draft.hasDraft) && (
            <div className="mb-3 flex items-center justify-end gap-2 text-[11px] text-slate-500">
              <span className="inline-flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block"></span>
                {draft.lastSavedAt > 0
                  ? <>Draft saved <span className="tabular-nums">{draft.lastSavedAgo}</span></>
                  : <>Draft ready</>}
              </span>
              <button
                type="button"
                onClick={() => {
                  draft.saveNow();
                  // Visible confirmation — the chip already updates
                  // silently, but a toast is what the operator's eye
                  // catches at this size.
                  toast.success('Draft saved to this browser.', { duration: 2000 });
                }}
                className="text-primary-600 hover:text-primary-800 hover:underline"
                title="Force-save the current form state to your browser's local storage"
              >
                Save now
              </button>
            </div>
          )}

          {/* Header — 2 cols on mobile, 5 cols on desktop (Date, Type,
              Company, Warehouse, Godown). Remarks always full width. */}
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6 mb-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Header</h3>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="min-w-0">
                <label className={labelClass}>Date <span className="text-red-500">*</span></label>
                <CustomDatePicker value={header.entry_date} onChange={(v) => setHeaderField('entry_date', v)} disabled={!editable} />
              </div>
              <div className="min-w-0">
                <label className={labelClass}>Company <span className="text-red-500">*</span></label>
                <CustomSelect
                  value={header.company}
                  onChange={(e) => { setHeaderField('company', e.target.value); setHeaderField('warehouse', ''); setHeaderField('godown', ''); }}
                  disabled={!editable}
                >
                  <option value="">Pick company…</option>
                  {companies.map((c) => (<option key={c.value} value={c.value}>{c.label}</option>))}
                </CustomSelect>
              </div>
              <div className="min-w-0">
                <label className={labelClass}>Warehouse <span className="text-red-500">*</span></label>
                <CustomSelect
                  value={header.warehouse}
                  onChange={(e) => { setHeaderField('warehouse', e.target.value); setHeaderField('godown', ''); }}
                  disabled={!editable || !header.company}
                >
                  <option value="">Pick warehouse…</option>
                  {warehouses.map((w) => (<option key={w.value} value={w.value}>{w.label}</option>))}
                </CustomSelect>
              </div>
              {/* Type sits AFTER Warehouse — the PACKING option only
                  makes sense once the operator has committed to a
                  warehouse (the backend gate blocks PACKING at any
                  warehouse other than TVP-SS). Ordering Warehouse
                  first lets the operator see whether packing is even
                  a valid choice, and the Packing-source picker below
                  flows naturally out of Type. */}
              <div className="min-w-0">
                <label className={labelClass}>Type <span className="text-red-500">*</span></label>
                <CustomSelect
                  value={header.entry_type}
                  onChange={(e) => setHeaderField('entry_type', e.target.value)}
                  disabled={!editable}
                >
                  <option value="PRODUCTION">Production</option>
                  <option value="PACKING">Packing</option>
                </CustomSelect>
              </div>
              {/* Godown moved to each Output card — no header default
                  needed. The output picker remembers your last choice
                  so consecutive outputs at the same godown are one tap. */}
              {/* Packing stage — TVP-SS only. Every packing session
                  at TVP-SS covers ONE physical stage; the DPR sheet
                  already tracks it via the Remark column values
                  (filling only / Label,box / Completed). Non-TVP
                  packing runs the whole flow in one shot so this
                  picker stays hidden; MIXED is the implicit default
                  posted from those forms. */}
              {header.entry_type === 'PACKING' && (() => {
                const warehouseName = (warehouses.find((w) => w.value === header.warehouse) || {}).label || '';
                const isTvp = warehouseName.trim().toUpperCase() === 'TVP-SS';
                if (!isTvp) return null;
                return (
                  <div className="min-w-0 col-span-2 lg:col-span-4">
                    <label className={labelClass}>
                      Packing stage <span className="text-red-500">*</span>
                      <span className="text-slate-400 font-normal ml-1">
                        — which physical step this session covered
                      </span>
                    </label>
                    <CustomSelect
                      value={header.packing_stage}
                      onChange={(e) => setHeaderField('packing_stage', e.target.value)}
                      disabled={!editable}
                    >
                      <option value="">Pick stage…</option>
                      <option value="FILLING">Filling — bulk into pouches / bottles</option>
                      <option value="LABELING">Labeling — labels applied</option>
                      <option value="BOXING">Boxing — packed into outer boxes</option>
                      <option value="PELLETING">Pelleting — grouped onto pallets</option>
                      <option value="MIXED">Mixed — all stages in one session</option>
                      <option value="COMPLETED">Completed — final QC sign-off</option>
                    </CustomSelect>
                  </div>
                );
              })()}
              {/* Packing source — visible only when Type=Packing AND
                  warehouse is picked. Bulk-fills the first output's
                  material list with one INPUT row per residual OUTPUT
                  of the picked source production entry (packed_from
                  FK + product + batch pre-filled). Solves the
                  "no field for production reference" gap. */}
              {header.entry_type === 'PACKING' && header.warehouse && (
                <div className="min-w-0 col-span-2 lg:col-span-4">
                  <label className={labelClass}>
                    Packing source
                    <span className="text-slate-400 font-normal ml-1">
                      — pick a production entry; the bulk material rows
                      auto-fill under Output #1
                    </span>
                  </label>
                  <CustomSelect
                    value=""
                    onChange={(e) => onPickPackingSource(e.target.value)}
                    disabled={!editable || packableLoading}
                  >
                    <option value="">
                      {packableLoading
                        ? 'Loading source production entries…'
                        : packableEntries.length === 0
                          ? '— no production entries with residual stock at this warehouse —'
                          : packableEntriesAvailable.length === 0
                            ? '— all available sources already added —'
                            : 'Pick source production entry to add…'}
                    </option>
                    {packableEntriesAvailable.map((e) => {
                      // Re-compute the label from the FILTERED outputs
                      // so a partially-added source shows what's left
                      // to pick, not the original entry-wide roll-up.
                      const first = e.outputs[0] || {};
                      const rem = [];
                      if (Number(first.remaining_kg)    > 0) rem.push(`${Number(first.remaining_kg).toFixed(2)} kg`);
                      if (Number(first.remaining_ltr)   > 0) rem.push(`${Number(first.remaining_ltr).toFixed(2)} L`);
                      if (Number(first.remaining_count) > 0) rem.push(`${Number(first.remaining_count).toFixed(0)} pcs`);
                      const suffix = e.outputs.length > 1 ? ` + ${e.outputs.length - 1} more` : '';
                      const label = `${e.entry_no} · ${e.entry_date} · ${first.product_name || 'product'} · ${rem.join(' / ')} left${suffix}`;
                      return (
                        <option key={e.entry_id} value={e.entry_id}>{label}</option>
                      );
                    })}
                  </CustomSelect>
                  {pickedSourceSummaries.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <span className="text-[10px] uppercase tracking-wide text-slate-500 self-center mr-0.5">
                        Added:
                      </span>
                      {pickedSourceSummaries.map((s) => (
                        <span
                          key={s.line_id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-primary-50 text-primary-800 border border-primary-200"
                        >
                          <span className="font-mono">{s.entry_no}</span>
                          <span className="text-primary-500">·</span>
                          <span>{s.product_name}</span>
                          {s.batch_no && (
                            <>
                              <span className="text-primary-500">·</span>
                              <span className="font-mono">{s.batch_no}</span>
                            </>
                          )}
                          {editable && (
                            <button
                              type="button"
                              onClick={() => onRemovePackingSource(s.line_id)}
                              className="ml-0.5 text-primary-500 hover:text-primary-800"
                              title="Remove this source (drops its material row)"
                            >
                              ×
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="min-w-0 col-span-2 lg:col-span-4">
                <label className={labelClass}>Remarks</label>
                <input
                  type="text" className={inputClass} value={header.remarks}
                  onChange={(e) => setHeaderField('remarks', e.target.value)}
                  placeholder="Optional note" disabled={!editable}
                />
              </div>
            </div>
          </div>

          {/* Labor block — optional, per-batch labor cost. Collapsed by
              default; expanded automatically when editing an entry with
              any recorded headcount. Doesn't touch Production Stock —
              labor isn't stock; this just captures cost per batch. */}
          <div className="bg-white rounded-lg border border-slate-200 mb-4">
            <button
              type="button"
              onClick={() => setLaborOpen((v) => !v)}
              className="w-full px-3 sm:px-6 py-3 flex items-center gap-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              aria-expanded={laborOpen}
            >
              {laborOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <Users size={16} className="text-slate-500" />
              <span>Labor (optional)</span>
              <span className="ml-auto text-xs font-normal text-slate-500">
                {laborHeadcount > 0 ? (
                  <>
                    {laborHeadcount} persons
                    {' · '}
                    ₹{laborTotal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                  </>
                ) : 'None recorded'}
              </span>
            </button>
            {laborOpen && (
              <div className="p-3 sm:p-6 border-t border-slate-200">
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                        <th className="px-2 py-1.5">Category / Description</th>
                        <th className="px-2 py-1.5 w-32">Mode</th>
                        <th className="px-2 py-1.5 text-right w-32">Persons / Qty</th>
                        <th className="px-2 py-1.5 text-right w-40">Wage / Rate</th>
                        <th className="px-2 py-1.5 w-48">Contractor</th>
                        <th className="px-2 py-1.5 text-right w-32">Total (₹)</th>
                        <th className="px-2 py-1.5 w-10"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {header.labor_rows.length === 0 && (
                        <tr>
                          <td colSpan={7} className="px-2 py-4 text-center text-xs text-slate-400">
                            No labor rows yet. Click <span className="font-medium">+ Add labor row</span> to record a category.
                          </td>
                        </tr>
                      )}
                      {header.labor_rows.map((row) => {
                        const mode = (row.mode || 'HEAD').toUpperCase();
                        const total = laborRowTotal(row);
                        return (
                          <tr key={row.cid} className="border-t border-slate-100">
                            <td className="px-2 py-1.5 min-w-0">
                              <CreatableSelect
                                className={inputClass}
                                value={row.label}
                                onChange={(e) => updateLaborRow(row.cid, 'label', e.target.value)}
                                options={effectiveLaborCategories}
                                disabled={!editable}
                                placeholder="Pick or type — e.g. Loading helpers, Tamil workers, Supervisor"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <CustomSelect
                                value={mode}
                                onChange={(e) => updateLaborRow(row.cid, 'mode', e.target.value)}
                                disabled={!editable}
                              >
                                <option value="HEAD">Per head</option>
                                <option value="GROUP">Group</option>
                                <option value="PIECE">Per unit (MT / NOS / BAG)</option>
                              </CustomSelect>
                            </td>
                            {/* Count column doubles as the "qty" input
                                for PIECE mode — labelled MTS by default
                                (Cake Expeller 60.4 MTs) with a small
                                inline UOM picker so a bag / nos contract
                                still fits. HEAD / GROUP rows keep count
                                as headcount. */}
                            <td className="px-2 py-1.5">
                              {mode === 'PIECE' ? (
                                <div className="flex items-center gap-1">
                                  <input type="number" min="0" step="0.001" className={numClass}
                                    value={row.qty}
                                    onChange={(e) => updateLaborRow(row.cid, 'qty', e.target.value)}
                                    disabled={!editable} placeholder="0.000"
                                    title="Units processed (e.g. 60.4 MTs)" />
                                  <select
                                    value={row.qty_uom || 'MTS'}
                                    onChange={(e) => updateLaborRow(row.cid, 'qty_uom', e.target.value)}
                                    disabled={!editable}
                                    className="text-[10px] px-1 py-1 border border-slate-300 rounded bg-white"
                                    title="Unit for the piece rate"
                                  >
                                    <option value="MTS">MTS</option>
                                    <option value="KG">KG</option>
                                    <option value="LTR">LTR</option>
                                    <option value="NOS">NOS</option>
                                    <option value="BAG">BAG</option>
                                    <option value="PCS">PCS</option>
                                  </select>
                                </div>
                              ) : (
                                <input type="number" min="0" step="1" className={numClass}
                                  value={row.count}
                                  onChange={(e) => updateLaborRow(row.cid, 'count', e.target.value)}
                                  disabled={!editable} placeholder="0"
                                  title={mode === 'GROUP' ? 'Headcount for reporting; wage still paid as the group total' : 'Persons in this group'} />
                              )}
                            </td>
                            <td className="px-2 py-1.5">
                              {mode === 'GROUP' ? (
                                <div className="relative">
                                  <input type="number" min="0" step="0.01" className={numClass + ' pl-6'}
                                    value={row.group_total}
                                    onChange={(e) => updateLaborRow(row.cid, 'group_total', e.target.value)}
                                    disabled={!editable} placeholder="0.00"
                                    title="Flat wage paid to the whole group" />
                                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-500 pointer-events-none">₹</span>
                                </div>
                              ) : mode === 'PIECE' ? (
                                <div className="relative">
                                  <input type="number" min="0" step="0.01" className={numClass + ' pl-6 pr-12'}
                                    value={row.rate}
                                    onChange={(e) => updateLaborRow(row.cid, 'rate', e.target.value)}
                                    disabled={!editable} placeholder="0.00"
                                    title={`Rate per ${row.qty_uom || 'MT'}`} />
                                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-500 pointer-events-none">₹</span>
                                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-slate-500 pointer-events-none">/{row.qty_uom || 'MT'}</span>
                                </div>
                              ) : (
                                <div className="relative">
                                  <input type="number" min="0" step="0.01" className={numClass + ' pr-14'}
                                    value={row.rate}
                                    onChange={(e) => updateLaborRow(row.cid, 'rate', e.target.value)}
                                    disabled={!editable} placeholder="0.00" />
                                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-slate-500 pointer-events-none">/person</span>
                                </div>
                              )}
                            </td>
                            <td className="px-2 py-1.5 min-w-0">
                              <CustomSelect
                                value={row.contractor || ''}
                                onChange={(e) => updateLaborRow(row.cid, 'contractor', e.target.value)}
                                disabled={!editable}
                              >
                                <option value="">
                                  {mode === 'GROUP' ? 'Required — pick contractor…' : 'Optional'}
                                </option>
                                {vendorOptions.map((v) => (
                                  <option key={v.value} value={v.value}>{v.label}</option>
                                ))}
                              </CustomSelect>
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums font-medium text-slate-800">
                              {total > 0 ? `₹${total.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : <span className="text-slate-300">—</span>}
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              {editable && (
                                <button
                                  type="button"
                                  onClick={() => removeLaborRow(row.cid)}
                                  className="p-1 text-red-500 hover:bg-red-50 rounded"
                                  title="Remove this labor row"
                                >
                                  <Trash2 size={14} />
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    {header.labor_rows.length > 0 && (
                      <tfoot>
                        <tr className="border-t-2 border-slate-200 bg-slate-50">
                          <td className="px-2 py-2 font-semibold text-slate-700">Grand Total</td>
                          <td />
                          <td className="px-2 py-2 text-right tabular-nums font-semibold">
                            {laborHeadcount}
                          </td>
                          <td />
                          <td />
                          <td className="px-2 py-2 text-right tabular-nums font-semibold text-slate-800">
                            ₹{laborTotal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                          </td>
                          <td />
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
                {editable && (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={addLaborRow}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
                    >
                      <Plus size={12} /> Add labor row
                    </button>
                  </div>
                )}
                <div className="mt-3">
                  <label className={labelClass}>Labor remarks</label>
                  <input type="text" className={inputClass}
                    value={header.labor_remarks}
                    onChange={(e) => setHeaderField('labor_remarks', e.target.value)}
                    placeholder="Optional — e.g. Half day, wood-shifting also, one T.L on leave"
                    disabled={!editable} />
                </div>
              </div>
            )}
          </div>

          {/* Quick collapse / expand-all toggle when there's more than
              one output card open. Keeps entries with many outputs
              scannable on a phone. */}
          {outputs.length > 1 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              <button
                onClick={collapseAll}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200"
              >
                <ChevronRight size={12} /> Collapse all
              </button>
              <button
                onClick={expandAll}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200"
              >
                <ChevronDown size={12} /> Expand all
              </button>
            </div>
          )}
          {/* Output blocks — each one holds its own inputs */}
          {outputs.map((out, oIdx) => {
            const availOutputProducts = productsForOutput(out.cid, out.category);
            const collapsed = isCollapsed(out.cid);
            // Compact summary line for the collapsed state. Falls back
            // to gentle prompts when the output is still empty.
            const summaryProduct =
              products.find((p) => p.id === out.product)?.product_name || 'Product not picked';
            const summaryQty = (() => {
              const kg = Number(out.qty_kg) || 0;
              const lt = Number(out.qty_litres) || 0;
              const ct = Number(out.qty_count) || 0;
              const parts = [];
              if (kg > 0) parts.push(`${kg.toLocaleString('en-IN', { maximumFractionDigits: 3 })} KG`);
              if (lt > 0) parts.push(`${lt.toLocaleString('en-IN', { maximumFractionDigits: 3 })} LTR`);
              if (ct > 0) parts.push(`${ct.toLocaleString('en-IN', { maximumFractionDigits: 0 })} PCS`);
              return parts.join(' · ') || 'no qty';
            })();
            const materialsCount = out.inputs.filter((i) => i.product).length;
            // Godown name for the collapsed summary — the picked one,
            // or the header default if the operator didn't override.
            const effGodownId = out.godown || header.godown;
            const effGodownName = godowns.find((g) => g.value === effGodownId)?.label || '';
            return (
              <div key={out.cid} className="bg-white rounded-lg border border-slate-200 mb-4">
                {/* Header row — always visible. Contains the collapse
                    chevron and (when collapsed) a compact summary of
                    what this output holds so operators can scan a
                    long entry at a glance. */}
                <div className="px-3 py-3 border-b border-slate-200 bg-blue-50">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleCollapse(out.cid)}
                      className="p-0.5 text-blue-700 hover:bg-blue-100 rounded"
                      title={collapsed ? 'Expand output' : 'Collapse output'}
                      aria-expanded={!collapsed}
                    >
                      {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                    </button>
                    <ArrowUpRight size={16} className="text-blue-700 shrink-0" />
                    <span className="text-sm font-semibold text-blue-800 shrink-0">Output #{oIdx + 1}</span>
                    {collapsed && (
                      <span className="text-xs text-slate-600 truncate">
                        · <span className="font-medium">{summaryProduct}</span>
                        {' · '}{summaryQty}
                        {effGodownName ? ` · @ ${effGodownName}` : ''}
                        {' · '}{materialsCount} material{materialsCount === 1 ? '' : 's'}
                        {out.batch_no ? ` · ${out.batch_no}` : ''}
                      </span>
                    )}
                    {!collapsed && (
                      <span className="text-sm text-blue-800 hidden sm:inline">— what was produced</span>
                    )}
                    {editable && outputs.length > 1 && (
                      <button
                        onClick={() => removeOutput(out.cid)}
                        className="ml-auto p-1.5 text-red-600 hover:bg-red-100 rounded"
                        title="Remove this output (and its input rows)"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                  {!collapsed && (
                  <div className="mt-2 grid grid-cols-2 lg:grid-cols-6 gap-2 lg:gap-3">
                    <div className="min-w-0 lg:col-span-2">
                      <label className={labelClass}>Godown <span className="text-red-500">*</span></label>
                      <CustomSelect
                        value={out.godown}
                        onChange={(e) => updateOutput(out.cid, 'godown', e.target.value)}
                        disabled={!editable || !header.warehouse}
                      >
                        <option value="">{header.warehouse ? 'Pick godown…' : 'Pick warehouse first'}</option>
                        {godowns.map((g) => (<option key={g.value} value={g.value}>{g.label}</option>))}
                      </CustomSelect>
                    </div>
                    <div className="min-w-0">
                      <label className={labelClass}>Category</label>
                      <CustomSelect
                        value={out.category}
                        onChange={(e) => updateOutput(out.cid, 'category', e.target.value)}
                        disabled={!editable}
                      >
                        <option value="">Pick…</option>
                        {OUTPUT_CATEGORIES.map((c) => (
                          <option key={c.value} value={c.value}>{c.label}</option>
                        ))}
                      </CustomSelect>
                    </div>
                    {/* Product takes the whole mobile row (col-span-2)
                        so the long name isn't crammed next to the Qty
                        input; on desktop it still shares row 1 with
                        Godown + Category (lg:col-span-3). Qty + UOM
                        naturally sit together on the next mobile row. */}
                    <div className="min-w-0 col-span-2 lg:col-span-3">
                      <label className={labelClass}>Product</label>
                      <CustomSelect
                        value={out.product}
                        onChange={(e) => updateOutput(out.cid, 'product', e.target.value)}
                        disabled={!editable}
                      >
                        <option value="">Pick product…</option>
                        {availOutputProducts.map((p) => {
                          const label = `${p.product_name}${p.sku_code ? ` (${p.sku_code})` : ''}${p.sg_applicable ? ' • SG' : ''}`;
                          return (<option key={p.id} value={p.id}>{label}</option>);
                        })}
                      </CustomSelect>
                    </div>
                    {(() => {
                      const outProduct = out.product ? productById.get(out.product) : null;
                      const outMode = resolveQtyMode(outProduct);
                      // Qty inputs on the OUTPUT row honour the picked UOM
                      // the same way the input rows do — typing 7 with
                      // UOM=MTS stores 7000 kg (not 7 kg). Label updates
                      // live so the operator always sees what unit their
                      // number is being interpreted as.
                      if (outMode === 'sg') {
                        return (
                          <>
                            <div className="min-w-0">
                              <label className={labelClass}>Qty ({kgSuffix(out.uom)})</label>
                              <input type="number" step="0.001" min="0" className={numClass}
                                value={displayFromKg(out.qty_kg, out.uom)}
                                onChange={(e) => updateOutput(out.cid, 'qty_kg', kgFromDisplay(e.target.value, out.uom))}
                                disabled={!editable} placeholder="0.000" />
                            </div>
                            <div className="min-w-0">
                              <label className={labelClass}>Qty ({ltrSuffix(out.uom)})</label>
                              <input type="number" step="0.001" min="0" className={numClass}
                                value={displayFromLtr(out.qty_litres, out.uom)}
                                onChange={(e) => updateOutput(out.cid, 'qty_litres', ltrFromDisplay(e.target.value, out.uom))}
                                disabled={!editable} placeholder="0.000" />
                            </div>
                          </>
                        );
                      }
                      if (outMode === 'ltr') {
                        return (
                          <div className="min-w-0">
                            <label className={labelClass}>Qty ({ltrSuffix(out.uom)})</label>
                            <input type="number" step="0.001" min="0" className={numClass}
                              value={displayFromLtr(out.qty_litres, out.uom)}
                              onChange={(e) => updateOutput(out.cid, 'qty_litres', ltrFromDisplay(e.target.value, out.uom))}
                              disabled={!editable} placeholder="0.000" />
                          </div>
                        );
                      }
                      if (outMode === 'count') {
                        return (
                          <div className="min-w-0">
                            <label className={labelClass}>Qty ({out.uom || 'PCS'})</label>
                            <input type="number" step="1" min="0" className={numClass}
                              value={out.qty_count} onChange={(e) => updateOutput(out.cid, 'qty_count', e.target.value)}
                              disabled={!editable} placeholder="0" />
                          </div>
                        );
                      }
                      // Default: 'kg' (weight-family UOMs — KG/MTS/GM)
                      return (
                        <div className="min-w-0">
                          <label className={labelClass}>Qty ({kgSuffix(out.uom)})</label>
                          <input type="number" step="0.001" min="0" className={numClass}
                            value={displayFromKg(out.qty_kg, out.uom)}
                            onChange={(e) => updateOutput(out.cid, 'qty_kg', kgFromDisplay(e.target.value, out.uom))}
                            disabled={!editable} placeholder="0.000" />
                        </div>
                      );
                    })()}
                    <div className="min-w-0">
                      <label className={labelClass}>UOM</label>
                      <CustomSelect
                        value={out.uom}
                        onChange={(e) => updateOutput(out.cid, 'uom', e.target.value)}
                        disabled={!editable}
                      >
                        <option value="">Pick UOM…</option>
                        {uomOptionsWith(out.uom).map((u) => (<option key={u} value={u}>{u}</option>))}
                      </CustomSelect>
                    </div>
                    {/* Damage — sits right next to Qty since the two
                        are read together. Same UOM as the qty input.
                        Non-zero damage posts an OUT ADJUSTMENT on save
                        (reason = the row's Remarks below). */}
                    {(() => {
                      const outProduct = out.product ? productById.get(out.product) : null;
                      const outMode = resolveQtyMode(outProduct);
                      const cls = `${numClass} border-amber-300 bg-amber-50/50 focus:ring-amber-400 focus:border-amber-500`;
                      if (outMode === 'sg') {
                        return (
                          <>
                            <div className="min-w-0">
                              <label className={labelClass}>⚠ Damage ({kgSuffix(out.uom)})</label>
                              <input type="number" step="0.001" min="0" className={cls}
                                value={displayFromKg(out.damage_qty_kg, out.uom)}
                                onChange={(e) => updateOutput(out.cid, 'damage_qty_kg', kgFromDisplay(e.target.value, out.uom))}
                                disabled={!editable} placeholder="0.000" />
                            </div>
                            <div className="min-w-0">
                              <label className={labelClass}>⚠ Damage ({ltrSuffix(out.uom)})</label>
                              <input type="number" step="0.001" min="0" className={cls}
                                value={displayFromLtr(out.damage_qty_litres, out.uom)}
                                onChange={(e) => updateOutput(out.cid, 'damage_qty_litres', ltrFromDisplay(e.target.value, out.uom))}
                                disabled={!editable} placeholder="0.000" />
                            </div>
                          </>
                        );
                      }
                      if (outMode === 'ltr') return (
                        <div className="min-w-0">
                          <label className={labelClass}>⚠ Damage ({ltrSuffix(out.uom)})</label>
                          <input type="number" step="0.001" min="0" className={cls}
                            value={displayFromLtr(out.damage_qty_litres, out.uom)}
                            onChange={(e) => updateOutput(out.cid, 'damage_qty_litres', ltrFromDisplay(e.target.value, out.uom))}
                            disabled={!editable} placeholder="0.000" />
                        </div>
                      );
                      if (outMode === 'count') return (
                        <div className="min-w-0">
                          <label className={labelClass}>⚠ Damage ({out.uom || 'PCS'})</label>
                          <input type="number" step="1" min="0" className={cls}
                            value={out.damage_qty_count} onChange={(e) => updateOutput(out.cid, 'damage_qty_count', e.target.value)}
                            disabled={!editable} placeholder="0" />
                        </div>
                      );
                      return (
                        <div className="min-w-0">
                          <label className={labelClass}>⚠ Damage ({kgSuffix(out.uom)})</label>
                          <input type="number" step="0.001" min="0" className={cls}
                            value={displayFromKg(out.damage_qty_kg, out.uom)}
                            onChange={(e) => updateOutput(out.cid, 'damage_qty_kg', kgFromDisplay(e.target.value, out.uom))}
                            disabled={!editable} placeholder="0.000" />
                        </div>
                      );
                    })()}
                    <div className="min-w-0 col-span-2 lg:col-span-2">
                      <label className={labelClass}>Batch No</label>
                      <input type="text" className={inputClass}
                        value={out.batch_no} onChange={(e) => updateOutput(out.cid, 'batch_no', e.target.value)}
                        placeholder="e.g. PB-2026-00002"
                        title="Enter the batch number for this output."
                        disabled={!editable} />
                    </div>
                    <div className="min-w-0 col-span-2 lg:col-span-2">
                      <label className={labelClass}>
                        Remarks for this output
                        {(Number(out.damage_qty_kg) > 0 || Number(out.damage_qty_litres) > 0 || Number(out.damage_qty_count) > 0) && (
                          <span className="ml-1 text-amber-700 font-normal">— also serves as the damage reason</span>
                        )}
                      </label>
                      <input type="text" className={inputClass}
                        value={out.remarks} onChange={(e) => updateOutput(out.cid, 'remarks', e.target.value)}
                        placeholder="Optional note (or damage reason if damage entered above)"
                        disabled={!editable} />
                    </div>
                  </div>
                  )}
                </div>

                {/* Damage / loss now lives inline on each material +
                    output row (see the Damage column in the materials
                    table below). Reason for the damage is the row's
                    own Remarks — matches the DPR where damage notes
                    sit next to the affected line. */}

                {!collapsed && (
                <>
                {/* Inputs consumed for THIS output — clickable to collapse
                    just the materials list while keeping the output card
                    open. Useful when the output has many rows and the
                    operator only needs to tweak the header fields. */}
                <button
                  type="button"
                  onClick={() => toggleMaterialsCollapse(out.cid)}
                  className="w-full px-4 py-3 border-b border-slate-200 bg-emerald-50 text-xs font-semibold text-emerald-800 flex items-center gap-2 hover:bg-emerald-100"
                  aria-expanded={!areMaterialsCollapsed(out.cid)}
                >
                  {areMaterialsCollapsed(out.cid) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <Layers size={14} />
                  <span>Raw materials consumed for this output</span>
                  <span className="ml-auto text-[11px] font-normal text-emerald-700">
                    {out.inputs.filter((i) => i.product).length} added
                  </span>
                </button>

                {!areMaterialsCollapsed(out.cid) && (
                <>
                {/* Desktop only (lg and up): compact table layout. Below
                    lg — tablets AND phones — we render the roomy card
                    layout below so quantity inputs are actually tappable. */}
                <div className="hidden lg:block overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                        <th className="px-3 py-2 w-8">#</th>
                        <th className="px-3 py-2 w-40">Category</th>
                        <th className="px-3 py-2">Product</th>
                        <th className="px-3 py-2">Batch</th>
                        <th className="px-3 py-2 text-right w-40">Stock</th>
                        <th className="px-3 py-2 text-right w-40">Qty</th>
                        <th className="px-3 py-2 w-24">UOM</th>
                        <th className="px-3 py-2 w-28 text-right text-amber-700">⚠ Damage</th>
                        <th className="px-3 py-2">Remarks / Damage reason</th>
                        <th className="px-3 py-2 w-10"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {out.inputs.map((inp, iIdx) => {
                        const effectiveGodown = out.godown || header.godown;
                        const batchList = inp.product ? (stockByProductForGodown(effectiveGodown).get(inp.product) || []) : [];
                        const pickedBatch = batchList.find((b) => b.batch_no === inp.batch_no);
                        // Prefer the packing-source's remaining qty when
                        // this row was auto-populated from a Packed-from
                        // pick — the packable-outputs endpoint already
                        // computed exactly what's left for that source
                        // line, and it's the ceiling the operator cares
                        // about. Falls back to the godown-scoped stock
                        // lookup when packed_from isn't set (regular
                        // material rows).
                        const packedFromStock = (inp.packed_from && inp.product)
                          ? (() => {
                              const src = (packableByProduct.get(inp.product) || [])
                                .find((r) => r.line_id === inp.packed_from);
                              return src
                                ? {
                                    qty_kg:     Number(src.remaining_kg    || 0),
                                    qty_litres: Number(src.remaining_ltr   || 0),
                                    qty_count:  Number(src.remaining_count || 0),
                                  }
                                : null;
                            })()
                          : null;
                        const stockRow = packedFromStock
                          || (pickedBatch
                            ? { qty_kg: pickedBatch.qty_kg, qty_litres: pickedBatch.qty_litres, qty_count: pickedBatch.qty_count }
                            : (inp.product ? stockLookupForGodown(effectiveGodown).get(inp.product) : null));
                        // Fall back to the product's own category when the row
                        // hasn't set one yet — happens on edit-mode load where
                        // server rows carry `product` but not `category`.
                        const rowCategory = inp.category || (inp.product ? (productCategoryById.get(inp.product) || '') : '');
                        const availInputProducts = productsForInput(out.cid, inp.cid, rowCategory);
                        const inpProduct = inp.product ? productById.get(inp.product) : null;
                        const inpMode = resolveQtyMode(inpProduct);
                        // When entry_type = PACKING AND the picked product
                        // has source PRODUCTION output(s) with unpacked
                        // bulk left, swap the Batch dropdown for a
                        // "source line" picker whose value is the source
                        // OUTPUT line's UUID (stored on inp.packed_from).
                        // The picker's onChange auto-fills batch_no from
                        // the source so the hard-FK + soft batch string
                        // can never disagree.
                        const packableForRow = (header.entry_type === 'PACKING' && inp.product)
                          ? (packableByProduct.get(inp.product) || [])
                          : [];
                        const usePackablePicker = packableForRow.length > 0;
                        // Over-pack / over-consume live check. Only
                        // meaningful when we know the ceiling — i.e.
                        // the row is pinned to a batch (via packed_from
                        // or manual batch_no). Unbatched raw material
                        // rows lean on the general InventoryLedger,
                        // which this form doesn't track, so we skip.
                        const knowsCeiling = stockRow && (inp.packed_from || inp.batch_no);
                        const overPack = knowsCeiling ? {
                          kg:    Number(inp.qty_kg     || 0) > Number(stockRow.qty_kg     || 0),
                          ltr:   Number(inp.qty_litres || 0) > Number(stockRow.qty_litres || 0),
                          count: Number(inp.qty_count  || 0) > Number(stockRow.qty_count  || 0),
                        } : { kg: false, ltr: false, count: false };
                        const hasOverPack = overPack.kg || overPack.ltr || overPack.count;
                        return (
                          <tr key={inp.cid} className="border-t border-slate-100">
                            <td className="px-3 py-1.5 text-slate-500">{iIdx + 1}</td>
                            <td className="px-3 py-1.5 min-w-[140px]">
                              <CustomSelect
                                value={rowCategory}
                                onChange={(e) => updateInput(out.cid, inp.cid, 'category', e.target.value)}
                                disabled={!editable}
                              >
                                {INPUT_CATEGORIES.map((c) => (
                                  <option key={c.value || '__all__'} value={c.value}>{c.label}</option>
                                ))}
                              </CustomSelect>
                            </td>
                            <td className="px-3 py-1.5 min-w-[220px]">
                              <CustomSelect
                                value={inp.product}
                                onChange={(e) => {
                                  const nextProduct = e.target.value;
                                  updateInput(out.cid, inp.cid, 'product', nextProduct);
                                  // Auto-pick batch if only one available;
                                  // else clear (operator picks).
                                  autoPickBatchForInput(out.cid, inp.cid, nextProduct);
                                }}
                                disabled={!editable}
                              >
                                <option value="">Pick material…</option>
                                {availInputProducts.map((p) => {
                                  const label = `${p.product_name}${p.sku_code ? ` (${p.sku_code})` : ''}${p.sg_applicable ? ' • SG' : ''}`;
                                  return (<option key={p.id} value={p.id}>{label}</option>);
                                })}
                              </CustomSelect>
                            </td>
                            <td className="px-3 py-1.5 min-w-[200px]">
                              {usePackablePicker ? (
                                <>
                                  <CustomSelect
                                    value={inp.packed_from}
                                    onChange={(e) => updateInput(out.cid, inp.cid, 'packed_from', e.target.value)}
                                    disabled={!editable}
                                  >
                                    <option value="">— pick source batch —</option>
                                    {packableForRow.map((r) => {
                                      const bits = [];
                                      if (Number(r.remaining_kg)    > 0) bits.push(`${Number(r.remaining_kg).toFixed(2)} kg`);
                                      if (Number(r.remaining_ltr)   > 0) bits.push(`${Number(r.remaining_ltr).toFixed(2)} L`);
                                      if (Number(r.remaining_count) > 0) bits.push(`${Number(r.remaining_count).toFixed(0)} pcs`);
                                      return (
                                        <option key={r.line_id} value={r.line_id}>
                                          {r.batch_no || 'no-batch'} · {bits.join(' / ')} left · from {r.entry_no}
                                        </option>
                                      );
                                    })}
                                  </CustomSelect>
                                  {inp.packed_from && (
                                    <div className="mt-0.5 text-[10px] text-emerald-700">
                                      Packed from batch{' '}
                                      <span className="font-mono">{inp.batch_no || '—'}</span>
                                    </div>
                                  )}
                                </>
                              ) : (
                                <CustomSelect
                                  value={inp.batch_no}
                                  onChange={(e) => updateInput(out.cid, inp.cid, 'batch_no', e.target.value)}
                                  disabled={!editable || !inp.product}
                                >
                                  <option value="">{inp.product ? '— any / unbatched —' : 'Pick product first'}</option>
                                  {batchList.filter((b) => b.batch_no).map((b) => (
                                    <option key={b.batch_no} value={b.batch_no}>
                                      {b.batch_no} · {Number(b.qty_kg).toFixed(2)}kg / {Number(b.qty_litres).toFixed(2)}L
                                    </option>
                                  ))}
                                </CustomSelect>
                              )}
                            </td>
                            <td className={`px-3 py-1.5 text-right tabular-nums text-xs ${hasOverPack ? 'text-red-600 font-semibold' : 'text-slate-500'}`}>
                              {stockRow ? (() => {
                                // Stock display scales into the row's picked UOM
                                // so the operator compares apples-to-apples with
                                // their qty input. Ledger storage stays canonical
                                // (KG / LTR); only the visible number + suffix
                                // shift per-UOM.
                                const kgSuf = kgSuffix(inp.uom);
                                const ltrSuf = ltrSuffix(inp.uom);
                                const kgVal = Number(displayFromKg(stockRow.qty_kg, inp.uom) || 0);
                                const ltrVal = Number(displayFromLtr(stockRow.qty_litres, inp.uom) || 0);
                                const sub = (label) => (
                                  <span className={`text-[10px] ${hasOverPack ? 'text-red-500' : 'text-slate-400'}`}>{label}</span>
                                );
                                if (inpMode === 'sg') return (
                                  <>
                                    <div>{kgVal.toFixed(3)} {sub(kgSuf)}</div>
                                    <div>{ltrVal.toFixed(3)} {sub(ltrSuf)}</div>
                                  </>
                                );
                                if (inpMode === 'ltr') return <>{ltrVal.toFixed(3)} {sub(ltrSuf)}</>;
                                if (inpMode === 'count') return <>{Number(stockRow.qty_count || 0).toFixed(0)} {sub(inp.uom || 'pcs')}</>;
                                return <>{kgVal.toFixed(3)} {sub(kgSuf)}</>;
                              })() : '—'}
                            </td>
                            <td className="px-3 py-1.5 w-40">
                              {inpMode === 'sg' ? (
                                <div className="flex flex-col gap-1">
                                  <div className="relative">
                                    <input type="number" step="0.001" min="0"
                                      className={`${numClass} pr-9 ${overPack.kg ? 'border-red-400 bg-red-50 focus:ring-red-400 focus:border-red-500' : ''}`}
                                      value={displayFromKg(inp.qty_kg, inp.uom)}
                                      onChange={(e) => updateInput(out.cid, inp.cid, 'qty_kg', kgFromDisplay(e.target.value, inp.uom))}
                                      disabled={!editable} placeholder="0.000" />
                                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-medium text-slate-500 pointer-events-none">{kgSuffix(inp.uom)}</span>
                                  </div>
                                  <div className="relative">
                                    <input type="number" step="0.001" min="0"
                                      className={`${numClass} pr-9 ${overPack.ltr ? 'border-red-400 bg-red-50 focus:ring-red-400 focus:border-red-500' : ''}`}
                                      value={displayFromLtr(inp.qty_litres, inp.uom)}
                                      onChange={(e) => updateInput(out.cid, inp.cid, 'qty_litres', ltrFromDisplay(e.target.value, inp.uom))}
                                      disabled={!editable} placeholder="0.000" />
                                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-medium text-slate-500 pointer-events-none">{ltrSuffix(inp.uom)}</span>
                                  </div>
                                </div>
                              ) : inpMode === 'ltr' ? (
                                <div className="relative">
                                  <input type="number" step="0.001" min="0"
                                    className={`${numClass} pr-9 ${overPack.ltr ? 'border-red-400 bg-red-50 focus:ring-red-400 focus:border-red-500' : ''}`}
                                    value={displayFromLtr(inp.qty_litres, inp.uom)}
                                    onChange={(e) => updateInput(out.cid, inp.cid, 'qty_litres', ltrFromDisplay(e.target.value, inp.uom))}
                                    disabled={!editable} placeholder="0.000" />
                                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-medium text-slate-500 pointer-events-none">{ltrSuffix(inp.uom)}</span>
                                </div>
                              ) : inpMode === 'count' ? (
                                <div className="relative">
                                  <input type="number" step="1" min="0"
                                    className={`${numClass} pr-9 ${overPack.count ? 'border-red-400 bg-red-50 focus:ring-red-400 focus:border-red-500' : ''}`}
                                    value={inp.qty_count} onChange={(e) => updateInput(out.cid, inp.cid, 'qty_count', e.target.value)}
                                    disabled={!editable} placeholder="0" />
                                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-medium text-slate-500 pointer-events-none">{inp.uom || 'PCS'}</span>
                                </div>
                              ) : (
                                <div className="relative">
                                  <input type="number" step="0.001" min="0"
                                    className={`${numClass} pr-9 ${overPack.kg ? 'border-red-400 bg-red-50 focus:ring-red-400 focus:border-red-500' : ''}`}
                                    value={displayFromKg(inp.qty_kg, inp.uom)}
                                    onChange={(e) => updateInput(out.cid, inp.cid, 'qty_kg', kgFromDisplay(e.target.value, inp.uom))}
                                    disabled={!editable} placeholder="0.000" />
                                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-medium text-slate-500 pointer-events-none">{kgSuffix(inp.uom)}</span>
                                </div>
                              )}
                              {hasOverPack ? (
                                <div className="mt-0.5 text-[10px] text-red-600 flex items-center gap-0.5 justify-end">
                                  <span>⚠</span>
                                  <span>Exceeds available</span>
                                </div>
                              ) : (
                                // "Will remain" pending-qty indicator — only
                                // shown when the row is pinned to a batch AND
                                // the operator has typed a non-zero qty. Tells
                                // them at a glance how much of the source
                                // batch is left after this entry saves.
                                stockRow && (inp.packed_from || inp.batch_no) && (() => {
                                  const kgSuf = kgSuffix(inp.uom);
                                  const ltrSuf = ltrSuffix(inp.uom);
                                  const bits = [];
                                  const rem = (stockKg, qtyKg, unit, suf) => {
                                    if (Number(qtyKg) <= 0) return;
                                    const remaining = Number(stockKg) - Number(qtyKg);
                                    const displayed = unit === 'kg'
                                      ? Number(displayFromKg(String(remaining), inp.uom) || 0)
                                      : Number(displayFromLtr(String(remaining), inp.uom) || 0);
                                    bits.push(`${displayed.toFixed(3)} ${suf}`);
                                  };
                                  if (inpMode === 'sg') {
                                    rem(stockRow.qty_kg, inp.qty_kg, 'kg', kgSuf);
                                    rem(stockRow.qty_litres, inp.qty_litres, 'ltr', ltrSuf);
                                  } else if (inpMode === 'ltr') {
                                    rem(stockRow.qty_litres, inp.qty_litres, 'ltr', ltrSuf);
                                  } else if (inpMode === 'count') {
                                    if (Number(inp.qty_count) > 0) {
                                      const remaining = Number(stockRow.qty_count || 0) - Number(inp.qty_count);
                                      bits.push(`${Math.round(remaining)} ${inp.uom || 'pcs'}`);
                                    }
                                  } else {
                                    rem(stockRow.qty_kg, inp.qty_kg, 'kg', kgSuf);
                                  }
                                  if (!bits.length) return null;
                                  return (
                                    <div className="mt-0.5 text-[10px] text-emerald-700 text-right">
                                      = {bits.join(' / ')} left after save
                                    </div>
                                  );
                                })()
                              )}
                            </td>
                            <td className="px-3 py-1.5 w-24">
                              <CustomSelect
                                value={inp.uom}
                                onChange={(e) => updateInput(out.cid, inp.cid, 'uom', e.target.value)}
                                disabled={!editable}
                              >
                                <option value="">…</option>
                                {uomOptionsWith(inp.uom).map((u) => (<option key={u} value={u}>{u}</option>))}
                              </CustomSelect>
                            </td>
                            {/* Damage — same UOM mode as the qty
                                input on this row. Non-zero damage
                                posts an OUT ADJUSTMENT on save;
                                reason = this row's Remarks column
                                (next cell over). */}
                            <td className="px-3 py-1.5 w-28">
                              {(() => {
                                const dmgCls = 'w-full px-2 py-1.5 border border-amber-300 bg-amber-50/40 rounded text-xs text-right tabular-nums focus:ring-2 focus:ring-amber-400 focus:border-amber-500';
                                if (inpMode === 'sg') return (
                                  <div className="flex flex-col gap-0.5">
                                    <input type="number" step="0.001" min="0" className={dmgCls}
                                      value={displayFromKg(inp.damage_qty_kg, inp.uom)}
                                      onChange={(e) => updateInput(out.cid, inp.cid, 'damage_qty_kg', kgFromDisplay(e.target.value, inp.uom))}
                                      disabled={!editable} placeholder={`0 ${kgSuffix(inp.uom)}`} />
                                    <input type="number" step="0.001" min="0" className={dmgCls}
                                      value={displayFromLtr(inp.damage_qty_litres, inp.uom)}
                                      onChange={(e) => updateInput(out.cid, inp.cid, 'damage_qty_litres', ltrFromDisplay(e.target.value, inp.uom))}
                                      disabled={!editable} placeholder={`0 ${ltrSuffix(inp.uom)}`} />
                                  </div>
                                );
                                if (inpMode === 'ltr') return (
                                  <input type="number" step="0.001" min="0" className={dmgCls}
                                    value={displayFromLtr(inp.damage_qty_litres, inp.uom)}
                                    onChange={(e) => updateInput(out.cid, inp.cid, 'damage_qty_litres', ltrFromDisplay(e.target.value, inp.uom))}
                                    disabled={!editable} placeholder={`0 ${ltrSuffix(inp.uom)}`} />
                                );
                                if (inpMode === 'count') return (
                                  <input type="number" step="1" min="0" className={dmgCls}
                                    value={inp.damage_qty_count}
                                    onChange={(e) => updateInput(out.cid, inp.cid, 'damage_qty_count', e.target.value)}
                                    disabled={!editable} placeholder={`0 ${inp.uom || 'pcs'}`} />
                                );
                                return (
                                  <input type="number" step="0.001" min="0" className={dmgCls}
                                    value={displayFromKg(inp.damage_qty_kg, inp.uom)}
                                    onChange={(e) => updateInput(out.cid, inp.cid, 'damage_qty_kg', kgFromDisplay(e.target.value, inp.uom))}
                                    disabled={!editable} placeholder={`0 ${kgSuffix(inp.uom)}`} />
                                );
                              })()}
                            </td>
                            <td className="px-3 py-1.5">
                              <input type="text"
                                className={
                                  (Number(inp.damage_qty_kg) > 0 || Number(inp.damage_qty_litres) > 0 || Number(inp.damage_qty_count) > 0)
                                    ? `${inputClass} border-amber-300 bg-amber-50/40`
                                    : inputClass
                                }
                                value={inp.remarks} onChange={(e) => updateInput(out.cid, inp.cid, 'remarks', e.target.value)}
                                disabled={!editable}
                                placeholder={
                                  (Number(inp.damage_qty_kg) > 0 || Number(inp.damage_qty_litres) > 0 || Number(inp.damage_qty_count) > 0)
                                    ? 'Damage reason (e.g. broken bottles)'
                                    : 'Optional'
                                } />
                            </td>
                            <td className="px-3 py-1.5 text-center">
                              {editable && (
                                <button onClick={() => removeInput(out.cid, inp.cid)}
                                  className="p-1 text-red-500 hover:bg-red-50 rounded" title="Remove input row">
                                  <Minus size={14} />
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Mobile + tablet (below lg): stacked, compact material
                    cards — every field is full tap-target width. */}
                <div className="lg:hidden divide-y divide-slate-100">
                  {out.inputs.map((inp, iIdx) => {
                    const effectiveGodown = out.godown || header.godown;
                    const batchList = inp.product ? (stockByProductForGodown(effectiveGodown).get(inp.product) || []) : [];
                    const pickedBatch = batchList.find((b) => b.batch_no === inp.batch_no);
                    const stockRow = pickedBatch
                      ? { qty_kg: pickedBatch.qty_kg, qty_litres: pickedBatch.qty_litres, qty_count: pickedBatch.qty_count }
                      : (inp.product ? stockLookupForGodown(effectiveGodown).get(inp.product) : null);
                    const rowCategory = inp.category || (inp.product ? (productCategoryById.get(inp.product) || '') : '');
                    const availInputProducts = productsForInput(out.cid, inp.cid, rowCategory);
                    const inpProduct = inp.product ? productById.get(inp.product) : null;
                    const inpMode = resolveQtyMode(inpProduct);
                    // Same packable-picker gate as the desktop table.
                    const packableForRow = (header.entry_type === 'PACKING' && inp.product)
                      ? (packableByProduct.get(inp.product) || [])
                      : [];
                    const usePackablePicker = packableForRow.length > 0;
                    return (
                      <div key={inp.cid} className="p-3">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Material #{iIdx + 1}</span>
                          {editable && (
                            <button onClick={() => removeInput(out.cid, inp.cid)}
                              className="p-1 text-red-500 hover:bg-red-50 rounded" title="Remove"
                            ><Trash2 size={14} /></button>
                          )}
                        </div>
                        {/* Category filter — narrows the Product picker below */}
                        <div className="mb-2">
                          <label className={labelClass}>Category</label>
                          <CustomSelect
                            value={rowCategory}
                            onChange={(e) => updateInput(out.cid, inp.cid, 'category', e.target.value)}
                            disabled={!editable}
                          >
                            {INPUT_CATEGORIES.map((c) => (
                              <option key={c.value || '__all__'} value={c.value}>{c.label}</option>
                            ))}
                          </CustomSelect>
                        </div>
                        {/* Product picker — full width, stock hint below */}
                        <div className="mb-2">
                          <CustomSelect
                            value={inp.product}
                            onChange={(e) => {
                              const nextProduct = e.target.value;
                              updateInput(out.cid, inp.cid, 'product', nextProduct);
                              autoPickBatchForInput(out.cid, inp.cid, nextProduct);
                            }}
                            disabled={!editable}
                          >
                            <option value="">Pick material…</option>
                            {availInputProducts.map((p) => {
                              const label = `${p.product_name}${p.sku_code ? ` (${p.sku_code})` : ''}${p.sg_applicable ? ' • SG' : ''}`;
                              return (<option key={p.id} value={p.id}>{label}</option>);
                            })}
                          </CustomSelect>
                          {stockRow && (
                            <p className="mt-1 text-[10px] text-slate-500">
                              Stock{pickedBatch ? ` (${pickedBatch.batch_no})` : ''}:
                              {inpMode === 'sg' ? (
                                <>
                                  {' '}<span className="tabular-nums font-medium">{Number(stockRow.qty_kg).toFixed(3)} kg</span>
                                  {' · '}<span className="tabular-nums font-medium">{Number(stockRow.qty_litres).toFixed(3)} L</span>
                                </>
                              ) : inpMode === 'ltr' ? (
                                <> <span className="tabular-nums font-medium">{Number(stockRow.qty_litres).toFixed(3)} L</span></>
                              ) : inpMode === 'count' ? (
                                <> <span className="tabular-nums font-medium">{Number(stockRow.qty_count || 0).toFixed(0)} pcs</span></>
                              ) : (
                                <> <span className="tabular-nums font-medium">{Number(stockRow.qty_kg).toFixed(3)} kg</span></>
                              )}
                            </p>
                          )}
                        </div>
                        {/* Batch picker — full width, only when a product is picked.
                            In PACKING mode with packable options, swap to the
                            source-line picker (same logic as the desktop table). */}
                        {inp.product && (
                          <div className="mb-2">
                            <label className={labelClass}>
                              {usePackablePicker ? 'Packed from' : 'Batch'}
                            </label>
                            {usePackablePicker ? (
                              <>
                                <CustomSelect
                                  value={inp.packed_from}
                                  onChange={(e) => updateInput(out.cid, inp.cid, 'packed_from', e.target.value)}
                                  disabled={!editable}
                                >
                                  <option value="">— pick source batch —</option>
                                  {packableForRow.map((r) => {
                                    const bits = [];
                                    if (Number(r.remaining_kg)    > 0) bits.push(`${Number(r.remaining_kg).toFixed(2)} kg`);
                                    if (Number(r.remaining_ltr)   > 0) bits.push(`${Number(r.remaining_ltr).toFixed(2)} L`);
                                    if (Number(r.remaining_count) > 0) bits.push(`${Number(r.remaining_count).toFixed(0)} pcs`);
                                    return (
                                      <option key={r.line_id} value={r.line_id}>
                                        {r.batch_no || 'no-batch'} · {bits.join(' / ')} left · from {r.entry_no}
                                      </option>
                                    );
                                  })}
                                </CustomSelect>
                                {inp.packed_from && (
                                  <p className="mt-1 text-[10px] text-emerald-700">
                                    Packed from batch <span className="font-mono">{inp.batch_no || '—'}</span>
                                  </p>
                                )}
                              </>
                            ) : (
                              <CustomSelect
                                value={inp.batch_no}
                                onChange={(e) => updateInput(out.cid, inp.cid, 'batch_no', e.target.value)}
                                disabled={!editable}
                              >
                                <option value="">— any / unbatched —</option>
                                {batchList.filter((b) => b.batch_no).map((b) => (
                                  <option key={b.batch_no} value={b.batch_no}>
                                    {b.batch_no} · {Number(b.qty_kg).toFixed(2)}kg / {Number(b.qty_litres).toFixed(2)}L
                                  </option>
                                ))}
                              </CustomSelect>
                            )}
                          </div>
                        )}
                        {/* Qty (mode-driven) + UOM — mobile: stacked pair when SG.
                            Labels + values follow the picked UOM (KG/MTS/GM
                            for weight, LTR/ML/CUM for volume) so "7 MTS"
                            typed by the operator becomes 7000 kg in state,
                            not 7 kg. */}
                        <div className={`grid ${inpMode === 'sg' ? 'grid-cols-3' : 'grid-cols-2'} gap-2 mb-2`}>
                          {inpMode === 'sg' ? (
                            <>
                              <div>
                                <label className={labelClass}>Qty ({kgSuffix(inp.uom)})</label>
                                <input type="number" step="0.001" min="0" className={numClass}
                                  value={displayFromKg(inp.qty_kg, inp.uom)}
                                  onChange={(e) => updateInput(out.cid, inp.cid, 'qty_kg', kgFromDisplay(e.target.value, inp.uom))}
                                  disabled={!editable} placeholder="0.000" />
                              </div>
                              <div>
                                <label className={labelClass}>Qty ({ltrSuffix(inp.uom)})</label>
                                <input type="number" step="0.001" min="0" className={numClass}
                                  value={displayFromLtr(inp.qty_litres, inp.uom)}
                                  onChange={(e) => updateInput(out.cid, inp.cid, 'qty_litres', ltrFromDisplay(e.target.value, inp.uom))}
                                  disabled={!editable} placeholder="0.000" />
                              </div>
                            </>
                          ) : inpMode === 'ltr' ? (
                            <div>
                              <label className={labelClass}>Qty ({ltrSuffix(inp.uom)})</label>
                              <input type="number" step="0.001" min="0" className={numClass}
                                value={displayFromLtr(inp.qty_litres, inp.uom)}
                                onChange={(e) => updateInput(out.cid, inp.cid, 'qty_litres', ltrFromDisplay(e.target.value, inp.uom))}
                                disabled={!editable} placeholder="0.000" />
                            </div>
                          ) : inpMode === 'count' ? (
                            <div>
                              <label className={labelClass}>Qty ({inp.uom || 'PCS'})</label>
                              <input type="number" step="1" min="0" className={numClass}
                                value={inp.qty_count} onChange={(e) => updateInput(out.cid, inp.cid, 'qty_count', e.target.value)}
                                disabled={!editable} placeholder="0" />
                            </div>
                          ) : (
                            <div>
                              <label className={labelClass}>Qty ({kgSuffix(inp.uom)})</label>
                              <input type="number" step="0.001" min="0" className={numClass}
                                value={displayFromKg(inp.qty_kg, inp.uom)}
                                onChange={(e) => updateInput(out.cid, inp.cid, 'qty_kg', kgFromDisplay(e.target.value, inp.uom))}
                                disabled={!editable} placeholder="0.000" />
                            </div>
                          )}
                          <div>
                            <label className={labelClass}>UOM</label>
                            <CustomSelect
                              value={inp.uom}
                              onChange={(e) => updateInput(out.cid, inp.cid, 'uom', e.target.value)}
                              disabled={!editable}
                            >
                              <option value="">…</option>
                              {uomOptionsWith(inp.uom).map((u) => (<option key={u} value={u}>{u}</option>))}
                            </CustomSelect>
                          </div>
                        </div>
                        {/* Damage — full width, amber-tinted. Same
                            UOM mode as the qty inputs above. Reason
                            lives in the Remarks below (auto-labelled
                            when damage > 0). */}
                        {(() => {
                          const dmgCls = 'w-full px-2 py-1.5 border border-amber-300 bg-amber-50/40 rounded text-sm text-right tabular-nums focus:ring-2 focus:ring-amber-400';
                          const damageBlock = (() => {
                            if (inpMode === 'sg') return (
                              <div className="grid grid-cols-2 gap-2">
                                <input type="number" step="0.001" min="0" className={dmgCls}
                                  value={displayFromKg(inp.damage_qty_kg, inp.uom)}
                                  onChange={(e) => updateInput(out.cid, inp.cid, 'damage_qty_kg', kgFromDisplay(e.target.value, inp.uom))}
                                  disabled={!editable} placeholder={`0 ${kgSuffix(inp.uom)}`} />
                                <input type="number" step="0.001" min="0" className={dmgCls}
                                  value={displayFromLtr(inp.damage_qty_litres, inp.uom)}
                                  onChange={(e) => updateInput(out.cid, inp.cid, 'damage_qty_litres', ltrFromDisplay(e.target.value, inp.uom))}
                                  disabled={!editable} placeholder={`0 ${ltrSuffix(inp.uom)}`} />
                              </div>
                            );
                            if (inpMode === 'ltr') return (
                              <input type="number" step="0.001" min="0" className={dmgCls}
                                value={displayFromLtr(inp.damage_qty_litres, inp.uom)}
                                onChange={(e) => updateInput(out.cid, inp.cid, 'damage_qty_litres', ltrFromDisplay(e.target.value, inp.uom))}
                                disabled={!editable} placeholder={`0 ${ltrSuffix(inp.uom)}`} />
                            );
                            if (inpMode === 'count') return (
                              <input type="number" step="1" min="0" className={dmgCls}
                                value={inp.damage_qty_count}
                                onChange={(e) => updateInput(out.cid, inp.cid, 'damage_qty_count', e.target.value)}
                                disabled={!editable} placeholder={`0 ${inp.uom || 'pcs'}`} />
                            );
                            return (
                              <input type="number" step="0.001" min="0" className={dmgCls}
                                value={displayFromKg(inp.damage_qty_kg, inp.uom)}
                                onChange={(e) => updateInput(out.cid, inp.cid, 'damage_qty_kg', kgFromDisplay(e.target.value, inp.uom))}
                                disabled={!editable} placeholder={`0 ${kgSuffix(inp.uom)}`} />
                            );
                          })();
                          return (
                            <div className="mb-2">
                              <label className={`${labelClass} text-amber-700`}>⚠ Damage / loss (optional)</label>
                              {damageBlock}
                            </div>
                          );
                        })()}
                        {/* Remarks — also serves as damage reason
                            when non-zero damage is entered above. */}
                        {(() => {
                          const hasDmg = Number(inp.damage_qty_kg) > 0
                                       || Number(inp.damage_qty_litres) > 0
                                       || Number(inp.damage_qty_count) > 0;
                          return (
                            <input type="text"
                              className={hasDmg ? `${inputClass} border-amber-300 bg-amber-50/40` : inputClass}
                              value={inp.remarks} onChange={(e) => updateInput(out.cid, inp.cid, 'remarks', e.target.value)}
                              disabled={!editable}
                              placeholder={hasDmg ? 'Damage reason (e.g. broken bottles)' : 'Remarks (optional)'} />
                          );
                        })()}
                      </div>
                    );
                  })}
                </div>

                {editable && (
                  <div className="p-2 border-t border-slate-100 bg-slate-50">
                    <button onClick={() => addInput(out.cid)}
                      className="w-full sm:w-auto inline-flex items-center justify-center gap-1 px-3 py-2 text-xs font-medium rounded bg-emerald-100 text-emerald-800 hover:bg-emerald-200">
                      <Plus size={12} /> Add material to Output #{oIdx + 1}
                    </button>
                  </div>
                )}
                </>
                )}
                </>
                )}
              </div>
            );
          })}

          {/* Add another output */}
          {editable && (
            <div className="mb-4">
              <button onClick={addOutput}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium bg-blue-100 text-blue-800 rounded-lg hover:bg-blue-200">
                <Plus size={14} /> Add another Output (another product produced today)
              </button>
            </div>
          )}

          {/* Balance check — inputs vs outputs per unit. When both
              sides use the same unit we show a delta % so a typo
              like "60 instead of 600 kg" jumps out; mixed-unit
              totals just print side by side. Save never blocks on
              this; a warning toast fires if the delta is out of
              range so the operator can double-check. */}
          {hasBalanceActivity && (
            <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">
                Balance check
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {balanceRows.map(({ key, label, ins, outs, delta }) => {
                  const fmtn = (n) => Number(n || 0).toLocaleString('en-IN', {
                    maximumFractionDigits: key === 'pcs' ? 0 : 3,
                    minimumFractionDigits: key === 'pcs' ? 0 : 3,
                  });
                  const outOfRange = delta != null && Math.abs(delta) > BALANCE_TOLERANCE_PCT;
                  const deltaColor = delta == null
                    ? ''
                    : outOfRange
                      ? (hasCrossUnitFlow
                        ? 'text-slate-600 bg-slate-100 border-slate-300'
                        : 'text-red-700 bg-red-50 border-red-200')
                      : 'text-emerald-700 bg-emerald-50 border-emerald-200';
                  return (
                    <div key={key} className="rounded-md border border-slate-200 bg-white p-2">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px] font-medium text-slate-500">{label}</span>
                        {delta != null && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border tabular-nums ${deltaColor}`}>
                            {delta > 0 ? '+' : ''}{delta.toFixed(2)}%
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-600 tabular-nums">
                        <div className="flex justify-between">
                          <span className="text-slate-500">In</span>
                          <span className="font-medium text-slate-800">{fmtn(ins)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-500">Out</span>
                          <span className="font-medium text-slate-800">{fmtn(outs)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {!hasCrossUnitFlow && balanceRows.some((r) => r.delta != null && Math.abs(r.delta) > BALANCE_TOLERANCE_PCT) && (
                <p className="mt-2 text-[11px] text-red-700">
                  One or more units is out of the {BALANCE_TOLERANCE_PCT}% conservation range —
                  double-check quantities. Save is still allowed (chemistry legitimately loses mass /
                  volume to evaporation).
                </p>
              )}
              {hasCrossUnitFlow && balanceRows.some((r) => r.delta != null) && (
                <p className="mt-2 text-[11px] text-slate-500">
                  Inputs and outputs span different units — material entering as one unit can
                  legitimately leave as another (liquid absorbed into solids, solids dissolved
                  into liquid), so the % delta can't verify conservation here. Double-check
                  quantities against the day's production record instead.
                </p>
              )}
            </div>
          )}

          {/* Actions — sticky bottom bar on mobile so Save is always
              reachable; a plain row on desktop. Adds extra bottom
              padding on mobile to clear the app's bottom-tab nav. */}
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4 pb-24 sm:pb-4">
            <button onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/inventory/production-entries')}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
              <ArrowLeft size={14} /> Back
            </button>
            {editable && (
              <button onClick={handleSave} disabled={saving}
                className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-60">
                {saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />}
                {isEdit ? 'Save changes' : 'Save entry'}
              </button>
            )}
            {isEdit && canDelete('Production Entry') && (
              <button onClick={handleDelete}
                className="w-full sm:w-auto sm:ml-auto inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg">
                <Trash2 size={14} /> Remove entry
              </button>
            )}
          </div>

          {isEdit && createdByName && (
            <p className="mt-3 text-[11px] text-slate-500">
              First recorded by <span className="font-medium">{createdByName}</span>.
            </p>
          )}
        </>
      )}
    </MainLayout>
  );
}
