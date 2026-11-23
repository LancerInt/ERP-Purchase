import { confirm } from '@/components/common/confirm';
import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2, Sparkles, Upload, FileText, AlertTriangle, X, Check, Loader2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup, { clearLookupCache } from '../../../hooks/useLookup.js';
import useApiData from '../../../hooks/useApiData.js';
import AddressField, { formatAddressDisplay, getDistrictState, parseAddress, stringifyAddress } from '../../../components/common/AddressField';
import FileAttachments, { uploadPendingFiles } from '../components/FileAttachments';
import { SALES_UOM_OPTIONS, SALES_UOM_VALUES } from '../utils/uomOptions';
import { formatCurrency } from '@/utils/formatters';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

// Maps common UOM spellings/abbreviations from a customer PO to the
// dropdown values the form expects. Customer POs are wildly inconsistent
// here — "Kg", "Kgs", "Kilogram", "KILOS" all need to land on "KG", and
// "Litres" / "L" / "Ltr" all need to land on "LTR". The whitelist is
// derived from the dropdown itself (SALES_UOM_VALUES) so it can't drift
// from what the <select> actually offers — any unit the dropdown doesn't
// carry (DRUM, MTR, …) must normalise to '' so `resolvedUom` falls back
// to the price-list UOM instead of committing to an unselectable value.
const _UOM_DROPDOWN_VALUES = new Set(SALES_UOM_VALUES);
const _UOM_SYNONYMS = {
  KG: 'KG', KGS: 'KG', KILO: 'KG', KILOS: 'KG', KILOGRAM: 'KG', KILOGRAMS: 'KG',
  GM: 'GM', GMS: 'GM', GRAM: 'GM', GRAMS: 'GM', G: 'GM',
  LTR: 'LTR', LITRE: 'LTR', LITER: 'LTR', L: 'LTR',
  LTRS: 'LTRS', LITRES: 'LTRS', LITERS: 'LTRS', LS: 'LTRS',
  ML: 'ML', MILLILITRE: 'ML', MILLILITRES: 'ML', MILLILITER: 'ML', MILLILITERS: 'ML',
  NOS: 'NOS', NO: 'NOS', NUMBER: 'NOS', NUMBERS: 'NOS', UNIT: 'NOS', UNITS: 'NOS',
  PCS: 'PCS', PC: 'PCS', PIECE: 'PCS', PIECES: 'PCS', EA: 'PCS', EACH: 'PCS', QTY: 'PCS',
  BOX: 'BOX', BOXES: 'BOX', BX: 'BOX', CARTON: 'BOX', CARTONS: 'BOX', CTN: 'BOX',
  BAG: 'BAG', BAGS: 'BAG', BG: 'BAG', SACK: 'BAG', SACKS: 'BAG',
  // The sales UOM dropdown's canonical metric-ton is MTS (TON/MT were
  // dropped from it), so every ton spelling a PO can print must land on
  // MTS — mapping MT to the removed 'TON' left the dropdown blank on
  // SAP-style POs that price in metric tons (e.g. UOM "MT", qty 7.000).
  TON: 'MTS', TONS: 'MTS', TONNE: 'MTS', TONNES: 'MTS', MT: 'MTS', METRICTON: 'MTS',
  MTS: 'MTS',
  SET: 'SET', SETS: 'SET',
};
const normalizeUom = (raw) => {
  if (!raw) return '';
  const u = String(raw).toUpperCase().replace(/[\s.]+/g, '');
  if (_UOM_SYNONYMS[u]) return _UOM_SYNONYMS[u];
  if (_UOM_DROPDOWN_VALUES.has(u)) return u;
  return '';  // unknown — let caller fall through to next priority
};
// Canonical key for UOM row-matching. Falls back to raw uppercase so
// price-list rows with units normalizeUom doesn't know (SQM, PACK, …)
// still match themselves.
const uomKey = (u) => normalizeUom(u) || String(u || '').trim().toUpperCase();

// ── UOM scale conversion (rate ↔ quantity) ──────────────────────────────
// Price lists author bulk rates per METRIC TON (MTS/TON) while customer POs
// arrive in KG. A per-MT rate applied to a KG quantity made the line amount
// 1000x too high. These maps give the KG- and LTR-equivalent of each mass /
// volume unit so a rate authored per one unit can be restated per the PO
// line's unit. Same unit, cross-dimension, or unknown units return factor 1
// (never guess).
const _UOM_MASS = { KG: 1, GM: 0.001, MTS: 1000, TON: 1000 };
const _UOM_VOL  = { LTR: 1, LTRS: 1, ML: 0.001, KL: 1000 };
const uomScale = (from, to) => {
  from = (normalizeUom(from) || String(from || '').toUpperCase());
  to   = (normalizeUom(to)   || String(to   || '').toUpperCase());
  if (!from || !to || from === to) return 1;
  if (from in _UOM_MASS && to in _UOM_MASS) return _UOM_MASS[from] / _UOM_MASS[to];
  if (from in _UOM_VOL  && to in _UOM_VOL)  return _UOM_VOL[from]  / _UOM_VOL[to];
  return 1;
};
// Restate a price-list rate (authored per plUom) as a rate per the PO line's
// uom, so Amount = qty(lineUom) × rate is correct. e.g. 50700/MTS → 50.70/KG.
const rateForLineUom = (plRate, plUom, lineUom) =>
  (parseFloat(plRate) || 0) * uomScale(lineUom, plUom);

// Round to a DB column's precision before sending. DRF DecimalFields reject a
// value carrying MORE decimal places than the column allows, and our line
// values routinely do: the extractor prints the PO's rate as "15.90000" (5 dp)
// and the per-UOM restatement above is float math (15900 * 0.001 ->
// 15.900000000000002). Both are really 2-dp numbers, but the save failed with
// "Ensure that there are no more than 2 decimal places". Returns null for
// blank/unparseable so the caller can fall back to its own default.
const dec = (v, places) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(places)) : null;
};

// Auto-pick a price list the way the backend does: prefer lists currently
// in effect (effective_from <= today <= effective_to; a missing date
// counts as open-ended) and take the FIRST such list as returned by the
// API — the backend orders by -effective_from, so that's the newest
// effective one. Only when nothing is currently effective (all lists
// future-dated / expired) fall back to the old most-recently-updated sort.
const pickEffectivePriceList = (lists) => {
  const all = lists || [];
  const today = new Date().toISOString().slice(0, 10);
  const isEffective = (pl) => {
    const from = String(pl?.effective_from || '').slice(0, 10);
    const to = String(pl?.effective_to || '').slice(0, 10);
    return (!from || from <= today) && (!to || to >= today);
  };
  const effective = all.filter(isEffective);
  if (effective.length > 0) return effective[0];
  return [...all].sort((a, b) => {
    const da = a.updated_at || a.created_at || '';
    const db = b.updated_at || b.created_at || '';
    return String(db).localeCompare(String(da));
  })[0];
};

const GOODS_SUB_TYPE_OPTIONS = [
  { value: '', label: 'Select Category' },
  { value: 'RAW_MATERIAL', label: 'Raw Material' }, { value: 'PACKING_MATERIAL', label: 'Packing Material' },
  { value: 'FINISHED_GOOD', label: 'Finished Good' }, { value: 'SEMI_FINISHED', label: 'Semi Finished' },
  { value: 'TRADED_PRODUCTS', label: 'Traded Products' }, { value: 'CAPITAL_GOOD', label: 'Capital Good' },
  { value: 'MACHINE_SPARES', label: 'Machine Spares' }, { value: 'CONSUMABLES', label: 'Consumables' },
];

// Pretty-prints the per-call Gemini telemetry the backend attaches to
// the PO-extract response under `meta.gemini_calls`. We use console.group
// + console.table so a developer opening DevTools after a PO upload sees
// exactly which model ran each call, the prompt/completion/total token
// counts, the latency, and any errors. No-ops gracefully when the meta
// block isn't present (e.g. backend hasn't been updated yet, or the
// extraction errored before any Gemini call ran).
function logGeminiTelemetry(meta, fileName) {
  const calls = meta?.gemini_calls;
  if (!Array.isArray(calls) || calls.length === 0) {
    console.info('[CustomerPO Extract] No Gemini telemetry returned from backend.');
    return;
  }
  const totals = meta?.gemini_totals || {};
  const heading = `📄 Customer PO Extract — Gemini telemetry — ${fileName || '(file)'}`;
  /* eslint-disable no-console */
  console.groupCollapsed(`%c${heading}`, 'color:#4f46e5;font-weight:bold;font-size:12px;');
  console.table(
    calls.map((c, i) => ({
      '#': i + 1,
      Call: c.call,
      Model: c.model,
      OK: c.ok ? '✅' : '❌',
      'Prompt tok': c.prompt_tokens ?? '—',
      'Completion tok': c.completion_tokens ?? '—',
      'Total tok': c.total_tokens ?? '—',
      'Duration (ms)': c.duration_ms ?? '—',
      Error: c.error ?? '',
    })),
  );
  console.log(
    `%cTotals%c — calls: ${totals.call_count ?? calls.length}, prompt: ${totals.prompt_tokens ?? 0}, ` +
    `completion: ${totals.completion_tokens ?? 0}, total: ${totals.total_tokens ?? 0} tokens, ` +
    `elapsed: ${totals.duration_ms ?? 0} ms`,
    'background:#4f46e5;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold;',
    'color:inherit;',
  );
  console.log('Raw payload →', { meta, calls, totals });
  console.groupEnd();
  /* eslint-enable no-console */
}

const emptyLine = {
  product_category: 'FINISHED_GOOD', parsed_sku: '', product_description: '', item_code: '', hsn_code: '',
  quantity: '', uom: 'KG',
  // `price` is the authoritative rate from the customer's price list
  // (drives Amount / Net Amt). `po_rate` is the rate printed on the
  // buyer's PO document — surfaced as a separate read-along column so
  // the user can see at a glance when the buyer wrote a different
  // rate than what the master price list says.
  price: '', po_rate: '',
  discount: '0', gst: '0',
  sgst_percent: '0', cgst_percent: '0', igst_percent: '0',
  line_remarks: '',
};

export default function CreateCustomerPO() {
  const navigate = useNavigate();
  // `?inbox_id=...&attachment_id=...` is set when the user clicks
  // "Process Mail" on the inbox panel. The autoload effect below
  // fetches the attachment and feeds it into handleExtractFromFile
  // — the SAME entry point the file picker uses — so the inbox flow
  // doesn't duplicate any extraction logic.
  const [searchParams, setSearchParams] = useSearchParams();
  const inboxId = searchParams.get('inbox_id') || '';
  const inboxAttachmentId = searchParams.get('attachment_id') || '';
  // Filename passed from the inbox panel so we don't have to rely on
  // the response's Content-Disposition header (which CORS hides from
  // JS unless explicitly exposed). Carries the extension the
  // extractor needs to accept the file.
  const inboxFilenameParam = searchParams.get('filename') || '';
  const inboxLoadedRef = useRef(false);
  // ── Review-replay params ───────────────────────────────────────────
  // `?draft=<id>` — a bulk-created DRAFT Customer PO whose full extract
  // response is stored in `extraction_snapshot`. The replay effect
  // below feeds that snapshot through applyExtraction (the SAME
  // autofill pipeline a fresh upload runs) and Save then UPDATES the
  // draft (PUT) instead of creating a new CPO.
  // `?bulkReview=1` — unresolved-customer path: the bulk-upload page
  // stashed {extraction, fileName} in sessionStorage ('bulk_po_review')
  // because no customer matched; replay it and let the user pick the
  // customer manually (Save creates a NEW CPO as usual).
  const reviewDraftParam = searchParams.get('draft') || '';
  const bulkReviewParam = searchParams.get('bulkReview') || '';
  // Guards the replay effect against React 18 StrictMode's dev
  // double-mount — same pattern as inboxLoadedRef above.
  const reviewLoadedRef = useRef(false);
  // Set once the draft's snapshot has been replayed. handleSubmit
  // switches from POST (create) to PUT (update this draft) when set.
  const [reviewDraftId, setReviewDraftId] = useState(null);
  // Holds the inbox row that this page session was opened from, so
  // we can flip it to PROCESSED only AFTER the user actually saves
  // the Customer PO (not when the extractor finishes). Survives the
  // URL-param strip that happens right after the attachment download.
  const pendingInboxIdRef = useRef('');
  const [isLoadingInboxFile, setIsLoadingInboxFile] = useState(Boolean(inboxId && inboxAttachmentId));
  const { options: companyOptions } = useLookup('/api/companies/');
  // State groups for the rate-overlay's state-aware matching. `raw`
  // gives us the full row (incl. member_states) so the client overlay
  // can short-circuit when it doesn't need a server round-trip.
  const { options: stateGroupOptions, raw: stateGroupsRaw } = useLookup('/api/state-groups/');
  // useApiData paginates through every page so the products referenced
  // by the price list are guaranteed to be present in `rawProducts`.
  // Using useLookup here would silently drop any product on page 2+.
  const { data: rawProducts } = useApiData('/api/products/');
  // useLookup caches the price-lists fetch at module level. If the
  // user just created or edited a price list in master and navigated
  // here, the cached list would be stale and the new entry would be
  // invisible. Clear the cache on mount.
  useEffect(() => { clearLookupCache('/api/price-lists/'); }, []);

  const [isLoading, setIsLoading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  // The customer PO file the user uploaded for extraction. Held in
  // parent state so we can feed it down to FileAttachments via the
  // `presetPendingFiles` prop and have it auto-attach to the saved
  // Customer PO record. Cleared on resetFormToDefaults so re-uploads
  // replace the previous attachment instead of stacking.
  const [extractedPoFile, setExtractedPoFile] = useState(null);
  const [poNo, setPoNo] = useState('');
  const [selectedCompany, setSelectedCompany] = useState('');
  const [filteredCustomers, setFilteredCustomers] = useState([]);
  const [filteredPriceLists, setFilteredPriceLists] = useState([]);
  const [priceLines, setPriceLines] = useState([]);

  useEffect(() => {
    // Review-replay keeps the draft's own upload_id in the PO No field
    // (set by the replay effect after the snapshot is applied) — skip
    // the next-number preview so its async response can't race in
    // afterwards and overwrite the number shown. If the draft turns
    // out to have no snapshot, the replay effect fetches the preview
    // itself as a fallback.
    if (reviewDraftParam) return;
    apiClient.get('/api/sales/customer-po/next-number/')
      .then(r => setPoNo(r.data?.number || ''))
      .catch(() => setPoNo(''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [formData, setFormData] = useState({
    company: '', customer: '',
    po_number: '', po_date: new Date().toISOString().split('T')[0],
    // Fields below were previously hard-coded to plausible defaults
    // (NET_15, EX_FACTORY, BY_ROAD, +15 days) but that misled users
    // when the PO + price list didn't actually carry those terms —
    // the form looked authoritative for values we'd invented. Now
    // they start blank; extraction / price-list autofill / the
    // mismatch confirmation modal fill them in when there's real
    // data, otherwise the user picks manually.
    price_list: '', payment_terms: '',
    // State group drives state-wise price-line matching. Auto-resolved
    // by the Gemini extractor (from header.consignee_address) and by
    // the resolver endpoint when the user edits the address. Manual
    // entry: user picks from the dropdown; their pick wins.
    state_group: '',
    currency: 'INR', required_ship_date: '',
    delivery_type: '',
    delivery_due_date: '',
    dispatched_through: '', consignee_name: '', consignee_address: '', consignee_gstin: '',
    billing_name: '', billing_address: '', billing_gstin: '',
    special_instructions: '',
    destination: '', remarks: '',
  });
  const [poLines, setPoLines] = useState([{ ...emptyLine }]);
  // Mirror of `poLines` for use inside useEffects that need the latest
  // value WITHOUT taking poLines as a dep (which would re-run the
  // effect on every keystroke and clobber manual edits). Updated after
  // every render below.
  const poLinesRef = useRef(poLines);
  useEffect(() => { poLinesRef.current = poLines; }, [poLines]);

  // Server-reported duplicate-PO error. Surfaces as a persistent banner
  // above the form so the user can choose to view the existing record
  // or change the PO number — instead of being silently redirected.
  const [duplicateError, setDuplicateError] = useState(null);
  // Clear the banner when the user changes the PO number — they're
  // attempting a fresh save with new input.
  useEffect(() => {
    if (duplicateError) setDuplicateError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.po_number]);

  // ── Price-list state, restructured into TWO single-responsibility
  // effects so the three pieces of state (dropdown options, the selected
  // list, and its lines) can never race or disagree:
  //
  //   Effect A (this one)  customer/company → filteredPriceLists + auto-pick
  //   Effect B (below)     formData.price_list → priceLines
  //
  // Every other code path (extraction, manual dropdown changes) now ONLY
  // sets formData.price_list and lets Effect B fetch the lines — there is
  // exactly one line-loader in the whole component.
  //
  // Effect A — options + auto-selection. Uses the SAME `for_customer`
  // endpoint the extractor uses, so the dropdown and the extraction can
  // never disagree about which lists exist for this customer/company (the
  // old version fetched ALL lists and re-filtered by name, which sometimes
  // excluded the very list the extractor had selected → blank dropdown).
  useEffect(() => {
    if (!formData.customer) { setFilteredPriceLists([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const url = formData.company
          ? `/api/price-lists/for_customer/?customer_id=${formData.customer}&company_id=${formData.company}`
          : `/api/price-lists/for_customer/?customer_id=${formData.customer}`;
        const res = await apiClient.get(url);
        if (cancelled) return;
        const lists = res.data?.results || res.data || [];
        const options = lists.map(pl => ({ value: pl.id, label: pl.price_list_id || pl.id }));
        setFilteredPriceLists(options);
        const ids = new Set(options.map(o => String(o.value)));
        // Preserve a still-valid selection (e.g. one the extractor just
        // made, or the user's manual pick); only auto-pick the currently-
        // effective list when nothing valid is currently chosen.
        if (!formData.price_list || !ids.has(String(formData.price_list))) {
          const recent = pickEffectivePriceList(lists);
          setFormData(prev => ({ ...prev, price_list: recent?.id || '' }));
        }
      } catch { if (!cancelled) setFilteredPriceLists([]); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.customer, formData.company]);

  // Effect B — the ONE place that loads price-list lines. Fires whenever
  // the selection changes (extraction, the auto-pick above, or a manual
  // dropdown change), so priceLines always corresponds to the list shown
  // in the dropdown.
  useEffect(() => {
    if (!formData.price_list) { setPriceLines([]); return; }
    let cancelled = false;
    apiClient.get(`/api/price-lists/${formData.price_list}/lines/`)
      .then(r => { if (!cancelled) setPriceLines(r.data?.results || r.data || []); })
      .catch(() => { if (!cancelled) setPriceLines([]); });
    return () => { cancelled = true; };
  }, [formData.price_list]);

  // Re-resolve every PO line's Rate / discount / GST whenever the
  // active price list's lines change.
  //
  // Why this is necessary: extraction fills rates synchronously using
  // whatever price list `autofillMatchedCustomer` happened to fetch
  // first, but the `fetchAndScope` effect above can then re-pick a
  // different (company-scoped) list and replace `priceLines`. Without
  // this effect, the table is stuck on the first list while the banner
  // and dropdown reflect the second — exactly the bug where a product
  // visibly present in the selected list still shows Rate = blank.
  // Re-applying on every `priceLines` change keeps Rate authoritative
  // for whichever list is actually selected.
  useEffect(() => {
    // Only re-resolve once a price list is actually loaded. An empty
    // `priceLines` could mean "list has zero items" OR "fetch hasn't
    // completed yet"; we can't tell the two apart, so we defer rather
    // than risk blanking valid manually-typed rates.
    if (priceLines.length === 0) return;
    const priceListIds = new Set(priceLines.map(p => String(p.product)));
    // Index the CURRENTLY-SELECTED price list by product name + SKU (also via
    // the master product, looked up in rawProducts). This lets us recover an
    // extraction row whose matched master is a DIFFERENT record than the one
    // this price list references for the SAME product (duplicate product
    // records). Without it, a product that's visibly on the selected list is
    // still exiled to the "not in price list" banner just because the UUIDs
    // differ — which is exactly "the product is in the dropdown but won't
    // auto-fill".
    const _norm = (s) => String(s || '').toUpperCase()
      .replace(/\([^)]*\)/g, ' ').replace(/[\.,;:'"&/\-%]/g, ' ')
      .split(/\s+/).filter(Boolean).sort().join(' ');
    const _masterById = new Map((rawProducts || []).map(p => [String(p.id), p]));
    const plByName = new Map();
    const plBySku = new Map();
    priceLines.forEach((pl) => {
      const m = _masterById.get(String(pl.product));
      [pl.product_name, m?.product_name].forEach((nm) => {
        const k = _norm(nm); if (k && !plByName.has(k)) plByName.set(k, pl);
      });
      [pl.product_sku, m?.sku_code, m?.product_sku].forEach((sk) => {
        const k = String(sk || '').toUpperCase().trim();
        if (k && !plBySku.has(k)) plBySku.set(k, pl);
      });
    });
    const _matchInSelected = (line) => {
      const sku = String(line.matched_product_sku || '').toUpperCase().trim();
      return (sku && plBySku.get(sku))
        || plByName.get(_norm(line.matched_product_name))
        || plByName.get(_norm(line.product_description))
        || null;
    };
    // Compute synchronously from the ref so we know `newlyExcluded`
    // is populated before we call setExtractedExcludedProducts. Doing
    // the work inside a setPoLines updater would defer it (the updater
    // is queued for the next render), so the excluded banner would
    // see an empty list at check time and stay green even though rows
    // had been dropped.
    const prev = poLinesRef.current;
    if (prev.length === 0) return;
    let changed = false;
    const next = [];
    const newlyExcluded = [];
    for (let line of prev) {
      // Filter pass — only applies to extraction-origin rows. If the
      // line was placed by the AI extractor and its product isn't on
      // the currently-selected price list, drop the row entirely (the
      // user asked for "only existing price-list products" in the
      // table) and record it for the banner. Manually-added rows have
      // no `from_extraction` flag and are always preserved so the
      // user can deliberately add off-list items.
      if (
        line.from_extraction
        && line.parsed_sku
        && !priceListIds.has(String(line.parsed_sku))
      ) {
        // The matched master may be a DIFFERENT record than the one the
        // selected price list uses for the SAME product. If the product is
        // genuinely on the selected list (by SKU or name), re-map the row
        // onto the list's product so it auto-fills, instead of exiling it
        // to the "not in price list" banner.
        const _hit = _matchInSelected(line);
        if (_hit && _hit.product) {
          line = { ...line, parsed_sku: String(_hit.product) };
          changed = true;
          // fall through to the rate re-application below
        } else {
          newlyExcluded.push({
            product_name: line.product_description || line.matched_product_name || '(unnamed)',
            product_sku: line.matched_product_sku || '',
            quantity: line.quantity || '',
            po_rate: line.po_rate || line.price || '',
            // Carry the PO's unit + codes so a later recovery restores
            // the row as ordered, not as the price list happens to price.
            uom: line.uom || '',
            hsn_code: line.hsn_code || '',
            item_code: line.item_code || '',
          });
          changed = true;
          continue;
        }
      }
      if (!line.parsed_sku) { next.push(line); continue; }
      // State-aware match. Precedence (mirrors the backend selector):
      //   1. (product, uom, state_group)  — exact state-specific row
      //   2. (product, uom, default)      — state_group=NULL fallback
      //   3. (product, state_group)       — UOM-less state-specific
      //   4. (product, default)           — legacy single-row catalog
      // Same product can be listed multiple times in a price list
      // when each row carries a different (uom, state_group, packing)
      // — picking the WRONG row would show the user a rate that
      // doesn't match what the SO conversion will eventually use.
      const lineUom = uomKey(line.uom);
      const sgId = formData.state_group ? String(formData.state_group) : '';
      const isSg = (p) => sgId
        ? String(p.state_group || '') === sgId
        : !p.state_group;  // default-row preference when no group set
      const isDefault = (p) => !p.state_group;
      let pl = null;
      if (lineUom) {
        // State-specific UOM-match first.
        pl = priceLines.find(p =>
          String(p.product) === String(line.parsed_sku)
          && uomKey(p.uom) === lineUom
          && isSg(p),
        );
        if (!pl && sgId) {
          // Default-row UOM-match as fallback.
          pl = priceLines.find(p =>
            String(p.product) === String(line.parsed_sku)
            && uomKey(p.uom) === lineUom
            && isDefault(p),
          );
        }
      }
      if (!pl) {
        pl = priceLines.find(p => String(p.product) === String(line.parsed_sku) && isSg(p));
      }
      if (!pl && sgId) {
        pl = priceLines.find(p => String(p.product) === String(line.parsed_sku) && isDefault(p));
      }
      if (!pl) {
        pl = priceLines.find(p => String(p.product) === String(line.parsed_sku));
      }
      const hasPlRate = pl && pl.rate !== undefined && pl.rate !== null && pl.rate !== '';
      // Restate the PL rate per the line's UOM (e.g. per-MTS → per-KG) so the
      // amount isn't 1000x off when the PO qty is in KG but the price is per MT.
      const newPrice = hasPlRate ? String(rateForLineUom(pl.rate, pl.uom, line.uom)) : '';
      // Lines waiting on user confirmation OR explicitly left blank by
      // the user are off-limits to the auto re-resolver — overwriting
      // either case would re-apply PL values the user hasn't agreed to
      // (pending) or actively rejected (dismissed). RATE is the one
      // exception: price is never part of the deferral (it's
      // PL-authoritative), so it must still follow the selected list —
      // otherwise a price-list switch leaves a stale rate on the row.
      if (line._pl_pending || line._pl_dismissed) {
        if (hasPlRate && line.price !== newPrice) {
          changed = true;
          next.push({ ...line, price: newPrice });
        } else {
          next.push(line);
        }
        continue;
      }
      const newDiscount = pl && pl.discount !== undefined && pl.discount !== null && pl.discount !== ''
        ? String(pl.discount)
        : '0';
      // No price-list entry → zero out every commercial field. The
      // banner above the table calls these lines out by name; we
      // don't want any partially-autofilled GST values from the
      // Gemini extract leaking into a row the user must touch
      // manually anyway.
      const newSgst = pl && pl.sgst_rate !== undefined && pl.sgst_rate !== null && pl.sgst_rate !== ''
        ? String(pl.sgst_rate)
        : '0';
      const newCgst = pl && pl.cgst_rate !== undefined && pl.cgst_rate !== null && pl.cgst_rate !== ''
        ? String(pl.cgst_rate)
        : '0';
      const newIgst = pl && pl.igst_rate !== undefined && pl.igst_rate !== null && pl.igst_rate !== ''
        ? String(pl.igst_rate)
        : '0';
      // PO-authoritative guard for DISCOUNT + GST flavours — those
      // values can legitimately differ from the PL default (CGST/SGST
      // depend on supply state, customer registration, etc.) and the
      // PO is the document being honoured. Without this guard a PO
      // that printed CGST 2.5% / SGST 2.5% would get silently
      // rewritten to the PL's 9% / 9% the moment priceLines landed
      // (the bug originally reported on the SS Biochem PO).
      //
      // RATE (price) is INTENTIONALLY excluded from the guard — the
      // price list is the contracted rate, so we always overwrite
      // the PO's printed rate with the PL value when one exists.
      // The PO's printed rate stays on `po_rate` for visibility.
      const poFields = new Set(line._po_fields || []);
      // Cross-regime gate: a PO prints exactly one GST regime —
      // inter-state (IGST) or intra-state (CGST+SGST). If the PO printed
      // one regime, PL values from the OTHER regime must not be applied,
      // or the line ends up taxed under both at once.
      const poHasIgstField = poFields.has('igst_percent');
      const poHasSplitField = poFields.has('sgst_percent') || poFields.has('cgst_percent');
      const merged = {
        // PL wins for price. Fall back to whatever the line already
        // has (which would be the PO's rate, preserved from the
        // initial mapping) when the PL doesn't carry a rate.
        price:         hasPlRate ? newPrice : line.price,
        discount:      poFields.has('discount')      ? line.discount      : newDiscount,
        sgst_percent:  (poFields.has('sgst_percent') || poHasIgstField)  ? line.sgst_percent  : newSgst,
        cgst_percent:  (poFields.has('cgst_percent') || poHasIgstField)  ? line.cgst_percent  : newCgst,
        igst_percent:  (poFields.has('igst_percent') || poHasSplitField) ? line.igst_percent  : newIgst,
      };
      if (
        line.price === merged.price
        && line.discount === merged.discount
        && line.sgst_percent === merged.sgst_percent
        && line.cgst_percent === merged.cgst_percent
        && line.igst_percent === merged.igst_percent
      ) { next.push(line); continue; }
      changed = true;
      next.push({ ...line, ...merged });
    }
    // ── Banner → table recovery ──────────────────────────────────────
    // Products earlier exiled to the "not in price list" banner (e.g. the
    // price list wasn't loaded yet at extraction time, or the customer /
    // company resolved late) must come BACK into the table once the
    // now-selected price list actually contains them — otherwise selecting
    // the correct list still leaves them stranded in the red banner. Match
    // each banner product against the selected list by SKU then name; on a
    // hit, add a row with the rate auto-filled and drop it from the banner.
    const recoveredKeys = new Set();
    const _existingProducts = new Set(next.filter(l => l.parsed_sku).map(l => String(l.parsed_sku)));
    const _existingNames = new Set(next.map(l => _norm(l.matched_product_name || l.product_description)).filter(Boolean));
    for (const ex of (extractedExcludedRef.current || [])) {
      const key = `${ex.product_sku}|${ex.product_name}`;
      const sku = String(ex.product_sku || '').toUpperCase().trim();
      const hit = (sku && plBySku.get(sku)) || plByName.get(_norm(ex.product_name)) || null;
      if (!hit || !hit.product) continue;
      // Already represented in the table (same product or same name) — just
      // clear it from the banner, don't add a duplicate row.
      if (_existingProducts.has(String(hit.product)) || _existingNames.has(_norm(ex.product_name))) {
        recoveredKeys.add(key);
        continue;
      }
      const _v = (x) => (x !== undefined && x !== null && x !== '') ? String(x) : '';
      // The PO's printed unit (stashed on exclusion) wins over the
      // price-list UOM, and the PL rate is restated per that unit so
      // Amount = qty × rate stays correct across unit scales.
      const poUom = normalizeUom(ex.uom) || '';
      next.push({
        ...emptyLine,
        parsed_sku: String(hit.product),
        from_extraction: true,
        product_description: ex.product_name,
        matched_product_name: ex.product_name,
        matched_product_sku: ex.product_sku || '',
        quantity: ex.quantity != null ? String(ex.quantity) : '',
        po_rate: ex.po_rate != null ? String(ex.po_rate) : '',
        uom: poUom || hit.uom || emptyLine.uom,
        hsn_code: ex.hsn_code || emptyLine.hsn_code,
        item_code: ex.item_code || emptyLine.item_code,
        price: (hit.rate !== undefined && hit.rate !== null && hit.rate !== '')
          ? String(rateForLineUom(hit.rate, hit.uom, poUom || hit.uom))
          : '',
        discount: _v(hit.discount) || '0',
        gst: _v(hit.gst) || '0',
        sgst_percent: _v(hit.sgst_rate) || '0',
        cgst_percent: _v(hit.cgst_rate) || '0',
        igst_percent: _v(hit.igst_rate) || '0',
      });
      recoveredKeys.add(key);
      _existingProducts.add(String(hit.product));
      _existingNames.add(_norm(ex.product_name));
      changed = true;
    }
    // Keep at least one editable row so the table isn't empty when
    // every extracted line gets filtered out by a price-list switch.
    if (next.length === 0) next.push({ ...emptyLine });
    if (changed) setPoLines(next);
    if (newlyExcluded.length > 0 || recoveredKeys.size > 0) {
      setExtractedExcludedProducts(curr => {
        // Drop anything we just pulled back into the table, then add the
        // newly-excluded rows and de-dupe.
        const kept = curr.filter(p => !recoveredKeys.has(`${p.product_sku}|${p.product_name}`));
        const merged = [...kept, ...newlyExcluded];
        const seen = new Set();
        return merged.filter(p => {
          const key = `${p.product_sku}|${p.product_name}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceLines, formData.state_group, (rawProducts || []).length]);

  // ── AI extract state ─────────────────────────────────────────────
  // Uploading a PO file (PDF / image / DOCX) hits the Gemini-backed
  // /api/sales/customer-po/extract/ endpoint and autofills as much of
  // the form as can be parsed. Anything the model wasn't confident
  // about lands in `lowConfidenceFields` so we can flag those inputs.
  const [isExtracting, setIsExtracting] = useState(false);
  // Products the Gemini extract matched to Product master but that are
  // missing from the customer's selected price list. We DON'T render
  // those rows in the table (the user asked for "only existing
  // price-list product rows"), so we stash the descriptions here so the
  // red banner can still tell the user exactly what got dropped.
  const [extractedExcludedProducts, setExtractedExcludedProducts] = useState([]);
  // Mirror of the banner list so the price-list re-resolver (which can't take
  // it as a dependency without looping) can read the current excluded set and
  // pull any product back into the table once the selected price list
  // actually contains it.
  const extractedExcludedRef = useRef([]);
  useEffect(() => { extractedExcludedRef.current = extractedExcludedProducts; }, [extractedExcludedProducts]);
  const [extractMeta, setExtractMeta] = useState(null); // { file_name, overall_confidence, low_confidence_fields }
  // Post-extract reconciliation dialog. Fires when the PO upload finishes
  // but one or more header fields the price list defaults (payment_terms,
  // delivery_type, currency, freight_terms) came back EMPTY from the PO
  // while the price-list HAS a value for them. The user picks between
  // "use price-list defaults" (fill them in) and "use extraction data"
  // (leave them blank — they really weren't on the PO).
  // ─── Combined extraction-review modal ──────────────────────────────
  // Single popup that lists EVERYTHING the user needs to confirm after
  // a PO upload — fuzzy customer / company matches AND header fields
  // the PO didn't print but the price list defaults. Previously these
  // were two separate modals shown in sequence; users hated the
  // pop-then-pop-again UX and asked for a unified table.
  //
  // Each item in the list has:
  //   id          — stable React key
  //   group       — 'match' | 'field'   (drives sub-section header)
  //   label       — short row label (e.g. "Customer", "Payment Terms")
  //   description — small subtitle under the row (similarity %, etc.)
  //   extractedLabel/Value  — left column ("from the PO")
  //   suggestedLabel/Value  — right column ("from master / price list")
  //   similarity  — 0..1 or null (no chip when null)
  //   onAccept    — called when the user clicks ✓ (apply suggested)
  //   onReject    — called when the user clicks ✗ (keep extracted /
  //                  leave blank — semantics depend on item kind)
  //   defaultDecision — 'accepted' for fuzzy matches that were
  //                  auto-applied during extract (so the row already
  //                  shows ✓), 'pending' for missing-field items
  //   decision    — null until user clicks; then 'accepted' | 'rejected'
  // Empty array (default) means nothing to confirm and the modal
  // stays closed.
  const [confirmReview, setConfirmReview] = useState([]);
  const lowConfidence = new Set(extractMeta?.low_confidence_fields || []);

  // 'manual' = regular keyed-in form; 'auto' = Gemini upload card visible.
  // Default to 'auto' so the Create button lands the operator on the
  // upload card — the AI extractor is the primary intake path for
  // customer POs; manual entry is a fallback when a PO doesn't have
  // a usable file. The two modes share no state — switching wipes the
  // form so values from one workflow can't bleed into the other.
  const [entryMode, setEntryMode] = useState('auto');

  const defaultFormData = () => ({
    company: '', customer: '',
    po_number: '', po_date: new Date().toISOString().split('T')[0],
    // Keep this in lockstep with the useState initialiser above —
    // every previously hardcoded "sensible default" is blank now so
    // the form only shows values that came from extraction, the
    // matched price list, or an explicit user pick. INR stays as
    // the currency baseline because this is an India-only ERP and
    // a blank currency would just need a manual click for every PO.
    price_list: '', payment_terms: '',
    currency: 'INR', required_ship_date: '',
    delivery_type: '',
    delivery_due_date: '',
    dispatched_through: '', consignee_name: '', consignee_address: '', consignee_gstin: '',
    billing_name: '', billing_address: '', billing_gstin: '',
    special_instructions: '',
    destination: '', remarks: '',
  });

  const resetFormToDefaults = () => {
    setFormData(defaultFormData());
    setPoLines([{ ...emptyLine }]);
    setPendingAttachments([]);
    setSelectedCompany('');
    setFilteredCustomers([]);
    setFilteredPriceLists([]);
    setPriceLines([]);
    setCustomerAddresses([]);
    setSelectedShipIdx(0);
    setExtractMeta(null);
    setExtractedExcludedProducts([]);
    setExtractedPoFile(null);
    setConfirmReview([]);
  };

  const switchEntryMode = (next) => {
    if (next === entryMode) return;
    setEntryMode(next);
    resetFormToDefaults();
  };

  // ── Manual Entry: auto-fill the product table from the price list ─────
  // When the operator picks a price list in Manual Entry (or one gets
  // auto-picked for the chosen customer), drop one product row per
  // price-list item into the table — pre-filled with Rate / Discount /
  // GST / HSN / UOM. The operator then types quantities and deletes any
  // rows they don't need (every row has a Remove button). The Auto
  // Extractor path is untouched — it builds its rows from the uploaded PO.
  const manualPlPopulatedRef = useRef('');
  const buildManualLinesFromPriceList = (pls) => {
    const _v = (x) => (x !== undefined && x !== null && x !== '') ? String(x) : '';
    const masterById = new Map((rawProducts || []).map(p => [String(p.id), p]));
    // A product can appear more than once in a list (per UOM / state
    // group). Show it once — the first row — and let the price-list
    // re-resolver refine the exact rate for the line's UOM / state.
    const seen = new Set();
    const lines = [];
    for (const pl of pls) {
      const pid = String(pl.product || '');
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      const prod = masterById.get(pid);
      const sgst = _v(pl.sgst_rate) || '0';
      const cgst = _v(pl.cgst_rate) || '0';
      const igst = _v(pl.igst_rate) || '0';
      const gstTotal = (parseFloat(sgst) || 0) + (parseFloat(cgst) || 0) + (parseFloat(igst) || 0);
      lines.push({
        ...emptyLine,
        product_category: prod?.goods_sub_type || emptyLine.product_category,
        parsed_sku: pid,
        product_description: prod?.product_name || pl.product_name || '',
        item_code: prod?.sku_code || pl.product_sku || '',
        hsn_code: _v(pl.hsn_code),
        quantity: '',
        uom: pl.uom || prod?.uom || emptyLine.uom,
        price: _v(pl.rate),
        discount: _v(pl.discount) || '0',
        sgst_percent: sgst,
        cgst_percent: cgst,
        igst_percent: igst,
        gst: gstTotal ? String(gstTotal) : (_v(pl.gst) || '0'),
      });
    }
    return lines;
  };

  useEffect(() => {
    if (entryMode !== 'manual') return;
    if (!formData.price_list) { manualPlPopulatedRef.current = ''; return; }
    // Wait until BOTH the price-list lines and the product master have
    // loaded, else category / name / SKU cells would come out blank.
    if (priceLines.length === 0 || (rawProducts || []).length === 0) return;
    // Populate once per selected list. Re-selecting a DIFFERENT list
    // repopulates; edits to an already-populated list are preserved.
    if (manualPlPopulatedRef.current === formData.price_list) return;
    const built = buildManualLinesFromPriceList(priceLines);
    if (built.length === 0) return;
    manualPlPopulatedRef.current = formData.price_list;
    setPoLines(built);
    toast.success(`Loaded ${built.length} product${built.length > 1 ? 's' : ''} from the price list — delete any rows you don't need.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryMode, formData.price_list, priceLines, rawProducts]);

  // ── Regional-variant disambiguation ────────────────────────────────
  // Some customers exist as multiple master records that share a base
  // name but split by region — "Greenstar Fertilisers Limited - North"
  // vs "- South", "S.S. Biochem (East)" vs "(West)", etc. The backend
  // fuzzy matcher strips NORTH/SOUTH/EAST/WEST as stopwords so both
  // candidates score identically — whichever is picked is arbitrary.
  //
  // When we detect that the matched name carries a regional suffix
  // (and therefore likely has siblings), we re-score every sibling
  // candidate against the PO's printed ship-to address and pick the
  // one whose master addresses best align. PIN-code equality wins; a
  // strong token overlap on the raw text is the fallback.
  //
  // Returns the (possibly overridden) `{ id, name, reason, switched }`.
  // `reason` is one of:
  //   'no_regional_variant' — name has no -North/-South/etc, no change
  //   'no_siblings_found'   — couldn't fetch siblings, no change
  //   'switched_by_address' — picked a different sibling via address match
  //   'kept_low_confidence' — siblings exist but no address match, kept original
  //   'kept_confirmed'      — siblings exist, address match confirms backend pick
  const REGIONAL_SUFFIX_RE = /[\s\-_(\[]+\s*(north|south|east|west|central|n|s|e|w)\b\s*[)\]]?\s*$/i;
  const stripRegionalSuffix = (name) => {
    const s = String(name || '').trim();
    return s.replace(REGIONAL_SUFFIX_RE, '').replace(/[\s\-_(\[]+$/, '').trim();
  };
  const hasRegionalSuffix = (name) => REGIONAL_SUFFIX_RE.test(String(name || '').trim());

  // Deterministic India-state → region map. Backs the regional-variant
  // disambiguator's name-vs-state fallback: when neither the address
  // Jaccard scorer nor the LLM can decide between "Customer - North"
  // and "Customer - South" siblings, we look at the PO ship-to's
  // state, derive its region, and pick the sibling whose name suffix
  // matches. KRISHNAGIRI Tamil Nadu → SOUTH → "- South" wins.
  const STATE_TO_REGION = {
    // South
    'TAMIL NADU': 'SOUTH', 'TAMILNADU': 'SOUTH', 'TN': 'SOUTH',
    'KARNATAKA': 'SOUTH', 'KA': 'SOUTH',
    'KERALA': 'SOUTH', 'KL': 'SOUTH',
    'ANDHRA PRADESH': 'SOUTH', 'AP': 'SOUTH',
    'TELANGANA': 'SOUTH', 'TS': 'SOUTH', 'TG': 'SOUTH',
    'PUDUCHERRY': 'SOUTH', 'PONDICHERRY': 'SOUTH', 'PY': 'SOUTH',
    // North
    'PUNJAB': 'NORTH', 'PB': 'NORTH',
    'HARYANA': 'NORTH', 'HR': 'NORTH',
    'UTTAR PRADESH': 'NORTH', 'UTTARPRADESH': 'NORTH', 'UP': 'NORTH',
    'UTTARAKHAND': 'NORTH', 'UK': 'NORTH', 'UT': 'NORTH',
    'HIMACHAL PRADESH': 'NORTH', 'HIMACHALPRADESH': 'NORTH', 'HP': 'NORTH',
    'DELHI': 'NORTH', 'DL': 'NORTH', 'NEW DELHI': 'NORTH',
    'JAMMU AND KASHMIR': 'NORTH', 'JAMMU & KASHMIR': 'NORTH', 'JK': 'NORTH',
    'LADAKH': 'NORTH', 'LA': 'NORTH',
    'CHANDIGARH': 'NORTH', 'CH': 'NORTH',
    'RAJASTHAN': 'NORTH', 'RJ': 'NORTH',
    // West
    'MAHARASHTRA': 'WEST', 'MH': 'WEST',
    'GUJARAT': 'WEST', 'GJ': 'WEST',
    'GOA': 'WEST', 'GA': 'WEST',
    // East
    'WEST BENGAL': 'EAST', 'WESTBENGAL': 'EAST', 'WB': 'EAST',
    'ODISHA': 'EAST', 'ORISSA': 'EAST', 'OR': 'EAST',
    'BIHAR': 'EAST', 'BR': 'EAST',
    'JHARKHAND': 'EAST', 'JH': 'EAST',
    // North-East
    'ASSAM': 'EAST', 'AS': 'EAST',
    'ARUNACHAL PRADESH': 'EAST', 'AR': 'EAST',
    'MANIPUR': 'EAST', 'MN': 'EAST',
    'MEGHALAYA': 'EAST', 'ML': 'EAST',
    'MIZORAM': 'EAST', 'MZ': 'EAST',
    'NAGALAND': 'EAST', 'NL': 'EAST',
    'SIKKIM': 'EAST', 'SK': 'EAST',
    'TRIPURA': 'EAST', 'TR': 'EAST',
    // Central
    'MADHYA PRADESH': 'CENTRAL', 'MADHYAPRADESH': 'CENTRAL', 'MP': 'CENTRAL',
    'CHHATTISGARH': 'CENTRAL', 'CHATTISGARH': 'CENTRAL', 'CG': 'CENTRAL',
  };
  const regionFromState = (stateName) => {
    if (!stateName) return '';
    const key = String(stateName).toUpperCase().trim();
    if (STATE_TO_REGION[key]) return STATE_TO_REGION[key];
    const squashed = key.replace(/\s+/g, '');
    return STATE_TO_REGION[squashed] || '';
  };
  // Pull the region keyword out of a customer name's regional suffix.
  // "Greenstar Fertilisers Limited - South" → "SOUTH". Used to match
  // a sibling's region against the PO ship-to's region.
  const SUFFIX_TO_REGION = { NORTH: 'NORTH', SOUTH: 'SOUTH', EAST: 'EAST', WEST: 'WEST', CENTRAL: 'CENTRAL', N: 'NORTH', S: 'SOUTH', E: 'EAST', W: 'WEST' };
  const regionFromCustomerName = (name) => {
    const m = String(name || '').trim().match(REGIONAL_SUFFIX_RE);
    if (!m) return '';
    return SUFFIX_TO_REGION[String(m[1]).toUpperCase()] || '';
  };

  const disambiguateRegionalVariant = async (matchedCustomer, poConsigneeAddress) => {
    // matchedCustomer: { id, name } — what the backend picked.
    const matchedName = matchedCustomer?.name || '';
    const matchedId   = matchedCustomer?.id   || '';
    const baseName    = stripRegionalSuffix(matchedName);
    if (!hasRegionalSuffix(matchedName) || !poConsigneeAddress) {
      return { id: matchedId, name: matchedName, reason: 'no_regional_variant', switched: false };
    }
    // Fetch siblings by searching on the bare base name. The vendor
    // viewset's SearchFilter already handles partial matches.
    let candidates = [];
    try {
      const res = await _getWithRetry(`/api/customers/?search=${encodeURIComponent(baseName)}&page_size=20`);
      const rows = res.data?.results || res.data || [];
      // Keep only rows whose base name (after stripping regional suffix
      // + normalising) matches our base — drops unrelated companies
      // whose names happen to share a token.
      const targetBase = baseName.toLowerCase().replace(/\s+/g, ' ').trim();
      candidates = rows.filter(r => {
        const rb = stripRegionalSuffix(r.customer_name || '').toLowerCase().replace(/\s+/g, ' ').trim();
        return rb === targetBase;
      });
    } catch {
      return { id: matchedId, name: matchedName, reason: 'no_siblings_found', switched: false };
    }
    if (candidates.length <= 1) {
      // Only one variant exists — backend's pick is correct by default.
      return { id: matchedId, name: matchedName, reason: 'no_regional_variant', switched: false };
    }
    // Score each candidate by best shipping-address match against the
    // PO ship-to. Higher = better; ≥0.4 is the floor for "real match"
    // (matches compareShippingAddress's own threshold).
    let best = { id: matchedId, name: matchedName, score: -1 };
    let backendScore = -1;
    for (const c of candidates) {
      const addrs = (c.shipping_addresses || []).map((sa) => ({
        address: sa.address
          ? (typeof sa.address === 'object' ? stringifyAddress(sa.address) : sa.address)
          : '',
      }));
      const cmp = compareShippingAddress(poConsigneeAddress, addrs);
      const score = cmp.bestScore || 0;
      if (c.id === matchedId) backendScore = score;
      if (score > best.score) {
        best = { id: c.id, name: c.customer_name, score };
      }
    }
    // Deterministic scoring was inconclusive — try one more
    // deterministic signal before reaching for the LLM: derive the
    // PO ship-to's region (SOUTH/NORTH/EAST/WEST/CENTRAL) from its
    // state, and look for a sibling whose name suffix matches. The
    // common case "Krishnagiri TN → SOUTH → Greenstar - South" is
    // unambiguous and doesn't need an API key. We only trust this
    // when EXACTLY ONE sibling matches the region — otherwise we
    // still fall through to the LLM.
    if (best.score < 0.4) {
      const poAddr = parseAddress(poConsigneeAddress);
      const poRegion = regionFromState(poAddr.state);
      if (poRegion) {
        const regionMatches = candidates.filter(c => regionFromCustomerName(c.customer_name) === poRegion);
        if (regionMatches.length === 1) {
          const winner = regionMatches[0];
          if (winner.id !== matchedId) {
            return {
              id: winner.id,
              name: winner.customer_name,
              reason: 'switched_by_region',
              switched: true,
              backendScore,
              previousName: matchedName,
              poRegion,
            };
          }
          return {
            id: matchedId,
            name: matchedName,
            reason: 'kept_confirmed_by_region',
            switched: false,
            backendScore,
            poRegion,
          };
        }
      }
    }
    // Still inconclusive — fall back to Gemini.
    // The LLM knows Indian geography (Krishnagiri = southern TN, etc.)
    // and can disambiguate when none of the saved addresses share a
    // PIN or token overlap with the printed ship-to. Failure modes:
    //   - GEMINI_API_KEY not set on server → 503 → keep backend pick
    //   - LLM abstains (chosen_id: null) → keep backend pick + warn
    //   - LLM picks a sibling → switch with that as the reason
    if (best.score < 0.4) {
      try {
        const res = await apiClient.post('/api/sales/disambiguate-customer-variant/', {
          po_ship_to: poConsigneeAddress,
          candidates: candidates.map(c => ({
            id: c.id,
            name: c.customer_name,
            addresses: (c.shipping_addresses || []).map(sa =>
              sa.address
                ? (typeof sa.address === 'object' ? stringifyAddress(sa.address) : sa.address)
                : '',
            ).filter(Boolean),
          })),
        }, { timeout: 35000 });
        const llm = res.data || {};
        if (llm.chosen_id && llm.chosen_id !== matchedId) {
          const winner = candidates.find(c => c.id === llm.chosen_id);
          if (winner) {
            return {
              id: winner.id,
              name: winner.customer_name,
              reason: 'switched_by_llm',
              switched: true,
              backendScore,
              llmConfidence: llm.confidence,
              llmReason: llm.reason,
              previousName: matchedName,
            };
          }
        }
        if (llm.chosen_id === matchedId) {
          return { id: matchedId, name: matchedName, reason: 'kept_confirmed_by_llm', switched: false, backendScore, llmConfidence: llm.confidence };
        }
      } catch (err) {
        // Endpoint missing / Gemini down / API key absent — fall
        // through to the legacy "keep + warn" path. Log so ops can
        // notice if this happens regularly.
        // eslint-disable-next-line no-console
        console.warn('[regional disambiguation] LLM fallback unavailable', err?.response?.status, err?.message);
      }
      return { id: matchedId, name: matchedName, reason: 'kept_low_confidence', switched: false, backendScore };
    }
    // The backend already picked the highest-scoring variant.
    if (best.id === matchedId) {
      return { id: matchedId, name: matchedName, reason: 'kept_confirmed', switched: false, backendScore };
    }
    // A different sibling won on address — switch.
    return {
      id: best.id,
      name: best.name,
      reason: 'switched_by_address',
      switched: true,
      backendScore,
      newScore: best.score,
      previousName: matchedName,
    };
  };

  // Company-based disambiguation. Some customers exist as MULTIPLE master
  // records with the EXACT same name, each registered under a different
  // Company (e.g. "T.Stanes And Company Ltd., - Coimbatore" exists once
  // under United Agro Industries and once under SS Biochem India). The
  // backend name/GSTIN matcher has no way to know which seller the PO is
  // for, so it may pick the record under the wrong company — which then
  // trips the company ↔ customer mismatch lock. Before locking, look for a
  // same-name sibling registered under the PO's resolved seller company and
  // switch to it. Returns { id, name, switched }.
  const disambiguateByCompany = async (matchedCustomer, poCompanyId) => {
    const matchedId   = matchedCustomer?.id   || '';
    const matchedName = matchedCustomer?.name || '';
    if (!poCompanyId || !matchedName) {
      return { id: matchedId, name: matchedName, switched: false };
    }
    let rows = [];
    try {
      const res = await _getWithRetry(`/api/customers/?search=${encodeURIComponent(matchedName)}&page_size=20`);
      rows = res.data?.results || res.data || [];
    } catch {
      return { id: matchedId, name: matchedName, switched: false };
    }
    // Same-name siblings only (exact normalised-name equality), so we never
    // jump to an unrelated customer that merely shares a search token.
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const target = norm(matchedName);
    const siblings = rows.filter(r => norm(r.customer_name) === target);
    if (siblings.length <= 1) {
      return { id: matchedId, name: matchedName, switched: false };
    }
    // Already registered under the PO's company → nothing to do.
    const current = siblings.find(r => String(r.id) === String(matchedId));
    if (current && String(current.company) === String(poCompanyId)) {
      return { id: matchedId, name: matchedName, switched: false };
    }
    // Exactly one same-name sibling sits under the PO's company → that's
    // the right record. (If several do, it's genuinely ambiguous — leave
    // the mismatch lock to surface it rather than guessing.)
    const underPoCompany = siblings.filter(r => String(r.company) === String(poCompanyId));
    if (underPoCompany.length === 1 && String(underPoCompany[0].id) !== String(matchedId)) {
      const w = underPoCompany[0];
      return { id: w.id, name: w.customer_name, switched: true, previousName: matchedName };
    }
    return { id: matchedId, name: matchedName, switched: false };
  };

  // Pure helper: does the printed ship-to on the PO match a shipping
  // address we already have for this customer? Returns the matched
  // index (or -1) and a small status object for the UI.
  //
  // Matching strategy:
  //   1. Exact pincode equality (strongest signal). If multiple addrs
  //      share that pincode, pick the highest fuzzy-overlap on the
  //      raw text.
  //   2. Token-overlap fallback when pincode is missing/ambiguous —
  //      we require ≥40% Jaccard overlap on the address text to avoid
  //      latching onto an unrelated entry.
  const compareShippingAddress = (poConsignee, customerAddrs) => {
    if (!poConsignee || !customerAddrs || customerAddrs.length === 0) {
      return { matchedIndex: -1, reason: customerAddrs?.length ? 'no_po_address' : 'no_customer_addresses' };
    }
    const poParsed = parseAddress(poConsignee);
    const poPin = (poParsed.pincode || '').trim();
    const tokenize = (s) => new Set(
      String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean),
    );
    const poTokens = tokenize(poParsed.raw_address || poConsignee);

    let matchedIndex = -1;
    let bestScore = 0;
    customerAddrs.forEach((sa, i) => {
      const cParsed = parseAddress(sa.address);
      const cPin = (cParsed.pincode || '').trim();
      const cTokens = tokenize(cParsed.raw_address || sa.address);
      const overlap = poTokens.size && cTokens.size
        ? [...poTokens].filter(t => cTokens.has(t)).length / new Set([...poTokens, ...cTokens]).size
        : 0;
      let score = 0;
      if (poPin && cPin && poPin === cPin) score = 1.0 + overlap;
      else score = overlap;
      if (score > bestScore) { bestScore = score; matchedIndex = i; }
    });
    // Token overlap below 40% with no pincode hit ⇒ no real match.
    if (bestScore < 0.4) return { matchedIndex: -1, reason: 'no_match', bestScore };
    return { matchedIndex, reason: 'matched', bestScore };
  };

  // Hard-fetches a customer by id and primes every field that the
  // normal `handleChange('customer', ...)` flow would have populated:
  //   - formData.customer / consignee_name / consignee_gstin
  //   - customerAddresses + the first one as consignee_address
  //   - filteredPriceLists for the picker
  //   - injects the customer into filteredCustomers so the dropdown
  //     shows it even if the company-scoped list didn't return it.
  // Used by the extraction flow because the regular dropdown-based
  // flow races against the /api/customers/?company=… fetch.
  //
  // `poConsigneeAddress` (optional) is the ship-to printed on the
  // uploaded PO; we use it to pick the right shipping address row
  // from the customer's master list and to flag a mismatch when the
  // PO ships to an address the customer doesn't have on file.
  // Single-retry GET helper for endpoints that occasionally drop right
  // after a long Gemini call (dev server still draining the previous
  // long-poll, transient CORS preflight, etc.). Only retries when the
  // first failure had no response object — actual HTTP error responses
  // (404, 403, 500) are propagated immediately so we don't mask real
  // server-side failures behind a delay.
  const _getWithRetry = async (url, opts = {}) => {
    try {
      return await apiClient.get(url, { timeout: 60000, ...opts });
    } catch (err) {
      const noResponse = !err?.response;
      const isAbort = err?.code === 'ECONNABORTED';
      if (!noResponse && !isAbort) throw err;
      await new Promise(r => setTimeout(r, 600));
      return apiClient.get(url, { timeout: 60000, ...opts });
    }
  };

  const autofillMatchedCustomer = async (customerId, poConsigneeAddress = '', customerHint = {}, companyHint = '', preferredPriceListId = '') => {
    if (!customerId) return { shipping: null, priceListLines: [] };

    // ── Optimistic injection (CANNOT FAIL) ─────────────────────────
    // Inject the customer into the dropdown + formData from the
    // backend's `customer_match` payload that the caller passes via
    // `customerHint`. This happens BEFORE any network call, so even
    // if every subsequent fetch fails, the customer stays selected.
    // Previously a single transient hiccup on `/api/customers/{id}/`
    // dropped the entire selection back to "Select Customer" and
    // showed a scary "Network error" toast even though the matching
    // succeeded — that's the bug this guards against.
    const hintName = (customerHint.name || '').toString().trim();
    const hintGstin = (customerHint.gstin || '').toString().trim();
    setFilteredCustomers(prev => {
      const without = prev.filter(c => c.value !== customerId);
      return [{
        value: customerId,
        label: hintName || customerId,
        raw: { id: customerId, customer_name: hintName, gstin: hintGstin },
      }, ...without];
    });
    setFormData(prev => ({
      ...prev,
      customer: customerId,
      consignee_name: prev.consignee_name || hintName || '',
      consignee_gstin: prev.consignee_gstin || hintGstin || '',
    }));

    // ── Best-effort enrichment ─────────────────────────────────────
    // Try to fetch the full customer record so we can populate the
    // shipping-addresses dropdown and replace the dropdown label
    // with the richer master name. If this fails (timeout, 500,
    // transient network) we silently keep the optimistic state —
    // NO TOAST, NO BAILOUT.
    let cust = null;
    try {
      const res = await _getWithRetry(`/api/customers/${customerId}/`);
      cust = res.data || {};
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[autofillMatchedCustomer] /api/customers/{id}/ failed, keeping optimistic selection', {
        url: `/api/customers/${customerId}/`,
        status: err?.response?.status,
        code: err?.code,
        message: err?.message,
      });
    }

    let shippingStatus = { matchedIndex: -1, reason: 'no_match', bestScore: 0 };
    let addrs = [];
    if (cust) {
      // Upgrade dropdown entry with richer master-side data.
      setFilteredCustomers(prev => {
        const dropdownEntry = {
          value: cust.id || customerId,
          label: cust.customer_name || cust.name || hintName || cust.id || customerId,
          raw: cust,
        };
        const without = prev.filter(c => c.value !== dropdownEntry.value);
        return [dropdownEntry, ...without];
      });

      addrs = (cust.shipping_addresses || []).map((sa, i) => ({
        label: sa.address_label || `Shipping Address ${i + 1}`,
        address: sa.address
          ? (typeof sa.address === 'object' ? stringifyAddress(sa.address) : sa.address)
          : '',
        contact: sa.contact_person || '',
        phone: sa.contact_phone || '',
        type: 'shipping',
      }));
      setCustomerAddresses(addrs);
      shippingStatus = compareShippingAddress(poConsigneeAddress, addrs);
      const idx = shippingStatus.matchedIndex >= 0 ? shippingStatus.matchedIndex : 0;
      setSelectedShipIdx(idx);

      setFormData(prev => ({
        ...prev,
        customer: cust.id || customerId,
        consignee_name: prev.consignee_name || cust.customer_name || cust.name || hintName || '',
        consignee_gstin: prev.consignee_gstin || cust.gstin || hintGstin || '',
      }));
    }

    // Price-list fetch (independent of whether /api/customers/{id}/
    // succeeded — only needs the id). Don't show a toast on failure;
    // the dropdown will just stay empty and the price-list useEffect
    // will repopulate it.
    let priceListLines = [];
    // Also surface the price-list's HEADER terms (payment_terms,
    // delivery_terms, currency, freight_terms). The auto-extractor uses
    // these for the "extraction vs price-list" mismatch dialog — fields
    // the PO didn't print but the price list carries.
    let priceListTerms = null;
    // The matched list id is RETURNED (not written to state) so the caller
    // can set formData.price_list once — Effect B then loads the lines. This
    // keeps a single line-loader and stops this function racing the
    // customer/company price-list effect.
    let priceListId = null;
    try {
      // Send `company_id` so the backend pre-filters the result set —
      // the frontend filter below is a belt-and-braces guard in case
      // the backend is an older version that ignores the param.
      const plUrl = companyHint
        ? `/api/price-lists/for_customer/?customer_id=${customerId}&company_id=${companyHint}`
        : `/api/price-lists/for_customer/?customer_id=${customerId}`;
      const plRes = await _getWithRetry(plUrl);
      const allLists = plRes.data?.results || plRes.data || [];
      // When the caller already knows which company the PO was matched
      // to, narrow the picker to price lists that belong to that
      // company (or that are company-agnostic). Without this filter
      // we'd silently auto-fill a price list owned by a *different*
      // company than the one the form auto-selected — the cross-company
      // bug from the SS BIOCHEM / UNITED AGRO ticket.
      // Prefer lists that belong to the matched company (or are company-
      // agnostic). But if the customer's ONLY lists are under a different one
      // of our companies (duplicate-company data), keep them rather than
      // leaving the picker empty — the backend already returns the same
      // customer's lists as a cross-company fallback.
      const lists = (() => {
        if (!companyHint) return allLists;
        const matching = allLists.filter(pl => {
          const plCompany = String(pl.company || pl.company_id || '');
          return !plCompany || plCompany === String(companyHint);
        });
        return matching.length ? matching : allLists;
      })();
      // The backend's extract response may name the exact list it priced
      // against (`price_list_match`) — honour that pick when it's in the
      // fetched set so frontend and backend can't disagree. Otherwise
      // auto-pick the currently-effective list.
      const recent = (preferredPriceListId
        && lists.find(pl => String(pl.id) === String(preferredPriceListId)))
        || pickEffectivePriceList(lists);
      if (recent?.id) {
        priceListId = recent.id;
        // Fetch the lines synchronously for the extraction mapping below
        // (it needs them in-hand to decide each row's rate / banner). We do
        // NOT setPriceLines here — Effect B owns that, keyed on the
        // selection the caller is about to set.
        try {
          const linesRes = await _getWithRetry(`/api/price-lists/${recent.id}/lines/`);
          priceListLines = linesRes.data?.results || linesRes.data || [];
        } catch (_lineErr) { /* leave priceListLines empty */ }
        // Pull the price-list metadata (header terms). Separate call
        // because `/lines/` returns only the line items, not the
        // payment/delivery/currency defaults stored on the list itself.
        try {
          const plMetaRes = await _getWithRetry(`/api/price-lists/${recent.id}/`);
          const pl = plMetaRes.data || {};
          priceListTerms = {
            id: pl.id,
            label: pl.price_list_id || pl.name || '',
            payment_terms: pl.payment_terms || '',
            delivery_type: pl.delivery_terms || '',
            currency: pl.currency || '',
            freight_terms: pl.default_freight_terms || '',
          };
        } catch (_metaErr) { /* leave priceListTerms null */ }
      }
    } catch (_e) { /* no price lists; user can pick manually */ }

    return {
      shipping: cust
        ? { ...shippingStatus, po_consignee_address: poConsigneeAddress, customer_has_addresses: addrs.length > 0 }
        : null,
      priceListLines,
      priceListTerms,
      priceListId,
      // Surface the customer's own Company FK so the Auto Extractor can
      // validate that the company auto-picked from the PO's supplier
      // block actually matches the company the customer is registered
      // under. Without this, a PO addressed to "SS Biochem" could be
      // saved against a customer registered under "United Agro" — a
      // cross-company contamination the Save flow had no way to catch.
      customerCompanyId: cust?.company || null,
      customerCompanyName: cust?.company_name || '',
    };
  };

  const handleExtractFromFile = async (file, inboxRefs) => {
    if (!file) return;
    // Accept by extension OR by MIME type. A camera-captured photo often
    // arrives with a generic / extensionless name (e.g. "image.jpg" or no
    // name at all on some Android/iOS browsers), so an extension-only check
    // would silently reject it and the extractor would never run. The MIME
    // type ("image/jpeg" etc.) is reliable for captured files.
    const okExt = /\.(pdf|png|jpe?g|webp|docx)$/i.test(file.name || '');
    const okType = /^(image\/(png|jpe?g|webp)|application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/i.test(file.type || '');
    if (!okExt && !okType) {
      toast.error('Upload a PDF, image (PNG / JPG / WEBP), or DOCX.');
      return;
    }
    // The form's company at upload time — the same fallback scope the
    // backend uses (matched company, else the form's company) for its
    // customer / price-list lookups. Captured BEFORE the reset below
    // clears it, so the price-list pick can mirror the backend's scope
    // when the PO's supplier block doesn't resolve to a company.
    const extractCompanyId = formData.company || '';
    // ── Reset BEFORE we POST ───────────────────────────────────────
    // Every extract starts from a clean slate. Without this, a second
    // upload inherits the first upload's consignee / billing / line
    // items and the new data either renders alongside old data or is
    // silently rejected by the "only fill if empty" guard below.
    // Re-uploading is the user's explicit "throw out previous, use
    // this" gesture, so a full reset is the expected behaviour.
    resetFormToDefaults();
    setIsExtracting(true);
    // Tracks whether the extract POST itself returned successfully.
    // The catch block uses this to distinguish "transport failed"
    // (real server / network issue → show the alarming toast) from
    // "POST succeeded but a subsequent state-update / autofill step
    // threw" (programming or downstream issue → don't blame the
    // network when the form is already populated).
    let extractResponseReceived = false;
    try {
      const fd = new FormData();
      fd.append('file', file);
      // Pass the currently-selected company so the backend can scope the
      // customer-master lookup. Without this the backend would search
      // every customer across every company.
      if (formData.company) fd.append('company', formData.company);
      // Forward the inbox refs (when this extract was kicked off by the
      // inbox "Process Mail" flow) so the backend can hit its cache
      // instead of calling Gemini again. Only the inbox auto-ingest
      // effect passes these — manual file picks leave `inboxRefs`
      // undefined so the cache lookup is skipped and the upload runs
      // through Gemini as before.
      if (inboxRefs?.inboxId && inboxRefs?.inboxAttachmentId) {
        fd.append('inbox_id', inboxRefs.inboxId);
        fd.append('attachment_id', inboxRefs.inboxAttachmentId);
      }
      // Gemini multimodal can take 30-120s; we also have a model
      // fallback chain that adds another second or two per attempted
      // model. 4 minutes is a comfortable upper bound; the previous
      // 3-minute cap occasionally fired spuriously.
      const res = await apiClient.post('/api/sales/customer-po/extract/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 240000,
      });
      // Telemetry breadcrumb: the backend stamps `cached: true` when
      // the response came from the cache instead of a fresh Gemini
      // call. Surface it as a quiet toast so the user can tell the
      // form populated instantly because of the cache, not because
      // anything was wrong.
      if (res.data?.cached) {
        toast('Loaded saved extraction (no AI call)', { icon: '⚡' });
      }
      extractResponseReceived = true;
      // Everything after the POST is shared post-processing — moved to
      // applyExtraction (below) so the review-replay flow can run a
      // STORED extraction_snapshot through the exact same pipeline.
      await applyExtraction(res.data, file, extractCompanyId);
    } catch (err) {
      // Differentiate "the extract POST never returned" from "the POST
      // succeeded but a subsequent step threw". The previous catch
      // always blamed the network, which was misleading when the form
      // was already populated from a successful response.
      const isAbort = err?.code === 'ECONNABORTED' || /timeout/i.test(err?.message || '');
      const isNetwork = !err?.response;
      // eslint-disable-next-line no-console
      console.error('[handleExtractFromFile] failed', {
        extractResponseReceived,
        code: err?.code,
        message: err?.message,
        url: err?.config?.url,
        status: err?.response?.status,
        data: err?.response?.data,
      });
      if (extractResponseReceived) {
        // The extract succeeded — the form already has the data —
        // and something AFTER the POST threw (state update, address
        // helper, line mapper, etc.). Surface the actual message but
        // not as a scary network error.
        toast.error(
          'Extracted successfully, but post-processing hit an error: '
          + (err?.message || 'unknown') + '. Review the form before saving.',
          { duration: 8000 },
        );
      } else if (isAbort) {
        toast.error('Extraction timed out — Gemini took longer than 4 minutes. Try a smaller PDF or retry.');
      } else if (isNetwork && err?.code === 'ERR_NETWORK') {
        toast.error('Could not reach Django at http://localhost:8000. Restart the dev server if you just edited backend code.');
      } else if (isNetwork) {
        toast.error('Connection dropped before the response arrived. The extract may have succeeded server-side — wait 30s, refresh, and check the invoice list before retrying.');
      } else {
        toast.error(getApiErrorMessage(err) || 'Could not extract the document.');
      }
    } finally {
      setIsExtracting(false);
    }
  };

  // ── Shared extraction post-processing ──────────────────────────────
  // Runs the ENTIRE autofill pipeline (company/customer matching,
  // disambiguation, price-list resolution, line mapping, review queue)
  // on an extract response. Two callers:
  //   • handleExtractFromFile — fresh upload; passes the live response
  //     and the uploaded File.
  //   • the review-replay mount effect — replays a STORED
  //     `extraction_snapshot` from a bulk-created DRAFT (or the
  //     sessionStorage 'bulk_po_review' stash); passes srcFile = null
  //     because no raw File exists anymore.
  // Params:
  //   resData          — extract response body (res.data of the extract
  //                      POST, or the stored extraction_snapshot —
  //                      identical shape).
  //   srcFile          — the uploaded File, or null when replaying.
  //   extractCompanyId — the form's company at upload time; fallback
  //                      scope for the price-list lookups (mirrors the
  //                      backend's matched-company-else-form-company).
  const applyExtraction = async (resData, srcFile, extractCompanyId = '') => {
      // Surface Gemini per-call telemetry (model used + token counts +
      // duration) in the browser dev console so we can audit the cost of
      // each PO upload without needing server log access. Backend sends
      // these in `meta.gemini_calls`.
      logGeminiTelemetry(resData?.meta, srcFile?.name || 'stored extraction');
      const {
        header = {},
        lines = [],
        customer: extractedCustomer = {},
        supplier: extractedSupplier = {},
        customer_match: customerMatch = {},
        company_match: companyMatch = {},
        // Backend resolves the buyer state group from the PO address
        // and ships the id/name here. Empty when the address didn't
        // contain a recognisable state — manual entry still works,
        // the user just picks the state group from the dropdown.
        state_resolution: stateResolution = {},
        overall_confidence = 0,
        low_confidence_fields = [],
        file_name,
      } = resData || {};

      // Auto-pick the Company on the form when the supplier section of
      // the PO matches one in our Company master. Running this BEFORE
      // setFormData(...) lets the company auto-fill chain (fetches
      // /companies/{id}/ and populates billing_address from the master)
      // win over the Gemini-supplied address.
      //
      // We do NOT gate on `!formData.company`: `resetFormToDefaults()`
      // already cleared the field, but its setState is async and the
      // closure-captured `formData` here still holds the previous
      // selection from an earlier upload. That stale check was making
      // the second-and-later uploads silently skip the Company autofill
      // even though the banner said "Company auto-selected" — exactly
      // the empty-dropdown screenshot the user reported.
      const shouldAutoSelectCompany = (
        companyMatch.exists_in_master
        && companyMatch.matched_id
      );
      if (shouldAutoSelectCompany) {
        handleChange({ target: { name: 'company', value: companyMatch.matched_id } });
      }

      // Hard-fetch the matched customer (don't wait on the company's
      // /api/customers/?company=… list — it races and sometimes omits
      // the customer entirely if their company FK doesn't match the
      // matched supplier company). Pass the PO's printed consignee
      // address so the matcher can pick the right shipping row and
      // flag a mismatch when the PO ships somewhere new.
      let shippingResult = null;
      // Capture the price-list lines returned by the customer autofill
      // so we can resolve each matched product's Rate synchronously
      // below — React state set inside the same handler isn't visible
      // until the next render, so reading `priceLines` here would race.
      let extractedPriceListLines = [];
      // Captured from autofillMatchedCustomer so the post-extract
      // mismatch dialog can compare header fields the PO didn't print
      // against what the price-list itself defaults them to.
      let extractedPriceListTerms = null;
      let extractedPriceListId = '';
      // Validation outcome for company ↔ customer pairing. Populated
      // when both ends resolve — surfaced in the banner area below and
      // re-checked at submit time so a mismatched pairing can't slip
      // through.
      let companyCustomerCheck = { state: 'skipped' };
      if (customerMatch.exists_in_master && customerMatch.matched_id) {
        // ── Regional-variant disambiguation ─────────────────────────
        // Backend fuzzy matcher treats "- North"/"- South" as stop-
        // words, so both regional variants of the same base customer
        // score identically. Before committing, ask whether the PO's
        // ship-to address picks a different sibling.
        const poConsigneeAddress = (header.consignee_address || '').toString();
        const disamb = await disambiguateRegionalVariant(
          { id: customerMatch.matched_id, name: customerMatch.matched_name },
          poConsigneeAddress,
        );
        if (disamb.switched) {
          // Override the backend's choice — the user sees the right
          // variant in the dropdown and the address banner aligns.
          // eslint-disable-next-line no-console
          console.info('[CustomerPO extract] Regional variant switched', disamb);
          const via = disamb.reason === 'switched_by_llm'
            ? `by Gemini (confidence: ${disamb.llmConfidence || 'unknown'}) — ${disamb.llmReason || 'address geography match'}`
            : disamb.reason === 'switched_by_region'
              ? `based on the PO ship-to state (${disamb.poRegion})`
              : 'based on the PO ship-to address';
          toast.success(
            `Auto-switched to ${disamb.name} ${via} (was ${disamb.previousName}).`,
            { duration: 6000 },
          );
          customerMatch.matched_id = disamb.id;
          customerMatch.matched_name = disamb.name;
        } else if (disamb.reason === 'kept_low_confidence') {
          // Multiple regional variants exist but none had a clear
          // address match. Warn the user explicitly rather than
          // silently keeping the (arbitrary) backend pick.
          toast(
            `Multiple regional variants of "${stripRegionalSuffix(customerMatch.matched_name)}" exist. None of their shipping addresses match the PO ship-to — please confirm the correct customer manually.`,
            { icon: '⚠️', duration: 7000 },
          );
        }

        // ── Company-based disambiguation ─────────────────────────────
        // If the PO resolved a seller company, prefer a same-name customer
        // registered under THAT company over an arbitrary same-name record
        // under a different company. This runs before the autofill so the
        // dropdown, price list and the company ↔ customer cross-check all
        // key off the correct record.
        const poSellerCompanyId = (companyMatch.exists_in_master && companyMatch.matched_id) || '';
        if (poSellerCompanyId) {
          const byCompany = await disambiguateByCompany(
            { id: customerMatch.matched_id, name: customerMatch.matched_name },
            poSellerCompanyId,
          );
          if (byCompany.switched && byCompany.id) {
            // eslint-disable-next-line no-console
            console.info('[CustomerPO extract] Customer switched by company', byCompany);
            toast.success(
              `Matched ${byCompany.name} registered under ${companyMatch.matched_name} (a same-name record exists under a different company).`,
              { duration: 6000 },
            );
            customerMatch.matched_id = byCompany.id;
            customerMatch.matched_name = byCompany.name;
          }
        }

        const res2 = await autofillMatchedCustomer(
          customerMatch.matched_id,
          poConsigneeAddress,
          {
            // Pass the master-side name/GSTIN that the backend's
            // fuzzy matcher already resolved, so the dropdown shows
            // the customer instantly via optimistic injection — even
            // if /api/customers/{id}/ later times out or 500s.
            name: customerMatch.matched_name || extractedCustomer?.name || '',
            gstin: customerMatch.gstin_from_document || extractedCustomer?.gstin || '',
          },
          // Scope the price-list autofill to the matched company, else
          // the form's company at upload time — mirroring the backend's
          // matched-company-else-form-company scope.
          (companyMatch.exists_in_master && companyMatch.matched_id) || extractCompanyId || '',
          // The list the backend priced against, when it names one
          // (`price_list_match`); absent on older backends → unchanged.
          resData?.price_list_match || '',
        );
        shippingResult = res2?.shipping || null;
        extractedPriceListLines = res2?.priceListLines || [];
        extractedPriceListTerms = res2?.priceListTerms || null;
        extractedPriceListId = res2?.priceListId || '';

        // ── Company ↔ Customer cross-check ────────────────────────────
        // The PO's supplier block told us which Company in our master is
        // the seller; the Customer master record tells us which Company
        // that customer is actually registered under. If they disagree
        // this PO is INCONSISTENT — the buyer wrote a PO addressed to
        // one of our companies, but in our books that buyer belongs to
        // a different company. Saving it would corrupt the buyer ↔
        // seller relationship for every downstream DC / invoice, so we
        // freeze the Company dropdown and refuse the Save. The user
        // must either correct the customer's Company in master or pick
        // a different customer that legitimately belongs under this
        // supplier.
        const customerCompanyId = res2?.customerCompanyId || null;
        const supplierMatchedId = (companyMatch.exists_in_master && companyMatch.matched_id) || null;
        if (!customerCompanyId) {
          companyCustomerCheck = {
            state: 'no_company_on_customer',
            customer_name: customerMatch.matched_name,
          };
        } else if (supplierMatchedId && supplierMatchedId !== customerCompanyId) {
          // Mismatch — DO NOT auto-switch. Keep the supplier-side
          // company on display so the user can see the inconsistency,
          // but lock the field and block Save until the master data is
          // fixed.
          companyCustomerCheck = {
            state: 'mismatch',
            customer_name: customerMatch.matched_name,
            po_company_id: supplierMatchedId,
            po_company_name: companyMatch.matched_name,
            customer_company_id: customerCompanyId,
            customer_company_name: res2?.customerCompanyName || '',
          };
          toast.error(
            `This PO is addressed to ${companyMatch.matched_name}, but ${customerMatch.matched_name} is registered under ${res2?.customerCompanyName || 'a different company'}. Fix in master before saving.`,
            { duration: 7000 },
          );
        } else if (!supplierMatchedId) {
          // PO didn't resolve a company — fill from the customer's
          // record. This isn't a mismatch, just a gap on the PO.
          handleChange({ target: { name: 'company', value: customerCompanyId } });
          companyCustomerCheck = {
            state: 'filled_from_customer',
            customer_name: customerMatch.matched_name,
            to_company_id: customerCompanyId,
            to_company_name: res2?.customerCompanyName || '',
          };
        } else {
          companyCustomerCheck = { state: 'ok' };
        }
      }

      // Merge header fields. Re-uploading is an explicit "use this PO"
      // gesture, so extracted values always win over whatever was on
      // the form. Empty strings from the model never clobber data set
      // by intermediate steps (e.g. the consignee_name autofill from
      // the matched customer master, which ran before this block).
      setFormData((prev) => {
        const next = { ...prev };
        const HEADER_KEYS = [
          'po_number', 'po_date', 'consignee_name', 'consignee_address', 'consignee_gstin',
          'billing_name', 'billing_address', 'billing_gstin', 'destination', 'payment_terms',
          'delivery_type', 'dispatched_through', 'currency',
          'required_ship_date', 'delivery_due_date',
          'special_instructions', 'remarks',
        ];
        HEADER_KEYS.forEach((k) => {
          const incoming = (header[k] ?? '').toString().trim();
          if (incoming) next[k] = incoming;
        });
        // Apply the backend-resolved state group when present. We
        // ALWAYS overwrite from extraction — the upload is the user
        // saying "use what's in this PO", and the address-based pick
        // is more authoritative than any prior manual selection. User
        // can still tweak the dropdown afterwards.
        if (stateResolution.state_group_id) {
          next.state_group = stateResolution.state_group_id;
        }
        // Select the price list the extractor matched. Effect B then loads
        // its lines and the dropdown (driven by Effect A) shows it — keeping
        // selection, options and lines in lockstep instead of the old
        // race where the lines loaded but the dropdown read "Select…".
        if (extractedPriceListId) next.price_list = extractedPriceListId;
        return next;
      });

      // Replace the empty default line if the model returned any.
      // Each `l.matched_product` is the server-side fuzzy match against
      // Product master — when present, we pre-select the dropdown via
      // `parsed_sku` and pin the category to whatever the matched
      // product carries so the Category filter doesn't hide it.
      if (lines.length > 0) {
        let matchedCount = 0;
        let rateFilledCount = 0;
        const unmatched = [];   // collect explanations for un-matched lines
        // Track matched products that are missing from the selected
        // price list. These lines DO have a master-product match
        // (so the dropdown will pre-select correctly) but no rate
        // can be auto-filled — the user needs to add them to the
        // price list or pick a different list. Surfaced as a toast
        // per-line so it's obvious which products are missing.
        const productsNotInPriceList = [];
        // One-shot price lookup keyed by product UUID. We use the
        // synchronously-returned price-list lines, not React state,
        // because state updates inside this handler aren't yet
        // visible.
        const priceByProduct = new Map();
        extractedPriceListLines.forEach((pl) => {
          if (pl?.product) priceByProduct.set(String(pl.product), pl);
        });
        // Name-keyed fallback index. The backend matches a PO line
        // against ALL master products — when the master has two rows
        // with the same display name (e.g. one tagged to the matched
        // customer, one not), it may pick the row that ISN'T on the
        // current price list, leaving the line stranded in the red
        // "not in price list" banner even though the customer trades
        // that product with us. Indexing the price-list lines by a
        // normalised product name lets us recover the right Product
        // UUID by name when the UUID lookup misses.
        // Canonicalise a product name for matching. We deliberately strip
        // '%' and split on '.' so the SAME item written two ways across two
        // master records — "0.15 %" vs "0.15%" vs "0.15 %" — collapses to the
        // same token set. That formatting drift is exactly what was leaving
        // PO products (matched to one master) "not in the price list" when
        // the list referenced a sibling master with the same name. Tokens are
        // sorted so word order doesn't matter either.
        const _normName = (s) => String(s || '')
          .toUpperCase()
          .replace(/\([^)]*\)/g, ' ')
          .replace(/[\.,;:'"&/\-%]/g, ' ')
          .split(/\s+/)
          .filter(Boolean)
          .sort()
          .join(' ');
        // Index price-list lines by the line's own product_name AND by the
        // MASTER product's name (looked up by the line's product UUID — the
        // same source the line-item dropdown uses). Without the master
        // fallback, a product that's visible in the dropdown can still be
        // wrongly reported "not in the price list" when the price-line's
        // stored name/sku differs from the product master (duplicate /
        // re-created product records).
        const _masterById = new Map((rawProducts || []).map(p => [String(p.id), p]));
        const priceByName = new Map();
        extractedPriceListLines.forEach((pl) => {
          const key = _normName(pl?.product_name);
          if (key && !priceByName.has(key)) priceByName.set(key, pl);
          const _mName = _normName(_masterById.get(String(pl?.product))?.product_name);
          if (_mName && !priceByName.has(_mName)) priceByName.set(_mName, pl);
        });
        // SKU- and trade-name-keyed indexes. The matched_product block
        // from the backend carries `matched_sku` and `matched_trade_name`
        // alongside `matched_id`; when the master Product the line was
        // matched to has the SAME sku/trade-name as a different Product
        // on the price list (which happens when two Product rows share
        // identifying attributes — common after a product re-creation),
        // these indexes recover the right price-list line by SKU or
        // trade name rather than dropping the rate to zero.
        const priceBySku = new Map();
        const priceByTradeName = new Map();
        // The Customer Brand Name lives on the price-list line as
        // `customer_trade_name` (the brand the customer markets this
        // product as — set on the price list, not the product master).
        // Index it so we can recover the right Product when Gemini's
        // backend matcher returned no match BUT the PO description
        // matches a customer's brand name on this price list.
        const priceByCustomerTradeName = new Map();
        extractedPriceListLines.forEach((pl) => {
          if (pl?.product_sku) {
            const k = String(pl.product_sku).trim().toUpperCase();
            if (k && !priceBySku.has(k)) priceBySku.set(k, pl);
          }
          // Also index by the MASTER product's SKU code (dropdown source)
          // so a master-SKU match recovers the right price-list line even
          // when the price-line's stored sku differs from the master.
          {
            const _m = _masterById.get(String(pl?.product));
            const _mSku = String(_m?.sku_code || _m?.product_sku || '').trim().toUpperCase();
            if (_mSku && !priceBySku.has(_mSku)) priceBySku.set(_mSku, pl);
          }
          if (pl?.product_trade_name) {
            const k = _normName(pl.product_trade_name);
            if (k && !priceByTradeName.has(k)) priceByTradeName.set(k, pl);
          }
          if (pl?.customer_trade_name) {
            const k = _normName(pl.customer_trade_name);
            if (k && !priceByCustomerTradeName.has(k)) priceByCustomerTradeName.set(k, pl);
          }
        });
        // Best-effort fuzzy lookup. Returns the price-list line whose
        // normalised name shares the most tokens with `target`, but
        // ONLY when at least 50% of the price-list line's tokens are
        // present in the target — avoids false positives where a
        // short PO description ("BUCKET") accidentally matches a
        // long PL product name.
        const _findByFuzzyName = (target) => {
          const t = _normName(target);
          if (!t) return null;
          const tTokens = new Set(t.split(' '));
          let best = null;
          let bestOverlap = 0;
          extractedPriceListLines.forEach((pl) => {
            // Match against BOTH the price line's own name and the MASTER
            // product's name (the line's stored name is sometimes blank — the
            // dropdown shows the master name), so the fuzzy fallback still
            // recovers the line either way.
            const candidates = [pl?.product_name, _masterById.get(String(pl?.product))?.product_name];
            candidates.forEach((nameStr) => {
              const n = _normName(nameStr);
              if (!n) return;
              const pTokens = new Set(n.split(' '));
              let overlap = 0;
              pTokens.forEach((tok) => { if (tTokens.has(tok)) overlap += 1; });
              if (overlap > bestOverlap && overlap >= Math.ceil(pTokens.size * 0.5)) {
                best = pl;
                bestOverlap = overlap;
              }
            });
          });
          return best;
        };
        // Diagnostic — open DevTools → Console after an extract to see
        // exactly what the price-list lookup found. The most common
        // reasons Rate stays at 0:
        //   • Customer has no price list yet.
        //   • Price list is empty / has no lines for the matched product.
        //   • The matched product UUID doesn't appear on the price list,
        //     and SKU / name fallbacks didn't connect either.
        // Always-on (not gated by import.meta.env.DEV) because users on
        // the deployed Render build also need to see this to debug rate
        // issues without redeploying with a dev flag.
        /* eslint-disable no-console */
        console.groupCollapsed(
          `%c[CPO extract] Price-list lookup diagnostic — ${extractedPriceListLines.length} PL line(s)`,
          'color:#4f46e5;font-weight:bold;',
        );
        console.log('Customer:', {
          matched: customerMatch?.matched_id,
          name: customerMatch?.matched_name,
        });
        console.table(extractedPriceListLines.map(pl => ({
          product_uuid: pl.product,
          sku: pl.product_sku,
          name: pl.product_name,
          trade_name: pl.product_trade_name,
          rate: pl.rate,
        })));
        console.log('Extraction → looking up each line:');
        console.table(lines.map(l => ({
          po_description: l.product_description,
          matched_id: l?.matched_product?.matched_id,
          matched_name: l?.matched_product?.matched_name,
          matched_sku: l?.matched_product?.matched_sku,
          matched_trade_name: l?.matched_product?.matched_trade_name,
          hit_by_uuid: !!(l?.matched_product?.matched_id
                          && priceByProduct.get(String(l.matched_product.matched_id))),
          hit_by_sku: !!(l?.matched_product?.matched_sku
                         && priceBySku.get(String(l.matched_product.matched_sku).trim().toUpperCase())),
          hit_by_name: !!(l?.matched_product?.matched_name
                          && priceByName.get(_normName(l.matched_product.matched_name))),
        })));
        console.groupEnd();
        /* eslint-enable no-console */
        // Fuzzy fallback against customer_trade_name. Used when the
        // backend matcher returned no `matched_id` for a line — see
        // the "Customer Brand Name fallback" block below. Same shape
        // as `_findByFuzzyName` (>=50% token overlap on the PL key)
        // but it scans the customer_trade_name column instead.
        const _findByFuzzyCustomerBrand = (target) => {
          const t = _normName(target);
          if (!t) return null;
          const tTokens = new Set(t.split(' '));
          let best = null;
          let bestOverlap = 0;
          extractedPriceListLines.forEach((pl) => {
            const n = _normName(pl?.customer_trade_name);
            if (!n) return;
            const pTokens = new Set(n.split(' '));
            let overlap = 0;
            pTokens.forEach((tok) => { if (tTokens.has(tok)) overlap += 1; });
            if (overlap > bestOverlap && overlap >= Math.ceil(pTokens.size * 0.5)) {
              best = pl;
              bestOverlap = overlap;
            }
          });
          return best;
        };

        const mappedLines = lines.map((l) => {
          // Drop a completely empty extracted line before any matching.
          // Gemini occasionally emits a trailing empty line object, or a
          // terms/notes row parsed as a line — with nothing to match and
          // nothing printed it would otherwise render as a spurious blank
          // row alongside the real products. A genuine unmatched line still
          // carries a description / item_code / qty and is kept so the user
          // can fix it; the "keep one empty line" fallback still gives a row
          // to type in if every line was dropped.
          if (!(l.product_description || '').trim()
              && !(l.item_code || '').trim()
              && !(l.hsn_code || '').trim()
              && !String(l.quantity ?? '').trim()
              && !String(l.price ?? '').trim()
              && !(l.matched_product?.matched_id)) {
            return null;
          }
          let mp = l.matched_product || {};
          let priceLine = mp.matched_id
            ? priceByProduct.get(String(mp.matched_id))
            : null;

          // ── Customer Brand Name fallback ──────────────────────────
          // The backend matcher (Gemini + fuzzy against Product master)
          // returned NO match for this line, but the PO printed a
          // product description. As a last-mile rescue, see if the
          // description matches a `customer_trade_name` on any line of
          // the currently-selected price list — that's the brand the
          // customer prints on their POs (e.g. "Nimbecidine 0.03%")
          // even though our master product name might be quite
          // different ("EMP -BUCKET-5 KG"). If we find one, treat the
          // PL line's product as the match so the dropdown pre-selects
          // it and the rate / discount / GST autofill from PL too.
          if (!mp.matched_id && (l.product_description || l.item_code)) {
            const target = l.product_description || l.item_code;
            const targetKey = _normName(target);
            const hit = priceByCustomerTradeName.get(targetKey)
              || _findByFuzzyCustomerBrand(target);
            if (hit?.product) {
              priceLine = hit;
              mp = {
                ...mp,
                matched_id: hit.product,
                matched_name: hit.product_name || mp.matched_name || target,
                matched_sku: hit.product_sku || mp.matched_sku || '',
                matched_trade_name: hit.product_trade_name || mp.matched_trade_name || '',
                matched_field: 'customer_brand_name_fallback',
                matched_reasoning: `Matched via Customer Brand Name "${hit.customer_trade_name}" on the active price list.`,
              };
            }
          }
          // Fallback path: the backend matched the line to a Product
          // (mp.matched_id is set) but that Product isn't on the
          // currently-selected price list. Before giving up, see if
          // a PRICE-LIST line shares the same name as the matched
          // master product — if so, the user almost certainly meant
          // that one. Swap the matched_id over so the row lands in
          // the table with the rate filled from PL instead of being
          // exiled to the "not in price list" banner.
          if (mp.matched_id && !priceLine) {
            // Resolution priority:
            //   1. SKU code — strongest signal (codes are unique per
            //      product, so a match here is unambiguous).
            //   2. Master product name (exact, normalised).
            //   3. Customer trade name (exact, normalised).
            //   4. Fuzzy token-overlap on product names — last resort.
            const skuKey = (mp.matched_sku || '').toString().trim().toUpperCase();
            const byMasterName = (skuKey && priceBySku.get(skuKey))
              || priceByName.get(_normName(mp.matched_name))
              || priceByTradeName.get(_normName(mp.matched_trade_name))
              || priceByName.get(_normName(mp.matched_trade_name))
              || _findByFuzzyName(mp.matched_name || mp.matched_trade_name || l.product_description);
            if (byMasterName?.product) {
              priceLine = byMasterName;
              mp = {
                ...mp,
                matched_id: byMasterName.product,
                matched_name: byMasterName.product_name || mp.matched_name,
                matched_field: mp.matched_field || 'price_list_sku_or_name_swap',
              };
            }
          }
          if (mp.matched_id) {
            // Validation: matched product has no corresponding price-list
            // entry. Two distinct cases:
            //   • A price list IS selected but doesn't include the
            //     product → the row can't be priced authoritatively, so
            //     drop it and record it in `productsNotInPriceList` (the
            //     red banner + toasts point the user at what's missing).
            //   • NO price list resolved at all → keep the row (rate
            //     falls back to the PO's printed value below) so a
            //     fully-extracted PO never renders an empty table.
            if (!priceLine && extractedPriceListLines.length > 0) {
              productsNotInPriceList.push({
                product_name: mp.matched_name || mp.matched_sku || l.product_description || '(unnamed)',
                product_sku: mp.matched_sku || '',
                quantity: l.quantity || '',
                po_rate: l.price || '',
                // Carry the PO's unit + codes so a later recovery
                // restores the row as ordered.
                uom: normalizeUom(l.uom) || '',
                hsn_code: l.hsn_code || '',
                item_code: l.item_code || '',
              });
              return null;
            }
            // Counted AFTER the drop decision so the success toast only
            // reports rows that actually landed in the table.
            matchedCount += 1;
          } else if ((l.product_description || '').trim() || (l.item_code || '').trim()) {
            // No match for a line that DID have something to match
            // against — record the description so the user can see
            // which line is empty (and why, if Gemini gave a reason).
            unmatched.push({
              description: l.product_description || l.item_code || '(unnamed line)',
              reasoning: mp.matched_reasoning || '',
              field: mp.matched_field || '',
            });
            // When no price list was matched at all, also drop these
            // unpriced empty rows so the table is honest about the
            // fact that nothing can be saved until a price list exists.
            if (extractedPriceListLines.length === 0) return null;
          }
          // All commercial values (price, discount, every GST flavour)
          // are authoritative-only: they autofill from the customer's
          // price list and from nothing else. When the matched product
          // is missing from the selected list we clear the row to zero
          // and rely on the red banner above the table to tell the user
          // exactly which lines need a manual rate / GST decision. The
          // PO-printed unit rate is preserved separately on `po_rate`
          // so the user can still see what the buyer wrote.
          const hasPlRate = priceLine
            && priceLine.rate !== undefined
            && priceLine.rate !== null
            && priceLine.rate !== '';
          // `rateFilledCount` is now incremented BELOW, after we know
          // whether the line was actually auto-filled or deferred behind
          // the user-confirmation banner.
          // Restate the PL rate per the line's UOM (per-MTS → per-KG etc.) so
          // Amount = qty × rate is correct across unit scales.
          const resolvedPrice = hasPlRate
            ? String(rateForLineUom(priceLine.rate, priceLine?.uom, normalizeUom(l.uom) || priceLine?.uom || 'KG'))
            : '';
          const resolvedDiscount = priceLine
            && priceLine.discount !== undefined
            && priceLine.discount !== null
            && priceLine.discount !== ''
              ? String(priceLine.discount)
              : '0';
          const resolvedGst = priceLine
            && priceLine.gst !== undefined
            && priceLine.gst !== null
            && priceLine.gst !== ''
              ? String(priceLine.gst)
              : '0';
          const resolvedSgst = priceLine
            && priceLine.sgst_rate !== undefined
            && priceLine.sgst_rate !== null
            && priceLine.sgst_rate !== ''
              ? String(priceLine.sgst_rate)
              : '0';
          const resolvedCgst = priceLine
            && priceLine.cgst_rate !== undefined
            && priceLine.cgst_rate !== null
            && priceLine.cgst_rate !== ''
              ? String(priceLine.cgst_rate)
              : '0';
          const resolvedIgst = priceLine
            && priceLine.igst_rate !== undefined
            && priceLine.igst_rate !== null
            && priceLine.igst_rate !== ''
              ? String(priceLine.igst_rate)
              : '0';
          // UOM priority: what the PO actually printed (normalised) wins
          // over the price-list UOM. The PO is the authoritative source
          // for what the buyer ordered — if they wrote "KGS" we should
          // commit to KG, not silently override to MTS because the price
          // list happens to be priced per metric ton. Falls back to the
          // price-list UOM and finally KG.
          const resolvedUom = normalizeUom(l.uom) || priceLine?.uom || 'KG';

          // ── Commercial-value resolution ───────────────────────────────
          // Two different authority models live side-by-side here:
          //
          //   RATE (price) → PRICE LIST AUTHORITATIVE.
          //     The price list is the agreed-upon contract price for
          //     this customer. A PO's printed rate is the buyer's view
          //     and may carry copy-paste errors or stale numbers, so
          //     we always overwrite it with the PL rate when one is
          //     available. The PO's value is still preserved separately
          //     on `po_rate` for the user to sanity-check. We only fall
          //     back to the PO's rate when the product genuinely isn't
          //     on the PL (which also lights up the "not in price list"
          //     red banner above the table).
          //
          //   DISCOUNT / GST (gst, sgst, cgst, igst) → PO-WINS-WHEN-PRINTED.
          //     Tax rates can legitimately differ from the PL default
          //     based on supply state and customer registration, and
          //     the PO is the document being honoured. Resolution:
          //       1. PO printed a value      → use the PO's value.
          //       2. PO blank, PL has value  → DEFER: leave row at 0,
          //                                    stash PL value in
          //                                    `_pl_pending`, surface
          //                                    in the amber confirmation
          //                                    banner above the table.
          //       3. PO blank, PL also blank → leave at 0.
          const _isFilled = (v) => {
            if (v === undefined || v === null) return false;
            const s = String(v).trim();
            if (s === '') return false;
            const n = parseFloat(s);
            return Number.isFinite(n) && n > 0;
          };
          // PL value for this field, or null if the PL doesn't carry it.
          // Note `price` follows `hasPlRate` (which preserves "rate of 0"
          // when intentional); the others use `_isFilled` so a PL rate
          // of 0 doesn't pretend to be a real rate.
          const _plByField = {
            price:         hasPlRate ? resolvedPrice : null,
            discount:      _isFilled(resolvedDiscount) ? resolvedDiscount : null,
            gst:           _isFilled(resolvedGst)      ? resolvedGst      : null,
            sgst_percent:  _isFilled(resolvedSgst)     ? resolvedSgst     : null,
            cgst_percent:  _isFilled(resolvedCgst)     ? resolvedCgst     : null,
            igst_percent:  _isFilled(resolvedIgst)     ? resolvedIgst     : null,
          };
          // A PO can legitimately print 0 for GST / discount (exempt
          // supply, no discount). Unlike `_isFilled`, a printed '0'
          // counts here — it must WIN over the PL value, not fall
          // through to the `_pl_pending` confirmation path.
          const _isPrinted = (v) => v !== undefined && v !== null && String(v).trim() !== '' && Number.isFinite(parseFloat(v)) && parseFloat(v) >= 0;
          // GST fields the backend backfilled from the document-LEVEL
          // tax summary arrive tagged in `_doc_gst_fields` — those were
          // not printed on THIS line, so they take the `_pl_pending`
          // confirmation path instead of winning outright. (Key absent
          // on older backends → behaviour unchanged.)
          const _docGst = new Set(Array.isArray(l._doc_gst_fields) ? l._doc_gst_fields : []);
          // PO value for this field, or null if the PO didn't print one.
          const _poByField = {
            price:         _isFilled(l.price)                                          ? String(l.price).trim()         : null,
            discount:      _isPrinted(l.discount)     && !_docGst.has('discount')      ? String(l.discount).trim()      : null,
            gst:           _isPrinted(l.gst)          && !_docGst.has('gst')           ? String(l.gst).trim()           : null,
            sgst_percent:  _isPrinted(l.sgst_percent) && !_docGst.has('sgst_percent')  ? String(l.sgst_percent).trim()  : null,
            cgst_percent:  _isPrinted(l.cgst_percent) && !_docGst.has('cgst_percent')  ? String(l.cgst_percent).trim()  : null,
            igst_percent:  _isPrinted(l.igst_percent) && !_docGst.has('igst_percent')  ? String(l.igst_percent).trim()  : null,
          };
          // Cross-regime gate: a PO prints exactly one GST regime —
          // inter-state (IGST) or intra-state (CGST+SGST). Never defer
          // PL values from the OTHER regime into `_pl_pending`, or
          // confirming the amber banner would mix both on one line.
          const poHasIgst = _poByField.igst_percent != null;
          const poHasSplit = _poByField.sgst_percent != null || _poByField.cgst_percent != null;
          if (poHasIgst && !poHasSplit) {
            _plByField.sgst_percent = null;
            _plByField.cgst_percent = null;
          } else if (poHasSplit && !poHasIgst) {
            _plByField.igst_percent = null;
          }
          const _final = {};
          const _deferred = {};
          ['price', 'discount', 'gst', 'sgst_percent', 'cgst_percent', 'igst_percent'].forEach(k => {
            const poVal = _poByField[k];
            const plVal = _plByField[k];
            if (k === 'price') {
              // RATE is PL-authoritative — always use the PL rate when
              // available, regardless of what the PO printed. The
              // PO's printed rate is preserved on `po_rate` so the
              // user can spot a customer-side mismatch (e.g. customer
              // sent a PO at an old price).
              if (plVal != null) {
                _final[k] = plVal;
              } else if (poVal != null) {
                // Product genuinely isn't on the PL — fall back so the
                // row isn't blank, and the existing "not in price list"
                // red banner above the table tells the user to fix it.
                _final[k] = poVal;
              } else {
                _final[k] = '';
              }
              return;
            }
            if (poVal != null) {
              _final[k] = poVal;            // PO wins.
            } else if (plVal != null) {
              _deferred[k] = plVal;          // wait for user confirmation.
              _final[k] = '0';
            } else {
              _final[k] = '0';
            }
          });
          // If the PO printed SGST + CGST individually but no combined
          // `gst` total, synthesise the combined % so the line's `gst`
          // column matches the split (the UI shows `gst` and the splits
          // both — keeping them in sync avoids confusing 0% next to 2.5
          // + 2.5).
          if (!_isFilled(_final.gst)) {
            const _sgst = parseFloat(_final.sgst_percent) || 0;
            const _cgst = parseFloat(_final.cgst_percent) || 0;
            const _igst = parseFloat(_final.igst_percent) || 0;
            const _sum = _sgst + _cgst + _igst;
            if (_sum > 0) _final.gst = String(_sum);
          }
          const finalPrice    = _final.price;
          const finalDiscount = _final.discount;
          const finalGst      = _final.gst;
          const finalSgst     = _final.sgst_percent;
          const finalCgst     = _final.cgst_percent;
          const finalIgst     = _final.igst_percent;
          const plPending = Object.keys(_deferred).length > 0 ? _deferred : null;
          // Count rates that actually landed in the cell (from PO OR
          // PL-applied silently — but PL-fills now go through the
          // banner gate, so a deferred-rate line doesn't count here).
          if (_final.price !== '') rateFilledCount += 1;
          return {
            ...emptyLine,
            // Pre-select the matched product in the dropdown. The form's
            // handleLineChange only mutates other fields when the user
            // edits the dropdown manually, so setting parsed_sku here
            // doesn't overwrite the PO-extracted description / HSN.
            parsed_sku: mp.matched_id || '',
            // Keep the matched product's master-side name + sku on the
            // line so the dropdown can display it even when the option
            // hasn't been hydrated into rawProducts yet (paginated
            // fetch, price-list filter that excluded it, etc.). Without
            // this the cell would show "Select" despite parsed_sku
            // being set and the rate already filled from the price
            // list — confusing for the user.
            matched_product_name: mp.matched_name || '',
            matched_product_sku: mp.matched_sku || '',
            product_category: mp.matched_goods_sub_type || (mp.matched_id ? 'FINISHED_GOOD' : ''),
            product_description: l.product_description || '',
            item_code: l.item_code || '',
            hsn_code: l.hsn_code || '',
            quantity: l.quantity || '',
            // `po_rate` always carries the rate Gemini read off the PO.
            // It's user-visible and editable so the user can sanity-check
            // it against `price` (price-list rate, fills below).
            po_rate: l.price || '',
            uom: resolvedUom,
            price: finalPrice,
            discount: finalDiscount,
            gst: finalGst,
            sgst_percent: finalSgst,
            cgst_percent: finalCgst,
            igst_percent: finalIgst,
            // Holds the price-list values we'd have written into the
            // line if the PO had explicitly priced it. Cleared once the
            // user confirms via the "Autofill from Price List" banner.
            _pl_pending: plPending,
            // Fields the PO printed itself. The re-resolution useEffect
            // (triggered when the active price list reloads) will skip
            // these — otherwise a PO that printed CGST 2.5% / SGST 2.5%
            // would get silently overwritten to the PL's 9% / 9% the
            // moment priceLines arrived.
            _po_fields: Object.keys(_poByField).filter(k => _poByField[k] != null),
            line_remarks: l.line_remarks || '',
            // Marker for the re-resolution useEffect: when the active
            // price list changes after extraction (the race where
            // autofillMatchedCustomer's auto-pick differs from the
            // company-scoped fetchAndScope's pick), we filter out
            // extraction-origin rows that no longer fit the selected
            // list. Manually-added rows have no flag and are preserved.
            from_extraction: true,
          };
        }).filter(Boolean);
        // Same-product merge: when a PO repeats the same product across
        // multiple lines IN THE SAME UOM (e.g. NIMBECIDINE 0.15%
        // appearing twice with qty 150 + qty 110), collapse them into a
        // single row whose quantity is the sum. Same product in
        // DIFFERENT UOMs (5 KG + 2 MTS) stays as separate rows —
        // quantities across units can't be summed. Rate / discount /
        // GST / PO Rate are intentionally NOT averaged or summed — for
        // the same (SKU, UOM) on the same price list those values are
        // identical, so we just carry the first occurrence's values
        // forward. If the buyer's PO printed two different PO rates for
        // the same product the first one wins; the second is silently
        // dropped because the user almost always wants a single combined
        // line and can spot the discrepancy on the source PO if it ever
        // matters. Only extraction-origin lines participate —
        // manually-added lines (no `from_extraction` flag) are kept as
        // separate rows even when their product matches an extracted
        // line, since the user explicitly added them.
        const mergedExtracted = (() => {
          const byProduct = new Map();
          const passthrough = []; // lines without parsed_sku — keep as-is
          for (const line of mappedLines) {
            if (!line.parsed_sku) { passthrough.push(line); continue; }
            const mergeKey = line.parsed_sku + '|' + (line.uom || '');
            const existing = byProduct.get(mergeKey);
            if (existing) {
              const sumQty = (parseFloat(existing.quantity) || 0) + (parseFloat(line.quantity) || 0);
              existing.quantity = String(sumQty);
            } else {
              byProduct.set(mergeKey, { ...line });
            }
          }
          return [...byProduct.values(), ...passthrough];
        })();
        // Keep at least one empty line so the user has somewhere to
        // type if every extracted product ended up filtered out.
        setPoLines(mergedExtracted.length > 0 ? mergedExtracted : [{ ...emptyLine }]);
        // Dedupe the excluded-product list (a PO line repeated for the
        // same SKU shouldn't show twice) and stash it so the red banner
        // can name each one even though no row exists for it anymore.
        if (productsNotInPriceList.length > 0) {
          const seen = new Set();
          const uniqueExcluded = productsNotInPriceList.filter(p => {
            const key = `${p.product_sku}|${p.product_name}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          setExtractedExcludedProducts(uniqueExcluded);
        } else {
          setExtractedExcludedProducts([]);
        }
        if (matchedCount > 0) {
          const rateNote = rateFilledCount > 0
            ? ` Rate printed on the PO for ${rateFilledCount} of those (others are blank — confirm via the amber banner if you want PL values).`
            : (extractedPriceListLines.length === 0
                ? ' (No price list found for this customer — Rate left blank.)'
                : ' (PO didn\'t print rates — confirm via the amber banner to pull from the price list.)');
          toast.success(
            `${matchedCount} of ${lines.length} line(s) auto-matched to Product master.${rateNote}`,
            { duration: 6000 },
          );
        }
        if (unmatched.length > 0) {
          // One toast per unmatched line, with Gemini's reasoning if it
          // gave one. Helps diagnose why "EMP -BUCKET-5 KG" didn't
          // autofill (e.g. "size 5 KG ≠ 50 KG in any candidate" tells
          // us the catalog doesn't actually have the right product).
          unmatched.forEach((u) => {
            const tail = u.reasoning ? ` — ${u.reasoning}` : '';
            toast.error(
              `Could not match "${u.description}" to Product master${tail}`,
              { duration: 7000 },
            );
          });
        }
        // Products in the master but not in the customer's price list
        // → flag each one so the user knows which lines need attention
        //   (missing price-list entry → no rate auto-fill).
        if (productsNotInPriceList.length > 0) {
          // Dedupe by SKU/name so a multi-line PO with the same SKU
          // doesn't spawn N identical toasts.
          const seen = new Set();
          const unique = productsNotInPriceList.filter(p => {
            const key = `${p.product_sku}|${p.product_name}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          if (extractedPriceListLines.length === 0) {
            // Validation error: no price list matched this customer
            // under the auto-selected company. Skip the per-product
            // spam and show a single, actionable banner so the user
            // knows the WHY — products were intentionally NOT
            // auto-populated because no priced row could be saved.
            const sampleNames = unique.slice(0, 3).map(p => `"${p.product_name}"`).join(', ');
            const more = unique.length > 3 ? ` (+${unique.length - 3} more)` : '';
            toast.error(
              `No price list found for this customer under the auto-selected company. `
              + `${unique.length} product line(s) from the PO were not added: ${sampleNames}${more}. `
              + `Create a matching price list and re-upload, or switch the Company / price list manually.`,
              { duration: 12000 },
            );
          } else {
            unique.forEach(p => {
              const skuPart = p.product_sku ? ` (${p.product_sku})` : '';
              toast.error(
                `"${p.product_name}"${skuPart} is not in the selected price list — row was not added. `
                + `Add it to the price list, pick a different list, or insert a row manually.`,
                { duration: 8000 },
              );
            });
          }
        }
      }

      setExtractMeta({
        file_name,
        overall_confidence,
        low_confidence_fields,
        extracted_customer: extractedCustomer,
        extracted_supplier: extractedSupplier,
        customer_match: customerMatch,
        company_match: companyMatch,
        shipping: shippingResult,
        po_consignee_address: header.consignee_address || '',
        company_customer_check: companyCustomerCheck,
      });

      // ── Combined extraction-review queue ─────────────────────────
      // ONE popup, not two. Collects every thing the user needs to
      // confirm — fuzzy customer / company matches AND header fields
      // the PO didn't print but the matched price list defaults —
      // into a single review table rendered below the form. Each
      // entry is self-contained with its own accept/reject callbacks
      // so the modal can render them in a uniform list.
      const _review = [];

      // 1. Fuzzy CUSTOMER match (50%-99% similar). Already applied
      //    during extract — accept = keep, reject = clear customer FK
      //    + dependent price-list state.
      const _custScore = Number(customerMatch?.matched_score) || 0;
      if (
        customerMatch?.exists_in_master
        && customerMatch?.matched_id
        && _custScore < 0.99
        && _custScore >= 0.5
      ) {
        _review.push({
          id: 'match:customer',
          group: 'match',
          label: 'Customer',
          extractedLabel: 'EXTRACTED (DOCUMENT)',
          extractedValue: extractedCustomer?.name || '',
          extractedMeta: extractedCustomer?.gstin || '',
          suggestedLabel: 'CUSTOMER MASTER',
          suggestedValue: customerMatch.matched_name || '',
          suggestedMeta: customerMatch.matched_id ? `ID ${String(customerMatch.matched_id).slice(0, 8)}…` : '',
          similarity: _custScore,
          // Already applied during extract → default decision is
          // "accepted" so the row shows the auto-application state.
          defaultDecision: 'accepted',
          decision: null,
          onAccept: () => { /* no-op, already applied */ },
          onReject: () => {
            setFormData(prev => ({
              ...prev,
              customer: '',
              price_list: '',
              consignee_gstin: extractedCustomer?.gstin || prev.consignee_gstin,
            }));
            setFilteredPriceLists([]);
            setPriceLines([]);
            setExtractMeta(prev => prev
              ? { ...prev, customer_match: { ...(prev.customer_match || {}), exists_in_master: false, matched_id: null, matched_name: '' } }
              : prev);
          },
        });
      }

      // 2. Fuzzy COMPANY (supplier) match.
      const _coScore = Number(companyMatch?.matched_score) || 0;
      if (
        companyMatch?.exists_in_master
        && companyMatch?.matched_id
        && _coScore < 0.99
        && _coScore >= 0.5
      ) {
        _review.push({
          id: 'match:company',
          group: 'match',
          label: 'Company (Supplier)',
          extractedLabel: 'EXTRACTED (DOCUMENT)',
          extractedValue: extractedSupplier?.name || '',
          extractedMeta: extractedSupplier?.gstin || '',
          suggestedLabel: 'COMPANY MASTER',
          suggestedValue: companyMatch.matched_name || '',
          suggestedMeta: companyMatch.matched_id ? `ID ${String(companyMatch.matched_id).slice(0, 8)}…` : '',
          similarity: _coScore,
          defaultDecision: 'accepted',
          decision: null,
          onAccept: () => {},
          onReject: () => {
            setFormData(prev => ({ ...prev, company: '' }));
            setSelectedCompany('');
            setExtractMeta(prev => prev
              ? { ...prev, company_match: { ...(prev.company_match || {}), exists_in_master: false, matched_id: null, matched_name: '' } }
              : prev);
          },
        });
      }

      // 3. Header fields the PO didn't print but the price-list has
      //    a default for (payment terms, delivery type, currency,
      //    freight terms). NOT pre-applied — the row is "pending" so
      //    the user explicitly picks PL-default vs blank.
      if (extractedPriceListTerms) {
        const _term = (v) => (v ?? '').toString().trim();
        const PT_LABELS = {
          IMMEDIATE: 'Immediate', NET_15: 'Net 15', NET_30: 'Net 30',
          NET_45: 'Net 45', NET_60: 'Net 60',
        };
        const DT_LABELS = {
          EX_FACTORY: 'Ex-Factory', DOOR_DELIVERY: 'Door Delivery',
          CIF: 'CIF', FOB: 'FOB',
        };
        const FT_LABELS = { PAID: 'Paid', TO_PAY: 'To Pay' };
        const candidates = [
          { key: 'payment_terms', label: 'Payment Terms',
            extracted: _term(header.payment_terms),
            plValue: _term(extractedPriceListTerms.payment_terms),
            display: (v) => PT_LABELS[v] || v },
          { key: 'delivery_type', label: 'Delivery Terms',
            extracted: _term(header.delivery_type),
            plValue: _term(extractedPriceListTerms.delivery_type),
            display: (v) => DT_LABELS[v] || v },
          { key: 'currency', label: 'Currency',
            extracted: _term(header.currency),
            plValue: _term(extractedPriceListTerms.currency),
            display: (v) => v },
          { key: 'freight_terms', label: 'Freight Terms',
            extracted: _term(header.freight_terms),
            plValue: _term(extractedPriceListTerms.freight_terms),
            display: (v) => FT_LABELS[v] || v },
        ];
        candidates.filter(c => !c.extracted && c.plValue).forEach(c => {
          _review.push({
            id: `field:${c.key}`,
            group: 'field',
            label: c.label,
            extractedLabel: 'EXTRACTED (PO)',
            extractedValue: '(blank)',
            extractedMeta: 'PO did not print this field',
            suggestedLabel: `PRICE LIST${extractedPriceListTerms.label ? ` (${extractedPriceListTerms.label})` : ''}`,
            suggestedValue: c.display(c.plValue),
            suggestedMeta: '',
            similarity: null,
            // Not auto-applied — the user must explicitly choose.
            defaultDecision: 'pending',
            decision: null,
            onAccept: () => {
              setFormData(prev => ({ ...prev, [c.key]: c.plValue }));
            },
            onReject: () => { /* leave blank — already blank */ },
          });
        });
      }

      if (_review.length > 0) {
        setConfirmReview(_review);
      }
      // Auto-attach the uploaded PO. FileAttachments' presetPendingFiles
      // prop will seed this into its pending list so when the user hits
      // Create, the PO travels along as an attachment without a second
      // manual upload. Replay mode has no raw File (the snapshot is
      // data-only) — the original upload is already attached to the
      // draft, so skipping here is correct, not a loss.
      if (srcFile) setExtractedPoFile(srcFile);
      const pct = Math.round((overall_confidence || 0) * 100);
      toast.success(`Extracted from ${file_name || srcFile?.name || 'stored extraction'} (${pct}% confidence). Review the highlighted fields.`);
  };

  const clearExtractMeta = () => setExtractMeta(null);

  // Helper: classes for a field that the model wasn't sure about — used
  // to add an amber outline + helper note next to it.
  const fieldClass = (key) => `${inputClass}${lowConfidence.has(`header.${key}`) || lowConfidence.has(key) ? ' border-amber-400 ring-1 ring-amber-200' : ''}`;
  // Customer master addresses (from shipping_addresses)
  const [customerAddresses, setCustomerAddresses] = useState([]);
  const [selectedShipIdx, setSelectedShipIdx] = useState(0);
  // Loading flag for the "Add PO ship-to to Customer master" action.
  const [isAddingShipAddr, setIsAddingShipAddr] = useState(false);

  // Add the printed PO ship-to as a brand-new ShippingAddress on the
  // currently-selected customer. Triggered from the mismatch panel
  // (and from the empty-state panel when the customer has no
  // addresses at all). Confirms with the user first, then refreshes
  // the addresses list and auto-selects the new entry so the form
  // immediately picks it up.
  const addPoShipToCustomerMaster = async () => {
    const text = (extractMeta?.po_consignee_address || '').trim();
    if (!text) {
      toast.error('No ship-to address was extracted from the PO');
      return;
    }
    if (!formData.customer) {
      toast.error('Pick a customer first, then add the address');
      return;
    }
    const custLabel = filteredCustomers.find(c => String(c.value) === String(formData.customer))?.label
      || 'this customer';
    const ok = await confirm({
      message: `The PO ship-to address isn't on ${custLabel}'s record yet.\n\n`
      + `Add it as a new shipping address?\n\n`
      + text
    });
    if (!ok) return;
    setIsAddingShipAddr(true);
    try {
      // Run the PO ship-to through parseAddress so the new ShippingAddress
      // record gets stored in the same {raw_address, state, district,
      // pincode, country} shape the master pages expect. Without this
      // the Customer master loaded the row with an empty address /
      // state / district because the record was previously written as
      // {full: '...'} which parseAddress didn't recognise.
      const structured = parseAddress(text);
      await apiClient.post('/api/shipping-addresses/', {
        customer: formData.customer,
        address_label: `PO Ship-to ${new Date().toLocaleDateString('en-IN')}`,
        address: structured,
        contact_person: formData.consignee_name || '',
      });
      toast.success('Added to customer master');
      // Re-fetch the customer so the local shipping list reflects the
      // new row, then auto-select it.
      const r = await apiClient.get(`/api/customers/${formData.customer}/`);
      const cust = r.data || {};
      const addrs = (cust.shipping_addresses || []).map((sa, i) => ({
        label: sa.address_label || `Shipping Address ${i + 1}`,
        address: sa.address
          ? (typeof sa.address === 'object' ? stringifyAddress(sa.address) : sa.address)
          : '',
        contact: sa.contact_person || '',
        phone: sa.contact_phone || '',
        type: 'shipping',
      }));
      setCustomerAddresses(addrs);
      const newIdx = addrs.findIndex(a => (a.address || '').trim().toLowerCase() === text.toLowerCase());
      const pickIdx = newIdx >= 0 ? newIdx : addrs.length - 1;
      if (pickIdx >= 0) {
        setSelectedShipIdx(pickIdx);
        setFormData(prev => ({
          ...prev,
          consignee_address: addrs[pickIdx].address,
          destination: getDistrictState(addrs[pickIdx].address),
        }));
      }
      // Clear the mismatch warning — the address now lives in master.
      setExtractMeta(prev => prev ? {
        ...prev,
        shipping: { ...(prev.shipping || {}), matchedIndex: pickIdx, reason: 'matched_added' },
      } : prev);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsAddingShipAddr(false);
    }
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));

    // Auto Extractor mode: keep most of the master-data autofills the
    // form depends on (customers list, customer addresses dropdown,
    // price lists), but skip the three pieces the PO extraction is
    // already authoritative for:
    //   - Company change → DON'T fetch company billing address
    //                      (header.billing_address came from the PO
    //                      supplier block; replacing it would lose
    //                      the printed billing data).
    //   - Customer change → DON'T auto-set consignee_address from the
    //                       customer's first shipping address (the PO
    //                       header.consignee_address is the truth).
    //   - Price list change → DON'T fill header terms (payment_terms,
    //                         currency, delivery_type) from the price
    //                         list; the PO has those.
    if (entryMode === 'auto') {
      if (name === 'company') {
        setSelectedCompany(value);
        setFilteredPriceLists([]);
        setPriceLines([]);
        if (value) {
          apiClient.get(`/api/customers/?company=${value}`)
            .then(r => {
              const list = (r.data?.results || r.data || []).map(c => ({
                value: c.id,
                label: c.customer_name || c.name || c.id,
                raw: c,
              }));
              // Merge with anything already in the list (e.g. the
              // matched customer injected by autofillMatchedCustomer)
              // so it survives the company-scoped fetch.
              setFilteredCustomers(prev => {
                const fetchedIds = new Set(list.map(c => c.value));
                const preserved = prev.filter(c => !fetchedIds.has(c.value));
                return [...list, ...preserved];
              });
            })
            .catch(() => {});
          // Intentionally NOT fetching /api/companies/<id>/ here —
          // that's the manual-mode billing autofill we're dropping.
        }
      }
      if (name === 'customer') {
        if (value) {
          // Hydrate the shipping-addresses dropdown so the user can
          // switch addresses manually if they need to. Do NOT push
          // the first address into consignee_address — that's the
          // autofill the user explicitly wanted off in auto mode.
          apiClient.get(`/api/customers/${value}/`).then(r => {
            const cust = r.data || {};
            const addrs = (cust.shipping_addresses || []).map((sa, i) => ({
              label: sa.address_label || `Shipping Address ${i + 1}`,
              address: sa.address
                ? (typeof sa.address === 'object' ? stringifyAddress(sa.address) : sa.address)
                : '',
              contact: sa.contact_person || '',
              phone: sa.contact_phone || '',
              type: 'shipping',
            }));
            setCustomerAddresses(addrs);
          }).catch(() => {});
          // Price lists + auto-selection are owned by Effect A (keyed on
          // customer/company) and the lines by Effect B (keyed on the
          // selection) — changing formData.customer above is enough.
        } else {
          setCustomerAddresses([]);
          setFilteredPriceLists([]);
          setFormData(prev => ({ ...prev, price_list: '' }));
        }
      }
      // price_list line loading is handled by Effect B (keyed on the
      // selection). Auto mode keeps PO-printed terms, so nothing else here.
      return;
    }

    if (name === 'company') {
      setSelectedCompany(value);
      setFormData(prev => ({ ...prev, company: value, customer: '', price_list: '',
        consignee_name: '', consignee_address: '', consignee_gstin: '',
        billing_name: '', billing_address: '', billing_gstin: '',
      }));
      setFilteredCustomers([]); setFilteredPriceLists([]); setPriceLines([]);
      if (value) {
        // Fetch customers for this company
        apiClient.get(`/api/customers/?company=${value}`)
          .then(r => {
            const list = r.data?.results || r.data || [];
            setFilteredCustomers(list.map(c => ({
              value: c.id,
              label: c.customer_name || c.name || c.id,
              raw: c,
            })));
          }).catch(() => {});
        // Auto-fill billing address from company
        apiClient.get(`/api/companies/${value}/`)
          .then(r => {
            const co = r.data;
            const addr = co.billing_address || co.registered_address;
            let addrStr = '';
            if (addr) {
              if (typeof addr === 'object' && !Array.isArray(addr)) {
                // New format: {raw_address, state, district, pincode, country}
                addrStr = stringifyAddress(addr);
              } else if (typeof addr === 'string') {
                addrStr = addr;
              }
            }
            setFormData(prev => ({
              ...prev,
              billing_name: co.legal_name || co.trade_name || '',
              billing_address: addrStr || co.legal_name || '',
              billing_gstin: co.gstin || '',
            }));
          }).catch(() => {});
      }
    }
    if (name === 'customer') {
      const selectedCust = filteredCustomers.find(c => c.value === value);
      const custData = selectedCust?.raw || {};

      setFormData(prev => ({
        ...prev,
        customer: value,
        price_list: '',
        consignee_name: custData.customer_name || custData.name || '',
        consignee_gstin: custData.gstin || '',
        // Default the payment terms from the customer master's Credit Terms.
        // A price list picked later still overrides this with its own terms.
        payment_terms: custData.credit_terms || prev.payment_terms,
      }));
      setSelectedShipIdx(0);
      setCustomerAddresses([]);

      // Fetch customer detail with shipping addresses from master
      if (value) {
        apiClient.get(`/api/customers/${value}/`).then(r => {
          const cust = r.data;
          const addrs = (cust.shipping_addresses || []).map((sa, i) => ({
            label: sa.address_label || `Shipping Address ${i + 1}`,
            address: sa.address ? (typeof sa.address === 'object' ? stringifyAddress(sa.address) : sa.address) : '',
            contact: sa.contact_person || '',
            phone: sa.contact_phone || '',
            type: 'shipping',
          }));
          setCustomerAddresses(addrs);
          // Auto-select first address
          if (addrs.length > 0) {
            setFormData(prev => ({
              ...prev,
              consignee_address: addrs[0].address,
              destination: getDistrictState(addrs[0].address),
            }));
          }
        }).catch(() => {});
      }
      // Price lists (Effect A) and lines (Effect B) reload off the
      // customer/price_list change above — no per-handler fetch needed.
    }
    if (name === 'price_list' && value) {
      // Lines load via Effect B. Manual mode additionally pulls the list's
      // header terms + GST split (the PO isn't the source of truth here).
      apiClient.get(`/api/price-lists/${value}/`).then(r => {
        const pl = r.data;
        const gstType = pl.gst_type || '';
        setFormData(prev => ({
          ...prev,
          payment_terms: pl.payment_terms || prev.payment_terms,
          delivery_type: pl.delivery_terms || prev.delivery_type,
          currency: pl.currency || prev.currency,
          freight_terms: pl.default_freight_terms || prev.freight_terms,
        }));
        // Auto-fill UOM + GST split on product lines based on price list GST type
        setPoLines(prev => prev.map(line => {
          const updated = { ...line };
          if (line.parsed_sku) {
            const plLine = (pl.price_lines || []).find(p => p.product === line.parsed_sku);
            // The PO's printed UOM is AUTHORITATIVE — the rate is already
            // restated per it via rateForLineUom, so a per-MTS price list
            // still prices a KG line correctly. Only borrow the price-list
            // UOM when the PO line carried none. (Overwriting a KG line with
            // the list's MTS is what blew the amount up 1000x.)
            if (plLine?.uom && !normalizeUom(updated.uom)) updated.uom = plLine.uom;
          }
          if (gstType === 'IGST') {
            const gst = parseFloat(updated.gst) || 0;
            updated.igst_percent = String(gst);
            updated.sgst_percent = '0';
            updated.cgst_percent = '0';
          } else if (gstType === 'CGST_SGST') {
            const gst = parseFloat(updated.gst) || 0;
            updated.sgst_percent = String(gst / 2);
            updated.cgst_percent = String(gst / 2);
            updated.igst_percent = '0';
          }
          return updated;
        }));
        if (gstType) toast.success(`GST Type set to ${gstType === 'IGST' ? 'IGST (Inter-State)' : 'CGST + SGST (Intra-State)'}`);
      }).catch(() => {});
    }
  };

  const getFilteredProducts = (cat) => {
    let products = rawProducts;
    // If price list is loaded, only show products from the price list
    if (priceLines.length > 0) {
      const plProductIds = new Set(priceLines.map(pl => pl.product));
      products = products.filter(p => plProductIds.has(p.id));
    }
    if (cat) {
      products = products.filter(p => p.goods_sub_type === cat);
    }
    return products.map(p => ({ value: p.id, label: p.product_name || p.sku_code || p.id }));
  };

  // Categories present in the loaded price list. Used to scope the
  // Category dropdown so users can't accidentally pick a category
  // that has no matching products in the customer's price list.
  const priceListCategories = (() => {
    if (priceLines.length === 0 || rawProducts.length === 0) return null;
    const plIds = new Set(priceLines.map(pl => pl.product));
    const cats = new Set();
    rawProducts.forEach(p => {
      if (plIds.has(p.id) && p.goods_sub_type) cats.add(p.goods_sub_type);
    });
    return cats;
  })();

  const categoryOptionsForLine = priceListCategories
    ? GOODS_SUB_TYPE_OPTIONS.filter(o => o.value === '' || priceListCategories.has(o.value))
    : GOODS_SUB_TYPE_OPTIONS;

  const findPriceForProduct = (productId, uom) => {
    if (!productId || priceLines.length === 0) return null;
    // A price list can carry the SAME product multiple times under
    // different UOMs — the model's unique_together is
    // (price_list, product, uom). Without the UOM filter we pick
    // whichever row sorts first and end up with the wrong rate when
    // the PO's UOM differs from the first row's UOM (e.g. LTR rate
    // returned for a KG line). When `uom` is supplied, prefer an
    // exact-UOM match and fall back to the first product-only match
    // only when no UOM-specific row exists.
    if (uom) {
      const u = uomKey(uom);
      const exact = priceLines.find(
        pl => pl.product === productId
          && uomKey(pl.uom) === u,
      );
      if (exact) return exact;
    }
    return priceLines.find(pl => pl.product === productId);
  };

  const handleLineChange = (idx, field, value) => {
    setPoLines(prev => prev.map((l, i) => {
      if (i !== idx) return l;
      const nl = { ...l, [field]: value };
      if (field === 'product_category') { nl.parsed_sku = ''; nl.price = ''; nl.discount = '0'; nl.gst = '0'; nl.sgst_percent = '0'; nl.cgst_percent = '0'; }
      if (field === 'parsed_sku' && value) {
        const prod = rawProducts.find(p => p.id === value);
        if (prod) {
          nl.product_description = prod.product_name || '';
          // The line's UOM is the PO's printed unit — only adopt the
          // master's unit when the line doesn't carry a usable one.
          if (!normalizeUom(nl.uom)) nl.uom = prod.uom || nl.uom;
          // NOTE: HSN is NOT a Product field — it lives on the PriceLine
          // (filled from `pl.hsn_code` in the price block below). The old
          // `prod.sku_code` here wrongly dumped the SKU into the HSN column.
          if (!nl.product_category && prod.goods_sub_type) nl.product_category = prod.goods_sub_type;
        }
        // Price-list lookup is the source of truth for commercial
        // fields (rate, discount, GST). When the product exists on the
        // active price list, every relevant cell is filled. When the
        // product is missing from the price list the rate is left
        // blank so the user notices and either picks a different
        // product or types a manual rate — matching the extraction
        // flow's behaviour.
        const pl = findPriceForProduct(value, nl.uom);
        if (pl) {
          // Restate the PL rate per the line's UOM (per-MTS → per-KG
          // etc.) so Amount = qty × rate stays correct — and keep the
          // line's unit; the PL's unit only fills a blank.
          nl.price        = (pl.rate !== undefined && pl.rate !== null && pl.rate !== '') ? String(rateForLineUom(pl.rate, pl.uom, nl.uom)) : '';
          nl.discount     = pl.discount != null && pl.discount !== '' ? String(pl.discount) : '0';
          // HSN comes from the price line (blank is allowed). Don't clobber a
          // PO-printed HSN the line already carries when the PL has none.
          if (pl.hsn_code) nl.hsn_code = pl.hsn_code;
          if (pl.uom && !normalizeUom(nl.uom)) nl.uom = pl.uom;
          nl.sgst_percent = pl.sgst_rate != null && pl.sgst_rate !== '' ? String(pl.sgst_rate) : '0';
          nl.cgst_percent = pl.cgst_rate != null && pl.cgst_rate !== '' ? String(pl.cgst_rate) : '0';
          nl.igst_percent = pl.igst_rate != null && pl.igst_rate !== '' ? String(pl.igst_rate) : '0';
          // Synthesise the combined `gst` so the column matches the
          // SGST/CGST/IGST splits (the table shows both and a mismatch
          // looks like a bug).
          const _sgst = parseFloat(nl.sgst_percent) || 0;
          const _cgst = parseFloat(nl.cgst_percent) || 0;
          const _igst = parseFloat(nl.igst_percent) || 0;
          nl.gst = String(_sgst + _cgst + _igst);
        } else {
          // Product isn't on the active price list — wipe commercial
          // fields and let the existing "not in price list" red banner
          // above the table prompt the user to fix it.
          nl.price = '';
          nl.discount = '0';
          nl.sgst_percent = '0';
          nl.cgst_percent = '0';
          nl.igst_percent = '0';
          nl.gst = '0';
        }
      }
      // Changing the unit must restate the rate — a per-MTS rate left
      // against a KG line makes the amount 1000x off. Prefer the price
      // list (it may carry a row per UOM); otherwise rescale the manual
      // rate when the units share a dimension. Quantity is NOT touched:
      // it's the PO's printed number.
      if (field === 'uom' && uomKey(value) !== uomKey(l.uom)) {
        const pl = nl.parsed_sku ? findPriceForProduct(nl.parsed_sku, value) : null;
        if (pl && pl.rate !== undefined && pl.rate !== null && pl.rate !== '') {
          nl.price = String(rateForLineUom(pl.rate, pl.uom, value));
        } else if (String(l.price || '').trim() !== '') {
          const _dim = (u) => {
            const k = normalizeUom(u) || String(u || '').toUpperCase();
            return k in _UOM_MASS ? 'mass' : (k in _UOM_VOL ? 'vol' : '');
          };
          const scale = uomScale(value, l.uom);
          if (scale !== 1 || (_dim(value) && _dim(value) === _dim(l.uom))) {
            nl.price = String((parseFloat(l.price) || 0) * scale);
          } else {
            // Cross-dimension / unknown units aren't convertible
            // (uomScale returns 1 rather than guess) — keep the typed
            // rate and make the user check it.
            toast('Rate not converted — verify the rate for the new unit', { icon: '⚠️' });
          }
        }
      }
      // Auto-split GST into SGST/CGST (equal split)
      if (field === 'gst') {
        const totalGst = parseFloat(value) || 0;
        nl.sgst_percent = String(totalGst / 2);
        nl.cgst_percent = String(totalGst / 2);
      }
      return nl;
    }));
  };

  const addLine = () => setPoLines(prev => [...prev, { ...emptyLine }]);
  const removeLine = (idx) => { if (poLines.length > 1) setPoLines(prev => prev.filter((_, i) => i !== idx)); };

  // Replay the per-field PL values stashed in `_pl_pending` onto every
  // line still waiting for confirmation. Only fields the user hasn't
  // already touched (empty / zero on the row) get filled — a manual
  // edit can't be clobbered by clicking the banner button.
  const applyPlAutofillToPendingLines = () => {
    let appliedCount = 0;
    setPoLines(prev => prev.map(line => {
      if (!line._pl_pending) return line;
      const p = line._pl_pending;
      const next = { ...line };
      const _empty = (v) => v === undefined || v === null || String(v).trim() === '' || parseFloat(v) === 0;
      // Cross-regime gate: never fill split GST onto a line already
      // carrying IGST, or IGST onto a line carrying split GST — a line
      // is taxed under exactly one regime.
      const _has = (v) => (parseFloat(v) || 0) > 0;
      Object.keys(p).forEach(fieldKey => {
        const plVal = p[fieldKey];
        if (plVal == null) return;
        if ((fieldKey === 'sgst_percent' || fieldKey === 'cgst_percent') && _has(next.igst_percent)) return;
        if (fieldKey === 'igst_percent' && (_has(next.sgst_percent) || _has(next.cgst_percent))) return;
        if (_empty(next[fieldKey])) next[fieldKey] = plVal;
      });
      next._pl_pending = null;
      // Mark the line as user-resolved so the re-resolution useEffect
      // doesn't keep re-applying / clobbering values when the price
      // list refreshes.
      next._pl_resolved = true;
      appliedCount += 1;
      return next;
    }));
    if (appliedCount > 0) {
      toast.success(`Filled missing rate / discount / GST from price list on ${appliedCount} line(s).`);
    }
  };

  // User explicitly said "leave empty" — clear `_pl_pending` AND set
  // `_pl_dismissed` so the re-resolution useEffect won't refill the
  // blanked fields the moment the price list refreshes.
  const dismissPlAutofillForPendingLines = () => {
    let dismissedCount = 0;
    setPoLines(prev => prev.map(line => {
      if (!line._pl_pending) return line;
      dismissedCount += 1;
      return { ...line, _pl_pending: null, _pl_dismissed: true };
    }));
    if (dismissedCount > 0) {
      toast.success(`Left ${dismissedCount} line(s) blank — fill rate / discount / GST manually if needed.`);
    }
  };

  const calcLineTotal = (l) => {
    const qty = parseFloat(l.quantity) || 0;
    const price = parseFloat(l.price) || 0;
    const disc = parseFloat(l.discount) || 0;
    const gst = parseFloat(l.gst) || 0;
    const sub = qty * price - disc;
    return sub + sub * gst / 100;
  };

  const calcLineSGST = (l) => {
    const qty = parseFloat(l.quantity) || 0;
    const price = parseFloat(l.price) || 0;
    const disc = parseFloat(l.discount) || 0;
    const sgst = parseFloat(l.sgst_percent) || 0;
    return (qty * price - disc) * sgst / 100;
  };

  const calcLineCGST = (l) => {
    const qty = parseFloat(l.quantity) || 0;
    const price = parseFloat(l.price) || 0;
    const disc = parseFloat(l.discount) || 0;
    const cgst = parseFloat(l.cgst_percent) || 0;
    return (qty * price - disc) * cgst / 100;
  };

  const totalQty = poLines.reduce((s, l) => s + (parseFloat(l.quantity) || 0), 0);
  const totalAmount = poLines.reduce((s, l) => s + ((parseFloat(l.quantity) || 0) * (parseFloat(l.price) || 0)), 0);
  const totalDiscount = poLines.reduce((s, l) => s + (parseFloat(l.discount) || 0), 0);
  const totalSGST = poLines.reduce((s, l) => s + calcLineSGST(l), 0);
  const totalCGST = poLines.reduce((s, l) => s + calcLineCGST(l), 0);
  const grandTotal = poLines.reduce((s, l) => s + calcLineTotal(l), 0);
  const fmt = (v) => formatCurrency(v);
  const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.customer) { toast.error('Customer is required'); return; }
    if (!formData.price_list) { toast.error('Price List is required'); return; }
    if (!formData.delivery_type) { toast.error('Delivery Terms is required'); return; }
    if (!(formData.payment_terms || '').trim()) { toast.error('Payment Terms is required'); return; }
    if (!formData.consignee_address) { toast.error('Consignee (Ship To) address is required'); return; }
    if (!formData.billing_address) { toast.error('Billing Address is required'); return; }
    const validLines = poLines.filter(l => l.parsed_sku && l.quantity);
    if (validLines.length === 0) { toast.error('At least one product line with product and quantity is required'); return; }

    // Hard guard against company ↔ customer mismatch. The Auto Extractor
    // detects this case during upload and locks the Company dropdown,
    // but we re-verify here so:
    //   1. Manual-entry POs (no Auto Extractor) are also covered.
    //   2. A stale extractMeta from a previous upload can't bypass the
    //      check via the disabled-field shortcut.
    // Saving a PO under the wrong Company corrupts the buyer ↔ seller
    // relationship in every downstream DC, invoice and receivable.
    if (extractMeta?.company_customer_check?.state === 'mismatch') {
      toast.error(
        'This PO cannot be saved — the customer is registered under a different Company in master. '
        + 'Fix the customer\'s Company in master, then re-upload the PO.',
      );
      return;
    }
    const selectedCustomer = filteredCustomers.find(c => c.value === formData.customer);
    const customerCompanyOnFile = selectedCustomer?.raw?.company || null;
    if (customerCompanyOnFile && formData.company && customerCompanyOnFile !== formData.company) {
      toast.error(
        'Selected Customer is registered under a different Company in master. '
        + 'Pick a Customer registered under the current Company, or correct the customer in master.',
      );
      return;
    }
    if (selectedCustomer?.raw && !customerCompanyOnFile) {
      toast.error(
        'Selected Customer has no Company assigned in master. '
        + 'Open the customer record and set a Company before saving this PO.',
      );
      return;
    }

    setIsLoading(true);
    try {
      // Merge multiple addresses into the main fields
      const payload = {
        ...formData,
        company: formData.company || null,
        price_list: formData.price_list || null,
        state_group: formData.state_group || null,
        required_ship_date: formData.required_ship_date || null,
        delivery_due_date: formData.delivery_due_date || null,
        po_lines: validLines.map(l => ({
          parsed_sku: l.parsed_sku || null, product_description: l.product_description || '',
          item_code: l.item_code || '', hsn_code: l.hsn_code || '', quantity: dec(l.quantity, 4), uom: l.uom || '',
          price: dec(l.price, 2),
          po_rate: dec(l.po_rate, 2),
          discount: dec(l.discount, 2) ?? 0, gst: dec(l.gst, 2) ?? 0,
          sgst_percent: dec(l.sgst_percent, 2) ?? 0, cgst_percent: dec(l.cgst_percent, 2) ?? 0,
          igst_percent: dec(l.igst_percent, 2) ?? 0,
          line_remarks: l.line_remarks || '',
        })),
      };
      // Review-replay: this form session is reviewing an existing
      // bulk-created DRAFT (see reviewDraftId) — update THAT record
      // via PUT (the edit page already uses PUT with this serializer,
      // so nested po_lines are supported) instead of creating a new
      // CPO. The backend ignores upload_id on update, so the draft
      // keeps its own number (which the PO No field already shows).
      const isDraftUpdate = Boolean(reviewDraftId);
      const res = isDraftUpdate
        ? await apiClient.put(`/api/sales/customer-po/${reviewDraftId}/`, payload)
        : await apiClient.post('/api/sales/customer-po/', payload);
      const newId = isDraftUpdate ? reviewDraftId : res.data?.id;
      toast.success(isDraftUpdate
        ? `Draft ${res.data?.upload_id || poNo || ''} updated`
        : 'Customer PO created!');
      if (pendingAttachments.length > 0 && newId) { await uploadPendingFiles('CUSTOMER_PO', newId, pendingAttachments); }
      // If this PO was started from an inbox email, flip that inbox
      // row to PROCESSED now — at the point the user has actually
      // committed the data. Non-fatal: the PO is already saved.
      const pendingInboxId = pendingInboxIdRef.current;
      if (pendingInboxId) {
        pendingInboxIdRef.current = '';
        try {
          await apiClient.post(`/api/sales/inbox-pos/${pendingInboxId}/mark-processed/`);
        } catch (e) {
          console.warn('mark-processed failed (non-fatal):', e);
        }
      }
      navigate(`/sales/customer-po/${newId || ''}`);
    } catch (error) {
      // Backend returns a structured duplicate hint when the
      // (customer, po_number) pair (or a cross-customer collision)
      // already exists. Show a persistent banner above the form so
      // the user sees the conflict, can choose to view the existing
      // record, or change the PO number and re-save. The previous
      // 800ms auto-redirect was disorienting — users couldn't tell
      // whether the save had succeeded or failed before being
      // bounced to a different page.
      const dupHint = error?.response?.data?.duplicate_of;
      const dupMessage = error?.response?.data?.po_number;
      if (dupHint?.id) {
        const msg = (Array.isArray(dupMessage) ? dupMessage[0] : dupMessage)
          || 'A Customer PO with this PO number already exists.';
        setDuplicateError({
          message: msg,
          existingId: dupHint.id,
          existingUploadId: dupHint.upload_id,
          existingStatus: dupHint.status,
        });
        toast.error(msg, { duration: 6000 });
      } else {
        toast.error(getApiErrorMessage(error));
      }
    }
    finally { setIsLoading(false); }
  };

  // ── Inbox auto-ingest ──────────────────────────────────────────────
  // Triggered by a `?inbox_id=...&attachment_id=...` URL — the "Process
  // Mail" button on the Customer PO list inbox panel. Fetches the
  // attachment as a Blob from the backend, converts it to a File, and
  // feeds it into `handleExtractFromFile` exactly as if the user had
  // picked it from disk. Then marks the inbox row PROCESSED and
  // strips the params so a refresh doesn't re-extract.
  //
  // `inboxLoadedRef` guards against double-fires from React 18's
  // strict-mode double mount in dev.
  useEffect(() => {
    if (!inboxId || !inboxAttachmentId) return;
    // `inboxLoadedRef` is the SINGLE source of truth for "should this
    // effect run". It survives React 18 StrictMode's dev double-mount
    // (refs aren't reset between mount cycles), so the second invoke
    // returns early and only one download is ever issued.
    //
    // Earlier this effect also carried a `cancelled` flag set by the
    // cleanup function — that was a footgun: StrictMode's first
    // mount → cleanup → second mount sequence flipped `cancelled` to
    // true before the download finished, then the `finally` block's
    // `if (!cancelled)` skipped the state reset and left the loading
    // banner stuck forever. Removed.
    if (inboxLoadedRef.current) return;
    inboxLoadedRef.current = true;
    (async () => {
      try {
        setIsLoadingInboxFile(true);
        // Inbox flow only makes sense in Auto Extractor mode — flip
        // there so the extraction card is visible while we work.
        setEntryMode('auto');
        // Pull the binary. Use apiClient (sends auth header) but
        // override responseType so axios doesn't try to JSON-parse a
        // PDF / image / docx body. 15s timeout — the file is on our
        // own server and is hard-capped at 25 MB, anything slower
        // points at runserver thread starvation or proxy weirdness
        // and we want to fail fast so the user can fall back.
        const downloadUrl = `/api/sales/inbox-pos/${inboxId}/attachments/${inboxAttachmentId}/download/`;
        console.log('[inbox] fetching attachment:', downloadUrl);
        const res = await apiClient.get(downloadUrl, {
          responseType: 'blob',
          timeout: 15000,
        });
        console.log('[inbox] attachment received:', res.status, res.headers?.['content-length'] || '?', 'bytes');
        const blob = res.data;
        // Resolve the filename in priority order:
        //   1. `filename` URL param (passed from the inbox panel — most
        //      reliable, immune to CORS / proxy header stripping).
        //   2. Content-Disposition header (works when CORS exposes it
        //      AND the proxy doesn't strip it — true in dev, often
        //      false in prod).
        //   3. Generic "inbox-attachment" fallback — last resort; loses
        //      the extension which the extractor needs to accept the
        //      file, so this path means the extractor will reject the
        //      upload with "Upload a PDF, image..." until the user
        //      retries via the inbox panel button (which sets the
        //      filename param).
        let filename = inboxFilenameParam;
        if (!filename) {
          const disp = res.headers?.['content-disposition'] || '';
          const match = /filename\*?=(?:UTF-8'')?["']?([^;"'\n]+)["']?/i.exec(disp);
          filename = match ? decodeURIComponent(match[1]) : 'inbox-attachment';
        }
        const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
        // Remember which inbox row to mark PROCESSED later — only
        // AFTER the user saves the Customer PO, not now. Stashed in a
        // ref because the URL params are about to be stripped.
        pendingInboxIdRef.current = inboxId;
        // Strip the URL params BEFORE extraction kicks off so a
        // user-triggered refresh during extraction doesn't re-enter
        // this effect.
        searchParams.delete('inbox_id');
        searchParams.delete('attachment_id');
        searchParams.delete('filename');
        setSearchParams(searchParams, { replace: true });
        toast.success(`Loaded "${filename}" from inbox — extracting…`);
        // Drop the inbox banner BEFORE the extraction kicks off —
        // handleExtractFromFile has its own loading UI inside the
        // upload card, which shows actual progress (status text +
        // spinner). Leaving the banner up through the 10-40s Gemini
        // call looks like the page has hung.
        setIsLoadingInboxFile(false);
        // Pass the inbox refs so the extract endpoint can cache (and
        // re-serve) the Gemini result. First extract per attachment
        // hits Gemini and writes the cache; every subsequent click on
        // Process Mail for the same attachment returns instantly from
        // that cache with zero LLM cost.
        await handleExtractFromFile(file, {
          inboxId,
          inboxAttachmentId,
        });
        // NOTE: do NOT flip the inbox row to PROCESSED here. Extraction
        // only pre-fills the form — the user might still abandon the
        // page without saving. The flip happens in handleSubmit after
        // the Customer PO is actually created (see pendingInboxIdRef).
      } catch (err) {
        console.error('inbox attachment auto-ingest failed', err);
        toast.error(
          err?.response?.data?.detail
          || 'Failed to load inbox attachment. Try processing it manually from the Customer PO list.',
        );
        // Mark the inbox row FAILED so the user can spot which one
        // didn't go through.
        try {
          await apiClient.post(
            `/api/sales/inbox-pos/${inboxId}/mark-failed/`,
            { reason: err?.response?.data?.detail || err?.message || 'attachment download or extraction failed' },
          );
        } catch { /* non-fatal */ }
      } finally {
        // Unconditional — we never want the banner to stay up after
        // the async fn exits, regardless of which branch took us
        // here. (Setting state after unmount in React 18 is a no-op
        // with a dev warning, not an error.)
        setIsLoadingInboxFile(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxId, inboxAttachmentId]);

  // ── Review replay ──────────────────────────────────────────────────
  // Replays a STORED extraction through applyExtraction — the exact
  // pipeline a fresh upload runs — with zero Gemini cost. Two entry
  // points (see the param docs next to reviewDraftParam above):
  //   ?draft=<id>    — replay the draft's extraction_snapshot; Save
  //                    becomes a PUT that updates the same draft.
  //   ?bulkReview=1  — replay the sessionStorage 'bulk_po_review' stash
  //                    (unresolved customer); Save creates a new CPO.
  // `reviewLoadedRef` survives StrictMode's dev double-mount so the
  // replay runs exactly once per page load.
  useEffect(() => {
    if (!reviewDraftParam && !bulkReviewParam) return;
    if (reviewLoadedRef.current) return;
    reviewLoadedRef.current = true;
    (async () => {
      // Replay only makes sense in Auto Extractor mode — the extraction
      // banner / review UI lives there. (Default is already 'auto', but
      // be explicit so a future default change can't break replay.)
      setEntryMode('auto');
      // Same clean-slate + loading UI a fresh upload gets. The reset is
      // a no-op on a fresh mount but keeps the replay path identical to
      // handleExtractFromFile's sequence.
      resetFormToDefaults();
      setIsExtracting(true);
      try {
        if (reviewDraftParam) {
          const res = await apiClient.get(`/api/sales/customer-po/${reviewDraftParam}/`);
          const snapshot = res.data?.extraction_snapshot;
          if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && Object.keys(snapshot).length > 0) {
            setReviewDraftId(reviewDraftParam);
            // Scope fallback = the draft's own company, mirroring what
            // the original upload captured from the form.
            await applyExtraction(snapshot, null, res.data?.company || '');
            // AFTER the replay: the draft keeps its own number — show
            // it in the PO No field instead of a next-number preview
            // (that fetch was skipped above; the backend also ignores
            // upload_id on PUT, so this is display + reassurance).
            setPoNo(res.data?.upload_id || '');
            toast(
              `Reviewing draft ${res.data?.upload_id || ''} — saving will update it.`,
              { icon: 'ℹ️', duration: 6000 },
            );
          } else {
            // No snapshot stored (old draft, or bulk upload predates the
            // snapshot column). Fall back to a normal create page: fetch
            // the next-number preview we skipped on mount.
            toast.error('This draft has no stored extraction to replay — upload the PO file again or fill the form manually.');
            apiClient.get('/api/sales/customer-po/next-number/')
              .then(r => setPoNo(r.data?.number || ''))
              .catch(() => setPoNo(''));
          }
        } else {
          const raw = sessionStorage.getItem('bulk_po_review');
          if (raw) {
            // One-shot: consume the stash so a refresh doesn't replay a
            // stale extraction into a form the user may have edited.
            sessionStorage.removeItem('bulk_po_review');
            const parsed = JSON.parse(raw);
            await applyExtraction(parsed?.extraction, null, '');
            toast(
              `Loaded extraction${parsed?.fileName ? ` from "${parsed.fileName}"` : ''} — no customer could be matched automatically. Pick the customer manually, then save.`,
              { icon: '⚠️', duration: 8000 },
            );
          } else {
            toast.error('No pending bulk-review extraction found — it may already have been reviewed in this tab.');
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[review replay] failed', err);
        toast.error(getApiErrorMessage(err) || 'Could not load the stored extraction for review.');
      } finally {
        setIsExtracting(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <MainLayout>
      <PageHeader title="Create Customer PO" breadcrumbs={[
        { label: 'Sales', path: '/sales' }, { label: 'Customer PO', path: '/sales/customer-po' }, { label: 'Create' },
      ]} />

      {/* Duplicate-PO banner — set when the server rejected the save
          because a Customer PO with the same number already exists.
          Persistent (unlike the toast) so the user can read it, decide
          whether to open the existing record or change the PO number,
          and react without time pressure. Auto-clears when the user
          edits the PO Number field. */}
      {duplicateError && (
        <div className="mb-4 px-4 py-3 bg-red-50 border border-red-300 rounded-lg flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-red-800">Duplicate PO Number</p>
            <p className="text-sm text-red-700 mt-0.5">{duplicateError.message}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => navigate(`/sales/customer-po/${duplicateError.existingId}`)}
              className="px-3 py-1.5 text-xs font-medium bg-red-600 text-white rounded hover:bg-red-700"
            >
              View existing PO
            </button>
            <button
              type="button"
              onClick={() => setDuplicateError(null)}
              className="px-3 py-1.5 text-xs font-medium bg-white border border-red-300 text-red-700 rounded hover:bg-red-100"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Inbox auto-ingest banner — only visible while we're pulling
          the attachment off the backend. Disappears once
          handleExtractFromFile takes over (which has its own
          loading UI under the upload card). */}
      {isLoadingInboxFile && (
        <div className="mb-4 flex items-center justify-between gap-3 px-4 py-3 bg-indigo-50 border border-indigo-200 rounded-lg text-sm text-indigo-800">
          <div className="flex items-center gap-3 min-w-0">
            <Loader2 size={16} className="animate-spin shrink-0" />
            <span>Downloading attachment from your inbox… the extractor starts automatically once it lands.</span>
          </div>
          {/* Escape hatch if the download genuinely hangs — lets the
              user dismiss the banner and switch to manual upload
              instead of being stuck. */}
          <button
            type="button"
            onClick={() => {
              setIsLoadingInboxFile(false);
              // Break the inbox→PO link so a subsequent manual save
              // doesn't accidentally mark the cancelled inbox row as
              // processed.
              pendingInboxIdRef.current = '';
              searchParams.delete('inbox_id');
              searchParams.delete('attachment_id');
              searchParams.delete('filename');
              setSearchParams(searchParams, { replace: true });
              toast('Cancelled — upload the PO manually below.', { icon: '✕' });
            }}
            className="px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 rounded shrink-0"
          >
            Cancel
          </button>
        </div>
      )}

      {/* ── Entry mode picker ─────────────────────────────────────────
          Manual Entry keeps the form untouched. Auto Extractor reveals
          the Gemini upload card; the actual extraction call only fires
          from inside that card, so manual mode is guaranteed to never
          hit the LLM endpoint. */}
      <div className="mb-4 flex items-center gap-2">
        <span className="text-sm font-medium text-slate-700 mr-1">Entry mode:</span>
        <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
          <button
            type="button"
            onClick={() => switchEntryMode('manual')}
            className={`px-4 py-2 text-sm font-medium ${
              entryMode === 'manual'
                ? 'bg-primary-600 text-white'
                : 'bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            Manual Entry
          </button>
          <button
            type="button"
            onClick={() => switchEntryMode('auto')}
            className={`inline-flex items-center gap-1 px-4 py-2 text-sm font-medium border-l border-slate-300 ${
              entryMode === 'auto'
                ? 'bg-indigo-600 text-white'
                : 'bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Sparkles size={13} /> Auto Extractor
          </button>
        </div>
      </div>

      {/* ── AI-assisted Upload PO ─────────────────────────────────────
          Drop a customer PO file here (PDF / image / DOCX) and Gemini
          2.5 Flash extracts header fields + line items, then autofills
          the form below. Only shown when entry mode is 'auto'. */}
      {entryMode === 'auto' && (
      <div className={`bg-gradient-to-br from-indigo-50 to-white border-2 border-dashed border-indigo-200 rounded-lg mb-4 ${
        !extractMeta && !isExtracting
          ? 'p-10 flex flex-col items-center text-center'
          : 'p-4 sm:p-6'
      }`}>
        {/* Initial empty state — only the Upload PO button is shown until
            the user actually uploads a file. Form is hidden below. */}
        {!extractMeta && !isExtracting && (
          <>
            <div className="rounded-full bg-indigo-100 p-4 text-indigo-700 mb-4">
              <Sparkles size={28} />
            </div>
            <h3 className="text-lg font-semibold text-slate-800 mb-1">Upload PO &amp; auto-fill</h3>
            <p className="text-sm text-slate-500 max-w-md mb-5">
              Drop a customer PO (PDF, PNG/JPG, or DOCX). We&apos;ll read it with Gemini and pre-fill the entire form for you.
            </p>
            <label className="inline-flex items-center gap-2 px-4 sm:px-6 py-3 rounded-lg text-sm font-semibold border bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700 cursor-pointer shadow-sm">
              <Upload size={16} />
              Upload PO
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,application/pdf,image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) handleExtractFromFile(f);
                }}
              />
            </label>
            <p className="text-xs text-slate-400 mt-3">Or switch to <button type="button" onClick={() => switchEntryMode('manual')} className="underline hover:text-slate-600">Manual Entry</button> above.</p>
          </>
        )}

        {/* Loading state — Gemini is reading the PO. Form stays hidden
            until extraction returns. */}
        {isExtracting && (
          <div className="flex flex-col items-center text-center py-4 sm:py-6">
            <Loader2 size={36} className="text-indigo-600 animate-spin mb-4" />
            <h3 className="text-base font-semibold text-slate-800 mb-1">Reading your PO…</h3>
            <p className="text-sm text-slate-500 max-w-md">
              Extracting buyer, supplier, line items and terms with Gemini 2.5 Flash. This usually takes 5–15 seconds.
            </p>
          </div>
        )}

        {/* Result state — extraction complete. Header + status pills +
            confidence chip + re-upload affordance. Form is rendered
            below this card. */}
        {extractMeta && !isExtracting && (
          <>
        <div className="flex items-start gap-3 mb-3">
          <div className="rounded-lg bg-indigo-100 p-2 text-indigo-700">
            <Sparkles size={18} />
          </div>
          <div>
            <h3 className="text-base font-semibold text-slate-800">PO extracted — review and save</h3>
            <p className="text-xs text-slate-500">
              Fields below were auto-filled from your PO. Amber-highlighted fields are low-confidence — please double-check before saving.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border cursor-pointer ${
              isExtracting
                ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                : 'bg-white text-indigo-700 border-indigo-300 hover:bg-indigo-50'
            }`}
          >
            <Upload size={14} />
            Re-upload PO
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,application/pdf,image/*"
              className="hidden"
              disabled={isExtracting}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = ''; // allow re-selecting the same file
                if (f) handleExtractFromFile(f);
              }}
            />
          </label>
          {extractMeta && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-slate-700">
              <FileText size={12} className="text-slate-500" />
              <span className="font-medium truncate max-w-[260px]">{extractMeta.file_name}</span>
              <span className="text-slate-400">·</span>
              <span className={`font-semibold ${
                extractMeta.overall_confidence >= 0.8 ? 'text-emerald-600'
                  : extractMeta.overall_confidence >= 0.5 ? 'text-amber-600'
                  : 'text-red-600'
              }`}>
                {Math.round((extractMeta.overall_confidence || 0) * 100)}% confident
              </span>
              <button type="button" onClick={clearExtractMeta} aria-label="Clear extracted document info" title="Clear" className="ml-1 text-slate-400 hover:text-slate-600">
                <X size={12} />
              </button>
            </div>
          )}
        </div>
        {/* Customer match status — the buyer printed at the top of the
            PO is what we try to resolve against the Customer master.
            Three states: matched (green), not-in-master (amber warning),
            or nothing detected (silent). */}
        {extractMeta?.customer_match?.name_from_document && (() => {
          const m = extractMeta.customer_match;
          const docName = m.name_from_document;
          const docGstin = m.gstin_from_document;
          if (m.exists_in_master) {
            return (
              <p className="mt-3 text-xs text-emerald-700 flex items-start gap-1">
                <Check size={12} className="mt-0.5 flex-shrink-0" />
                <span>
                  Customer matched in master:{' '}
                  <span className="font-semibold">{m.matched_name}</span>
                  {docGstin ? <span className="text-emerald-600"> · GSTIN {docGstin}</span> : null}
                  <span className="text-slate-500"> — auto-selected in the Customer dropdown below.</span>
                </span>
              </p>
            );
          }
          return (
            <p className="mt-3 text-xs text-red-700 flex items-start gap-1">
              <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
              <span>
                Customer <span className="font-semibold">&quot;{docName}&quot;</span>
                {docGstin ? <span> (GSTIN {docGstin})</span> : null}
                {' '}is not in your customer master
                {m.scoped_to_company ? ' for this company' : ''}.
                Add the customer first, or pick a close match from the dropdown below.
              </span>
            </p>
          );
        })()}
        {/* Company ↔ Customer cross-check. When the auto-picked Company
            (from the PO supplier block) doesn't match the Company the
            matched Customer is actually registered under in master, we
            auto-correct the form's Company and tell the user what we
            did. If the customer has no Company set at all, we flag it
            as a validation error so it can't slip through Save. */}
        {extractMeta?.company_customer_check && (() => {
          const cc = extractMeta.company_customer_check;
          if (cc.state === 'mismatch') {
            return (
              <p className="mt-2 text-xs text-red-700 flex items-start gap-1">
                <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                <span>
                  Customer <span className="font-semibold">{cc.customer_name}</span> is registered under{' '}
                  <span className="font-semibold">{cc.customer_company_name || 'a different company'}</span>{' '}
                  in master, not <span className="font-semibold">{cc.po_company_name}</span>.
                  <span className="text-slate-500">
                    {' '}Company field is locked — Save is blocked until the customer's Company is corrected in
                    master, or a different customer / PO is uploaded.
                  </span>
                </span>
              </p>
            );
          }
          if (cc.state === 'filled_from_customer') {
            return (
              <p className="mt-2 text-xs text-emerald-700 flex items-start gap-1">
                <Check size={12} className="mt-0.5 flex-shrink-0" />
                <span>
                  Company filled from the customer master:{' '}
                  <span className="font-semibold">{cc.to_company_name || cc.customer_name}</span>
                  <span className="text-slate-500"> — the PO didn't carry a recognisable supplier block.</span>
                </span>
              </p>
            );
          }
          if (cc.state === 'no_company_on_customer') {
            return (
              <p className="mt-2 text-xs text-red-700 flex items-start gap-1">
                <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                <span>
                  Customer <span className="font-semibold">{cc.customer_name}</span> has no Company assigned in master.
                  Open the customer record and set a Company before saving this PO.
                </span>
              </p>
            );
          }
          return null;
        })()}
        {/* Supplier match — does the supplier on the PO (= us) match
            one of our Companies in master? If yes, the Company dropdown
            is auto-selected and Billing Address is filled from the
            company record. If not, we tell the user that no company in
            master carries this address. */}
        {extractMeta?.company_match?.name_from_document && (() => {
          const cm = extractMeta.company_match;
          const docName = cm.name_from_document;
          const docGstin = cm.gstin_from_document;
          const docPin = cm.pincode_from_document;
          if (cm.exists_in_master) {
            return (
              <p className="mt-2 text-xs text-emerald-700 flex items-start gap-1">
                <Check size={12} className="mt-0.5 flex-shrink-0" />
                <span>
                  Addressed to <span className="font-semibold">{cm.matched_name}</span> in your company master
                  {docGstin ? <span className="text-emerald-600"> · GSTIN {docGstin}</span> : null}
                  {docPin ? <span className="text-emerald-600"> · PIN {docPin}</span> : null}
                  <span className="text-slate-500"> — Company auto-selected; Billing Address filled from master.</span>
                </span>
              </p>
            );
          }
          return (
            <p className="mt-2 text-xs text-red-700 flex items-start gap-1">
              <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
              <span>
                Addressed to <span className="font-semibold">&quot;{docName}&quot;</span>
                {docGstin ? <span> · GSTIN {docGstin}</span> : null}
                {docPin ? <span> · PIN {docPin}</span> : null}
                {' '}— this address isn&apos;t present on any company in your master.
                The Billing Address below was filled from the document; pick a Company manually before saving.
              </span>
            </p>
          );
        })()}
        {/* Shipping address sanity check — does the consignee printed
            on the PO match one of the customer's shipping addresses in
            master? */}
        {extractMeta?.shipping && extractMeta?.po_consignee_address && (() => {
          const sh = extractMeta.shipping;
          if (sh.matchedIndex >= 0) {
            return (
              <p className="mt-2 text-xs text-emerald-700 flex items-start gap-1">
                <Check size={12} className="mt-0.5 flex-shrink-0" />
                <span>
                  Ship-to on PO matches the customer&apos;s shipping address #{sh.matchedIndex + 1}
                  <span className="text-slate-500"> — auto-selected in the Consignee section.</span>
                </span>
              </p>
            );
          }
          if (sh.reason === 'no_customer_addresses') {
            return (
              <div className="mt-2 text-xs text-red-700">
                <p className="flex items-start gap-1">
                  <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                  <span>
                    The customer has no shipping addresses configured in master.
                    Add the PO&apos;s ship-to as a shipping address on the customer record before saving.
                  </span>
                </p>
                <button
                  type="button"
                  onClick={addPoShipToCustomerMaster}
                  disabled={isAddingShipAddr || !formData.customer}
                  className="mt-2 inline-flex items-center gap-1 px-3 py-1.5 bg-emerald-600 text-white rounded-md text-xs font-medium hover:bg-emerald-700 disabled:opacity-50"
                >
                  <Plus size={12} /> {isAddingShipAddr ? 'Adding…' : 'Add this address to Customer master'}
                </button>
              </div>
            );
          }
          // no_match — customer has addresses but none align with the PO's ship-to
          return (
            <div className="mt-2 text-xs text-red-700">
              <p className="flex items-start gap-1">
                <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                <span>
                  Shipping address on the PO doesn&apos;t match any of the customer&apos;s addresses in master.
                  {' '}<span className="font-medium">PO ship-to:</span>{' '}
                  <span className="italic">{extractMeta.po_consignee_address}</span>
                  {' '}— add this address to the customer or pick the closest existing one from the dropdown.
                </span>
              </p>
              <button
                type="button"
                onClick={addPoShipToCustomerMaster}
                disabled={isAddingShipAddr || !formData.customer}
                className="mt-2 inline-flex items-center gap-1 px-3 py-1.5 bg-emerald-600 text-white rounded-md text-xs font-medium hover:bg-emerald-700 disabled:opacity-50"
              >
                <Plus size={12} /> {isAddingShipAddr ? 'Adding…' : 'Add this address to Customer master'}
              </button>
            </div>
          );
        })()}
        {extractMeta && (extractMeta.low_confidence_fields?.length || 0) > 0 && (
          <p className="mt-2 text-xs text-amber-700 flex items-start gap-1">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
            <span>
              Low-confidence fields:{' '}
              {(extractMeta.low_confidence_fields || []).join(', ')}
            </span>
          </p>
        )}
          </>
        )}
      </div>
      )}

      {/* Form is gated in auto mode — only shown after Gemini returns
          an extraction. In manual mode it's always visible. */}
      {(entryMode === 'manual' || (entryMode === 'auto' && extractMeta && !isExtracting)) && (
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
        <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-6" noValidate>
          {/* Order Details */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Order Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div><label className="block text-sm font-medium text-slate-700 mb-1">PO No</label>
                <input type="text" value={poNo} readOnly className={`${inputClass} bg-slate-50 text-slate-600 font-medium`} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">PO Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="po_date" value={formData.po_date} onChange={handleChange} className={fieldClass('po_date')} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
                {/* Always editable — never lock Company, even on an extraction
                    mismatch. If extraction picked the wrong company (or none),
                    the user must be able to select the correct one manually. */}
                <CustomSelect
                  name="company"
                  value={formData.company}
                  onChange={handleChange}
                  className={inputClass}
                >
                  <option value="">Select Company</option>{companyOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Customer <span className="text-red-500">*</span></label>
                <CustomSelect name="customer" value={formData.customer} onChange={handleChange} disabled={!selectedCompany} className={`${inputClass} disabled:bg-slate-100`}>
                  <option value="">{selectedCompany ? 'Select Customer' : 'Select Company first'}</option>{filteredCustomers.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Price List <span className="text-red-500">*</span></label>
                <CustomSelect name="price_list" value={formData.price_list} onChange={handleChange} disabled={!formData.customer} className={`${inputClass} disabled:bg-slate-100`}>
                  <option value="">{formData.customer ? 'Select Price List' : 'Select Customer first'}</option>
                  {filteredPriceLists.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
                {formData.price_list && priceLines.length > 0 && (
                  <p className="text-xs text-green-600 mt-1">{priceLines.length} product(s) in price list</p>
                )}
              </div>
              {/* State Group — only relevant for customers whose price
                  list ACTUALLY carries state-wise rows. Detected by
                  scanning the loaded `priceLines` for any non-null
                  state_group; if none exists, this customer's pricing
                  isn't state-segmented and the field is hidden
                  entirely — keeps the form tight for the common case.
                  When shown: auto-filled by the Gemini extractor for
                  uploads, manually picked for typed entry. */}
              {priceLines.some(pl => pl.state_group) && (
                <div><label className="block text-sm font-medium text-slate-700 mb-1">State Group</label>
                  <CustomSelect
                    name="state_group"
                    value={formData.state_group || ''}
                    onChange={handleChange}
                    className={inputClass}
                    title="Blank = use the customer-wide default rate. Auto-resolved on PO upload from the ship-to address."
                  >
                    <option value="">— Default —</option>
                    {stateGroupOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                  {formData.state_group && (() => {
                    const sg = stateGroupsRaw.find(g => String(g.id) === String(formData.state_group));
                    return sg && Array.isArray(sg.member_states) && sg.member_states.length > 0
                      ? <p className="text-xs text-slate-500 mt-1">States: {sg.member_states.join(', ')}</p>
                      : null;
                  })()}
                </div>
              )}
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Customer PO Number</label>
                <input type="text" name="po_number" value={formData.po_number} onChange={handleChange} className={fieldClass('po_number')} placeholder="e.g. PO-1010125-05881" /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Delivery Terms <span className="text-red-500">*</span></label>
                <CustomSelect name="delivery_type" value={formData.delivery_type} onChange={handleChange} className={inputClass}>
                  <option value="">Select</option><option value="EX_FACTORY">Ex-Factory</option><option value="DOOR_DELIVERY">Door Delivery</option><option value="CIF">CIF</option><option value="FOB">FOB</option>
                </CustomSelect></div>
            </div>
          </div>

          {/* Terms & Currency */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Terms & Currency</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {/* Freight Terms — the list page shows this column for
                  every PO but the form previously had no manual entry
                  for it (only auto-extracted from the AI parser /
                  pulled from the Price List default). Mirrors the
                  Sales Order form's behaviour: disabled when
                  delivery_type is EX_FACTORY because the customer
                  arranges freight in that case. Options match the
                  termLabel() map on the list page (PAID / TO_PAY). */}
              <div><label className="block text-sm font-medium text-slate-700 mb-1">
                  Freight Terms
                </label>
                <CustomSelect
                  name="freight_terms"
                  value={formData.freight_terms || ''}
                  onChange={handleChange}
                  disabled={formData.delivery_type === 'EX_FACTORY'}
                  className={`${inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`}
                >
                  <option value="">
                    {formData.delivery_type === 'EX_FACTORY'
                      ? 'Not applicable — customer arranges'
                      : 'Select Freight Terms'}
                  </option>
                  <option value="PAID">Paid</option>
                  <option value="TO_PAY">To Pay</option>
                </CustomSelect></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Payment Terms <span className="text-red-500">*</span></label>
                <CustomSelect name="payment_terms" value={formData.payment_terms} onChange={handleChange} className={inputClass}>
                  <option value="">Select</option>
                  <option value="IMMEDIATE">Immediate</option>
                  {/* CASH / CUSTOM mirror the Customer master's Credit Terms
                      vocabulary so a value auto-filled from the customer always
                      has a matching option to render. */}
                  <option value="CASH">Cash</option>
                  <option value="NET_15">Net 15</option>
                  <option value="NET_30">Net 30</option>
                  <option value="NET_45">Net 45</option>
                  <option value="NET_60">Net 60</option>
                  <option value="CUSTOM">Custom Days</option>
                </CustomSelect></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Currency</label>
                <CustomSelect name="currency" value={formData.currency} onChange={handleChange} className={inputClass}>
                  <option value="INR">INR</option><option value="USD">USD</option>
                </CustomSelect></div>
            </div>
          </div>

          {/* Consignee (Ship To) — Select from Customer Master Addresses
              When the auto-extracted PO ship-to doesn't match any of
              the customer's master addresses, we don't bury that fact
              behind a tiny banner + dropdown. Instead we expose ALL
              of the customer's addresses as a card grid AND surface
              the extracted PO text as its own card. The user picks
              one explicitly — either an existing master address (the
              card autofills consignee fields) or the extracted PO
              text (kept as-is, with a hint to add it to the customer
              master before next time). When the PO ship-to DOES
              match a master address, we keep the slim dropdown UX
              since there's no decision to make. */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Consignee (Ship To) <span className="text-red-500">*</span></h3>
            {!formData.customer ? (
              <div className="p-4 bg-amber-50 rounded-lg border border-amber-200 text-sm text-amber-700">Select a Customer to see available shipping addresses.</div>
            ) : customerAddresses.length === 0 ? (
              <div className="p-4 bg-slate-50 rounded-lg border text-sm text-slate-500">No addresses found for this customer. Add addresses in Customer Master.</div>
            ) : (() => {
              // Mismatch = extractor found NO master address matching
              // the PO ship-to. `matchedIndex < 0` is the flag.
              const sh = extractMeta?.shipping || null;
              const poConsigneeText = extractMeta?.po_consignee_address || '';
              const showMismatchPicker = !!sh && sh.matchedIndex < 0 && !!poConsigneeText && customerAddresses.length > 0;

              if (!showMismatchPicker) {
                // Default path — slim dropdown when there's nothing
                // to decide.
                return (
                  <div className="mb-4">
                    <label className="block text-xs font-medium text-blue-700 mb-1">Shipping Address ({customerAddresses.length} available)</label>
                    <CustomSelect value={selectedShipIdx} onChange={(e) => {
                      const idx = parseInt(e.target.value);
                      setSelectedShipIdx(idx);
                      const addr = customerAddresses[idx];
                      if (addr) {
                        setFormData(prev => ({
                          ...prev,
                          consignee_address: addr.address,
                          destination: getDistrictState(addr.address),
                        }));
                      }
                    }} className={inputClass}>
                      {customerAddresses.map((addr, idx) => (
                        <option key={idx} value={idx}>{addr.label} — {formatAddressDisplay(addr.address) || 'No address'}</option>
                      ))}
                    </CustomSelect>
                  </div>
                );
              }

              // Mismatch path — card grid picker.
              // `selectedShipIdx === -1` is reserved for "use the PO
              // text as-is" (the rose card). 0..N-1 selects master
              // addresses (emerald cards).
              const isPoCardSelected = selectedShipIdx === -1;
              const pickPoText = () => {
                setSelectedShipIdx(-1);
                setFormData(prev => ({
                  ...prev,
                  consignee_address: poConsigneeText,
                  destination: getDistrictState(poConsigneeText),
                }));
              };
              const pickMasterAddr = (idx) => {
                setSelectedShipIdx(idx);
                const addr = customerAddresses[idx];
                if (addr) {
                  setFormData(prev => ({
                    ...prev,
                    consignee_address: addr.address,
                    destination: getDistrictState(addr.address),
                  }));
                }
              };

              return (
                <div className="mb-4 space-y-3">
                  <div className="p-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-xs flex items-start gap-2 flex-wrap">
                    <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                    <span className="flex-1 min-w-[200px]">
                      <strong>Address mismatch.</strong> The PO&apos;s ship-to address doesn&apos;t match any of this customer&apos;s {customerAddresses.length} master address{customerAddresses.length === 1 ? '' : 'es'}.
                      Pick the right one below, or add it to the customer master so it&apos;s available next time.
                    </span>
                    <button
                      type="button"
                      onClick={addPoShipToCustomerMaster}
                      disabled={isAddingShipAddr}
                      className="inline-flex items-center gap-1 px-3 py-1.5 bg-emerald-600 text-white rounded-md text-xs font-medium hover:bg-emerald-700 disabled:opacity-50 flex-shrink-0"
                    >
                      <Plus size={12} /> {isAddingShipAddr ? 'Adding…' : 'Add to Customer master'}
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {/* Card 0 — Extracted from PO */}
                    <button
                      type="button"
                      onClick={pickPoText}
                      className={`text-left rounded-lg border-2 p-3 transition focus:outline-none focus:ring-2 focus:ring-rose-300 ${
                        isPoCardSelected
                          ? 'border-rose-500 bg-rose-50 shadow-sm'
                          : 'border-rose-200 bg-white hover:bg-rose-50'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-[10px] font-semibold text-rose-700 uppercase tracking-wide">Extracted from PO</p>
                        {isPoCardSelected && <Check size={14} className="text-rose-700" />}
                      </div>
                      <p className="text-sm text-slate-800 break-words leading-snug whitespace-pre-line">{poConsigneeText}</p>
                      <p className="text-[10px] text-rose-600 mt-1.5 italic">Not in customer master — kept as printed text.</p>
                    </button>

                    {/* Cards 1..N — Customer master addresses */}
                    {customerAddresses.map((addr, idx) => {
                      const isSel = selectedShipIdx === idx;
                      return (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => pickMasterAddr(idx)}
                          className={`text-left rounded-lg border-2 p-3 transition focus:outline-none focus:ring-2 focus:ring-emerald-300 ${
                            isSel
                              ? 'border-emerald-500 bg-emerald-50 shadow-sm'
                              : 'border-emerald-200 bg-white hover:bg-emerald-50'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <p className="text-[10px] font-semibold text-emerald-700 uppercase tracking-wide truncate max-w-[80%]">{addr.label || `Address ${idx + 1}`}</p>
                            {isSel && <Check size={14} className="text-emerald-700" />}
                          </div>
                          <p className="text-sm text-slate-800 break-words leading-snug">{formatAddressDisplay(addr.address) || addr.address || 'No address'}</p>
                          {(addr.contact || addr.phone) && (
                            <p className="text-[10px] text-slate-500 mt-1.5">
                              {[addr.contact, addr.phone].filter(Boolean).join(' · ')}
                            </p>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
            {/* Editable fields */}
            <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
              <div className="space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-2 gap-3">
                  <div><label className="block text-xs font-medium text-slate-600 mb-1">Name</label>
                    <input type="text" name="consignee_name" value={formData.consignee_name} onChange={handleChange} className={inputClass} /></div>
                  <div><label className="block text-xs font-medium text-slate-600 mb-1">GST No</label>
                    <input type="text" name="consignee_gstin" value={formData.consignee_gstin} onChange={handleChange} className={inputClass} placeholder="GSTIN" /></div>
                </div>
                <AddressField label="Selected Address" value={formData.consignee_address} onChange={(v) => setFormData(prev => ({ ...prev, consignee_address: v, destination: getDistrictState(v) }))} />
              </div>
            </div>
          </div>

          {/* Billing Address — Auto-fill from Company */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Billing Address <span className="text-red-500">*</span></h3>
            <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
              <div className="space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-2 gap-3">
                  <div><label className="block text-xs font-medium text-slate-600 mb-1">Name</label>
                    <input type="text" name="billing_name" value={formData.billing_name} onChange={handleChange} className={inputClass} /></div>
                  <div><label className="block text-xs font-medium text-slate-600 mb-1">GST No</label>
                    <input type="text" name="billing_gstin" value={formData.billing_gstin} onChange={handleChange} className={inputClass} placeholder="GSTIN" /></div>
                </div>
                <AddressField label="Selected Address" value={formData.billing_address} onChange={(v) => setFormData(prev => ({ ...prev, billing_address: v }))} />
              </div>
            </div>
          </div>

          {/* Product Lines */}
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b">
              <h3 className="text-lg font-semibold text-slate-800">Product Lines <span className="text-red-500">*</span></h3>
              <button type="button" onClick={addLine} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100"><Plus size={16} /> Add Product</button>
            </div>
            {formData.price_list && priceLines.length > 0 && (
              <div className="mb-3 p-3 bg-blue-50 rounded-lg text-sm text-blue-800">
                Price list loaded with {priceLines.length} product(s). Only customer products are shown. Selecting a product will auto-fill price, discount & GST.
              </div>
            )}
            {/* PO-vs-PL confirmation banner. When the PO was missing
                rate / discount / GST on one or more lines, we don't
                silently fall back to the price list — the user has to
                opt in. Two actions: "Autofill from Price List" (pulls
                the missing values from PL) or "Leave Empty" (commits
                to blank and stops the auto-resolver from refilling). */}
            {poLines.some(l => l._pl_pending) && (() => {
              const pending = poLines.filter(l => l._pl_pending);
              const pendingCount = pending.length;
              const FIELD_LABELS = {
                price: 'rate',
                discount: 'discount',
                gst: 'GST %',
                sgst_percent: 'SGST',
                cgst_percent: 'CGST',
                igst_percent: 'IGST',
              };
              const missingFields = new Set();
              pending.forEach(l => Object.keys(l._pl_pending || {}).forEach(k => missingFields.add(k)));
              // Collapse the GST flavours into one bucket for the human-
              // readable label — "rate, discount, GST" reads better than
              // "rate, discount, GST %, SGST, CGST".
              const friendly = [];
              if (missingFields.has('price')) friendly.push('rate');
              if (missingFields.has('discount')) friendly.push('discount');
              const anyGst = ['gst', 'sgst_percent', 'cgst_percent', 'igst_percent']
                .some(k => missingFields.has(k));
              if (anyGst) friendly.push('GST');
              const missingLabel = friendly.join(' / ') || Array.from(missingFields).map(k => FIELD_LABELS[k] || k).join(' / ');
              return (
                <div className="mb-3 p-3 bg-amber-50 border border-amber-300 rounded-lg flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-start gap-2 text-sm text-amber-900 flex-1 min-w-[260px]">
                    <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="font-semibold mb-0.5">
                        PO didn&apos;t print {missingLabel} for {pendingCount} line(s) — the price list does.
                      </p>
                      <p className="text-xs text-amber-700">
                        <strong>Autofill from Price List</strong> pulls each missing value from the customer&apos;s price list.{' '}
                        <strong>Leave Empty</strong> commits the row(s) to blank — you can still type them in manually.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      type="button"
                      onClick={dismissPlAutofillForPendingLines}
                      className="px-4 py-2 bg-white text-amber-800 text-sm font-semibold rounded-lg border border-amber-300 hover:bg-amber-100"
                    >
                      Leave Empty
                    </button>
                    <button
                      type="button"
                      onClick={applyPlAutofillToPendingLines}
                      className="px-4 py-2 bg-amber-600 text-white text-sm font-semibold rounded-lg hover:bg-amber-700"
                    >
                      Autofill from Price List
                    </button>
                  </div>
                </div>
              );
            })()}
            {/* Persistent price-list-coverage banner. Merges two
                sources so nothing the user needs to know about gets
                lost:
                  - `extractedExcludedProducts`: products the extractor
                    matched to master but that were filtered out of the
                    table because they're not in the selected price
                    list (no row exists for them, so we can't compute
                    this from `poLines`).
                  - poLines rows whose `parsed_sku` isn't in the active
                    price list — covers the case where the user
                    manually picks a product, then switches lists.
                Shows green when both sources are empty. */}
            {formData.price_list && priceLines.length > 0 && (poLines.some(l => l.parsed_sku) || extractedExcludedProducts.length > 0) && (() => {
              const priceListIds = new Set(priceLines.map(pl => String(pl.product)));
              const rowMissing = poLines
                .filter(l => l.parsed_sku && !priceListIds.has(String(l.parsed_sku)))
                .map(l => ({
                  description: l.product_description || l.matched_product_name || '(unnamed)',
                  sku: l.matched_product_sku || '',
                  qty: l.quantity,
                  po_rate: l.po_rate || l.price,
                }));
              const extractMissing = extractedExcludedProducts.map(p => ({
                description: p.product_name,
                sku: p.product_sku,
                qty: p.quantity,
                po_rate: p.po_rate,
              }));
              // Dedupe by sku|description across both sources.
              const seen = new Set();
              const missingLines = [...extractMissing, ...rowMissing].filter(m => {
                const key = `${m.sku}|${m.description}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              });
              if (missingLines.length === 0) {
                const matchedLineCount = poLines.filter(l => l.parsed_sku && priceListIds.has(String(l.parsed_sku))).length;
                return (
                  <div className="mb-3 p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-700 flex items-start gap-2">
                    <Check size={14} className="mt-0.5 flex-shrink-0" />
                    <span>
                      <strong>All {matchedLineCount} matched product(s) exist in the selected price list.</strong>{' '}
                      Rates auto-filled.
                    </span>
                  </div>
                );
              }
              return (
                <div className="mb-3 p-2.5 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="font-semibold mb-1">
                        {missingLines.length} product(s) on this PO are NOT in the selected price list and were not added to the table:
                      </p>
                      <ul className="list-disc list-inside space-y-0.5">
                        {missingLines.map((m, i) => {
                          const qtyTxt = (m.qty !== undefined && m.qty !== null && String(m.qty).trim() !== '') ? `Qty: ${m.qty}` : '';
                          const rateTxt = (m.po_rate !== undefined && m.po_rate !== null && String(m.po_rate).trim() !== '') ? `PO Rate: ₹${m.po_rate}` : '';
                          const meta = [qtyTxt, rateTxt].filter(Boolean).join(' · ');
                          return (
                            <li key={i}>
                              <strong>{m.description}</strong>{m.sku ? ` (${m.sku})` : ''}
                              {meta ? <span className="text-red-500"> — {meta}</span> : ''}
                            </li>
                          );
                        })}
                      </ul>
                      <p className="mt-1.5 text-red-600">
                        Either add these products to the price list (Pricing → Price Lists → {filteredPriceLists.find(p => p.value === formData.price_list)?.label || 'selected list'}), pick a different price list above, or add a row manually for each.
                      </p>
                    </div>
                  </div>
                </div>
              );
            })()}
            {/* Mobile-only stacked editor. Identical state + handlers
                to the table below; just rendered as one card per line
                so every field is reachable without horizontal scroll.
                Desktop / tablet (sm+) keeps the original 14-column
                table. */}
            <div className="sm:hidden space-y-3">
              {poLines.map((line, idx) => {
                const amt = (parseFloat(line.quantity) || 0) * (parseFloat(line.price) || 0);
                const netAmt = calcLineTotal(line);
                // Same fallback-label logic as the desktop table —
                // synthesises a master-only option when the
                // auto-extractor's `parsed_sku` isn't in the filtered
                // product list yet.
                const filtered = getFilteredProducts(line.product_category);
                const hasMatchOption = !line.parsed_sku
                  || filtered.some(o => String(o.value) === String(line.parsed_sku));
                let fallbackLabel = '';
                if (line.matched_product_name && line.matched_product_sku) {
                  fallbackLabel = `${line.matched_product_name} (${line.matched_product_sku})`;
                } else if (line.matched_product_name) {
                  fallbackLabel = line.matched_product_name;
                } else if (line.matched_product_sku) {
                  fallbackLabel = line.matched_product_sku;
                }
                const showFallback = !hasMatchOption && !!fallbackLabel;

                // PO Rate vs Rate mismatch tint — same logic as the
                // desktop column.
                const poR = parseFloat(line.po_rate);
                const plR = parseFloat(line.price);
                const rateDiffers = !isNaN(poR) && !isNaN(plR) && Math.abs(poR - plR) > 0.005;

                return (
                  <div key={idx} className="border border-slate-200 rounded-lg p-3 space-y-2 bg-white">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Line #{idx + 1}</span>
                      <button
                        type="button"
                        onClick={() => removeLine(idx)}
                        disabled={poLines.length <= 1}
                        className="inline-flex items-center gap-1 text-red-500 disabled:opacity-30 text-xs"
                      >
                        <Trash2 size={14} /> Remove
                      </button>
                    </div>

                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Category</label>
                      <CustomSelect value={line.product_category || ''} onChange={(e) => handleLineChange(idx, 'product_category', e.target.value)} className={`${inputClass} w-full`}>
                        {categoryOptionsForLine.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </CustomSelect>
                    </div>

                    <div>
                      <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Product <span className="text-red-500">*</span></label>
                      <CustomSelect
                        value={line.parsed_sku}
                        onChange={(e) => handleLineChange(idx, 'parsed_sku', e.target.value)}
                        disabled={!line.product_category}
                        className={`${inputClass} disabled:bg-slate-100 w-full`}
                      >
                        <option value="">{line.product_category ? 'Select' : 'Category first'}</option>
                        {showFallback && (
                          <option value={line.parsed_sku}>{fallbackLabel}</option>
                        )}
                        {filtered.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </CustomSelect>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">HSN</label>
                        <input type="text" value={line.hsn_code} onChange={(e) => handleLineChange(idx, 'hsn_code', e.target.value)} className={`${inputClass} w-full`} placeholder="HSN" />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">UOM</label>
                        <CustomSelect value={line.uom} onChange={(e) => handleLineChange(idx, 'uom', e.target.value)} className={`${inputClass} w-full`}>
                          {SALES_UOM_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.value}</option>)}
                        </CustomSelect>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Qty <span className="text-red-500">*</span></label>
                        <input type="number" step="0.001" min="0.001" value={line.quantity} onChange={(e) => handleLineChange(idx, 'quantity', e.target.value)} className={`${inputClass} w-full text-right`} />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5" title="Rate printed on the buyer's PO document">PO Rate</label>
                        <input
                          type="number" step="0.01" min="0"
                          value={line.po_rate || ''}
                          onChange={(e) => handleLineChange(idx, 'po_rate', e.target.value)}
                          className={`${inputClass} w-full text-right ${rateDiffers ? 'border-amber-400 ring-1 ring-amber-200 bg-amber-50' : ''}`}
                          placeholder="—"
                          title={rateDiffers ? `Buyer wrote ₹${poR.toFixed(2)} but price list says ₹${plR.toFixed(2)}` : 'Rate printed on the PO'}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5" title="Authoritative rate from the customer's price list">Rate</label>
                        <input type="number" step="0.01" min="0" value={line.price} onChange={(e) => handleLineChange(idx, 'price', e.target.value)} className={`${inputClass} w-full text-right`} placeholder="0.00" />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Amount</label>
                        <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded text-right text-sm text-slate-600">
                          {amt > 0 ? fmt(amt) : '-'}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Discount</label>
                        <input type="number" step="0.01" min="0" value={line.discount} onChange={(e) => handleLineChange(idx, 'discount', e.target.value)} className={`${inputClass} w-full text-right`} />
                      </div>
                      <div className="flex flex-col justify-end">
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Net Amount</label>
                        <div className="px-3 py-2 bg-slate-100 border border-slate-300 rounded text-right text-sm font-bold text-slate-900">
                          {netAmt > 0 ? fmt(netAmt) : '-'}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">SGST %</label>
                        <input
                          type="number" step="0.01" min="0" value={line.sgst_percent}
                          onChange={(e) => {
                            const val = e.target.value;
                            setPoLines(prev => prev.map((l, i) => i !== idx ? l : { ...l, sgst_percent: val, gst: String((parseFloat(val) || 0) + (parseFloat(l.cgst_percent) || 0)) }));
                          }}
                          className={`${inputClass} w-full text-right`}
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">CGST %</label>
                        <input
                          type="number" step="0.01" min="0" value={line.cgst_percent}
                          onChange={(e) => {
                            const val = e.target.value;
                            setPoLines(prev => prev.map((l, i) => i !== idx ? l : { ...l, cgst_percent: val, gst: String((parseFloat(l.sgst_percent) || 0) + (parseFloat(val) || 0)) }));
                          }}
                          className={`${inputClass} w-full text-right`}
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">IGST %</label>
                        <input type="number" step="0.01" min="0" value={line.igst_percent} onChange={(e) => handleLineChange(idx, 'igst_percent', e.target.value)} className={`${inputClass} w-full text-right`} />
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Mobile totals card — same numbers as the table's tfoot,
                  stacked vertically so each figure has enough room. */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-slate-500">Total Qty</span><span className="font-medium text-slate-800">{fmtQty(totalQty)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Total Amount</span><span className="font-medium text-slate-800">{fmt(totalAmount)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Total Discount</span><span className="font-medium text-red-600">{fmt(totalDiscount)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Total SGST</span><span className="font-medium text-slate-700">{fmt(totalSGST)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Total CGST</span><span className="font-medium text-slate-700">{fmt(totalCGST)}</span></div>
                <div className="flex justify-between pt-2 mt-1 border-t border-slate-300">
                  <span className="text-slate-700 font-semibold">Grand Total</span>
                  <span className="text-base font-bold text-slate-900">{fmt(grandTotal)}</span>
                </div>
              </div>
            </div>

            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                  <th className="text-left px-2 py-2 font-medium text-slate-600">#</th>
                  <th className="text-left px-2 py-2 font-medium text-slate-600">Category</th>
                  <th className="text-left px-2 py-2 font-medium text-slate-600">Product <span className="text-red-500">*</span></th>
                  <th className="text-left px-2 py-2 font-medium text-slate-600">HSN</th>
                  <th className="text-left px-2 py-2 font-medium text-slate-600">UOM</th>
                  <th className="text-right px-2 py-2 font-medium text-slate-600">Qty <span className="text-red-500">*</span></th>
                  <th className="text-right px-2 py-2 font-medium text-slate-600" title="Rate printed on the buyer's PO document">PO Rate</th>
                  <th className="text-right px-2 py-2 font-medium text-slate-600" title="Authoritative rate from the customer's price list">Rate</th>
                  <th className="text-right px-2 py-2 font-medium text-slate-600">Amount</th>
                  <th className="text-right px-2 py-2 font-medium text-slate-600">Disc.</th>
                  <th className="text-right px-2 py-2 font-medium text-slate-600">SGST %</th>
                  <th className="text-right px-2 py-2 font-medium text-slate-600">CGST %</th>
                  <th className="text-right px-2 py-2 font-medium text-slate-600">IGST %</th>
                  <th className="text-right px-2 py-2 font-medium text-slate-600">Net Amt</th>
                  <th className="px-2 py-2"></th>
                </tr></thead>
                <tbody>{poLines.map((line, idx) => {
                  const amt = (parseFloat(line.quantity) || 0) * (parseFloat(line.price) || 0);
                  const netAmt = calcLineTotal(line);
                  return (
                    <tr key={idx} className="border-b">
                      <td className="px-2 py-2 text-slate-500">{idx + 1}</td>
                      <td className="px-2 py-2"><CustomSelect value={line.product_category || ''} onChange={(e) => handleLineChange(idx, 'product_category', e.target.value)} className={inputClass} style={{ minWidth: '110px' }}>
                        {categoryOptionsForLine.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</CustomSelect></td>
                      <td className="px-2 py-2">{(() => {
                        // Fallback: when the auto-extractor has set
                        // parsed_sku to a matched product UUID but
                        // rawProducts hasn't loaded that product yet
                        // (paginated /api/products/ fetch, or the
                        // price-list filter excluded it), the option
                        // list won't contain the value and the select
                        // would silently fall back to "Select".
                        // Inject a synthetic option so the matched
                        // product master entry is always visible.
                        //
                        // IMPORTANT: the label must come from the
                        // PRODUCT MASTER (matched_product_name / sku),
                        // NEVER from the PO's extracted text. The PO's
                        // shorthand description ("NIMBECIDINE 1500")
                        // is not a product master name; if we showed
                        // it as a product name the user would think
                        // the master was being bypassed.
                        const filtered = getFilteredProducts(line.product_category);
                        const hasMatchOption = !line.parsed_sku
                          || filtered.some(o => String(o.value) === String(line.parsed_sku));
                        // Master-only label: name (sku in parens when
                        // both exist, so it's visibly different from
                        // free-text description).
                        let fallbackLabel = '';
                        if (line.matched_product_name && line.matched_product_sku) {
                          fallbackLabel = `${line.matched_product_name} (${line.matched_product_sku})`;
                        } else if (line.matched_product_name) {
                          fallbackLabel = line.matched_product_name;
                        } else if (line.matched_product_sku) {
                          fallbackLabel = line.matched_product_sku;
                        }
                        const showFallback = !hasMatchOption && !!fallbackLabel;
                        return (
                          <CustomSelect
                            value={line.parsed_sku}
                            onChange={(e) => handleLineChange(idx, 'parsed_sku', e.target.value)}
                            disabled={!line.product_category}
                            className={`${inputClass} disabled:bg-slate-100`}
                            style={{ minWidth: '140px' }}
                          >
                            <option value="">{line.product_category ? 'Select' : 'Category first'}</option>
                            {showFallback && (
                              <option value={line.parsed_sku}>{fallbackLabel}</option>
                            )}
                            {filtered.map(o => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </CustomSelect>
                        );
                      })()}</td>
                      <td className="px-2 py-2"><input type="text" value={line.hsn_code} onChange={(e) => handleLineChange(idx, 'hsn_code', e.target.value)} className={inputClass} style={{ minWidth: '80px' }} placeholder="HSN" /></td>
                      <td className="px-2 py-2"><CustomSelect value={line.uom} onChange={(e) => handleLineChange(idx, 'uom', e.target.value)} className={inputClass} style={{ minWidth: '65px' }}>
                        {SALES_UOM_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.value}</option>)}
                      </CustomSelect></td>
                      <td className="px-2 py-2"><input type="number" step="0.001" min="0.001" value={line.quantity} onChange={(e) => handleLineChange(idx, 'quantity', e.target.value)} className={inputClass} style={{ minWidth: '70px' }} /></td>
                      {/* PO Rate — what the buyer printed on the PO. Editable
                          but does NOT flow into Amount / Net Amt. Tinted amber
                          when it differs from the price-list `Rate` so the
                          user can spot mismatches at a glance. */}
                      <td className="px-2 py-2">
                        {(() => {
                          const poR = parseFloat(line.po_rate);
                          const plR = parseFloat(line.price);
                          const differ = !isNaN(poR) && !isNaN(plR) && Math.abs(poR - plR) > 0.005;
                          return (
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={line.po_rate || ''}
                              onChange={(e) => handleLineChange(idx, 'po_rate', e.target.value)}
                              className={`${inputClass} ${differ ? 'border-amber-400 ring-1 ring-amber-200 bg-amber-50' : ''}`}
                              style={{ minWidth: '80px' }}
                              placeholder="—"
                              title={differ ? `Buyer wrote ₹${poR.toFixed(2)} but price list says ₹${plR.toFixed(2)}` : 'Rate printed on the PO'}
                            />
                          );
                        })()}
                      </td>
                      <td className="px-2 py-2"><input type="number" step="0.01" min="0" value={line.price} onChange={(e) => handleLineChange(idx, 'price', e.target.value)} className={inputClass} style={{ minWidth: '80px' }} placeholder="0.00" /></td>
                      <td className="px-2 py-2 text-right font-medium whitespace-nowrap text-slate-600">{amt > 0 ? fmt(amt) : '-'}</td>
                      <td className="px-2 py-2"><input type="number" step="0.01" min="0" value={line.discount} onChange={(e) => handleLineChange(idx, 'discount', e.target.value)} className={inputClass} style={{ minWidth: '60px' }} /></td>
                      <td className="px-2 py-2"><input type="number" step="0.01" min="0" value={line.sgst_percent}
                        onChange={(e) => {
                          const val = e.target.value;
                          setPoLines(prev => prev.map((l, i) => i !== idx ? l : { ...l, sgst_percent: val, gst: String((parseFloat(val) || 0) + (parseFloat(l.cgst_percent) || 0)) }));
                        }} className={inputClass} style={{ minWidth: '55px' }} /></td>
                      <td className="px-2 py-2"><input type="number" step="0.01" min="0" value={line.cgst_percent}
                        onChange={(e) => {
                          const val = e.target.value;
                          setPoLines(prev => prev.map((l, i) => i !== idx ? l : { ...l, cgst_percent: val, gst: String((parseFloat(l.sgst_percent) || 0) + (parseFloat(val) || 0)) }));
                        }} className={inputClass} style={{ minWidth: '55px' }} /></td>
                      <td className="px-2 py-2"><input type="number" step="0.01" min="0" value={line.igst_percent} onChange={(e) => handleLineChange(idx, 'igst_percent', e.target.value)} className={inputClass} style={{ minWidth: '55px' }} /></td>
                      <td className="px-2 py-2 text-right font-semibold whitespace-nowrap">{netAmt > 0 ? fmt(netAmt) : '-'}</td>
                      <td className="px-2 py-2"><button type="button" onClick={() => removeLine(idx)} disabled={poLines.length <= 1} className="text-red-500 disabled:opacity-30"><Trash2 size={16} /></button></td>
                    </tr>
                  );
                })}</tbody>
                <tfoot>
                  <tr className="bg-slate-50 font-semibold border-t-2 border-slate-300">
                    <td colSpan="5" className="px-2 py-2 text-right text-slate-600">Totals:</td>
                    <td className="px-2 py-2 text-right">{fmtQty(totalQty)}</td>
                    <td></td>
                    <td className="px-2 py-2 text-right">{fmt(totalAmount)}</td>
                    <td className="px-2 py-2 text-right text-red-600">{fmt(totalDiscount)}</td>
                    <td className="px-2 py-2 text-right text-xs">{fmt(totalSGST)}</td>
                    <td className="px-2 py-2 text-right text-xs">{fmt(totalCGST)}</td>
                    <td></td>
                    <td className="px-2 py-2 text-right text-base">{fmt(grandTotal)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Special Instructions & Remarks */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Additional Information</h3>
            <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Special Instructions</label>
                <textarea name="special_instructions" value={formData.special_instructions} onChange={handleChange} rows={3} className={fieldClass('special_instructions')} placeholder="e.g. GOODS WILL BE ACCEPTED ONLY AFTER SATISFACTORY COMPLETION OF QUALITY PARAMETERS" /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Remarks</label>
                <textarea name="remarks" value={formData.remarks} onChange={handleChange} rows={3} className={fieldClass('remarks')} /></div>
            </div>
          </div>

          <FileAttachments
            module="CUSTOMER_PO"
            recordId={null}
            onPendingChange={setPendingAttachments}
            presetPendingFiles={extractedPoFile ? [extractedPoFile] : []}
          />

          {/* Mobile-friendly action row — stack full-width with
              the primary action on top, side-by-side on sm+. */}
          <div className="flex flex-row justify-end gap-2 pt-4 border-t">
            <button type="button" onClick={() => navigate('/sales/customer-po')} className="w-full sm:w-auto px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="w-full sm:w-auto px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Creating...' : 'Create Customer PO'}</button>
          </div>
        </form>
      </div>
      )}

      {/* Unified extraction-review modal. ONE popup that lists every
          thing the user needs to confirm after a PO upload — fuzzy
          customer / company matches AND header fields the PO didn't
          print but the price list defaults — into a single review
          table. Each row has its own ✓ / ✗ buttons that mark a per-row
          decision. The "Done" button closes the modal once the user
          has reviewed everything; pending rows are left as-is (fuzzy
          matches stay auto-applied, missing fields stay blank). */}
      {confirmReview.length > 0 && (() => {
        const undecidedCount = confirmReview.filter(it => !it.decision).length;
        const setDecision = (id, decision) => {
          setConfirmReview(prev => prev.map(it => {
            if (it.id !== id) return it;
            // Fire the side-effect ONCE per row when the decision
            // changes. We allow flipping a decision (user clicks the
            // other button), but each click runs the relevant
            // callback again — both onAccept/onReject are designed
            // to be idempotent so this is safe.
            if (decision === 'accepted') it.onAccept?.();
            else if (decision === 'rejected') it.onReject?.();
            return { ...it, decision };
          }));
        };
        return (
          <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-2 sm:p-4">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[95dvh] sm:max-h-[85dvh] flex flex-col" role="dialog" aria-modal="true" aria-label="Review extraction matches">
              <div className="flex items-start justify-between px-4 sm:px-5 py-3 border-b border-slate-200">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-sky-100 text-sky-700 text-xs font-semibold">?</span>
                  <div>
                    <h3 className="text-base font-semibold text-slate-800">Review extraction matches</h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {confirmReview.length} item{confirmReview.length === 1 ? '' : 's'} to review — pick whether to use the suggested value or keep what the PO printed.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setConfirmReview([])}
                  className="p-1 text-slate-400 hover:text-slate-700"
                  aria-label="Close"
                  title="Close — pending rows keep their default (auto-applied matches stay; blank fields stay blank)"
                >
                  ×
                </button>
              </div>

              <div className="overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b border-slate-200 sticky top-0 z-10">
                    <tr className="text-left text-[11px] uppercase tracking-wide text-slate-600">
                      <th className="px-3 sm:px-4 py-2 font-semibold whitespace-nowrap">Field</th>
                      <th className="px-3 sm:px-4 py-2 font-semibold">Extracted (PO)</th>
                      <th className="px-3 sm:px-4 py-2 font-semibold">Suggested (Master / PL)</th>
                      <th className="px-3 sm:px-4 py-2 font-semibold whitespace-nowrap text-center">Similarity</th>
                      <th className="px-3 sm:px-4 py-2 font-semibold whitespace-nowrap text-center">Decision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {confirmReview.map((it) => {
                      const pct = it.similarity != null ? Math.round(it.similarity * 100) : null;
                      // Show the "default" pill when the user hasn't
                      // touched this row yet — clarifies what'll happen
                      // if they close the modal.
                      const defaultLabel = it.defaultDecision === 'accepted'
                        ? 'Auto-applied'
                        : 'Blank';
                      return (
                        <tr key={it.id} className="border-b last:border-b-0 align-top">
                          <td className="px-3 sm:px-4 py-3 whitespace-nowrap">
                            <p className="font-medium text-slate-800">{it.label}</p>
                            <p className="text-[10px] text-slate-400 uppercase tracking-wide">
                              {it.group === 'match' ? 'Fuzzy match' : 'Missing on PO'}
                            </p>
                          </td>
                          <td className="px-3 sm:px-4 py-3">
                            <div className="rounded-md border border-rose-200 bg-rose-50/70 px-2 py-1.5">
                              <p className="text-[10px] font-semibold text-rose-700 uppercase tracking-wide">{it.extractedLabel}</p>
                              <p className="text-sm font-medium text-slate-800 break-words">{it.extractedValue || '—'}</p>
                              {it.extractedMeta && <p className="text-[10px] text-slate-500 mt-0.5 break-words">{it.extractedMeta}</p>}
                            </div>
                          </td>
                          <td className="px-3 sm:px-4 py-3">
                            <div className="rounded-md border border-emerald-200 bg-emerald-50/70 px-2 py-1.5">
                              <p className="text-[10px] font-semibold text-emerald-700 uppercase tracking-wide">{it.suggestedLabel}</p>
                              <p className="text-sm font-medium text-slate-800 break-words">{it.suggestedValue || '—'}</p>
                              {it.suggestedMeta && <p className="text-[10px] text-slate-500 mt-0.5 break-words">{it.suggestedMeta}</p>}
                            </div>
                          </td>
                          <td className="px-3 sm:px-4 py-3 text-center">
                            {pct != null ? (
                              <span className="inline-block px-2 py-0.5 rounded text-[11px] font-semibold text-rose-700 bg-rose-50 border border-rose-200 whitespace-nowrap">{pct}%</span>
                            ) : (
                              <span className="text-[11px] text-slate-400">—</span>
                            )}
                          </td>
                          <td className="px-3 sm:px-4 py-3">
                            <div className="flex flex-col items-center gap-1.5">
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => setDecision(it.id, 'accepted')}
                                  className={`px-2.5 py-1 rounded text-xs font-medium inline-flex items-center gap-1 transition ${
                                    it.decision === 'accepted'
                                      ? 'bg-emerald-600 text-white'
                                      : 'border border-emerald-300 text-emerald-700 hover:bg-emerald-50'
                                  }`}
                                  title="Use the suggested value"
                                >
                                  ✓ Use suggested
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDecision(it.id, 'rejected')}
                                  className={`px-2.5 py-1 rounded text-xs font-medium inline-flex items-center gap-1 transition ${
                                    it.decision === 'rejected'
                                      ? 'bg-slate-700 text-white'
                                      : 'border border-slate-300 text-slate-700 hover:bg-slate-50'
                                  }`}
                                  title="Keep what the PO printed (or leave blank)"
                                >
                                  ✗ Keep as is
                                </button>
                              </div>
                              {!it.decision && (
                                <span className="text-[10px] text-slate-400 italic">defaults to: {defaultLabel}</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="px-4 sm:px-5 py-3 border-t border-slate-200 bg-slate-50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-b-xl">
                <p className="text-xs text-slate-500">
                  {undecidedCount > 0
                    ? `${undecidedCount} row${undecidedCount === 1 ? '' : 's'} still using the default — close anyway to keep the defaults.`
                    : 'All rows decided. You can close this dialog.'}
                </p>
                <button
                  type="button"
                  onClick={() => setConfirmReview([])}
                  className="px-4 py-1.5 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </MainLayout>
  );
}
