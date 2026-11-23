import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import useAllProducts from '../components/useAllProducts.js';
import FileAttachments, { uploadPendingFiles } from '../components/FileAttachments';
import ScanCaptureButton from '@/components/common/ScanCaptureButton';
import PreviousRates from '../components/PreviousRates';
import ProductMismatchModal from './ProductMismatchModal';
import VendorMatchConfirmModal from './VendorMatchConfirmModal';
import { UOM_OPTIONS, UOM_VALUES } from '../../../constants/uom.js';
import { formatCurrency } from '@/utils/formatters';

/* ------------------------------------------------------------------ */
/*  Fuzzy match — Dice coefficient on character bigrams               */
/* ------------------------------------------------------------------ */
function bigrams(s) {
  const out = new Map();
  const t = (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (let i = 0; i < t.length - 1; i++) {
    const bg = t.substr(i, 2);
    out.set(bg, (out.get(bg) || 0) + 1);
  }
  return out;
}
function diceSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a.toLowerCase().trim() === b.toLowerCase().trim()) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let common = 0, total = 0;
  A.forEach((cnt, bg) => { total += cnt; if (B.has(bg)) common += Math.min(cnt, B.get(bg)); });
  B.forEach((cnt) => { total += cnt; });
  return total === 0 ? 0 : (2 * common) / total;
}
const FUZZY_THRESHOLD = 0.80;

// ── OCR debug logger ────────────────────────────────────────────────
// Logs are gated on a runtime flag so production builds can be debugged
// without a redeploy. To turn on in a deployed app, open DevTools →
// Console and run:
//     localStorage.setItem('debug_ocr', '1')
// Then re-trigger the extraction. To disable:
//     localStorage.removeItem('debug_ocr')
// `import.meta.env.DEV` is true on `npm run dev` so local development
// logs unconditionally — no need to set the flag manually.
function ocrLog(...args) {
  try {
    if (import.meta.env.DEV || localStorage.getItem('debug_ocr') === '1') {
      // eslint-disable-next-line no-console
      console.log('[QuoteExtract]', ...args);
    }
  } catch (_) { /* localStorage blocked in private mode — silently skip */ }
}

// ── Defensive label scanners ────────────────────────────────────────
// The backend extractor canonicalises ~30 quote-date aliases and ~25
// rate aliases into `data.quote_date` / `it.rate`. If the deployed
// backend is older than the frontend (or the Gemini model emits a
// label we haven't catalogued yet), `data.quote_date` arrives empty
// even though a date IS in the raw response.
//
// These scanners walk every key of the response object looking for
// the labels listed in the spec. They run AFTER the normal backend
// mapping — so when the backend works correctly there's zero behavior
// change; when it doesn't, they salvage the value.

// Lowercased, separator-stripped label list with priority (lower = better).
const QUOTE_DATE_FALLBACK_KEYS = [
  ['vendorquotedate', 1], ['quotationsubmissiondate', 2], ['rfqresponsedate', 3],
  ['offerdate', 4], ['proposaldate', 5], ['priceofferdate', 6], ['biddate', 7],
  ['submissiondate', 8], ['commercialofferdate', 9],
  ['quotationdate', 10], ['quotedate', 10], ['documentdate', 10],
  ['issuedon', 10], ['dated', 10], ['date', 10],
];
const LINE_RATE_FALLBACK_KEYS = [
  ['quotedrate', 1], ['offerprice', 2], ['purchaserate', 3], ['unitprice', 4],
  ['priceperunit', 5], ['perunitrate', 6], ['itemrate', 7], ['productrate', 8],
  ['materialrate', 9], ['basicrate', 10], ['commercialrate', 11], ['bidprice', 12],
  ['unitcost', 13], ['costperunit', 14], ['unitvalue', 15], ['itemprice', 16],
  ['costprice', 17], ['unitamount', 18], ['sellingprice', 19], ['rate', 20],
  ['price', 21],
];

function _normaliseKey(k) {
  // Lowercase, strip everything that isn't a letter or digit. So
  // "Vendor Quote Date", "vendor_quote_date" and "Vendor-Quote-Date"
  // all collapse to "vendorquotedate".
  return String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function _scanForDate(obj) {
  if (!obj || typeof obj !== 'object') return { value: '', sourceKey: null };
  // Build a map: normalised-key → raw value.
  const map = {};
  for (const k of Object.keys(obj)) map[_normaliseKey(k)] = obj[k];
  for (const [norm] of QUOTE_DATE_FALLBACK_KEYS) {
    const v = map[norm];
    if (v != null && String(v).trim() !== '') {
      return { value: String(v).trim(), sourceKey: norm };
    }
  }
  return { value: '', sourceKey: null };
}

function _coerceDateFE(raw) {
  // Mirror the backend's date coercion for the rescue path. Handles
  // the four formats listed in the spec (YYYY-MM-DD, DD/MM/YYYY,
  // DD-MM-YYYY, DD.MM.YYYY) plus 2-digit-year variants.
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Day-first separator-flexible: D[/-.]M[/-.]Y(YYY?)
  const m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = (Number(y) <= 68 ? '20' : '19') + y;
    const dd = String(d).padStart(2, '0');
    const mm = String(mo).padStart(2, '0');
    const dt = new Date(`${y}-${mm}-${dd}T00:00:00`);
    if (!Number.isNaN(dt.getTime()) && dt.getMonth() + 1 === Number(mm)) {
      return `${y}-${mm}-${dd}`;
    }
  }
  return '';
}

function _scanForRate(item) {
  if (!item || typeof item !== 'object') return { value: null, sourceKey: null };
  const map = {};
  for (const k of Object.keys(item)) map[_normaliseKey(k)] = item[k];
  for (const [norm] of LINE_RATE_FALLBACK_KEYS) {
    const v = map[norm];
    if (v == null) continue;
    // Strip ₹, commas, INR, spaces. Same as backend _coerce_number.
    const cleaned = String(v).replace(/[^\d.\-]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '.') continue;
    const num = parseFloat(cleaned);
    if (!Number.isNaN(num) && num > 0) {
      return { value: num, sourceKey: norm };
    }
  }
  return { value: null, sourceKey: null };
}

// The RFQ /products/ endpoint namespaces non-Goods IDs as
// "MACHINERY:<uuid>" / "SERVICE:<uuid>" so they don't collide with raw
// Product UUIDs client-side. This helper decodes the namespace into
// (item_type, id) so the Quote line save path can route to the right
// FK on POLine / QuoteLine. Goods rows pass through unchanged.
function decodeRfqProductId(raw) {
  const s = (raw == null ? '' : String(raw));
  if (!s) return { item_type: 'PRODUCT', id: '' };
  const i = s.indexOf(':');
  if (i < 0) return { item_type: 'PRODUCT', id: s };
  const prefix = s.slice(0, i).toUpperCase();
  if (prefix === 'MACHINERY' || prefix === 'SERVICE') {
    return { item_type: prefix, id: s.slice(i + 1) };
  }
  return { item_type: 'PRODUCT', id: s };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const ACCEPTED_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

const ACCEPTED_EXTENSIONS = '.pdf,.jpg,.jpeg,.png,.docx,.xlsx';

// True when the row carries a prefilled PR-requested qty (`_requested_qty`,
// UI-only — never sent to the API) and the operator's current quantity
// differs from it numerically. A cleared quantity field also counts.
function qtyDiffersFromRequested(item) {
  const req = parseFloat(item?._requested_qty);
  if (!Number.isFinite(req)) return false;
  const q = parseFloat(item?.quantity);
  return !Number.isFinite(q) || q !== req;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = { pdf: 'PDF', jpg: 'JPG', jpeg: 'JPG', png: 'PNG', docx: 'DOC', xlsx: 'XLS' };
  return icons[ext] || 'FILE';
}

/** Overall confidence badge colors (kept for backward compat) */
function confidenceColor(pct) {
  if (pct >= 80) return 'text-emerald-600 bg-emerald-50 border-emerald-200';
  if (pct >= 60) return 'text-amber-600 bg-amber-50 border-amber-200';
  return 'text-red-600 bg-red-50 border-red-200';
}

function confidenceDot(pct) {
  if (pct >= 80) return 'bg-emerald-500';
  if (pct >= 60) return 'bg-amber-500';
  return 'bg-red-500';
}

/** Per-field confidence helpers using new thresholds: green >=80, yellow 60-79, red <60 */
function fieldConfidenceBg(pct) {
  if (pct >= 80) return 'text-emerald-700 bg-emerald-50';
  if (pct >= 60) return 'text-amber-700 bg-amber-50';
  return 'text-red-700 bg-red-50';
}

function fieldConfidenceIcon(pct) {
  if (pct >= 80) return { symbol: '\u2713', color: 'text-emerald-600' }; // checkmark
  if (pct >= 60) return { symbol: '\u26A0', color: 'text-amber-500' };  // warning
  return { symbol: '\u2717', color: 'text-red-500' };                    // cross
}

function fieldConfidenceDotColor(pct) {
  if (pct >= 80) return 'bg-emerald-500';
  if (pct >= 60) return 'bg-amber-500';
  return 'bg-red-500';
}

/** Extract value/confidence/source from new or old format */
function extractField(field) {
  if (field === null || field === undefined) return null;
  if (typeof field === 'object' && field.value !== undefined) {
    return {
      value: field.value,
      confidence: typeof field.confidence === 'number' ? field.confidence : null,
      source: field.source || null,
    };
  }
  // Old flat format — no confidence info
  return { value: field, confidence: null, source: null };
}

/** Extract value from line_items entry field (new format objects or plain values) */
function extractLineField(field) {
  if (field === null || field === undefined) return { value: null, confidence: null };
  if (typeof field === 'object' && field.value !== undefined) {
    return { value: field.value, confidence: typeof field.confidence === 'number' ? field.confidence : null };
  }
  return { value: field, confidence: null };
}

/**
 * Detects whether a backend extraction response is the new Gemini contract
 * (flat top-level: rfq_no/vendor_name/items/...) or the legacy QuoteParser
 * shape (extracted/line_items/...). The new endpoint returns the flat shape;
 * the legacy /parse-upload/ keeps the nested shape. Auto-fill below uses
 * the right code path for whichever it gets.
 */
function isGeminiExtractionPayload(data) {
  if (!data || typeof data !== 'object') return false;
  return (
    Object.prototype.hasOwnProperty.call(data, 'items') ||
    Object.prototype.hasOwnProperty.call(data, 'extraction_status') ||
    Object.prototype.hasOwnProperty.call(data, 'rfq_no') ||
    Object.prototype.hasOwnProperty.call(data, 'vendor_name')
  );
}

/* ------------------------------------------------------------------ */
/*  Source tooltip component                                          */
/* ------------------------------------------------------------------ */
function SourceTooltip({ text }) {
  if (!text) return null;
  return (
    <div className="group relative inline-block ml-1">
      <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5 text-slate-400 cursor-help" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <div className="invisible group-hover:visible absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-max max-w-xs px-3 py-2 text-xs text-white bg-slate-800 rounded-lg shadow-lg whitespace-pre-wrap">
        <div className="font-medium text-slate-300 mb-0.5">Source text:</div>
        {text}
        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AutoFillDot — small colored indicator next to auto-filled fields  */
/* ------------------------------------------------------------------ */
function AutoFillDot({ confidence }) {
  if (confidence === null || confidence === undefined) return null;
  const pct = typeof confidence === 'number' && confidence <= 1 ? confidence * 100 : confidence;
  const bg = pct >= 80 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-500' : 'bg-red-500';
  const label = pct >= 80 ? 'High confidence auto-fill' : pct >= 60 ? 'Medium confidence auto-fill' : 'Low confidence auto-fill';
  return (
    <span title={label} className={`inline-block h-2 w-2 rounded-full ${bg} ml-1.5 flex-shrink-0`} />
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export default function CreateQuoteResponse() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const rfqFromUrl = searchParams.get('rfq');
  const isEditMode = !!id;
  const { canCreate, canEdit } = usePermissions();
  // Create mode gates fields on Create; edit mode gates on Edit.
  const editable = isEditMode ? canEdit('Quote') : canCreate('Quote');
  const { isHidden, isReadOnly } = useFieldPermissions('Quote');
  const { isHidden: isLineHidden, isReadOnly: isLineRO } = useFieldPermissions('Quote Line');
  // Base input styling shared by the gated header fields; the locked
  // variant is applied when a field is READ_ONLY for the role.
  const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
  const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;
  const { options: rfqOptions, raw: rfqRaw } = useLookup('/api/purchase/rfq/');
  const { raw: evalRaw } = useLookup('/api/purchase/evaluations/');
  const { options: vendorOptions, raw: vendorRaw } = useLookup('/api/vendors/');
  // Loads the entire active product master via DRF pagination — global
  // useLookup caps at 500 rows so products past that boundary were
  // invisible in the dropdown. Shared across all purchase forms.
  const { options: productOptions, raw: productRaw } = useAllProducts();
  // Unified item catalogue (Product + Machinery + Service). The Quote
  // line dropdown sources from here so vendors can quote on any of the
  // three sources. The existing `productRaw` is still used by the
  // Gemini OCR matching code which is Product-master specific.
  const { raw: purchaseItems } = useLookup('/api/purchase/items/');
  const fileInputRef = useRef(null);

  const [isLoading, setIsLoading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const pendingAttachmentsRef = useRef([]);
  // Default to AI Auto Fill for any NEW quote — the vendor's quote
  // document is usually on hand, so extraction is the primary path.
  // Editing an existing quote (`id` set) starts on Manual since the
  // fields are already populated.
  const [fillMode, setFillMode] = useState(!id ? 'autofill' : 'manual'); // 'manual' or 'autofill'
  const [formData, setFormData] = useState({
    rfq: '',
    vendor: '',
    vendor_name_text: '',
    quote_date: new Date().toISOString().split('T')[0],
    price_valid_till: '',
    currency: 'INR',
    payment_terms: '',
    custom_payment_terms: '',
    delivery_terms: '',
    lead_time_days: '',
    remarks: '',
  });

  // Computed after formData is declared
  const evaluatedRfqIds = new Set(evalRaw.map(e => e.rfq));
  const filteredRfqOptions = rfqOptions.filter(o => {
    if (evaluatedRfqIds.has(o.value) && o.value !== rfqFromUrl && o.value !== formData.rfq) return false;
    // A quote can only be recorded against an RFQ that has been EMAILED to
    // vendors. Keep the current/URL selection regardless (edit mode).
    if (o.value === rfqFromUrl || o.value === formData.rfq) return true;
    const row = (rfqRaw || []).find(r => String(r.id) === String(o.value));
    return row?.email_sent === true;
  });

  // Vendor dropdown scoping. The Vendor list must contain ONLY the
  // vendors invited to the currently-selected RFQ — never the whole
  // vendor master. As vendors submit their quotes for THIS RFQ, drop
  // them from the list so a duplicate quote can't be entered for the
  // same vendor+RFQ pair. Cross-RFQ responses don't filter anything —
  // a vendor who quoted on RFQ-A is still selectable on RFQ-B.
  // In edit mode the current quote's vendor is always preserved.
  const [respondedVendorIds, setRespondedVendorIds] = useState(new Set());
  // Invited-vendor list is fetched directly from /api/purchase/rfq/<id>/
  // rather than read off the cached rfqRaw list. The cached list may
  // omit the selected RFQ (pagination, soft-deleted, filtered) which
  // used to silently empty the vendor dropdown. `null` = still loading,
  // `Set` = loaded (possibly empty).
  const [invitedVendorIds, setInvitedVendorIds] = useState(null);
  useEffect(() => {
    if (!formData.rfq) {
      setRespondedVendorIds(new Set());
      setInvitedVendorIds(null);
      return;
    }
    // Fan out the two fetches in parallel — invited list + already-
    // responded list. They're independent: a stale rfqRaw is no longer
    // a dependency.
    let cancelled = false;
    Promise.all([
      apiClient.get(`/api/purchase/rfq/${formData.rfq}/`),
      apiClient.get('/api/purchase/quotes/', { params: { rfq: formData.rfq, page_size: 500 } }),
    ])
      .then(([rfqRes, quotesRes]) => {
        if (cancelled) return;
        const invited = new Set(((rfqRes.data?.vendors) || []).map(String));
        setInvitedVendorIds(invited);
        const list = quotesRes.data?.results || quotesRes.data || [];
        const ids = new Set(
          list
            .filter(q => !isEditMode || String(q.id) !== String(id))
            .map(q => q.vendor)
            .filter(Boolean)
            .map(String)
        );
        setRespondedVendorIds(ids);
        // If the URL ?rfq= pre-fill picked a vendor who has already
        // submitted a quote, clear formData.vendor so the dropdown shows
        // its placeholder instead of an invisible selected value.
        if (!isEditMode && formData.vendor && ids.has(String(formData.vendor))) {
          setFormData(prev => ({ ...prev, vendor: '' }));
        }
      })
      .catch(() => {
        if (cancelled) return;
        setInvitedVendorIds(new Set());
        setRespondedVendorIds(new Set());
      });
    return () => { cancelled = true; };
  }, [formData.rfq, isEditMode, id]);

  const vendorDropdownOptions = (() => {
    if (!invitedVendorIds) return [];
    return vendorOptions.filter(o => {
      const vid = String(o.value);
      if (!invitedVendorIds.has(vid)) return false;
      if (respondedVendorIds.has(vid)) {
        if (isEditMode && String(formData.vendor) === vid) return true;
        return false;
      }
      return true;
    });
  })();
  // Distinguish "RFQ details still loading" from "everyone responded".
  // The placeholder needs both states because they're easy to confuse —
  // an empty dropdown was previously displayed identically in both cases.
  const vendorDropdownLoading = formData.rfq && invitedVendorIds === null;
  const vendorDropdownExhausted = formData.rfq
    && invitedVendorIds !== null
    && invitedVendorIds.size > 0
    && vendorDropdownOptions.length === 0;
  const vendorDropdownEmptyInvited = formData.rfq
    && invitedVendorIds !== null
    && invitedVendorIds.size === 0;

  // Track which fields were auto-filled and their confidence
  const [autoFilledFields, setAutoFilledFields] = useState({});
  // Track source texts for auto-filled fields (for tooltips)
  const [fieldSources, setFieldSources] = useState({});

  // Store rfq_no from edit data for fallback display
  const [editRfqOption, setEditRfqOption] = useState(null);

  // Load existing data in edit mode
  useEffect(() => {
    if (!isEditMode) return;
    apiClient.get(`/api/purchase/quotes/${id}/`).then(async (res) => {
      const q = res.data;
      setFormData({
        rfq: q.rfq || '', vendor: q.vendor || '', vendor_name_text: q.vendor_name_text || '',
        quote_date: q.quote_date || '',
        price_valid_till: q.price_valid_till || '', currency: q.currency || '',
        payment_terms: q.payment_terms || '', custom_payment_terms: q.custom_payment_terms || '',
        delivery_terms: q.delivery_terms || '', lead_time_days: q.lead_time_days || '', remarks: q.remarks || '',
      });
      // Save RFQ option as fallback in case lookup hasn't loaded yet
      if (q.rfq && q.rfq_no) {
        setEditRfqOption({ value: q.rfq, label: q.rfq_no });
      }
      if (q.quote_lines?.length > 0) {
        setLineItems(q.quote_lines.map(l => {
          // A line can reference any one of three masters via three
          // separate FKs. Previously this only read `product_service`,
          // so MACHINERY / SERVICE lines showed up with an empty
          // product dropdown — and even PRODUCT lines didn't pre-select
          // because the dropdown's encoded value is "<TYPE>:<id>" and
          // `item_type` was never restored. Pick the FK that's set, fall
          // back to the serializer's `item_type` (already computed) and
          // then to `PRODUCT` for legacy rows.
          const itemId = l.product_service || l.machinery || l.service_catalogue || '';
          const itemType = (l.item_type
            || (l.machinery ? 'MACHINERY'
              : l.service_catalogue ? 'SERVICE'
              : 'PRODUCT')).toUpperCase();
          return {
            product: itemId,
            item_type: itemType,
            quantity: l.quantity_offered || 1,
            uom: l.uom || 'KG',
            unit_price: l.unit_price || '',
            gst: l.gst || '',
            description: l.specification || '',
          };
        }));
      } else if (q.rfq) {
        // Recovery path: the quote has no saved lines (likely an old
        // record from before Quantity + Unit Price were validated —
        // the original submit silently filtered out rows missing
        // either field, leaving the quote with zero lines on the
        // backend). Re-seed the line items from the RFQ's linked PRs
        // so the operator can fill in Unit Price and re-save instead
        // of starting from a blank table. Same shape the URL-prefill
        // and handleRfqChange paths produce.
        try {
          const rfqRes = await apiClient.get(`/api/purchase/rfq/${q.rfq}/`);
          const prIds = rfqRes.data?.linked_prs || [];
          const prFetches = await Promise.all(
            prIds.map(pid => apiClient.get(`/api/purchase/requests/${pid}/`).catch(() => null))
          );
          const seeded = [];
          prFetches.forEach(prRes => {
            if (!prRes) return;
            // Exclude products routed to "Skip RFQ" — they already have a direct
        // PO, so they must NOT be quoted here (would double-order).
        const lines = (prRes.data?.lines || prRes.data?.pr_lines || []).filter(l => !l.allow_rfq_skip);
            lines.forEach(line => {
              seeded.push({
                product: line.product_service || line.product || '',
                item_type: 'PRODUCT',
                quantity: line.quantity_requested || line.quantity || 1,
                _requested_qty: line.quantity_requested || line.quantity || '',
                uom: line.uom || 'KG',
                unit_price: '',
                gst: '',
                description: line.specification || line.description_override || line.description || '',
              });
            });
          });
          if (seeded.length > 0) {
            setLineItems(seeded);
            toast(`No saved lines on this quote — seeded ${seeded.length} row(s) from the linked PR. Fill in Unit Price before saving.`, { icon: 'ℹ️', duration: 7000 });
          }
        } catch { /* silently keep the empty default row */ }
      }
    }).catch(() => toast.error('Failed to load quote'));
  }, [id, isEditMode]);

  // Auto-fill from RFQ when navigating from RFQ detail page (?rfq=UUID)
  const [rfqAutoFilled, setRfqAutoFilled] = useState(false);
  const [prefillRfqNo, setPrefillRfqNo] = useState('');

  // Fetch RFQ number immediately (before rfqRaw loads) to show in read-only field
  useEffect(() => {
    if (!rfqFromUrl || prefillRfqNo) return;
    setFormData(prev => ({ ...prev, rfq: rfqFromUrl }));
    apiClient.get(`/api/purchase/rfq/${rfqFromUrl}/`).then(res => {
      setPrefillRfqNo(res.data.rfq_no || '');
    }).catch(() => {});
  }, [rfqFromUrl]);

  useEffect(() => {
    // URL-prefill auto-fill. Previously gated on `rfqRaw.length > 0`, but
    // the RFQ detail is fetched directly below — waiting on the cached
    // list just delayed the fill (and skipped it entirely if the RFQ was
    // missing from the paginated list). Drop the gate so the fill runs
    // as soon as the URL param arrives.
    if (!rfqFromUrl || isEditMode || rfqAutoFilled) return;

    setFormData(prev => ({ ...prev, rfq: rfqFromUrl }));
    setRfqAutoFilled(true);

    // Fetch RFQ details to get line items. Don't pre-pick a vendor —
    // multiple invited vendors may have responded, and the user must
    // pick the one whose quote they're entering. Auto-picking the first
    // vendor was confusing once we started filtering already-responded
    // vendors out of the dropdown.
    apiClient.get(`/api/purchase/rfq/${rfqFromUrl}/`).then(async (res) => {
      const rfq = res.data;
      if (!prefillRfqNo) setPrefillRfqNo(rfq.rfq_no || '');
      // `linked_prs` on the RFQ header serializer is a flat array of PR
      // UUIDs (M2M default), NOT nested PR objects. The previous code
      // iterated it as if each entry already had `.lines` — that's why
      // arriving via "Quote Response" from the RFQ list showed an empty
      // line-items table. Fetch each PR detail (which DOES expose
      // `lines`) and flatten — same pattern handleRfqChange uses for
      // manual RFQ selection.
      const prIds = rfq.linked_prs || [];
      const prFetches = await Promise.all(
        prIds.map(prId => apiClient.get(`/api/purchase/requests/${prId}/`).catch(() => null))
      );
      const prLines = [];
      prFetches.forEach(prRes => {
        if (!prRes) return;
        // Exclude products routed to "Skip RFQ" — they already have a direct
        // PO, so they must NOT be quoted here (would double-order).
        const lines = (prRes.data?.lines || prRes.data?.pr_lines || []).filter(l => !l.allow_rfq_skip);
        lines.forEach(line => {
          prLines.push({
            product: line.product_service || line.product || '',
            quantity: line.quantity_requested || line.quantity || 1,
            _requested_qty: line.quantity_requested || line.quantity || '',
            uom: line.uom || 'KG',
            unit_price: '',
            gst: '',
            description: line.specification || line.description_override || line.description || '',
          });
        });
      });
      if (prLines.length > 0) setLineItems(prLines);
    }).catch(() => {});
  }, [rfqFromUrl, isEditMode, rfqAutoFilled]);

  /* ---------- Text extraction (from Doc Extractor) ---------- */
  const [extractText, setExtractText] = useState('');
  const [isExtracting, setIsExtracting] = useState(false);

  const handleTextExtract = async () => {
    if (!extractText.trim()) { toast.error('Paste or type text to extract'); return; }
    setIsExtracting(true);
    try {
      const fd = new FormData();
      fd.append('text', extractText.trim());
      const res = await apiClient.post('/api/purchase/extract-document/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      // Convert to parseResult format
      const raw = res.data.raw_parser || {};
      const d = res.data.data || {};
      const result = {
        extracted: raw.extracted || {},
        line_items: raw.line_items || [],
        confidence: raw.confidence || (res.data.confidence_summary?.overall_confidence * 100) || 0,
        warnings: raw.warnings || [],
      };
      // Merge structured data
      if (d.vendor_name?.value) result.extracted.vendor_name = d.vendor_name.value;
      if (d.date?.value) result.extracted.quote_date = d.date.value;
      if (d.grand_total?.value) result.extracted.total_amount = d.grand_total.value;
      // Build line items from products if needed
      if ((!result.line_items || result.line_items.length === 0) && d.products?.length > 0) {
        result.line_items = d.products.map(p => ({
          product_name: { value: p.name?.value || '', confidence: p.name?.confidence || 0.5 },
          quantity: { value: p.quantity?.value || 1, confidence: p.quantity?.confidence || 0.5 },
          uom: { value: p.unit?.value || 'NOS', confidence: p.unit?.confidence || 0.5 },
          unit_price: { value: p.price_per_unit?.value || 0, confidence: p.price_per_unit?.confidence || 0.5 },
        }));
      }
      setParseResult(result);
      toast.success(`Extracted with ${Math.round(result.confidence || 0)}% confidence`);
    } catch (err) {
      toast.error('Text extraction failed');
    } finally {
      setIsExtracting(false);
    }
  };

  /* ---------- Line items state ---------- */
  const [lineItems, setLineItems] = useState([
    { product: '', quantity: 1, length: '', width: '', breadth: '', height: '', uom: 'KG', unit_price: '', gst: '', description: '' },
  ]);

  // GST is a property of the PRODUCT (its HSN), not the vendor. When the
  // picked product has a GST set in the master, the quote line auto-fills
  // and locks to it so the rate is identical across every vendor.
  const productMasterGst = (productId) => {
    if (!productId) return null;
    const p = (productRaw || []).find(r => String(r.id) === String(productId));
    const g = p?.gst_percentage;
    return (g === null || g === undefined || g === '') ? null : g;
  };

  // Physical dimensions (Length/Width/Breadth/Height) only matter for PACKING
  // MATERIAL lines, so the expandable dimension row is shown only when the
  // line's product is a packing material (goods_sub_type === 'PACKING_MATERIAL').
  const isPackingLine = (item) => {
    if (!item?.product) return false;
    const p = (productRaw || []).find(r => String(r.id) === String(item.product));
    return p?.goods_sub_type === 'PACKING_MATERIAL';
  };

  const handleLineChange = (idx, field, value) => {
    setLineItems(prev => prev.map((item, i) => {
      if (i !== idx) return item;
      const next = { ...item, [field]: value };
      if (field === 'product') {
        const masterGst = productMasterGst(value);
        if (masterGst !== null) next.gst = String(masterGst);  // lock to master GST
      }
      return next;
    }));
  };

  const addLine = () => {
    setLineItems(prev => [...prev, { product: '', quantity: 1, length: '', width: '', breadth: '', height: '', uom: 'KG', unit_price: '', gst: '', description: '' }]);
  };

  const removeLine = (idx) => {
    if (lineItems.length <= 1) return;
    setLineItems(prev => prev.filter((_, i) => i !== idx));
    setLineExpand({});  // indices shift on delete — drop stale overrides
  };

  // Per-line dimension row expand/collapse (only used for packing-material lines).
  const [lineExpand, setLineExpand] = useState({});
  const lineHasDims = (it) => !!(Number(it.length) || Number(it.width) || Number(it.breadth) || Number(it.height));
  const isLineExpanded = (it, idx) => (lineExpand[idx] !== undefined ? lineExpand[idx] : lineHasDims(it));
  const toggleLine = (idx) => setLineExpand(prev => ({ ...prev, [idx]: !isLineExpanded(lineItems[idx], idx) }));


  /* ---------- File-upload state ---------- */
  const [uploadedFile, setUploadedFile] = useState(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseResult, setParseResult] = useState(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [autoFillPending, setAutoFillPending] = useState(false);

  // ── Product-mismatch resolution state ────────────────────────────────
  // Cached lookups (fetched on RFQ pick + vendor pick) so applyGeminiExtraction
  // can run them synchronously. Refs because the extraction effect reads them.
  const [rfqProducts, setRfqProducts] = useState([]);
  const [vendorMappings, setVendorMappings] = useState([]);
  const rfqProductsRef = useRef([]);
  const vendorMappingsRef = useRef([]);
  useEffect(() => { rfqProductsRef.current = rfqProducts; }, [rfqProducts]);
  useEffect(() => { vendorMappingsRef.current = vendorMappings; }, [vendorMappings]);

  const [mismatchRows, setMismatchRows] = useState([]);
  const [mismatchOpen, setMismatchOpen] = useState(false);

  // Buffer of resolved mismatches kept across the session so they can be POSTed
  // to the audit log alongside the Quote save. Key is the vendor product name
  // (lowercased) so re-resolving the same row replaces the prior decision.
  const mismatchAuditRef = useRef(new Map());
  const recordAuditDecision = (entry) => {
    const k = (entry.vendor_product_name || '').trim().toLowerCase();
    if (!k) return;
    mismatchAuditRef.current.set(k, entry);
  };

  // Vendor match confirmation — shown when the best candidate scored
  // 0.60–0.85 (probable but not certain).
  const [vendorConfirm, setVendorConfirm] = useState(null);
  // shape: { extractedName, candidate: {id, vendor_name, vendor_code}, score }

  // Fetch RFQ products whenever the selected RFQ (or vendor) changes. When a
  // vendor is chosen we scope to the line items THAT vendor was actually sent
  // in their RFQ email (per-line routing), so the quote reflects what they
  // were asked to quote — not the whole RFQ.
  useEffect(() => {
    if (!formData.rfq) { setRfqProducts([]); return; }
    const params = formData.vendor ? { vendor_id: formData.vendor } : {};
    apiClient.get(`/api/purchase/rfq/${formData.rfq}/products/`, { params })
      .then(res => setRfqProducts(Array.isArray(res.data) ? res.data : []))
      .catch(() => setRfqProducts([]));
  }, [formData.rfq, formData.vendor]);

  // Seed the line-item grid to the selected vendor's routed lines. Runs only
  // before any quote price is entered, so AI-extracted / manually-typed
  // quotes are never clobbered. This is what makes a vendor sent 2 of 3 lines
  // show exactly those 2 lines here (matching their RFQ email).
  useEffect(() => {
    if (isEditMode || !formData.rfq || !formData.vendor) return;
    const noPrices = (lineItems || []).every(l => l.unit_price === '' || l.unit_price == null);
    if (!noPrices) return;
    let cancelled = false;
    apiClient.get(`/api/purchase/rfq/${formData.rfq}/products/`, { params: { vendor_id: formData.vendor } })
      .then(res => {
        if (cancelled) return;
        const prods = Array.isArray(res.data) ? res.data : [];
        if (prods.length === 0) return;
        setLineItems(prods.map(p => ({
          product: p.product,
          quantity: p.quantity_requested || 1,
          _requested_qty: p.quantity_requested || '',
          length: '', width: '', breadth: '', height: '',
          uom: p.uom || 'KG',
          unit_price: '',
          gst: '',
          description: '',
        })));
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.rfq, formData.vendor, isEditMode]);

  // Fetch saved vendor → product mappings whenever vendor changes.
  useEffect(() => {
    if (!formData.vendor) { setVendorMappings([]); return; }
    apiClient.get('/api/purchase/vendor-product-mappings/', { params: { vendor: formData.vendor, page_size: 500 } })
      .then(res => {
        const list = res.data?.results || res.data || [];
        setVendorMappings(Array.isArray(list) ? list : []);
      })
      .catch(() => setVendorMappings([]));
  }, [formData.vendor]);

  // Check sessionStorage for extracted data from Document Extractor
  useEffect(() => {
    if (isEditMode) return;
    try {
      const stored = sessionStorage.getItem('extractedQuoteData');
      if (stored) {
        sessionStorage.removeItem('extractedQuoteData');
        const data = JSON.parse(stored);
        // Build a parseResult-compatible object from the stored data
        setParseResult({
          extracted: data.extracted || data,
          extracted_detailed: data.extracted_detailed || {},
          line_items: data.line_items || data.extracted?.items || [],
          confidence: data.confidence || 50,
        });
        setAutoFillPending(true);
        setFillMode('autofill');
      }
    } catch (e) {
      console.error('Failed to load extracted data from session:', e);
    }
  }, [isEditMode]);

  /* ---------- Handlers ---------- */

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => {
      const next = { ...prev, [name]: type === 'checkbox' ? checked : value };
      // Drop any stale custom text when payment terms moves off CUSTOM,
      // so a non-custom quote never carries leftover free-text.
      if (name === 'payment_terms' && value !== 'CUSTOM') next.custom_payment_terms = '';
      return next;
    });
  };

  // True when the line-item grid is still the untouched single blank row,
  // so it's safe to overwrite with RFQ-derived lines without losing input.
  const lineItemsAreBlank = (rows) =>
    !rows || rows.length === 0 ||
    (rows.length === 1 && !rows[0].product && !rows[0].description &&
      (rows[0].unit_price === '' || rows[0].unit_price == null));

  // When RFQ changes, fetch RFQ details and auto-fill line items from the
  // linked PRs. The product / quantity / UOM / specification are the data
  // an RFQ and a quote share, so we fill them in BOTH fill modes — picking
  // an RFQ shouldn't require uploading a document just to seed the grid.
  // In autofill mode we only fill when the grid is still blank, so an RFQ
  // pick never clobbers values the AI already extracted.
  const handleRfqChange = async (e) => {
    const rfqId = e.target.value;
    setFormData(prev => ({ ...prev, rfq: rfqId }));

    if (!rfqId) return;

    // If a vendor is already chosen, the vendor-scoped seeding effect owns the
    // grid (it shows only that vendor's routed lines) — don't seed all lines
    // here and clobber it.
    if (formData.vendor) return;

    // Don't overwrite AI-extracted lines in autofill mode.
    if (fillMode === 'autofill' && !lineItemsAreBlank(lineItems)) return;

    try {
      const res = await apiClient.get(`/api/purchase/rfq/${rfqId}/`);
      const rfq = res.data;

      // `linked_prs` is a flat array of PR UUIDs; fetch each PR detail
      // (which exposes `lines`) and flatten — same shape the ?rfq= URL
      // prefill produces.
      const prIds = rfq.linked_prs || [];
      const prFetches = await Promise.all(
        prIds.map(prId => apiClient.get(`/api/purchase/requests/${prId}/`).catch(() => null))
      );
      const newLines = [];
      prFetches.forEach(prRes => {
        if (!prRes) return;
        // Exclude products routed to "Skip RFQ" — they already have a direct
        // PO, so they must NOT be quoted here (would double-order).
        const lines = (prRes.data?.lines || prRes.data?.pr_lines || []).filter(l => !l.allow_rfq_skip);
        lines.forEach(line => {
          newLines.push({
            product: line.product_service || line.product || '',
            quantity: line.quantity_requested || line.quantity || 1,
            _requested_qty: line.quantity_requested || line.quantity || '',
            uom: line.uom || 'KG',
            unit_price: '',
            gst: '',
            description: line.specification || line.description_override || line.description || '',
          });
        });
      });

      if (newLines.length > 0) {
        setLineItems(newLines);
        toast.success(`Auto-filled ${newLines.length} line item(s) from RFQ`);
      }
    } catch (err) {
      console.error('Failed to fetch RFQ details:', err);
    }
  };

  const processFile = useCallback(async (file) => {
    if (!file) return;

    // Validate type
    if (!ACCEPTED_TYPES.includes(file.type)) {
      toast.error('Unsupported file type. Please upload PDF, JPG, PNG, DOCX, or XLSX.');
      return;
    }

    // Validate size (max 20 MB)
    if (file.size > 20 * 1024 * 1024) {
      toast.error('File too large. Maximum size is 20 MB.');
      return;
    }

    setUploadedFile(file);
    setIsParsing(true);
    setParseResult(null);
    setAutoFilledFields({});
    setFieldSources({});

    try {
      const fd = new FormData();
      fd.append('file', file);

      // Gemini-only extraction. The legacy Python /parse-upload/ fallback
      // was removed because it returned garbage on real vendor documents
      // (header text bleeding into the vendor name, product columns chopped
      // mid-string, etc). If Gemini fails — bad scan, API issue — surface
      // the error and tell the user to switch to Manual Fill rather than
      // silently flooding the form with wrong data.
      const extractingToast = toast.loading('Extracting quote data…');
      let res;
      try {
        res = await apiClient.post('/api/purchase/quotes/extract/', fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
          // Gemini PDF extraction can take 15-60s per attempt; with the
          // primary→fallback retry chain (Flash → Flash-Lite) the worst
          // case approaches 2 minutes. Default axios timeout is 30s which
          // killed the request mid-extraction. Match gunicorn's 120s.
          timeout: 120000,
        });
      } finally {
        toast.dismiss(extractingToast);
      }

      setParseResult(res.data);

      const modelTag = res.data.model_used ? ` (${res.data.model_used})` : '';
      // Surface the underlying Gemini error so the user can see why it
      // failed (rate limit, model not enabled on the API key, 5xx from
      // Google, etc). `attempts[N].status` carries the last try's message.
      const attempts = Array.isArray(res.data.attempts) ? res.data.attempts : [];
      const lastAttemptStatus = attempts.length
        ? attempts[attempts.length - 1].status
        : '';
      const failureDetail = lastAttemptStatus && lastAttemptStatus !== 'ok'
        ? ` — ${lastAttemptStatus}`
        : '';

      if (res.data.extraction_status === 'failed') {
        toast.error(
          `Extraction failed${modelTag}${failureDetail}. Switch to Manual Fill or try a clearer document.`,
          { duration: 12000 },
        );
        // Always log the full diagnostics so we can chase the root cause
        // without re-running the upload.
        console.error('[QuoteUpload] extraction failed:', {
          model_used: res.data.model_used,
          extraction_status: res.data.extraction_status,
          attempts,
          warnings: res.data.warnings,
        });
      } else if (res.data.extraction_status === 'partial') {
        toast(`Extraction partial${modelTag} — review highlighted fields.`, { icon: '⚠️' });
      } else {
        toast.success(`Quote extracted${modelTag}`);
      }
      (res.data.warnings || []).forEach(w => toast(w, { icon: '⚠️' }));
      // Auto-trigger fill once lookups (vendor/rfq/product) are ready.
      setAutoFillPending(true);
    } catch (err) {
      console.error('[QuoteUpload] parse error:', err.response?.status, err.response?.data || err.message);
      const httpStatus = err.response?.status;
      const detail = err.response?.data?.error
        || err.response?.data?.detail
        || (httpStatus ? `HTTP ${httpStatus}` : err.message)
        || 'Failed to parse document';
      toast.error(`${detail}`, { duration: 12000 });
      setParseResult(null);
    } finally {
      setIsParsing(false);
    }
  }, []);

  const handleFileUpload = (e) => {
    processFile(e.target.files?.[0]);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    processFile(e.dataTransfer.files?.[0]);
  };

  const handleClearUpload = () => {
    setUploadedFile(null);
    setParseResult(null);
    setIsParsing(false);
    setAutoFilledFields({});
    setFieldSources({});
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Convert date from DD-MM-YYYY or DD/MM/YYYY to YYYY-MM-DD (HTML date input format)
  const convertDate = (dateStr) => {
    if (!dateStr) return '';
    const d = String(dateStr).trim();
    // Already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    // DD-MM-YYYY or DD/MM/YYYY
    const m = d.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    return '';
  };

  // Match vendor by name (case-insensitive partial match)
  const findVendorId = (name) => {
    if (!name) return '';
    const lower = name.toLowerCase().trim();
    const match = vendorRaw.find(v =>
      (v.vendor_name || '').toLowerCase().includes(lower) ||
      lower.includes((v.vendor_name || '').toLowerCase())
    );
    return match ? match.id : '';
  };

  // Match RFQ by number
  const findRfqId = (rfqNo) => {
    if (!rfqNo) return '';
    const match = rfqRaw.find(r => (r.rfq_no || '') === rfqNo);
    return match ? match.id : '';
  };

  // Map extracted payment terms to dropdown value
  const mapPaymentTerms = (terms) => {
    if (!terms) return '';
    const t = terms.toLowerCase();
    if (t.includes('net 15') || t.includes('net15')) return 'NET_15';
    if (t.includes('net 30') || t.includes('net30')) return 'NET_30';
    if (t.includes('net 45') || t.includes('net45')) return 'NET_45';
    if (t.includes('net 60') || t.includes('net60')) return 'NET_60';
    if (t.includes('cash') || t.includes('advance')) return 'CASH';
    if (t.includes('custom')) return 'CUSTOM';
    return '';
  };

  // Map freight terms
  const mapFreightTerms = (terms) => {
    if (!terms) return '';
    const t = terms.toLowerCase();
    if (t.includes('paid') || t.includes('prepaid') || t.includes('included')) return 'PAID';
    if (t.includes('to pay') || t.includes('collect') || t.includes('topay')) return 'TO_PAY';
    if (t.includes('mix')) return 'MIXED';
    return 'PAID'; // default if delivery terms exist
  };

  /* ---------- Enhanced Auto-fill ---------- */
  const handleAutoFill = (mode = 'all') => {
    if (!parseResult?.extracted) return;
    const ext = parseResult.extracted;
    const threshold = mode === 'high' ? 0.80 : 0.0;

    // Helper: get value with confidence check, supporting both old and new format
    const getVal = (field) => {
      const f = ext[field];
      if (f === null || f === undefined) return null;
      if (typeof f === 'object' && f.value !== undefined) {
        return f.confidence >= threshold ? f.value : null;
      }
      return f; // old format — always include
    };

    // Helper: get confidence for a field
    const getConf = (field) => {
      const f = ext[field];
      if (f === null || f === undefined) return null;
      if (typeof f === 'object' && f.confidence !== undefined) return f.confidence;
      return null;
    };

    // Helper: get source text for a field
    const getSource = (field) => {
      const f = ext[field];
      if (f === null || f === undefined) return null;
      if (typeof f === 'object' && f.source) return f.source;
      return null;
    };

    const updates = {};
    const filled = {};
    const sources = {};
    let filledCount = 0;

    // RFQ — try to match by ID first, then by number
    const rfqId = getVal('rfq_id');
    if (rfqId) {
      updates.rfq = rfqId;
      filled.rfq = getConf('rfq_id');
      sources.rfq = getSource('rfq_id') || getSource('rfq_number');
      filledCount++;
    } else {
      const rfqNo = getVal('rfq_number');
      if (rfqNo) {
        const match = rfqRaw.find(r => (r.rfq_no || '') === rfqNo);
        if (match) {
          updates.rfq = match.id;
          filled.rfq = getConf('rfq_number');
          sources.rfq = getSource('rfq_number');
          filledCount++;
        }
      }
    }

    // Vendor — try ID first, then name match
    const vendorId = getVal('vendor_id');
    if (vendorId) {
      updates.vendor = vendorId;
      filled.vendor = getConf('vendor_id');
      sources.vendor = getSource('vendor_id') || getSource('vendor_name');
      filledCount++;
    } else {
      const vendorName = getVal('vendor_name');
      if (vendorName) {
        const match = findVendorId(vendorName);
        if (match) {
          updates.vendor = match;
          filled.vendor = getConf('vendor_name');
          sources.vendor = getSource('vendor_name');
          filledCount++;
        }
      }
    }

    // Quote Date
    const qd = getVal('quote_date');
    if (qd) {
      const d = convertDate(qd);
      if (d) { updates.quote_date = d; filled.quote_date = getConf('quote_date'); sources.quote_date = getSource('quote_date'); filledCount++; }
    }

    // Valid Until
    const vu = getVal('valid_until');
    if (vu) {
      const d = convertDate(vu);
      if (d) { updates.price_valid_till = d; filled.price_valid_till = getConf('valid_until'); sources.price_valid_till = getSource('valid_until'); filledCount++; }
    }

    // Currency
    const cur = getVal('currency');
    if (cur) { updates.currency = cur; filled.currency = getConf('currency'); sources.currency = getSource('currency'); filledCount++; }

    // Payment Terms
    const pt = getVal('payment_terms');
    if (pt) {
      const mapped = mapPaymentTerms(pt);
      if (mapped) {
        updates.payment_terms = mapped; filled.payment_terms = getConf('payment_terms'); sources.payment_terms = getSource('payment_terms'); filledCount++;
        // When the extracted terms don't match a standard option, keep the
        // raw text in the custom field so it isn't lost behind "CUSTOM".
        if (mapped === 'CUSTOM') updates.custom_payment_terms = String(pt);
      }
    }

    // Lead Time
    const lt = getVal('lead_time_days');
    if (lt) { updates.lead_time_days = String(lt); filled.lead_time_days = getConf('lead_time_days'); sources.lead_time_days = getSource('lead_time_days'); filledCount++; }

    // Delivery Terms (text)
    const dt = getVal('delivery_terms');
    if (dt) { updates.delivery_terms = dt; filled.delivery_terms = getConf('delivery_terms'); sources.delivery_terms = getSource('delivery_terms'); filledCount++; }

    // Remarks
    const notes = getVal('notes') || getVal('remarks');
    if (notes) { updates.remarks = notes; filled.remarks = getConf('notes') ?? getConf('remarks'); sources.remarks = getSource('notes') || getSource('remarks'); filledCount++; }

    setFormData(prev => ({ ...prev, ...updates }));
    setAutoFilledFields(filled);
    setFieldSources(sources);

    // Auto-fill line items from extracted products (support both formats)
    const rawItems = parseResult.line_items || ext.line_items || ext.items || [];
    if (rawItems.length > 0) {
      const newLines = rawItems.map(item => {
        // Extract values supporting new {value, confidence} format
        const pName = extractLineField(item.product_name).value || extractLineField(item.description).value || extractLineField(item.name).value || '';
        const sku = extractLineField(item.sku_code).value || '';
        const qty = extractLineField(item.quantity).value ?? extractLineField(item.qty).value ?? 1;
        const uom = extractLineField(item.uom).value || extractLineField(item.unit).value || 'KG';
        const price = extractLineField(item.unit_price).value ?? extractLineField(item.rate).value ?? '';
        const gst = extractLineField(item.gst).value ?? extractLineField(item.gst_percentage).value ?? (ext.gst_percentage ? (typeof ext.gst_percentage === 'object' ? ext.gst_percentage.value : ext.gst_percentage) : '');

        // Match product by name or SKU code (supports partial matching)
        const pNameLower = (pName || '').toLowerCase().trim();
        const skuLower = (sku || '').toLowerCase().trim();
        const match = productRaw.find(p => {
          const dbName = (p.product_name || '').toLowerCase();
          const dbSku = (p.sku_code || '').toLowerCase();
          // Exact match
          if (dbName && dbName === pNameLower) return true;
          if (dbSku && skuLower && dbSku === skuLower) return true;
          // Partial match: DB name contained in extracted name or vice versa
          if (dbName && pNameLower && (pNameLower.includes(dbName) || dbName.includes(pNameLower))) return true;
          // SKU partial match
          if (dbSku && skuLower && (skuLower.includes(dbSku) || dbSku.includes(skuLower))) return true;
          // Word-based match: check if product name words appear in extracted text
          if (dbName && pNameLower) {
            const dbWords = dbName.split(/\s+/).filter(w => w.length > 2);
            const matchCount = dbWords.filter(w => pNameLower.includes(w)).length;
            if (dbWords.length > 0 && matchCount >= Math.ceil(dbWords.length * 0.6)) return true;
          }
          return false;
        });
        return {
          product: match ? match.id : '',
          quantity: qty,
          uom: uom,
          unit_price: price,
          gst: gst,
          description: pName ? `${pName}${sku ? ' (' + sku + ')' : ''}` : '',
          _matched: !!match,
          _productName: pName,
        };
      });
      setLineItems(newLines);
      filledCount += rawItems.length;
    }

    let msg = `Auto-filled ${filledCount} field(s)`;
    if (rawItems.length > 0) msg += ` including ${rawItems.length} line item(s)`;
    if (mode === 'high') msg += ' (high confidence only)';
    toast.success(msg);
  };

  /* ---------- Gemini Auto-fill (new flat shape) ---------- */
  // Applies a response from POST /api/purchase/quotes/extract/ directly onto
  // form state. Field-by-field exact match against vendor/rfq/product master;
  // when no match exists the printed text is kept and an inline warning is
  // surfaced so the user can pick from the dropdown manually.
  const applyGeminiExtraction = async (data) => {
    if (!data || typeof data !== 'object') return;
    ocrLog('model_used:', data.model_used);
    ocrLog('extraction_status:', data.extraction_status);
    ocrLog('raw response:', data);

    const updates = {};
    const filled = {};
    const sources = {};   // re-use the existing tooltip surface for "extracted text" warnings
    const warnings = [];
    const failedMappings = [];   // surfaced via ocrLog at the end

    // Header — direct field-to-field copy where keys already match.
    const setHeader = (key, value) => {
      if (value === null || value === undefined || value === '') return;
      updates[key] = value;
      filled[key] = 0.9; // single-confidence flag for the highlight border
    };

    // Quote Date — backend canonicalises to `data.quote_date`. If
    // present, use it directly. If empty, fall back to scanning every
    // key in the response for any of the 16 known date labels
    // (production-safety: rescues old backends that don't recognise
    // newer aliases like "Quoted Rate" / "Vendor Quote Date").
    let quoteDate = (data.quote_date || '').trim();
    let quoteDateSource = quoteDate ? 'backend.quote_date' : null;
    if (!quoteDate) {
      const scan = _scanForDate(data);
      if (scan.value) {
        const coerced = _coerceDateFE(scan.value);
        if (coerced) {
          quoteDate = coerced;
          quoteDateSource = `fallback-scan(${scan.sourceKey})`;
          warnings.push(`Quote date rescued by frontend scan from key "${scan.sourceKey}" — backend should canonicalise this.`);
        } else {
          failedMappings.push({ field: 'quote_date', reason: 'frontend coerce failed', raw: scan.value, sourceKey: scan.sourceKey });
        }
      } else {
        failedMappings.push({ field: 'quote_date', reason: 'no recognised date label in response' });
      }
    }
    ocrLog('mapped quote_date:', quoteDate, '| source:', quoteDateSource);
    setHeader('quote_date', quoteDate);
    setHeader('price_valid_till', data.price_valid_till);
    setHeader('currency', data.currency);
    // Payment Terms — map free-text ("Net 30 days") to dropdown code ("NET_30").
    // Without this, the raw text doesn't match any <option value> and the
    // select stays on its placeholder.
    if (data.payment_terms) {
      const mapped = mapPaymentTerms(data.payment_terms);
      if (mapped) {
        setHeader('payment_terms', mapped);
        // Preserve the raw extracted text for unmatched ("CUSTOM") terms.
        if (mapped === 'CUSTOM') setHeader('custom_payment_terms', String(data.payment_terms));
        sources.payment_terms = `Extracted "${data.payment_terms}" → ${mapped}`;
      } else {
        warnings.push(`Payment Terms extracted: "${data.payment_terms}" — no dropdown match, select manually.`);
        sources.payment_terms = `Extracted "${data.payment_terms}" (no exact match)`;
      }
    }
    setHeader('lead_time_days', data.lead_time_days);
    setHeader('delivery_terms', data.delivery_terms);
    setHeader('remarks', data.remarks);
    // (freight_terms isn't in formData today — show the extracted value as a warning instead.)
    if (data.freight_terms) {
      warnings.push(`Freight Terms extracted: "${data.freight_terms}" — no field in form, capture in Remarks if needed.`);
    }

    // RFQ — exact match by rfq_no against the RFQ master. When matched,
    // also fetch the RFQ's products INLINE (await) so the line-item
    // matching block below has a real haystack instead of an empty
    // `rfqProductsRef.current` (which only populates async after
    // handleRfqChange's fetch resolves — too late for this run).
    let inlineRfqProducts = null;
    const rfqNo = (data.rfq_no || '').trim();
    if (rfqNo) {
      const match = rfqRaw.find(r => (r.rfq_no || '').trim() === rfqNo);
      if (match) {
        updates.rfq = match.id;
        filled.rfq = 1;
        sources.rfq = `Matched RFQ "${rfqNo}"`;
        try {
          const rfqProdRes = await apiClient.get(`/api/purchase/rfq/${match.id}/products/`);
          inlineRfqProducts = Array.isArray(rfqProdRes.data) ? rfqProdRes.data : [];
          // Push into state too so the modal / save path see them.
          setRfqProducts(inlineRfqProducts);
        } catch (err) {
          if (import.meta.env.DEV) console.error('[QuoteExtract] RFQ products fetch failed:', err);
          warnings.push(`Could not load RFQ ${rfqNo} products — line matches may be incomplete.`);
        }
      } else {
        warnings.push(`RFQ "${rfqNo}" not found in master — please select manually.`);
        sources.rfq = `Extracted "${rfqNo}" (no exact match)`;
        filled.rfq = 0.3;
      }
    }

    // Vendor — popup-on-anything-non-exact:
    //   - Exact (case-insensitive identical) → silent fill
    //   - Score ≥ 0.60                       → popup; user clicks Yes/No
    //   - Score < 0.60                       → no fill, warning only
    // (Lowered the silent threshold from 0.85 → exact-only so the user gets
    // a confirmation prompt for every "looks similar but not identical" case,
    // e.g. "GEMINI PACK" vs "Gemini packs".)
    const vendorName = (data.vendor_name || '').trim();
    let vendorConfirmCandidate = null;
    if (vendorName) {
      updates.vendor_name_text = vendorName;
      filled.vendor_name_text = 0.9;

      const vn = vendorName.toLowerCase().trim();

      // (1) Exact case-insensitive match → silent fill.
      let match = vendorRaw.find(v => (v.vendor_name || '').trim().toLowerCase() === vn);
      let bestScore = match ? 1.0 : 0;
      let bestCandidate = match || null;

      if (!match) {
        // (2) Compute fuzzy similarity against every vendor. Contains
        // either direction gets a similarity floor of 0.75 so big-prefix
        // matches ("Gemini packs" inside "Gemini Pack Industries Pvt Ltd")
        // surface in the popup rather than being missed.
        for (const v of vendorRaw) {
          const mn = (v.vendor_name || '').toLowerCase().trim();
          if (!mn) continue;
          let s = diceSimilarity(vendorName, v.vendor_name || '');
          if (mn.length >= 4 && vn.length >= 4 && (mn.includes(vn) || vn.includes(mn))) {
            s = Math.max(s, 0.75);
          }
          if (s > bestScore) { bestScore = s; bestCandidate = v; }
        }
        if (bestCandidate && bestScore >= 0.60) {
          // Queue confirmation popup. Don't auto-select.
          vendorConfirmCandidate = {
            extractedName: vendorName,
            candidate: {
              id: bestCandidate.id,
              vendor_name: bestCandidate.vendor_name,
              vendor_code: bestCandidate.vendor_code || '',
            },
            score: bestScore,
          };
        }
      }

      if (match) {
        updates.vendor = match.id;
        filled.vendor = 1;
        sources.vendor = `Matched vendor "${vendorName}" → "${match.vendor_name}" (exact)`;
      } else if (!vendorConfirmCandidate) {
        warnings.push(`Vendor "${vendorName}" not found in master — saved as text only; pick from dropdown if you have a master record.`);
        sources.vendor = `Extracted "${vendorName}" (no match)`;
        filled.vendor = 0.3;
      } else {
        // Similar match — leave dropdown empty until user confirms via popup.
        sources.vendor = `Extracted "${vendorName}" — confirm in popup`;
        filled.vendor = 0.5;
      }
    }

    setFormData(prev => ({ ...prev, ...updates }));
    setAutoFilledFields(prev => ({ ...prev, ...filled }));
    setFieldSources(prev => ({ ...prev, ...sources }));

    // Line items — RFQ-scoped resolution.
    // Order of resolution per extracted row:
    //   1. Saved vendor mapping  (silent auto-fill)
    //   2. SKU exact match against RFQ products
    //   3. Name exact match against RFQ products
    //   4. Fuzzy match (Dice) against RFQ products, >= FUZZY_THRESHOLD
    //   5. Below threshold or no candidate → push to mismatch modal
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length > 0) {
      const vendorMappings = vendorMappingsRef.current || [];   // saved vendor → product aliases
      // Prefer the freshly-fetched RFQ products from the inline await
      // above. Falls back to the ref (which holds whatever was last
      // cached from a previous RFQ selection) only when this extract
      // run didn't resolve an RFQ.
      const rfqProducts = inlineRfqProducts !== null
        ? inlineRfqProducts
        : (rfqProductsRef.current || []);
      const mismatchQueue = [];

      const newLines = items.map((it, idx) => {
        const rawName = (it.product_name || '').trim();
        let pName = rawName;
        let pCode = (it.product_code || '').trim();

        // Gemini often emits the SKU inside the product name like
        //   "Amino Acid Powder (RMNM00127)"
        // instead of populating a separate product_code field. When that
        // happens the SKU-exact match step below silently fails and the
        // line gets pushed to the mismatch modal even though the SKU
        // matches an RFQ product perfectly. Pull the parenthesised token
        // out into pCode (if it looks like an SKU code) and strip it
        // from pName so the name-exact comparison succeeds too.
        if (!pCode) {
          const m = rawName.match(/\(([A-Z0-9][A-Z0-9_\-\/]{2,})\)\s*$/i);
          if (m) {
            pCode = m[1];
            pName = rawName.slice(0, m.index).trim();
          }
        } else {
          // pCode already known — strip any "(SKU)" suffix off the name
          // so the exact name match doesn't trip on the embedded code.
          pName = rawName.replace(/\s*\(\s*[A-Z0-9][A-Z0-9_\-\/]{2,}\s*\)\s*$/i, '').trim();
        }

        const haystack = (pName || pCode).toLowerCase().trim();

        // 1) Saved vendor mapping wins outright.
        let match = null;
        let matchSource = '';
        let fuzzyScore = null;
        if (haystack && vendorMappings.length) {
          const m = vendorMappings.find(vm => (vm.extracted_text || '').toLowerCase().trim() === haystack);
          if (m) {
            match = { id: m.product, product_name: m.product_name, sku_code: m.product_sku };
            matchSource = 'mapping';
          }
        }

        // 2) SKU exact against RFQ products.
        if (!match && pCode && rfqProducts.length) {
          const m = rfqProducts.find(p => (p.sku_code || '').toLowerCase().trim() === pCode.toLowerCase().trim());
          if (m) { match = { id: m.product, product_name: m.product_name, sku_code: m.sku_code }; matchSource = 'sku'; }
        }

        // 3) Name exact against RFQ products.
        if (!match && pName && rfqProducts.length) {
          const m = rfqProducts.find(p => (p.product_name || '').toLowerCase().trim() === pName.toLowerCase().trim());
          if (m) { match = { id: m.product, product_name: m.product_name, sku_code: m.sku_code }; matchSource = 'name'; }
        }

        // 4) Fuzzy against RFQ products. Always pick the highest-scoring
        // candidate, defaulting to the first RFQ product so even a 0-score
        // match still surfaces *something* for the user to compare against.
        let bestRfq = rfqProducts.length ? rfqProducts[0] : null;
        let bestScore = 0;
        if (rfqProducts.length && (pName || pCode)) {
          for (const p of rfqProducts) {
            const sName = diceSimilarity(pName, p.product_name);
            const sCode = pCode && p.sku_code ? diceSimilarity(pCode, p.sku_code) : 0;
            const s = Math.max(sName, sCode);
            if (s > bestScore) { bestScore = s; bestRfq = p; }
          }
        }
        if (!match && bestRfq && bestScore >= FUZZY_THRESHOLD) {
          match = { id: bestRfq.product, product_name: bestRfq.product_name, sku_code: bestRfq.sku_code };
          matchSource = 'fuzzy';
          fuzzyScore = bestScore;
        }

        // NOTE: We deliberately do NOT fall back to the global product
        // master here. The mismatch modal compares only against the
        // selected RFQ's products, so off-RFQ master hits (e.g. "Amino
        // Acid Powder" exists in master but the RFQ doesn't include it)
        // stay unresolved and the user picks an RFQ product / creates new.

        // 5) Still unresolved → queue for the modal. We queue every unmatched
        // line, including those where Gemini didn't return a product_name
        // (only rate/qty), so the user can still pick from the RFQ dropdown.
        if (!match) {
          mismatchQueue.push({
            idx,
            extracted_name: pName || (it.description || '').trim() || '(no name extracted)',
            extracted_code: pCode,
            extracted_qty: it.quantity != null ? String(it.quantity) : '',
            extracted_uom: it.uom || '',
            extracted_rate: it.rate != null ? String(it.rate) : '',
            suggested_product: bestRfq ? {
              product: bestRfq.product,
              product_name: bestRfq.product_name,
              sku_code: bestRfq.sku_code,
            } : null,
            suggested_score: bestRfq ? bestScore : null,
            all_rfq_products: rfqProducts,
          });
        }

        // Pull unit price. Resolution order:
        //   1. Backend's canonical `it.rate` (handles all 25 aliases
        //      when backend is current).
        //   2. Defensive scan of every key on the item — rescues
        //      values when production backend is older than this
        //      frontend OR Gemini emits a label the backend missed.
        //   3. Derived `amount / quantity` when neither column is
        //      present but both qty + total are.
        const backendRate = (it.rate != null && it.rate !== '' && Number(it.rate) > 0)
          ? Number(it.rate) : null;
        let extractedRate = backendRate;
        let rateSource = backendRate != null ? 'backend.rate' : null;
        if (extractedRate == null) {
          const scan = _scanForRate(it);
          if (scan.value != null) {
            extractedRate = scan.value;
            rateSource = `fallback-scan(${scan.sourceKey})`;
            warnings.push(`Line ${idx + 1}: unit price rescued by frontend scan from "${scan.sourceKey}" — backend should canonicalise this.`);
          }
        }
        // If amount + quantity exist but rate doesn't, derive rate.
        const derivedRate = (extractedRate == null && it.amount && it.quantity)
          ? Number(it.amount) / Number(it.quantity)
          : null;
        if (extractedRate == null && derivedRate != null) {
          rateSource = 'derived(amount/quantity)';
        }
        const finalRate = extractedRate ?? derivedRate ?? '';
        ocrLog(`line ${idx + 1} unit_price:`, finalRate, '| source:', rateSource, '| raw item:', it);
        if (finalRate === '' || finalRate === 0) {
          failedMappings.push({ field: `line[${idx}].unit_price`, reason: 'no rate found in any known key' });
        }

        // Per-line GST falls back to header-level gst_percentage. Many quote
        // docs print GST once at the bottom (e.g. "GST: 18%" or "GST @ 5% Extra")
        // instead of repeating it on every line.
        const headerGstRaw = data.gst_percentage;
        const headerGst = headerGstRaw != null && headerGstRaw !== ''
          ? String(headerGstRaw).replace(/[^\d.\-]/g, '')
          : '';
        const lineGst = it.tax != null && it.tax !== '' ? it.tax : (headerGst || '');

        // Decode any namespaced RFQ id ("MACHINERY:..." / "SERVICE:...") so
        // the line stores the raw id plus item_type. Goods matches just pass
        // through with item_type='PRODUCT'.
        const matchDecoded = match ? decodeRfqProductId(match.id) : { item_type: 'PRODUCT', id: '' };
        return {
          item_type: matchDecoded.item_type,
          product: matchDecoded.id,
          quantity: it.quantity != null ? it.quantity : 1,
          uom: it.uom || 'KG',
          unit_price: finalRate,
          gst: lineGst,
          description: it.description || (pName ? `${pName}${pCode ? ' (' + pCode + ')' : ''}` : ''),
          _matched: !!match,
          _matchSource: matchSource,
          _fuzzyScore: fuzzyScore,
          _vendorProduct: false,           // becomes true if the user picks 'Use Extracted'
          _unresolved: !match,             // every unmatched line awaits modal resolution
          _extractedName: pName,
          _extractedCode: pCode,
          _productName: pName || pCode,
        };
      });
      setLineItems(newLines);

      // If anything is unresolved, open the modal once lookups are ready.
      if (mismatchQueue.length) {
        setMismatchRows(mismatchQueue);
        setMismatchOpen(true);
      }
    }

    if (warnings.length > 0) {
      warnings.slice(0, 6).forEach(w => toast(w, { icon: '⚠️', duration: 6000 }));
    }
    const fieldCount = Object.keys(updates).length + (data.rfq_no ? 1 : 0) + (data.vendor_name ? 1 : 0);
    toast.success(`Auto-filled ${fieldCount} field(s)${items.length ? ` + ${items.length} line item(s)` : ''}`);
    ocrLog('FINAL applied to form state', {
      headerUpdates: updates,
      itemCount: items.length,
      rfqMatched: !!updates.rfq,
      vendorMatched: !!updates.vendor,
      warnings,
      failedMappings,
    });

    // Trigger vendor-match confirmation popup if extraction was borderline.
    if (vendorConfirmCandidate) {
      setVendorConfirm(vendorConfirmCandidate);
    }
  };

  /* ---------- Product Mismatch resolution handler ---------- */
  // Called by the modal's "Apply Resolutions" button. Three resolution paths
  // per row:
  //   choice === 'rfq'    → write the picked RFQ product id into the line
  //   choice === 'create' → POST /api/products/ first, then write the new id
  //   choice === 'vendor' → keep extracted text, mark line as Vendor Product
  // Any 'Remember mapping' rows POST to /api/purchase/vendor-product-mappings/.
  const handleMismatchResolve = async (resolutions) => {
    // Phase 1: create any new products. If any fail, we surface a toast and
    // leave those lines as unresolved so the user can retry.
    const creates = resolutions.filter(r => r.choice === 'create' && r.newProduct);
    const createdIds = {};   // idx → new product id (newly created OR matched existing)
    const createdProducts = []; // genuinely new rows — for cache refresh + success toast
    const reusedExisting = []; // SKU already existed → reused the existing master row
    if (creates.length) {
      // Try to POST each new product. If POST fails with "sku_code already
      // exists" (HTTP 400 with that specific field error), fall back to
      // looking up the existing product master row by SKU and using its id —
      // the user's intent ("create this product") is best satisfied by
      // reusing the one that's already there. Same for product_name dupes.
      const findExistingBySku = (sku) =>
        (productRaw || []).find(p => (p.sku_code || '').trim().toLowerCase() === (sku || '').trim().toLowerCase());
      const findExistingByName = (name) =>
        (productRaw || []).find(p => (p.product_name || '').trim().toLowerCase() === (name || '').trim().toLowerCase());

      const isDuplicateField = (data, field) => {
        if (!data || typeof data !== 'object') return false;
        const v = data[field];
        const text = Array.isArray(v) ? v.join(' ') : (typeof v === 'string' ? v : '');
        return /already exists|must be unique/i.test(text);
      };

      const results = await Promise.allSettled(
        creates.map(r => apiClient.post('/api/products/', r.newProduct).then(res => ({ idx: r.idx, data: res.data }))),
      );

      results.forEach((res, i) => {
        const create = creates[i];
        if (res.status === 'fulfilled') {
          createdIds[res.value.idx] = res.value.data.id;
          createdProducts.push(res.value.data);
          return;
        }
        const err = res.reason;
        const httpStatus = err?.response?.status;
        const data = err?.response?.data;

        // Duplicate SKU / name → reuse the existing product instead of failing.
        if (httpStatus === 400) {
          let existing = null;
          if (isDuplicateField(data, 'sku_code')) {
            existing = findExistingBySku(create.newProduct.sku_code);
          }
          if (!existing && isDuplicateField(data, 'product_name')) {
            existing = findExistingByName(create.newProduct.product_name);
          }
          if (existing) {
            createdIds[create.idx] = existing.id;
            reusedExisting.push({ row: create.idx + 1, sku: existing.sku_code, name: existing.product_name });
            return;
          }
        }

        // Non-recoverable error — surface the full response so it's clear why.
        const fieldErrors = data && typeof data === 'object'
          ? Object.entries(data).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' | ')
          : (typeof data === 'string' ? data : err?.message || 'Unknown error');
        console.error('[Quote] Create product failed', {
          payload: create.newProduct,
          httpStatus,
          response: data,
        });
        let humanMsg = fieldErrors;
        if (httpStatus === 403) {
          humanMsg = "You don't have permission to create products. Ask an admin to grant 'Product' create permission to your role.";
        } else if (httpStatus === 401) {
          humanMsg = 'Your session expired. Please log in again.';
        }
        toast.error(
          `Row ${create.idx + 1} — failed to create product${httpStatus ? ` (HTTP ${httpStatus})` : ''}: ${humanMsg}`,
          { duration: 10000 },
        );
      });

      if (createdProducts.length) {
        toast.success(`Created ${createdProducts.length} new product${createdProducts.length > 1 ? 's' : ''} in master`);
      }
      if (reusedExisting.length) {
        const detail = reusedExisting
          .map(r => `Row ${r.row} → ${r.name}${r.sku ? ` (${r.sku})` : ''}`)
          .join('; ');
        toast(`Used existing master product${reusedExisting.length > 1 ? 's' : ''}: ${detail}`, {
          icon: 'ℹ️',
          duration: 8000,
        });
      }
      // If nothing got resolved (no creates succeeded and no SKU reused),
      // bail so the modal can stay open for the user to retry.
      const totalResolved = createdProducts.length + reusedExisting.length;
      if (totalResolved === 0) {
        return;
      }
    }

    // Phase 2: apply resolutions to lineItems.
    const rfqProductsById = new Map(rfqProducts.map(p => [String(p.product), p]));
    setLineItems(prev => prev.map((line, i) => {
      const r = resolutions.find(x => x.idx === i);
      if (!r) return line;
      if (r.choice === 'rfq') {
        const p = rfqProductsById.get(String(r.productId));
        // r.productId may be namespaced ("MACHINERY:<uuid>" / "SERVICE:<uuid>")
        // when the user picked a non-Goods RFQ item. Decode so the line
        // stores the raw id plus item_type — otherwise the save path
        // tries to write "MACHINERY:..." into product_service and the
        // backend rejects it.
        const decoded = decodeRfqProductId(r.productId);
        return {
          ...line,
          item_type: decoded.item_type,
          product: decoded.id,
          _matched: true,
          _matchSource: 'mismatch_modal',
          _vendorProduct: false,
          _unresolved: false,
          _productName: p?.product_name || line._productName,
        };
      }
      if (r.choice === 'create') {
        const newId = createdIds[i];
        if (!newId) {
          // Create failed — leave this row unresolved.
          return { ...line, _unresolved: true };
        }
        // Newly-created rows always land on master.Product (the create
        // endpoint is Product-only), so force item_type back to PRODUCT
        // in case the row was previously matched to a Machinery/Service.
        return {
          ...line,
          item_type: 'PRODUCT',
          product: newId,
          _matched: true,
          _matchSource: 'created_new',
          _vendorProduct: false,
          _unresolved: false,
          _productName: r.newProduct?.product_name || line._productName,
        };
      }
      // 'vendor' → keep the printed name, mark as Vendor Product, line resolves.
      // No FK saved for vendor-only rows; reset item_type so a later
      // toggle doesn't replay a stale machinery/service classification.
      return {
        ...line,
        item_type: 'PRODUCT',
        product: '',
        _matched: false,
        _vendorProduct: true,
        _unresolved: false,
      };
    }));

    // Fire-and-forget mapping saves for any "Remember" rows.
    const vendorId = formData.vendor;
    if (vendorId) {
      // Vendor-product mappings are a Goods-only construct (VendorProductMapping.product
      // is a FK to master.Product). Filter out Machinery / Service picks so a
      // "Remember this mapping" toggle on a non-Goods row doesn't 400 the request.
      const toSave = resolutions.filter(r => {
        if (!(r.remember && r.choice === 'rfq' && r.productId && r.extracted_name)) return false;
        const { item_type } = decodeRfqProductId(r.productId);
        return item_type === 'PRODUCT';
      });
      if (toSave.length) {
        try {
          await Promise.all(toSave.map(r =>
            apiClient.post('/api/purchase/vendor-product-mappings/', {
              vendor: vendorId,
              extracted_text: r.extracted_name,
              product: decodeRfqProductId(r.productId).id,
            }),
          ));
          toast.success(`Saved ${toSave.length} vendor mapping${toSave.length > 1 ? 's' : ''} for future quotes`);
          // Refresh local cache so it picks up immediately.
          apiClient.get('/api/purchase/vendor-product-mappings/', { params: { vendor: vendorId, page_size: 500 } })
            .then(res => setVendorMappings(res.data?.results || res.data || []))
            .catch(() => {});
        } catch (err) {
          toast.error('Failed to save one or more vendor mappings — they will need to be set again next time.');
        }
      }
    }

    // Record each decision in the audit buffer so it can be persisted on
    // Quote save. Keyed by vendor product name (last write wins per row).
    resolutions.forEach((r) => {
      const idxLine = lineItems[r.idx];
      const vendorName = r.extracted_name || idxLine?._extractedName || '';
      const rfqProduct = r.choice === 'rfq'
        ? rfqProductsById.get(String(r.productId))
        : null;
      const rfqProductName = rfqProduct?.product_name || idxLine?._productName || '';
      const userSelected = r.choice === 'rfq' ? 'RFQ_PRODUCT'
        : r.choice === 'create' ? 'NEW_PRODUCT'
        : r.choice === 'vendor' ? 'VENDOR_PRODUCT'
        : 'UNRESOLVED';
      // ProductMismatchLog.rfq_product is FK to master.Product, so only
      // log the raw id when the resolution actually picked a Product.
      // Machinery / Service picks audit-log without an rfq_product_id.
      const decodedAudit = r.choice === 'rfq' ? decodeRfqProductId(r.productId) : null;
      recordAuditDecision({
        vendor_product_name: vendorName,
        rfq_product_id: decodedAudit && decodedAudit.item_type === 'PRODUCT' ? decodedAudit.id : null,
        rfq_product_name: rfqProductName,
        user_selected: userSelected,
        similarity_score: idxLine?._fuzzyScore != null ? idxLine._fuzzyScore : null,
        remarks: '',
      });
    });

    setMismatchOpen(false);
    setMismatchRows([]);
  };

  // Auto-trigger fill when data comes from Document Extractor page OR Gemini extract.
  //
  // The previous version waited a hard-coded 500ms then ran — which
  // silently failed on a slow network because vendor / RFQ / product
  // lookups hadn't populated yet, leaving the Vendor and RFQ dropdowns
  // empty after extraction. We now wait until ALL three lookups have
  // returned non-empty arrays (or 4s have elapsed as a safety net) so
  // the match-by-name step has something to match against.
  useEffect(() => {
    if (!autoFillPending || !parseResult) return;

    const lookupsReady = vendorRaw.length > 0 && rfqRaw.length > 0 && productRaw.length > 0;

    const fire = () => {
      ocrLog('firing apply, lookups state:', {
        lookupsReady,
        vendorLookup: vendorRaw.length,
        rfqLookup: rfqRaw.length,
        productLookup: productRaw.length,
        isGemini: isGeminiExtractionPayload(parseResult),
      });
      if (isGeminiExtractionPayload(parseResult)) {
        applyGeminiExtraction(parseResult);
      } else if (parseResult?.extracted) {
        handleAutoFill('all');
      }
      setAutoFillPending(false);
    };

    if (lookupsReady) {
      fire();
      return;
    }

    // Safety net — if lookups never resolve (offline, API down, empty
    // master), fall back after 4s so the user at least sees scalar
    // fields populated. Vendor / RFQ dropdowns will stay blank but a
    // toast warning from applyGeminiExtraction explains why.
    const timer = setTimeout(fire, 4000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFillPending, parseResult, vendorRaw.length, rfqRaw.length, productRaw.length]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Block submission if any line item is still flagged as unresolved.
    const unresolved = lineItems.filter(l => l._unresolved);
    if (unresolved.length > 0) {
      toast.error(`Resolve ${unresolved.length} product mismatch${unresolved.length > 1 ? 'es' : ''} before saving.`);
      if (mismatchRows.length > 0) setMismatchOpen(true);
      return;
    }
    // Payment Terms are mandatory.
    if (!(formData.payment_terms || '').trim()) {
      toast.error('Payment Terms are required.');
      return;
    }
    // Quantity + Unit Price are mandatory on every line that has a
    // product picked. Previously the submit handler silently dropped
    // rows missing either field via `.filter(l => l.product && l.unit_price)`,
    // so operators thought their line saved and it didn't. Now we
    // surface a toast pointing at the first offending row.
    for (let i = 0; i < lineItems.length; i++) {
      const l = lineItems[i];
      if (!l.product) continue;
      const qty = parseFloat(l.quantity);
      if (!l.quantity && l.quantity !== 0 || Number.isNaN(qty) || qty <= 0) {
        toast.error(`Line ${i + 1}: Quantity is required and must be greater than 0.`);
        return;
      }
      const price = parseFloat(l.unit_price);
      if (l.unit_price === '' || l.unit_price == null || Number.isNaN(price) || price <= 0) {
        toast.error(`Line ${i + 1}: Unit Price is required and must be greater than 0.`);
        return;
      }
    }
    // Custom payment terms must carry the actual terms text.
    if (formData.payment_terms === 'CUSTOM' && !formData.custom_payment_terms.trim()) {
      toast.error('Enter the custom payment terms.');
      return;
    }
    // Non-blocking heads-up: some lines are quoted with a quantity that
    // differs from the PR's requested qty. Vendors legitimately quote
    // different lots, so this only informs — it never blocks submission.
    const qtyMismatchCount = lineItems.filter(l => l.product && qtyDiffersFromRequested(l)).length;
    if (qtyMismatchCount > 0) {
      toast(`${qtyMismatchCount} line(s) quoted with a different quantity than requested`, { icon: '⚠️' });
    }
    setIsLoading(true);
    try {
      const payload = cleanFormData(formData);
      // Attach buffered mismatch audit entries — server writes ProductMismatchLog
      // rows in a non-critical post-save hook (failure won't block quote save).
      const auditEntries = Array.from(mismatchAuditRef.current.values());
      if (auditEntries.length && !isEditMode) {
        payload.product_mismatch_resolutions = auditEntries;
      }
      if (import.meta.env.DEV) console.log('[QuoteResponse] payload:', payload);
      let quoteId;
      if (isEditMode) {
        await apiClient.patch(`/api/purchase/quotes/${id}/`, payload);
        quoteId = id;
      } else {
        const res = await apiClient.post('/api/purchase/quotes/', payload);
        quoteId = res.data.id;
      }

      // Add line items. Each line carries `item_type` which decides
      // whether the picked id lands on product_service / machinery /
      // service_catalogue. Goods lines default to product_service when
      // item_type isn't set (e.g. when the extraction flow auto-fills
      // matched Products without touching item_type).
      const validLines = lineItems.filter(l => l.product && l.unit_price);
      for (const line of validLines) {
        const itemType = (line.item_type || 'PRODUCT').toUpperCase();
        const fkField =
          itemType === 'MACHINERY' ? 'machinery' :
          itemType === 'SERVICE'   ? 'service_catalogue' :
                                     'product_service';
        try {
          await apiClient.post(`/api/purchase/quotes/${quoteId}/add-line/`, {
            [fkField]: line.product,
            quantity_offered: line.quantity || 1,
            uom: line.uom || 'KG',
            unit_price: line.unit_price || 0,
            // Master GST is authoritative when configured (locked field).
            gst: (productMasterGst(line.product) ?? line.gst) || 0,
            specification: line.description || '',
            // Physical dimensions — only meaningful for packing-material
            // lines. Sent as null when blank (DRF rejects '' for Decimal).
            length:  line.length  === '' || line.length  == null ? null : line.length,
            width:   line.width   === '' || line.width   == null ? null : line.width,
            breadth: line.breadth === '' || line.breadth == null ? null : line.breadth,
            height:  line.height  === '' || line.height  == null ? null : line.height,
          });
        } catch (lineErr) {
          console.error('Failed to add quote line:', lineErr.response?.data);
        }
      }

      // Always attach the quote's source document. Manual attachments plus
      // the AI auto-fill source file (if it wasn't also added manually).
      const filesToUpload = [...(pendingAttachmentsRef.current || [])];
      if (uploadedFile && !filesToUpload.some(f => f.name === uploadedFile.name && f.size === uploadedFile.size)) {
        filesToUpload.push(uploadedFile);
      }
      if (filesToUpload.length > 0) {
        await uploadPendingFiles('QUOTE', quoteId, filesToUpload);
      }

      toast.success(isEditMode ? 'Quote updated!' : `Quote created with ${validLines.length} line item(s)!`);
      navigate('/purchase/quotes');
    } catch (error) {
      if (import.meta.env.DEV) console.error('[CreateQuoteResponse] error:', error.response?.data);
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  /* ---------- Derived ---------- */
  const confidence = parseResult?.confidence ?? null;
  const extracted = parseResult?.extracted ?? null;
  const extractedItems = parseResult?.line_items || parseResult?.extracted?.line_items || parseResult?.extracted?.items || [];

  /** Build the field-by-field preview data from extracted, supporting both formats */
  const previewFields = (() => {
    if (!extracted) return [];
    const fieldDefs = [
      { key: 'rfq_number', label: 'RFQ Number' },
      { key: 'vendor_name', label: 'Vendor' },
      { key: 'quote_date', label: 'Quote Date' },
      { key: 'valid_until', label: 'Valid Until' },
      { key: 'currency', label: 'Currency' },
      { key: 'payment_terms', label: 'Payment Terms' },
      { key: 'freight_terms', label: 'Freight Terms' },
      { key: 'delivery_terms', label: 'Delivery Terms' },
      { key: 'lead_time_days', label: 'Lead Time (Days)' },
      { key: 'total_amount', label: 'Total Amount' },
      { key: 'notes', label: 'Notes' },
      { key: 'gst_percentage', label: 'GST %' },
    ];
    return fieldDefs
      .map(def => {
        const info = extractField(extracted[def.key]);
        if (!info || info.value === null || info.value === undefined || info.value === '') return null;
        return { ...def, ...info, confidencePct: info.confidence !== null ? Math.round(info.confidence * 100) : null };
      })
      .filter(Boolean);
  })();

  /* ---------- Render ---------- */
  return (
    <MainLayout>
      <PageHeader
        title={isEditMode ? 'Edit Quote Response' : 'Create Quote Response'}
        subtitle={isEditMode ? 'Update quote details and line items' : 'Fill in details and add line items'}
        breadcrumbs={[
          { label: 'Purchase', path: '/purchase' },
          { label: 'Quotes', path: '/purchase/quotes' },
          { label: isEditMode ? 'Edit' : 'New' },
        ]}
      />

      {/* ====== FILL MODE SELECTOR ====== */}
      {!isEditMode && (
        <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4 sm:mb-6">
          <div className="flex items-center gap-4 sm:gap-6">
            <span className="text-sm font-semibold text-slate-700">Fill Mode:</span>
            <label className={`flex items-center gap-2 px-4 py-2 rounded-lg cursor-pointer transition border-2 ${fillMode === 'manual' ? 'border-primary-500 bg-primary-50 text-primary-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>
              <input type="radio" name="fillMode" value="manual" checked={fillMode === 'manual'} onChange={() => setFillMode('manual')} className="text-primary-600 focus:ring-primary-500" />
              <div>
                <span className="font-medium text-sm">Manual Fill</span>
                <span className="text-xs text-slate-500 block">Select RFQ to auto-fill from linked PR data</span>
              </div>
            </label>
            <label className={`flex items-center gap-2 px-4 py-2 rounded-lg cursor-pointer transition border-2 ${fillMode === 'autofill' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>
              <input type="radio" name="fillMode" value="autofill" checked={fillMode === 'autofill'} onChange={() => setFillMode('autofill')} className="text-emerald-600 focus:ring-emerald-500" />
              <div>
                <span className="font-medium text-sm">Auto Fill (AI)</span>
                <span className="text-xs text-slate-500 block">Upload document to extract & auto-fill fields</span>
              </div>
            </label>
          </div>
        </div>
      )}

      {/* ====== FILE UPLOAD SECTION (only in autofill mode) ====== */}
      {fillMode === 'autofill' && <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6 mb-4 sm:mb-6">
        <h3 className="text-lg font-semibold text-slate-800 mb-4">Extract Quote Data</h3>

        {/* Drop zone */}
        {!uploadedFile && (
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 sm:px-6 py-10 cursor-pointer transition-colors ${
              isDragOver
                ? 'border-primary-400 bg-primary-50'
                : 'border-slate-300 bg-slate-50 hover:border-primary-300 hover:bg-primary-50/50'
            }`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-slate-400 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="text-sm font-medium text-slate-700 mb-1">
              Drag &amp; drop or click to upload
            </p>
            <p className="text-xs text-slate-500">
              Supports: PDF, JPG, PNG, DOCX, XLSX
            </p>

            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_EXTENSIONS}
              onChange={handleFileUpload}
              className="hidden"
            />

            <div className="mt-4 flex flex-wrap items-center justify-center gap-2" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                onClick={(e) => {
                  e.stopPropagation();
                  fileInputRef.current?.click();
                }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                Browse Files
              </button>
              <ScanCaptureButton onCapture={(file) => processFile(file)} />
            </div>
          </div>
        )}

        {/* Uploaded file info */}
        {uploadedFile && (
          <div className="space-y-4">
            {/* File chip */}
            <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
              <span className="inline-flex items-center justify-center rounded bg-primary-100 text-primary-700 px-2 py-1 text-xs font-bold tracking-wide">
                {fileIcon(uploadedFile.name)}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-800 truncate">{uploadedFile.name}</p>
                <p className="text-xs text-slate-500">{formatBytes(uploadedFile.size)}</p>
              </div>

              {isParsing && (
                <span className="inline-flex items-center gap-1.5 text-sm text-primary-600 font-medium">
                  <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Parsing...
                </span>
              )}

              {!isParsing && parseResult && (
                <span className="inline-flex items-center gap-1 text-sm text-emerald-600 font-medium">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Parsed
                </span>
              )}

              {!isParsing && !parseResult && uploadedFile && (
                <span className="text-sm text-red-500 font-medium">Parse failed</span>
              )}

              <button
                type="button"
                onClick={handleClearUpload}
                className="ml-2 rounded p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                title="Remove file"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* ====== EXTRACTION DEBUG (Gemini /extract/ responses) ====== */}
            {parseResult && isGeminiExtractionPayload(parseResult) && (
              <details className="mt-3 rounded-lg border border-slate-200 bg-slate-50 text-xs">
                <summary className="cursor-pointer select-none px-3 py-2 font-medium text-slate-700 hover:bg-slate-100">
                  Extraction diagnostics ({parseResult.model_used || 'gemini'} · status: {parseResult.extraction_status || 'unknown'})
                </summary>
                <div className="px-3 py-2 space-y-2 font-mono">
                  <div>
                    <span className="text-slate-500">model_used:</span>{' '}
                    <span className="text-slate-800">{parseResult.model_used || '—'}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">extraction_status:</span>{' '}
                    <span className="text-slate-800">{parseResult.extraction_status || '—'}</span>
                  </div>
                  {parseResult.missing_fields?.length > 0 && (
                    <div>
                      <span className="text-slate-500">missing_fields:</span>{' '}
                      <span className="text-red-600">{parseResult.missing_fields.join(', ')}</span>
                    </div>
                  )}
                  {(parseResult.attempts || []).map((a, i) => (
                    <div key={i} className="border-t border-slate-200 pt-2 mt-2">
                      <div className="text-slate-700 font-semibold">Attempt #{i + 1} · {a.model}</div>
                      <div><span className="text-slate-500">status:</span> {a.status}</div>
                      {a.upload_path && <div><span className="text-slate-500">upload_path:</span> {a.upload_path}</div>}
                      {a.local_text_chars != null && (
                        <div><span className="text-slate-500">local_text_chars:</span> {a.local_text_chars}</div>
                      )}
                      {a.local_text_preview && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-slate-600">local_text_preview ({a.local_text_chars} chars)</summary>
                          <pre className="mt-1 whitespace-pre-wrap bg-white border border-slate-200 rounded p-2 text-slate-700 max-h-40 overflow-auto">{a.local_text_preview}</pre>
                        </details>
                      )}
                      {a.finish_reason && <div><span className="text-slate-500">finish_reason:</span> {a.finish_reason}</div>}
                      {a.response_length != null && (
                        <div><span className="text-slate-500">response_length:</span> {a.response_length}</div>
                      )}
                      {a.response_preview && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-slate-600">response_preview ({a.response_length} chars)</summary>
                          <pre className="mt-1 whitespace-pre-wrap bg-white border border-slate-200 rounded p-2 text-slate-700 max-h-40 overflow-auto">{a.response_preview}</pre>
                        </details>
                      )}
                      {a.safety && <div className="text-amber-700"><span className="text-slate-500">safety:</span> {a.safety}</div>}
                    </div>
                  ))}
                  {parseResult.warnings?.length > 0 && (
                    <div className="border-t border-slate-200 pt-2 mt-2">
                      <div className="text-slate-700 font-semibold">Warnings</div>
                      <ul className="list-disc list-inside text-slate-700">
                        {parseResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              </details>
            )}

            {/* ====== ENHANCED EXTRACTED DATA PREVIEW ====== */}
            {parseResult && extracted && (
              <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
                {/* Header with overall confidence */}
                <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-slate-700">Extracted Data Preview</h4>
                  {confidence !== null && (
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium ${confidenceColor(confidence)}`}>
                        <span className={`inline-block h-2 w-2 rounded-full ${confidenceDot(confidence)}`} />
                        {confidence}%
                      </span>
                      {/* Mini progress bar */}
                      <div className="w-16 h-2 bg-slate-200 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${confidence >= 80 ? 'bg-emerald-500' : confidence >= 60 ? 'bg-amber-500' : 'bg-red-500'}`}
                          style={{ width: `${Math.min(confidence, 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Field-by-field confidence list */}
                {previewFields.length > 0 && (
                  <div className="divide-y divide-slate-100">
                    {previewFields.map((field) => {
                      const icon = field.confidencePct !== null ? fieldConfidenceIcon(field.confidencePct) : null;
                      return (
                        <div key={field.key} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 transition-colors">
                          {/* Status icon */}
                          {icon ? (
                            <span className={`text-base leading-none w-5 text-center ${icon.color}`}>{icon.symbol}</span>
                          ) : (
                            <span className="text-base leading-none w-5 text-center text-slate-400">-</span>
                          )}
                          {/* Label */}
                          <span className="text-sm text-slate-600 w-36 flex-shrink-0">{field.label}</span>
                          {/* Value */}
                          <span className="text-sm font-medium text-slate-800 flex-1 truncate flex items-center gap-1">
                            {String(field.value)}
                            {field.source && <SourceTooltip text={field.source} />}
                          </span>
                          {/* Confidence badge */}
                          {field.confidencePct !== null && (
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium flex-shrink-0 ${fieldConfidenceBg(field.confidencePct)}`}>
                              <span className={`inline-block h-1.5 w-1.5 rounded-full ${fieldConfidenceDotColor(field.confidencePct)}`} />
                              {field.confidencePct}%
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Extracted line items preview */}
                {extractedItems.length > 0 && (
                  <div className="border-t border-slate-200">
                    <div className="px-4 py-3 bg-slate-50 border-b border-slate-200">
                      <h4 className="text-sm font-semibold text-slate-700">
                        Line Items Found
                        <span className="ml-2 inline-flex items-center rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600">
                          {extractedItems.length}
                        </span>
                      </h4>
                    </div>                    <div className="overflow-x-auto ios-scroll">
                      <table className="min-w-full divide-y divide-slate-200 text-sm">
                        <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40">
                          <tr>
                            <th className="px-4 py-2 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide">#</th>
                            <th className="px-4 py-2 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide">Product</th>
                            <th className="px-4 py-2 text-right text-xs font-semibold text-slate-600 uppercase tracking-wide">Qty</th>
                            <th className="px-4 py-2 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide">UOM</th>
                            <th className="px-4 py-2 text-right text-xs font-semibold text-slate-600 uppercase tracking-wide">Unit Price</th>
                            <th className="px-4 py-2 text-right text-xs font-semibold text-slate-600 uppercase tracking-wide">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {extractedItems.map((item, idx) => {
                            const pName = extractLineField(item.product_name).value || extractLineField(item.description).value || extractLineField(item.name).value || '-';
                            const sku = extractLineField(item.sku_code).value;
                            const qty = extractLineField(item.quantity).value ?? extractLineField(item.qty).value ?? '-';
                            const uom = extractLineField(item.uom).value || extractLineField(item.unit).value || '-';
                            const price = extractLineField(item.unit_price).value ?? extractLineField(item.rate).value ?? '-';
                            const amount = extractLineField(item.amount).value ?? extractLineField(item.total).value ?? '-';
                            return (
                              <tr key={idx} className="hover:bg-primary-50/40 transition-colors">
                                <td className="px-4 py-2 text-slate-500">{extractLineField(item.line_no).value || idx + 1}</td>
                                <td className="px-4 py-2 text-slate-800 font-medium">
                                  {pName}
                                  {sku && <span className="ml-2 text-xs text-slate-400">({sku})</span>}
                                </td>
                                <td className="px-4 py-2 text-right text-slate-700">{qty}</td>
                                <td className="px-4 py-2 text-slate-700">{uom}</td>
                                <td className="px-4 py-2 text-right text-slate-700">{price}</td>
                                <td className="px-4 py-2 text-right text-slate-700 font-medium">{amount}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Action buttons */}
                <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex items-center gap-3 flex-wrap">
                  <button
                    type="button"
                    onClick={() => handleAutoFill('high')}
                    className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 transition-colors"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Auto-fill High Confidence
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAutoFill('all')}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-primary-700 transition-colors"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                    Auto-fill All
                  </button>
                  <button
                    type="button"
                    onClick={handleClearUpload}
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>}

      {/* ====== EXISTING FORM ====== */}
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-3 sm:space-y-6">
          <div>
            <div className="flex items-center justify-between gap-3 mb-3 sm:mb-4 pb-2 border-b">
              <h3 className="text-base sm:text-lg font-semibold text-slate-800">Quote Details</h3>
              {formData.rfq && invitedVendorIds && invitedVendorIds.size > 0 && (
                <span className={`shrink-0 inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full ${respondedVendorIds.size >= invitedVendorIds.size ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                  {respondedVendorIds.size} of {invitedVendorIds.size} vendor responses recorded
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {!isHidden('rfq') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center">
                  RFQ <span className="text-red-500 ml-0.5">*</span>
                  <AutoFillDot confidence={autoFilledFields.rfq} />
                  {fieldSources.rfq && <SourceTooltip text={fieldSources.rfq} />}
                </label>
                {rfqFromUrl && formData.rfq ? (
                  <input type="text" readOnly value={prefillRfqNo || rfqRaw.find(r => r.id === formData.rfq)?.rfq_no || 'Loading...'} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-slate-50 cursor-not-allowed" />
                ) : (
                  <CustomSelect name="rfq" value={formData.rfq} onChange={handleRfqChange} required disabled={isReadOnly('rfq')} className={isReadOnly('rfq') ? lockedInputClass : inputClass}>
                    <option value="">Select RFQ</option>
                    {(() => {
                      const opts = isEditMode ? rfqOptions : filteredRfqOptions;
                      if (editRfqOption && !opts.find(o => o.value === editRfqOption.value)) {
                        return [editRfqOption, ...opts].map(o => <option key={o.value} value={o.value}>{o.label}</option>);
                      }
                      return opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>);
                    })()}
                  </CustomSelect>
                )}
              </div>
              )}
              {!isHidden('vendor') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center">
                  Vendor <span className="text-red-500 ml-0.5">*</span>
                  <AutoFillDot confidence={autoFilledFields.vendor} />
                  {fieldSources.vendor && <SourceTooltip text={fieldSources.vendor} />}
                </label>
                <CustomSelect
                  name="vendor"
                  value={formData.vendor}
                  onChange={handleChange}
                  required
                  disabled={isReadOnly('vendor') || !formData.rfq || vendorDropdownLoading}
                  className={isReadOnly('vendor') ? lockedInputClass : "w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:bg-slate-100 disabled:cursor-not-allowed"}
                >
                  <option value="">
                    {!formData.rfq
                      ? 'Select RFQ first...'
                      : vendorDropdownLoading
                        ? 'Loading invited vendors...'
                        : vendorDropdownEmptyInvited
                          ? 'No vendors invited on this RFQ'
                          : vendorDropdownExhausted
                            ? 'All invited vendors have responded'
                            : 'Select Vendor'}
                  </option>
                  {vendorDropdownOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('quote_date') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center">
                  Quote Date <span className="text-red-500 ml-0.5">*</span>
                  <AutoFillDot confidence={autoFilledFields.quote_date} />
                  {fieldSources.quote_date && <SourceTooltip text={fieldSources.quote_date} />}
                </label>
                <CustomDatePicker name="quote_date" value={formData.quote_date} onChange={handleChange} required disabled={isReadOnly('quote_date')} className={isReadOnly('quote_date') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('price_valid_till') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center">
                  Price Valid Till
                  <AutoFillDot confidence={autoFilledFields.price_valid_till} />
                  {fieldSources.price_valid_till && <SourceTooltip text={fieldSources.price_valid_till} />}
                </label>
                <CustomDatePicker name="price_valid_till" value={formData.price_valid_till} onChange={handleChange} disabled={isReadOnly('price_valid_till')} className={isReadOnly('price_valid_till') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('currency') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center">
                  Currency <span className="text-red-500 ml-0.5">*</span>
                  <AutoFillDot confidence={autoFilledFields.currency} />
                  {fieldSources.currency && <SourceTooltip text={fieldSources.currency} />}
                </label>
                <CustomSelect name="currency" value={formData.currency} onChange={handleChange} required disabled={isReadOnly('currency')} className={isReadOnly('currency') ? lockedInputClass : inputClass}>
                  <option value="">Select Currency</option>
                  <option value="INR">INR</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </CustomSelect>
              </div>
              )}
              {!isHidden('payment_terms') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center">
                  Payment Terms <span className="text-red-500 ml-0.5">*</span>
                  <AutoFillDot confidence={autoFilledFields.payment_terms} />
                  {fieldSources.payment_terms && <SourceTooltip text={fieldSources.payment_terms} />}
                </label>
                <CustomSelect name="payment_terms" value={formData.payment_terms} onChange={handleChange} disabled={isReadOnly('payment_terms')} className={isReadOnly('payment_terms') ? lockedInputClass : inputClass}>
                  <option value="">Select Payment Terms</option>
                  <option value="NET_15">Net 15</option>
                  <option value="NET_30">Net 30</option>
                  <option value="CUSTOM">Custom</option>
                </CustomSelect>
                {formData.payment_terms === 'CUSTOM' && (
                  <textarea
                    name="custom_payment_terms"
                    value={formData.custom_payment_terms}
                    onChange={handleChange}
                    rows={2}
                    required
                    disabled={isReadOnly('payment_terms')}
                    placeholder="Enter custom payment terms (e.g. 50% advance, 50% on delivery)"
                    className={isReadOnly('payment_terms') ? `mt-2 ${lockedInputClass}` : "mt-2 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"}
                  />
                )}
              </div>
              )}
            </div>
          </div>
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Additional Information</h3>
            <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
              {!isHidden('delivery_terms') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center">
                  Delivery Terms
                  <AutoFillDot confidence={autoFilledFields.delivery_terms} />
                  {fieldSources.delivery_terms && <SourceTooltip text={fieldSources.delivery_terms} />}
                </label>
                <textarea name="delivery_terms" value={formData.delivery_terms} onChange={handleChange} rows={3} disabled={isReadOnly('delivery_terms')} className={isReadOnly('delivery_terms') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('remarks') && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1 flex items-center">
                  Remarks
                  <AutoFillDot confidence={autoFilledFields.remarks} />
                  {fieldSources.remarks && <SourceTooltip text={fieldSources.remarks} />}
                </label>
                <textarea name="remarks" value={formData.remarks} onChange={handleChange} rows={3} disabled={isReadOnly('remarks')} className={isReadOnly('remarks') ? lockedInputClass : inputClass} />
              </div>
              )}
            </div>
          </div>
          {/* Line Items */}
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b">
              <h3 className="text-lg font-semibold text-slate-800">Line Items</h3>
              <div className="flex items-center gap-2">
                {lineItems.some(l => l._unresolved) && (
                  <button
                    type="button"
                    onClick={() => {
                      // Rebuild mismatch rows from current unresolved lines, so the
                      // user can re-open the modal even after dismissing it.
                      const rows = lineItems
                        .map((l, idx) => ({ l, idx }))
                        .filter(({ l }) => l._unresolved)
                        .map(({ l, idx }) => {
                          // Find best fuzzy candidate against the current RFQ products.
                          // Default to first product so we always show *some*
                          // suggestion when the RFQ has products.
                          let bestRfq = rfqProducts.length ? rfqProducts[0] : null;
                          let bestScore = 0;
                          for (const p of rfqProducts) {
                            const s = Math.max(
                              diceSimilarity(l._extractedName || '', p.product_name || ''),
                              l._extractedCode && p.sku_code ? diceSimilarity(l._extractedCode, p.sku_code) : 0,
                            );
                            if (s > bestScore) { bestScore = s; bestRfq = p; }
                          }
                          return {
                            idx,
                            extracted_name: l._extractedName || l.description || '(no name extracted)',
                            extracted_code: l._extractedCode || '',
                            extracted_qty: l.quantity != null ? String(l.quantity) : '',
                            extracted_uom: l.uom || '',
                            extracted_rate: l.unit_price != null ? String(l.unit_price) : '',
                            suggested_product: bestRfq ? {
                              product: bestRfq.product,
                              product_name: bestRfq.product_name,
                              sku_code: bestRfq.sku_code,
                            } : null,
                            suggested_score: bestRfq ? bestScore : null,
                            all_rfq_products: rfqProducts,
                          };
                        });
                      if (rows.length === 0) {
                        toast('No unresolved lines.', { icon: 'ℹ️' });
                        return;
                      }
                      setMismatchRows(rows);
                      setMismatchOpen(true);
                    }}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-red-700 border border-red-300 bg-red-50 rounded-lg hover:bg-red-100"
                  >
                    Resolve {lineItems.filter(l => l._unresolved).length} mismatch{lineItems.filter(l => l._unresolved).length > 1 ? 'es' : ''}
                  </button>
                )}
                <button type="button" onClick={addLine} className="flex items-center gap-1 px-3 py-1.5 text-sm text-primary-600 border border-primary-300 rounded-lg hover:bg-primary-50">
                  + Add Item
                </button>
              </div>
            </div>            <div className="overflow-x-auto ios-scroll">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                    <th className="text-left px-3 py-2 font-medium text-slate-600 w-10">#</th>
                    {!isLineHidden('product_service') && <th className="text-left px-3 py-2 font-medium text-slate-600">Product</th>}
                    {!isLineHidden('quantity_offered') && <th className="text-left px-3 py-2 font-medium text-slate-600 w-24">Quantity <span className="text-red-500">*</span></th>}
                    {!isLineHidden('uom') && <th className="text-left px-3 py-2 font-medium text-slate-600 w-20">UOM</th>}
                    {!isLineHidden('unit_price') && <th className="text-left px-3 py-2 font-medium text-slate-600 w-28">Unit Price <span className="text-red-500">*</span></th>}
                    {!isLineHidden('gst') && <th className="text-left px-3 py-2 font-medium text-slate-600 w-20">GST %</th>}
                    {!isLineHidden('specification') && <th className="text-left px-3 py-2 font-medium text-slate-600">Description</th>}
                    <th className="text-right px-3 py-2 font-medium text-slate-600 w-28">Total Amount</th>
                    <th className="text-center px-3 py-2 font-medium text-slate-600 w-16">Status</th>
                    <th className="text-center px-3 py-2 font-medium text-slate-600 w-12">Del</th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((item, idx) => {
                    const packing = isPackingLine(item);
                    const expanded = packing && isLineExpanded(item, idx);
                    return (
                    <Fragment key={idx}>
                    <tr className="border-b border-slate-100">
                      <td className="px-3 py-2 text-slate-500">
                        {packing ? (
                          <div className="flex items-center gap-1">
                            <button type="button" onClick={() => toggleLine(idx)} title={expanded ? 'Hide dimensions' : 'Add dimensions (packing material)'} className="p-0.5 rounded hover:bg-slate-200 text-slate-400">
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`transition-transform ${expanded ? 'rotate-180' : ''}`}><path d="m6 9 6 6 6-6"/></svg>
                            </button>
                            <span>{idx + 1}</span>
                            {!expanded && lineHasDims(item) && <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary-500" title="Has dimensions" />}
                          </div>
                        ) : (idx + 1)}
                      </td>
                      {!isLineHidden('product_service') && (
                      <td className="px-3 py-2">
                        {/* Encoded "<TYPE>:<ID>" so the change handler
                            stores both item_type and the picked id in
                            a single setState. Items are grouped by
                            type (Products / Machinery / Services) so
                            users can scan each source separately. */}
                        <CustomSelect
                          value={item.product ? `${(item.item_type || 'PRODUCT').toUpperCase()}:${item.product}` : ''}
                          disabled={isLineRO('product_service')}
                          onChange={e => {
                            const v = e.target.value;
                            if (!v) {
                              handleLineChange(idx, 'product', '');
                              return;
                            }
                            const ci = v.indexOf(':');
                            const type = ci >= 0 ? v.slice(0, ci) : 'PRODUCT';
                            const id = ci >= 0 ? v.slice(ci + 1) : v;
                            setLineItems(prev => prev.map((row, ri) => ri === idx ? {
                              ...row,
                              item_type: type,
                              product: id,
                            } : row));
                          }}
                          className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm"
                        >
                          <option value="">Select Item...</option>
                          {['PRODUCT', 'MACHINERY', 'SERVICE'].map(type => {
                            const items = (purchaseItems || []).filter(it => it.item_type === type);
                            if (items.length === 0) return null;
                            const groupLabel = type === 'PRODUCT' ? 'Products' : type === 'MACHINERY' ? 'Machinery' : 'Services';
                            return (
                              <optgroup key={type} label={groupLabel}>
                                {items
                                  .slice()
                                  .sort((a, b) => (a.item_name || '').localeCompare(b.item_name || ''))
                                  .map(it => (
                                    <option key={`${it.item_type}:${it.item_id}`} value={`${it.item_type}:${it.item_id}`}>
                                      {it.label || it.item_name}
                                    </option>
                                  ))}
                              </optgroup>
                            );
                          })}
                        </CustomSelect>
                      </td>
                      )}
                      {!isLineHidden('quantity_offered') && (
                      <td className="px-3 py-2">
                        <input type="number" min="0.01" step="any" required value={item.quantity} onChange={e => handleLineChange(idx, 'quantity', e.target.value)} disabled={isLineRO('quantity_offered')} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
                        {/* UI-only hint when the offered qty drifts from the PR's
                            requested qty — vendors may legitimately quote a
                            different lot, so this never blocks anything. */}
                        {qtyDiffersFromRequested(item) && (
                          <div className="text-[10px] text-amber-600 mt-0.5">PR asked {item._requested_qty}</div>
                        )}
                      </td>
                      )}
                      {!isLineHidden('uom') && (
                      <td className="px-3 py-2">
                        <CustomSelect value={item.uom} onChange={e => handleLineChange(idx, 'uom', e.target.value)} disabled={isLineRO('uom')} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm">
                          {item.uom && !UOM_VALUES.includes(item.uom) && (
                            <option value={item.uom}>{item.uom}</option>
                          )}
                          {UOM_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </CustomSelect>
                      </td>
                      )}
                      {!isLineHidden('unit_price') && (
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          <div className={`flex items-center border border-slate-300 rounded focus-within:ring-2 focus-within:ring-primary-500 ${isLineRO('unit_price') ? 'bg-slate-50' : 'bg-white'}`}>
                            <span className="pl-2 text-slate-400 text-sm select-none">₹</span>
                            <input type="number" min="0.01" step="any" required value={item.unit_price} onChange={e => handleLineChange(idx, 'unit_price', e.target.value)} disabled={isLineRO('unit_price')} placeholder="0.00" className="w-24 px-1.5 py-1.5 text-sm text-right bg-transparent border-0 focus:outline-none focus:ring-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
                          </div>
                          <PreviousRates vendor={formData.vendor} product={item.product} />
                        </div>
                      </td>
                      )}
                      {!isLineHidden('gst') && (() => {
                        // GST is locked to the product master when configured.
                        // The DISPLAYED value is the master rate regardless of
                        // how the line was built (manual pick, AI extraction,
                        // RFQ seed) — so an extracted/blank doc GST can never
                        // override the product's true rate.
                        const masterGst = productMasterGst(item.product);
                        const gstLocked = masterGst !== null;
                        const gstValue = gstLocked ? String(masterGst) : item.gst;
                        return (
                      <td className="px-3 py-2">
                        <div className={`flex items-center border border-slate-300 rounded focus-within:ring-2 focus-within:ring-primary-500 ${(isLineRO('gst') || gstLocked) ? 'bg-slate-50' : 'bg-white'}`}>
                          <input type="number" min="0" max="100" step="0.01" value={gstValue} onChange={e => handleLineChange(idx, 'gst', e.target.value)} disabled={isLineRO('gst') || gstLocked} title={gstLocked ? 'GST is set on the product master and is the same for every vendor' : undefined} placeholder="18" className="w-14 px-1.5 py-1.5 text-sm text-right bg-transparent border-0 focus:outline-none focus:ring-0 disabled:cursor-not-allowed [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
                          <span className="pr-2 text-slate-400 text-sm select-none">%</span>
                        </div>
                      </td>
                        );
                      })()}
                      {!isLineHidden('specification') && (
                      <td className="px-3 py-2">
                        <input type="text" value={item.description} onChange={e => handleLineChange(idx, 'description', e.target.value)} disabled={isLineRO('specification')} placeholder="Specification / remarks" className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" style={{ minWidth: '160px' }} />
                      </td>
                      )}
                      <td className="px-3 py-2 text-right">
                        <span className="font-semibold text-slate-800">
                          {(Number(item.quantity || 0) * Number(item.unit_price || 0)) > 0
                            ? formatCurrency(Number(item.quantity || 0) * Number(item.unit_price || 0))
                            : '-'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center">
                        {item._unresolved && (
                          <span className="inline-flex items-center gap-1 text-xs text-red-700 font-semibold" title={`Unresolved: "${item._extractedName || item._productName || ''}" not on this RFQ`}>
                            <span className="inline-block h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                            Unresolved
                          </span>
                        )}
                        {!item._unresolved && item._vendorProduct && (
                          <span className="inline-flex items-center gap-1 text-xs text-amber-700 font-semibold" title={`Vendor wording: "${item._extractedName || ''}" kept as-is`}>
                            <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
                            Vendor Product
                          </span>
                        )}
                        {!item._unresolved && !item._vendorProduct && item._matched === true && (
                          (item._matchSource === 'master_sku' || item._matchSource === 'master_name') ? (
                            <span className="inline-flex items-center gap-1 text-xs text-blue-700 font-medium" title={`Matched from product master (not on RFQ): ${item._productName || ''}`}>
                              <span className="inline-block h-2 w-2 rounded-full bg-blue-500" />
                              Matched (not on RFQ)
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 font-medium" title={`Matched (${item._matchSource || 'exact'}): ${item._productName || ''}`}>
                              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                              {item._matchSource === 'fuzzy' && item._fuzzyScore != null
                                ? `Fuzzy ${Math.round(item._fuzzyScore * 100)}%`
                                : item._matchSource === 'mapping'
                                ? 'Mapped'
                                : 'Matched'}
                            </span>
                          )
                        )}
                        {!item._unresolved && !item._vendorProduct && item._matched === false && (
                          <span className="inline-flex items-center gap-1 text-xs text-amber-600 font-medium" title={`No match found for: ${item._productName || ''}`}>
                            <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
                            Unmatched
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button type="button" onClick={() => removeLine(idx)} disabled={lineItems.length <= 1} className="p-1 text-red-500 hover:bg-red-50 rounded disabled:opacity-30">
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                        </button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="bg-slate-50/60 border-b border-slate-100">
                        <td className="px-2"></td>
                        <td colSpan={11} className="px-3 pb-3 pt-1">
                          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                            {[['length', 'Length'], ['width', 'Width'], ['breadth', 'Breadth'], ['height', 'Height']].map(([f, lbl]) => (
                              <div key={f} className="flex flex-col">
                                <label className="text-[11px] uppercase tracking-wide text-slate-500 mb-0.5">{lbl}</label>
                                <input type="number" min="0" step="any" value={item[f] || ''} onChange={e => handleLineChange(idx, f, e.target.value)} placeholder="0" className="w-24 px-2 py-1.5 border border-slate-300 rounded text-sm" />
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pricing Summary */}
          {lineItems.some(item => Number(item.quantity || 0) > 0 && Number(item.unit_price || 0) > 0) && (() => {
            const subtotal = lineItems.reduce((sum, item) => sum + (Number(item.quantity || 0) * Number(item.unit_price || 0)), 0);
            const totalGst = lineItems.reduce((sum, item) => {
              const lineTotal = Number(item.quantity || 0) * Number(item.unit_price || 0);
              // Master GST wins so the summary matches what's saved + shown.
              const gstRate = Number((productMasterGst(item.product) ?? item.gst) || 0);
              return sum + (lineTotal * gstRate / 100);
            }, 0);
            const grandTotal = subtotal + totalGst;

            return (
              <div className="flex justify-end">
                <div className="w-80 bg-slate-50 rounded-lg border border-slate-200 p-4">
                  <h4 className="text-sm font-semibold text-slate-700 mb-3 pb-2 border-b">Pricing Summary</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-slate-600">Subtotal</span>
                      <span className="font-medium">₹{subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">GST Amount</span>
                      <span className="font-medium">₹{totalGst.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between pt-2 border-t border-slate-300">
                      <span className="text-base font-bold text-slate-800">Grand Total</span>
                      <span className="text-base font-bold text-primary-700">₹{grandTotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

          <FileAttachments module="QUOTE" recordId={id || null} onPendingChange={(files) => { pendingAttachmentsRef.current = files; setPendingAttachments(files); }} />
          {/* A quote must carry its source document. Auto-fill (AI) uses the
              uploaded file as the source; a manually-filled quote must have a
              document uploaded above. Save stays disabled until one exists. */}
          {!isEditMode && uploadedFile && (
            <p className="mt-2 text-xs text-emerald-600">✓ The uploaded quote document ({uploadedFile.name}) will be attached to this quote.</p>
          )}
          {!isEditMode && !uploadedFile && pendingAttachments.length === 0 && (
            <p className="mt-2 text-xs text-amber-600">A quote document is required — upload the vendor's quotation (via AI auto-fill above or Attachments) before saving.</p>
          )}

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            {((isEditMode && canEdit('Quote')) || (!isEditMode && canCreate('Quote'))) && (
              <button
                type="submit"
                disabled={isLoading || (!isEditMode && !uploadedFile && pendingAttachments.length === 0)}
                title={(!isEditMode && !uploadedFile && pendingAttachments.length === 0) ? 'Upload the quote document first' : undefined}
                className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed">{isLoading ? 'Saving...' : (isEditMode ? 'Update' : 'Save')}</button>
            )}
          </div>
          </EditGate>
        </form>
      </div>

      <ProductMismatchModal
        open={mismatchOpen}
        mismatches={mismatchRows}
        vendorId={formData.vendor || null}
        vendorName={(vendorRaw.find(v => v.id === formData.vendor) || {}).vendor_name || ''}
        rfqProducts={rfqProducts}
        onResolve={handleMismatchResolve}
        onClose={() => setMismatchOpen(false)}
      />

      <VendorMatchConfirmModal
        open={!!vendorConfirm}
        extractedName={vendorConfirm?.extractedName}
        candidate={vendorConfirm?.candidate}
        score={vendorConfirm?.score || 0}
        onConfirm={() => {
          if (vendorConfirm?.candidate) {
            setFormData(prev => ({ ...prev, vendor: vendorConfirm.candidate.id }));
            setAutoFilledFields(prev => ({ ...prev, vendor: 1 }));
            setFieldSources(prev => ({
              ...prev,
              vendor: `Confirmed: "${vendorConfirm.extractedName}" → "${vendorConfirm.candidate.vendor_name}" (${Math.round(vendorConfirm.score * 100)}%)`,
            }));
            toast.success(`Vendor set to "${vendorConfirm.candidate.vendor_name}"`);
          }
          setVendorConfirm(null);
        }}
        onDecline={() => {
          toast(`Vendor kept as text only — pick from dropdown manually if needed.`, { icon: 'ℹ️' });
          setVendorConfirm(null);
        }}
      />
    </MainLayout>
  );
}
