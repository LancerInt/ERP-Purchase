import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { confirm } from '@/components/common/confirm';
import { promptText } from '@/components/common/prompt';
import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Edit3,
  Save,
  X,
  CheckCircle,
  XCircle,
  Clock,
  ArrowLeft,
  FileText,
  Link as LinkIcon,
  Trash2,
  SkipForward,
  Paperclip,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import { Plus } from 'lucide-react';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import useLookup from '../../../hooks/useLookup.js';
import { UOM_OPTIONS, UOM_VALUES } from '../../../constants/uom.js';
import useAllProducts from '../components/useAllProducts.js';
import FileAttachments, { uploadPendingFiles } from '../components/FileAttachments';
// ActivityLog removed — activity shows in the collapsible Timeline section
import { formatDate as fmtSharedDate, formatDateTime as fmtSharedDateTime } from '@/utils/formatters';
import { getApiErrorMessage } from '@/utils/formHelpers';
import { PAYMENT_TERM_OPTIONS, FREIGHT_TERM_OPTIONS, withCurrent } from '@/constants/purchaseTerms';

// Voice notes recorded as the "Reason for change" land as VOICE_NOTE
// attachments on the PR. This panel lists them with an inline audio player so
// the spoken reason can be heard on the PR's own page.
function VoiceNotesPanel({ recordId, refreshKey }) {
  const [notes, setNotes] = useState([]);
  const [urls, setUrls] = useState({});

  useEffect(() => {
    if (!recordId) return;
    let alive = true;
    apiClient.get('/api/purchase/attachments/', { params: { module: 'PR', record_id: recordId, category: 'VOICE_NOTE' } })
      .then((res) => { if (alive) setNotes(res.data?.results || res.data || []); })
      .catch(() => { if (alive) setNotes([]); });
    return () => { alive = false; };
  }, [recordId, refreshKey]);

  useEffect(() => {
    notes.forEach((n) => {
      if (urls[n.id]) return;
      apiClient.get(`/api/purchase/attachments/${n.id}/signed-url/`)
        .then((res) => {
          const url = res.data?.url || res.data?.signed_url || res.data;
          if (url) setUrls((u) => ({ ...u, [n.id]: url }));
        })
        .catch(() => {});
    });
  }, [notes]);  // eslint-disable-line react-hooks/exhaustive-deps

  if (!notes.length) return null;

  return (
    <div className="mt-4 bg-white rounded-xl border border-slate-200 p-4">
      <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
        🎙 Voice Notes <span className="text-xs font-normal text-slate-400">({notes.length})</span>
      </h3>
      <div className="space-y-2">
        {notes.map((n) => (
          <div key={n.id} className="flex items-center gap-3 text-sm">
            {urls[n.id]
              ? <audio controls src={urls[n.id]} className="h-8" />
              : <span className="text-xs text-slate-400">Loading…</span>}
            <span className="text-xs text-slate-500">
              {n.uploaded_by_name || n.uploaded_by || ''} · {fmtSharedDateTime(n.created_at)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PurchaseRequestDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit, canDelete } = usePermissions();
  const { isHidden, isReadOnly } = useFieldPermissions('Purchase Request');
  const { isHidden: isLineHidden, isReadOnly: isLineRO } = useFieldPermissions('Purchase Request Line');
  const { options: warehouseOptions, raw: warehouseRaw } = useLookup('/api/warehouses/?scope=true');
  const { options: productOptions, raw: productRaw } = useAllProducts();

  // Goods category options (only 2 — mirrors backend validation in PRLine).
  const GOODS_CATEGORY_CHOICES = [
    { value: 'RAW_MATERIAL', label: 'Raw Material' },
    { value: 'PACKING_MATERIAL', label: 'Packing Material' },
    { value: 'FRUIT', label: 'Fruit' },
    { value: 'MAIZE', label: 'Maize' },
    { value: 'FINISHED_GOODS', label: 'FINISHED_GOOD' },
  ];
  const CATEGORY_LABEL = { RAW_MATERIAL: 'Raw Material', PACKING_MATERIAL: 'Packing Material', FRUIT: 'Fruit', MAIZE: 'Maize', FINISHED_GOODS: 'FINISHED_GOOD' };

  // Filter product options for Goods lines by the selected category.
  // Maps our two-option category to the corresponding goods_sub_type values on Product.
  const getFilteredProducts = (category, excludeIds = new Set()) => {
    const drop = (list) => list.filter(o => !excludeIds.has(String(o.value)));
    if (!category) return drop(productOptions);
    let subType = null;
    if (category === 'RAW_MATERIAL') subType = 'RAW_MATERIAL';
    else if (category === 'PACKING_MATERIAL') subType = 'PACKING_MATERIAL';
    else if (category === 'FINISHED_GOODS') subType = 'FINISHED_GOOD';
    if (!subType) return drop(productOptions);
    return drop(productRaw
      .filter(p => p.goods_sub_type === subType)
      .map(p => ({ value: p.id, label: p.product_name || p.sku_code || p.id })));
  };
  // Products already chosen on OTHER lines (no duplicate products per PR).
  const productsUsedExcept = (lines, idx) =>
    new Set((lines || []).filter((_, i) => i !== idx).map(l => String(l.product_service)).filter(Boolean));

  const [pr, setPr] = useState(null);
  // Fallback vendor picker for the Skip RFQ wizard (used when a PR's
  // products have no preferred vendor). Scoped to the PR's OWN company —
  // a vendor like "Gemini packs" is registered once per company, so an
  // SS PR must only offer the SS Gemini record, not the UAI duplicate.
  // Until the PR (and its company) loads, pass null so useLookup holds
  // off fetching; the wizard only opens on an already-loaded PR.
  // Also grab .raw so the Approve modal can auto-fill vendor defaults
  // (payment_terms) when a vendor is picked — .options is {value,label}
  // only, which drops the actual vendor fields.
  const { options: vendorOptions, raw: vendorRaw } = useLookup(
    pr?.company ? `/api/vendors/?company=${pr.company}` : null
  );
  // Sales Orders for the justification-reference dropdown (edit mode).
  // Labelled "SO-no — customer" so the WM can find the driving order fast.
  const { options: soOptions } = useLookup('/api/sales/orders/', {
    labelField: (so) => `${so.so_no || so.id}${so.customer_name ? ` — ${so.customer_name}` : ''}`,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isProceeding, setIsProceeding] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSkippingRfq, setIsSkippingRfq] = useState(false);
  const [editData, setEditData] = useState({});
  const [editLines, setEditLines] = useState([]);

  // Fetch PR data
  useEffect(() => {
    fetchPR();
  }, [id]);

  const fetchPR = async () => {
    setIsLoading(true);
    try {
      const res = await apiClient.get(`/api/purchase/requests/${id}/`);
      setPr(res.data);
      setEditData(res.data);
      setEditLines(initLines(res.data.lines || res.data.line_items || []));
    } catch (err) {
      if (err.response?.status !== 404) toast.error(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  // Status checks
  const approvalStatus = pr?.approval_status || pr?.status || 'DRAFT';
  // PENDING_APPROVAL is the Warehouse-Manager-approved stage, shown everywhere
  // on the PR as "Factory Approved". One helper so every badge/label agrees.
  const statusLabel = (s) => s === 'PENDING_APPROVAL' ? 'Factory Approved' : (s || '').replace(/_/g, ' ');
  const isApproved = approvalStatus === 'APPROVED';
  const isRejected = approvalStatus === 'REJECTED';
  const isEdited = false; // EDITED status no longer used
  // Strictly DRAFT only — once status moves out of DRAFT, non-admin cannot edit
  const isDraft = approvalStatus === 'DRAFT';
  const isSubmitted = approvalStatus === 'PENDING';                 // stage 1 done — awaiting Warehouse Manager
  const isPendingApproval = approvalStatus === 'PENDING_APPROVAL';  // stage 2 done — awaiting Purchase Coordinator

  // Permission checks
  const { canApprove: canApproveModule, canReject: canRejectModule, canSkipRfq: canSkipRfqPerm, canSubmit: canSubmitPerm, canProceedApproval: canProceedApprovalPerm, isAdmin: isAdminUser, isSuperuser, role } = usePermissions();
  // Edit is stage-aware — each stage's OWNER may correct the request
  // before acting on it: DRAFT for anyone with can_edit; PENDING for the
  // Proceed-to-Approve holder (Warehouse Manager); PENDING_APPROVAL for
  // the approver (Purchase Coordinator, e.g. adjusting qty for rate
  // factors). Every non-DRAFT edit demands a reason and lands in the
  // change trail. Mirrors PurchaseRequestViewSet._edit_blocked_response.
  const canEditPR = canEdit('Purchase Request') && (
    isAdminUser || isDraft
    || (isSubmitted && canProceedApprovalPerm('Purchase Request'))
    || (isPendingApproval && canApproveModule('Purchase Request'))
  );

  // Privileged-role list for PR. Delete and Reject are gated to these roles
  // PLUS the RBAC check — never just one. Approve uses the same list but as
  // a permissive fallback (OR) so the button stays visible when the cache is
  // stale. The backend still enforces every check.
  const PR_PRIVILEGED_ROLES = new Set(['admin', 'administrator', 'purchase coordinator', 'purchase manager', 'warehouse manager']);
  const _roleName = (role?.role_name || role?.name || '').trim().toLowerCase();
  const isPrivilegedPRUser = isAdminUser || isSuperuser || PR_PRIVILEGED_ROLES.has(_roleName);
  const canApproveAccess = canApproveModule('Purchase Request') || isPrivilegedPRUser;

  // 3-stage approval, each gated by its own flag:
  //   Stage 1 — SUBMIT (DRAFT → PENDING), e.g. Warehouse Coordinator.
  const canSubmitPR = isDraft && !isApproved && !isRejected
    && (canSubmitPerm('Purchase Request') || isAdminUser || isSuperuser);
  //   Stage 2 — PROCEED TO APPROVE (PENDING → PENDING_APPROVAL), e.g. Warehouse Manager.
  const canProceedPR = isSubmitted
    && (canProceedApprovalPerm('Purchase Request') || isAdminUser || isSuperuser);
  //   Stage 3 — APPROVE (PENDING_APPROVAL → APPROVED), e.g. Purchase Coordinator.
  const canApprovePR = isPendingApproval && canApproveAccess && !isApproved;
  // Reject surfaces once the PR is submitted (stage 2 or 3), gated by
  // can_reject AND the role list so a plain requester never sees it.
  const canRejectPR = (isSubmitted || isPendingApproval) && !isApproved && !isRejected
    && canRejectModule('Purchase Request') && isPrivilegedPRUser;
  const canDeletePR = canDelete('Purchase Request') && isPrivilegedPRUser && (isAdminUser || isDraft);

  // RFQ Skip — gated on the dedicated `can_skip_rfq` flag on the
  // Purchase Request module (set per role in Admin → Permissions).
  //
  // Since the per-line routing modal on Approve (RFQ vs Skip→PO per
  // product), the standalone whole-PR Skip RFQ button is REDUNDANT at
  // PENDING_APPROVAL — routing every line to Skip does the same thing —
  // so it no longer shows there. It survives ONLY as a recovery path on
  // an APPROVED PR that ended up with no RFQ and no PO (legacy data or
  // an interrupted approval), where the routing modal is no longer
  // reachable.
  const canSkipRfq = canSkipRfqPerm('Purchase Request') || isAdminUser || isSuperuser;
  const noRfqLinked = !pr?.linked_rfq && !pr?.linked_rfq_id && !pr?.linked_rfq_no;
  const noPoCreated = !pr?.has_po;
  const eligibleStatusForSkip = !isRejected && approvalStatus !== 'CANCELLED' && noRfqLinked && noPoCreated;
  const showSkipRfqButton = canSkipRfq && eligibleStatusForSkip && isApproved;

  const handleDelete = async () => {
    if (!(await confirm({ message: 'Are you sure you want to delete this purchase request? This action cannot be undone.', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/requests/${id}/`);
      toast.success('Purchase request deleted successfully');
      navigate('/purchase/requests');
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to delete');
    }
  };

  // Map a legacy goods_sub_type value to one of our two simplified Goods categories.
  const subTypeToCategory = (subType) => {
    if (!subType) return '';
    if (subType === 'RAW_MATERIAL') return 'RAW_MATERIAL';
    if (subType === 'PACKING_MATERIAL') return 'PACKING_MATERIAL';
    if (subType === 'FINISHED_GOOD') return 'FINISHED_GOODS';
    return '';
  };

  // Read category from the backend; fall back to derived for lines saved before
  // the field existed (best-effort backfill from the product's goods_sub_type).
  const initLines = (lines) => {
    return (lines || []).map(l => {
      const prod = productRaw.find(p => p.id === l.product_service);
      const rawQty = l.quantity_requested;
      const cleanQty = rawQty != null && rawQty !== '' ? String(parseFloat(rawQty)) : '';
      const category = (l.category && String(l.category).trim()) || subTypeToCategory(prod?.goods_sub_type);
      return {
        ...l,
        category,
        quantity_requested: cleanQty,
      };
    });
  };

  // Handle edit toggle
  const handleEdit = () => {
    if (!canEditPR) return;
    setIsEditing(true);
    setEditData({ ...pr });
    setEditLines(initLines(pr.lines || pr.line_items || []));
  };

  // Handle cancel edit
  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditData({ ...pr });
    setEditLines(initLines(pr.lines || pr.line_items || []));
  };

  // Handle save (changes status to EDITED) - includes line items
  const handleSave = async () => {
    // Client-side validation: every line must have a category, and for Goods it must be one of the two values.
    const reqType = (editData.requirement_type || 'GOODS').toUpperCase();
    const candidateLines = editLines.filter(l => l.product_service);
    for (let i = 0; i < candidateLines.length; i++) {
      const l = candidateLines[i];
      const cat = (l.category || '').trim();
      if (!cat) {
        toast.error(`Line ${i + 1}: Category is required.`);
        return;
      }
      if (reqType === 'GOODS' && !['RAW_MATERIAL', 'PACKING_MATERIAL', 'FINISHED_GOODS'].includes(cat)) {
        toast.error(`Line ${i + 1}: For Goods, Category must be Raw Material, Packing Material, or Finished Goods.`);
        return;
      }
      // Quantity is mandatory on every line.
      if (!(parseFloat(l.quantity_requested) > 0)) {
        toast.error(`Line ${i + 1}: Quantity is required and must be greater than 0.`);
        return;
      }
    }

    // Editing a SUBMITTED (non-draft) PR requires a reason — the backend
    // appends it to the PR's change trail and rejects the edit without one.
    // DRAFT saves are unchanged.
    let editReason = null;
    let reasonAudio = null;
    if (!isDraft) {
      const r = await promptText({ title: 'Reason for change', label: 'Why is this being changed? (type or record a voice note)', multiline: true, required: true, voice: true, confirmLabel: 'Save' });
      if (r === null) return;
      // voice:true resolves to { text, audioFile }.
      editReason = (r.text || '').trim();
      reasonAudio = r.audioFile || null;
      // A voice-only reason (clip, no text) still counts — label it so the
      // change trail isn't blank.
      if (!editReason && reasonAudio) editReason = '[Voice note attached]';
    }

    setIsSaving(true);
    try {
      const payload = {
        warehouse: editData.warehouse,
        godown: editData.godown || null,
        priority: editData.priority,
        required_by_date: editData.required_by_date || null,
        justification: editData.justification || '',
        notes: editData.notes || '',
        requirement_type: editData.requirement_type,
        requestor_role: editData.requestor_role || '',
        lines: editLines.filter(l => l.product_service).map((l, i) => {
          const linePayload = {
            line_no: l.line_no || i + 1,
            category: (l.category || '').trim(),
            product_service: l.product_service,
            quantity_requested: l.quantity_requested,
            uom: l.uom || 'KG',
            description_override: l.description_override || '',
            purpose: l.purpose || '',
          };
          if (l.id && !l._isNew) linePayload.id = l.id;
          return linePayload;
        }),
      };
      Object.keys(payload).forEach(k => {
        if (payload[k] === null || payload[k] === undefined) delete payload[k];
      });
      // After the null-cleanup on purpose: an explicit null must reach the
      // API so clearing the SO reference actually unlinks it.
      payload.sales_order = editData.sales_order || null;
      if (editReason !== null) payload.edit_reason = editReason;

      const res = await apiClient.post(`/api/purchase/requests/${id}/edit/`, payload);
      // Attach the spoken reason as a voice-note clip on the PR, so it plays
      // back on this page's attachments. Non-fatal: a failed upload must not
      // undo the saved edit.
      if (reasonAudio) {
        try {
          await uploadPendingFiles('PR', id, [reasonAudio], 'VOICE_NOTE');
        } catch (e) {
          toast.error('Edit saved, but the voice note could not be attached.');
        }
      }
      setPr(res.data);
      setEditData(res.data);
      setEditLines((res.data.lines || res.data.line_items || []).map(l => ({ ...l })));
      setIsEditing(false);
      toast.success('Purchase Request saved. You can now approve it.');
    } catch (err) {
      if (import.meta.env.DEV) console.error('[PR Edit] error:', err.response?.data);
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  // Stage 1 — submit a draft PR for review (DRAFT → PENDING).
  const handlePrSubmit = async () => {
    if (!(await confirm({ message: 'Submit this Purchase Request for review?' }))) return;
    setIsSubmitting(true);
    try {
      await apiClient.post(`/api/purchase/requests/${id}/submit/`);
      toast.success('Submitted for review.');
      fetchPR();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to submit');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle proceed to approve (Pending → Pending Approval)
  const handleProceedToApprove = async () => {
    if (!(await confirm({ message: 'Move this Purchase Request to the approver?' }))) return;
    setIsProceeding(true);
    try {
      const res = await apiClient.post(`/api/purchase/requests/${id}/proceed-to-approve/`);
      toast.success('PR sent for approval');
      fetchPR();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to proceed');
    } finally {
      setIsProceeding(false);
    }
  };

  // Handle approve
  // Approve with the per-line routing chosen in the modal: Skip lines cut
  // PO(s) (one per vendor), RFQ lines create one RFQ.
  const submitApproveRouting = async () => {
    const lines = pr?.lines || [];
    // Skip and Hold both need a vendor picked; Hold skips the unit-price
    // check (that's the whole point of Hold).
    const missingSkip = lines.filter((l) => lineRoutes[l.id]?.route === 'SKIP' && !lineRoutes[l.id]?.vendor);
    if (missingSkip.length) {
      toast.error(`Pick a vendor for the Skip-routed product(s): ${missingSkip.map(lineLabel).join(', ')}`);
      return;
    }
    // Rate proof is MANDATORY for every Skip-RFQ line.
    const missingProof = lines.filter((l) => lineRoutes[l.id]?.route === 'SKIP' && !lineRoutes[l.id]?.rateProofFile);
    if (missingProof.length) {
      toast.error(`Attach a rate proof (invoice / quote) for the Skip RFQ product(s): ${missingProof.map(lineLabel).join(', ')}`);
      return;
    }
    const missingHold = lines.filter((l) => lineRoutes[l.id]?.route === 'HOLD' && !lineRoutes[l.id]?.vendor);
    if (missingHold.length) {
      toast.error(`A held line needs a vendor even without a price: ${missingHold.map(lineLabel).join(', ')}`);
      return;
    }
    // Splits sanity: sum of batch qtys must equal the line qty and
    // every batch needs qty > 0. Backend re-validates but a clear
    // client-side error saves a round trip.
    for (const l of lines) {
      const r = lineRoutes[l.id] || {};
      if (r.route !== 'SKIP') continue;
      const splits = Array.isArray(r.splits) ? r.splits : [];
      if (!splits.length) continue;
      const lineQty = parseFloat(l.quantity_requested ?? l.quantity ?? 0) || 0;
      const zeros = splits.filter(s => !(parseFloat(s.quantity) > 0));
      if (zeros.length) {
        toast.error(`${lineLabel(l)}: every batch quantity must be greater than 0.`);
        return;
      }
      const sum = splits.reduce((a, s) => a + (parseFloat(s.quantity) || 0), 0);
      if (Math.abs(sum - lineQty) > 0.0001) {
        toast.error(`${lineLabel(l)}: batch quantities (${sum}) must add up to the line quantity (${lineQty}).`);
        return;
      }
    }
    // Skip lines with no unit price → confirm before proceeding. The
    // backend accepts price=0 and creates the DRAFT PO, but the PO's
    // own Approve button stays disabled until a real price is set,
    // which trips operators later. Force a conscious choice here.
    const zeroPriceSkip = lines.filter((l) => {
      const r = lineRoutes[l.id] || {};
      if (r.route !== 'SKIP') return false;
      const p = parseFloat(r.unit_price);
      return !(p > 0);
    });
    if (zeroPriceSkip.length > 0) {
      const bullets = zeroPriceSkip.map((l) => `• ${lineLabel(l)}`).join('\n');
      const ok = await confirm({
        title: `${zeroPriceSkip.length} Skip line${zeroPriceSkip.length > 1 ? 's' : ''} without a Unit Price`,
        message: (
          `${bullets}\n\n`
          + `The DRAFT PO${zeroPriceSkip.length > 1 ? 's' : ''} will be created with ₹0 and cannot be Approved / emailed to the vendor `
          + `until you open the DRAFT PO and set the Unit Price there.\n\n`
          + `Proceed anyway?`
        ),
        confirmLabel: 'Approve without price',
        isDangerous: false,
      });
      if (!ok) return;
    }
    setIsApproving(true);
    try {
      const line_routes = {};
      lines.forEach((l) => {
        const r = lineRoutes[l.id] || {};
        if (r.route === 'SKIP') {
          line_routes[l.id] = {
            route: 'SKIP', vendor: r.vendor, unit_price: r.unit_price, quantity: r.quantity,
            gst: r.gst, payment_terms: r.payment_terms, freight_terms: r.freight_terms,
            // Optional batch split — omit when empty so the backend
            // takes the standard single-PO path.
            splits: Array.isArray(r.splits) && r.splits.length ? r.splits.map(s => ({
              quantity: s.quantity,
              delivery_date: s.delivery_date || '',
            })) : undefined,
          };
        } else if (r.route === 'HOLD') {
          line_routes[l.id] = {
            route: 'HOLD', vendor: r.vendor,
            gst: r.gst, payment_terms: r.payment_terms, freight_terms: r.freight_terms,
          };
        } else {
          line_routes[l.id] = { route: 'RFQ' };
        }
      });
      const res = await apiClient.post(`/api/purchase/requests/${id}/approve/`, { line_routes });
      toast.success(res.data.message || 'Approved successfully!');
      // Upload the rate-proof files from the Skip lines onto the PR (RATE_PROOF).
      const proofFiles = lines.map((l) => lineRoutes[l.id]?.rateProofFile).filter(Boolean);
      if (proofFiles.length) {
        try { await uploadPendingFiles('PR', id, proofFiles, 'RATE_PROOF'); }
        catch (e) { toast.error('Approved, but a rate-proof file failed to upload.'); }
      }
      const poCount = res.data.po_count || 0;
      const holdCount = res.data.hold_count || 0;
      if (poCount) toast.success(`${poCount} PO(s) created via RFQ skip`);
      if (res.data.rfq_no) toast.success(`RFQ ${res.data.rfq_no} created`);
      if (holdCount) toast.success(`${holdCount} line(s) held pending price`);
      setRouteModalOpen(false);
      // Exactly one PO and no RFQ and no held lines → jump to the PO to
      // set prices. Held lines mean the operator still has work to do on
      // this PR, so stay put.
      if (poCount === 1 && !res.data.rfq_no && !holdCount && res.data.pos?.[0]?.id) {
        navigate(`/purchase/orders/${res.data.pos[0].id}`);
        return;
      }
      fetchPR();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to approve');
    } finally {
      setIsApproving(false);
    }
  };

  // Handle reject
  const handleReject = async () => {
    const reason = await promptText({ title: 'Reject Purchase Request', label: 'Rejection reason', placeholder: 'Why is this PR being rejected?', multiline: true, required: true, confirmLabel: 'Reject', isDangerous: true });
    if (reason === null) return;
    setIsRejecting(true);
    try {
      await apiClient.post(`/api/purchase/requests/${id}/reject/`, { reason });
      toast.success('Purchase Request rejected');
      fetchPR();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to reject');
    } finally {
      setIsRejecting(false);
    }
  };

  // Convert-held-line modal state. `convertLine` is the PR line row
  // (or null when closed); `convertForm` collects the operator's inputs
  // for the DRAFT PO the backend creates on submit.
  const [convertLine, setConvertLine] = useState(null);
  const [convertForm, setConvertForm] = useState({
    vendor: '', unit_price: '', quantity: '',
    payment_terms: '', freight_terms: '', gst: '',
  });
  const [isConverting, setIsConverting] = useState(false);

  const openConvertModal = (line) => {
    setConvertLine(line);
    // Residual = qty on the PR line still open for routing. On a
    // partial-routed line the operator has already committed some to
    // one PO, so this is what's left. Falls back to full requested
    // qty for legacy lines the backend hasn't computed for yet.
    const residual = parseFloat(line.residual_quantity ?? line.quantity_requested ?? 0) || 0;
    setConvertForm({
      vendor: line.preferred_vendor || '',
      unit_price: '',
      quantity: residual > 0 ? String(residual) : (line.quantity_requested ?? ''),
      payment_terms: '',
      freight_terms: '',
      // Auto-fill GST from the product master if available — same rule
      // as the Approve modal so the operator doesn't retype it.
      gst: line.product_gst_percentage ?? '',
    });
  };

  const submitConvertHeldLine = async () => {
    if (!convertLine) return;
    if (!convertForm.vendor) {
      toast.error('Pick a vendor.');
      return;
    }
    const price = parseFloat(convertForm.unit_price);
    if (!(price > 0)) {
      toast.error('Enter a unit price greater than 0.');
      return;
    }
    setIsConverting(true);
    try {
      const payload = {
        vendor: convertForm.vendor,
        unit_price: convertForm.unit_price,
        quantity: convertForm.quantity || null,
        payment_terms: convertForm.payment_terms || '',
        freight_terms: convertForm.freight_terms || '',
        gst: convertForm.gst || '0',
      };
      const res = await apiClient.post(
        `/api/purchase/requests/${id}/lines/${convertLine.id}/convert/`,
        payload,
      );
      toast.success(res.data.message || 'Line converted to DRAFT PO.');
      setConvertLine(null);
      fetchPR();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to convert line.');
    } finally {
      setIsConverting(false);
    }
  };

  // Bulk convert — multi-select held lines and convert them together
  // into ONE DRAFT PO (same vendor). Complements the per-line convert
  // above for the "one vendor quoted everything" case.
  const [bulkSelected, setBulkSelected] = useState([]);      // held PR line ids
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkForm, setBulkForm] = useState({ vendor: '', payment_terms: '', freight_terms: '', lines: [] });
  const [isBulkConverting, setIsBulkConverting] = useState(false);

  const toggleBulkLine = (lineId) =>
    setBulkSelected((prev) => (prev.includes(lineId) ? prev.filter((x) => x !== lineId) : [...prev, lineId]));

  const openBulkModal = (heldLines) => {
    const picked = heldLines.filter((l) => bulkSelected.includes(l.id));
    if (picked.length < 2) return;
    // Default vendor: the one all picked lines agree on (if any).
    const vendorIds = [...new Set(picked.map((l) => l.preferred_vendor).filter(Boolean))];
    setBulkForm({
      vendor: vendorIds.length === 1 ? vendorIds[0] : '',
      payment_terms: '',
      freight_terms: '',
      lines: picked.map((l) => {
        const residual = parseFloat(l.residual_quantity ?? l.quantity_requested ?? 0) || 0;
        return {
          id: l.id,
          line_no: l.line_no,
          label: lineLabel(l),
          uom: l.uom || '',
          residual,
          quantity: residual > 0 ? String(residual) : '',
          unit_price: '',
          gst: l.product_gst_percentage ?? '',
        };
      }),
    });
    setBulkOpen(true);
  };

  const setBulkLine = (idx, field, value) =>
    setBulkForm((prev) => ({
      ...prev,
      lines: prev.lines.map((l, i) => (i === idx ? { ...l, [field]: value } : l)),
    }));

  const submitBulkConvert = async () => {
    if (!bulkForm.vendor) { toast.error('Pick a vendor.'); return; }
    for (const l of bulkForm.lines) {
      if (!(parseFloat(l.unit_price) > 0)) {
        toast.error(`Line #${l.line_no}: enter a unit price greater than 0.`);
        return;
      }
      const qty = parseFloat(l.quantity);
      if (!(qty > 0)) {
        toast.error(`Line #${l.line_no}: enter a quantity greater than 0.`);
        return;
      }
      if (l.residual > 0 && qty > l.residual) {
        toast.error(`Line #${l.line_no}: only ${l.residual} remains open.`);
        return;
      }
    }
    setIsBulkConverting(true);
    try {
      const res = await apiClient.post(`/api/purchase/requests/${id}/lines/convert-bulk/`, {
        vendor: bulkForm.vendor,
        payment_terms: bulkForm.payment_terms || '',
        freight_terms: bulkForm.freight_terms || '',
        lines: bulkForm.lines.map((l) => ({
          id: l.id,
          unit_price: l.unit_price,
          quantity: l.quantity || null,
          gst: l.gst || '0',
        })),
      });
      toast.success(res.data.message || 'Lines converted to one DRAFT PO.');
      setBulkOpen(false);
      setBulkSelected([]);
      fetchPR();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to convert lines.');
    } finally {
      setIsBulkConverting(false);
    }
  };

  // Allow RFQ Skip wizard state
  const [skipWizardOpen, setSkipWizardOpen] = useState(false);
  const [skipWizardLoading, setSkipWizardLoading] = useState(false);
  const [preferredVendors, setPreferredVendors] = useState([]);
  const [selectedVendorId, setSelectedVendorId] = useState('');
  // Optional per-line vendor override → skip-RFQ clubs into one PO per vendor.
  const [lineVendors, setLineVendors] = useState({}); // { prLineId: vendorId }
  // Optional per-line unit price typed in the wizard → seeds the DRAFT PO line.
  const [linePrices, setLinePrices] = useState({}); // { prLineId: unitPrice }
  // Optional per-line ordered qty (defaults to the requested qty).
  const [lineQtys, setLineQtys] = useState({}); // { prLineId: qty }
  const [lineGsts, setLineGsts] = useState({}); // { prLineId: gstPercent }

  // Per-line approval routing: each product is sent to an RFQ or skipped
  // straight to a PO (one PO per vendor). Opened by the Approve button on a
  // PENDING_APPROVAL PR. { prLineId: { route:'RFQ'|'SKIP', vendor, unit_price, quantity } }
  const [routeModalOpen, setRouteModalOpen] = useState(false);
  const [lineRoutes, setLineRoutes] = useState({});
  const setRoute = (lineId, key, value) =>
    setLineRoutes((prev) => ({ ...prev, [lineId]: { ...(prev[lineId] || {}), [key]: value } }));

  // Picking a vendor in the Approve-route modal also auto-fills the
  // per-line payment_terms (from Vendor master) and gst (from the line's
  // product master), sparing operators from looking them up per line.
  // Only fills BLANK slots — anything the operator has already typed
  // stays put. Called from the vendor <CustomSelect>'s onChange.
  const setRouteVendor = (line, vendorId) => {
    const v = (vendorRaw || []).find((x) => String(x.id) === String(vendorId));
    setLineRoutes((prev) => {
      const cur = prev[line.id] || {};
      return {
        ...prev,
        [line.id]: {
          ...cur,
          vendor: vendorId,
          payment_terms: cur.payment_terms || (v?.payment_terms || ''),
          gst: (cur.gst !== '' && cur.gst != null) ? cur.gst
               : (line.product_gst_percentage ?? ''),
        },
      };
    });
  };
  // Bulk-set every line's route — drives the "All RFQ" checkbox.
  const setAllRoutes = (route) =>
    setLineRoutes((prev) => {
      const next = { ...prev };
      (pr?.lines || []).forEach((l) => { next[l.id] = { ...(next[l.id] || {}), route }; });
      return next;
    });
  const openRouteModal = () => {
    const seed = {};
    (pr?.lines || []).forEach((l) => {
      // If a preferred vendor is already assigned, pre-fill its default
      // payment_terms from the vendor master. GST always pre-fills from
      // the product master (regardless of vendor).
      const v = l.preferred_vendor
        ? (vendorRaw || []).find((x) => String(x.id) === String(l.preferred_vendor))
        : null;
      seed[l.id] = {
        // Default every product to Skip → PO; the "All RFQ" checkbox flips
        // the whole PR to RFQ in one click.
        route: 'SKIP',
        vendor: l.preferred_vendor || '',
        unit_price: '',
        quantity: l.quantity_requested ?? l.quantity ?? '',
        payment_terms: v?.payment_terms || '',
        freight_terms: '',
        gst: l.product_gst_percentage ?? '',
      };
    });
    setLineRoutes(seed);
    setRouteModalOpen(true);
  };
  const lineLabel = (l) =>
    l.product_service_name || l.product_name || l.machinery_name
    || l.service_catalogue_name || l.item_name || `Line ${l.line_no}`;

  // Per-line preferred vendors (from each product's master preferred_vendors),
  // keyed by pr_line_id — drives the "ask which vendor" picker on skip-RFQ.
  const lineVendorMap = useMemo(() => {
    const map = {};
    (preferredVendors || []).forEach((v) => {
      (v.supplied_products || []).forEach((sp) => {
        if (!sp.pr_line_id) return;
        (map[sp.pr_line_id] = map[sp.pr_line_id] || []).push({ id: v.id, name: v.vendor_name, code: v.vendor_code });
      });
    });
    return map;
  }, [preferredVendors]);

  // A product with EXACTLY ONE preferred vendor auto-assigns; a product with
  // MULTIPLE must be picked by the user (that's the "ask whom to send" flow).
  useEffect(() => {
    const auto = {};
    Object.entries(lineVendorMap).forEach(([lid, vs]) => { if (vs.length === 1) auto[lid] = vs[0].id; });
    if (Object.keys(auto).length) setLineVendors((prev) => ({ ...auto, ...prev }));
  }, [lineVendorMap]);

  // Picking a vendor via the radio applies it to every line's dropdown (only
  // for lines it's a valid option for). Re-syncs when the radio changes; a
  // manual per-line change afterward still wins until the radio changes again.
  useEffect(() => {
    if (!selectedVendorId) return;
    setLineVendors((prev) => {
      const next = { ...prev };
      (pr?.lines || []).forEach((l) => {
        const preferred = lineVendorMap[l.id] || [];
        const valid = preferred.length === 0 || preferred.some((pv) => pv.id === selectedVendorId);
        if (valid) next[l.id] = selectedVendorId;
      });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVendorId]);

  // Open the wizard: fetch preferred vendors for the PR's products.
  const openSkipRfqWizard = async () => {
    setSkipWizardOpen(true);
    setSelectedVendorId('');
    setLineVendors({});
    setLinePrices({});
    setLineQtys({});
    setLineGsts({});
    setSkipWizardLoading(true);
    try {
      const res = await apiClient.get(`/api/purchase/requests/${id}/preferred-vendors/`);
      const vendors = res.data?.vendors || [];
      setPreferredVendors(vendors);
      if (vendors.length === 1) setSelectedVendorId(vendors[0].id);
    } catch (err) {
      const errMsg = err.response?.data?.error || err.response?.data?.detail || 'Failed to load preferred vendors';
      toast.error(errMsg);
      setPreferredVendors([]);
    } finally {
      setSkipWizardLoading(false);
    }
  };

  // One-shot Skip RFQ: vendor + PO creation happen in a single backend
  // call. The endpoint auto-approves the PR (DRAFT → APPROVED) and
  // cuts the PO in DRAFT for review — see `skip_rfq_create_po` in
  // purchase/views.py. The earlier two-step "configure + create"
  // wizard has been retired; admins kept ending up with PRs flagged
  // allow_rfq_skip=True but no PO because step 2 was skipped.
  const confirmSkipRfq = async () => {
    const lines = pr?.lines || [];
    // A product with multiple preferred vendors needs a vendor chosen — either
    // per line, or the fallback vendor selected above (which applies to all).
    const multiUnpicked = lines.filter((l) => (lineVendorMap[l.id]?.length || 0) > 1 && !lineVendors[l.id] && !selectedVendorId);
    if (multiUnpicked.length) {
      toast.error(`Choose a vendor for: ${multiUnpicked.map((l) => l.product_service_name || l.product_name || `Line ${l.line_no}`).join(', ')} — each has multiple preferred vendors (or pick a vendor above).`);
      return;
    }
    const allLinesCovered = lines.length > 0 && lines.every((l) => lineVendors[l.id]);
    if (!selectedVendorId && !allLinesCovered) {
      toast.error('Select a fallback vendor, or assign a vendor to every line.');
      return;
    }
    setIsSkippingRfq(true);
    try {
      const res = await apiClient.post(
        `/api/purchase/requests/${id}/skip-rfq-create-po/`,
        { vendor_id: selectedVendorId || null, line_vendors: lineVendors, line_prices: linePrices, line_qtys: lineQtys, line_gsts: lineGsts },
      );
      const count = res.data.count || (res.data.pos || []).length || 1;
      toast.success(res.data.message || `${count} PO(s) created (RFQ Skipped)!`);
      setSkipWizardOpen(false);
      // Land on the PO's send-email page so the user can PREVIEW + edit the
      // PO mail before it's sent to the vendor. (For a multi-PO skip, they
      // start with the first and send the rest from Orders.)
      const poId = res.data.po_id || (res.data.pos && res.data.pos[0] && res.data.pos[0].id);
      if (poId) navigate(`/purchase/orders/${poId}/send-email`);
      else navigate('/purchase/orders');
    } catch (err) {
      console.error('Skip RFQ create PO error:', err.response?.data || err);
      const errData = err.response?.data;
      const errMsg = typeof errData === 'object'
        ? (errData.error || errData.detail || JSON.stringify(errData))
        : 'Failed to create PO';
      toast.error(errMsg);
    } finally {
      setIsSkippingRfq(false);
    }
  };

  // Handle field change during edit
  const handleChange = (e) => {
    const { name, value } = e.target;
    setEditData(prev => ({ ...prev, [name]: value }));
  };

  // Local line item handlers (changes stay in state until Save)
  const handleEditLineChange = (index, field, value) => {
    setEditLines(prev => prev.map((line, i) => {
      if (i !== index) return line;
      const next = { ...line, [field]: value };
      // For Goods, when the user picks a different category, clear the product so they re-pick.
      if (field === 'category' && (editData?.requirement_type || pr?.requirement_type || 'GOODS').toUpperCase() === 'GOODS') {
        next.product_service = '';
      }
      // Auto-fill UOM from the product master when a product is picked.
      if (field === 'product_service' && value) {
        const prod = (productRaw || []).find(p => String(p.id) === String(value));
        if (prod?.uom) next.uom = prod.uom;
      }
      return next;
    }));
  };
  // Mirror new.jsx's hard cap. Backend rejects > 15; catch here for a
  // clearer toast than the generic 400.
  const MAX_PR_LINES = 15;
  const handleAddEditLine = () => {
    if (editLines.length >= MAX_PR_LINES) {
      toast.error(`A Purchase Request can hold at most ${MAX_PR_LINES} lines. Split the extras into a new PR.`);
      return;
    }
    const nextLineNo = editLines.length > 0 ? Math.max(...editLines.map(l => l.line_no || 0)) + 1 : 1;
    setEditLines(prev => [...prev, { _isNew: true, line_no: nextLineNo, category: '', product_service: '', quantity_requested: '', uom: 'KG', description_override: '', purpose: '' }]);
  };
  const handleRemoveEditLine = (index) => {
    setEditLines(prev => prev.filter((_, i) => i !== index));
  };

  // Format date for display
  const formatDate = (dateStr) => {
    if (!dateStr) return '-';
    return fmtSharedDate(dateStr);
  };

  // Format datetime for display
  const formatDateTime = (dateStr) => {
    if (!dateStr) return '-';
    return fmtSharedDateTime(dateStr);
  };

  // Get warehouse name from ID
  const getWarehouseName = (warehouseId) => {
    if (!warehouseId) return '-';
    const wh = warehouseRaw.find(w => String(w.id) === String(warehouseId));
    return wh?.name || warehouseId;
  };

  // (line item columns are rendered inline in the table below)

  // Loading state
  if (isLoading) {
    return (
      <MainLayout>
        <div className="space-y-2 max-w-6xl">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-32 bg-slate-200 rounded animate-pulse" />
          ))}
        </div>
      </MainLayout>
    );
  }

  // Not found state
  if (!pr) {
    return (
      <MainLayout>
        <div className="text-center py-12">
          <FileText className="mx-auto text-slate-300 mb-4" size={48} />
          <p className="text-slate-600 text-lg">Purchase Request not found</p>
          <button
            onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/purchase/requests'))}
            className="mt-4 px-4 py-2 text-blue-600 hover:text-blue-800 transition"
          >
            Back to Purchase Requests
          </button>
        </div>
      </MainLayout>
    );
  }

  const prNumber = pr.prNumber || pr.pr_number || pr.pr_no || `PR-${id}`;
  const lineItems = pr.lines || pr.lineItems || pr.line_items || pr.items || [];

  const breadcrumbs = [
    { label: 'Purchase', href: '/purchase/requests' },
    { label: 'Requests', href: '/purchase/requests' },
    { label: prNumber },
  ];

  return (
    <MainLayout breadcrumbs={breadcrumbs}>
      <div className="max-w-6xl space-y-2">

        {/* ── Design E: Approval-First Banner ── */}
        {/* Show the banner to whoever can act on the current stage: the
            Warehouse Manager (Proceed, at PENDING) OR the Purchase Coordinator
            (Approve, at PENDING_APPROVAL). Previously gated on canApproveAccess
            only, which hid the Proceed button from the WM. */}
        {!isEditing && (isPendingApproval || isSubmitted) && (canApproveAccess || canProceedPR) && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-3 py-2.5 rounded-lg border border-amber-300 bg-gradient-to-r from-amber-50 to-yellow-50">
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-bold text-amber-900">
                {isPendingApproval ? '⏳ Awaiting Your Approval' : '⏳ Awaiting Review'}
              </p>
              <p className="text-[11px] text-amber-700 mt-0.5">
                Submitted by {pr.created_by_name || '—'} on {formatDate(pr.createdDate || pr.created_at || pr.created_date)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {isPendingApproval && (
                <button onClick={openRouteModal} disabled={isApproving} className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded-md text-xs font-semibold hover:bg-green-700 transition disabled:opacity-50">
                  <CheckCircle size={13} /> {isApproving ? 'Approving...' : 'Approve'}
                </button>
              )}
              {canProceedPR && (
                <button onClick={handleProceedToApprove} disabled={isProceeding} className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 text-white rounded-md text-xs font-semibold hover:bg-amber-600 transition disabled:opacity-50">
                  <CheckCircle size={13} /> {isProceeding ? 'Sending...' : 'Proceed to Approve'}
                </button>
              )}
              {canRejectPR && (
                <button onClick={handleReject} disabled={isRejecting} className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 text-red-600 border border-red-200 rounded-md text-xs font-semibold hover:bg-red-100 transition disabled:opacity-50">
                  <XCircle size={13} /> {isRejecting ? 'Rejecting...' : 'Reject'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Approved banner ── */}
        {isApproved && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-3 py-2.5 rounded-lg border border-green-300 bg-gradient-to-r from-green-50 to-emerald-50">
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-bold text-green-900 flex items-center gap-1.5">
                <CheckCircle size={14} className="text-green-600" /> Approved
              </p>
              <p className="text-[11px] text-green-700 mt-0.5">
                {pr.approved_by || pr.approvedBy ? `By ${pr.approved_by || pr.approvedBy}` : ''}
                {(pr.approved_at || pr.approvedAt) ? ` on ${formatDateTime(pr.approved_at || pr.approvedAt)}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {(pr.linked_rfq_no || pr.rfq_no) && (
                <Link to={`/purchase/rfq/${pr.linked_rfq_id || pr.rfq_id || ''}`} className="flex items-center gap-1 px-2.5 py-1 bg-white border border-green-200 rounded-md text-xs font-medium text-green-800 hover:bg-green-50 transition">
                  <LinkIcon size={12} /> RFQ {pr.linked_rfq_no || pr.rfq_no}
                </Link>
              )}
              {showSkipRfqButton && (
                <button onClick={openSkipRfqWizard} disabled={isSkippingRfq} className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 text-white rounded-md text-xs font-semibold hover:bg-amber-600 transition disabled:opacity-50">
                  <SkipForward size={13} /> {isSkippingRfq ? 'Creating PO...' : 'Skip RFQ'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Rejected banner ── */}
        {isRejected && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-3 py-2.5 rounded-lg border border-red-300 bg-gradient-to-r from-red-50 to-rose-50">
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-bold text-red-900 flex items-center gap-1.5">
                <XCircle size={14} className="text-red-600" /> Rejected
              </p>
              <p className="text-[11px] text-red-700 mt-0.5">
                {pr.rejected_by ? `By ${pr.rejected_by}` : ''}
                {pr.rejected_at ? ` on ${formatDateTime(pr.rejected_at)}` : ''}
                {(pr.reject_reason || pr.rejection_reason) ? ` — "${pr.reject_reason || pr.rejection_reason}"` : ''}
              </p>
            </div>
          </div>
        )}

        {/* ── Header row: Back + PR# + badge + chips + actions ── */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 flex-wrap mb-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button
              onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/purchase/requests'))}
              className="p-1 text-slate-400 hover:text-slate-700 transition shrink-0"
              title="Back to list"
            >
              <ArrowLeft size={18} />
            </button>
            <h1 className="text-lg sm:text-xl font-bold text-slate-900 truncate">{prNumber}</h1>
            <StatusBadge status={approvalStatus} label={statusLabel(approvalStatus)} />
            {/* Inline chips */}
            <div className="hidden sm:flex items-center gap-1.5 ml-1">
              {pr.company_name && <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{pr.company_name}</span>}
              {pr.priority && <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${pr.priority === 'HIGH' ? 'bg-red-50 text-red-600' : pr.priority === 'MEDIUM' ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-500'}`}>{pr.priority}</span>}
              {(pr.required_by_date || pr.deliveryDate) && <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">Due {formatDate(pr.required_by_date || pr.deliveryDate)}</span>}
              {pr.requestor_role && <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{pr.requestor_role}</span>}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-wrap ml-6 sm:ml-0">
            {!isEditing && canEditPR && !isApproved && !isRejected && (
              <button onClick={handleEdit} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 rounded-md text-slate-700 hover:bg-slate-50 transition text-xs font-medium">
                <Edit3 size={13} /> Edit
              </button>
            )}
            {!isEditing && canDeletePR && !isApproved && !isRejected && (
              <button onClick={handleDelete} className="flex items-center gap-1.5 px-3 py-1.5 border border-red-200 rounded-md text-red-600 hover:bg-red-50 transition text-xs font-medium">
                <Trash2 size={13} /> Delete
              </button>
            )}
            {isEditing && (
              <>
                <button onClick={handleSave} disabled={isSaving} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-md text-xs font-semibold hover:bg-blue-700 transition disabled:opacity-50">
                  <Save size={13} /> {isSaving ? 'Saving...' : 'Save'}
                </button>
                <button onClick={handleCancelEdit} disabled={isSaving} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 rounded-md text-slate-700 hover:bg-slate-50 transition text-xs font-medium">
                  <X size={13} /> Cancel
                </button>
              </>
            )}
            {!isEditing && canSubmitPR && (
              <button onClick={handlePrSubmit} disabled={isSubmitting} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-md text-xs font-semibold hover:bg-blue-700 transition disabled:opacity-50">
                <CheckCircle size={13} /> {isSubmitting ? 'Submitting...' : 'Submit'}
              </button>
            )}
            {/* Approve/Reject/Proceed are in the banner above, not duplicated here */}
          </div>
        </div>

        {/* Mobile chips row (hidden on desktop) */}
        <div className="flex sm:hidden items-center gap-1.5 flex-wrap ml-7">
          {pr.company_name && <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{pr.company_name}</span>}
          {pr.priority && <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${pr.priority === 'HIGH' ? 'bg-red-50 text-red-600' : pr.priority === 'MEDIUM' ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-500'}`}>{pr.priority}</span>}
          {(pr.required_by_date || pr.deliveryDate) && <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">Due {formatDate(pr.required_by_date || pr.deliveryDate)}</span>}
          {pr.requestor_role && <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{pr.requestor_role}</span>}
        </div>

        {/* ── Single-row field strip ── */}
        <div className="bg-white rounded-lg border border-slate-200 px-3 py-2">
          {!isEditing ? (
            <div className="flex items-start gap-4 overflow-x-auto" style={{ fontSize: 0 }}>
              {!isHidden('warehouse') && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Warehouse</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{pr.warehouse_name || getWarehouseName(pr.warehouse) || '-'}</p></div>
              )}
              {!isHidden('godown') && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Godown</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{pr.godown_name || '-'}</p></div>
              )}
              {!isHidden('requirement_type') && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Requirement</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{pr.requirement_type_display || pr.requirement_type || '-'}</p></div>
              )}
              {!isHidden('preferred_vendor') && (pr.allow_rfq_skip || pr.preferred_vendor || pr.preferred_vendor_name) && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Pref. Vendor</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{pr.preferred_vendor_name || pr.preferred_vendor || '-'}</p></div>
              )}
              <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">SO Ref</p>
                {pr.sales_order ? (
                  <button type="button" onClick={() => navigate(`/sales/orders/${pr.sales_order}`)} style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-blue-600 hover:underline whitespace-nowrap">{pr.sales_order_no || 'View SO'}</button>
                ) : (<p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800">-</p>)}
              </div>
              {pr.created_by_name && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Created By</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{pr.created_by_name}</p></div>
              )}
              {!isHidden('justification') && pr.justification && (
                <div className="min-w-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Justification</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-700 truncate max-w-[260px]" title={pr.justification}>{pr.justification}</p></div>
              )}
              {!isHidden('notes') && pr.notes && (
                <div className="min-w-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Notes</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-700 truncate max-w-[200px]" title={pr.notes}>{pr.notes}</p></div>
              )}
            </div>
          ) : (
            /* Edit mode: 2-col grid on mobile, 4-col on desktop */
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1.5">
              {!isHidden('warehouse') && (
                <div>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Warehouse</p>
                  {!isReadOnly('warehouse') ? (
                    <CustomSelect name="warehouse" value={editData.warehouse || ''} onChange={handleChange} className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500">
                      <option value="">Select...</option>
                      {warehouseOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </CustomSelect>
                  ) : (<p className="text-[12px] font-medium text-slate-800">{pr.warehouse_name || getWarehouseName(pr.warehouse) || '-'}</p>)}
                </div>
              )}
              {!isHidden('godown') && (
                <div>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Godown</p>
                  {!isReadOnly('godown') ? (
                    <GodownEditSelect warehouse={editData.warehouse} value={editData.godown || ''} onChange={handleChange} />
                  ) : (<p className="text-[12px] font-medium text-slate-800">{pr.godown_name || '-'}</p>)}
                </div>
              )}
              {!isHidden('requirement_type') && (
                <div>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Requirement Type</p>
                  {!isReadOnly('requirement_type') ? (
                    <CustomSelect name="requirement_type" value={editData.requirement_type || 'GOODS'} onChange={handleChange} className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500">
                      <option value="GOODS">Goods</option>
                      <option value="MACHINERY">Machinery</option>
                    </CustomSelect>
                  ) : (<p className="text-[12px] font-medium text-slate-800">{pr.requirement_type_display || pr.requirement_type || '-'}</p>)}
                </div>
              )}
              {!isHidden('priority') && (
                <div>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Priority</p>
                  {!isReadOnly('priority') ? (
                    <CustomSelect name="priority" value={editData.priority || ''} onChange={handleChange} className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500">
                      <option value="">Select...</option>
                      <option value="LOW">Low</option>
                      <option value="MEDIUM">Medium</option>
                      <option value="HIGH">High</option>
                    </CustomSelect>
                  ) : (<p className="text-[12px] font-medium text-slate-800">{pr.priority || '-'}</p>)}
                </div>
              )}
              {!isHidden('required_by_date') && (
                <div>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Required By</p>
                  {!isReadOnly('required_by_date') ? (
                    <CustomDatePicker name="required_by_date" value={editData.required_by_date || ''} onChange={handleChange} className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  ) : (<p className="text-[12px] font-medium text-slate-800">{formatDate(pr.required_by_date || pr.deliveryDate)}</p>)}
                </div>
              )}
              {!isHidden('requestor_role') && (
                <div>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Requestor Role</p>
                  {!isReadOnly('requestor_role') ? (
                    <input type="text" name="requestor_role" value={editData.requestor_role || ''} onChange={handleChange} className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  ) : (<p className="text-[12px] font-medium text-slate-800">{pr.requestor_role || '-'}</p>)}
                </div>
              )}
              <div>
                <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Sales Order Ref</p>
                <CustomSelect name="sales_order" value={editData.sales_order || ''} onChange={handleChange} className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500">
                  <option value="">None</option>
                  {soOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              {!isHidden('justification') && (
                <div className="col-span-2 sm:col-span-4">
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Justification</p>
                  {!isReadOnly('justification') ? (
                    <textarea name="justification" value={editData.justification || ''} onChange={handleChange} rows={1} placeholder="Justification..." className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  ) : (<p className="text-[12px] text-slate-700">{pr.justification || '-'}</p>)}
                </div>
              )}
              {!isHidden('notes') && (
                <div className="col-span-2 sm:col-span-4">
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Notes</p>
                  {!isReadOnly('notes') ? (
                    <textarea name="notes" value={editData.notes || ''} onChange={handleChange} rows={1} placeholder="Notes..." className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  ) : (<p className="text-[12px] text-slate-700">{pr.notes || '-'}</p>)}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Full-width content below ── */}

            {/* Held Lines — only when the PR has any PENDING_PRICE
                lines. Surfaces exactly the work the operator still owes
                the system so it doesn't get lost. */}
            {(() => {
              const held = (pr?.lines || []).filter((l) => {
                if (l.status === 'PENDING_PRICE') return true;
                // Stranded RFQ-skip lines: approved for skip-routing but
                // the PO never materialised (declined ₹0-price confirm,
                // vendor never assigned, PO cancelled later…). They carry
                // an open residual yet aren't PENDING_PRICE, so without
                // this they vanish from the UI with no way to route them.
                const residual = parseFloat(l.residual_quantity ?? 0) || 0;
                return l.status === 'APPROVED' && l.allow_rfq_skip && residual > 0;
              });
              if (held.length === 0) return null;
              const heldSelected = held.filter((l) => bulkSelected.includes(l.id));
              const allHeldSelected = held.length > 0 && heldSelected.length === held.length;
              return (
                <div className="bg-blue-50/60 rounded-lg border border-blue-300 p-2.5 sm:p-3">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-2">
                    <h2 className="text-[11px] font-semibold text-blue-900 uppercase tracking-wide">
                      Pending routing ({held.length})
                    </h2>
                    <p className="text-xs text-blue-700">
                      Each line has an open residual — convert it into a DRAFT PO now, or leave for later.
                    </p>
                  </div>
                  {/* Multi-select toolbar — combine held lines for ONE
                      vendor into a single DRAFT PO instead of one PO
                      per line. Only useful with 2+ lines held. */}
                  {held.length > 1 && (
                    <div className="flex flex-wrap items-center gap-3 mb-3">
                      <label className="flex items-center gap-1.5 text-xs text-blue-900 font-medium cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={allHeldSelected}
                          onChange={() => setBulkSelected(allHeldSelected ? [] : held.map((l) => l.id))}
                          className="rounded border-blue-300"
                        />
                        Select all
                      </label>
                      {heldSelected.length >= 2 && (
                        <button
                          type="button"
                          onClick={() => openBulkModal(held)}
                          className="px-3 py-1.5 text-xs sm:text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                        >
                          Convert {heldSelected.length} together → one PO
                        </button>
                      )}
                      {heldSelected.length === 1 && (
                        <span className="text-[11px] text-blue-700">Select at least one more line to combine into one PO.</span>
                      )}
                    </div>
                  )}
                  <div className="space-y-2">
                    {held.map((l) => {
                      const residual = parseFloat(l.residual_quantity ?? l.quantity_requested ?? 0) || 0;
                      const requested = parseFloat(l.quantity_requested ?? 0) || 0;
                      const isPartial = residual > 0 && residual !== requested;
                      return (
                        <div key={`hold-${l.id}`} className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-lg border border-blue-200 bg-white px-3 py-2">
                          {held.length > 1 && (
                            <input
                              type="checkbox"
                              checked={bulkSelected.includes(l.id)}
                              onChange={() => toggleBulkLine(l.id)}
                              className="shrink-0 rounded border-blue-300 self-start sm:self-center"
                              aria-label={`Select line ${l.line_no} for bulk convert`}
                            />
                          )}
                          <div className="sm:flex-1 min-w-0">
                            <p className="text-sm font-medium text-slate-800 truncate">
                              #{l.line_no} · {lineLabel(l)}
                            </p>
                            <p className="text-xs text-slate-500">
                              {isPartial ? (
                                <>
                                  <span className="text-amber-700 font-medium">
                                    Residual: {residual.toLocaleString()} of {requested.toLocaleString()} {l.uom || ''}
                                  </span>
                                  {' '}(rest already routed)
                                </>
                              ) : (
                                <>{requested.toLocaleString()} {l.uom || ''}</>
                              )}
                              {l.preferred_vendor_name && (
                                <> · Vendor: <span className="text-slate-700">{l.preferred_vendor_name}</span></>
                              )}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => openConvertModal(l)}
                            className="shrink-0 px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                          >
                            {isPartial ? 'Route more' : 'Set price & convert'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Line Items */}
            <div className="bg-white rounded-lg border border-slate-200">
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100">
                <h2 style={{ fontSize: 11 }} className="font-semibold text-slate-500 uppercase tracking-wider">Line Items ({(isEditing ? editLines : lineItems).length})</h2>
                {isEditing && (
                  <button
                    type="button"
                    onClick={handleAddEditLine}
                    disabled={editLines.length >= MAX_PR_LINES}
                    title={editLines.length >= MAX_PR_LINES ? `Maximum ${MAX_PR_LINES} lines per PR` : ''}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs text-primary-600 border border-primary-300 rounded hover:bg-primary-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    + Add Item {editLines.length >= MAX_PR_LINES && `(${MAX_PR_LINES} max)`}
                  </button>
                )}
              </div>

              {(() => {
                const displayLines = isEditing ? editLines : lineItems;
                const reqType = (editData?.requirement_type || pr?.requirement_type || 'GOODS').toUpperCase();
                const isGoods = reqType === 'GOODS';
                return displayLines.length > 0 ? (
                  <>
                  {/* Mobile-stacked cards. Same data as the desktop
                      table below, but each line gets a vertical card
                      so the screen never needs horizontal scroll on a
                      phone. View mode shows read-only key/value rows;
                      edit mode swaps in the same inputs the table
                      uses. */}
                  <div className="sm:hidden space-y-2 p-2">
                    {displayLines.map((line, idx) => {
                      const lineCategory = line.category || line._category || '';
                      return (
                        <div key={`m-${line.id || `new-${idx}`}`} className="border border-slate-200 rounded-lg bg-white overflow-hidden">
                          <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-b border-slate-100">
                            <div className="min-w-0">
                              <p className="text-[11px] uppercase tracking-wide text-slate-500">Line #{line.line_no || idx + 1}</p>
                              <p className="text-sm font-semibold text-slate-800 truncate">{line.product_name || line.product_code || '(new line)'}</p>
                            </div>
                            {isEditing && (
                              <button onClick={() => handleRemoveEditLine(idx)} className="p-1 text-red-500 hover:bg-red-50 rounded" title="Remove">
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                          <div className="px-3 py-2.5 text-sm grid grid-cols-6 gap-x-3 gap-y-2.5">
                            {!isLineHidden('category') && (
                            <div className="col-span-3">
                              <p className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide mb-0.5">Category {isEditing && <span className="text-red-500">*</span>}</p>
                              {isEditing && !isLineRO('category') ? (
                                isGoods ? (
                                  <CustomSelect value={lineCategory} onChange={e => handleEditLineChange(idx, 'category', e.target.value)} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm">
                                    <option value="">Select Category...</option>
                                    {GOODS_CATEGORY_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                                  </CustomSelect>
                                ) : (
                                  <input type="text" value={lineCategory} onChange={e => handleEditLineChange(idx, 'category', e.target.value)} placeholder="Type category..." className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
                                )
                              ) : (<p className="text-sm sm:text-base text-slate-900 font-medium sm:font-semibold mt-0.5 break-words">{lineCategory ? (CATEGORY_LABEL[lineCategory] || lineCategory) : '-'}</p>)}
                            </div>
                            )}
                            {/* Product selector — edit only. View mode already
                                shows the product in the card header, so we
                                don't repeat it here. */}
                            {isEditing && !isLineHidden('product_service') && (
                              <div className="col-span-6">
                                <p className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide mb-0.5">Product <span className="text-red-500">*</span></p>
                                <CustomSelect value={line.product_service || ''} onChange={e => handleEditLineChange(idx, 'product_service', e.target.value)} disabled={isLineRO('product_service')} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm disabled:bg-slate-100 disabled:cursor-not-allowed">
                                  <option value="">{(isGoods && lineCategory) || !isGoods ? 'Select Product' : 'Select Category first'}</option>
                                  {(() => {
                                    const used = productsUsedExcept(displayLines, idx);
                                    const opts = isGoods ? getFilteredProducts(lineCategory, used) : productOptions.filter(o => !used.has(String(o.value)));
                                    return opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>);
                                  })()}
                                </CustomSelect>
                              </div>
                            )}
                            {!isLineHidden('description_override') && (
                            <div className="col-span-3">
                              <p className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide mb-0.5">Description</p>
                              {isEditing && !isLineRO('description_override') ? (
                                <input type="text" value={line.description_override || ''} onChange={e => handleEditLineChange(idx, 'description_override', e.target.value)} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
                              ) : (<p className="text-sm sm:text-base text-slate-900 font-medium sm:font-semibold mt-0.5 break-words">{line.description_override || '-'}</p>)}
                            </div>
                            )}
                            {!isLineHidden('quantity_requested') && (
                            <div className="col-span-2">
                              <p className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide mb-0.5">Qty {isEditing && <span className="text-red-500">*</span>}</p>
                              {isEditing && !isLineRO('quantity_requested') ? (
                                <input type="number" min="0.01" step="any" required value={line.quantity_requested ?? ''} onChange={e => handleEditLineChange(idx, 'quantity_requested', e.target.value)} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
                              ) : (
                                <>
                                  <p className="text-slate-700">{parseFloat(line.quantity_requested) || '-'}</p>
                                  {!isEditing && pr?.has_po && line.ordered_quantity != null && (
                                    <p className="text-[10px] text-slate-500 mt-0.5">Ordered {line.ordered_quantity} · Bal {line.balance_quantity ?? '-'}</p>
                                  )}
                                  {!isEditing && line.allow_rfq_skip && (
                                    <span className="inline-flex mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700">RFQ skipped → PO</span>
                                  )}
                                </>
                              )}
                            </div>
                            )}
                            {!isLineHidden('uom') && (
                            <div className="col-span-2">
                              <p className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide mb-0.5">UOM</p>
                              {isEditing && !isLineRO('uom') ? (
                                <CustomSelect value={line.uom || 'KG'} onChange={e => handleEditLineChange(idx, 'uom', e.target.value)} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm">
                                  {line.uom && !UOM_VALUES.includes(line.uom) && (
                                    <option value={line.uom}>{line.uom}</option>
                                  )}
                                  {UOM_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                  ))}
                                </CustomSelect>
                              ) : (<p className="text-sm sm:text-base text-slate-900 font-medium sm:font-semibold mt-0.5 break-words">{line.uom || '-'}</p>)}
                            </div>
                            )}
                            {!isLineHidden('purpose') && (
                            <div className="col-span-2 min-w-0">
                              <p className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide mb-0.5">Purpose</p>
                              {isEditing && !isLineRO('purpose') ? (
                                <input type="text" value={line.purpose || ''} onChange={e => handleEditLineChange(idx, 'purpose', e.target.value)} className="w-full px-2 py-1.5 border border-slate-300 rounded text-sm" />
                              ) : (<p className="text-sm sm:text-base text-slate-900 font-medium sm:font-semibold mt-0.5 break-words">{line.purpose || '-'}</p>)}
                            </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Desktop table — hidden on phones. */}
                  <div className="hidden sm:block overflow-x-auto">
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="border-b border-slate-200">
                          <th className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase text-[9px] tracking-wide whitespace-nowrap">#</th>
                          {!isLineHidden('category') && <th className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase text-[9px] tracking-wide whitespace-nowrap">Category {isEditing && <span className="text-red-500">*</span>}</th>}
                          {!isLineHidden('product_service') && <th className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase text-[9px] tracking-wide whitespace-nowrap">Product {isEditing && <span className="text-red-500">*</span>}</th>}
                          <th className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase text-[9px] tracking-wide whitespace-nowrap">Stock</th>
                          {!isLineHidden('description_override') && <th className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase text-[9px] tracking-wide whitespace-nowrap">Description</th>}
                          {!isLineHidden('quantity_requested') && <th className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase text-[9px] tracking-wide whitespace-nowrap">Qty {isEditing && <span className="text-red-500">*</span>}</th>}
                          {!isLineHidden('uom') && <th className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase text-[9px] tracking-wide whitespace-nowrap">UOM</th>}
                          {!isLineHidden('purpose') && <th className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase text-[9px] tracking-wide whitespace-nowrap">Purpose</th>}
                          {isEditing && <th className="px-2 py-1.5" style={{ width: 32 }}></th>}
                        </tr>
                      </thead>
                      <tbody>
                        {displayLines.map((line, idx) => {
                          const reqType = (editData?.requirement_type || pr?.requirement_type || 'GOODS').toUpperCase();
                          const isGoods = reqType === 'GOODS';
                          const lineCategory = line.category || line._category || '';
                          return (
                          <tr key={line.id || `new-${idx}`} className="border-b border-slate-100 hover:bg-slate-50/60 transition-colors">
                            <td className="px-2 py-1.5 text-slate-400">{line.line_no || idx + 1}</td>
                            {!isLineHidden('category') && (
                            <td className="px-2 py-1.5">
                              {isEditing && !isLineRO('category') ? (
                                isGoods ? (
                                  <CustomSelect
                                    value={lineCategory}
                                    onChange={e => handleEditLineChange(idx, 'category', e.target.value)}
                                    className="w-full px-1.5 py-1 border border-slate-300 rounded text-[11px]"
                                  >
                                    <option value="">Select...</option>
                                    {GOODS_CATEGORY_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                                  </CustomSelect>
                                ) : (
                                  <input
                                    type="text"
                                    value={lineCategory}
                                    onChange={e => handleEditLineChange(idx, 'category', e.target.value)}
                                    placeholder="Category..."
                                    className="w-full px-1.5 py-1 border border-slate-300 rounded text-[11px]"
                                  />
                                )
                              ) : (
                                <span className="text-slate-700 text-[11px]">
                                  {lineCategory ? (CATEGORY_LABEL[lineCategory] || lineCategory) : '-'}
                                </span>
                              )}
                            </td>
                            )}
                            {!isLineHidden('product_service') && (
                            <td className="px-2 py-1.5">
                              {isEditing && !isLineRO('product_service') ? (
                                <CustomSelect value={line.product_service || ''} onChange={e => handleEditLineChange(idx, 'product_service', e.target.value)} className="w-full px-1.5 py-1 border border-slate-300 rounded text-[11px]">
                                  <option value="">{(isGoods && lineCategory) || !isGoods ? 'Select Product' : 'Category first'}</option>
                                  {(() => {
                                    const used = productsUsedExcept(displayLines, idx);
                                    const opts = isGoods ? getFilteredProducts(lineCategory, used) : productOptions.filter(o => !used.has(String(o.value)));
                                    return opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>);
                                  })()}
                                </CustomSelect>
                              ) : (<span className="font-medium truncate block">{line.product_name || line.product_code || '-'}</span>)}
                            </td>
                            )}
                            <td className="px-2 py-1.5 text-right text-slate-600 tabular-nums">
                              {(() => {
                                const stock = line.current_stock ?? line.available_stock;
                                if (stock === null || stock === undefined || stock === '') return <span className="text-[10px] text-slate-300">—</span>;
                                const n = Number(stock);
                                const tone = Number.isFinite(n) && n < 0
                                  ? 'bg-red-50 border-red-200 text-red-800'
                                  : 'bg-sky-50 border-sky-200 text-sky-900';
                                return (
                                  <span className={`inline-block px-1.5 py-0.5 text-[10px] rounded border ${tone}`}>
                                    {n.toLocaleString('en-IN')}
                                    {line.uom && <span className="text-[9px] text-slate-400 ml-0.5">{line.uom}</span>}
                                  </span>
                                );
                              })()}
                            </td>
                            {!isLineHidden('description_override') && (
                            <td className="px-2 py-1.5">
                              {isEditing && !isLineRO('description_override') ? (
                                <input type="text" value={line.description_override || ''} onChange={e => handleEditLineChange(idx, 'description_override', e.target.value)} className="w-full px-1.5 py-1 border border-slate-300 rounded text-[11px]" />
                              ) : (<span className="truncate block">{line.description_override || '-'}</span>)}
                            </td>
                            )}
                            {!isLineHidden('quantity_requested') && (
                            <td className="px-2 py-1.5 text-right tabular-nums">
                              {isEditing && !isLineRO('quantity_requested') ? (
                                <input type="number" min="0.01" step="any" required value={line.quantity_requested ?? ''} onChange={e => handleEditLineChange(idx, 'quantity_requested', e.target.value)} className="w-full px-1.5 py-1 border border-slate-300 rounded text-[11px] text-right" />
                              ) : (
                                <>
                                  <span className="font-medium">{parseFloat(line.quantity_requested) || '-'}</span>
                                  {!isEditing && pr?.has_po && line.ordered_quantity != null && (
                                    <p className="text-[9px] text-slate-500 mt-0.5">Ord {line.ordered_quantity} · Bal {line.balance_quantity ?? '-'}</p>
                                  )}
                                  {!isEditing && line.allow_rfq_skip && (
                                    <span className="inline-flex mt-0.5 px-1 py-0.5 rounded text-[9px] font-medium bg-amber-100 text-amber-700">Skip→PO</span>
                                  )}
                                </>
                              )}
                            </td>
                            )}
                            {!isLineHidden('uom') && (
                            <td className="px-2 py-1.5 text-slate-600">
                              {isEditing && !isLineRO('uom') ? (
                                <CustomSelect value={line.uom || 'KG'} onChange={e => handleEditLineChange(idx, 'uom', e.target.value)} className="w-full px-1 py-1 border border-slate-300 rounded text-[11px]">
                                  {line.uom && !UOM_VALUES.includes(line.uom) && (
                                    <option value={line.uom}>{line.uom}</option>
                                  )}
                                  {UOM_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                  ))}
                                </CustomSelect>
                              ) : (line.uom || '-')}
                            </td>
                            )}
                            {!isLineHidden('purpose') && (
                            <td className="px-2 py-1.5">
                              {isEditing && !isLineRO('purpose') ? (
                                <input type="text" value={line.purpose || ''} onChange={e => handleEditLineChange(idx, 'purpose', e.target.value)} className="w-full px-1.5 py-1 border border-slate-300 rounded text-[11px]" />
                              ) : (<span className="truncate block">{line.purpose || '-'}</span>)}
                            </td>
                            )}
                            {isEditing && (
                              <td className="px-2 py-1.5 text-center">
                                <button onClick={() => handleRemoveEditLine(idx)} className="p-0.5 text-red-500 hover:bg-red-50 rounded" title="Remove"><Trash2 size={12} /></button>
                              </td>
                            )}
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  </>
                ) : (
                  <div className="text-center py-8 text-slate-400">
                    <p>No line items yet.</p>
                    {isEditing && <p className="text-sm mt-1">Click "+ Add Item" to add products to this request.</p>}
                  </div>
                );
              })()}
            </div>

        {/* ── Collapsible bottom sections: Attachments + Activity ── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
            <details className="group">
              <summary className="flex items-center justify-between px-3 py-2 cursor-pointer select-none hover:bg-slate-50 transition">
                <span style={{ fontSize: 11 }} className="font-semibold text-slate-500 uppercase tracking-wider">Attachments</span>
                <span className="text-[10px] text-blue-600 font-medium group-open:hidden">View ↓</span>
                <span className="text-[10px] text-blue-600 font-medium hidden group-open:inline">Hide ↑</span>
              </summary>
              <div className="border-t border-slate-100">
                <FileAttachments module="PR" recordId={id} readOnly={!isEditing} />
              </div>
            </details>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
            <details className="group">
              <summary className="flex items-center justify-between px-3 py-2.5 cursor-pointer select-none hover:bg-slate-50 transition">
                <span className="text-[11px] font-semibold text-slate-800 uppercase tracking-wide flex items-center gap-1.5">
                  <Clock size={13} className="text-slate-400" />
                  Activity Timeline ({buildAuditTrail(pr).length} events)
                </span>
                <span className="text-[10px] text-blue-600 font-medium group-open:hidden">View ↓</span>
                <span className="text-[10px] text-blue-600 font-medium hidden group-open:inline">Hide ↑</span>
              </summary>
              <div className="px-3 pb-3 border-t border-slate-100">
                <div className="flex items-start overflow-x-auto ios-scroll pb-1 pt-2">
                  {buildAuditTrail(pr).map((entry, idx, arr) => (
                    <div key={idx} className="flex-1 min-w-[86px] flex flex-col items-center text-center" title={entry.remarks || undefined}>
                      <div className="flex items-center w-full">
                        <div className={`h-0.5 flex-1 ${idx === 0 ? 'bg-transparent' : 'bg-slate-200'}`} />
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                          entry.type === 'approved' ? 'bg-green-100'
                            : entry.type === 'rejected' ? 'bg-red-100'
                            : entry.type === 'edited' ? 'bg-blue-100'
                            : 'bg-slate-100'
                        }`}>
                          {entry.type === 'approved' ? <CheckCircle className="text-green-600" size={13} />
                            : entry.type === 'rejected' ? <XCircle className="text-red-600" size={13} />
                            : entry.type === 'edited' ? <Edit3 className="text-blue-600" size={13} />
                            : <Clock className="text-slate-500" size={13} />}
                        </div>
                        <div className={`h-0.5 flex-1 ${idx === arr.length - 1 ? 'bg-transparent' : 'bg-slate-200'}`} />
                      </div>
                      <p className="text-[10px] font-medium text-slate-900 mt-1 px-1 leading-tight">{entry.action}</p>
                      <p className="text-[9px] text-slate-500 mt-0.5 px-1 leading-tight">
                        {entry.user && <span className="block truncate max-w-[80px] mx-auto">{entry.user}</span>}
                        {entry.date}
                      </p>
                      {entry.remarks && (
                        <p className="text-[9px] italic text-slate-400 mt-0.5 px-1 leading-tight break-words">{entry.remarks}</p>
                      )}
                      {(entry.changes || []).length > 0 && (
                        <div className="mt-0.5 px-1 space-y-0.5">
                          {entry.changes.map((c, ci) => (
                            <p key={ci} className="text-[9px] text-slate-500 leading-tight break-words">
                              {c.label}: {c.old} → {c.new}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {buildAuditTrail(pr).length === 0 && (
                    <p className="text-xs text-slate-500 text-center py-2 w-full">No activity recorded</p>
                  )}
                </div>
              </div>
            </details>
          </div>
        </div>

        <VoiceNotesPanel recordId={id} refreshKey={pr?.updated_at} />
      </div>

      {/* Approve — per-product RFQ / Skip routing. Skip products cut a DRAFT
          PO (one per vendor); RFQ products create one RFQ. */}
      {routeModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90dvh] flex flex-col" role="dialog" aria-modal="true" aria-label="Approve — route products">
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b">
              <div className="flex items-center gap-2">
                <CheckCircle size={20} className="text-green-600" />
                <h2 className="text-lg font-semibold text-slate-800">Approve — route each product</h2>
              </div>
              <button onClick={() => setRouteModalOpen(false)} className="p-1 text-slate-400 hover:text-slate-600"><XCircle size={20} /></button>
            </div>
            <div className="px-4 sm:px-6 py-4 overflow-y-auto">
              <p className="text-sm text-slate-500 mb-3">
                Choose per product: <span className="font-medium text-slate-700">RFQ</span> for competitive quotes, or
                <span className="font-medium text-amber-700"> Skip RFQ</span> for a known single vendor. Skip-RFQ
                products create a DRAFT PO (one per vendor); RFQ products create one RFQ.
              </p>
              {/* Bulk toggle — checking flips every product to RFQ; unchecking
                  returns them all to the Skip → PO default. */}
              {(() => {
                const lines = pr?.lines || [];
                const allRfq = lines.length > 0 && lines.every((l) => (lineRoutes[l.id]?.route || 'SKIP') === 'RFQ');
                return (
                  <label className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg border border-slate-200 bg-slate-50 text-sm font-medium text-slate-700 select-none cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allRfq}
                      onChange={(e) => setAllRoutes(e.target.checked ? 'RFQ' : 'SKIP')}
                      className="rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                    />
                    All RFQ (get quotes)
                  </label>
                );
              })()}
              <div className="space-y-2">
                {(pr?.lines || []).map((l) => {
                  const r = lineRoutes[l.id] || { route: 'SKIP' };
                  const isSkip = r.route === 'SKIP';
                  const isHold = r.route === 'HOLD';
                  const rowBorder = isSkip
                    ? 'border-amber-300 bg-amber-50/50'
                    : isHold
                      ? 'border-blue-300 bg-blue-50/40'
                      : 'border-slate-200';
                  return (
                    <div key={l.id} className={`rounded-lg border p-3 ${rowBorder}`}>
                      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                        <div className="sm:flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-800 truncate">{lineLabel(l)}</p>
                          <p className="text-xs text-slate-500">{Number(l.quantity_requested ?? l.quantity ?? 0).toLocaleString()} {l.uom || ''}</p>
                        </div>
                        <div className="sm:w-44 shrink-0">
                          <CustomSelect value={r.route} onChange={(e) => setRoute(l.id, 'route', e.target.value)} className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm">
                            <option value="RFQ">RFQ (get quotes)</option>
                            <option value="SKIP">Skip RFQ</option>
                            <option value="HOLD">Hold — awaiting price</option>
                          </CustomSelect>
                        </div>
                      </div>
                      {(isSkip || isHold) && (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
                          <div>
                            <label className="block text-[11px] text-slate-500 mb-0.5">Vendor <span className="text-red-500">*</span></label>
                            <CustomSelect value={r.vendor || ''} onChange={(e) => setRouteVendor(l, e.target.value)} className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm">
                              <option value="">Select vendor…</option>
                              {vendorOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </CustomSelect>
                          </div>
                          {/* Unit price + Qty only apply to Skip → PO. For Hold
                              the whole point is that the price isn't known
                              yet, so we hide the price / qty inputs and just
                              collect the vendor + optional terms. */}
                          {isSkip && (
                            <>
                              <div>
                                <label className="block text-[11px] text-slate-500 mb-0.5">Unit price</label>
                                <input type="number" step="any" min="0" value={r.unit_price || ''} onChange={(e) => setRoute(l.id, 'unit_price', e.target.value)} placeholder="0.00" className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm text-right" />
                              </div>
                              <div>
                                <label className="block text-[11px] text-slate-500 mb-0.5">
                                  Qty
                                  {(() => {
                                    const lineQ = parseFloat(l.quantity_requested ?? l.quantity ?? 0) || 0;
                                    const enteredQ = parseFloat(r.quantity) || 0;
                                    return enteredQ > 0 && enteredQ < lineQ ? (
                                      <span className="text-amber-700 font-normal ml-1">
                                        (partial route: {lineQ - enteredQ} {l.uom || ''} residual stays on PR)
                                      </span>
                                    ) : null;
                                  })()}
                                </label>
                                <input type="number" step="any" min="0" value={r.quantity ?? ''} onChange={(e) => setRoute(l.id, 'quantity', e.target.value)} placeholder={`Full: ${l.quantity_requested ?? ''}`} className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm text-right" />
                              </div>
                            </>
                          )}
                          {/* Terms + tax seeded onto the DRAFT PO (still editable
                              on the PO). Payment + Freight are PO-level; GST is
                              set on the PO line. Held lines can pre-fill these
                              too so they carry over when the line is later
                              converted. */}
                          <div>
                            <label className="block text-[11px] text-slate-500 mb-0.5">Payment Terms</label>
                            <CustomSelect value={r.payment_terms || ''} onChange={(e) => setRoute(l.id, 'payment_terms', e.target.value)} className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm">
                              <option value="">—</option>
                              {withCurrent(PAYMENT_TERM_OPTIONS, r.payment_terms).map((o) => <option key={o} value={o}>{o}</option>)}
                            </CustomSelect>
                          </div>
                          <div>
                            <label className="block text-[11px] text-slate-500 mb-0.5">Freight / Delivery Terms</label>
                            <CustomSelect value={r.freight_terms || ''} onChange={(e) => setRoute(l.id, 'freight_terms', e.target.value)} className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm">
                              <option value="">—</option>
                              {withCurrent(FREIGHT_TERM_OPTIONS, r.freight_terms).map((o) => <option key={o} value={o}>{o}</option>)}
                            </CustomSelect>
                          </div>
                          <div>
                            <label className="block text-[11px] text-slate-500 mb-0.5">GST %</label>
                            <input type="number" step="0.01" min="0" max="100" value={r.gst ?? ''} onChange={(e) => setRoute(l.id, 'gst', e.target.value)} placeholder="0" className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm text-right" />
                          </div>
                          {/* Rate proof — mandatory invoice / quote that justifies
                              this product's unit price when skipping RFQ to a PO.
                              Uploaded to the PR (RATE_PROOF) after approve. */}
                          {isSkip && (
                            <div className="sm:col-span-3">
                              <label className="block text-[11px] text-slate-500 mb-0.5">Rate proof (invoice / quote) <span className="text-red-500">*</span></label>
                              <div className="flex items-center gap-2">
                                <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border border-dashed border-amber-300 text-amber-700 rounded-lg cursor-pointer hover:bg-amber-50">
                                  <Paperclip size={13} />
                                  {r.rateProofFile ? 'Change file' : 'Attach file'}
                                  <input type="file" accept="image/*,.pdf" className="hidden"
                                    onChange={(e) => { const f = e.target.files?.[0] || null; e.target.value = ''; setRoute(l.id, 'rateProofFile', f); }} />
                                </label>
                                {r.rateProofFile && (
                                  <span className="inline-flex items-center gap-1.5 text-xs text-slate-600 min-w-0">
                                    <span className="truncate max-w-[220px]">{r.rateProofFile.name}</span>
                                    <button type="button" onClick={() => setRoute(l.id, 'rateProofFile', null)} className="text-slate-400 hover:text-red-500" title="Remove"><XCircle size={13} /></button>
                                  </span>
                                )}
                              </div>
                            </div>
                          )}
                          {isHold && (
                            <p className="sm:col-span-3 text-[11px] text-blue-700">
                              This line will be held on the PR until you set the unit price and convert it to a DRAFT PO.
                            </p>
                          )}
                          {/* Optional batch split for SKIP lines only —
                              a 1500-unit line can be routed as 3 x 500
                              POs with staggered delivery dates for cost
                              management. Each batch becomes an
                              independent DRAFT PO on approve. */}
                          {isSkip && (
                            <div className="sm:col-span-3 border-t border-amber-200 mt-1 pt-2">
                              {(() => {
                                const lineQty = parseFloat(l.quantity_requested ?? l.quantity ?? 0) || 0;
                                const splits = Array.isArray(r.splits) ? r.splits : [];
                                const splitOn = splits.length > 0;
                                const sum = splits.reduce((a, s) => a + (parseFloat(s.quantity) || 0), 0);
                                const balance = Math.round((lineQty - sum) * 100) / 100;
                                const toggle = (on) => {
                                  if (on) {
                                    // Seed 2 equal batches by default.
                                    const half = lineQty / 2;
                                    setRoute(l.id, 'splits', [
                                      { quantity: half ? String(half) : '', delivery_date: '' },
                                      { quantity: half ? String(half) : '', delivery_date: '' },
                                    ]);
                                  } else {
                                    setRoute(l.id, 'splits', []);
                                  }
                                };
                                const updateSplit = (i, key, value) => {
                                  const next = splits.map((s, idx) => idx === i ? { ...s, [key]: value } : s);
                                  setRoute(l.id, 'splits', next);
                                };
                                const addBatch = () => {
                                  if (splits.length >= 10) return;
                                  setRoute(l.id, 'splits', [...splits, { quantity: '', delivery_date: '' }]);
                                };
                                const removeBatch = (i) => {
                                  if (splits.length <= 2) return;
                                  setRoute(l.id, 'splits', splits.filter((_, idx) => idx !== i));
                                };
                                return (
                                  <>
                                    <label className="inline-flex items-center gap-1.5 text-[11px] text-amber-800 cursor-pointer select-none">
                                      <input
                                        type="checkbox"
                                        checked={splitOn}
                                        onChange={(e) => toggle(e.target.checked)}
                                        className="rounded border-slate-300"
                                      />
                                      Split into batches (create multiple DRAFT POs from this line)
                                    </label>
                                    {splitOn && (
                                      <div className="mt-2 space-y-1">
                                        {splits.map((s, i) => (
                                          <div key={i} className="flex items-center gap-2">
                                            <span className="text-[11px] text-slate-500 w-14 shrink-0">Batch {i + 1}</span>
                                            <input
                                              type="number" step="any" min="0"
                                              value={s.quantity ?? ''}
                                              onChange={(e) => updateSplit(i, 'quantity', e.target.value)}
                                              placeholder="Qty"
                                              className="w-28 border border-slate-300 rounded-lg px-2 py-1 text-sm text-right"
                                            />
                                            <CustomDatePicker
                                              value={s.delivery_date || ''}
                                              onChange={(e) => updateSplit(i, 'delivery_date', e.target.value)}
                                              className="flex-1 border border-slate-300 rounded-lg px-2 py-1 text-sm"
                                            />
                                            <button
                                              type="button"
                                              onClick={() => removeBatch(i)}
                                              disabled={splits.length <= 2}
                                              className="text-slate-400 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed text-lg leading-none px-1"
                                              title={splits.length <= 2 ? 'At least 2 batches required' : 'Remove batch'}
                                            >×</button>
                                          </div>
                                        ))}
                                        <div className="flex items-center justify-between pt-1">
                                          <button
                                            type="button"
                                            onClick={addBatch}
                                            disabled={splits.length >= 10}
                                            className="text-[11px] text-primary-600 hover:text-primary-800 hover:underline disabled:opacity-50"
                                          >
                                            + Add another batch
                                          </button>
                                          <span className={`text-[11px] font-medium ${balance === 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                                            Sum: {sum} / Line qty: {lineQty}
                                            {balance !== 0 && ` · Off by ${balance > 0 ? '−' : '+'}${Math.abs(balance)}`}
                                          </span>
                                        </div>
                                      </div>
                                    )}
                                  </>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 px-4 sm:px-6 py-4 border-t">
              <p className="text-xs text-slate-500">
                {(() => {
                  const lines = pr?.lines || [];
                  const skip = lines.filter((l) => lineRoutes[l.id]?.route === 'SKIP').length;
                  const hold = lines.filter((l) => lineRoutes[l.id]?.route === 'HOLD').length;
                  const rfq = lines.length - skip - hold;
                  const parts = [];
                  if (skip) parts.push(`${skip} to Skip RFQ`);
                  if (rfq) parts.push(`${rfq} to RFQ`);
                  if (hold) parts.push(`${hold} on Hold`);
                  return parts.join(' · ') || '—';
                })()}
              </p>
              <div className="flex items-center gap-2">
                <button onClick={() => setRouteModalOpen(false)} disabled={isApproving} className="px-4 py-2 text-sm border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
                <button onClick={submitApproveRouting} disabled={isApproving} className="px-4 py-2 text-sm font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 inline-flex items-center gap-1.5">
                  <CheckCircle size={16} /> {isApproving ? 'Approving…' : 'Approve'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Convert held PR line — enter price & terms, backend creates a
          single-line DRAFT PO for the vendor and flips the line status
          back to APPROVED (PR closes when the last held line is done). */}
      {convertLine && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => !isConverting && setConvertLine(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b">
              <div>
                <h2 className="text-lg font-semibold text-slate-800">Set price &amp; convert</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Line #{convertLine.line_no} · {lineLabel(convertLine)}
                </p>
              </div>
              <button type="button" className="text-slate-500 hover:text-slate-800" disabled={isConverting} onClick={() => setConvertLine(null)}>×</button>
            </div>
            <div className="px-4 sm:px-6 py-4 space-y-3">
              <div>
                <label className="block text-[11px] text-slate-500 mb-0.5">Vendor <span className="text-red-500">*</span></label>
                <CustomSelect
                  value={convertForm.vendor}
                  onChange={(e) => setConvertForm(prev => ({ ...prev, vendor: e.target.value }))}
                  className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm"
                >
                  <option value="">Select vendor…</option>
                  {vendorOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] text-slate-500 mb-0.5">Unit price <span className="text-red-500">*</span></label>
                  <input
                    type="number" step="any" min="0"
                    value={convertForm.unit_price}
                    onChange={(e) => setConvertForm(prev => ({ ...prev, unit_price: e.target.value }))}
                    placeholder="0.00"
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm text-right"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-0.5">
                    Qty
                    {convertLine && (() => {
                      const residual = parseFloat(convertLine.residual_quantity ?? convertLine.quantity_requested ?? 0) || 0;
                      const requested = parseFloat(convertLine.quantity_requested ?? 0) || 0;
                      return residual > 0 && residual !== requested ? (
                        <span className="text-amber-700 font-normal ml-1">
                          (residual: {residual} of {requested})
                        </span>
                      ) : null;
                    })()}
                  </label>
                  <input
                    type="number" step="any" min="0"
                    value={convertForm.quantity}
                    onChange={(e) => setConvertForm(prev => ({ ...prev, quantity: e.target.value }))}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm text-right"
                  />
                  <p className="text-[10px] text-slate-500 mt-0.5 italic">
                    Enter less than residual to leave a balance open on the PR for another PO later.
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] text-slate-500 mb-0.5">Payment Terms</label>
                  <CustomSelect
                    value={convertForm.payment_terms}
                    onChange={(e) => setConvertForm(prev => ({ ...prev, payment_terms: e.target.value }))}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm"
                  >
                    <option value="">—</option>
                    {withCurrent(PAYMENT_TERM_OPTIONS, convertForm.payment_terms).map((o) => <option key={o} value={o}>{o}</option>)}
                  </CustomSelect>
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-0.5">Freight / Delivery</label>
                  <CustomSelect
                    value={convertForm.freight_terms}
                    onChange={(e) => setConvertForm(prev => ({ ...prev, freight_terms: e.target.value }))}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm"
                  >
                    <option value="">—</option>
                    {withCurrent(FREIGHT_TERM_OPTIONS, convertForm.freight_terms).map((o) => <option key={o} value={o}>{o}</option>)}
                  </CustomSelect>
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-0.5">GST %</label>
                <input
                  type="number" step="0.01" min="0" max="100"
                  value={convertForm.gst}
                  onChange={(e) => setConvertForm(prev => ({ ...prev, gst: e.target.value }))}
                  placeholder="0"
                  className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm text-right"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 sm:px-6 py-4 border-t">
              <button type="button" onClick={() => setConvertLine(null)} disabled={isConverting} className="px-4 py-2 text-sm border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
              <button type="button" onClick={submitConvertHeldLine} disabled={isConverting} className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {isConverting ? 'Converting…' : 'Create DRAFT PO'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk convert held PR lines — one vendor, one DRAFT PO with all
          selected lines. Per-line price/qty/GST; shared terms. */}
      {bulkOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => !isBulkConverting && setBulkOpen(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90dvh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b">
              <div>
                <h2 className="text-lg font-semibold text-slate-800">Convert {bulkForm.lines.length} lines → one DRAFT PO</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  All lines go to the same vendor on a single PO. Enter a price for every line.
                </p>
              </div>
              <button type="button" className="text-slate-500 hover:text-slate-800" disabled={isBulkConverting} onClick={() => setBulkOpen(false)}>×</button>
            </div>
            <div className="px-4 sm:px-6 py-4 space-y-3 overflow-y-auto flex-1">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                  <label className="block text-[11px] text-slate-500 mb-0.5">Vendor <span className="text-red-500">*</span></label>
                  <CustomSelect
                    value={bulkForm.vendor}
                    onChange={(e) => setBulkForm(prev => ({ ...prev, vendor: e.target.value }))}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm"
                  >
                    <option value="">Select vendor…</option>
                    {vendorOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-0.5">Payment Terms</label>
                  <CustomSelect
                    value={bulkForm.payment_terms}
                    onChange={(e) => setBulkForm(prev => ({ ...prev, payment_terms: e.target.value }))}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm"
                  >
                    <option value="">—</option>
                    {withCurrent(PAYMENT_TERM_OPTIONS, bulkForm.payment_terms).map((o) => <option key={o} value={o}>{o}</option>)}
                  </CustomSelect>
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-0.5">Freight / Delivery</label>
                  <CustomSelect
                    value={bulkForm.freight_terms}
                    onChange={(e) => setBulkForm(prev => ({ ...prev, freight_terms: e.target.value }))}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm"
                  >
                    <option value="">—</option>
                    {withCurrent(FREIGHT_TERM_OPTIONS, bulkForm.freight_terms).map((o) => <option key={o} value={o}>{o}</option>)}
                  </CustomSelect>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b text-left text-xs text-slate-500">
                      <th className="px-2 py-1.5">Line</th>
                      <th className="px-2 py-1.5 text-right w-28">Qty</th>
                      <th className="px-2 py-1.5 text-right w-28">Unit price <span className="text-red-500">*</span></th>
                      <th className="px-2 py-1.5 text-right w-20">GST %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkForm.lines.map((l, idx) => (
                      <tr key={l.id} className="border-b align-top">
                        <td className="px-2 py-1.5">
                          <p className="text-slate-800 font-medium">#{l.line_no} · {l.label}</p>
                          <p className="text-[11px] text-slate-500">Open: {l.residual.toLocaleString()} {l.uom}</p>
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="number" step="any" min="0"
                            value={l.quantity}
                            onChange={(e) => setBulkLine(idx, 'quantity', e.target.value)}
                            className="w-24 px-2 py-1 border border-slate-300 rounded text-sm text-right ml-auto block"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="number" step="any" min="0"
                            value={l.unit_price}
                            onChange={(e) => setBulkLine(idx, 'unit_price', e.target.value)}
                            placeholder="0.00"
                            className="w-24 px-2 py-1 border border-slate-300 rounded text-sm text-right ml-auto block"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="number" step="0.01" min="0" max="100"
                            value={l.gst}
                            onChange={(e) => setBulkLine(idx, 'gst', e.target.value)}
                            className="w-16 px-2 py-1 border border-slate-300 rounded text-sm text-right ml-auto block"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-slate-500 italic">
                Enter less than the open qty on a line to leave a balance on the PR for another PO later.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 sm:px-6 py-4 border-t">
              <button type="button" onClick={() => setBulkOpen(false)} disabled={isBulkConverting} className="px-4 py-2 text-sm border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
              <button type="button" onClick={submitBulkConvert} disabled={isBulkConverting} className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {isBulkConverting ? 'Converting…' : 'Create one DRAFT PO'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Allow RFQ Skip — vendor selection wizard */}
      {skipWizardOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90dvh] flex flex-col" role="dialog" aria-modal="true" aria-label="Skip RFQ — Select Vendor">
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b">
              <div className="flex items-center gap-2">
                <SkipForward size={20} className="text-amber-600" />
                <h2 className="text-lg font-semibold text-slate-800">Skip RFQ — Select Vendor</h2>
              </div>
              <button
                onClick={() => setSkipWizardOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-600 rounded"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>

            <div className="px-4 sm:px-6 py-4 overflow-y-auto flex-1">
              <p className="text-sm text-slate-600 mb-4">
                Pick one of the preferred vendors for the products on this PR. The PO will be
                created in <span className="font-semibold">DRAFT</span> status with the selected vendor.
              </p>

              {skipWizardLoading && (
                <div className="text-center py-12 text-slate-500">Loading preferred vendors…</div>
              )}

              {!skipWizardLoading && preferredVendors.length === 0 && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                    <p className="font-semibold mb-0.5">No preferred vendors configured</p>
                    <p className="text-xs">
                      None of the products on this PR have a preferred vendor. Pick any vendor below
                      to create the PO in <span className="font-semibold">DRAFT</span> — you can set
                      preferred vendors on the products later (Master → Products).
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-0.5">
                      Select Vendor <span className="text-red-500">*</span>
                    </label>
                    <CustomSelect
                      value={selectedVendorId}
                      onChange={(e) => setSelectedVendorId(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                    >
                      <option value="">Select a vendor…</option>
                      {vendorOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </CustomSelect>
                  </div>
                </div>
              )}

              {!skipWizardLoading && preferredVendors.length > 0 && (
                <div className="space-y-2">
                  {preferredVendors.map(v => {
                    const checked = selectedVendorId === v.id;
                    const fmt = (val) => (val === null || val === undefined || val === '' ? '—' : val);
                    // Reflect what the user typed for the line(s) assigned to THIS vendor.
                    const assigned = (pr?.lines || []).filter((l) => (lineVendors[l.id] || selectedVendorId) === v.id);
                    const orderQty = assigned.reduce((sum, l) => sum + (Number(lineQtys[l.id] ?? l.quantity_requested) || 0), 0);
                    const typedPrices = assigned.map((l) => linePrices[l.id]).filter((p) => p !== undefined && p !== '');
                    const priceDisplay = typedPrices.length === 1 ? `₹${Number(typedPrices[0]).toLocaleString('en-IN')}` : (typedPrices.length > 1 ? 'varies' : null);
                    const qtyUom = assigned[0]?.uom || '';
                    return (
                      <label
                        key={v.id}
                        className={`block rounded-lg border p-3 cursor-pointer transition ${
                          checked ? 'border-amber-500 bg-amber-50' : 'border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="radio"
                            name="skip-rfq-vendor"
                            value={v.id}
                            checked={checked}
                            onChange={() => setSelectedVendorId(v.id)}
                            className="mt-1"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2 flex-wrap">
                              <div className="font-semibold text-slate-800">
                                {v.vendor_name}
                                <span className="ml-2 text-xs font-normal text-slate-500">{v.vendor_code}</span>
                              </div>
                              {v.gstin && (
                                <span className="text-[11px] font-mono text-slate-500">{v.gstin}</span>
                              )}
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-2 text-xs">
                              <div>
                                <div className="text-slate-400">Vendor SKU</div>
                                <div className="text-slate-700">{fmt(v.vendor_product_code)}</div>
                              </div>
                              <div>
                                <div className="text-slate-400">Unit Price</div>
                                <div className={priceDisplay ? 'text-slate-900 font-semibold' : 'text-slate-700'}>
                                  {priceDisplay ?? '—'}
                                </div>
                              </div>
                              <div>
                                <div className="text-slate-400">Order Qty</div>
                                <div className={assigned.length ? 'text-slate-900 font-semibold' : 'text-slate-700'}>
                                  {assigned.length ? `${orderQty} ${qtyUom}`.trim() : '—'}
                                </div>
                              </div>
                              <div>
                                <div className="text-slate-400">Lead Time</div>
                                <div className="text-slate-700">
                                  {v.lead_time_days != null ? `${v.lead_time_days} days` : '—'}
                                </div>
                              </div>
                              <div>
                                <div className="text-slate-400">Payment Terms</div>
                                <div className="text-slate-700">{fmt(v.payment_terms)}</div>
                              </div>
                            </div>
                            {v.supplied_products?.length > 0 && (
                              <div className="mt-2 text-[11px] text-slate-500">
                                Preferred for:{' '}
                                {v.supplied_products.map(p => p.name || p.sku_code).join(', ')}
                              </div>
                            )}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}

              {/* Per-line vendor override — one PO per vendor on Create */}
              {!skipWizardLoading && lineItems.length > 0 && (
                <div className="mt-5 border-t border-slate-200 pt-4">
                  <p className="text-sm font-semibold text-slate-700 mb-0.5">Assign a vendor &amp; unit price per line</p>
                  <p className="text-xs text-slate-500 mb-3">
                    Different vendors create separate POs (one per vendor). Leave the vendor blank to use the one selected above. Unit price is optional — you can also fill it on the DRAFT PO.
                  </p>
                  <div className="space-y-2">
                    {lineItems.map((l) => (
                      <div key={l.id} className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3">
                        <span className="sm:w-44 shrink-0 text-sm text-slate-700 truncate">
                          {l.product_name || l.machinery_name || l.service_catalogue_name || `Line ${l.line_no}`}
                        </span>
                        {(() => {
                          const preferred = lineVendorMap[l.id] || [];
                          const multi = preferred.length > 1;
                          const needsPick = multi && !lineVendors[l.id] && !selectedVendorId;
                          const opts = preferred.length
                            ? preferred.map((v) => ({ value: v.id, label: `${v.name}${v.code ? ` (${v.code})` : ''}` }))
                            : vendorOptions;
                          return (
                            <div className="flex-1 min-w-[150px]">
                              <CustomSelect
                                value={lineVendors[l.id] || ''}
                                onChange={(e) => setLineVendors((prev) => ({ ...prev, [l.id]: e.target.value }))}
                                className={`w-full border rounded-lg px-3 py-2 text-sm ${needsPick ? 'border-amber-400 bg-amber-50' : 'border-slate-300'}`}
                              >
                                <option value="">{multi && !selectedVendorId ? 'Choose a vendor…' : '— Use selected vendor —'}</option>
                                {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </CustomSelect>
                              {needsPick && (
                                <p className="text-[11px] text-amber-700 mt-0.5">Multiple preferred vendors — pick one, or select a vendor above.</p>
                              )}
                            </div>
                          );
                        })()}
                        <div className="flex items-center gap-1 sm:w-28 shrink-0">
                          <input
                            type="number" min="0" step="0.0001"
                            value={lineQtys[l.id] ?? (l.quantity_requested ?? '')}
                            onChange={(e) => setLineQtys((prev) => ({ ...prev, [l.id]: e.target.value }))}
                            title="Order quantity"
                            className="w-full border border-slate-300 rounded-lg px-2 py-2 text-sm text-right"
                          />
                          <span className="text-[11px] text-slate-400 shrink-0">{l.uom}</span>
                        </div>
                        <input
                          type="number" min="0" step="0.01"
                          value={linePrices[l.id] ?? ''}
                          onChange={(e) => setLinePrices((prev) => ({ ...prev, [l.id]: e.target.value }))}
                          placeholder="Unit price"
                          title="Unit price"
                          className="sm:w-28 shrink-0 border border-slate-300 rounded-lg px-3 py-2 text-sm text-right"
                        />
                        <div className="flex items-center gap-1 sm:w-24 shrink-0">
                          <input
                            type="number" min="0" max="100" step="0.01"
                            value={lineGsts[l.id] ?? ''}
                            onChange={(e) => setLineGsts((prev) => ({ ...prev, [l.id]: e.target.value }))}
                            placeholder="GST"
                            title="GST %"
                            className="w-full border border-slate-300 rounded-lg px-2 py-2 text-sm text-right"
                          />
                          <span className="text-[11px] text-slate-400 shrink-0">%</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  {Object.values(lineVendors).filter(Boolean).length > 0 && (
                    <p className="text-[11px] text-amber-700 mt-2">
                      Lines with different vendors will each get their own PO.
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 px-4 sm:px-6 py-4 border-t bg-slate-50">
              <button
                type="button"
                onClick={() => setSkipWizardOpen(false)}
                className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmSkipRfq}
                disabled={isSkippingRfq || (!selectedVendorId && !((pr?.lines || []).length > 0 && (pr.lines).every((l) => lineVendors[l.id])))}
                className="px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-semibold hover:bg-amber-600 transition disabled:opacity-50"
              >
                {isSkippingRfq ? 'Creating PO…' : 'Create PO'}
              </button>
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  );
}

/**
 * Build an audit trail array from PR data fields.
 * The backend records every action on the append-only `approval_trails`
 * change trail (actor, timestamp, remarks and field-level changes). Creation
 * isn't part of the trail, so a 'Created' step is always synthesized first.
 * Falls back to synthesizing Created/Approved from the flat timestamps for
 * older deploys that don't serve `approval_trails` yet.
 */
function buildAuditTrail(pr) {
  if (!pr) return [];

  const fmtDate = (d) =>
    d
      ? fmtSharedDateTime(d)
      : '-';

  // Created — always synthesized (not part of the append-only trail).
  const trail = [];
  const createdAt = pr.created_at || pr.createdDate || pr.created_date;
  if (createdAt) {
    trail.push({
      type: 'created',
      action: 'Created',
      user: pr.created_by_name || null,
      date: fmtDate(createdAt),
      remarks: null,
    });
  }

  // Real trail from the backend, oldest first.
  if (Array.isArray(pr.approval_trails) && pr.approval_trails.length > 0) {
    const ACTION_TITLES = {
      EDITED: 'Edited',
      SUBMITTED: 'Submitted',
      PROCEEDED: 'Proceeded to Approve',
      APPROVED: 'Approved',
      PARTIAL: 'Partially Approved',
      REJECTED: 'Rejected',
    };
    [...pr.approval_trails]
      .sort((a, b) => new Date(a.action_date) - new Date(b.action_date))
      .forEach((entry) => {
        const action = (entry.action || '').toUpperCase();
        trail.push({
          type: action.toLowerCase(),
          action: ACTION_TITLES[action] || entry.action || 'Activity',
          user: entry.actor_name || entry.actor_label || null,
          date: fmtDate(entry.action_date),
          remarks: entry.remarks || null,
          changes: entry.changes || [],
        });
      });
    return trail;
  }

  // Fallback (older deploys without approval_trails): synthesize Approved
  // from the flat timestamp so the timeline still renders something.
  const approvedAt = pr.approved_at || pr.approvedAt;
  if (approvedAt) {
    trail.push({
      type: 'approved',
      action: 'Approved',
      user: pr.approved_by_name || null,
      date: fmtDate(approvedAt),
      remarks: null,
    });
  }

  return trail;
}

/**
 * Godown select for the edit form. Wraps useLookup so the warehouse-scoped
 * godown list is fetched only while editing — the parent view-mode render
 * uses the flat `pr.godown_name` field instead. Extracted into a small
 * component so the parent doesn't need to call useLookup for the
 * /api/godowns/ endpoint on every render of a non-edit view.
 */
function GodownEditSelect({ warehouse, value, onChange }) {
  const { options } = useLookup(warehouse ? `/api/godowns/?warehouse=${warehouse}` : null);
  return (
    <CustomSelect
      name="godown"
      value={value || ''}
      onChange={onChange}
      disabled={!warehouse}
      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-slate-100 disabled:cursor-not-allowed"
    >
      <option value="">{warehouse ? 'Select Godown...' : 'Select warehouse first...'}</option>
      {options.map(opt => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </CustomSelect>
  );
}
