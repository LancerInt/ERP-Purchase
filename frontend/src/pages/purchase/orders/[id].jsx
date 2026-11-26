import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { promptText } from '@/components/common/prompt';
import POAmendment from '../components/POAmendment';
import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  ArrowLeft,
  CheckCircle,
  XCircle,
  Send,
  Mail,
  FileText,
  Edit3,
  Trash2,
  PackageCheck,
  FileDown,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import useLookup from '../../../hooks/useLookup.js';
import FileAttachments from '../components/FileAttachments';
import ActivityLog from '@/components/common/ActivityLog';
import { confirm } from '@/components/common/confirm';
import { formatDate as fmtDate } from '@/utils/formatters';
import { getApiErrorMessage } from '@/utils/formHelpers';
import { PAYMENT_TERM_OPTIONS, FREIGHT_TERM_OPTIONS, withCurrent, paymentTermMessage } from '@/constants/purchaseTerms';

// Base edit-mode input classes pulled from this page's inline styling so
// the field-permission lock state can reuse them.
const inputClass = "w-full mt-1 px-2 py-1 border border-slate-300 rounded text-sm";
const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;

export default function PurchaseOrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Back honours a `backTo` URL passed by the caller (dashboard drawers,
  // filtered lists) so Back restores the exact view they came from; otherwise
  // falls back to the existing history-aware default.
  const goBack = () => {
    const backTo = location.state?.backTo;
    if (backTo) navigate(backTo);
    else if (window.history.state?.idx > 0) navigate(-1);
    else navigate('/purchase/orders');
  };
  const { canCreate, canEdit, canDelete, canApprove, canSendEmail, canRequestAmendment, canApproveAmendment } = usePermissions();
  const { isHidden, isReadOnly } = useFieldPermissions('Purchase Order');
  const { isHidden: isLineHidden, isReadOnly: isLineRO } = useFieldPermissions('Purchase Order Line');

  const [po, setPO] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isApproving, setIsApproving] = useState(false);
  const [isIssuing, setIsIssuing] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  // Split-into-batches modal (DRAFT single-line POs only).
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitBatches, setSplitBatches] = useState([]); // [{quantity, delivery_date}]
  const [isSplitting, setIsSplitting] = useState(false);
  const [editData, setEditData] = useState({});

  // Broker master — drives the Broker Name dropdown so PO users can only
  // pick brokers that have been added to the master (no free-text typos).
  const { raw: brokerList } = useLookup('/api/brokers/');
  // Lookups for edit-mode parity with the Create page.
  const { options: vendorOptions } = useLookup('/api/vendors/');
  const { options: companyOptions } = useLookup('/api/companies/');
  const { options: rfqOptions } = useLookup('/api/purchase/rfq/');
  const { raw: prRaw } = useLookup('/api/purchase/requests/', { labelField: 'pr_no' });
  const prOptions = (prRaw || [])
    .filter(p => p.approval_status === 'APPROVED' || p.approval_status === 'PARTIALLY_APPROVED')
    .map(p => ({ value: p.id, label: p.pr_no }));

  const handleDelete = async () => {
    if (!(await confirm({ message: 'Are you sure you want to delete this purchase order? This action cannot be undone.', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/orders/${id}/`);
      toast.success('Purchase order deleted successfully');
      navigate('/purchase/orders');
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to delete');
    }
  };

  const [editLines, setEditLines] = useState([]);
  // Warehouse list narrows to the (editable) selected company in edit mode.
  const { options: warehouseOptions } = useLookup(
    editData.company ? `/api/warehouses/?company=${editData.company}&scope=true` : null
  );
  const handleEditToggle = () => {
    setIsEditing(true);
    setEditData({
      ...po,
      // Coerce linked_prs (array on detail) → single id for the dropdown,
      // mirroring the Create page (CustomSelect handles a single value).
      linked_prs: Array.isArray(po.linked_prs) && po.linked_prs.length > 0 ? po.linked_prs[0] : (po.linked_prs || ''),
    });
    setEditLines((po.po_lines || []).map(l => ({ ...l })));
  };
  const handleEditCancel = () => { setIsEditing(false); setEditData({}); setEditLines([]); };
  // Remove one line from a DRAFT PO (backend action). Frees the linked
  // PR line so the same item can be re-picked under a different vendor
  // on a new PO — the intended workflow when the wrong product was
  // grouped into this vendor's PO by mistake.
  const handleRemoveLine = async (line, idx) => {
    if (!line.id) {
      // Unsaved line — just drop from local state.
      setEditLines(prev => prev.filter((_, i) => i !== idx));
      return;
    }
    if (!(await confirm({
      message: `Remove '${line.item_name || line.product_name || 'this line'}' from the PO? The PR line becomes available for a new PO to a different vendor.`,
      isDangerous: true,
      confirmLabel: 'Remove line',
    }))) return;
    try {
      const res = await apiClient.delete(`/api/purchase/orders/${id}/lines/${line.id}/`);
      setPO(res.data);
      setEditLines((res.data.po_lines || []).map(l => ({ ...l })));
      toast.success('Line removed.');
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.detail || 'Failed to remove line.');
    }
  };
  const handleEditLineChange = (idx, field, value) => {
    setEditLines(prev => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));
  };
  const handleEditChange = (e) => {
    const { name, value } = e.target;
    // Changing company invalidates the previously-picked warehouse, same
    // behavior as the Create page.
    if (name === 'company') {
      setEditData(prev => ({ ...prev, company: value, warehouse: '' }));
      return;
    }
    setEditData(prev => ({ ...prev, [name]: value }));
  };
  const handleEditSave = async () => {
    setIsSaving(true);
    try {
      const res = await apiClient.patch(`/api/purchase/orders/${id}/`, {
        vendor: editData.vendor || null,
        company: editData.company || null,
        warehouse: editData.warehouse || null,
        linked_prs: editData.linked_prs ? [editData.linked_prs] : [],
        linked_rfq: editData.linked_rfq || null,
        payment_terms: editData.payment_terms || '',
        freight_terms: editData.freight_terms || '',
        currency: editData.currency || 'INR',
        broker_name: editData.broker_name || '',
        terms_and_conditions: editData.terms_and_conditions || '',
        expected_delivery_start: editData.expected_delivery_start || null,
        expected_delivery_end: editData.expected_delivery_end || null,
        po_lines: editLines.map(l => ({
          id: l.id,
          unit_price: l.unit_price || '0',
          gst: l.gst || '0',
          quantity_ordered: l.quantity_ordered,
          uom: l.uom || '',
          // pr_line_category is a read-only derived field on the
          // serializer — sending it back has no effect, but we keep
          // the value in editLines so the UI shows the operator's
          // override until refresh.
        })),
      });
      setPO(res.data);
      setIsEditing(false);
      setEditLines([]);
      toast.success('Purchase Order updated');
    } catch (err) { toast.error(getApiErrorMessage(err)); }
    finally { setIsSaving(false); }
  };

  // Fetch PO data
  useEffect(() => {
    fetchPO();
  }, [id]);

  const fetchPO = async () => {
    setIsLoading(true);
    try {
      const res = await apiClient.get(`/api/purchase/orders/${id}/`);
      setPO(res.data);
    } catch (err) {
      if (err.response?.status !== 404) toast.error(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  // Status checks
  const poStatus = po?.status || 'DRAFT';
  const isDraft = poStatus === 'DRAFT';
  const isApproved = poStatus === 'APPROVED';
  const isIssued = poStatus === 'ISSUED';
  const isClosed = poStatus === 'CLOSED';
  const isCancelled = poStatus === 'CANCELLED';

  // Permission checks
  const hasEditPerm = canEdit('Purchase Order');
  const hasDeletePerm = canDelete('Purchase Order');
  const canApprovePO = isDraft && canApprove('Purchase Order');
  // Split action is only visible on DRAFT + single-line POs. Multi-line
  // POs would need per-line batching (should be done at PR-approve time).
  const canSplitPO = isDraft
    && hasEditPerm
    && (po?.po_lines || []).length === 1
    && parseFloat((po?.po_lines || [])[0]?.quantity_ordered || 0) > 0;
  const canSendPOEmail = (isApproved || isIssued) && !isCancelled && !isClosed && canSendEmail('Purchase Order');
  const canCreateReceipt = canCreate('Receipt Advice');

  // Handle approve
  const handleApprove = async () => {
    if (!(await confirm({ message: 'Are you sure you want to approve this Purchase Order?' }))) return;
    setIsApproving(true);
    try {
      const res = await apiClient.post(`/api/purchase/orders/${id}/approve/`);
      toast.success(res.data?.message || 'PO approved successfully!');
      fetchPO();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to approve PO');
    } finally {
      setIsApproving(false);
    }
  };

  // Open the Split modal — DRAFT single-line POs only. Seeds with 2
  // equal-half batches, matching the Approve-modal split UX.
  const openSplitModal = () => {
    const line = (po?.po_lines || [])[0];
    if (!line) return;
    const orderedQty = parseFloat(line.quantity_ordered) || 0;
    const half = orderedQty / 2;
    setSplitBatches([
      { quantity: half ? String(half) : '', delivery_date: '' },
      { quantity: half ? String(half) : '', delivery_date: '' },
    ]);
    setSplitOpen(true);
  };

  const submitSplit = async () => {
    const line = (po?.po_lines || [])[0];
    const lineQty = parseFloat(line?.quantity_ordered) || 0;
    // Client-side sanity — backend re-validates.
    if (splitBatches.some(s => !(parseFloat(s.quantity) > 0))) {
      toast.error('Every batch quantity must be greater than 0.');
      return;
    }
    const sum = splitBatches.reduce((a, s) => a + (parseFloat(s.quantity) || 0), 0);
    if (Math.abs(sum - lineQty) > 0.0001) {
      toast.error(`Batch quantities (${sum}) must add up to the PO line quantity (${lineQty}).`);
      return;
    }
    if (!(await confirm({
      message: (
        `Split ${po.po_no} into ${splitBatches.length} DRAFT POs? `
        + `The original PO will be marked SPLIT (kept for audit trail, with a note pointing at the new PO numbers).`
      ),
      confirmLabel: 'Split PO',
    }))) return;
    setIsSplitting(true);
    try {
      const res = await apiClient.post(`/api/purchase/orders/${id}/split/`, {
        splits: splitBatches.map(s => ({
          quantity: s.quantity,
          delivery_date: s.delivery_date || '',
        })),
      });
      toast.success(res.data?.message || 'PO split successfully.');
      setSplitOpen(false);
      // Land on the Orders list — the current PO is now CANCELLED
      // and there's N new DRAFTs to look at.
      navigate('/purchase/orders');
    } catch (err) {
      toast.error(err.response?.data?.error || getApiErrorMessage(err, 'Failed to split PO.'));
    } finally {
      setIsSplitting(false);
    }
  };

  // Handle issue
  const handleIssue = async () => {
    if (!(await confirm({ message: 'Are you sure you want to issue this Purchase Order?' }))) return;
    setIsIssuing(true);
    try {
      const res = await apiClient.post(`/api/purchase/orders/${id}/issue/`);
      toast.success('PO issued successfully!');
      fetchPO();
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.detail || 'Failed to issue PO');
    } finally {
      setIsIssuing(false);
    }
  };

  // Handle reject
  const handleReject = async () => {
    const reason = await promptText({ title: 'Reject Purchase Order', label: 'Rejection reason', placeholder: 'Why is this PO being rejected?', multiline: true, required: true, confirmLabel: 'Reject', isDangerous: true });
    if (reason === null) return;
    setIsRejecting(true);
    try {
      await apiClient.post(`/api/purchase/orders/${id}/reject/`, { reason });
      toast.success('PO rejected/cancelled');
      fetchPO();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to reject PO');
    } finally {
      setIsRejecting(false);
    }
  };

  // Short-close a partially-received PO whose balance will never arrive.
  const [isClosing, setIsClosing] = useState(false);
  const handleClosePO = async () => {
    const reason = await promptText({
      title: 'Close PO (short of full receipt)',
      label: 'The remaining quantity will never arrive — why are you closing this PO?',
      placeholder: 'e.g. Vendor cancelled the balance / goods damaged, won\'t resend',
      multiline: true, required: true, confirmLabel: 'Close PO', isDangerous: true,
    });
    if (reason === null) return;
    setIsClosing(true);
    try {
      await apiClient.post(`/api/purchase/orders/${id}/close/`, { reason });
      toast.success('PO closed. Admins have been notified.');
      fetchPO();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to close PO');
    } finally {
      setIsClosing(false);
    }
  };

  // Format helpers
  const formatDate = (dateStr) => {
    if (!dateStr) return '-';
    return fmtDate(dateStr);
  };

  const formatCurrency = (value) => {
    const num = Number(value);
    if (isNaN(num)) return '-';
    return `\u20B9${num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

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
  if (!po) {
    return (
      <MainLayout>
        <div className="text-center py-12">
          <FileText className="mx-auto text-slate-300 mb-4" size={48} />
          <p className="text-slate-600 text-lg">Purchase Order not found</p>
          <button
            onClick={goBack}
            className="mt-4 px-4 py-2 text-blue-600 hover:text-blue-800 transition"
          >
            Back to Purchase Orders
          </button>
        </div>
      </MainLayout>
    );
  }

  const poNumber = po.po_no || `PO-${id}`;
  const lineItems = po.po_lines || [];

  // A PO can only be approved once every line carries a real unit price.
  // Approving at 0 would lock in a zero-value order (and post a zero-cost
  // receipt later), so the Approve button stays disabled until each line
  // has unit_price > 0.
  const allLinesPriced = lineItems.length > 0 &&
    lineItems.every(l => Number(l.unit_price) > 0);

  // Compute financial summary (use editLines when editing, lineItems otherwise)
  const summaryLines = isEditing ? editLines : lineItems;
  const subtotal = summaryLines.reduce((sum, line) => {
    const qty = Number(line.quantity_ordered) || 0;
    const price = Number(line.unit_price) || 0;
    return sum + (qty * price);
  }, 0);

  const totalTax = summaryLines.reduce((sum, line) => {
    const qty = Number(line.quantity_ordered) || 0;
    const price = Number(line.unit_price) || 0;
    const gst = Number(line.gst) || 0;
    return sum + ((qty * price) * gst / 100);
  }, 0);

  const grandTotal = subtotal + totalTax;

  const breadcrumbs = [
    { label: 'Purchase', href: '/purchase/orders' },
    { label: 'Orders', href: '/purchase/orders' },
    { label: poNumber },
  ];

  return (
    <MainLayout breadcrumbs={breadcrumbs}>
      <div className="max-w-6xl space-y-2">

        {/* ── Header row: Back + PO# + badge + chips + actions ── */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 flex-wrap mb-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button onClick={goBack} className="p-1 text-slate-400 hover:text-slate-700 transition shrink-0" title="Back to list">
              <ArrowLeft size={18} />
            </button>
            <h1 className="text-lg sm:text-xl font-bold text-slate-900 truncate">{poNumber}</h1>
            <StatusBadge status={po?.fulfillment_status || poStatus} />
            <div className="hidden sm:flex items-center gap-1.5 ml-1">
              {po.company_name && <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{po.company_name}</span>}
              {po.warehouse_name && <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{po.warehouse_name}</span>}
              {po?.email_sent && <span className="px-2 py-0.5 rounded bg-emerald-100 text-[10px] font-semibold text-emerald-700">Mail Sent</span>}
              <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{formatCurrency(grandTotal || po.total_order_value || 0)}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap ml-6 sm:ml-0">
            {!isEditing && (
              <button onClick={() => navigate(`/purchase/orders/${id}/document`)} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 rounded-md text-slate-700 hover:bg-slate-50 transition text-xs font-medium">
                <FileDown size={13} /> PO Document
              </button>
            )}
            {!isEditing && isDraft && hasEditPerm && (
              <button onClick={handleEditToggle} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 rounded-md text-slate-700 hover:bg-slate-50 transition text-xs font-medium">
                <Edit3 size={13} /> Edit
              </button>
            )}
            {!isEditing && isDraft && hasDeletePerm && (
              <button onClick={handleDelete} className="flex items-center gap-1.5 px-3 py-1.5 border border-red-200 rounded-md text-red-600 hover:bg-red-50 transition text-xs font-medium">
                <Trash2 size={13} /> Delete
              </button>
            )}
            {isEditing && (
              <>
                <button onClick={handleEditSave} disabled={isSaving} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-md text-xs font-semibold hover:bg-blue-700 transition disabled:opacity-50">
                  <CheckCircle size={13} /> {isSaving ? 'Saving...' : 'Save'}
                </button>
                <button onClick={handleEditCancel} disabled={isSaving} className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 rounded-md text-slate-700 hover:bg-slate-50 transition text-xs font-medium">
                  <XCircle size={13} /> Cancel
                </button>
              </>
            )}
            {canApprovePO && !isEditing && (
              <button onClick={handleApprove} disabled={isApproving || !allLinesPriced} title={!allLinesPriced ? 'Enter a unit price on every line item before approving' : undefined} className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded-md text-xs font-semibold hover:bg-green-700 transition disabled:opacity-50 disabled:cursor-not-allowed">
                <CheckCircle size={13} /> {isApproving ? 'Approving...' : 'Approve'}
              </button>
            )}
            {canSplitPO && !isEditing && (
              <button onClick={openSplitModal} className="flex items-center gap-1.5 px-3 py-1.5 border border-amber-400 text-amber-800 bg-amber-50 rounded-md hover:bg-amber-100 transition text-xs font-medium" title="Split this DRAFT PO into multiple DRAFT POs by batch quantity">
                Split
              </button>
            )}
            {canSendPOEmail && !isEditing && (
              <button onClick={() => navigate(`/purchase/orders/${id}/send-email`)} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition text-xs font-medium ${po?.email_sent ? 'border border-primary-300 text-primary-700 hover:bg-primary-50' : 'bg-primary-600 text-white hover:bg-primary-700'}`}>
                <Mail size={13} /> {po?.email_sent ? 'Resend' : 'Send Email'}
              </button>
            )}
            {canCreateReceipt && (isApproved || isIssued) && !po?.is_fully_received && (po?.email_sent || po?.fulfillment_status === 'PARTIALLY_RECEIVED') && !isEditing && (
              <button onClick={() => navigate(`/purchase/receipts/new?po_id=${id}`)} className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 transition text-xs font-medium">
                <PackageCheck size={13} /> Receipt
              </button>
            )}
            {canCreateReceipt && (isApproved || isIssued) && !po?.is_fully_received && !isClosed && !isCancelled && Number(po?.total_received) > 0 && !isEditing && (
              <button onClick={handleClosePO} disabled={isClosing} className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 text-white rounded-md hover:bg-rose-700 transition text-xs font-medium disabled:opacity-50">
                <XCircle size={13} /> {isClosing ? 'Closing…' : 'Close PO'}
              </button>
            )}
          </div>
        </div>

        {/* Mobile chips row */}
        <div className="flex sm:hidden items-center gap-1.5 flex-wrap ml-7">
          {po.company_name && <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{po.company_name}</span>}
          {po.warehouse_name && <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{po.warehouse_name}</span>}
          {po?.email_sent && <span className="px-2 py-0.5 rounded bg-emerald-100 text-[10px] font-semibold text-emerald-700">Mail Sent</span>}
          <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{formatCurrency(grandTotal || po.total_order_value || 0)}</span>
        </div>

        {/* Payment terms note */}
        {(() => {
          const message = paymentTermMessage(po?.payment_terms);
          if (!message) return null;
          return (
            <div className="bg-amber-50 border border-amber-200 rounded-md px-3 py-1.5">
              <p className="text-[11px] font-semibold text-amber-800">{message}</p>
            </div>
          );
        })()}

        {/* SPLIT banner */}
        {po?.status === 'SPLIT' && (() => {
          const m = (po?.terms_and_conditions || '').match(/\[Split into \d+ POs?:\s*([^\]]+)\]/i);
          const children = m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
          return (
            <div className="rounded-md border border-purple-300 bg-purple-50 px-3 py-2">
              <p className="text-[11px] font-semibold text-purple-900">This PO was split</p>
              <p className="text-[10px] text-purple-800 mt-0.5">
                Obligation moved to {children.length || 'the'} child DRAFT PO{children.length === 1 ? '' : 's'}.
              </p>
              {children.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {children.map((poNo) => (
                    <button key={poNo} onClick={async () => {
                      try {
                        const res = await apiClient.get(`/api/purchase/orders/?search=${encodeURIComponent(poNo)}`);
                        const rows = res.data?.results || res.data || [];
                        const hit = Array.isArray(rows) ? rows.find(r => r.po_no === poNo) : null;
                        if (hit?.id) { navigate(`/purchase/orders/${hit.id}`); return; }
                      } catch { /* ignore */ }
                      navigate('/purchase/orders');
                    }} className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-white border border-purple-300 text-purple-800 rounded hover:bg-purple-100" title={`Open ${poNo}`}>
                      → {poNo}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* PO amendment */}
        <POAmendment po={po} canRequest={canRequestAmendment('Purchase Order')} canApprove={canApproveAmendment('Purchase Order')} onApplied={fetchPO} />

        {/* ── Single-row field strip (view mode) / Grid (edit mode) ── */}
        <div className="bg-white rounded-lg border border-slate-200 px-3 py-2">
          {!isEditing ? (
            <div className="flex items-start gap-4 overflow-x-auto" style={{ fontSize: 0 }}>
              {!isHidden('vendor') && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Vendor</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{po.vendor_name || '-'}</p></div>
              )}
              {!isHidden('company') && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Company</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{po.company_name || '-'}</p></div>
              )}
              {!isHidden('warehouse') && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Warehouse</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{po.warehouse_name || '-'}</p></div>
              )}
              {!isHidden('payment_terms') && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Payment</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{po.payment_terms || '-'}</p></div>
              )}
              {!isHidden('freight_terms') && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Freight</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{po.freight_terms || '-'}</p></div>
              )}
              {!(isHidden('expected_delivery_start') && isHidden('expected_delivery_end')) && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Delivery</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{po.expected_delivery_start || po.expected_delivery_end ? `${formatDate(po.expected_delivery_start)} – ${formatDate(po.expected_delivery_end)}` : '-'}</p></div>
              )}
              {!isHidden('linked_prs') && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Linked PRs</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{po.linked_pr_numbers?.length > 0 ? po.linked_pr_numbers.join(', ') : '-'}</p></div>
              )}
              {!isHidden('linked_rfq') && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">RFQ</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{(() => { const rfq = (rfqOptions || []).find(o => String(o.value) === String(po.linked_rfq)); return rfq?.label || po.linked_rfq || '-'; })()}</p></div>
              )}
              {!isHidden('currency') && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Currency</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{po.currency || '-'}</p></div>
              )}
              {!isHidden('broker_name') && po.broker_name && (
                <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Broker</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{po.broker_name}</p></div>
              )}
              {!isHidden('terms_and_conditions') && po.terms_and_conditions && (
                <div className="min-w-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">T&C</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-700 truncate max-w-[260px]" title={po.terms_and_conditions}>{po.terms_and_conditions}</p></div>
              )}
              <div className="shrink-0"><p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Created</p><p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{formatDate(po.po_date || po.created_at)}</p></div>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1.5">
              {!isHidden('vendor') && (
                <div>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Vendor</p>
                  {!isReadOnly('vendor') ? (
                    <CustomSelect name="vendor" value={editData.vendor || ''} onChange={handleEditChange} className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500">
                      <option value="">Select Vendor</option>
                      {vendorOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </CustomSelect>
                  ) : (<p className="text-[12px] font-medium text-slate-800">{po.vendor_name || '-'}</p>)}
                </div>
              )}
              {!isHidden('company') && (
                <div>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Company</p>
                  {!isReadOnly('company') ? (
                    <CustomSelect name="company" value={editData.company || ''} onChange={handleEditChange} className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500">
                      <option value="">Select Company</option>
                      {companyOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </CustomSelect>
                  ) : (<p className="text-[12px] font-medium text-slate-800">{po.company_name || '-'}</p>)}
                </div>
              )}
              {!isHidden('warehouse') && (
                <div>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Warehouse</p>
                  {!isReadOnly('warehouse') ? (
                    <CustomSelect name="warehouse" value={editData.warehouse || ''} onChange={handleEditChange} disabled={!editData.company} className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100">
                      <option value="">{editData.company ? 'Select Warehouse' : 'Select company first...'}</option>
                      {warehouseOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </CustomSelect>
                  ) : (<p className="text-[12px] font-medium text-slate-800">{po.warehouse_name || '-'}</p>)}
                </div>
              )}
              {!isHidden('payment_terms') && (
                <div>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Payment Terms</p>
                  {!isReadOnly('payment_terms') ? (
                    <CustomSelect name="payment_terms" value={editData.payment_terms || ''} onChange={handleEditChange} className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500">
                      <option value="">Select...</option>
                      {withCurrent(PAYMENT_TERM_OPTIONS, editData.payment_terms).map(o => <option key={o} value={o}>{o}</option>)}
                    </CustomSelect>
                  ) : (<p className="text-[12px] font-medium text-slate-800">{po.payment_terms || '-'}</p>)}
                </div>
              )}
              {!isHidden('freight_terms') && (
                <div>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Freight Terms</p>
                  {!isReadOnly('freight_terms') ? (
                    <CustomSelect name="freight_terms" value={editData.freight_terms || ''} onChange={handleEditChange} className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500">
                      <option value="">Select...</option>
                      {withCurrent(FREIGHT_TERM_OPTIONS, editData.freight_terms).map(o => <option key={o} value={o}>{o}</option>)}
                    </CustomSelect>
                  ) : (<p className="text-[12px] font-medium text-slate-800">{po.freight_terms || '-'}</p>)}
                </div>
              )}
              {!(isHidden('expected_delivery_start') && isHidden('expected_delivery_end')) && (
                <div>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Delivery</p>
                  <div className="flex gap-2">
                    {!isHidden('expected_delivery_start') && <CustomDatePicker name="expected_delivery_start" value={editData.expected_delivery_start || ''} onChange={handleEditChange} disabled={isReadOnly('expected_delivery_start')} className="flex-1 px-2 py-1.5 border border-slate-300 rounded text-[12px]" />}
                    {!isHidden('expected_delivery_end') && <CustomDatePicker name="expected_delivery_end" value={editData.expected_delivery_end || ''} onChange={handleEditChange} disabled={isReadOnly('expected_delivery_end')} className="flex-1 px-2 py-1.5 border border-slate-300 rounded text-[12px]" />}
                  </div>
                </div>
              )}
              {!isHidden('linked_prs') && (
                <div>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Linked PR</p>
                  {!isReadOnly('linked_prs') ? (
                    <CustomSelect name="linked_prs" value={editData.linked_prs || ''} onChange={handleEditChange} className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500">
                      <option value="">Select PR</option>
                      {prOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </CustomSelect>
                  ) : (<p className="text-[12px] font-medium text-slate-800">{po.linked_pr_numbers?.join(', ') || '-'}</p>)}
                </div>
              )}
              {!isHidden('linked_rfq') && (
                <div>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Linked RFQ</p>
                  {!isReadOnly('linked_rfq') ? (
                    <CustomSelect name="linked_rfq" value={editData.linked_rfq || ''} onChange={handleEditChange} className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500">
                      <option value="">Select RFQ</option>
                      {rfqOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </CustomSelect>
                  ) : (<p className="text-[12px] font-medium text-slate-800">{(() => { const rfq = (rfqOptions || []).find(o => String(o.value) === String(po.linked_rfq)); return rfq?.label || po.linked_rfq || '-'; })()}</p>)}
                </div>
              )}
              {!isHidden('currency') && (
                <div>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Currency</p>
                  {!isReadOnly('currency') ? (
                    <CustomSelect name="currency" value={editData.currency || 'INR'} onChange={handleEditChange} className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500">
                      <option value="INR">INR</option>
                      <option value="USD">USD</option>
                    </CustomSelect>
                  ) : (<p className="text-[12px] font-medium text-slate-800">{po.currency || '-'}</p>)}
                </div>
              )}
              {!isHidden('broker_name') && (
                <div>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Broker</p>
                  {!isReadOnly('broker_name') ? (
                    <CustomSelect name="broker_name" value={editData.broker_name || ''} onChange={handleEditChange} className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500">
                      <option value="">Select broker (optional)</option>
                      {(brokerList || []).map((b) => <option key={b.id} value={b.broker_name}>{b.broker_name}{b.broker_code ? ` (${b.broker_code})` : ''}</option>)}
                    </CustomSelect>
                  ) : (<p className="text-[12px] font-medium text-slate-800">{po.broker_name || '-'}</p>)}
                </div>
              )}
              {!isHidden('terms_and_conditions') && (
                <div className="col-span-2 sm:col-span-4">
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Terms & Conditions</p>
                  {!isReadOnly('terms_and_conditions') ? (
                    <textarea name="terms_and_conditions" value={editData.terms_and_conditions || ''} onChange={handleEditChange} rows={1} className="w-full px-2 py-1.5 border border-slate-300 rounded text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  ) : (<p className="text-[12px] text-slate-700">{po.terms_and_conditions || '-'}</p>)}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Fulfilment stat row ── */}
        {(() => {
          const totalOrdered = lineItems.reduce((sum, l) => sum + (Number(l.quantity_ordered) || 0), 0);
          const totalReceived = lineItems.reduce((sum, l) => sum + (Number(l.received_quantity) || 0), 0);
          const approvalText = isDraft ? 'Pending' : isCancelled ? 'Cancelled'
            : isApproved ? 'Approved' : isIssued ? 'Issued' : isClosed ? 'Closed' : poStatus;
          const approvalCls = isDraft ? 'text-amber-600' : isCancelled ? 'text-red-600' : 'text-green-700';
          const balance = Math.max(0, Math.round((totalOrdered - totalReceived) * 10000) / 10000);
          const cells = [
            { label: 'Ordered', value: totalOrdered.toLocaleString('en-IN'), cls: 'text-slate-800' },
            { label: 'Received', value: totalReceived.toLocaleString('en-IN'), cls: 'text-green-700' },
            { label: 'Balance', value: balance.toLocaleString('en-IN'), cls: balance > 0 ? 'text-amber-600' : 'text-green-700' },
            { label: 'Receipt', value: po.is_fully_received ? 'Full' : (totalReceived > 0 ? 'Partial' : 'Pending'), cls: po.is_fully_received ? 'text-green-700' : totalReceived > 0 ? 'text-amber-600' : 'text-slate-500' },
            { label: 'Approval', value: approvalText, cls: approvalCls },
          ];
          return (
            <div className="grid grid-cols-5 divide-x divide-slate-200 border border-slate-200 rounded-md overflow-hidden text-center bg-white">
              {cells.map((c, i) => (
                <div key={i} className="px-1 py-1.5 min-w-0">
                  <p className="text-[9px] uppercase tracking-tight text-slate-500 leading-tight truncate">{c.label}</p>
                  <p className={`text-xs font-semibold mt-0.5 truncate ${c.cls}`}>{c.value}</p>
                </div>
              ))}
            </div>
          );
        })()}

        {/* ── Line Items ── */}
        <div className="bg-white rounded-lg border border-slate-200">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100">
            <h2 style={{ fontSize: 11 }} className="font-semibold text-slate-500 uppercase tracking-wider">Line Items ({lineItems.length})</h2>
          </div>
          {lineItems.length === 0 ? (
            <p className="text-slate-400 text-center py-4 text-[12px]">No line items</p>
          ) : (
            <>
            {/* Mobile cards */}
            <div className="sm:hidden space-y-2 p-2">
              {(isEditing ? editLines : lineItems).map((line, idx) => {
                const qty = Number(line.quantity_ordered) || 0;
                const price = Number(line.unit_price) || 0;
                const gst = Number(line.gst) || 0;
                const lineSubtotal = qty * price;
                const lineTax = lineSubtotal * gst / 100;
                const lineTotal = lineSubtotal + lineTax;
                return (
                  <div key={`m-${line.id || idx}`} className="border border-slate-200 rounded-lg bg-white overflow-hidden">
                    <div className="flex items-start justify-between px-3 py-2 bg-slate-50 border-b border-slate-100 gap-2">
                      <div className="min-w-0">
                        <p className="text-[11px] uppercase tracking-wide text-slate-500">Line #{line.line_no || idx + 1}</p>
                        <p className="text-sm font-semibold text-slate-800 break-words">{line.item_name || line.product_name || '-'}</p>
                        {(line.item_code || line.product_code) && <p className="text-[11px] text-slate-500 mt-0.5">{line.item_code || line.product_code}</p>}
                      </div>
                      <p className="shrink-0 text-sm font-bold text-slate-900 whitespace-nowrap">{formatCurrency(lineTotal)}</p>
                    </div>
                    <div className="px-3 py-2 grid grid-cols-3 gap-x-3 gap-y-2 text-xs">
                      {!isLineHidden('quantity_ordered') && (
                      <div>
                        <p className="text-[10px] uppercase text-slate-500">Qty</p>
                        <p className="text-slate-800 font-medium">{qty.toLocaleString()} {!isLineHidden('uom') && <span className="text-slate-400">{line.uom || ''}</span>}</p>
                      </div>
                      )}
                      {!isLineHidden('unit_price') && (
                      <div>
                        <p className="text-[10px] uppercase text-slate-500">Price</p>
                        {isEditing ? (
                          <input type="number" step="0.01" min="0" value={line.unit_price} onChange={e => handleEditLineChange(idx, 'unit_price', e.target.value)} disabled={isLineRO('unit_price')} className={`w-full px-2 py-1 border border-slate-300 rounded text-xs text-right${isLineRO('unit_price') ? ' bg-slate-100 cursor-not-allowed' : ''}`} />
                        ) : <p className="text-slate-700">{formatCurrency(price)}</p>}
                      </div>
                      )}
                      {!isLineHidden('gst') && (
                      <div>
                        <p className="text-[10px] uppercase text-slate-500">GST</p>
                        {isEditing ? (
                          <input type="number" step="0.01" min="0" max="100" value={line.gst} onChange={e => handleEditLineChange(idx, 'gst', e.target.value)} disabled={isLineRO('gst')} className={`w-full px-2 py-1 border border-slate-300 rounded text-xs text-right${isLineRO('gst') ? ' bg-slate-100 cursor-not-allowed' : ''}`} />
                        ) : <p className="text-slate-700">{gst}%</p>}
                      </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Desktop table */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-slate-200">
                    {!isLineHidden('line_no') && <th className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase text-[9px] tracking-wide whitespace-nowrap">#</th>}
                    {!isLineHidden('product_service') && <th className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase text-[9px] tracking-wide whitespace-nowrap">Product</th>}
                    <th className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase text-[9px] tracking-wide whitespace-nowrap">Category</th>
                    {!isLineHidden('quantity_ordered') && <th className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase text-[9px] tracking-wide whitespace-nowrap">Qty</th>}
                    {!isEditing && !isLineHidden('quantity_ordered') && <th className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase text-[9px] tracking-wide whitespace-nowrap">Received</th>}
                    {!isEditing && !isLineHidden('quantity_ordered') && <th className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase text-[9px] tracking-wide whitespace-nowrap">Balance</th>}
                    {!isLineHidden('uom') && <th className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase text-[9px] tracking-wide whitespace-nowrap">UOM</th>}
                    {!isLineHidden('unit_price') && <th className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase text-[9px] tracking-wide whitespace-nowrap">Unit Price</th>}
                    {!isLineHidden('gst') && <th className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase text-[9px] tracking-wide whitespace-nowrap">GST %</th>}
                    <th className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase text-[9px] tracking-wide whitespace-nowrap">Total</th>
                    {isEditing && isDraft && <th className="px-2 py-1.5" style={{ width: 32 }}></th>}
                  </tr>
                </thead>
                <tbody>
                  {(isEditing ? editLines : lineItems).map((line, idx) => {
                    const qty = Number(line.quantity_ordered) || 0;
                    const price = Number(line.unit_price) || 0;
                    const gst = Number(line.gst) || 0;
                    const lineSubtotal = qty * price;
                    const lineTax = lineSubtotal * gst / 100;
                    const lineTotal = lineSubtotal + lineTax;
                    return (
                      <tr key={line.id || idx} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                        {!isLineHidden('line_no') && <td className="px-2 py-1.5 text-slate-400">{line.line_no || idx + 1}</td>}
                        {!isLineHidden('product_service') && (
                        <td className="px-2 py-1.5">
                          <p className="font-semibold text-slate-800">{line.item_name || line.product_name || '-'}</p>
                          {(line.item_code || line.product_code) && <p className="text-[10px] text-slate-500">{line.item_code || line.product_code}</p>}
                          {line.item_type && line.item_type !== 'PRODUCT' && (
                            <span className={`inline-block mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${line.item_type === 'MACHINERY' ? 'bg-indigo-50 text-indigo-700' : 'bg-emerald-50 text-emerald-700'}`}>
                              {line.item_type === 'MACHINERY' ? 'Machinery' : 'Service'}
                            </span>
                          )}
                          {line.description && <p className="text-[10px] text-slate-500 mt-0.5">{line.description}</p>}
                        </td>
                        )}
                        <td className="px-2 py-1.5">
                          {isEditing ? (
                            <CustomSelect value={line.pr_line_category || ''} onChange={e => handleEditLineChange(idx, 'pr_line_category', e.target.value)} className="w-full px-1.5 py-1 border border-slate-300 rounded text-[11px]">
                              <option value="">-</option>
                              <option value="RAW_MATERIAL">Raw Material</option>
                              <option value="PACKING_MATERIAL">Packing Material</option>
                              <option value="FINISHED_GOODS">Finished Goods</option>
                              {line.pr_line_category && !['RAW_MATERIAL', 'PACKING_MATERIAL', 'FINISHED_GOODS'].includes(String(line.pr_line_category).toUpperCase()) && <option value={line.pr_line_category}>{line.pr_line_category}</option>}
                            </CustomSelect>
                          ) : (
                            (() => {
                              const raw = (line.pr_line_category || '').toString().trim().toUpperCase();
                              if (!raw) return <span className="text-slate-400">-</span>;
                              const map = {
                                PACKING_MATERIAL: { label: 'Packing Material', cls: 'bg-amber-50 text-amber-700 border border-amber-200' },
                                RAW_MATERIAL:     { label: 'Raw Material',     cls: 'bg-blue-50 text-blue-700 border border-blue-200' },
                                FINISHED_GOODS:   { label: 'Finished Goods',   cls: 'bg-emerald-50 text-emerald-700 border border-emerald-200' },
                              };
                              const meta = map[raw];
                              if (meta) return <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium ${meta.cls}`}>{meta.label}</span>;
                              return <span className="text-[11px] text-slate-600">{line.pr_line_category}</span>;
                            })()
                          )}
                        </td>
                        {!isLineHidden('quantity_ordered') && (
                        <td className="px-2 py-1.5 text-right font-medium whitespace-nowrap">
                          {isEditing ? (
                            <input type="number" step="0.01" min="0.01" value={line.quantity_ordered || ''} onChange={e => handleEditLineChange(idx, 'quantity_ordered', e.target.value)} disabled={isLineRO('quantity_ordered')} className={`w-20 px-1.5 py-1 border border-slate-300 rounded text-[11px] text-right${isLineRO('quantity_ordered') ? ' bg-slate-100 cursor-not-allowed' : ''}`} />
                          ) : qty.toLocaleString()}
                        </td>
                        )}
                        {!isEditing && !isLineHidden('quantity_ordered') && (
                        <td className="px-2 py-1.5 text-right whitespace-nowrap">
                          {(() => {
                            const rcvd = Number(line.received_quantity) || 0;
                            const full = qty > 0 && rcvd >= qty;
                            const pill = full
                              ? { label: 'Full', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
                              : rcvd > 0
                                ? { label: 'Partial', cls: 'bg-amber-50 text-amber-700 border-amber-200' }
                                : { label: 'Pending', cls: 'bg-slate-50 text-slate-500 border-slate-200' };
                            return (
                              <span className="inline-flex items-center gap-1">
                                <span className="font-medium text-slate-700">{rcvd.toLocaleString('en-IN')}</span>
                                <span className={`px-1 py-0.5 rounded border text-[9px] font-medium ${pill.cls}`}>{pill.label}</span>
                              </span>
                            );
                          })()}
                        </td>
                        )}
                        {!isEditing && !isLineHidden('quantity_ordered') && (
                        <td className="px-2 py-1.5 text-right whitespace-nowrap">
                          {(() => {
                            const rcvd = Number(line.received_quantity) || 0;
                            const bal = qty - rcvd;
                            if (bal > 0) return <span className="font-medium text-slate-700">{bal.toLocaleString('en-IN')}</span>;
                            if (bal < 0) return <span className="font-medium text-rose-600" title="Over-delivered">+{Math.abs(bal).toLocaleString('en-IN')} over</span>;
                            return <span className="text-slate-400">0</span>;
                          })()}
                        </td>
                        )}
                        {!isLineHidden('uom') && (
                        <td className="px-2 py-1.5 text-slate-600">
                          {isEditing ? (
                            <input type="text" value={line.uom || ''} onChange={e => handleEditLineChange(idx, 'uom', e.target.value)} disabled={isLineRO('uom')} className={`w-14 px-1.5 py-1 border border-slate-300 rounded text-[11px]${isLineRO('uom') ? ' bg-slate-100 cursor-not-allowed' : ''}`} />
                          ) : (line.uom || '-')}
                        </td>
                        )}
                        {!isLineHidden('unit_price') && (
                        <td className="px-2 py-1.5 text-right">
                          {isEditing ? (
                            <input type="number" step="0.01" min="0" value={line.unit_price} onChange={e => handleEditLineChange(idx, 'unit_price', e.target.value)} disabled={isLineRO('unit_price')} className={`w-24 px-1.5 py-1 border border-slate-300 rounded text-[11px] text-right${isLineRO('unit_price') ? ' bg-slate-100 cursor-not-allowed' : ''}`} />
                          ) : formatCurrency(price)}
                        </td>
                        )}
                        {!isLineHidden('gst') && (
                        <td className="px-2 py-1.5 text-right">
                          {isEditing ? (
                            <input type="number" step="0.01" min="0" max="100" value={line.gst} onChange={e => handleEditLineChange(idx, 'gst', e.target.value)} disabled={isLineRO('gst')} className={`w-14 px-1.5 py-1 border border-slate-300 rounded text-[11px] text-right${isLineRO('gst') ? ' bg-slate-100 cursor-not-allowed' : ''}`} />
                          ) : <span className="text-slate-600">{gst}%</span>}
                        </td>
                        )}
                        <td className="px-2 py-1.5 text-right font-medium whitespace-nowrap">{formatCurrency(lineTotal)}</td>
                        {isEditing && isDraft && (
                          <td className="px-2 py-1.5 text-center">
                            <button type="button" onClick={() => handleRemoveLine(line, idx)} className="p-0.5 text-red-500 hover:bg-red-50 rounded" title="Remove"><Trash2 size={12} /></button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Financial Summary */}
              <div className="border-t border-slate-200 px-3 py-2 flex justify-end">
                <div className="w-56 space-y-1 text-[12px]">
                  <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span className="font-medium">{formatCurrency(subtotal)}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Tax</span><span className="font-medium">{formatCurrency(totalTax)}</span></div>
                  <div className="flex justify-between border-t border-slate-200 pt-1 text-[13px]"><span className="font-semibold text-slate-800">Grand Total</span><span className="font-bold text-slate-900">{formatCurrency(grandTotal)}</span></div>
                </div>
              </div>
            </div>

            {/* Mobile totals */}
            <div className="sm:hidden bg-slate-50 border-t border-slate-200 p-2.5 space-y-1 text-[12px]">
              <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span className="font-medium text-slate-800">{formatCurrency(subtotal)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Tax</span><span className="font-medium text-slate-700">{formatCurrency(totalTax)}</span></div>
              <div className="flex justify-between pt-1.5 mt-1 border-t border-slate-300"><span className="text-slate-700 font-semibold">Grand Total</span><span className="text-[13px] font-bold text-slate-900">{formatCurrency(grandTotal)}</span></div>
            </div>
            </>
          )}
        </div>

        {/* Attachments + Activity */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="bg-white rounded-lg border border-slate-200">
            <FileAttachments module="PO" recordId={id} readOnly={!isEditing} />
          </div>
          <div className="bg-white rounded-lg border border-slate-200">
            <ActivityLog module="Purchase Order" recordId={id} />
          </div>
        </div>
      </div>

      {/* Split-into-batches modal — CANCELS the current DRAFT PO and
          creates N new DRAFT POs, each with a slice of the qty and
          its own delivery date. Same vendor / warehouse / terms
          copied through. */}
      {splitOpen && (() => {
        const line = (po?.po_lines || [])[0];
        const lineQty = parseFloat(line?.quantity_ordered) || 0;
        const uom = line?.uom || '';
        const sum = splitBatches.reduce((a, s) => a + (parseFloat(s.quantity) || 0), 0);
        const balance = Math.round((lineQty - sum) * 100) / 100;
        const updateBatch = (i, key, value) => {
          setSplitBatches(prev => prev.map((s, idx) => idx === i ? { ...s, [key]: value } : s));
        };
        const addBatch = () => {
          if (splitBatches.length >= 10) return;
          setSplitBatches(prev => [...prev, { quantity: '', delivery_date: '' }]);
        };
        const removeBatch = (i) => {
          if (splitBatches.length <= 2) return;
          setSplitBatches(prev => prev.filter((_, idx) => idx !== i));
        };
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => !isSplitting && setSplitOpen(false)}>
            <div className="bg-white rounded-xl shadow-xl w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b">
                <div>
                  <h2 className="text-lg font-semibold text-slate-800">Split {po?.po_no} into batches</h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Original PO is kept for audit trail (status: SPLIT). Each batch lands as its own DRAFT PO.
                  </p>
                </div>
                <button type="button" className="text-slate-500 hover:text-slate-800" disabled={isSplitting} onClick={() => setSplitOpen(false)}>×</button>
              </div>
              <div className="px-4 sm:px-6 py-4 space-y-2">
                <p className="text-xs text-slate-600 mb-1">
                  Line qty: <span className="font-medium">{lineQty} {uom}</span> · Vendor: {po?.vendor_name || '-'}
                </p>
                {splitBatches.map((s, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-[11px] text-slate-500 w-14 shrink-0">Batch {i + 1}</span>
                    <input
                      type="number" step="any" min="0"
                      value={s.quantity ?? ''}
                      onChange={(e) => updateBatch(i, 'quantity', e.target.value)}
                      placeholder="Qty"
                      className="w-28 border border-slate-300 rounded-lg px-2 py-1.5 text-sm text-right"
                    />
                    <CustomDatePicker
                      value={s.delivery_date || ''}
                      onChange={(e) => updateBatch(i, 'delivery_date', e.target.value)}
                      className="flex-1 border border-slate-300 rounded-lg px-2 py-1.5 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => removeBatch(i)}
                      disabled={splitBatches.length <= 2}
                      className="text-slate-400 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed text-lg leading-none px-1"
                      title={splitBatches.length <= 2 ? 'At least 2 batches required' : 'Remove batch'}
                    >×</button>
                  </div>
                ))}
                <p className="text-[11px] text-slate-500 italic pl-14">
                  Delivery date is optional — leave blank if it's not decided yet. You can set it later on the batch's PO.
                </p>
                <div className="flex items-center justify-between pt-1">
                  <button
                    type="button"
                    onClick={addBatch}
                    disabled={splitBatches.length >= 10}
                    className="text-xs text-primary-600 hover:text-primary-800 hover:underline disabled:opacity-50"
                  >
                    + Add another batch
                  </button>
                  <span className={`text-xs font-medium ${balance === 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                    Sum: {sum} / {lineQty} {uom}
                    {balance !== 0 && ` · Off by ${balance > 0 ? '−' : '+'}${Math.abs(balance)}`}
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 px-4 sm:px-6 py-4 border-t">
                <button type="button" onClick={() => setSplitOpen(false)} disabled={isSplitting} className="px-4 py-2 text-sm border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
                <button type="button" onClick={submitSplit} disabled={isSplitting || balance !== 0} className="px-4 py-2 text-sm font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50">
                  {isSplitting ? 'Splitting…' : `Split into ${splitBatches.length} DRAFT POs`}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </MainLayout>
  );
}
