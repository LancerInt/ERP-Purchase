import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { confirm } from '@/components/common/confirm';
import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2, ScanLine, Loader2, Camera, Upload, Paperclip, Mic, MicOff } from 'lucide-react';
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
import ReceiptMismatchModal from './ReceiptMismatchModal';
import { UOM_OPTIONS, UOM_VALUES } from '../../../constants/uom.js';

const inputClass = 'w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;

/* ── Combined Attachment List (bottom section) ─────────────────────────── */
const CATEGORY_LABELS = { GENERAL: 'Receipt Bill', TRANSPORT: 'Freight Bill', DAMAGE_PROOF: 'Damage Proof' };
const CATEGORY_COLORS = { GENERAL: 'bg-blue-100 text-blue-700', TRANSPORT: 'bg-emerald-100 text-emerald-700', DAMAGE_PROOF: 'bg-red-100 text-red-700' };
const PREVIEWABLE_IMAGE = new Set(['jpg', 'jpeg', 'png', 'webp']);

const AttachmentRow = memo(function AttachmentRow({ file }) {
  const [open, setOpen] = useState(false);
  const [objectUrl, setObjectUrl] = useState(null);
  const ext = (file.file_name || '').split('.').pop().toLowerCase();
  const isImage = PREVIEWABLE_IMAGE.has(ext);
  const isPdf = ext === 'pdf';
  const canPreview = isImage || isPdf;

  useEffect(() => {
    if (!open || !file.rawFile || objectUrl) return;
    const url = URL.createObjectURL(file.rawFile);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [open, file.rawFile, objectUrl]);

  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2 bg-slate-50">
        <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full whitespace-nowrap ${CATEGORY_COLORS[file.category]}`}>
          {CATEGORY_LABELS[file.category]}
        </span>
        <p className="flex-1 min-w-0 text-sm font-medium text-slate-700 truncate">{file.file_name}</p>
        {canPreview && (
          <button type="button" onClick={() => setOpen(v => !v)} className="text-xs text-primary-600 hover:underline flex-shrink-0">
            {open ? 'Hide' : 'View'}
          </button>
        )}
      </div>
      {open && objectUrl && (
        <div className="border-t border-slate-200">
          {isImage && (
            <div className="max-h-[50vh] overflow-auto bg-slate-100 flex justify-center p-2">
              <img src={objectUrl} alt={file.file_name} className="max-w-full h-auto rounded" />
            </div>
          )}
          {isPdf && (
            <iframe title={file.file_name} src={`${objectUrl}#toolbar=0&navpanes=0`} className="w-full h-[50vh] bg-slate-100" />
          )}
        </div>
      )}
    </div>
  );
});

const CombinedAttachmentList = memo(function CombinedAttachmentList({ generalFiles, transportFiles, damageFiles = [] }) {
  const allFiles = useMemo(() => [
    ...generalFiles.map((f, i) => ({ id: `gen-${i}`, file_name: f.name, category: 'GENERAL', rawFile: f })),
    ...transportFiles.map((f, i) => ({ id: `trn-${i}`, file_name: f.name, category: 'TRANSPORT', rawFile: f })),
    ...damageFiles.map((f, i) => ({ id: `dmg-${i}`, file_name: f.name, category: 'DAMAGE_PROOF', rawFile: f })),
  ], [generalFiles, transportFiles, damageFiles]);

  if (allFiles.length === 0) {
    return <p className="text-xs text-slate-400 text-center py-4">No attachments yet</p>;
  }

  return (
    <div className="space-y-2">
      {allFiles.map(file => <AttachmentRow key={file.id} file={file} />)}
    </div>
  );
});

/* ── Fuzzy match — Dice coefficient on character bigrams ─────────────── */
function _bigrams(s) {
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
  const A = _bigrams(a);
  const B = _bigrams(b);
  let common = 0, total = 0;
  A.forEach((cnt, bg) => { total += cnt; if (B.has(bg)) common += Math.min(cnt, B.get(bg)); });
  B.forEach((cnt) => { total += cnt; });
  return total === 0 ? 0 : (2 * common) / total;
}
// Tiers per user spec:
//   ≥ 0.50  → silent auto-fill (best fuzzy candidate wins)
//   0.25–0.50 → show suggestion pills inline; user clicks to apply
//   < 0.25  → no match, user picks manually
// Threshold above which we silently auto-fill a Goods receipt line from
// the closest PO / master product. Anything below this routes through
// the ReceiptMismatchModal so the user can confirm or pick a different
// match.
//
// Was 0.50 — that was too permissive: vendor invoices often produce
// dice-similarity scores in the 0.55–0.75 range against a *different*
// product (e.g. "Iron Bar 10mm" vs "Iron Bar 12mm") and the form
// silently picked the wrong one without surfacing the choice. Raised to
// 0.85 to match the Quote Response flow's threshold so weak matches now
// route to the popup for explicit confirmation.
const FUZZY_AUTOFILL = 0.85;
const FUZZY_SUGGEST  = 0.25;

// A PO is fully received once every line's received quantity meets or
// exceeds its ordered quantity — there's nothing left to receive against
// it, so the receipt form should refuse to open it.
const isPoFullyReceived = (po) => {
  const lines = po?.po_lines || [];
  if (lines.length === 0) return false;
  return lines.every((pl) => {
    const ordered = parseFloat(pl.quantity_ordered) || 0;
    const received = parseFloat(pl.received_quantity) || 0;
    return ordered - received <= 0.0001;
  });
};

// Compute per-line quantity flags for the operator: (a) PO over-delivery
// when Invoice Qty > PO pending qty (vendor invoiced more than PO
// ordered), and (b) Physical mismatch when Received Qty ≠ Invoice Qty
// (physical count differs from what the vendor invoiced). Both surface
// via the header banner + a save-time confirmation dialog so operators
// consciously accept the deviation instead of it passing silently.
function getReceiptLineFlag(line) {
  if (!line?.product) return null;
  const poQty = parseFloat(line.po_quantity) || 0;
  const alreadyRcvd = parseFloat(line.already_received) || 0;
  const invoiceQty = parseFloat(line.quantity_received) || 0;
  const netQty = parseFloat(line.net_quantity) || 0;
  const sameUom = !line.po_uom || !line.uom
    || (line.po_uom || '').trim().toUpperCase() === (line.uom || '').trim().toUpperCase();

  let overBy = 0;
  if (sameUom && poQty > 0) {
    const pending = poQty - alreadyRcvd;
    if (invoiceQty > pending) overBy = Math.round((invoiceQty - pending) * 100) / 100;
  }
  // Only meaningful once BOTH qtys are entered — before then the
  // "0 vs typed" difference is just a stub, not a real mismatch.
  const mismatchBy = (invoiceQty > 0 && netQty > 0 && invoiceQty !== netQty)
    ? Math.round((invoiceQty - netQty) * 100) / 100
    : 0;

  if (!overBy && !mismatchBy) return null;
  return { overBy, mismatchBy, uom: line.uom || line.po_uom || '' };
}

// FIFO enforcement across POs of the same vendor — PER PRODUCT.
// Walks `allPos` for OLDER POs of the same vendor with pending qty on
// products the candidate PO also carries, and returns a map:
//     { [productId]: { po_no, pending, uom, product_name } }
// An empty map = the pick is fully legal. A non-empty map means those
// PRODUCTS must be received from the older PO first — but the candidate
// PO's OTHER lines are still receivable: the caller seeds only the
// unblocked lines instead of rejecting the whole PO. (The old whole-PO
// veto blocked receiving "Container 1 Ltr" on a new PO just because the
// same vendor's older PO had "Container 500 ML" pending — a different
// product line that merely shared the PO.)
//
// `pickedPoIds` (optional): POs already part of the CURRENT receipt
// (primary + additional). An older PO that is itself being received on
// this form is NOT a blocker — its pending is being settled right here.
// Mirrors the backend rule (ReceiptAdviceSerializer.validate: the oldest
// pending PO for each RECEIVED product must be IN linked_pos).
const findFifoBlockedProducts = (candidatePo, allPos, pickedPoIds = []) => {
  const blocked = {};
  if (!candidatePo?.po_lines?.length) return blocked;
  const vendorId = candidatePo.vendor;
  const candidateDate = candidatePo.po_date || candidatePo.created_at || '';
  // Product ids on the candidate PO with pending qty > 0 — only these
  // are subject to FIFO (fully-received lines don't matter).
  const candidateProductIds = new Set();
  for (const pl of candidatePo.po_lines) {
    const pending = (parseFloat(pl.quantity_ordered) || 0) - (parseFloat(pl.received_quantity) || 0);
    if (pending > 0.0001 && pl.product_service) candidateProductIds.add(pl.product_service);
  }
  if (candidateProductIds.size === 0) return blocked;

  for (const po of allPos) {
    if (!po || po.id === candidatePo.id) continue;
    if (pickedPoIds.includes(po.id)) continue;
    if (po.vendor !== vendorId) continue;
    if (['CLOSED', 'CANCELLED', 'DRAFT', 'SPLIT'].includes(po.status)) continue;
    const otherDate = po.po_date || po.created_at || '';
    if (!otherDate || otherDate >= candidateDate) continue;
    for (const pl of (po.po_lines || [])) {
      const pending = (parseFloat(pl.quantity_ordered) || 0) - (parseFloat(pl.received_quantity) || 0);
      if (pending > 0.0001 && candidateProductIds.has(pl.product_service) && !blocked[pl.product_service]) {
        blocked[pl.product_service] = {
          po_no: po.po_no || '',
          product_name: pl.item_name || pl.product_name || 'this product',
          pending,
          uom: pl.uom || '',
        };
      }
    }
  }
  return blocked;
};

// Split a PO's lines by the FIFO block map: `receivable` seeds the
// receipt; `blockedPending` is reported (or, when it covers every
// pending line, blocks the pick entirely).
const partitionByFifo = (poLines, blockedByProduct) => {
  const pendingOf = (pl) =>
    (parseFloat(pl.quantity_ordered) || 0) - (parseFloat(pl.received_quantity) || 0);
  const pendingLines = (poLines || []).filter((pl) => pendingOf(pl) > 0.0001);
  const blockedPending = pendingLines.filter(
    (pl) => pl.product_service && blockedByProduct[pl.product_service],
  );
  const receivable = (poLines || []).filter(
    (pl) => !(pl.product_service && blockedByProduct[pl.product_service]),
  );
  return { pendingLines, blockedPending, receivable };
};

const emptyReceiptLine = {
  product: '',
  po_line: '',
  quantity_received: '',
  net_quantity: '',
  batch_no: '',
  uom: '',
  godown_location: '',
  remarks: '',
  is_debit_note: false,
  // Direct Receipt fields (no PO upstream → user enters rate + GST here so
  // the Bill page can prefill instead of asking again).
  rate: '',
  gst_percentage: '',
  // Optional physical dimensions captured at receipt time. All four
  // are nullable on the backend — left blank when the receipt isn't
  // for items where size/weight matters per line.
  length: '',
  breadth: '',
  width: '',
  weight: '',
};

// Reasons a receipt can be created without a PO. Picked here to make sure
// the front-end choices stay in lockstep with the backend choices on the
// ReceiptAdvice model (DIRECT_REASON_CHOICES).
const DIRECT_REASON_CHOICES = [
  { value: 'EMERGENCY',           label: 'Emergency Purchase' },
  { value: 'FREE_SAMPLE',         label: 'Free Sample' },
  { value: 'REPLACEMENT',         label: 'Replacement / Warranty' },
  { value: 'OPENING_STOCK',       label: 'Opening Stock' },
  { value: 'RETURN_FROM_JOBWORK', label: 'Returned from Job Work' },
  { value: 'GIFT',                label: 'Gift / Donation' },
  { value: 'OTHER',               label: 'Other' },
];

const emptyPackingLine = {
  packaging_sku: '',
  po_line: '',
  quantity: '',          // Invoice Quantity (what vendor invoiced)
  net_quantity: '',      // Received Quantity (what was accepted)
  uom: 'PCS',
  length: '',
  breadth: '',
  width: '',
  weight: '',
  batch_no: '',
  godown_location: '',
  remarks: '',
  condition: 'NEW',
  _damageFiles: [],
};

// Translate a PO's freight_terms value into the value the Receipt
// form's dropdown can render. PO supports PAID / TO_PAY / MIXED, the
// Receipt only PAID / TO_PAY (matches ReceiptAdvice.FREIGHT_TERMS_CHOICES
// on the model). For MIXED — which means individual line items each
// have their own setting — we deliberately return '' so the operator
// picks one explicitly on the Receipt instead of getting a value the
// dropdown can't display.
function receiptFreightTermsFromPO(poFreightTerms) {
  const v = (poFreightTerms || '').toString().trim().toUpperCase();
  if (v === 'PAID' || v === 'TO_PAY') return v;
  return '';
}

// PO-line → Receipt-section routing.
//
// A PR line typed with category=PACKING_MATERIAL must land in the
// Receipt's Packing Materials subform, NOT in Receipt Line Items —
// packing material moves separately on the goods receipt (different
// stock ledger, no per-line QC/batch tracking, different downstream
// consumption flow).
//
// We get the category off `pl.pr_line_category` (POLineSerializer
// exposes `linked_pr_line.category` under that key). Older receipts
// created before this serializer field existed will have all lines
// fall through to Receipt Line Items, which matches their prior
// behaviour — backward-compatible.
function isPackingMaterialPoLine(pl, productRaw = null) {
  // Primary: category resolved by POLineSerializer (PO override → PR
  // chain → RFQ-chain match). Set in the normal path.
  const cat = (pl?.pr_line_category || pl?.category || '').toString().trim().toUpperCase();
  if (cat === 'PACKING_MATERIAL') return true;
  // Fallback for legacy POs where the resolver returned nothing — look
  // up the product master and check goods_sub_type. This rescues old
  // POs whose linked_pr_line is null and whose RFQ chain doesn't
  // match. Requires productRaw to be passed in by the caller.
  if (Array.isArray(productRaw)) {
    const productId = pl?.product_service || pl?.product;
    if (productId) {
      const row = productRaw.find(p => p.id === productId);
      const sub = (row?.goods_sub_type || '').toString().trim().toUpperCase();
      if (sub === 'PACKING_MATERIAL') return true;
    }
  }
  return false;
}

// Map a PO line whose PR category was PACKING_MATERIAL into the
// Packing Materials row shape. quantity defaults to the PO-ordered
// figure so the row is usable on save without an extra click — the
// operator edits it down only when fewer units actually arrived.
// (Goods lines on the same form leave quantity_received blank because
// they show PO Qty / Rcvd / Balance columns alongside; the Packing
// Materials table doesn't have those companion columns, so a blank
// cell here just creates an extra step.)
function poLineToPackingRow(pl) {
  const orderedQty = pl.quantity_ordered;
  // Prefill Invoice Quantity with pending qty (ordered − already
  // received). Same rule as the Goods-lines seed — operator can just
  // confirm-and-save when the invoice matches; overrides on short.
  // received_quantity now sums BOTH ReceiptLine and PackingMaterialLine
  // (see POLineSerializer.get_received_quantity), so this is honest.
  const orderedNum = parseFloat(orderedQty) || 0;
  const rcvdNum = parseFloat(pl.received_quantity) || 0;
  const pending = Math.max(0, orderedNum - rcvdNum);
  return {
    packaging_sku: pl.product_service || '',
    po_line: pl.id || '',
    quantity: pending > 0 ? String(pending) : '',
    net_quantity: '',
    uom: pl.uom || 'PCS',
    length: '',
    breadth: '',
    width: '',
    weight: '',
    batch_no: '',
    // Inherit godown from the linked PR (per-PO line PR godown is
    // exposed by POLineSerializer.pr_godown).
    godown_location: pl.pr_godown || '',
    remarks: '',
    condition: 'NEW',
    // Helper/display fields. Not persisted — stripped before save.
    _itemName: pl.item_name || pl.product_name || '',
    _poQuantity: orderedQty || 0,
    _alreadyReceived: pl.received_quantity || 0,
    _poUom: pl.uom || '',
  };
}

// ── UOM conversion helper ──────────────────────────────────────────────
// Used when copying a weighment Second Weight (= net weight per business
// convention) onto a receipt line's Net Quantity. We MUST NOT blindly
// copy 30110 KG into a line whose UOM is TONS — the conversion table
// here resolves common aliases and applies the right factor.
//
// Internally everything resolves to a base unit per family:
//   mass    base = KG
//   volume  base = LTR
//   count   base = PCS
// `null` means "this UOM isn't convertible with the others" — caller
// should warn the user and leave Net Quantity for manual entry.
const UOM_FAMILY = {
  // mass — base KG
  'KG': { family: 'mass', toBase: 1 },
  'KGS': { family: 'mass', toBase: 1 },
  'KILOGRAM': { family: 'mass', toBase: 1 },
  'KILOGRAMS': { family: 'mass', toBase: 1 },
  'GRAM': { family: 'mass', toBase: 0.001 },
  'GRAMS': { family: 'mass', toBase: 0.001 },
  'GM': { family: 'mass', toBase: 0.001 },
  'GMS': { family: 'mass', toBase: 0.001 },
  'G': { family: 'mass', toBase: 0.001 },
  'MG': { family: 'mass', toBase: 0.000001 },
  'TON': { family: 'mass', toBase: 1000 },
  'TONS': { family: 'mass', toBase: 1000 },
  'TONNE': { family: 'mass', toBase: 1000 },
  'TONNES': { family: 'mass', toBase: 1000 },
  'MT': { family: 'mass', toBase: 1000 },
  'MTS': { family: 'mass', toBase: 1000 },
  'METRIC TON': { family: 'mass', toBase: 1000 },
  'METRIC TONS': { family: 'mass', toBase: 1000 },
  'QUINTAL': { family: 'mass', toBase: 100 },
  'QUINTALS': { family: 'mass', toBase: 100 },
  'QTL': { family: 'mass', toBase: 100 },
  'QNTL': { family: 'mass', toBase: 100 },
  // volume — base LTR
  'LTR': { family: 'volume', toBase: 1 },
  'LITRE': { family: 'volume', toBase: 1 },
  'LITRES': { family: 'volume', toBase: 1 },
  'LITER': { family: 'volume', toBase: 1 },
  'LITERS': { family: 'volume', toBase: 1 },
  'L': { family: 'volume', toBase: 1 },
  'ML': { family: 'volume', toBase: 0.001 },
  'CUM': { family: 'volume', toBase: 1000 },
  'M3': { family: 'volume', toBase: 1000 },
  // count — base PCS
  'PCS': { family: 'count', toBase: 1 },
  'PC': { family: 'count', toBase: 1 },
  'PIECE': { family: 'count', toBase: 1 },
  'PIECES': { family: 'count', toBase: 1 },
  'NOS': { family: 'count', toBase: 1 },
  'NO': { family: 'count', toBase: 1 },
  'NUMBER': { family: 'count', toBase: 1 },
  'UNIT': { family: 'count', toBase: 1 },
  'UNITS': { family: 'count', toBase: 1 },
  'BAGS': { family: 'count', toBase: 1 },
  'BAG': { family: 'count', toBase: 1 },
  'BOX': { family: 'count', toBase: 1 },
  'PACK': { family: 'count', toBase: 1 },
};

function _normUom(u) {
  return (u || '').toString().trim().toUpperCase();
}

/**
 * Convert `value` from `fromUom` to `toUom`.
 * Returns an object: { ok, value, reason }
 *   ok=true   → conversion succeeded; `value` is the converted number
 *   ok=false  → conversion not possible; `reason` is a human-readable hint
 *               and the caller should warn + leave manual entry to the user.
 */
function convertUom(value, fromUom, toUom) {
  const v = parseFloat(value);
  if (isNaN(v)) return { ok: false, reason: 'invalid number' };
  const from = _normUom(fromUom);
  const to = _normUom(toUom);
  // Same unit OR target unknown → pass through unchanged.
  if (!from || !to || from === to) {
    return { ok: true, value: v };
  }
  const a = UOM_FAMILY[from];
  const b = UOM_FAMILY[to];
  if (!a || !b) {
    return { ok: false, reason: `unknown unit (${!a ? from : to})` };
  }
  if (a.family !== b.family) {
    return { ok: false, reason: `cannot convert ${from} (${a.family}) to ${to} (${b.family})` };
  }
  // Convert via the family's base unit.
  const inBase = v * a.toBase;
  const converted = inBase / b.toBase;
  // Round to 4 decimals — matches DecimalField(decimal_places=4) on the line.
  return { ok: true, value: Math.round(converted * 10000) / 10000 };
}

const emptyWeighmentDetail = {
  weighment_name: '',
  weighment_number: '',
  first_weight: '',
  second_weight: '',
  tare_weight: '',
  uom: 'KG',
};

const emptyFreightDetail = {
  freight_type: 'LOCAL_DRAYAGE',
  transporter: '',
  freight_terms: '',
  tentative_charge: '',
  discount: '0',
  payable_by: 'COMPANY',
  quantity_basis: '',
  quantity_uom: '',
  destination_state: '',
};

const emptyWageLine = {
  wage_type: 'UNLOADING',
  contractor_vendor: '',
  amount: '',
  tds_applicable: '0',
  payable_by: 'COMPANY',
  remarks: '',
};

export default function CreateReceiptAdvice() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Permission gate for the Debit Note button — driven by the dedicated
  // "Apply Debit" (can_apply_debit) tick on the Receipt Advice row of the
  // admin button-permission grid. Edit rights alone (which every receipt
  // creator needs) must NOT expose the Debit Note action, so this is the
  // same flag the receipt detail page gates its Debit Note button on.
  // Admins/super always pass via usePermissions' isAdmin/isSuperuser shortcut.
  const { canApplyDebit, canDirectReceipt, canCreate } = usePermissions();
  const editable = canCreate('Receipt Advice');
  const canUseDebitNote = canApplyDebit('Receipt Advice');
  // "Direct Receipt" source toggle gate — admins grant this on the Receipt
  // Advice row. Without it the user can only receive against a PO/Job Work.
  const canUseDirectReceipt = canDirectReceipt('Receipt Advice');
  // Field-level permissions (VIEW / READ_ONLY / HIDDEN per role).
  const { isHidden, isReadOnly } = useFieldPermissions('Receipt Advice');
  const { isHidden: isLineHidden, isReadOnly: isLineRO } = useFieldPermissions('Receipt Line');
  const { isHidden: isPackHidden, isReadOnly: isPackRO } = useFieldPermissions('Receipt Packing Material');
  const { options: vendorOptions, raw: vendorRaw } = useLookup('/api/vendors/');
  const { options: transporterOptions } = useLookup('/api/transporters/');
  const [selectedCompany, setSelectedCompany] = useState('');
  const { options: companyOptions } = useLookup('/api/companies/');
  // `fresh: true` — POs are transactional and change mid-session (created,
  // emailed to vendor, received). The shared useLookup cache would otherwise
  // pin the dropdown to a stale snapshot taken on first load, hiding POs
  // that have since become receivable.
  const { raw: poRawData } = useLookup('/api/purchase/orders/', { fresh: true });
  // Active Job Work orders for the optional "Receive against Job Work" path.
  // Only show ones that can still receive materials (not Completed/Cancelled).
  // Also fresh — same staleness concern as POs.
  const { raw: jobWorkRawData } = useLookup('/api/inventory/job-work/', { fresh: true });
  const ACTIVE_JW_STATUSES = ['DRAFT', 'ISSUED', 'IN_PROGRESS', 'PARTIALLY_RECEIVED'];
  const jobWorkOptions = (jobWorkRawData || [])
    .filter(jw => ACTIVE_JW_STATUSES.includes(jw.status))
    .map(jw => ({
      value: jw.id,
      label: `${jw.order_no || jw.jw_order_no || ''} — ${jw.vendor_name || jw.vendor || ''} · ${jw.warehouse_name || ''}${jw.start_date ? ' · ' + jw.start_date : ''}`,
    }));
  // The /api/purchase/orders/ endpoint already scopes the list to the user's
  // accessible warehouses via stakeholder.warehouse_scope on the backend, so
  // we only need to filter out statuses that aren't valid for receipt creation.
  // A PO is hidden until it has been emailed to the vendor — the
  // dispatched-to-vendor signal is what makes the PO "real" enough to
  // expect goods against. The serializer's `email_sent` flag turns True
  // once an EmailLog row exists for this PO's vendor after PO creation.
  // Fully-received POs (auto-set to CLOSED) are excluded — there's nothing
  // left to receive against them. The handlePOChange / isPoFullyReceived
  // guard still blocks a fully-received PO reached via the ?po_id= deep link.
  // Base filter — status / email_sent / not-fully-received. Vendor
  // scoping is applied at the JSX consumer (formData is declared
  // later in this component; referencing it here trips a temporal
  // dead zone crash).
  const poOptions = poRawData
    .filter(po =>
      !['CLOSED', 'CANCELLED', 'DRAFT', 'SPLIT'].includes(po.status)
      && !po.is_fully_received
      && po.email_sent
    )
    .map(po => ({
      value: po.id,
      label: `${po.po_no} — ${po.vendor_name || ''}`,
      vendor: po.vendor,
    }));

  // Filter contractor vendors for wages section
  const contractorOptions = vendorRaw
    .filter(v => {
      const raw = v.vendor_type;
      const types = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? [raw] : []);
      return types.some(t => {
        const lower = (t || '').toLowerCase();
        return lower === 'contractor' || lower === 'wages' || lower === 'job_work';
      });
    })
    .map(v => ({ value: v.id, label: v.vendor_name || v.vendor_code }));
  const contractorVendorOptions = contractorOptions.length > 0 ? contractorOptions : vendorOptions;
  const { options: productOptions, raw: productRaw } = useAllProducts();
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const pendingAttachmentsRef = useRef([]);
  const [pendingTransportAttachments, setPendingTransportAttachments] = useState([]);
  const pendingTransportAttachmentsRef = useRef([]);
  const transportCameraRef = useRef(null);
  const transportFileRef = useRef(null);
  const generalCameraRef = useRef(null);
  const [freightExtracting, setFreightExtracting] = useState(false);

  const handleTransportFile = async (file) => {
    if (!file) return;
    const updated = [...pendingTransportAttachmentsRef.current, file];
    pendingTransportAttachmentsRef.current = updated;
    setPendingTransportAttachments(updated);

    setFreightExtracting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiClient.post('/api/purchase/receipts/extract-freight-bill/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 150_000,
      });
      const d = res.data || {};
      if (d.extraction_status === 'failed') {
        toast.error('Could not extract freight bill details. Fill manually.');
        return;
      }
      setFormData(prev => ({
        ...prev,
        transporter_name: d.transporter_name || prev.transporter_name,
        freight_bill_no: d.freight_bill_no || prev.freight_bill_no,
        freight_bill_date: d.freight_bill_date || prev.freight_bill_date,
        vehicle_number: d.vehicle_no || prev.vehicle_number,
        driver_name: d.driver_name || prev.driver_name,
        freight_value: d.freight_value || prev.freight_value,
        freight_terms: d.freight_terms || prev.freight_terms,
        advance_amount: d.advance_amount || prev.advance_amount,
      }));
      toast.success('Freight bill details extracted');
    } catch {
      toast.error('Freight bill extraction failed. Fill manually.');
    } finally {
      setFreightExtracting(false);
    }
  };
  const [prefillPoNo, setPrefillPoNo] = useState('');

  // ── Auto Fill (AI) — Gemini document extraction ────────────────────────
  // Default to AI extraction on a new receipt — the vendor invoice is
  // usually on hand, so extraction is the primary path. Switch to Manual
  // to key in / PO-autofill instead.
  const [fillMode, setFillMode] = useState('autofill'); // 'manual' | 'autofill'
  const [uploadedFile, setUploadedFile] = useState(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractResult, setExtractResult] = useState(null);
  const aiFileInputRef = useRef(null);

  const [formData, setFormData] = useState({
    po_no: '',
    job_work_no: '',
    vendor: '',
    warehouse: '',
    receipt_date: new Date().toISOString().split('T')[0],
    driver_name: '',
    driver_phone: '',
    vehicle_number: '',
    advance_amount: '',
    freight_value: '',
    freight_terms: '',
    qc_routing: '',
    qc_status: '',
    transporter: '',
    transporter_name: '',
    freight_bill_no: '',
    freight_bill_date: '',
    lr_no: '',
    partial_receipt_flag: false,
    remarks: '',
    // ── Direct Receipt support ────────────────────────────────────────
    receipt_source: 'AGAINST_PO', // 'AGAINST_PO' | 'DIRECT'
    direct_reason: '',
    invoice_no: '',
    invoice_date: '',
    invoice_amount: '',
  });

  // Convenience flag used throughout the JSX to hide PO-only fields/columns
  // and show the direct-receipt-only ones.
  const isDirectReceipt = formData.receipt_source === 'DIRECT';

  const { options: warehouseOptions } = useLookup('/api/warehouses/?scope=true');
  const { options: godownOptions } = useLookup(
    formData.warehouse ? `/api/godowns/?warehouse=${formData.warehouse}` : null
  );

  const [receiptLines, setReceiptLines] = useState([{ ...emptyReceiptLine }]);
  const [packingLines, setPackingLines] = useState([]);
  const [listeningPackIdx, setListeningPackIdx] = useState(null);
  const packMicRef = useRef(null);
  const [weighmentDetails, setWeighmentDetails] = useState([]);
  const [freightDetails, setFreightDetails] = useState([]);
  const [wageLines, setWageLines] = useState([]);
  const [poLines, setPoLines] = useState([]);

  // ── Multi-PO receipt ──────────────────────────────────────────────────
  // A single receipt can pull quantities from multiple active POs of the
  // same vendor. `formData.po_no` remains the "primary" PO (drives header
  // auto-fill: vendor / warehouse / freight_terms), and `additionalPoIds`
  // holds any extra PO ids the operator has merged in via "+ Add another
  // PO". Their line items are appended to `receiptLines` (with `po_line`
  // FK set), so each row still remembers which PO / PO-line it came from
  // — the backend serializer already handles a list on `linked_pos`.
  const [additionalPoIds, setAdditionalPoIds] = useState([]);
  const [addPoModalOpen, setAddPoModalOpen] = useState(false);
  const [addPoModalSelection, setAddPoModalSelection] = useState([]);
  const [addPoBusy, setAddPoBusy] = useState(false);

  // Receipt mismatch modal state — opens when Gemini extraction produces
  // line items that don't exactly match any PO product and have a fuzzy
  // similarity in the 25-50% range (or no match at all).
  const [mismatchRows, setMismatchRows] = useState([]);
  const [mismatchOpen, setMismatchOpen] = useState(false);

  // Weighment slip extraction — per-row inline AI upload. Each row has its
  // own tiny icon button; clicking it sets `weighmentExtractRowIdx` and
  // triggers the shared hidden file input below.
  const weighmentFileInputRef = useRef(null);
  const [weighmentExtractRowIdx, setWeighmentExtractRowIdx] = useState(null);
  const [extractingRowIdx, setExtractingRowIdx] = useState(null);

  // ── Packing-material enforcer ───────────────────────────────────────────
  // Belt-and-suspenders safety net: regardless of which code path
  // populated receiptLines (?po_id= redirect, handlePOChange dropdown,
  // applyReceiptExtraction OCR, mismatch-modal resolve, manual Add Line
  // + product pick), if a row in receiptLines is for a product whose
  // master `goods_sub_type` is PACKING_MATERIAL — or whose linked PO
  // line carries PACKING_MATERIAL category — this effect MIGRATES it
  // out of receiptLines and INTO packingLines, deduplicating by the
  // product id so we never double-add.
  //
  // Runs whenever receiptLines, poLines, or productRaw change. The
  // first two cover route fills; productRaw covers the case where
  // the product master loads after the receipt lines (race on initial
  // page mount). Idempotent — re-running it on already-correct state
  // is a no-op because the filter will find nothing to move.
  useEffect(() => {
    if (!Array.isArray(receiptLines) || receiptLines.length === 0) return;
    if (!Array.isArray(productRaw) || productRaw.length === 0) return;

    // Build a quick lookup of pr_line_category by po_line id from
    // the latest poLines snapshot, so we don't lose category info
    // when a receipt line carries po_line but the partition code
    // dropped the helper field.
    const poLineCategoryById = new Map();
    for (const pl of (poLines || [])) {
      if (pl?.id) {
        const cat = (pl.pr_line_category || pl.category || '').toString().trim().toUpperCase();
        if (cat) poLineCategoryById.set(pl.id, cat);
      }
    }

    const productCategoryById = new Map();
    for (const p of productRaw) {
      const sub = (p?.goods_sub_type || '').toString().trim().toUpperCase();
      if (p?.id && sub) productCategoryById.set(p.id, sub);
    }

    const isLinePacking = (line) => {
      if (!line?.product) return false;
      // 1. PR-linked PO line category
      const poCat = line.po_line ? poLineCategoryById.get(line.po_line) : '';
      if (poCat === 'PACKING_MATERIAL') return true;
      // 2. Product master goods_sub_type
      const prodCat = productCategoryById.get(line.product);
      if (prodCat === 'PACKING_MATERIAL') return true;
      return false;
    };

    const toMove = receiptLines.filter(isLinePacking);
    if (toMove.length === 0) return;

    // Drop them from receiptLines (preserve the rest, including any
    // truly empty rows the operator was using).
    setReceiptLines(prev => prev.filter(l => !isLinePacking(l)));

    // Append to packingLines, deduplicated by packaging_sku so a row
    // that already exists there (from a prior PO fetch / extraction)
    // doesn't get duplicated when the enforcer fires.
    setPackingLines(prev => {
      const seen = new Set(prev.map(p => p.packaging_sku).filter(Boolean));
      const additions = [];
      for (const l of toMove) {
        if (l.product && seen.has(l.product)) continue;
        additions.push({
          packaging_sku: l.product || '',
          po_line: l.po_line || '',
          quantity: l.quantity_received || l.po_quantity || '',
          net_quantity: l.net_quantity || '',
          uom: l.uom || 'PCS',
          length: l.length || '',
          breadth: l.breadth || '',
          width: l.width || '',
          weight: l.weight || '',
          batch_no: l.batch_no || '',
          godown_location: l.godown_location || '',
          remarks: l.remarks || '',
          condition: 'NEW',
          _itemName: l.item_name || '',
          _poQuantity: l.po_quantity || 0,
          _alreadyReceived: l.already_received || 0,
          _poUom: l.po_uom || l.uom || '',
        });
        if (l.product) seen.add(l.product);
      }
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });

    if (typeof window !== 'undefined' && window.localStorage?.getItem('RECEIPT_CATEGORY_DEBUG') === '1') {
      // eslint-disable-next-line no-console
      console.log('[Packing enforcer] migrated', toMove.length, 'row(s) from Receipt Line Items → Packing Materials');
    }
  }, [receiptLines, poLines, productRaw]);

  // Auto-fill from PO when redirected from PO detail page with ?po_id=
  useEffect(() => {
    const poId = searchParams.get('po_id');
    if (!poId) return;
    if (formData.po_no === poId) return;

    // Fetch PO directly for fresh received_quantity data
    apiClient.get(`/api/purchase/orders/${poId}/`).then(async (res) => {
      const selectedPO = res.data;
      if (!selectedPO) return;

      // A fully-received PO has nothing left to receive — warn and don't
      // seed the form (same rule the dropdown handler enforces).
      if (isPoFullyReceived(selectedPO)) {
        toast.error(`All quantities for ${selectedPO.po_no || 'this PO'} have already been received. No further receipt can be created against it.`);
        setFormData(prev => ({ ...prev, po_no: '' }));
        setPoLines([]);
        setReceiptLines([{ ...emptyReceiptLine }]);
        setPackingLines([]);
        return;
      }
      // A SPLIT PO's obligation has moved to its child DRAFT POs —
      // receipts should go against those, not the parent. Same
      // bail-out shape as the fully-received case.
      if (selectedPO.status === 'SPLIT') {
        toast.error(`${selectedPO.po_no || 'This PO'} was split into child POs — receive against those instead.`);
        setFormData(prev => ({ ...prev, po_no: '' }));
        setPoLines([]);
        setReceiptLines([{ ...emptyReceiptLine }]);
        setPackingLines([]);
        return;
      }

      setPrefillPoNo(selectedPO.po_no || '');
      if (selectedPO.company) setSelectedCompany(selectedPO.company);

      setFormData(prev => ({
        ...prev,
        po_no: selectedPO.id,
        vendor: selectedPO.vendor || '',
        warehouse: selectedPO.warehouse || '',
        // Carry Freight Terms forward from the PO. Only apply when
        // the PO actually has a value we can render — MIXED / empty
        // collapse to '' so the operator picks. Don't clobber an
        // already-typed value (initial load only).
        freight_terms: prev.freight_terms || receiptFreightTermsFromPO(selectedPO.freight_terms),
      }));

      setPoLines(selectedPO.po_lines || []);

      // Fetch linked PR's godown for auto-fill
      let prGodown = '';
      const linkedPrIds = selectedPO.linked_prs || [];
      if (linkedPrIds.length > 0) {
        try {
          const prRes = await apiClient.get(`/api/purchase/requests/${linkedPrIds[0]}/`);
          prGodown = prRes.data?.godown || '';
        } catch { /* ignore */ }
      }

      const lines = selectedPO.po_lines || [];
      if (lines.length > 0) {
        // Diagnostic: enable in console with
        //   localStorage.RECEIPT_CATEGORY_DEBUG = '1'
        // Shows exactly what category fields each PO line carries
        // when this useEffect (?po_id= redirect path) processes them.
        // The earlier diagnostic only covered handlePOChange — this
        // path needed its own log.
        if (typeof window !== 'undefined' && window.localStorage?.getItem('RECEIPT_CATEGORY_DEBUG') === '1') {
          // eslint-disable-next-line no-console
          console.log('[Receipt ?po_id= path] PO lines from API:', lines);
          // eslint-disable-next-line no-console
          console.table(lines.map(pl => ({
            line: pl.line_no,
            item: pl.item_name || pl.product_name,
            pr_line_category: pl.pr_line_category,
            poline_category: pl.category,
            isPM: isPackingMaterialPoLine(pl, productRaw),
            productRawLoaded: Array.isArray(productRaw) ? productRaw.length : 'not array',
          })));
        }
        // Partition by PR-line category so PACKING_MATERIAL lines go
        // into the Packing Materials subform and everything else into
        // Receipt Line Items. Same split runs in handlePOChange below
        // — see isPackingMaterialPoLine() for the routing rule.
        const goodsLines = lines.filter(pl => !isPackingMaterialPoLine(pl, productRaw));
        const packingPoLines = lines.filter(pl => isPackingMaterialPoLine(pl, productRaw));

        setReceiptLines(goodsLines.map(pl => ({
          // Track the source-master so the save path routes the picked
          // id to the right FK. Auto-fill copies item_type from the PO
          // line — Goods rows still use `product` for backward compat.
          item_type: (pl.item_type || 'PRODUCT').toUpperCase(),
          product: pl.product_service || pl.machinery || pl.service_catalogue || '',
          item_name: pl.item_name || pl.product_name || '',
          po_line: pl.id || '',
          _poNo: selectedPO.po_no || '',
          // Pre-fill Invoice Qty with the pending qty (ordered − already
          // received). Operator sees the remaining balance already typed
          // in, matching their expectation that the previous receipt was
          // tracked; they override if the invoice is short. Falls back to
          // blank when there's no PO qty to compute against.
          quantity_received: (() => {
            const ordered = parseFloat(pl.quantity_ordered) || 0;
            const rcvd = parseFloat(pl.received_quantity) || 0;
            const pending = Math.max(0, ordered - rcvd);
            return pending > 0 ? String(pending) : '';
          })(),
          _prefillQty: (() => {
            const ordered = parseFloat(pl.quantity_ordered) || 0;
            const rcvd = parseFloat(pl.received_quantity) || 0;
            const pending = Math.max(0, ordered - rcvd);
            return pending > 0 ? String(pending) : '';
          })(),
          po_quantity: pl.quantity_ordered || 0,
          already_received: pl.received_quantity || 0,
          uom: pl.uom || 'KG',
          // PR-line UOM travels with the row so the Density column
          // knows whether to show the input for this line (LTR → yes).
          pr_line_uom: pl.pr_line_uom || '',
          density: '',
          product_sg_applicable: !!pl.product_sg_applicable,
          specific_gravity: '',
          quantity_in_litres: '',
          // Snapshot the PO line's UOM so we can detect when the user
          // later changes the receipt-line UOM. Used to skip the max-qty
          // constraint when receipt UOM ≠ PO UOM (different unit space).
          po_uom: pl.uom || '',
          batch_no: '',
          // Per-line PR godown takes priority; fall back to the first linked PR's godown.
          godown_location: pl.pr_godown || prGodown,
          remarks: '',
          is_debit_note: false,
        })));

        if (packingPoLines.length > 0) {
          setPackingLines(packingPoLines.map(poLineToPackingRow));
        }
      }
    }).catch(() => {});
  }, [searchParams]);

  // When PO is selected, auto-fill vendor, warehouse, and receipt lines from PO
  const handlePOChange = async (e) => {
    const poId = e.target.value;
    setFormData(prev => ({ ...prev, po_no: poId }));
    // Primary PO changing invalidates any additional POs the operator
    // had merged in — their lines belonged to a different vendor context
    // or would now duplicate the fresh seed. Reset to a clean slate.
    setAdditionalPoIds([]);

    if (!poId) {
      setPoLines([]);
      setReceiptLines([{ ...emptyReceiptLine }]);
      return;
    }

    // Fetch PO directly for fresh received_quantity
    apiClient.get(`/api/purchase/orders/${poId}/`).then(async (res) => {
      const selectedPO = res.data;
      if (!selectedPO) return;

      // Block POs that are already fully received — nothing left to
      // receive, so reset the picker instead of seeding the form.
      if (isPoFullyReceived(selectedPO)) {
        toast.error(`All quantities for ${selectedPO.po_no || 'this PO'} have already been received. No further receipt can be created against it.`);
        setFormData(prev => ({ ...prev, po_no: '' }));
        setPoLines([]);
        setReceiptLines([{ ...emptyReceiptLine }]);
        setPackingLines([]);
        return;
      }

      // FIFO enforcement — PER PRODUCT. Lines whose product an older PO
      // of the same vendor still has pending are excluded from seeding
      // (receive them from the older PO first); the PO's other lines
      // remain receivable. Only when EVERY pending line is blocked does
      // the pick fail outright. Same rule in "+ Add another PO" below.
      const blockedByProduct = findFifoBlockedProducts(selectedPO, poRawData || []);
      const { pendingLines, blockedPending, receivable } = partitionByFifo(selectedPO.po_lines, blockedByProduct);
      if (pendingLines.length > 0 && blockedPending.length === pendingLines.length) {
        const b = blockedByProduct[blockedPending[0].product_service];
        toast.error(
          `${b.po_no || 'An older PO'} still has ${b.pending} ${b.uom} `
          + `of ${b.product_name} pending. Receive that first before opening ${selectedPO.po_no || 'this PO'}.`,
          { duration: 6000 },
        );
        setFormData(prev => ({ ...prev, po_no: '' }));
        setPoLines([]);
        setReceiptLines([{ ...emptyReceiptLine }]);
        setPackingLines([]);
        return;
      }
      if (blockedPending.length > 0) {
        const parts = blockedPending.map((pl) => {
          const b = blockedByProduct[pl.product_service];
          return `${b.product_name} (${b.po_no || 'older PO'} has ${b.pending} ${b.uom} pending)`;
        });
        toast(
          `Skipped from this receipt — receive the older PO first for: ${[...new Set(parts)].join('; ')}.`,
          { icon: '⚠️', duration: 8000 },
        );
      }

      setPoLines(receivable);
      if (selectedPO.company) setSelectedCompany(selectedPO.company);

      setFormData(prev => {
        // Auto-fill Freight Terms from the chosen PO when the operator
        // hasn't already picked one. handlePOChange runs every time
        // the operator selects a different PO, so the "first load
        // only" semantic comes from `prev.freight_terms ||` — if it's
        // already set, we don't clobber an existing manual pick.
        const fromPO = receiptFreightTermsFromPO(selectedPO.freight_terms);
        return {
          ...prev,
          po_no: poId,
          vendor: selectedPO.vendor || prev.vendor,
          warehouse: selectedPO.warehouse || prev.warehouse,
          freight_terms: prev.freight_terms || fromPO,
        };
      });

      // Fetch linked PR's godown for auto-fill
      let prGodown = '';
      const linkedPrIds = selectedPO.linked_prs || [];
      if (linkedPrIds.length > 0) {
        try {
          const prRes = await apiClient.get(`/api/purchase/requests/${linkedPrIds[0]}/`);
          prGodown = prRes.data?.godown || '';
        } catch { /* ignore */ }
      }

      const poLines = receivable;
      if (poLines.length > 0) {
        // Diagnostic: log each PO line's category-related fields so
        // we can see why the partition isn't routing. Enable in the
        // browser console once with:
        //     localStorage.RECEIPT_CATEGORY_DEBUG = '1'
        if (typeof window !== 'undefined' && window.localStorage?.getItem('RECEIPT_CATEGORY_DEBUG') === '1') {
          // eslint-disable-next-line no-console
          console.table(poLines.map(pl => ({
            line: pl.line_no,
            item: pl.item_name || pl.product_name,
            pr_line_category: pl.pr_line_category,
            poline_category: pl.category,
            linked_pr_line: pl.linked_pr_line,
            isPM: isPackingMaterialPoLine(pl, productRaw),
          })));
        }
        // Same routing as the ?po_id= effect above — split lines by
        // PR category so packing materials land in the right section.
        const goodsLines = poLines.filter(pl => !isPackingMaterialPoLine(pl, productRaw));
        const packingPoLines = poLines.filter(pl => isPackingMaterialPoLine(pl, productRaw));

        if (goodsLines.length > 0) {
          setReceiptLines(goodsLines.map(pl => ({
            item_type: (pl.item_type || 'PRODUCT').toUpperCase(),
            product: pl.product_service || pl.machinery || pl.service_catalogue || '',
            item_name: pl.item_name || pl.product_name || '',
            po_line: pl.id || '',
            _poNo: selectedPO.po_no || '',
            // Prefill Invoice Qty with pending qty (ordered − already
            // received) so the operator sees a "known-good" value and
            // can just confirm on the common case; edit if the invoice
            // is short.
            quantity_received: (() => {
              const ordered = parseFloat(pl.quantity_ordered) || 0;
              const rcvd = parseFloat(pl.received_quantity) || 0;
              const pending = Math.max(0, ordered - rcvd);
              return pending > 0 ? String(pending) : '';
            })(),
            _prefillQty: (() => {
              const ordered = parseFloat(pl.quantity_ordered) || 0;
              const rcvd = parseFloat(pl.received_quantity) || 0;
              const pending = Math.max(0, ordered - rcvd);
              return pending > 0 ? String(pending) : '';
            })(),
            po_quantity: pl.quantity_ordered || 0,
            already_received: pl.received_quantity || 0,
            uom: pl.uom || 'KG',
            // Snapshot the PO line's UOM so we can detect when the user
            // later changes the receipt-line UOM. Used to skip the max-qty
            // constraint when receipt UOM ≠ PO UOM (different unit space).
            po_uom: pl.uom || '',
            // PR-line UOM travels with the row so the Density column
            // knows whether to show the input (LTR → yes).
            pr_line_uom: pl.pr_line_uom || '',
            density: '',
            product_sg_applicable: !!pl.product_sg_applicable,
            specific_gravity: '',
            quantity_in_litres: '',
            batch_no: '',
            // Per-line PR godown takes priority; fall back to the first linked PR's godown.
            godown_location: pl.pr_godown || prGodown,
            remarks: '',
            is_debit_note: false,
          })));
        } else {
          // PO is 100% packing material — clear the (default) empty
          // Goods row so the section doesn't render an orphaned blank.
          setReceiptLines([]);
        }

        if (packingPoLines.length > 0) {
          setPackingLines(packingPoLines.map(poLineToPackingRow));
        }
      }
    }).catch(() => {});
  };

  // ── Multi-PO: append another PO's lines to the current receipt ─────
  // Fetches the PO, appends its Goods PO-lines as new receipt-line rows
  // (each carrying the po_line FK so the backend can post-back received
  // quantities against the right PO). Packing material lines get merged
  // into `packingLines` the same way the primary PO seeding does.
  //
  // Guards:
  //  - Must share the vendor of the primary PO (multi-PO is per-vendor).
  //  - Skip if already picked (as primary or additional).
  //  - Skip if the PO is fully received or in a non-active status.
  const addAdditionalPO = async (poId) => {
    if (!poId) return;
    if (!formData.po_no) {
      toast.error('Pick a primary PO first, then add more.');
      return;
    }
    if (poId === formData.po_no || additionalPoIds.includes(poId)) {
      return;
    }
    try {
      const res = await apiClient.get(`/api/purchase/orders/${poId}/`);
      const po = res.data;
      if (!po) return;
      if (isPoFullyReceived(po)) {
        toast.error(`${po.po_no || 'PO'} is already fully received — nothing left to add.`);
        return;
      }
      if (po.vendor && formData.vendor && po.vendor !== formData.vendor) {
        toast.error(`${po.po_no || 'PO'} belongs to a different vendor.`);
        return;
      }
      // Same per-product FIFO guard as handlePOChange — blocked products
      // are skipped (receive them from the older PO first), the rest of
      // the PO's lines still get added. POs already part of this receipt
      // (primary or previously added) are never blockers: their pending
      // is being received right here.
      const pickedPoIds = [formData.po_no, ...additionalPoIds].filter(Boolean);
      const blockedByProduct = findFifoBlockedProducts(po, poRawData || [], pickedPoIds);
      const { pendingLines, blockedPending, receivable } = partitionByFifo(po.po_lines, blockedByProduct);
      if (pendingLines.length > 0 && blockedPending.length === pendingLines.length) {
        const b = blockedByProduct[blockedPending[0].product_service];
        toast.error(
          `${b.po_no || 'An older PO'} still has ${b.pending} ${b.uom} `
          + `of ${b.product_name} pending. Receive that first before adding ${po.po_no || 'this PO'}.`,
          { duration: 6000 },
        );
        return;
      }
      if (blockedPending.length > 0) {
        const parts = blockedPending.map((pl) => {
          const b = blockedByProduct[pl.product_service];
          return `${b.product_name} (${b.po_no || 'older PO'} has ${b.pending} ${b.uom} pending)`;
        });
        toast(
          `Skipped from this receipt — receive the older PO first for: ${[...new Set(parts)].join('; ')}.`,
          { icon: '⚠️', duration: 8000 },
        );
      }

      const lines = receivable;
      const goodsLines = lines.filter(pl => !isPackingMaterialPoLine(pl, productRaw));
      const packingPoLines = lines.filter(pl => isPackingMaterialPoLine(pl, productRaw));

      // Look up the PO's linked PR godown once, mirroring handlePOChange.
      let prGodown = '';
      const linkedPrIds = po.linked_prs || [];
      if (linkedPrIds.length > 0) {
        try {
          const prRes = await apiClient.get(`/api/purchase/requests/${linkedPrIds[0]}/`);
          prGodown = prRes.data?.godown || '';
        } catch { /* ignore */ }
      }

      const newReceiptRows = goodsLines.map(pl => ({
        item_type: (pl.item_type || 'PRODUCT').toUpperCase(),
        product: pl.product_service || pl.machinery || pl.service_catalogue || '',
        item_name: pl.item_name || pl.product_name || '',
        po_line: pl.id || '',
        _poNo: po.po_no || '',
        // Same pending-qty prefill as the primary PO seed above.
        quantity_received: (() => {
          const ordered = parseFloat(pl.quantity_ordered) || 0;
          const rcvd = parseFloat(pl.received_quantity) || 0;
          const pending = Math.max(0, ordered - rcvd);
          return pending > 0 ? String(pending) : '';
        })(),
        po_quantity: pl.quantity_ordered || 0,
        already_received: pl.received_quantity || 0,
        uom: pl.uom || 'KG',
        po_uom: pl.uom || '',
        pr_line_uom: pl.pr_line_uom || '',
        density: '',
        product_sg_applicable: !!pl.product_sg_applicable,
        specific_gravity: '',
        quantity_in_litres: '',
        batch_no: '',
        godown_location: pl.pr_godown || prGodown,
        remarks: '',
        is_debit_note: false,
      }));

      // Append PO lines to `poLines` so the packing-material enforcer /
      // validation code that keys off po_line ids keeps working across
      // both primary and additional POs.
      setPoLines(prev => {
        const seen = new Set((prev || []).map(pl => pl.id));
        const additions = lines.filter(pl => pl.id && !seen.has(pl.id));
        return [...(prev || []), ...additions];
      });

      // Drop the initial empty row (if any) before appending — otherwise
      // the operator sees a stray blank line above the merged-in rows.
      setReceiptLines(prev => {
        const trimmed = (prev || []).filter(l => l.product || l.quantity_received || l.item_name);
        return [...trimmed, ...newReceiptRows];
      });

      if (packingPoLines.length > 0) {
        setPackingLines(prev => {
          const seen = new Set((prev || []).map(p => p.packaging_sku).filter(Boolean));
          const additions = packingPoLines
            .map(poLineToPackingRow)
            .filter(row => !row.packaging_sku || !seen.has(row.packaging_sku));
          return [...(prev || []), ...additions];
        });
      }

      setAdditionalPoIds(prev => (prev.includes(poId) ? prev : [...prev, poId]));
      toast.success(`${po.po_no || 'PO'} added to this receipt.`);
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Failed to add PO.'));
    }
  };

  // Reverse of addAdditionalPO — drop the additional PO id and any
  // receipt-line rows whose po_line came from it. Rows the operator
  // typed manually (no po_line) are preserved.
  const removeAdditionalPO = (poId) => {
    if (!poId) return;
    const removedLineIds = new Set(
      (poLines || [])
        .filter(pl => pl.purchase_order === poId || pl.po === poId)
        .map(pl => pl.id)
    );
    // Fallback: if the PO line rows don't expose the parent id in the
    // shape we grabbed, we can still recover by re-fetching the PO to
    // learn its line ids. Do this asynchronously so the UI clears now.
    setAdditionalPoIds(prev => prev.filter(id => id !== poId));

    if (removedLineIds.size > 0) {
      setReceiptLines(prev => prev.filter(l => !l.po_line || !removedLineIds.has(l.po_line)));
      setPoLines(prev => (prev || []).filter(pl => !removedLineIds.has(pl.id)));
      return;
    }

    apiClient.get(`/api/purchase/orders/${poId}/`).then(res => {
      const idsFromApi = new Set((res.data?.po_lines || []).map(pl => pl.id));
      setReceiptLines(prev => prev.filter(l => !l.po_line || !idsFromApi.has(l.po_line)));
      setPoLines(prev => (prev || []).filter(pl => !idsFromApi.has(pl.id)));
    }).catch(() => {});
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  // Receive against an existing Job Work Order. Picking one fetches the
  // order, auto-fills header fields, and loads its materials_supplied lines
  // into the receipt lines table. The form still posts to the normal Receipt
  // Advice endpoint — Job Work linkage is captured via formData.job_work_no
  // so the backend can persist it once a field exists; until then it's
  // ignored harmlessly.
  const handleJobWorkChange = async (e) => {
    const jwId = e.target.value;
    setFormData(prev => ({ ...prev, job_work_no: jwId }));
    if (!jwId) return;

    try {
      const res = await apiClient.get(`/api/inventory/job-work/${jwId}/`);
      const jw = res.data || {};

      // Block re-receipt on a completed/cancelled job work just in case the
      // dropdown was stale.
      if (['COMPLETED', 'CANCELLED'].includes(jw.status)) {
        toast.error(`Job Work ${jw.order_no || ''} is ${jw.status} — cannot create a receipt against it.`);
        setFormData(prev => ({ ...prev, job_work_no: '' }));
        return;
      }

      // Header auto-fill. Only set fields we have a value for; leave others
      // untouched so a user's manual edits aren't clobbered.
      const headerFromJW = {
        job_work_no: jwId,
        vendor: jw.vendor || formData.vendor,
        warehouse: jw.warehouse || formData.warehouse,
        freight_terms: jw.freight_terms || formData.freight_terms,
        qc_routing: jw.qc_requirement || jw.qc_routing || formData.qc_routing,
        transporter: jw.transporter || formData.transporter,
        vehicle_number: jw.vehicle_no || formData.vehicle_number,
        lr_no: jw.lr_no || formData.lr_no,
        remarks: jw.remarks || formData.remarks,
      };
      setFormData(prev => ({ ...prev, ...headerFromJW }));
      if (jw.company) setSelectedCompany(jw.company);

      // Load Job Work materials_supplied as receipt lines. Compute pending qty
      // = issued - already_received and seed Qty Received with the pending qty
      // (editable). Net Quantity = Qty Received - Difference.
      const materials = jw.materials_supplied || jw.lines || jw.products || [];
      if (materials.length > 0) {
        setReceiptLines(materials.map(m => {
          const issued = parseFloat(m.quantity || m.issue_qty || 0) || 0;
          const expectedReturn = parseFloat(m.expected_return_qty || 0) || 0;
          const alreadyReceived = parseFloat(m.already_received_qty || m.received_qty || 0) || 0;
          const balance = Math.max(0, (expectedReturn || issued) - alreadyReceived);
          return {
            // MaterialSupplied uses product_machine_id; the create form also
            // sends `product`. Accept either.
            product: m.product || m.product_machine_id || '',
            po_line: '',
            quantity_received: balance ? String(balance) : '',
            net_quantity: '',
            po_quantity: issued,
            already_received: alreadyReceived,
            expected_return_qty: expectedReturn,
            balance_qty: balance,
            difference_qty: '',
            uom: m.uom || 'KG',
            batch_no: m.batch || '',
            godown_location: jw.godown || '',
            remarks: m.remarks || '',
            is_debit_note: false,
            from_job_work: true,
          };
        }));
        setPoLines([]);
        toast.success(`Loaded ${materials.length} line${materials.length > 1 ? 's' : ''} from Job Work`);
      } else {
        toast(`Job Work has no line items to load — add lines manually.`, { icon: 'ℹ️' });
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to load Job Work details');
      setFormData(prev => ({ ...prev, job_work_no: '' }));
    }
  };

  // Receipt Lines handlers
  // Apply ReceiptMismatchModal decisions back onto receiptLines.
  // resolutions = [{ idx, choice, productId, product, newProduct, extracted_name }]
  //   choice: 'po' (PO Receipt) | 'master' (Direct Receipt) | 'create' | 'remove'
  const handleMismatchResolve = async (resolutions) => {
    // Phase 1 — create any "Create new" products. We do this first so the
    // newly-created ids can be applied to receipt lines in phase 2.
    const creates = resolutions.filter(r => r.choice === 'create' && r.newProduct);
    const createdIds = {};   // idx → product id (newly created OR reused existing)
    if (creates.length > 0) {
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
      let createdCount = 0;
      let reusedCount = 0;
      results.forEach((res, i) => {
        const create = creates[i];
        if (res.status === 'fulfilled') {
          createdIds[create.idx] = res.value.data.id;
          createdCount += 1;
          return;
        }
        // Duplicate SKU / name → reuse the existing master row instead of failing.
        const err = res.reason;
        const data = err?.response?.data;
        if (err?.response?.status === 400) {
          let existing = null;
          if (isDuplicateField(data, 'sku_code')) {
            existing = findExistingBySku(create.newProduct.sku_code);
          }
          if (!existing && isDuplicateField(data, 'product_name')) {
            existing = findExistingByName(create.newProduct.product_name);
          }
          if (existing) {
            createdIds[create.idx] = existing.id;
            reusedCount += 1;
            return;
          }
        }
        const fieldErrors = data && typeof data === 'object'
          ? Object.entries(data).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' | ')
          : (typeof data === 'string' ? data : err?.message || 'Unknown error');
        console.error('[Receipt] Create product failed', { payload: create.newProduct, response: data });
        toast.error(`Row ${create.idx + 1} — failed to create product: ${fieldErrors}`, { duration: 10000 });
      });
      if (createdCount) toast.success(`Created ${createdCount} new product${createdCount > 1 ? 's' : ''} in master`);
      if (reusedCount) toast(`Reused ${reusedCount} existing master product${reusedCount > 1 ? 's' : ''} (SKU already existed)`, { icon: 'ℹ️' });
    }

    // Phase 2 — apply decisions to receipt lines.
    //
    // After each row gets its chosen product, we re-evaluate category
    // routing: a row whose resolved product carries category
    // PACKING_MATERIAL (from the PO line's PR-linked category, or the
    // product master's goods_sub_type in Direct mode) is migrated
    // OUT of Receipt Line Items and INTO the Packing Materials
    // subform. Without this, an item that was unresolved during auto-
    // match would stay in Receipt Line Items even after the operator
    // confirmed it as packing material via the popup.
    const migrateToPacking = [];
    setReceiptLines((prev) => {
      const next = prev.map((line, i) => {
        const r = resolutions.find(x => x.idx === i);
        if (!r) return line;
        // PO Receipt: pick from PO products. Carry item_type AND
        // category from the picked product so post-resolve routing
        // can decide Receipt vs Packing.
        if (r.choice === 'po' && r.product) {
          return {
            ...line,
            item_type: (r.product.item_type || 'PRODUCT').toUpperCase(),
            product: r.productId,
            item_name: r.product.name || line.item_name || '',
            po_line: r.product.po_line_id || line.po_line,
            uom: r.product.uom || line.uom,
            po_quantity: r.product.quantity_ordered || line.po_quantity || 0,
            _matched: true,
            _matchSource: 'modal',
            _unresolved: false,
            _category: (r.product.category || '').toString().trim().toUpperCase(),
          };
        }
        // Direct Receipt: pick from master. Master is Goods-only so
        // item_type resets to PRODUCT. We still carry category from
        // the master pick (goods_sub_type) so packing-material picks
        // route correctly.
        if (r.choice === 'master' && r.product) {
          return {
            ...line,
            item_type: 'PRODUCT',
            product: r.productId,
            uom: r.product.uom || line.uom,
            _matched: true,
            _matchSource: 'modal_master',
            _unresolved: false,
            _category: (r.product.category || '').toString().trim().toUpperCase(),
          };
        }
        // Create new product → use the created/reused id. The newly
        // created master row defaults to goods_sub_type='RAW_MATERIAL'
        // (Product model default), so we can't infer packing-material
        // here. Operator can move the row manually if needed.
        if (r.choice === 'create') {
          const newId = createdIds[i];
          if (!newId) {
            return { ...line, _unresolved: true };
          }
          return {
            ...line,
            item_type: 'PRODUCT',
            product: newId,
            uom: r.newProduct?.uom || line.uom,
            _matched: true,
            _matchSource: 'created_new',
            _unresolved: false,
            _category: '',
          };
        }
        // 'remove' → mark for filter-out
        return { ...line, _remove: true };
      });

      // Collect packing-material rows so we can move them to the
      // Packing Materials subform after this setState returns. We
      // can't call setPackingLines from inside this updater without
      // risking React batching weirdness, so we stash the rows and
      // apply them outside.
      for (const line of next) {
        if (!line._remove && line._category === 'PACKING_MATERIAL') {
          migrateToPacking.push(line);
        }
      }
      // Drop removed rows AND packing-material rows from Receipt Line Items.
      return next.filter(l => !l._remove && l._category !== 'PACKING_MATERIAL');
    });

    if (migrateToPacking.length > 0) {
      setPackingLines(prev => {
        const seen = new Set(prev.map(p => p.packaging_sku).filter(Boolean));
        const merged = [...prev];
        for (const line of migrateToPacking) {
          if (line.product && seen.has(line.product)) continue;
          merged.push({
            packaging_sku: line.product || '',
            quantity: line.quantity_received || '',
            uom: line.uom || 'PCS',
            condition: 'NEW',
            _itemName: line.item_name || '',
            _poLineId: line.po_line || '',
            _extractedName: line._extractedName || '',
            _extractedCode: line._extractedCode || '',
          });
          if (line.product) seen.add(line.product);
        }
        return merged;
      });
      toast(`Moved ${migrateToPacking.length} packing-material row${migrateToPacking.length > 1 ? 's' : ''} to Packing Materials.`, { icon: '📦', duration: 4500 });
    }

    setMismatchOpen(false);
    setMismatchRows([]);
  };

  // Manual re-open of the mismatch popup. Rebuilds the queue from any
  // currently-unresolved receipt lines using the live PO products. Useful
  // when the user dismissed the modal earlier or PO was changed after
  // extraction.
  const reopenMismatchModal = () => {
    // Read whichever FK is set on each PO line (Goods / Machinery /
    // Service) so the manual re-open dropdown stays in sync with the
    // initial extraction haystack.
    const poProducts = (poLines || []).map((pl) => ({
      id: pl.product_service || pl.machinery || pl.service_catalogue || pl.product,
      name: pl.item_name || pl.product_name || pl.machinery_name || pl.service_catalogue_name || '',
      sku: pl.item_code || pl.product_code || pl.sku_code || '',
      po_line_id: pl.id || '',
      uom: pl.uom || '',
      quantity_ordered: pl.quantity_ordered || 0,
      item_type: pl.item_type || 'PRODUCT',
    })).filter(p => p.id);

    const rows = receiptLines
      .map((line, idx) => ({ line, idx }))
      .filter(({ line }) => line._unresolved)
      .map(({ line, idx }) => {
        // Rescore live against poProducts so the suggestion reflects the
        // currently-selected PO (in case the PO was changed since extraction).
        let bestRfq = poProducts.length ? poProducts[0] : null;
        let bestScore = 0;
        for (const p of poProducts) {
          const s = Math.max(
            diceSimilarity(line._extractedName || '', p.name || ''),
            line._extractedCode && p.sku ? diceSimilarity(line._extractedCode, p.sku) : 0,
          );
          if (s > bestScore) { bestScore = s; bestRfq = p; }
        }
        return {
          idx,
          extracted_name: line._extractedName || line._productName || '(no name extracted)',
          extracted_code: line._extractedCode || '',
          extracted_qty: line.quantity_received || '',
          extracted_uom: line.uom || '',
          extracted_rate: '',
          suggested: bestRfq ? {
            id: bestRfq.id, name: bestRfq.name, sku: bestRfq.sku,
            po_line_id: bestRfq.po_line_id, uom: bestRfq.uom,
          } : null,
          suggested_score: bestRfq ? bestScore : null,
          all_po_products: poProducts,
        };
      });
    if (rows.length === 0) {
      toast('No unresolved lines.', { icon: 'ℹ️' });
      return;
    }
    setMismatchRows(rows);
    setMismatchOpen(true);
  };

  const handleReceiptLineChange = (index, field, value) => {
    // Over-delivery is permitted — vendor production variance can ship
    // more than the PO. The earlier balance-cap guard here rejected
    // the keystroke, so the operator couldn't even type the higher qty.
    // The inline amber "Over-delivery: +N UOM" hint under the input
    // now surfaces the excess, and the backend accepts it.
    setReceiptLines(prev => prev.map((line, i) => i === index ? { ...line, [field]: value } : line));
  };
  const addReceiptLine = () => setReceiptLines(prev => [...prev, { ...emptyReceiptLine }]);
  const removeReceiptLine = (index) => {
    if (receiptLines.length > 1) setReceiptLines(prev => prev.filter((_, i) => i !== index));
  };

  // Packing Lines handlers
  const handlePackingLineChange = (index, field, value) => {
    setPackingLines(prev => prev.map((line, i) => i === index ? { ...line, [field]: value } : line));
  };
  const addPackingLine = () => setPackingLines(prev => [...prev, { ...emptyPackingLine }]);
  const removePackingLine = (index) => setPackingLines(prev => prev.filter((_, i) => i !== index));

  const togglePackMic = useCallback((index) => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { toast.error('Speech recognition not supported in this browser.'); return; }
    if (listeningPackIdx === index && packMicRef.current) {
      packMicRef.current.stop();
      packMicRef.current = null;
      setListeningPackIdx(null);
      return;
    }
    if (packMicRef.current) { packMicRef.current.stop(); packMicRef.current = null; }
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-IN';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript || '';
      if (transcript) {
        setPackingLines(prev => prev.map((p, i) => i === index ? { ...p, remarks: ((p.remarks || '') + (p.remarks ? ' ' : '') + transcript).trim() } : p));
      }
    };
    recognition.onend = () => { packMicRef.current = null; setListeningPackIdx(null); };
    recognition.onerror = (e) => { if (e.error !== 'aborted') toast.error(`Mic error: ${e.error}`); packMicRef.current = null; setListeningPackIdx(null); };
    packMicRef.current = recognition;
    setListeningPackIdx(index);
    recognition.start();
  }, [listeningPackIdx]);

  // Weighment Details handlers.
  // Convention: First Weight = gross (loaded truck), Second Weight =
  // tare (empty truck). The third column is the cargo's NET weight =
  // First − Second, displayed as "Net Weight" in the UI; backing field
  // stays `tare_weight` to avoid a data migration.
  //
  // The Receipt Line's "Received Quantity" auto-fills from this NET
  // value (the cargo) — NOT from Second Weight (the empty truck). This
  // changed from the previous behaviour where Second Weight was
  // (incorrectly) used as the cargo quantity.
  //
  // UOM conversion: when the weighment UOM differs from the receipt
  // line UOM (e.g. KG → TONS) we convert before writing. If the units
  // belong to different families (mass vs volume) we fall back to the
  // raw value and toast a warning.
  const handleWeighmentChange = (index, field, value) => {
    let netForLine = null;   // computed net (= first − second), pushed into Receipt Line
    let netSourceUom = null; // weighment UOM at the moment of edit

    setWeighmentDetails(prev => prev.map((line, i) => {
      if (i !== index) return line;
      const next = { ...line, [field]: value };
      // Recompute Net Weight = First − Second whenever either changes,
      // and capture for downstream receipt-line autofill.
      if (field === 'first_weight' || field === 'second_weight' || field === 'tare_weight') {
        const first = parseFloat(field === 'first_weight' ? value : next.first_weight);
        const second = parseFloat(field === 'second_weight' ? value : next.second_weight);
        if (!isNaN(first) && !isNaN(second)) {
          const netWeight = Math.round((first - second) * 1000) / 1000;
          next.tare_weight = String(netWeight);
          if (netWeight > 0) {
            netForLine = netWeight;
            netSourceUom = next.uom || 'KG';
          }
        } else if (field === 'tare_weight') {
          // User typed directly into the Net Weight field — honour it
          // even though normally it's computed.
          const manual = parseFloat(value);
          if (!isNaN(manual) && manual > 0) {
            netForLine = manual;
            netSourceUom = next.uom || 'KG';
          }
        }
      } else if (field === 'uom') {
        // Re-push current net value when the UOM dropdown changes so
        // the receipt-line conversion recalculates.
        const n = parseFloat(next.tare_weight);
        if (!isNaN(n) && n > 0) {
          netForLine = n;
          netSourceUom = value || 'KG';
        }
      }
      return next;
    }));

    // Map weighment row N → receipt line N by index. Convert from the
    // weighment UOM to the receipt-line UOM before writing the Net
    // Weight into the line's Received Quantity (`net_quantity` field).
    //
    // Unknown UOM fallback: receipt lines accept free-text UOMs (e.g.
    // "Labels" for a Machinery row) that aren't in the conversion
    // table. Fall back to copying the raw value and toast a warning so
    // the user knows to verify the unit makes sense.
    if (netForLine != null) {
      setReceiptLines(prev => prev.map((rl, i) => {
        if (i !== index) return rl;
        const targetUom = rl.uom || netSourceUom;
        const conv = convertUom(netForLine, netSourceUom, targetUom);
        if (conv.ok) {
          return { ...rl, net_quantity: String(conv.value) };
        }
        toast(
          `UOM mismatch (${netSourceUom} → ${targetUom}) on line ${i + 1}: copied raw Net Weight. Verify the unit.`,
          { icon: '⚠️', duration: 6000, id: `wt-uom-${i}-${netSourceUom}-${targetUom}` },
        );
        return { ...rl, net_quantity: String(netForLine) };
      }));
    }
  };
  const addWeighment = () => setWeighmentDetails(prev => [...prev, { ...emptyWeighmentDetail }]);
  const removeWeighment = (index) => setWeighmentDetails(prev => prev.filter((_, i) => i !== index));

  // ── Weighment slip extraction (Gemini) ────────────────────────────────
  // Per-row inline upload. Trigger sequence:
  //   1. User clicks the icon button in front of the Weighment Name input
  //   2. `triggerWeighmentExtract(idx)` records the target row & opens the
  //      shared hidden file input
  //   3. `handleWeighmentFileChange` reads the file, calls the API, and
  //      fills the target row in place
  const triggerWeighmentExtract = (idx) => {
    setWeighmentExtractRowIdx(idx);
    // small timeout so state commits before the click fires
    setTimeout(() => weighmentFileInputRef.current?.click(), 0);
  };
  const handleWeighmentFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (weighmentFileInputRef.current) weighmentFileInputRef.current.value = '';   // allow re-upload same file
    const idx = weighmentExtractRowIdx;
    setWeighmentExtractRowIdx(null);
    if (!file || idx == null) return;
    setExtractingRowIdx(idx);
    const toastId = toast.loading('Extracting weighment slip…');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiClient.post('/api/purchase/receipts/extract-weighment/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        // Gemini upload + extraction routinely exceeds the default 30s
        // timeout, especially when the primary→fallback chain kicks in.
        timeout: 120000,
      });
      toast.dismiss(toastId);
      if (res.data.extraction_status !== 'success') {
        toast.error('Weighment extraction failed — fill manually.');
        return;
      }
      const x = res.data.extracted || {};
      // Derive the Net Weight (= First − Second) for the autofill.
      // Prefer an explicitly-extracted tare_weight when the slip
      // already has a "Net" line; otherwise compute from First/Second.
      const fw = x.first_weight != null ? Number(x.first_weight) : null;
      const sw = x.second_weight != null ? Number(x.second_weight) : null;
      const extractedTare = x.tare_weight != null ? Number(x.tare_weight) : null;
      const computedNet = (fw != null && sw != null && !isNaN(fw) && !isNaN(sw))
        ? Math.round((fw - sw) * 1000) / 1000
        : null;
      const netWeight = (extractedTare != null && !isNaN(extractedTare) && extractedTare > 0)
        ? extractedTare
        : computedNet;

      setWeighmentDetails(prev => prev.map((line, i) => i === idx ? {
        ...line,
        weighment_name: x.weighment_name || line.weighment_name,
        weighment_number: x.weighment_number || line.weighment_number,
        first_weight: fw != null ? String(fw) : line.first_weight,
        second_weight: sw != null ? String(sw) : line.second_weight,
        // The 3rd column in the UI is now labelled "Net Weight" — back
        // it with the computed/extracted net.
        tare_weight: netWeight != null ? String(netWeight) : line.tare_weight,
        // Use the extracted UOM if present (e.g. "KG" from a slip that
        // prints "Gross Wt: 8520 kg"); otherwise keep whatever the user
        // already had selected.
        uom: x.uom || line.uom || 'KG',
      } : line));
      // Push the Net Weight (= cargo, NOT Second Weight which is the
      // empty truck) into the matching Receipt Line Item's Received
      // Quantity. Convert from the slip's UOM to the receipt line's UOM.
      if (netWeight != null && netWeight > 0) {
        const sourceUom = x.uom || 'KG';
        setReceiptLines(prev => prev.map((rl, i) => {
          if (i !== idx) return rl;
          const targetUom = rl.uom || sourceUom;
          const conv = convertUom(netWeight, sourceUom, targetUom);
          if (!conv.ok) {
            toast(
              `Weighment unit ${sourceUom} can't be auto-converted to line ${i + 1}'s UOM (${targetUom}). Enter Received Quantity manually.`,
              { icon: '⚠️', duration: 8000 },
            );
            return rl;
          }
          return { ...rl, net_quantity: String(conv.value) };
        }));
      }
      toast.success(`Weighment slip extracted${res.data.model_used ? ` (${res.data.model_used})` : ''}`);
    } catch (err) {
      toast.dismiss(toastId);
      toast.error(err.response?.data?.error || 'Failed to extract weighment slip');
    } finally {
      setExtractingRowIdx(null);
    }
  };

  // Freight Details handlers
  const handleFreightChange = (index, field, value) => {
    setFreightDetails(prev => prev.map((line, i) => i === index ? { ...line, [field]: value } : line));
  };
  const addFreightDetail = () => {
    const uom = receiptLines[0]?.uom || '';
    setFreightDetails(prev => [...prev, { ...emptyFreightDetail, quantity_uom: uom }]);
  };
  const removeFreightDetail = (index) => setFreightDetails(prev => prev.filter((_, i) => i !== index));

  // Wage Lines handlers
  const handleWageChange = (index, field, value) => {
    setWageLines(prev => prev.map((line, i) => i === index ? { ...line, [field]: value } : line));
  };
  const addWageLine = () => setWageLines(prev => [...prev, { ...emptyWageLine }]);
  const removeWageLine = (index) => setWageLines(prev => prev.filter((_, i) => i !== index));

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Validate quantities before submission
    const validLines = receiptLines.filter(l => l.product && l.quantity_received);
    for (let i = 0; i < validLines.length; i++) {
      const line = validLines[i];
      const qty = parseFloat(line.quantity_received) || 0;
      if (qty <= 0) {
        toast.error('Invoice quantity must be greater than 0.');
        return;
      }
      // Received Quantity is mandatory on every line being received.
      const net = parseFloat(line.net_quantity);
      if (line.net_quantity === '' || line.net_quantity == null || Number.isNaN(net) || net <= 0) {
        toast.error(`Line ${i + 1}: Received Quantity is required and must be greater than 0.`);
        return;
      }
      // Over-delivery is permitted by policy — no hard block here.
      // The Flagged Lines banner + save-time confirm dialog below
      // surface the deviation so the operator accepts it consciously.
    }

    // Save-time confirmation for any flagged lines (PO over-delivery or
    // physical-vs-invoice mismatch). Operator sees exactly which lines
    // and by how much, then clicks Confirm to proceed with the save.
    const flagged = validLines
      .map((l, i) => ({ line: l, flag: getReceiptLineFlag(l), index: i }))
      .filter(x => x.flag);
    if (flagged.length > 0) {
      // Require remarks on every flagged line
      for (const { line, index } of flagged) {
        if (!(line.remarks || '').trim()) {
          toast.error(`Line ${index + 1} (${line.item_name || 'item'}): Remarks is required when quantity differs from invoice.`);
          return;
        }
      }
      // Require at least one attachment when any line has a quantity deviation
      if (pendingAttachmentsRef.current.length === 0) {
        toast.error('At least one attachment (photo) is required when there is a quantity deviation.');
        return;
      }
      const bullets = flagged.map(({ line, flag, index }) => {
        const label = line.item_name || line._itemName || `Line ${index + 1}`;
        const parts = [];
        if (flag.overBy) parts.push(`over PO by +${flag.overBy} ${flag.uom}`);
        if (flag.mismatchBy)
          parts.push(
            flag.mismatchBy > 0
              ? `short vs invoice by ${flag.mismatchBy} ${flag.uom}`
              : `extra vs invoice by ${-flag.mismatchBy} ${flag.uom}`,
          );
        return `• ${label} — ${parts.join('; ')}`;
      }).join('\n');
      const ok = await confirm({
        title: `Confirm ${flagged.length} line${flagged.length > 1 ? 's' : ''} with quantity deviations`,
        message: `${bullets}\n\nSave the receipt with these deviations?`,
        confirmLabel: 'Confirm & save',
        isDangerous: false,
      });
      if (!ok) return;
    }

    // Transport details are mandatory — the lorry, driver and freight terms
    // must be recorded for every receipt. (Skipped for any field a role hides.)
    if (!isHidden('vehicle_number') && !(formData.vehicle_number || '').trim()) {
      toast.error('Lorry No is required under Transport Details.');
      return;
    }
    if (!isHidden('driver_name') && !(formData.driver_name || '').trim()) {
      toast.error('Driver Name is required under Transport Details.');
      return;
    }
    if (!isHidden('freight_terms') && !(formData.freight_terms || '').trim()) {
      toast.error('Freight Terms are required under Transport Details.');
      return;
    }

    // Freight attachment is compulsory when any freight detail is entered
    const hasFreightDetails = [
      formData.transporter_name, formData.freight_bill_no, formData.freight_bill_date,
    ].some(v => (v || '').toString().trim()) ||
      [formData.freight_value, formData.advance_amount].some(v => parseFloat(v) > 0);
    if (hasFreightDetails && pendingTransportAttachmentsRef.current.length === 0) {
      toast.error('Freight bill attachment is required when freight details are entered.');
      return;
    }

    // Damaged packing materials require attachment + remarks
    for (let i = 0; i < packingLines.length; i++) {
      const pk = packingLines[i];
      if (pk.condition !== 'DAMAGED') continue;
      if (!(pk.remarks || '').trim()) {
        toast.error(`Packing Material #${i + 1}: Remarks is required for damaged items.`);
        return;
      }
      if (!pk._damageFiles || pk._damageFiles.length === 0) {
        toast.error(`Packing Material #${i + 1}: Attachment (damage proof) is required for damaged items.`);
        return;
      }
    }

    setIsLoading(true);
    try {
      const cleaned = cleanFormData(formData);
      // Map po_no to linked_pos (M2M array)
      const poId = cleaned.po_no;
      delete cleaned.po_no;

      // Auto-detect partial receipt: compare received qty vs PO ordered qty
      let isPartial = false;
      if (poId) {
        const selectedPO = poRawData.find(po => po.id === poId);
        if (selectedPO) {
          const validLines = receiptLines.filter(l => l.product && l.quantity_received);
          for (const poLine of (selectedPO.po_lines || [])) {
            const receivedForProduct = validLines
              .filter(rl => rl.product === poLine.product_service)
              .reduce((sum, rl) => sum + (parseFloat(rl.quantity_received) || 0), 0);
            if (receivedForProduct < parseFloat(poLine.quantity_ordered || 0)) {
              isPartial = true;
              break;
            }
          }
        }
      }
      delete cleaned.partial_receipt_flag;

      const payload = {
        ...cleaned,
        // Multi-PO: send the primary PO plus any additional POs the
        // operator merged in. The backend ReceiptAdviceSerializer
        // handles `linked_pos` as a list; each receipt line already
        // carries its own po_line FK for line-level attribution.
        linked_pos: [poId, ...additionalPoIds].filter(Boolean),
        partial_receipt_flag: isPartial,
        receipt_lines: receiptLines.filter(l => l.product && l.quantity_received).map((l, i) => {
          const cleaned = cleanFormData(l);
          // cleanFormData() doesn't recognize `gst_percentage` as numeric so it
          // leaves '' in place — DRF rejects "" for a DecimalField. Drop both
          // gst_percentage and rate when blank so the backend stores null.
          if (cleaned.gst_percentage === '') delete cleaned.gst_percentage;
          if (cleaned.rate === '') delete cleaned.rate;
          // Same blank-→-null treatment for the optional dimension
          // fields. Sending '' would trip DRF's Decimal validator;
          // omitting the key lets the backend store NULL.
          for (const dimKey of ['length', 'breadth', 'width', 'weight']) {
            if (cleaned[dimKey] === '' || cleaned[dimKey] == null) {
              delete cleaned[dimKey];
            }
          }
          // Route the picked id to the correct FK based on item_type
          // so Machinery / Service receipt lines persist correctly.
          // Goods (default) keep using `product` — back-compat for the
          // existing flow. Strip helper-only fields from the payload.
          const itemType = (l.item_type || 'PRODUCT').toUpperCase();
          delete cleaned.item_type;
          delete cleaned.item_name;
          if (itemType === 'MACHINERY') {
            cleaned.machinery = l.product;
            delete cleaned.product;
          } else if (itemType === 'SERVICE') {
            cleaned.service_catalogue = l.product;
            delete cleaned.product;
            // Services don't move stock — drop the godown so the
            // backend's service-line check doesn't insist on one.
            delete cleaned.godown_location;
          }
          return { ...cleaned, line_no: i + 1 };
        }),
        packing_materials: packingLines
          .filter(l => l.packaging_sku && l.quantity)
          .map(l => {
            const c = cleanFormData(l);
            // Strip underscore-prefixed display helpers (item name,
            // PO qty / rcvd snapshot, po-uom). Backend ignores
            // unknown keys but trimming keeps DEV logs readable.
            for (const k of Object.keys(c)) if (k.startsWith('_')) delete c[k];
            // Blank Decimal-cell normalisation — DRF rejects ''.
            // Empty dimension / net-qty cells → null so the backend
            // stores NULL rather than coercing to 0.
            for (const k of ['length', 'breadth', 'width', 'weight', 'net_quantity']) {
              if (c[k] === '' || c[k] == null) delete c[k];
            }
            // Optional FK cells.
            if (c.po_line === '') delete c.po_line;
            if (c.godown_location === '') delete c.godown_location;
            return c;
          }),
        weighment_details: weighmentDetails
          .filter(l => l.weighment_name || l.weighment_number || l.first_weight || l.second_weight || l.tare_weight)
          .map(l => cleanFormData(l)),
        freight_details: freightDetails.filter(l => l.freight_type || l.transporter || l.tentative_charge).map(l => cleanFormData(l)),
        loading_unloading_wages: wageLines.filter(l => l.contractor_vendor).map(l => cleanFormData(l)),
      };
      if (import.meta.env.DEV) console.log('[CreateReceiptAdvice] payload:', payload);
      const res = await apiClient.post('/api/purchase/receipts/', payload);
      const newId = res.data?.id;

      if (pendingTransportAttachments.length > 0 && newId) {
        await uploadPendingFiles('RECEIPT', newId, pendingTransportAttachmentsRef.current, 'TRANSPORT');
      }
      if (pendingAttachments.length > 0 && newId) {
        await uploadPendingFiles('RECEIPT', newId, pendingAttachmentsRef.current, 'GENERAL');
      }
      // Upload damage proof attachments for damaged packing lines
      for (const pk of packingLines) {
        if (pk.condition === 'DAMAGED' && pk._damageFiles?.length > 0 && newId) {
          await uploadPendingFiles('RECEIPT', newId, pk._damageFiles, 'DAMAGE_PROOF');
        }
      }

      toast.success('Receipt Advice created successfully!');
      const adn = res.data?.auto_debit_note;
      if (adn?.credit_no) {
        toast.success(`Debit Note ${adn.credit_no} auto-generated (₹${adn.total_amount})`, { duration: 6000 });
      }
      navigate('/purchase/receipts');
    } catch (error) {
      if (import.meta.env.DEV) console.error('[CreateReceiptAdvice] error:', error.response?.data);
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  // ── Auto Fill (AI): upload handler + form mapping ──────────────────────
  const handleAIUpload = async (file) => {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      toast.error('File too large. Max 20 MB.');
      return;
    }
    setUploadedFile(file);
    setExtractResult(null);
    setIsExtracting(true);
    const t = toast.loading('Extracting receipt data…');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiClient.post('/api/purchase/receipts/extract/', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        // Gemini PDF/image extraction can take up to ~2 min including the
        // primary→fallback retry. Default axios timeout (30s) was killing
        // the request mid-flight; match gunicorn's 120s.
        timeout: 120000,
      });
      setExtractResult(res.data);
      toast.dismiss(t);

      const modelTag = res.data.model_used ? ` (${res.data.model_used})` : '';
      if (res.data.extraction_status === 'failed') {
        toast.error(`Extraction failed${modelTag}. See diagnostics.`);
      } else if (res.data.extraction_status === 'partial') {
        toast(`Extraction partial${modelTag} — review fields.`, { icon: '⚠️' });
      } else {
        toast.success(`Receipt extracted${modelTag}`);
      }
      (res.data.warnings || []).slice(0, 5).forEach(w => toast(w, { icon: '⚠️', duration: 6000 }));
      applyReceiptExtraction(res.data);
    } catch (err) {
      toast.dismiss(t);
      if (import.meta.env.DEV) console.error('[ReceiptExtract] error:', err.response?.data || err);
      toast.error(err.response?.data?.error || 'Failed to extract receipt');
    } finally {
      setIsExtracting(false);
    }
  };

  const applyReceiptExtraction = async (data) => {
    if (!data || typeof data !== 'object') return;
    if (import.meta.env.DEV) console.log('[ReceiptExtract] raw response:', data);
    const warnings = [];
    const updates = {};

    // Direct text-only header fields.
    if (data.receipt_date) updates.receipt_date = data.receipt_date;
    // Driver: Gemini's schema has only `driver_name` (no `driver_phone`),
    // so when the document prints both, the model often puts the phone
    // number into driver_name — either alone ("9505464816") or after the
    // name ("Ramesh 9505464816"). Split here so the phone lands on the
    // correct field and the name field doesn't show as a number.
    if (data.driver_name) {
      const raw = String(data.driver_name).trim();
      // Match a 10-15 digit run (with optional +, spaces, hyphens) anywhere in the string.
      const phoneMatch = raw.match(/(\+?\d[\d\s\-]{8,14}\d)/);
      if (phoneMatch) {
        const phone = phoneMatch[0].replace(/[\s\-]/g, '');
        const namePart = raw.replace(phoneMatch[0], '').replace(/[,;:|]/g, ' ').trim();
        updates.driver_phone = phone;
        if (namePart) updates.driver_name = namePart;
        // else: leave driver_name empty so the user knows to fill it.
      } else {
        updates.driver_name = raw;
      }
    }
    // Explicit driver_phone from the extractor (future-proof — schema
    // doesn't expose it today but if it gets added, prefer the explicit
    // value over the regex split above).
    if (data.driver_phone) updates.driver_phone = String(data.driver_phone).trim();
    if (data.vehicle_no) updates.vehicle_number = data.vehicle_no;
    if (data.lr_no) updates.lr_no = data.lr_no;
    if (data.freight_terms) updates.freight_terms = data.freight_terms;
    if (data.freight_value != null && data.freight_value !== '') updates.freight_value = String(data.freight_value);
    if (data.advance_amount != null && data.advance_amount !== '') updates.advance_amount = String(data.advance_amount);
    if (data.remarks) updates.remarks = data.remarks;

    // Direct Receipt fields — invoice metadata extracted from the
    // vendor doc. These only have UI in Direct mode, but it's harmless
    // to populate them in PO mode too (they're persisted and queryable).
    if (data.invoice_no) updates.invoice_no = data.invoice_no;
    if (data.invoice_date) updates.invoice_date = data.invoice_date;
    if (data.invoice_amount != null && data.invoice_amount !== '') {
      updates.invoice_amount = String(data.invoice_amount);
    }

    // PO No — exact match against existing PO list, then AWAIT the PO
    // fetch so the line-item matching block below has fresh PO lines
    // available. The previous version fire-and-forgot handlePOChange()
    // and then synchronously called setReceiptLines using stale poLines
    // state, which is why "extracted lines weren't filling in" — the
    // async handler's own setReceiptLines clobbered the extraction's.
    let selectedPO = null;
    let resolvedPoLines = [];
    const poNo = (data.po_no || '').trim();
    if (poNo) {
      const match = poRawData.find(p => (p.po_no || '').trim() === poNo);
      if (match) {
        updates.po_no = match.id;
        try {
          const poRes = await apiClient.get(`/api/purchase/orders/${match.id}/`);
          selectedPO = poRes.data;
          resolvedPoLines = selectedPO?.po_lines || [];
          if (selectedPO?.company) setSelectedCompany(selectedPO.company);
          if (selectedPO?.vendor) updates.vendor = selectedPO.vendor;
          if (selectedPO?.warehouse) updates.warehouse = selectedPO.warehouse;
          // Push PO lines into state so the form's PO summary panel and
          // any haystack rebuilds (re-open modal) see them.
          setPoLines(resolvedPoLines);
        } catch (err) {
          if (import.meta.env.DEV) console.error('[ReceiptExtract] PO fetch failed:', err);
          warnings.push(`Could not load PO ${poNo} details — receipt lines may not auto-match.`);
        }
      } else {
        warnings.push(`PO "${poNo}" not found — pick from dropdown.`);
      }
    }

    // Vendor — exact match against vendor master, else warn. Skipped if
    // PO already set the vendor above (PO is authoritative).
    if (!updates.vendor) {
      const vendorName = (data.vendor_name || '').trim();
      if (vendorName) {
        const match = vendorRaw.find(v =>
          (v.vendor_name || '').trim().toLowerCase() === vendorName.toLowerCase()
        );
        if (match) {
          updates.vendor = match.id;
        } else {
          warnings.push(`Vendor "${vendorName}" not found in master — please select manually.`);
        }
      }
    }

    // Transporter — exact match.
    const tpName = (data.transporter || '').trim();
    if (tpName) {
      const match = transporterOptions.find(o => (o.label || '').toLowerCase() === tpName.toLowerCase());
      // transporterOptions don't expose IDs the same way; we just leave the name as remarks fallback if no match.
      if (!match) {
        warnings.push(`Transporter "${tpName}" not found — set manually if needed.`);
      }
    }

    setFormData(prev => ({ ...prev, ...updates }));

    // Linked PR's godown — fetch ONCE upfront so every receipt line can
    // pick it up below without each line firing its own request.
    let prGodown = '';
    if (selectedPO?.linked_prs?.length) {
      try {
        const prRes = await apiClient.get(`/api/purchase/requests/${selectedPO.linked_prs[0]}/`);
        prGodown = prRes.data?.godown || '';
      } catch { /* ignore */ }
    }

    // Line items — matching behaviour depends on receipt source:
    //
    //   PO Receipt:
    //     Compare ONLY against the selected PO's products (poLines).
    //     The dropdown must never leak full-master items in this mode —
    //     the user explicitly selected a PO so the only valid receipt
    //     targets are that PO's lines.
    //     Resolution order:
    //       1. Exact SKU match on a PO line  → silent
    //       2. Exact name match on a PO line → silent
    //       3. Fuzzy ≥ FUZZY_AUTOFILL on PO  → silent auto-fill
    //       4. Otherwise                     → queue for popup
    //
    //   Direct Receipt:
    //     No PO to compare against. We silently auto-match against the
    //     full Product master (exact SKU → exact name → fuzzy ≥ 0.50).
    //     Anything that still doesn't match is left as a blank-product
    //     row; the user picks from the master dropdown (which already
    //     lists every product) or fills manually. No popup is shown.
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length > 0) {
      // Source PO products from the locally-resolved fetch result
      // (`resolvedPoLines`) — not from `poLines` state — because the
      // state update from setPoLines above hasn't propagated yet in
      // this synchronous closure. Using stale state was the original
      // cause of "no PO products to compare against" warnings even
      // though a PO had been auto-selected.
      const poProducts = (resolvedPoLines || []).map((pl) => ({
        id: pl.product_service || pl.machinery || pl.service_catalogue || pl.product,
        name: pl.item_name || pl.product_name || pl.machinery_name || pl.service_catalogue_name || '',
        sku: pl.item_code || pl.product_code || pl.sku_code || '',
        po_line_id: pl.id || '',
        uom: pl.uom || '',
        quantity_ordered: pl.quantity_ordered || 0,
        item_type: pl.item_type || 'PRODUCT',
        pr_godown: pl.pr_godown || '',
        // Category from the originating PR line. Used after matching
        // to route packing-material lines into the Packing Materials
        // subform instead of Receipt Line Items. See partition below.
        category: pl.pr_line_category || '',
      })).filter(p => p.id);
      const masterAsHaystack = (productRaw || []).map((p) => ({
        id: p.id, name: p.product_name || '', sku: p.sku_code || '', po_line_id: '', uom: '', quantity_ordered: 0,
        // In Direct Receipt mode there's no PR line to inherit from,
        // so we fall back to the product master's goods_sub_type. A
        // Product flagged as PACKING_MATERIAL on the master is treated
        // as packing material here too — matches how the PR form
        // pre-fills its Category dropdown for the same product.
        category: p.goods_sub_type || '',
      }));
      // PO mode: only PO products. Direct mode: full master. No more
      // silent fallback to master in PO mode — if a PO has no lines
      // the modal will surface the "No PO products to compare against"
      // warning instead of leaking the master into the dropdown.
      const haystack = isDirectReceipt ? masterAsHaystack : poProducts;

      const queue = [];

      const newLines = items.map((it, idx) => {
        const pName = (it.product_name || '').trim();
        const pCode = (it.product_code || '').trim();
        let match = null;
        let matchSource = '';

        if (pCode) {
          match = haystack.find(p => (p.sku || '').trim().toLowerCase() === pCode.toLowerCase());
          if (match) matchSource = 'sku';
        }
        if (!match && pName) {
          match = haystack.find(p => (p.name || '').trim().toLowerCase() === pName.toLowerCase());
          if (match) matchSource = 'name';
        }

        // Compute fuzzy candidates for auto-fill or modal.
        const scored = haystack.map((p) => {
          const sName = diceSimilarity(pName, p.name);
          const sSku = pCode && p.sku ? diceSimilarity(pCode, p.sku) : 0;
          return { candidate: p, score: Math.max(sName, sSku) };
        }).sort((a, b) => b.score - a.score);

        if (!match && scored.length && scored[0].score >= FUZZY_AUTOFILL) {
          match = scored[0].candidate;
          matchSource = 'fuzzy';
        }

        // Anything still unmatched goes into the popup queue.
        //   PO Receipt    → "Use PO product" + "Remove line"
        //   Direct Receipt → "Use master product" + "Create new" + "Remove line"
        // The modal reads `mode` from the parent to render the right pills.
        if (!match && (pName || pCode)) {
          const top = scored[0] || null;
          queue.push({
            idx,
            extracted_name: pName || (it.description || '').trim() || '(name not extracted)',
            extracted_code: pCode,
            extracted_qty: it.quantity != null ? String(it.quantity) : '',
            extracted_uom: it.uom || '',
            extracted_rate: it.rate != null ? String(it.rate) : '',
            suggested: top ? {
              id: top.candidate.id,
              name: top.candidate.name,
              sku: top.candidate.sku,
              po_line_id: top.candidate.po_line_id,
              uom: top.candidate.uom,
            } : null,
            suggested_score: top ? top.score : null,
            all_po_products: haystack,
          });
        }

        return {
          // Carry the matched PO line's item_type so the save path
          // routes the FK (product / machinery / service_catalogue)
          // correctly. Goods is the default.
          item_type: (match?.item_type || 'PRODUCT').toUpperCase(),
          product: match ? match.id : '',
          item_name: match?.name || pName || '',
          po_line: match ? (match.po_line_id || '') : '',
          quantity_received: it.quantity != null ? String(it.quantity) : '',
          _extractedQty: it.quantity != null ? String(it.quantity) : '',
          net_quantity: '',
          batch_no: it.batch_no || '',
          uom: it.uom || match?.uom || 'KG',
          po_quantity: match?.quantity_ordered || 0,
          // Inherit godown from the matched PO line (per-line PR godown
          // resolved server-side) or fall back to the PR's header godown
          // fetched once above. User can still override.
          godown_location: match?.pr_godown || prGodown || '',
          remarks: it.remarks || (pName ? `${pName}${pCode ? ' (' + pCode + ')' : ''}` : ''),
          is_debit_note: false,
          // Pull rate / GST from the extracted invoice — these are the
          // Direct Receipt's line-level pricing fields. In PO mode they
          // get overridden when the PO line is later auto-applied.
          rate: it.rate != null && it.rate !== '' ? String(it.rate) : '',
          gst_percentage: it.tax != null && it.tax !== '' ? String(it.tax) : '',
          _matched: !!match,
          _matchSource: matchSource,
          _unresolved: !match && !!(pName || pCode),
          _productName: pName || pCode,
          _extractedName: pName,
          _extractedCode: pCode,
          // Source category — read off the matched haystack entry.
          // poProducts carries it from pl.pr_line_category; the master
          // haystack from p.goods_sub_type. Drives the partition below.
          //
          // Final fallback chain when the haystack didn't carry one:
          //   1. match.category                            (already set)
          //   2. product master's goods_sub_type           (PO mode, legacy
          //      PO lines where pr_line_category is empty)
          //   3. extracted item's own category field        (vendor doc
          //      occasionally tags lines explicitly)
          // Each tier only fires when the prior produced nothing. The
          // operator can still drag a row across manually if the doc
          // and the PR disagree.
          _category: (() => {
            const fromMatch = (match?.category || '').toString().trim().toUpperCase();
            if (fromMatch) return fromMatch;
            // Look up the product master by the matched id and check
            // its goods_sub_type. This rescues legacy POs whose
            // linked_pr_line + RFQ chain both yielded empty.
            if (match?.id && Array.isArray(productRaw)) {
              const masterRow = productRaw.find(p => p.id === match.id);
              const sub = (masterRow?.goods_sub_type || '').toString().trim().toUpperCase();
              if (sub) return sub;
            }
            // Vendor doc sometimes tags the line itself.
            const fromExtracted = (it.category || '').toString().trim().toUpperCase();
            if (fromExtracted) return fromExtracted;
            return '';
          })(),
        };
      });

      // Partition the extracted lines: PACKING_MATERIAL ones go to the
      // Packing Materials subform, everything else stays in Receipt
      // Line Items. Same routing rule the PO-fetch path uses (see
      // isPackingMaterialPoLine + poLineToPackingRow) so document
      // extraction and direct PO selection produce identical results.
      const isPM = l => l._category === 'PACKING_MATERIAL';
      const goodsExtracted = newLines.filter(l => !isPM(l));
      const packingExtracted = newLines.filter(isPM);

      setReceiptLines(goodsExtracted);
      if (packingExtracted.length > 0) {
        // Map the receipt-line shape down to the packing-line shape.
        // We only need product / quantity / uom on this side; condition
        // defaults to NEW. The operator can edit either side.
        setPackingLines(prev => {
          const fromExtraction = packingExtracted.map(l => ({
            packaging_sku: l.product || '',
            quantity: l.quantity_received || '',
            uom: l.uom || 'PCS',
            condition: 'NEW',
            _itemName: l.item_name || '',
            _poLineId: l.po_line || '',
            _extractedName: l._extractedName || '',
            _extractedCode: l._extractedCode || '',
          }));
          // If the operator already auto-filled packing lines from a
          // PO fetch BEFORE running extraction (rare but possible),
          // keep those rows and append the newly-extracted ones de-
          // duplicated by packaging_sku so the table doesn't show the
          // same item twice.
          const seen = new Set(prev.map(p => p.packaging_sku).filter(Boolean));
          const merged = [...prev];
          for (const row of fromExtraction) {
            if (row.packaging_sku && seen.has(row.packaging_sku)) continue;
            merged.push(row);
            if (row.packaging_sku) seen.add(row.packaging_sku);
          }
          return merged;
        });
      }
      if (import.meta.env.DEV) {
        console.log('[ReceiptExtract] applied', {
          items: items.length,
          matched: newLines.filter(l => l._matched).length,
          unresolved: newLines.filter(l => l._unresolved).length,
          queueForModal: queue.length,
        });
      }

      if (queue.length) {
        setMismatchRows(queue);
        setMismatchOpen(true);
      }
    } else if (resolvedPoLines.length > 0) {
      // No line items in the extracted document but we did resolve a PO.
      // Seed receipt lines from the PO directly so the user isn't left
      // with an empty table — same default as handlePOChange(), and
      // same packing-material routing.
      const goodsLines = resolvedPoLines.filter(pl => !isPackingMaterialPoLine(pl, productRaw));
      const packingPoLines = resolvedPoLines.filter(pl => isPackingMaterialPoLine(pl, productRaw));

      setReceiptLines(goodsLines.map(pl => ({
        item_type: (pl.item_type || 'PRODUCT').toUpperCase(),
        product: pl.product_service || pl.machinery || pl.service_catalogue || '',
        item_name: pl.item_name || pl.product_name || '',
        po_line: pl.id || '',
        quantity_received: '',
        po_quantity: pl.quantity_ordered || 0,
        already_received: pl.received_quantity || 0,
        uom: pl.uom || 'KG',
        batch_no: '',
        godown_location: pl.pr_godown || prGodown || '',
        remarks: '',
        is_debit_note: false,
      })));
      if (packingPoLines.length > 0) {
        setPackingLines(packingPoLines.map(poLineToPackingRow));
      }
    }

    warnings.forEach(w => toast(w, { icon: '⚠️', duration: 6000 }));
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Receipt Advice"
        breadcrumbs={[
          { label: 'Purchase', href: '/purchase/receipts' },
          { label: 'Receipts', href: '/purchase/receipts' },
          { label: 'Create Receipt Advice' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-3">
          {/* ── Receipt Source + Fill Mode — one combined panel.
              Source pills are coloured (primary / amber) so the active mode
              is visible at a glance; Fill Mode pills sit beside them
              separated by a subtle divider, keeping the header compact. */}
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex items-center gap-x-4 sm:gap-x-6 gap-y-3 flex-wrap">
              {/* Source group */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Source</span>
                <div className="inline-flex rounded-lg border border-slate-200 bg-white overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setFormData(p => ({ ...p, receipt_source: 'AGAINST_PO', direct_reason: '' }))}
                    className={`px-3 py-1.5 text-sm font-medium transition ${!isDirectReceipt ? 'bg-primary-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
                    title="Receive against an existing PO or Job Work"
                  >
                    PO Receipt
                  </button>
                  {canUseDirectReceipt && (
                    <button
                      type="button"
                      onClick={() => setFormData(p => ({ ...p, receipt_source: 'DIRECT', po_no: '', job_work_no: '' }))}
                      className={`px-3 py-1.5 text-sm font-medium border-l border-slate-200 transition ${isDirectReceipt ? 'bg-amber-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
                      title="No PO — emergency / sample / opening stock"
                    >
                      Direct Receipt
                    </button>
                  )}
                </div>
              </div>

              <span className="h-6 w-px bg-slate-300 hidden md:inline-block" aria-hidden />

              {/* Fill mode group */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Fill Mode</span>
                <div className="inline-flex rounded-lg border border-slate-200 bg-white overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setFillMode('manual')}
                    className={`px-3 py-1.5 text-sm font-medium transition ${fillMode === 'manual' ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
                    title={isDirectReceipt ? 'Type vendor / product / rate by hand' : 'Select PO to auto-fill from order data'}
                  >
                    Manual
                  </button>
                  <button
                    type="button"
                    onClick={() => setFillMode('autofill')}
                    className={`px-3 py-1.5 text-sm font-medium border-l border-slate-200 transition ${fillMode === 'autofill' ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
                    title="Upload invoice / DC / GRN to auto-extract"
                  >
                    Auto Fill (AI)
                  </button>
                </div>
              </div>

              {/* Inline helper text on the right, contextual to source choice */}
              <p className="text-xs text-slate-500 ml-auto max-w-md text-right">
                {isDirectReceipt
                  ? 'No PO upstream — fill vendor, product, rate, GST manually or upload an invoice.'
                  : 'Auto-fills vendor / lines from the selected PO. Switch to AI to extract from a vendor invoice.'}
              </p>
            </div>
          </div>

          {/* ── AI Document Upload (Auto Fill mode only) ─────────────── */}
          {fillMode === 'autofill' && (
            <div className="rounded-lg border border-slate-200 p-4">
              <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Extract Receipt Data</h3>
              {!uploadedFile && (
                <div
                  onClick={() => aiFileInputRef.current?.click()}
                  className="cursor-pointer rounded-lg border-2 border-dashed border-slate-300 hover:border-primary-500 hover:bg-primary-50/30 transition p-8 text-center"
                >
                  <p className="text-sm text-slate-600">Click to upload an invoice / DC / GRN</p>
                  <p className="text-xs text-slate-400 mt-1">PDF, JPG, PNG, DOCX, XLSX · max 20 MB</p>
                  <input
                    ref={aiFileInputRef}
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png,.docx,.xlsx"
                    className="hidden"
                    onChange={(e) => handleAIUpload(e.target.files?.[0])}
                  />
                </div>
              )}
              {uploadedFile && (
                <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 bg-white">
                  <div className="flex items-center gap-3">
                    <span className="inline-flex items-center justify-center w-10 h-10 rounded bg-slate-100 text-xs font-semibold text-slate-600">
                      {(uploadedFile.name.split('.').pop() || 'FILE').toUpperCase().slice(0, 4)}
                    </span>
                    <div>
                      <div className="text-sm font-medium text-slate-800">{uploadedFile.name}</div>
                      <div className="text-xs text-slate-500">{(uploadedFile.size / 1024).toFixed(1)} KB</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {isExtracting && <span className="text-sm text-slate-500">Extracting…</span>}
                    {!isExtracting && extractResult && extractResult.extraction_status === 'success' && (
                      <span className="text-sm text-emerald-600 font-medium">✓ Extracted</span>
                    )}
                    {!isExtracting && extractResult && extractResult.extraction_status === 'partial' && (
                      <span className="text-sm text-amber-600 font-medium">⚠ Partial</span>
                    )}
                    {!isExtracting && extractResult && extractResult.extraction_status === 'failed' && (
                      <span className="text-sm text-red-500 font-medium">✗ Failed</span>
                    )}
                    <button
                      type="button"
                      onClick={() => { setUploadedFile(null); setExtractResult(null); if (aiFileInputRef.current) aiFileInputRef.current.value = ''; }}
                      className="rounded p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 transition"
                      title="Remove file"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}

              {/* Diagnostics panel */}
              {extractResult && (
                <details className="mt-3 rounded-lg border border-slate-200 bg-slate-50 text-xs">
                  <summary className="cursor-pointer select-none px-3 py-2 font-medium text-slate-700 hover:bg-slate-100">
                    Extraction diagnostics ({extractResult.model_used || 'gemini'} · status: {extractResult.extraction_status || 'unknown'})
                  </summary>
                  <div className="px-3 py-2 space-y-2 font-mono">
                    <div><span className="text-slate-500">model_used:</span> {extractResult.model_used || '—'}</div>
                    <div><span className="text-slate-500">extraction_status:</span> {extractResult.extraction_status || '—'}</div>
                    {extractResult.missing_fields?.length > 0 && (
                      <div><span className="text-slate-500">missing_fields:</span> <span className="text-red-600">{extractResult.missing_fields.join(', ')}</span></div>
                    )}
                    {(extractResult.attempts || []).map((a, i) => (
                      <div key={i} className="border-t border-slate-200 pt-2 mt-2">
                        <div className="text-slate-700 font-semibold">Attempt #{i + 1} · {a.model}</div>
                        <div><span className="text-slate-500">status:</span> {a.status}</div>
                        {a.upload_path && <div><span className="text-slate-500">upload_path:</span> {a.upload_path}</div>}
                        {a.finish_reason && <div><span className="text-slate-500">finish_reason:</span> {a.finish_reason}</div>}
                        {a.response_preview && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-slate-600">response_preview ({a.response_length} chars)</summary>
                            <pre className="mt-1 whitespace-pre-wrap bg-white border border-slate-200 rounded p-2 text-slate-700 max-h-40 overflow-auto">{a.response_preview}</pre>
                          </details>
                        )}
                      </div>
                    ))}
                    {extractResult.warnings?.length > 0 && (
                      <div className="border-t border-slate-200 pt-2 mt-2">
                        <div className="text-slate-700 font-semibold">Warnings</div>
                        <ul className="list-disc list-inside text-slate-700">
                          {extractResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                </details>
              )}
            </div>
          )}

          {/* Receipt Details */}
          <div>
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Receipt Details</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-3 gap-y-2">
              {!isDirectReceipt && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">PO No <span className="text-red-500">*</span></label>
                {searchParams.get('po_id') && formData.po_no ? (
                  <input type="text" readOnly value={prefillPoNo || 'Loading...'} className={`${inputClass} bg-slate-50 cursor-not-allowed`} />
                ) : (
                  <CustomSelect name="po_no" value={formData.po_no} onChange={handlePOChange} required={!formData.job_work_no} disabled={!!formData.job_work_no} className={`${inputClass} ${formData.job_work_no ? 'bg-slate-50 cursor-not-allowed' : ''}`}>
                    <option value="">{formData.job_work_no ? '— receiving against Job Work —' : 'Select PO'}</option>
                    {poOptions
                      // Once a vendor is picked (manually or auto-filled
                      // from the prior PO pick), restrict the PO list to
                      // that vendor's POs — multi-PO receipts are always
                      // per-vendor.
                      .filter(o => !formData.vendor || o.vendor === formData.vendor)
                      .map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                )}
                {/* Multi-PO chips + add button — only when a primary PO
                    is picked (chips need a vendor to filter against). */}
                {formData.po_no && !formData.job_work_no && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {additionalPoIds.map(id => {
                      const po = poRawData.find(p => p.id === id);
                      const label = po ? (po.po_no || id) : id;
                      return (
                        <span
                          key={id}
                          className="inline-flex items-center gap-1 rounded-full bg-primary-50 border border-primary-200 px-2 py-0.5 text-xs text-primary-700"
                          title={po?.vendor_name || ''}
                        >
                          + {label}
                          <button
                            type="button"
                            onClick={() => removeAdditionalPO(id)}
                            className="ml-0.5 text-primary-500 hover:text-red-600"
                            aria-label={`Remove ${label}`}
                          >
                            ×
                          </button>
                        </span>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => {
                        setAddPoModalSelection([]);
                        setAddPoModalOpen(true);
                      }}
                      className="text-xs text-primary-600 hover:text-primary-800 hover:underline"
                    >
                      + Add another PO
                    </button>
                  </div>
                )}
              </div>
              )}
              {/* Job Work No is only relevant in Direct Receipt mode —
                  receiving returned materials from a Job Work order. In
                  PO Receipt mode the source is already the PO, so the
                  field is hidden to keep the form uncluttered. */}
              {isDirectReceipt && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Job Work No</label>
                <CustomSelect
                  name="job_work_no"
                  value={formData.job_work_no}
                  onChange={handleJobWorkChange}
                  className={inputClass}
                  title="Receive materials against an open Job Work Order"
                >
                  <option value="">Select Job Work (optional)</option>
                  {jobWorkOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              )}
              {!isHidden('vendor') && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Vendor <span className="text-red-500">*</span></label>
                <CustomSelect name="vendor" value={formData.vendor} onChange={handleChange} required disabled={isReadOnly('vendor')} className={isReadOnly('vendor') ? lockedInputClass : inputClass}>
                  <option value="">Select Vendor</option>
                  {vendorOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Company <span className="text-red-500">*</span></label>
                {formData.po_no ? (
                  <input type="text" readOnly value={companyOptions.find(c => c.value === selectedCompany)?.label || 'Loading...'} className={`${inputClass} bg-slate-50 cursor-not-allowed`} />
                ) : (
                  <CustomSelect value={selectedCompany} onChange={(e) => { setSelectedCompany(e.target.value); setFormData(prev => ({ ...prev, warehouse: '' })); }} required className={inputClass}>
                    <option value="">Select Company</option>
                    {companyOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                )}
              </div>
              {!isHidden('warehouse') && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Warehouse <span className="text-red-500">*</span></label>
                {formData.po_no ? (
                  <input type="text" readOnly value={warehouseOptions.find(w => w.value === formData.warehouse)?.label || 'Loading...'} className={`${inputClass} bg-slate-50 cursor-not-allowed`} />
                ) : (
                  <CustomSelect name="warehouse" value={formData.warehouse} onChange={(e) => { setFormData(prev => ({ ...prev, warehouse: e.target.value })); }} required disabled={isReadOnly('warehouse')} className={isReadOnly('warehouse') ? lockedInputClass : inputClass}>
                    <option value="">Select Warehouse</option>
                    {warehouseOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                )}
              </div>
              )}
              {!isHidden('receipt_date') && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Receipt Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="receipt_date" value={formData.receipt_date} onChange={handleChange} required disabled={isReadOnly('receipt_date')} className={isReadOnly('receipt_date') ? lockedInputClass : inputClass} />
              </div>
              )}
              {/* Invoice No — shown in BOTH modes (was previously only inside
                  the Direct Receipt Info section). Vendor invoice number is
                  useful evidence on a PO receipt too. */}
              {!isHidden('invoice_no') && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Invoice No</label>
                <input
                  type="text"
                  name="invoice_no"
                  value={formData.invoice_no}
                  onChange={handleChange}
                  disabled={isReadOnly('invoice_no')}
                  className={isReadOnly('invoice_no') ? lockedInputClass : inputClass}
                  placeholder="Vendor invoice number"
                />
              </div>
              )}
            </div>
          </div>

          {/* Direct Receipt Info — only when receipt_source = DIRECT.
              Captures the justification + vendor invoice reference so this
              GRN can be reconciled / billed later without a PO. */}
          {isDirectReceipt && (
            <div>
              <h3 className="text-sm sm:text-base font-semibold text-amber-700 mb-2 pb-1.5 border-b border-amber-200">
                Direct Receipt Info
                <span className="ml-2 text-xs font-normal text-amber-600">Required when no PO is selected</span>
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-3 gap-y-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-0.5">
                    Reason <span className="text-red-500">*</span>
                  </label>
                  <CustomSelect
                    name="direct_reason"
                    value={formData.direct_reason}
                    onChange={handleChange}
                    required
                    className={inputClass}
                  >
                    <option value="">Select Reason</option>
                    {DIRECT_REASON_CHOICES.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </CustomSelect>
                </div>
                {/* Invoice No moved to the Receipt Details section above
                    so it's always visible (both PO and Direct modes). */}
                {!isHidden('invoice_date') && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-0.5">Invoice Date</label>
                  <CustomDatePicker
                    name="invoice_date"
                    value={formData.invoice_date}
                    onChange={handleChange}
                    disabled={isReadOnly('invoice_date')}
                    className={isReadOnly('invoice_date') ? lockedInputClass : inputClass}
                  />
                </div>
                )}
                {!isHidden('invoice_amount') && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-0.5">Invoice Amount</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="invoice_amount"
                    value={formData.invoice_amount}
                    onChange={handleChange}
                    disabled={isReadOnly('invoice_amount')}
                    className={isReadOnly('invoice_amount') ? lockedInputClass : inputClass}
                    placeholder="0.00"
                  />
                </div>
                )}
              </div>
            </div>
          )}

          {/* Weighment Details — placed BEFORE Transport Details (user
              preference). The extracted Tare (net) Weight still flows
              down into each receipt line's Net Quantity automatically
              because that mapping is driven by row index, not by render
              order. */}
          <div>
            <input
              ref={weighmentFileInputRef}
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={handleWeighmentFileChange}
            />
            <div className="flex items-center justify-between mb-2 pb-1.5 border-b">
              <h3 className="text-sm sm:text-base font-semibold text-slate-800">Weighment Details</h3>
              <button type="button" onClick={addWeighment} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100">
                <Plus size={16} /> Add Weighment
              </button>
            </div>
            {weighmentDetails.length === 0 ? (
              <p className="text-sm text-slate-400 italic">No weighment details added. Click "Add Weighment" to record weighbridge readings.</p>
            ) : (
              <div className="overflow-x-auto ios-scroll">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                      <th className="text-left px-3 py-2 font-medium text-slate-600">#</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Weighment Name</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Weighment No</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">First Weight</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Second Weight</th>
                      {/* Column label is "Net Weight" in the UI (= First −
                          Second = cargo weight); backing field stays
                          `tare_weight` so the data model / API don't need
                          to change. */}
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Net Weight</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {weighmentDetails.map((line, index) => (
                      <tr key={index} className="border-b">
                        <td className="px-3 py-2 text-slate-500">{index + 1}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => triggerWeighmentExtract(index)}
                              disabled={extractingRowIdx === index}
                              title="Upload weighbridge slip — AI auto-fills this row"
                              className="flex-shrink-0 inline-flex items-center gap-1 h-9 px-2.5 rounded-md border border-emerald-200 bg-gradient-to-b from-white to-emerald-50 text-emerald-700 hover:from-emerald-50 hover:to-emerald-100 hover:border-emerald-300 active:from-emerald-100 disabled:opacity-50 disabled:cursor-not-allowed transition shadow-sm text-xs font-medium"
                            >
                              {extractingRowIdx === index ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <ScanLine size={14} />
                              )}
                              <span>AI</span>
                            </button>
                            <input type="text" value={line.weighment_name} onChange={(e) => handleWeighmentChange(index, 'weighment_name', e.target.value)} placeholder="Weighbridge name" className={inputClass} style={{ minWidth: '160px' }} />
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <input type="text" value={line.weighment_number} onChange={(e) => handleWeighmentChange(index, 'weighment_number', e.target.value)} placeholder="Slip / Ticket No" className={inputClass} style={{ minWidth: '140px' }} />
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" step="0.001" min="0" value={line.first_weight} onChange={(e) => handleWeighmentChange(index, 'first_weight', e.target.value)} className={inputClass} style={{ minWidth: '110px' }} />
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" step="0.001" min="0" value={line.second_weight} onChange={(e) => handleWeighmentChange(index, 'second_weight', e.target.value)} className={inputClass} style={{ minWidth: '110px' }} />
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" step="0.001" min="0" value={line.tare_weight} onChange={(e) => handleWeighmentChange(index, 'tare_weight', e.target.value)} className={inputClass} style={{ minWidth: '110px' }} />
                        </td>
                        <td className="px-3 py-2">
                          <CustomSelect
                            value={line.uom || 'KG'}
                            onChange={(e) => handleWeighmentChange(index, 'uom', e.target.value)}
                            className={inputClass}
                            style={{ minWidth: '80px' }}
                          >
                            {/* Canonical UOM list — KG/MTS/etc. The
                                previous TON/QUINTAL entries were removed
                                as part of the UOM consolidation; if a
                                saved row used one of those, keep it
                                visible via the legacy fallback option. */}
                            {line.uom && !UOM_VALUES.includes(line.uom) && (
                              <option value={line.uom}>{line.uom}</option>
                            )}
                            {UOM_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </CustomSelect>
                        </td>
                        <td className="px-3 py-2">
                          <button type="button" onClick={() => removeWeighment(index)} className="text-red-500 hover:text-red-700">
                            <Trash2 size={16} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Transport Details — placed AFTER Weighment so the user
              records the weighbridge readings first (those drive the
              line-item Net Quantity), then fills in the truck / driver /
              freight metadata before reviewing line items. */}
          <div>
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Transport Details</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-3 gap-y-2">
              {!isHidden('driver_name') && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Driver Name <span className="text-red-500">*</span></label>
                <input type="text" name="driver_name" value={formData.driver_name} onChange={handleChange} disabled={isReadOnly('driver_name')} className={isReadOnly('driver_name') ? lockedInputClass : inputClass} />
              </div>
              )}
              {!isHidden('driver_phone') && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Driver Phone</label>
                <input
                  type="tel"
                  name="driver_phone"
                  value={formData.driver_phone}
                  onChange={handleChange}
                  disabled={isReadOnly('driver_phone')}
                  className={isReadOnly('driver_phone') ? lockedInputClass : inputClass}
                  placeholder="e.g. +91 98765 43210"
                  pattern="[0-9+\-\s()]{6,20}"
                  title="Contact number — digits, spaces, +, -, () allowed"
                />
              </div>
              )}
              {!isHidden('vehicle_number') && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Lorry No <span className="text-red-500">*</span></label>
                <input type="text" name="vehicle_number" value={formData.vehicle_number} onChange={handleChange} disabled={isReadOnly('vehicle_number')} className={isReadOnly('vehicle_number') ? lockedInputClass : inputClass} placeholder="e.g. TN-01-AB-1234" />
              </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Transporter Name</label>
                <input type="text" name="transporter_name" value={formData.transporter_name} onChange={handleChange} className={inputClass} placeholder="e.g. Sri Logistics" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Freight Bill No</label>
                <input type="text" name="freight_bill_no" value={formData.freight_bill_no} onChange={handleChange} className={inputClass} placeholder="e.g. FB-2024-001" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Freight Bill Date</label>
                <input type="date" name="freight_bill_date" value={formData.freight_bill_date} onChange={handleChange} className={inputClass} />
              </div>
              {!isHidden('advance_amount') && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Advance Amount</label>
                <input type="number" step="0.01" min="0" name="advance_amount" value={formData.advance_amount} onChange={handleChange} disabled={isReadOnly('advance_amount')} className={isReadOnly('advance_amount') ? lockedInputClass : inputClass} placeholder="0.00" />
              </div>
              )}
              {!isHidden('freight_value') && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Freight Value</label>
                <input type="number" step="0.01" min="0" name="freight_value" value={formData.freight_value} onChange={handleChange} disabled={isReadOnly('freight_value')} className={isReadOnly('freight_value') ? lockedInputClass : inputClass} placeholder="0.00" />
              </div>
              )}
              {!isHidden('freight_terms') && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Freight Terms <span className="text-red-500">*</span></label>
                <CustomSelect name="freight_terms" value={formData.freight_terms} onChange={handleChange} disabled={isReadOnly('freight_terms')} className={isReadOnly('freight_terms') ? lockedInputClass : inputClass}>
                  <option value="">Select Freight Terms</option>
                  <option value="PAID">Paid</option>
                  <option value="TO_PAY">To Pay</option>
                </CustomSelect>
              </div>
              )}
            </div>

            {/* Transport attachments — inline, no separate heading */}
            <div className="mt-4 pt-3 border-t border-slate-200">
              <div className="flex items-center gap-2 mb-2">
                <input
                  ref={transportCameraRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    handleTransportFile(file);
                    if (transportCameraRef.current) transportCameraRef.current.value = '';
                  }}
                />
                <input
                  ref={transportFileRef}
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.webp"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    handleTransportFile(file);
                    if (transportFileRef.current) transportFileRef.current.value = '';
                  }}
                />
                <button
                  type="button"
                  onClick={() => transportCameraRef.current?.click()}
                  disabled={freightExtracting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 transition disabled:opacity-50"
                >
                  <Camera size={14} />
                  Take Photo
                </button>
                <button
                  type="button"
                  onClick={() => transportFileRef.current?.click()}
                  disabled={freightExtracting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary-700 bg-primary-50 border border-primary-200 rounded-lg hover:bg-primary-100 transition disabled:opacity-50"
                >
                  {freightExtracting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  {freightExtracting ? 'Extracting...' : 'Upload Freight Bill'}
                </button>
              </div>
              <FileAttachments
                module="RECEIPT"
                recordId={null}
                category="TRANSPORT"
                compact
                hideUpload
                presetPendingFiles={pendingTransportAttachments}
                onPendingChange={(files) => { pendingTransportAttachmentsRef.current = files; setPendingTransportAttachments(files); }}
              />
            </div>
          </div>

          {/* Receipt Line Items */}
          <div>
            {(() => {
              // Live banner as the operator types. Lists lines with
              // (a) Invoice Qty > PO pending (PO over-delivery) or
              // (b) Received Qty ≠ Invoice Qty (physical vs invoice).
              // Same set that gets recapped in the save-time confirm.
              const flagged = receiptLines
                .map((l, i) => ({ label: l.item_name || l._itemName || `Line ${i + 1}`, flag: getReceiptLineFlag(l) }))
                .filter(x => x.flag);
              if (flagged.length === 0) return null;
              return (
                <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  <div className="font-medium mb-1">
                    {flagged.length} line{flagged.length > 1 ? 's' : ''} with quantity deviations — remarks &amp; attachment required
                  </div>
                  <ul className="text-xs space-y-0.5">
                    {flagged.map((x, i) => {
                      const parts = [];
                      if (x.flag.overBy) parts.push(`over PO by +${x.flag.overBy} ${x.flag.uom}`);
                      if (x.flag.mismatchBy)
                        parts.push(
                          x.flag.mismatchBy > 0
                            ? `short vs invoice by ${x.flag.mismatchBy} ${x.flag.uom}`
                            : `extra vs invoice by ${-x.flag.mismatchBy} ${x.flag.uom}`,
                        );
                      return <li key={i}>• {x.label} — {parts.join('; ')}</li>;
                    })}
                  </ul>
                </div>
              );
            })()}
            <div className="flex items-center justify-between mb-2 pb-1.5 border-b">
              <h3 className="text-sm sm:text-base font-semibold text-slate-800">Receipt Line Items</h3>
              <div className="flex items-center gap-2">
                {receiptLines.some(l => l._unresolved) && (
                  <button
                    type="button"
                    onClick={reopenMismatchModal}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-red-700 border border-red-300 bg-red-50 rounded-lg hover:bg-red-100"
                  >
                    Resolve {receiptLines.filter(l => l._unresolved).length} mismatch{receiptLines.filter(l => l._unresolved).length > 1 ? 'es' : ''}
                  </button>
                )}
                <button type="button" onClick={addReceiptLine} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100">
                  <Plus size={16} /> Add Line
                </button>
              </div>
            </div>
            {poLines.length > 0 && (
              <div className="mb-3 p-3 bg-blue-50 rounded-lg text-sm text-blue-800">
                <strong>PO Lines:</strong>{' '}
                {poLines.map((pl, i) => (
                  <span key={pl.id || i} className="mr-3">
                    {pl.product_name || pl.product_code || `Line ${pl.line_no}`} - Ordered: {pl.quantity_ordered} {pl.uom}
                  </span>
                ))}
              </div>
            )}
            <div className="overflow-x-auto ios-scroll">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                    <th className="text-left px-3 py-2 font-medium text-slate-600">#</th>
                    {/* Source-PO column — only when the receipt spans more
                        than one PO, so each line is attributable. */}
                    {!isDirectReceipt && additionalPoIds.length > 0 && (
                      <th className="text-left px-3 py-2 font-medium text-slate-600">PO</th>
                    )}
                    {!isLineHidden('product') && (
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Product <span className="text-red-500">*</span></th>
                    )}
                    {/* Length / Breadth / Width / Weight live on the
                        Packing Materials subform only — packing-material
                        rows are auto-routed there, and raw / finished
                        goods don't need dimensions on the receipt. */}
                    {!isDirectReceipt && (
                      <>
                        <th className="text-right px-3 py-2 font-medium text-slate-600">PO Qty</th>
                        <th className="text-right px-3 py-2 font-medium text-slate-600">Rcvd</th>
                        <th className="text-right px-3 py-2 font-medium text-slate-600">Balance</th>
                      </>
                    )}
                    {/* Column label is "Invoice Quantity" in the UI but the
                        backing data field stays `quantity_received` so no
                        backend / API migration is needed. Same for "Received
                        Quantity" → `net_quantity` below. */}
                    {!isLineHidden('quantity_received') && (
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Invoice Quantity <span className="text-red-500">*</span></th>
                    )}
                    {!isLineHidden('net_quantity') && (
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Received Quantity <span className="text-red-500">*</span></th>
                    )}
                    {/* Density column — only rendered when at least one
                        receipt line has an LTR (liquid) PR-line UOM.
                        Value is kg/L or g/ml, optional per line. */}
                    {receiptLines.some(l => (l.pr_line_uom || '').toUpperCase() === 'LTR') && (
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Density</th>
                    )}
                    {/* Specific Gravity column — only rendered when at least
                        one receipt line's product has sg_applicable=True
                        (product master flag). Per-batch SG value; on save
                        the backend derives quantity_in_litres = kg / SG
                        for the Production Stock table. */}
                    {receiptLines.some(l => l.product_sg_applicable) && (
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Specific Gravity</th>
                    )}
                    {/* Difference in Qty = Invoice − Received. Shown in
                        both PO mode and Direct mode — the shortage /
                        overage is just as meaningful for direct intake
                        as for PO-backed receipts. */}
                    <th className="text-right px-3 py-2 font-medium text-slate-600">Difference in Qty</th>
                    {isDirectReceipt && (
                      <>
                        {!isLineHidden('rate') && (
                          <th className="text-left px-3 py-2 font-medium text-slate-600">Rate <span className="text-red-500">*</span></th>
                        )}
                        {!isLineHidden('gst_percentage') && (
                          <th className="text-left px-3 py-2 font-medium text-slate-600">GST %</th>
                        )}
                      </>
                    )}
                    {/* Per-line Debit Note column removed — debit-note
                        state is now controlled by the receipt-level
                        toggle in the form-actions row. `is_debit_note`
                        still lives on each line in state so the bulk
                        toggle continues to flip them. */}
                    {!isLineHidden('uom') && (
                      <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                    )}
                    {!isLineHidden('batch_no') && (
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Batch No</th>
                    )}
                    {!isLineHidden('godown_location') && (
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Godown</th>
                    )}
                    <th className="text-left px-3 py-2 font-medium text-slate-600">Remarks</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {receiptLines.map((line, index) => (
                    <tr key={index} className="border-b">
                      <td className="px-3 py-2 text-slate-500">{index + 1}</td>
                      {!isDirectReceipt && additionalPoIds.length > 0 && (
                        <td className="px-3 py-2 text-xs text-slate-600 whitespace-nowrap">{line._poNo || '-'}</td>
                      )}
                      {!isLineHidden('product') && (
                      <td className="px-3 py-2">
                        {/* Machinery / Service receipt lines are
                            auto-filled from the parent PO and cannot
                            be swapped with a Goods product (they're
                            stored under different FKs). Render them as
                            a read-only label with a badge instead. */}
                        {line.item_type === 'MACHINERY' || line.item_type === 'SERVICE' ? (
                          <div className="flex items-center gap-2" style={{ minWidth: '160px' }}>
                            <span className="text-sm text-slate-800">{line.item_name || '-'}</span>
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              line.item_type === 'MACHINERY' ? 'bg-indigo-50 text-indigo-700' : 'bg-emerald-50 text-emerald-700'
                            }`}>
                              {line.item_type === 'MACHINERY' ? 'Machinery' : 'Service'}
                            </span>
                          </div>
                        ) : (
                          <CustomSelect value={line.product} onChange={(e) => handleReceiptLineChange(index, 'product', e.target.value)} disabled={isLineRO('product')} className={isLineRO('product') ? lockedInputClass : inputClass} style={{ minWidth: '160px' }}>
                            <option value="">Select Product</option>
                            {productOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </CustomSelect>
                        )}
                        {line.product && line._matchSource === 'fuzzy' && (
                          <p className="text-[10px] text-emerald-700 mt-1 italic">Auto-matched from "{line._extractedName || ''}"</p>
                        )}
                      </td>
                      )}
                      {!isDirectReceipt && (
                        <>
                          <td className="px-3 py-2 text-right text-slate-600">
                            {line.po_quantity || '-'}
                          </td>
                          <td className="px-3 py-2 text-right text-slate-600">
                            {line.already_received || 0}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {(() => {
                              const poQty = parseFloat(line.po_quantity) || 0;
                              const alreadyRcvd = parseFloat(line.already_received) || 0;
                              const currentQty = parseFloat(line.quantity_received) || 0;
                              const balance = Math.round((poQty - alreadyRcvd - currentQty) * 100) / 100;
                              if (!poQty) return '-';
                              return (
                                <span className={`font-medium ${balance > 0 ? 'text-emerald-600' : balance === 0 ? 'text-slate-500' : 'text-red-600'}`}>
                                  {balance.toFixed(2)}
                                </span>
                              );
                            })()}
                          </td>
                        </>
                      )}
                      {!isLineHidden('quantity_received') && (
                      <td className="px-3 py-2">
                        {(() => {
                          // Over-delivery is permitted — vendor
                          // production variance may ship more than the
                          // PO. No HTML5 `max` cap anymore; instead we
                          // surface a small amber "Over: +N UOM" hint
                          // right under the input when qty > pending.
                          const sameUom = !line.po_uom || !line.uom
                            || (line.po_uom || '').trim().toUpperCase() === (line.uom || '').trim().toUpperCase();
                          const balance = parseFloat(line.po_quantity) - parseFloat(line.already_received || 0);
                          const currentQty = parseFloat(line.quantity_received) || 0;
                          const over = !isDirectReceipt && sameUom && balance >= 0 && currentQty > balance
                            ? Math.round((currentQty - balance) * 100) / 100
                            : 0;
                          const title = isDirectReceipt
                            ? ''
                            : sameUom
                              ? `Pending: ${balance.toFixed(2)} ${line.po_uom || ''} — over-delivery allowed`
                              : `PO ordered ${line.po_quantity} ${line.po_uom || ''}; receipt is in ${line.uom || '?'} — no cross-UOM cap.`;
                          return (
                            <div className="flex flex-col gap-0.5" style={{ minWidth: '100px' }}>
                              <input
                                type="number" step="0.01" min="0.01"
                                value={line.quantity_received}
                                onChange={(e) => handleReceiptLineChange(index, 'quantity_received', e.target.value)}
                                disabled={isLineRO('quantity_received')}
                                className={isLineRO('quantity_received') ? lockedInputClass : inputClass}
                                title={title}
                              />
                              {over > 0 && (
                                <span className="text-[10px] text-amber-700 font-medium">
                                  Over-delivery: +{over} {line.po_uom || ''}
                                </span>
                              )}
                              {(() => {
                                const sourceQty = line._extractedQty || line._prefillQty;
                                if (!sourceQty) return null;
                                const entered = parseFloat(line.quantity_received) || 0;
                                const original = parseFloat(sourceQty) || 0;
                                if (!original || Math.abs(entered - original) < 0.01) return null;
                                const label = line._extractedQty ? 'Invoice extracted' : 'PO balance';
                                const diff = Math.round((entered - original) * 100) / 100;
                                return (
                                  <span className="text-[10px] text-blue-700 font-medium leading-tight">
                                    {label}: {original} — you entered {entered} ({diff > 0 ? '+' : ''}{diff})
                                  </span>
                                );
                              })()}
                            </div>
                          );
                        })()}
                      </td>
                      )}
                      {!isLineHidden('net_quantity') && (
                      <td className="px-3 py-2">
                        <input type="number" step="0.01" min="0.01" required value={line.net_quantity || ''} onChange={(e) => handleReceiptLineChange(index, 'net_quantity', e.target.value)} disabled={isLineRO('net_quantity')} className={isLineRO('net_quantity') ? lockedInputClass : inputClass} style={{ minWidth: '100px' }} placeholder="0.00" />
                      </td>
                      )}
                      {/* Density input — only shown for LTR (liquid) lines.
                          Non-liquid rows in the same table render a dash
                          so the column alignment stays clean. */}
                      {receiptLines.some(l => (l.pr_line_uom || '').toUpperCase() === 'LTR') && (
                      <td className="px-3 py-2">
                        {(line.pr_line_uom || '').toUpperCase() === 'LTR' ? (
                          <input
                            type="number" step="0.0001" min="0"
                            value={line.density || ''}
                            onChange={(e) => handleReceiptLineChange(index, 'density', e.target.value)}
                            className={inputClass}
                            style={{ minWidth: '80px' }}
                            placeholder="g/ml"
                            title="Density (g/ml or kg/L) for the received liquid"
                          />
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      )}
                      {/* Specific Gravity input — only shown for lines whose
                          product has sg_applicable=True. Under the input we
                          preview the derived litres = kg / SG so the operator
                          can eyeball the conversion before saving. */}
                      {receiptLines.some(l => l.product_sg_applicable) && (
                      <td className="px-3 py-2">
                        {line.product_sg_applicable ? (
                          <>
                            <input
                              type="number" step="0.0001" min="0"
                              value={line.specific_gravity || ''}
                              onChange={(e) => handleReceiptLineChange(index, 'specific_gravity', e.target.value)}
                              className={inputClass}
                              style={{ minWidth: '90px' }}
                              placeholder="e.g. 1.05"
                              title="Specific Gravity for this batch — litres = kg / SG"
                            />
                            {line.specific_gravity && line.quantity_received && Number(line.specific_gravity) > 0 && (
                              <div className="text-[10px] text-slate-500 mt-0.5">
                                ≈ {(Number(line.quantity_received) / Number(line.specific_gravity)).toFixed(2)} L
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      )}
                      <td className="px-3 py-2 text-right">
                        {(() => {
                          const rcvd = parseFloat(line.quantity_received) || 0;
                          const net = parseFloat(line.net_quantity) || 0;
                          if (!rcvd && !net) return <span className="text-slate-400">-</span>;
                          // Positive = shortage (invoice claimed more
                          // than what was actually received) → red.
                          // Negative = overage → amber. Zero → green.
                          const diff = Math.round((rcvd - net) * 100) / 100;
                          const cls = diff > 0 ? 'text-red-600' : diff < 0 ? 'text-amber-600' : 'text-emerald-600';
                          return <span className={`font-medium ${cls}`}>{diff.toFixed(2)}</span>;
                        })()}
                      </td>
                      {isDirectReceipt && (
                        <>
                          {!isLineHidden('rate') && (
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={line.rate || ''}
                              onChange={(e) => handleReceiptLineChange(index, 'rate', e.target.value)}
                              disabled={isLineRO('rate')}
                              className={isLineRO('rate') ? lockedInputClass : inputClass}
                              style={{ minWidth: '90px' }}
                              placeholder="0.00"
                              required
                            />
                          </td>
                          )}
                          {!isLineHidden('gst_percentage') && (
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              max="100"
                              value={line.gst_percentage || ''}
                              onChange={(e) => handleReceiptLineChange(index, 'gst_percentage', e.target.value)}
                              disabled={isLineRO('gst_percentage')}
                              className={isLineRO('gst_percentage') ? lockedInputClass : inputClass}
                              style={{ minWidth: '70px' }}
                              placeholder="0"
                            />
                          </td>
                          )}
                        </>
                      )}
                      {!isLineHidden('uom') && (
                      <td className="px-3 py-2">
                        {/* UOM dropdown — same canonical set the rest of
                            the codebase uses (Product master UOM_CHOICES,
                            packing materials, etc.). Including the
                            existing value if it isn't in the list keeps
                            legacy lines with unusual units like "Labels"
                            renderable rather than silently flipping
                            them to KG on first edit. */}
                        <CustomSelect
                          value={line.uom || 'KG'}
                          onChange={(e) => handleReceiptLineChange(index, 'uom', e.target.value)}
                          disabled={isLineRO('uom')}
                          className={isLineRO('uom') ? lockedInputClass : inputClass}
                          style={{ minWidth: '80px' }}
                        >
                          {['KG', 'LTR', 'MTR', 'PCS', 'TONS', 'BAGS', 'NOS', 'BOX', 'PACK', 'MTS'].map(u => (
                            <option key={u} value={u}>{u}</option>
                          ))}
                          {line.uom && !['KG', 'LTR', 'MTR', 'PCS', 'TONS', 'BAGS', 'NOS', 'BOX', 'PACK', 'MTS'].includes(line.uom) && (
                            <option value={line.uom}>{line.uom} (legacy)</option>
                          )}
                        </CustomSelect>
                      </td>
                      )}
                      {!isLineHidden('batch_no') && (
                      <td className="px-3 py-2">
                        <input type="text" value={line.batch_no} onChange={(e) => handleReceiptLineChange(index, 'batch_no', e.target.value)} disabled={isLineRO('batch_no')} className={isLineRO('batch_no') ? lockedInputClass : inputClass} style={{ minWidth: '100px' }} />
                      </td>
                      )}
                      {!isLineHidden('godown_location') && (
                      <td className="px-3 py-2">
                        <CustomSelect value={line.godown_location} onChange={(e) => handleReceiptLineChange(index, 'godown_location', e.target.value)} disabled={isLineRO('godown_location')} className={isLineRO('godown_location') ? lockedInputClass : inputClass} style={{ minWidth: '130px' }}>
                          <option value="">Select Godown</option>
                          {godownOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </CustomSelect>
                      </td>
                      )}
                      <td className="px-3 py-2">
                        <input type="text" value={line.remarks} onChange={(e) => handleReceiptLineChange(index, 'remarks', e.target.value)} placeholder={getReceiptLineFlag(line) ? 'Reason required' : ''} className={`${inputClass} ${getReceiptLineFlag(line) && !(line.remarks || '').trim() ? 'border-red-300 focus:border-red-500 focus:ring-red-200' : ''}`} style={{ minWidth: '120px' }} />
                      </td>
                      <td className="px-3 py-2">
                        <button type="button" onClick={() => removeReceiptLine(index)} disabled={receiptLines.length <= 1} className="text-red-500 hover:text-red-700 disabled:opacity-30">
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Packing Material Lines */}
          <div>
            <div className="flex items-center justify-between mb-2 pb-1.5 border-b">
              <h3 className="text-sm sm:text-base font-semibold text-slate-800">Packing Materials</h3>
              <button type="button" onClick={addPackingLine} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100">
                <Plus size={16} /> Add Packing Material
              </button>
            </div>
            {packingLines.length === 0 ? (
              <p className="text-sm text-slate-400 italic">No packing materials added. Click "Add Packing Material" to add.</p>
            ) : (
              <div className="space-y-3">
                {packingLines.map((line, index) => (
                  <div key={index} className={`border rounded-lg bg-white ${line.condition === 'DAMAGED' ? 'border-red-200' : 'border-slate-200'}`}>
                    {/* Card header */}
                    <div className={`flex items-center justify-between px-4 py-2 rounded-t-lg border-b ${line.condition === 'DAMAGED' ? 'bg-gradient-to-r from-red-50 to-red-50/40 border-red-100' : 'bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-slate-100'}`}>
                      <span className={`text-sm font-semibold ${line.condition === 'DAMAGED' ? 'text-red-700' : 'text-slate-700'}`}>#{index + 1}{line.condition === 'DAMAGED' && ' — Damaged'}</span>
                      <button type="button" onClick={() => removePackingLine(index)} className="text-red-400 hover:text-red-600 p-1 rounded hover:bg-red-50 transition">
                        <Trash2 size={15} />
                      </button>
                    </div>

                    <div className="px-4 py-3 space-y-3">
                      {/* Row 1: SKU, Dimensions, Weight, UOM, Condition */}
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-3">
                        {!isPackHidden('packaging_sku') && (
                          <div className="col-span-2 sm:col-span-3 md:col-span-2 lg:col-span-2">
                            <label className="block text-[11px] font-medium text-slate-500 mb-1">Packaging SKU</label>
                            <CustomSelect value={line.packaging_sku} onChange={(e) => handlePackingLineChange(index, 'packaging_sku', e.target.value)} disabled={isPackRO('packaging_sku')} className={`w-full ${isPackRO('packaging_sku') ? lockedInputClass : inputClass}`}>
                              <option value="">Select Product</option>
                              {productOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </CustomSelect>
                          </div>
                        )}
                        {!isPackHidden('length') && (
                          <div>
                            <label className="block text-[11px] font-medium text-slate-500 mb-1">Length</label>
                            <input type="number" min="0" step="any" value={line.length || ''} onChange={(e) => handlePackingLineChange(index, 'length', e.target.value)} disabled={isPackRO('length')} placeholder="0" className={`w-full ${isPackRO('length') ? lockedInputClass : inputClass}`} />
                          </div>
                        )}
                        {!isPackHidden('breadth') && (
                          <div>
                            <label className="block text-[11px] font-medium text-slate-500 mb-1">Breadth</label>
                            <input type="number" min="0" step="any" value={line.breadth || ''} onChange={(e) => handlePackingLineChange(index, 'breadth', e.target.value)} disabled={isPackRO('breadth')} placeholder="0" className={`w-full ${isPackRO('breadth') ? lockedInputClass : inputClass}`} />
                          </div>
                        )}
                        {!isPackHidden('width') && (
                          <div>
                            <label className="block text-[11px] font-medium text-slate-500 mb-1">Width</label>
                            <input type="number" min="0" step="any" value={line.width || ''} onChange={(e) => handlePackingLineChange(index, 'width', e.target.value)} disabled={isPackRO('width')} placeholder="0" className={`w-full ${isPackRO('width') ? lockedInputClass : inputClass}`} />
                          </div>
                        )}
                        {!isPackHidden('weight') && (
                          <div>
                            <label className="block text-[11px] font-medium text-slate-500 mb-1">Weight</label>
                            <input type="number" min="0" step="any" value={line.weight || ''} onChange={(e) => handlePackingLineChange(index, 'weight', e.target.value)} disabled={isPackRO('weight')} placeholder="0" className={`w-full ${isPackRO('weight') ? lockedInputClass : inputClass}`} />
                          </div>
                        )}
                        {!isPackHidden('uom') && (
                          <div>
                            <label className="block text-[11px] font-medium text-slate-500 mb-1">UOM</label>
                            <CustomSelect value={line.uom || 'PCS'} onChange={(e) => handlePackingLineChange(index, 'uom', e.target.value)} disabled={isPackRO('uom')} className={`w-full ${isPackRO('uom') ? lockedInputClass : inputClass}`}>
                              {['PCS', 'KG', 'LTR', 'MTR', 'SQM', 'CUM', 'BOX', 'PACK', 'MTS', 'NOS', 'BAGS', 'TONS'].map(u => (
                                <option key={u} value={u}>{u}</option>
                              ))}
                              {line.uom && !['PCS', 'KG', 'LTR', 'MTR', 'SQM', 'CUM', 'BOX', 'PACK', 'MTS', 'NOS', 'BAGS', 'TONS'].includes(line.uom) && <option value={line.uom}>{line.uom} (legacy)</option>}
                            </CustomSelect>
                          </div>
                        )}
                        <div>
                          <label className="block text-[11px] font-medium text-slate-500 mb-1">Condition</label>
                          <CustomSelect value={line.condition} onChange={(e) => handlePackingLineChange(index, 'condition', e.target.value)} className={`w-full ${inputClass}`}>
                            <option value="NEW">New</option>
                            <option value="DAMAGED">Damaged</option>
                          </CustomSelect>
                        </div>
                      </div>

                      {/* Row 2: Quantities, Batch, Godown, Remarks */}
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-3 pt-2 border-t border-slate-100">
                        {!isDirectReceipt && (
                          <>
                            <div>
                              <label className="block text-[11px] font-medium text-slate-500 mb-1">PO Qty</label>
                              <div className="px-3 py-2 bg-slate-50 rounded-lg text-sm text-slate-600 border border-slate-200">{line._poQuantity || line.po_quantity || '-'}</div>
                            </div>
                            <div>
                              <label className="block text-[11px] font-medium text-slate-500 mb-1">Rcvd</label>
                              <div className="px-3 py-2 bg-slate-50 rounded-lg text-sm text-slate-600 border border-slate-200">{line._alreadyReceived || line.already_received || 0}</div>
                            </div>
                            <div>
                              <label className="block text-[11px] font-medium text-slate-500 mb-1">Balance</label>
                              <div className="px-3 py-2 bg-slate-50 rounded-lg text-sm border border-slate-200">
                                {(() => {
                                  const poQty = parseFloat(line._poQuantity || line.po_quantity) || 0;
                                  const alreadyRcvd = parseFloat(line._alreadyReceived || line.already_received) || 0;
                                  const currentQty = parseFloat(line.quantity) || 0;
                                  const balance = Math.round((poQty - alreadyRcvd - currentQty) * 100) / 100;
                                  if (!poQty) return <span className="text-slate-400">-</span>;
                                  return <span className={`font-medium ${balance > 0 ? 'text-emerald-600' : balance === 0 ? 'text-slate-500' : 'text-red-600'}`}>{balance.toFixed(2)}</span>;
                                })()}
                              </div>
                            </div>
                          </>
                        )}
                        {!isPackHidden('quantity') && (
                          <div>
                            <label className="block text-[11px] font-medium text-slate-500 mb-1">Invoice Qty</label>
                            <input type="number" step="0.01" min="0" value={line.quantity || ''} onChange={(e) => handlePackingLineChange(index, 'quantity', e.target.value)} disabled={isPackRO('quantity')} placeholder="0.00" className={`w-full ${isPackRO('quantity') ? lockedInputClass : inputClass}`} />
                          </div>
                        )}
                        {!isPackHidden('net_quantity') && (
                          <div>
                            <label className="block text-[11px] font-medium text-slate-500 mb-1">Received Qty</label>
                            <input type="number" step="0.01" min="0" value={line.net_quantity || ''} onChange={(e) => handlePackingLineChange(index, 'net_quantity', e.target.value)} disabled={isPackRO('net_quantity')} placeholder="0.00" className={`w-full ${isPackRO('net_quantity') ? lockedInputClass : inputClass}`} />
                          </div>
                        )}
                        <div>
                          <label className="block text-[11px] font-medium text-slate-500 mb-1">Diff in Qty</label>
                          <div className="px-3 py-2 bg-slate-50 rounded-lg text-sm border border-slate-200">
                            {(() => {
                              const inv = parseFloat(line.quantity) || 0;
                              const rcv = parseFloat(line.net_quantity) || 0;
                              if (!inv && !rcv) return <span className="text-slate-400">-</span>;
                              const diff = Math.round((inv - rcv) * 100) / 100;
                              const cls = diff > 0 ? 'text-red-600' : diff < 0 ? 'text-amber-600' : 'text-emerald-600';
                              return <span className={`font-medium ${cls}`}>{diff.toFixed(2)}</span>;
                            })()}
                          </div>
                        </div>
                        {!isPackHidden('batch_no') && (
                          <div>
                            <label className="block text-[11px] font-medium text-slate-500 mb-1">Batch No</label>
                            <input type="text" value={line.batch_no || ''} onChange={(e) => handlePackingLineChange(index, 'batch_no', e.target.value)} disabled={isPackRO('batch_no')} placeholder="Batch" className={`w-full ${isPackRO('batch_no') ? lockedInputClass : inputClass}`} />
                          </div>
                        )}
                        {!isPackHidden('godown_location') && (
                          <div>
                            <label className="block text-[11px] font-medium text-slate-500 mb-1">Godown</label>
                            <CustomSelect value={line.godown_location || ''} onChange={(e) => handlePackingLineChange(index, 'godown_location', e.target.value)} disabled={isPackRO('godown_location')} className={`w-full ${isPackRO('godown_location') ? lockedInputClass : inputClass}`}>
                              <option value="">Select Godown</option>
                              {godownOptions.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                            </CustomSelect>
                          </div>
                        )}
                        {!isPackHidden('remarks') && (
                          <div className="col-span-2 sm:col-span-1">
                            <label className={`block text-[11px] font-medium mb-1 ${line.condition === 'DAMAGED' ? 'text-red-600' : 'text-slate-500'}`}>
                              Remarks{line.condition === 'DAMAGED' && ' *'}
                            </label>
                            <div className="flex gap-1.5">
                              <input type="text" value={line.remarks || ''} onChange={(e) => handlePackingLineChange(index, 'remarks', e.target.value)} disabled={isPackRO('remarks')} placeholder={line.condition === 'DAMAGED' ? 'Reason for damage (required)' : 'Remarks'} className={`w-full ${isPackRO('remarks') ? lockedInputClass : inputClass} ${line.condition === 'DAMAGED' && !(line.remarks || '').trim() ? 'border-red-300 focus:border-red-500 focus:ring-red-200' : ''}`} />
                              <button type="button" onClick={() => togglePackMic(index)} className={`flex-shrink-0 p-2 rounded-lg border transition ${listeningPackIdx === index ? 'bg-red-50 border-red-300 text-red-600 animate-pulse' : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'}`} title={listeningPackIdx === index ? 'Stop recording' : 'Speak remarks'}>
                                {listeningPackIdx === index ? <MicOff size={14} /> : <Mic size={14} />}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Damage proof — visible only when DAMAGED */}
                      {line.condition === 'DAMAGED' && (
                        <div className="pt-3 border-t border-red-100">
                          <div className="flex items-center gap-3 mb-2">
                            <span className="text-[11px] font-semibold text-red-600">Damage Proof *</span>
                            {(line._damageFiles || []).length > 0 && (
                              <span className="text-[11px] text-slate-400">{line._damageFiles.length} file(s)</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <input
                              type="file"
                              accept="image/*"
                              capture="environment"
                              className="hidden"
                              id={`damage-camera-${index}`}
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) {
                                  setPackingLines(prev => prev.map((p, i) => i === index ? { ...p, _damageFiles: [...(p._damageFiles || []), file] } : p));
                                }
                                e.target.value = '';
                              }}
                            />
                            <button type="button" onClick={() => document.getElementById(`damage-camera-${index}`)?.click()} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition">
                              <Camera size={14} /> Take Photo
                            </button>
                            <input
                              type="file"
                              accept=".pdf,.jpg,.jpeg,.png,.webp"
                              multiple
                              className="hidden"
                              id={`damage-file-${index}`}
                              onChange={(e) => {
                                const files = Array.from(e.target.files || []);
                                if (files.length > 0) {
                                  setPackingLines(prev => prev.map((p, i) => i === index ? { ...p, _damageFiles: [...(p._damageFiles || []), ...files] } : p));
                                }
                                e.target.value = '';
                              }}
                            />
                            <button type="button" onClick={() => document.getElementById(`damage-file-${index}`)?.click()} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition">
                              <Upload size={14} /> Upload Proof
                            </button>
                          </div>
                          {(line._damageFiles || []).length > 0 && (
                            <div className="mt-2 space-y-1">
                              {line._damageFiles.map((f, fi) => (
                                <div key={fi} className="flex items-center gap-2 px-2.5 py-1.5 bg-red-50/50 border border-red-100 rounded-lg text-xs">
                                  <Paperclip size={12} className="text-red-400 flex-shrink-0" />
                                  <span className="flex-1 truncate text-slate-700">{f.name}</span>
                                  <button type="button" onClick={() => setPackingLines(prev => prev.map((p, i) => i === index ? { ...p, _damageFiles: (p._damageFiles || []).filter((_, j) => j !== fi) } : p))} className="p-0.5 text-red-400 hover:text-red-600">
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>


          {/* Additional Information */}
          <div>
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Additional Information</h3>
            <div className="grid grid-cols-1 gap-3">
              {!isHidden('remarks') && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-0.5">Remarks</label>
                <textarea name="remarks" value={formData.remarks} onChange={handleChange} rows={2} disabled={isReadOnly('remarks')} className={isReadOnly('remarks') ? lockedInputClass : inputClass} />
              </div>
              )}
            </div>
          </div>

          {/* Attachments — combined view with category labels + inline preview */}
          <div>
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Attachments</h3>
            <div className="flex items-center gap-2 mb-3">
              <input
                ref={generalCameraRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const updated = [...pendingAttachmentsRef.current, file];
                    pendingAttachmentsRef.current = updated;
                    setPendingAttachments(updated);
                  }
                  if (generalCameraRef.current) generalCameraRef.current.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => generalCameraRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 transition"
              >
                <Camera size={14} />
                Take Photo
              </button>
            </div>
            <CombinedAttachmentList
              generalFiles={pendingAttachments}
              transportFiles={pendingTransportAttachments}
              damageFiles={packingLines.flatMap(l => l._damageFiles || [])}
            />
          </div>

          {/* Form Actions */}
          {(() => {
            // Receipt-level Debit Note toggle. Convenience for marking
            // every line item as a debit note in one click instead of
            // toggling each row individually. The per-line flags stay
            // canonical — this button just flips them all together.
            const allLines = receiptLines || [];
            const debitCount = allLines.filter(l => l.is_debit_note).length;
            // 3 visual states: all-off, all-on, mixed.
            const state = debitCount === 0
              ? 'off'
              : debitCount === allLines.length
                ? 'on'
                : 'mixed';
            const toggleAll = () => {
              // If currently mixed or off, turn ALL on.
              // If currently fully on, turn ALL off.
              const next = state !== 'on';
              setReceiptLines(prev => prev.map(l => ({ ...l, is_debit_note: next })));
              toast(next
                ? `Debit Note enabled on ${allLines.length} line${allLines.length > 1 ? 's' : ''}`
                : 'Debit Note cleared on all lines',
                { icon: next ? '🧾' : '✅', duration: 3000 });
            };
            return (
              <div className="flex justify-end items-center gap-3 pt-4 border-t">
                <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
                <button type="submit" disabled={isLoading} className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving...' : 'Save'}</button>
              </div>
            );
          })()}
          </EditGate>
        </form>
      </div>

      <ReceiptMismatchModal
        open={mismatchOpen}
        mismatches={mismatchRows}
        // Pass mode so the modal renders the right pills:
        //   direct → "Use master product" + "Create new" + "Remove line"
        //   po     → "Use PO product" + "Remove line"
        mode={isDirectReceipt ? 'direct' : 'po'}
        masterProducts={isDirectReceipt ? (productRaw || []) : []}
        poProducts={!isDirectReceipt ? (poLines || []).map((pl) => ({
          // Read whichever FK is set so Machinery / Service PO lines
          // also appear in the modal dropdown. Display fields come from
          // POLineSerializer's unified item_name / item_code accessors.
          id: pl.product_service || pl.machinery || pl.service_catalogue || pl.product,
          name: pl.item_name || pl.product_name || pl.machinery_name || pl.service_catalogue_name || '',
          sku: pl.item_code || pl.product_code || pl.sku_code || '',
          po_line_id: pl.id || '',
          uom: pl.uom || '',
          quantity_ordered: pl.quantity_ordered || 0,
          item_type: pl.item_type || 'PRODUCT',
        })).filter(p => p.id) : []}
        onResolve={handleMismatchResolve}
        onClose={() => setMismatchOpen(false)}
      />

      {/* Multi-PO picker modal — lists all active POs for the same vendor
          as the primary PO, minus any already picked (primary or added).
          On Add, sequentially calls addAdditionalPO() for each checked
          id so their lines are appended to the receipt. */}
      {addPoModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !addPoBusy && setAddPoModalOpen(false)}>
          <div className="w-full max-w-lg bg-white rounded-lg shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="border-b px-4 py-3 flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-800">Add more POs to this receipt</h3>
              <button
                type="button"
                className="text-slate-500 hover:text-slate-800"
                onClick={() => !addPoBusy && setAddPoModalOpen(false)}
              >×</button>
            </div>
            <div className="p-4 max-h-[60dvh] overflow-y-auto">
              {(() => {
                const alreadyPicked = new Set([formData.po_no, ...additionalPoIds].filter(Boolean));
                const candidates = (poRawData || [])
                  .filter(po =>
                    po.vendor === formData.vendor
                    && !alreadyPicked.has(po.id)
                    && !['CLOSED', 'CANCELLED', 'DRAFT', 'SPLIT'].includes(po.status)
                    && !po.is_fully_received
                    && po.email_sent
                  )
                  // Oldest first (FIFO-friendly): the older PO is the
                  // one the operator usually wants to consume first. Fall
                  // back to created_at if po_date is missing on a row.
                  .sort((a, b) => {
                    const da = a.po_date || a.created_at || '';
                    const db = b.po_date || b.created_at || '';
                    return da.localeCompare(db);
                  });
                if (candidates.length === 0) {
                  return (
                    <p className="text-sm text-slate-500">
                      No other active POs for this vendor.
                    </p>
                  );
                }
                return (
                  <ul className="space-y-2">
                    {candidates.map(po => {
                      const lines = po.po_lines || [];
                      return (
                        <li key={po.id}>
                          <label className="flex items-start gap-2 px-2 py-2 rounded hover:bg-slate-50 cursor-pointer border border-slate-200">
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={addPoModalSelection.includes(po.id)}
                              onChange={(e) => {
                                setAddPoModalSelection(prev =>
                                  e.target.checked
                                    ? [...prev, po.id]
                                    : prev.filter(id => id !== po.id)
                                );
                              }}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="text-sm text-slate-800">
                                <span className="font-medium">{po.po_no}</span>
                                {po.po_date ? <span className="text-slate-500"> · {po.po_date}</span> : null}
                                {po.total_amount ? <span className="text-slate-500"> · ₹{po.total_amount}</span> : null}
                              </div>
                              {lines.length > 0 && (
                                <ul className="mt-1 space-y-0.5">
                                  {lines.map((pl) => {
                                    const name = pl.item_name || pl.product_name || pl.machinery_name || pl.service_catalogue_name || '-';
                                    const ordered = parseFloat(pl.quantity_ordered) || 0;
                                    const rcvd = parseFloat(pl.received_quantity) || 0;
                                    const pending = Math.max(0, ordered - rcvd);
                                    return (
                                      <li key={pl.id} className="text-[11px] text-slate-600 pl-1">
                                        • {name}
                                        <span className="text-slate-500">
                                          {' · '}pending {pending}{ordered ? `/${ordered}` : ''} {pl.uom || ''}
                                        </span>
                                      </li>
                                    );
                                  })}
                                </ul>
                              )}
                            </div>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                );
              })()}
            </div>
            <div className="border-t px-4 py-3 flex items-center justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 rounded"
                disabled={addPoBusy}
                onClick={() => setAddPoModalOpen(false)}
              >Cancel</button>
              <button
                type="button"
                className="px-3 py-1.5 text-sm bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-50"
                disabled={addPoBusy || addPoModalSelection.length === 0}
                onClick={async () => {
                  setAddPoBusy(true);
                  try {
                    // Add oldest first so receipt-line rows land in the
                    // same order the operator sees in the picker above
                    // (which is also sorted oldest-first).
                    const byDate = (id) => {
                      const po = (poRawData || []).find(p => p.id === id);
                      return po?.po_date || po?.created_at || '';
                    };
                    const orderedSelection = [...addPoModalSelection].sort(
                      (a, b) => byDate(a).localeCompare(byDate(b))
                    );
                    for (const id of orderedSelection) {
                      // sequential to preserve deterministic row order
                      // and keep the setPoLines/setReceiptLines updates
                      // free from interleaved race conditions.
                      // eslint-disable-next-line no-await-in-loop
                      await addAdditionalPO(id);
                    }
                    setAddPoModalOpen(false);
                    setAddPoModalSelection([]);
                  } finally {
                    setAddPoBusy(false);
                  }
                }}
              >
                {addPoBusy ? 'Adding…' : `Add ${addPoModalSelection.length || ''}`.trim()}
              </button>
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  );
}
