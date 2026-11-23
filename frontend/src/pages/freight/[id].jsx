import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Trash2, ArrowLeft, Edit3, Plus, XCircle, ArrowDownLeft, ArrowUpRight, Paperclip, GitBranch } from 'lucide-react';
import MainLayout from '../../components/layout/MainLayout';
import PageHeader from '../../components/common/PageHeader';
import StatusBadge from '../../components/common/StatusBadge';
import apiClient from '../../utils/api.js';
import usePermissions from '../../hooks/usePermissions.js';
import useFieldPermissions from '../../hooks/useFieldPermissions.js';
import { useFlowDashboard } from '../../components/common/FlowDashboardPopup';
import FileAttachments from '../purchase/components/FileAttachments';
import { confirm } from '@/components/common/confirm';
import { formatDate, formatCurrency } from '@/utils/formatters';
import { getApiErrorMessage } from '@/utils/formHelpers';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

// Roles allowed to approve a Freight Advice (Inbound).
const FREIGHT_APPROVE_ROLES = new Set(['admin', 'administrator', 'purchase manager']);

export default function UnifiedFreightDetail() {
  const { type: routeType, id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { canApprove, canCancel, canEdit, canDelete, isAdmin, isSuperuser, role } = usePermissions();
  const _roleName = (role?.role_name || role?.name || '').trim().toLowerCase();
  const canApproveFreight = isAdmin || isSuperuser || FREIGHT_APPROVE_ROLES.has(_roleName);
  const [freight, setFreight] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [freightAttachments, setFreightAttachments] = useState([]);
  const [receiptAttachments, setReceiptAttachments] = useState([]);
  const { openFlow, FlowPopup } = useFlowDashboard();

  // The routes `/freight/purchase/:id` and `/freight/sales/:id` only capture
  // `:id`, so useParams().type is undefined for those (and only works for the
  // catch-all `/freight/:type/:id`). Infer from the URL path as a fallback so
  // inward freight detail correctly hits /api/purchase/freight and not the
  // sales endpoint.
  const type = routeType || (location.pathname.split('/')[2] || 'purchase');
  const isPurchase = type === 'purchase';
  const apiBase = isPurchase ? '/api/purchase/freight' : '/api/sales/freight';
  // Inward (purchase) freight lives under the 'Freight Advice' module;
  // outward (sales) freight permission is owned by the 'Sales Freight'
  // module (sales team-managed). Detail-page actions are gated on
  // whichever module owns the current record.
  const freightModule = isPurchase ? 'Freight Advice' : 'Sales Freight';
  // Field-level visibility for the Inward (Freight Advice) detail view.
  // Only the purchase side has a catalog module here; sales fields are
  // owned by the Sales Freight module and left untouched.
  const { isHidden } = useFieldPermissions('Freight Advice');

  const fmt = (v) => { const n = Number(v || 0); return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: n % 1 === 0 ? 0 : 2 })}`; };
  const fmtDate = (d) => d ? formatDate(d) : '-';

  const fetchFreight = async () => {
    setIsLoading(true);
    try {
      const res = await apiClient.get(`${apiBase}/${id}/`);
      setFreight(res.data);

      // Fetch freight attachments (receipt attachments are now copied permanently to freight)
      apiClient.get(`/api/purchase/attachments/?module=FREIGHT&record_id=${id}`)
        .then(r => setFreightAttachments(r.data?.results || r.data || []))
        .catch(() => setFreightAttachments([]));
    } catch (err) {
      // Surface the real HTTP status — generic "Failed to load freight"
      // hid whether this was a 403 (permission), 404 (no such record
      // / soft-deleted), or 5xx (server error). The 404-after-create
      // pattern usually means the create endpoint returned an id but
      // the row was either soft-deleted or filtered out by the
      // viewset queryset's is_active=True clause.
      const status = err?.response?.status;
      const data = err?.response?.data;
      let msg = 'Failed to load freight';
      if (status === 404) {
        msg = `Freight not found (id: ${id?.slice(0, 8)}…). The record may have been deleted.`;
      } else if (status === 403) {
        msg = 'You do not have permission to view this freight advice.';
      } else if (status === 401) {
        msg = 'Session expired — please log in again.';
      } else if (data?.error) {
        msg = data.error;
      } else if (data?.detail) {
        msg = data.detail;
      } else if (status) {
        msg = `Failed to load freight (HTTP ${status})`;
      }
      // The `!freight` render path already shows a "Freight not found"
      // page for a 404, so toasting here too would double-signal the
      // same 404. Only toast for non-404 failures (403 / 5xx / etc.).
      if (status !== 404) toast.error(msg);
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.error('[fetchFreight]', { id, status, data });
      }
    }
    finally { setIsLoading(false); }
  };

  useEffect(() => { fetchFreight(); }, [id, type]);

  // Unlink one of the EXTRA bills a shared slip covers (not the primary bill).
  const unlinkCoveredBill = async (billId) => {
    const remaining = (freight.covered_bills || []).filter((x) => String(x) !== String(billId));
    try {
      await apiClient.patch(`${apiBase}/${id}/`, { covered_bills: remaining });
      toast.success('Bill unlinked from this freight.');
      fetchFreight();
    } catch { toast.error('Could not unlink the bill.'); }
  };

  // ── Link a goods bill to this slip (clears it from the "Unmatched" list) ──
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkQ, setLinkQ] = useState('');
  const [linkResults, setLinkResults] = useState([]);
  const [linkBusy, setLinkBusy] = useState(false);

  const searchLinkable = async (q) => {
    setLinkQ(q);
    if (!q || q.trim().length < 2) { setLinkResults([]); return; }
    try {
      const r = await apiClient.get(`${apiBase}/${id}/linkable-bills/?q=${encodeURIComponent(q.trim())}`);
      setLinkResults(r.data?.results || []);
    } catch { setLinkResults([]); }
  };

  const linkBill = async (billId) => {
    setLinkBusy(true);
    try {
      await apiClient.post(`${apiBase}/${id}/link-bill/`, { bill_id: billId });
      toast.success('Bill linked to this freight.');
      setLinkOpen(false); setLinkQ(''); setLinkResults([]);
      fetchFreight();
    } catch (e) {
      toast.error(e?.response?.data?.detail || getApiErrorMessage(e) || 'Could not link the bill.');
    } finally { setLinkBusy(false); }
  };

  // ============ PURCHASE-SPECIFIC STATES ============
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editData, setEditData] = useState({});
  const [isApproving, setIsApproving] = useState(false);

  const handleEditToggle = () => { setIsEditing(true); setEditData({ ...freight }); };
  const handleEditCancel = () => setIsEditing(false);
  const handleEditChange = (e) => setEditData(prev => ({ ...prev, [e.target.name]: e.target.value }));

  const handleEditSave = async () => {
    setIsSaving(true);
    try {
      const res = await apiClient.patch(`${apiBase}/${id}/`, {
        driver_name: editData.driver_name || '', driver_contact: editData.driver_contact || '',
        destination_state: editData.destination_state || '', freight_terms: editData.freight_terms || '',
        remarks: editData.remarks || '', delivery_remarks: editData.delivery_remarks || '',
        dispatch_date: editData.dispatch_date || null, expected_arrival_date: editData.expected_arrival_date || null,
        transport_document_no: editData.transport_document_no || '', lorry_no: editData.lorry_no || '',
      });
      setFreight(res.data); setIsEditing(false);
      toast.success('Freight updated');
    } catch (err) { toast.error(getApiErrorMessage(err)); }
    finally { setIsSaving(false); }
  };

  const handleApprove = async () => {
    setIsApproving(true);
    try {
      const res = await apiClient.post(`${apiBase}/${id}/approve/`);
      setFreight(res.data);
      toast.success('Freight approved!');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to approve');
      fetchFreight();
    } finally { setIsApproving(false); }
  };

  const handleStatusChange = async (newStatus) => {
    try {
      const res = await apiClient.post(`${apiBase}/${id}/update-status/`, { status: newStatus });
      setFreight(res.data);
      toast.success(`Status updated to ${res.data.status_display || newStatus}`);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to update status');
      fetchFreight();
    }
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: `Delete freight ${freight?.advice_no}? This cannot be undone.`, isDangerous: true }))) return;
    try {
      await apiClient.delete(`${apiBase}/${id}/`);
      toast.success('Freight deleted');
      navigate(isPurchase ? '/freight/inward' : '/freight/outward');
    } catch (err) { toast.error(err.response?.data?.detail || 'Failed to delete'); }
  };

  // ============ PAYMENTS (both purchase & sales) ============
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentData, setPaymentData] = useState({
    payment_date: new Date().toISOString().split('T')[0],
    amount_paid: '', payment_mode: 'BANK', reference_no: '',
    paid_to: '', notes: '', remarks: '',
  });
  const [isSavingPayment, setIsSavingPayment] = useState(false);

  const getBalance = () => {
    if (!freight) return 0;
    if (isPurchase) {
      const payable = Number(freight.total_freight_cost) || Number(freight.payable_amount) || 0;
      return payable - (Number(freight.total_paid) || 0);
    }
    return Number(freight.balance) || 0;
  };

  const handleAddPayment = async (e) => {
    e.preventDefault();
    if (!paymentData.amount_paid || parseFloat(paymentData.amount_paid) <= 0) { toast.error('Amount must be > 0'); return; }
    const bal = getBalance();
    if (parseFloat(paymentData.amount_paid) > bal) { toast.error(`Amount exceeds balance (${fmt(bal)})`); return; }
    setIsSavingPayment(true);
    try {
      await apiClient.post(`${apiBase}/${id}/add-payment/`, paymentData);
      toast.success('Payment added!');
      setShowPaymentForm(false);
      setPaymentData({ payment_date: new Date().toISOString().split('T')[0], amount_paid: '', payment_mode: 'BANK', reference_no: '', paid_to: '', notes: '', remarks: '' });
      fetchFreight();
    } catch (err) { toast.error(getApiErrorMessage(err)); }
    finally { setIsSavingPayment(false); }
  };

  const handleDeletePayment = async (paymentId) => {
    if (!(await confirm({ message: 'Delete this payment?', isDangerous: true }))) return;
    try {
      await apiClient.delete(`${apiBase}/${id}/delete-payment/${paymentId}/`);
      toast.success('Payment deleted');
      fetchFreight();
    } catch { toast.error('Failed to delete payment'); }
  };

  const handleCancel = async () => {
    if (!(await confirm({ message: 'Cancel this freight?', isDangerous: true }))) return;
    try {
      await apiClient.post(`${apiBase}/${id}/cancel/`);
      toast.success('Freight cancelled');
      fetchFreight();
    } catch (err) { toast.error(err.response?.data?.detail || 'Failed to cancel'); }
  };

  // ============ RENDER ============
  if (isLoading) return <MainLayout><div className="flex justify-center py-20"><div className="animate-spin h-8 w-8 border-4 border-primary-500 border-t-transparent rounded-full" /></div></MainLayout>;
  if (!freight) return <MainLayout><div className="text-center py-20 text-red-500">Freight not found<br/><button onClick={() => navigate(isPurchase ? '/freight/inward' : '/freight/outward')} className="mt-4 text-blue-600 underline">Back to list</button></div></MainLayout>;

  const isCancelled = freight.status === 'CANCELLED';
  const isPaid = freight.status === 'PAID';
  const payments = freight.payments || [];
  const dcLinks = freight.dc_links || [];

  const InfoField = ({ label, children }) => (
    <div>
      <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">{label}</p>
      <p className="text-slate-900 font-semibold mt-1">{children || '-'}</p>
    </div>
  );

  return (
    <MainLayout>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <button onClick={() => { if (window.history.length > 1) navigate(-1); else navigate(isPurchase ? '/freight/inward' : '/freight/outward'); }} aria-label="Back" title="Back" className="p-1 text-slate-500 hover:text-slate-700"><ArrowLeft size={20} /></button>
            <h1 className="text-2xl font-bold text-slate-900">{freight.advice_no || 'Freight'}</h1>
            <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${isPurchase ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'}`}>
              {isPurchase ? <><ArrowDownLeft size={12} /> Inward Freight</> : <><ArrowUpRight size={12} /> Outward Freight</>}
            </span>
          </div>
          <div className="flex items-center gap-4 ml-8">
            <StatusBadge status={freight.status_display || freight.status} />
            <p className="text-slate-500 text-sm">{fmtDate(isPurchase ? (freight.created_date || freight.created_at) : freight.freight_date)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap ml-8 sm:ml-0">
          {isPurchase && !isEditing && canEdit(freightModule) && (
            <button onClick={handleEditToggle} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-primary-700 bg-primary-50 rounded-lg hover:bg-primary-100">Edit</button>
          )}
          {isPurchase && isEditing && (
            <>
              <button onClick={handleEditCancel} className="px-3 py-1.5 text-sm text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200">Cancel</button>
              <button onClick={handleEditSave} disabled={isSaving} className="px-3 py-1.5 text-sm text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50">{isSaving ? 'Saving...' : 'Save'}</button>
            </>
          )}
          {!isPurchase && freight.linked_so_id && (
            <button onClick={() => openFlow(freight.linked_so_id)} className="flex items-center gap-2 px-3 py-1.5 border border-purple-300 text-purple-700 bg-purple-50 hover:bg-purple-100 rounded-lg text-sm font-medium" title="View Sales Flow">
              <GitBranch size={14} /> Flow
            </button>
          )}
          {!isPurchase && canEdit(freightModule) && !isCancelled && (
            <button onClick={() => navigate(`/sales/freight/${id}/edit`)} className="flex items-center gap-2 px-3 py-1.5 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 text-sm font-medium"><Edit3 size={14} /> Edit</button>
          )}
          {canDelete(freightModule) && !isCancelled && (
            <button onClick={handleDelete} className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-600 bg-red-50 rounded-lg hover:bg-red-100"><Trash2 size={14} /> Delete</button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5 items-start">
        <div className="lg:col-span-2 space-y-4 sm:space-y-5">

          {/* ============ PURCHASE DETAIL ============ */}
          {isPurchase && (
            <>
              {/* Freight Details */}
              <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-4 pb-2 border-b">Freight Details</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  <InfoField label="Freight No">{freight.advice_no}</InfoField>
                  {!isHidden('receipt_advice') && (
                    <InfoField label="Receipt Advice">
                      <span className="text-primary-600 cursor-pointer" onClick={() => navigate(`/purchase/receipts/${freight.receipt_advice}`)}>{freight.receipt_advice_no || '-'}</span>
                    </InfoField>
                  )}
                  <InfoField label="Vendor">{freight.vendor_name}</InfoField>
                  <InfoField label="Warehouse">{freight.warehouse_name}</InfoField>
                  {!isHidden('transporter') && <InfoField label="Transporter">{freight.transporter_name}</InfoField>}
                  {!isHidden('freight_type') && <InfoField label="Freight Type">{freight.freight_type_display || freight.freight_type}</InfoField>}
                  {/* Freight Source — whether the freight was inside the goods bill
                      (In invoice) or came as its own slip (Separate slip). */}
                  <InfoField label="Freight Source">
                    <span className={`inline-block text-xs font-semibold rounded px-2 py-0.5 ${freight.freight_source === 'INVOICE_INCLUDED' ? 'bg-indigo-50 text-indigo-700' : 'bg-teal-50 text-teal-700'}`}>
                      {freight.freight_source === 'INVOICE_INCLUDED' ? 'In invoice' : 'Separate slip'}
                    </span>
                  </InfoField>
                  {!isHidden('freight_terms') && (
                    <InfoField label="Freight Terms">
                      {isEditing ? (
                        <CustomSelect name="freight_terms" value={editData.freight_terms || ''} onChange={handleEditChange} className="w-full mt-1 px-2 py-1 border border-slate-300 rounded text-sm">
                          <option value="">Select</option><option value="PAID">Paid</option><option value="TO_PAY">To Pay</option>
                        </CustomSelect>
                      ) : freight.freight_terms_display}
                    </InfoField>
                  )}
                  {!isHidden('destination_state') && <InfoField label="Destination State">{freight.destination_state}</InfoField>}
                  {/* Goods quantity + freight rate per unit (from Zoho). */}
                  {Number(freight.quantity_basis) > 0 && (
                    <InfoField label="Quantity">
                      {Number(freight.quantity_basis).toLocaleString('en-IN')}{freight.quantity_uom ? ` ${freight.quantity_uom}` : ''}
                    </InfoField>
                  )}
                  {Number(freight.cost_per_unit_calc) > 0 && (
                    <InfoField label={freight.quantity_uom === 'MTS' ? 'Rate / Ton' : 'Rate / Unit'}>
                      {formatCurrency(freight.cost_per_unit_calc)}
                    </InfoField>
                  )}
                  {!isHidden('status') && <InfoField label="Status"><StatusBadge status={freight.status_display || freight.status} /></InfoField>}
                </div>
                {freight.po_numbers?.length > 0 && (
                  <div className="mt-4 pt-4 border-t">
                    <p className="text-xs text-slate-500 uppercase">Linked PO Numbers</p>
                    <p className="font-medium text-primary-600 mt-1">{freight.po_numbers.join(', ')}</p>
                  </div>
                )}
              </div>

              {/* Transport Details */}
              <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-4 pb-2 border-b">Transport Details</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {/* Show the vehicle no ONLY when this freight is linked to a real
                      bill in the ERP (a clickable link). A not-imported reference or no
                      bill at all hides it, so a lone vehicle number never stands alone.
                      Sales freight and edit mode always show the field. */}
                  {!isHidden('lorry_no') && (isEditing || !isPurchase || freight.linked_bill?.id) && (
                    <InfoField label="Lorry / Vehicle No">
                      {isEditing ? <input name="lorry_no" value={editData.lorry_no || ''} onChange={handleEditChange} className="w-full mt-1 px-2 py-1 border border-slate-300 rounded text-sm" /> : freight.lorry_no}
                    </InfoField>
                  )}
                  {!isHidden('driver_name') && (
                    <InfoField label="Driver Name">
                      {isEditing ? <input name="driver_name" value={editData.driver_name || ''} onChange={handleEditChange} className="w-full mt-1 px-2 py-1 border border-slate-300 rounded text-sm" /> : freight.driver_name}
                    </InfoField>
                  )}
                  {!isHidden('driver_contact') && (
                    <InfoField label="Driver Contact">
                      {isEditing ? <input name="driver_contact" value={editData.driver_contact || ''} onChange={handleEditChange} className="w-full mt-1 px-2 py-1 border border-slate-300 rounded text-sm" /> : freight.driver_contact}
                    </InfoField>
                  )}
                  {!isHidden('transport_document_no') && (
                    <InfoField label="Transport Document No">
                      {isEditing ? <input name="transport_document_no" value={editData.transport_document_no || ''} onChange={handleEditChange} className="w-full mt-1 px-2 py-1 border border-slate-300 rounded text-sm" /> : freight.transport_document_no}
                    </InfoField>
                  )}
                  {/* Hide "Linked Bill" when the Bills Covered card already lists it
                      (the primary covered bill IS the linked bill) — else the same
                      bill shows twice. Show it only when there's no covered-bills card. */}
                  {isPurchase && freight.linked_bill && !(freight.covered_bills_detail || []).length && (
                    <InfoField label="Linked Bill">
                      {freight.linked_bill.id ? (
                        <button type="button" onClick={() => navigate(`/purchase/bills/${freight.linked_bill.id}`)}
                          className="text-primary-600 hover:text-primary-800 hover:underline font-medium text-left">
                          {freight.linked_bill.bill_no || freight.linked_bill.vendor_invoice_no || 'View bill'}
                        </button>
                      ) : (
                        // Bill reference known, but that bill isn't imported into the ERP yet.
                        <span className="font-medium text-slate-700">
                          {freight.linked_bill.bill_no}
                          <span className="block text-xs text-amber-600 mt-0.5">Bill not imported yet</span>
                        </span>
                      )}
                      {freight.linked_bill.vendor_invoice_no && freight.linked_bill.vendor_invoice_no !== freight.linked_bill.bill_no && (
                        <span className="block text-xs text-slate-400 mt-0.5">Invoice: {freight.linked_bill.vendor_invoice_no}</span>
                      )}
                      {freight.linked_bill.vendor_name && (
                        <span className="block text-xs text-slate-400">{freight.linked_bill.vendor_name}</span>
                      )}
                    </InfoField>
                  )}
                  {!isHidden('dispatch_date') && <InfoField label="Dispatch Date">{fmtDate(freight.dispatch_date)}</InfoField>}
                  {isPurchase && !isHidden('expected_arrival_date') && <InfoField label="Expected Arrival">{fmtDate(freight.expected_arrival_date)}</InfoField>}
                  {freight.actual_arrival_date && !isHidden('actual_arrival_date') && <InfoField label="Actual Arrival">{fmtDate(freight.actual_arrival_date)}</InfoField>}
                </div>
              </div>

              {/* Bills covered by this ONE slip (one trip, several goods invoices —
                  all the same vendor). Shows each bill's no, vendor and amount so a
                  shared freight from the Email Inbox lists what it's paid against. */}
              {(freight.covered_bills_detail || []).length > 0 && (
                <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
                  <div className="flex items-center justify-between mb-3 pb-2 border-b">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Bills covered ({freight.covered_bills_detail.length})</h3>
                    <span className="text-xs text-slate-500">one slip · paid once for all</span>
                  </div>
                  <div className="space-y-2">
                    {freight.covered_bills_detail.map((b) => (
                      <div key={b.id} className="flex items-center justify-between gap-2 text-sm border border-slate-100 rounded-lg px-3 py-2">
                        <div className="min-w-0">
                          <button type="button" onClick={() => navigate(`/purchase/bills/${b.id}`)}
                            className="font-medium text-primary-600 hover:text-primary-800 hover:underline text-left">{b.bill_no || b.invoice_no || 'View bill'}</button>
                          {b.is_primary && <span className="ml-2 text-[10px] uppercase tracking-wide bg-slate-100 text-slate-500 rounded px-1.5 py-0.5">primary</span>}
                          <span className="block text-xs text-slate-500 truncate">{b.vendor_name || '—'}{b.invoice_no ? ` · inv ${b.invoice_no}` : ''}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="font-semibold text-slate-800 tabular-nums">{formatCurrency(b.total)}</span>
                          {!b.is_primary && (
                            <button onClick={() => unlinkCoveredBill(b.id)} title="Unlink this bill from the freight"
                              className="text-slate-300 hover:text-rose-600 text-lg leading-none">&times;</button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Link a goods bill to this slip. The FIRST bill becomes the primary
                  (clears it from "Unmatched"); further bills are added as also-covered. */}
              {!isEditing && canEdit(freightModule) && (
                <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
                  <div className="flex items-center justify-between mb-3 pb-2 border-b">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      {(freight.covered_bills_detail || []).length > 0 ? 'Link another bill' : 'Link a bill'}
                    </h3>
                    {!(freight.covered_bills_detail || []).length && (
                      <span className="text-[11px] text-amber-600 font-medium">not linked to a bill yet</span>
                    )}
                  </div>
                  {!linkOpen ? (
                    <button type="button" onClick={() => setLinkOpen(true)}
                      className="inline-flex items-center gap-1.5 text-sm text-primary-600 hover:text-primary-800 font-medium">
                      <Plus size={15} /> Link a bill
                    </button>
                  ) : (
                    <div>
                      <input autoFocus value={linkQ} onChange={(e) => searchLinkable(e.target.value)}
                        placeholder="Search bill no / invoice / vendor…" className={inputClass} />
                      <div className="mt-2 divide-y divide-slate-100 max-h-64 overflow-auto">
                        {linkResults.map((b) => (
                          <button key={b.id} type="button" disabled={linkBusy} onClick={() => linkBill(b.id)}
                            className="w-full flex items-center justify-between gap-2 text-left px-2 py-2 hover:bg-slate-50 rounded disabled:opacity-50">
                            <span className="min-w-0">
                              <span className="block text-sm font-medium text-slate-800 truncate">{b.bill_no || b.vendor_invoice_no || '—'}</span>
                              <span className="block text-xs text-slate-500 truncate">{b.vendor_name}{b.vendor_invoice_no ? ` · inv ${b.vendor_invoice_no}` : ''}{b.bill_date ? ` · ${fmtDate(b.bill_date)}` : ''}</span>
                            </span>
                            <span className="text-sm font-semibold text-slate-700 tabular-nums shrink-0">{formatCurrency(b.total_amount)}</span>
                          </button>
                        ))}
                        {linkQ.trim().length >= 2 && linkResults.length === 0 && (
                          <p className="text-xs text-slate-400 py-3 text-center">No matching bill (or all are already linked to a freight).</p>
                        )}
                      </div>
                      <button type="button" onClick={() => { setLinkOpen(false); setLinkQ(''); setLinkResults([]); }}
                        className="mt-2 text-xs text-slate-400 hover:text-slate-600">Cancel</button>
                    </div>
                  )}
                </div>
              )}

              {/* Remarks */}
              {((freight.delivery_remarks && !isHidden('delivery_remarks')) || (freight.remarks && !isHidden('remarks'))) && (
                <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-4 pb-2 border-b">Remarks</h3>
                  {freight.delivery_remarks && !isHidden('delivery_remarks') && <div className="mb-3"><p className="text-xs text-slate-500 uppercase">Delivery Remarks</p><p className="text-sm text-slate-700 mt-1">{freight.delivery_remarks}</p></div>}
                  {freight.remarks && !isHidden('remarks') && <div><p className="text-xs text-slate-500 uppercase">General Remarks</p><p className="text-sm text-slate-700 mt-1">{freight.remarks}</p></div>}
                </div>
              )}

              {/* Freight Attachments — the scanned/emailed freight copy is
                  auto-attached; the operator can also add files by hand here. */}
              <FileAttachments module="FREIGHT" recordId={id} />
            </>
          )}

          {/* ============ SALES DETAIL ============ */}
          {!isPurchase && (
            <>
              {/* Basic Details */}
              <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-4 pb-2 border-b">Basic Details</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-5">
                  <InfoField label="Freight No">{freight.advice_no}</InfoField>
                  <InfoField label="Date">{fmtDate(freight.freight_date)}</InfoField>
                  <InfoField label="Company">{freight.company_name || '-'}</InfoField>
                  <InfoField label="Warehouse">{freight.factory_name || '-'}</InfoField>
                  <InfoField label="Customer">{freight.customer_name || '-'}</InfoField>
                  <InfoField label="Transporter">{freight.transporter_name || '-'}</InfoField>
                  <InfoField label="Freight Type">{freight.freight_type === 'LOCAL' ? 'Local' : freight.freight_type === 'LINEHAUL' ? 'Linehaul' : '-'}</InfoField>
                  <InfoField label="Lorry No">{freight.lorry_no || '-'}</InfoField>
                  <InfoField label="Destination">{freight.destination || '-'}</InfoField>
                </div>
              </div>

              {/* DC Links */}
              {dcLinks.length > 0 && (
                <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-4 pb-2 border-b">DC Mapping ({dcLinks.length})</h3>
                  {/* Mobile-stacked DC links — one card per row so the
                      eight-column table doesn't force horizontal scroll
                      on a phone. DC No is still clickable in both
                      layouts. */}
                  <div className="sm:hidden space-y-2 mb-3">
                    {dcLinks.map((l, i) => (
                      <div key={`m-${i}`} className="border border-slate-200 rounded bg-white p-2 text-xs">
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <button onClick={() => navigate(`/sales/dc/${l.dc}`)} className="text-blue-700 font-semibold text-sm">{l.dc_no}</button>
                          <p className="shrink-0 font-bold text-slate-900 whitespace-nowrap">{fmt(l.freight_amount)}</p>
                        </div>
                        <div className="grid grid-cols-3 gap-1 text-[10px]">
                          <div><span className="text-slate-500">Qty:</span> <span className="text-slate-700">{Number(l.quantity || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} {l.uom || ''}</span></div>
                          <div><span className="text-slate-500">Rate:</span> <span className="text-slate-700">{fmt(l.freight_rate)}</span></div>
                          <div><span className="text-slate-500">Inv:</span> <span className="text-slate-700">{l.invoice_no || '-'}</span></div>
                          {l.invoice_date && <div className="col-span-2"><span className="text-slate-500">Inv Date:</span> <span className="text-slate-700">{fmtDate(l.invoice_date)}</span></div>}
                          {l.destination && <div className="col-span-3"><span className="text-slate-500">Dest:</span> <span className="text-slate-700">{l.destination}</span></div>}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="hidden sm:block overflow-x-auto">
                    <table className="w-full text-sm" style={{ minWidth: '900px' }}>
                      <thead>
                        <tr className="border-b bg-slate-50">
                          <th className="text-left py-2 px-3 text-xs text-slate-500 uppercase whitespace-nowrap">DC No</th>
                          <th className="text-right py-2 px-3 text-xs text-slate-500 uppercase whitespace-nowrap">Qty</th>
                          <th className="text-left py-2 px-3 text-xs text-slate-500 uppercase whitespace-nowrap">UOM</th>
                          <th className="text-right py-2 px-3 text-xs text-slate-500 uppercase whitespace-nowrap">Rate (₹/unit)</th>
                          <th className="text-right py-2 px-3 text-xs text-slate-500 uppercase whitespace-nowrap">Amount</th>
                          <th className="text-left py-2 px-3 text-xs text-slate-500 uppercase whitespace-nowrap">Invoice No</th>
                          <th className="text-left py-2 px-3 text-xs text-slate-500 uppercase whitespace-nowrap">Invoice Date</th>
                          <th className="text-left py-2 px-3 text-xs text-slate-500 uppercase whitespace-nowrap">Destination</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dcLinks.map((l, i) => (
                          <tr key={i} className="border-b hover:bg-slate-50">
                            <td className="py-2 px-3 font-medium text-blue-700 cursor-pointer whitespace-nowrap" onClick={() => navigate(`/sales/dc/${l.dc}`)}>{l.dc_no}</td>
                            <td className="py-2 px-3 text-right whitespace-nowrap">{Number(l.quantity || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td>
                            <td className="py-2 px-3 whitespace-nowrap">{l.uom || '-'}</td>
                            <td className="py-2 px-3 text-right whitespace-nowrap">{fmt(l.freight_rate)}</td>
                            <td className="py-2 px-3 text-right font-semibold whitespace-nowrap">{fmt(l.freight_amount)}</td>
                            <td className="py-2 px-3 whitespace-nowrap">{l.invoice_no || '-'}</td>
                            <td className="py-2 px-3 whitespace-nowrap">{fmtDate(l.invoice_date)}</td>
                            <td className="py-2 px-3 whitespace-nowrap">{l.destination || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Freight Costs */}
              <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-4 pb-2 border-b">Freight Costs</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                  <div><span className="text-slate-500">Freight Value</span><p className="font-semibold">{fmt(freight.base_amount)}</p></div>
                  <div><span className="text-slate-500">Unloading Wages</span><p className="font-semibold">+{fmt(freight.unloading_wages_amount)}</p></div>
                  <div><span className="text-slate-500">Unloading Charges</span><p className="font-semibold">+{fmt(freight.unloading_charges)}</p></div>
                </div>
                {Number(freight.tds_less) > 0 && (
                  <div className="mt-3 flex justify-between text-sm text-rose-600">
                    <span>Less: TDS (deducted)</span><span>−{fmt(freight.tds_less)}</span>
                  </div>
                )}
                <div className="mt-4 pt-3 border-t flex justify-between text-base font-bold">
                  <span>Total Payable</span><span>{fmt(freight.payable_amount)}</span>
                </div>
              </div>

              {/* Bills covered by this ONE slip (one trip, several invoices) */}
              {(freight.covered_bills_detail || []).length > 0 && (
                <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
                  <div className="flex items-center justify-between mb-3 pb-2 border-b">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Bills covered ({freight.covered_bills_detail.length})</h3>
                    <span className="text-xs text-slate-500">one slip · paid once for all</span>
                  </div>
                  <div className="space-y-2">
                    {freight.covered_bills_detail.map((b) => (
                      <div key={b.id} className="flex items-center justify-between gap-2 text-sm border border-slate-100 rounded-lg px-3 py-2">
                        <div className="min-w-0">
                          <span className="font-medium text-slate-800">{b.bill_no}</span>
                          {b.is_primary && <span className="ml-2 text-[10px] uppercase tracking-wide bg-slate-100 text-slate-500 rounded px-1.5 py-0.5">primary</span>}
                          <span className="block text-xs text-slate-500 truncate">{b.vendor_name || '—'} · inv {b.invoice_no || '—'} · {fmt(b.total)}</span>
                        </div>
                        {!b.is_primary && isPurchase && (
                          <button onClick={() => unlinkCoveredBill(b.id)} title="Unlink this bill from the freight"
                            className="text-slate-300 hover:text-rose-600 shrink-0 text-lg leading-none">&times;</button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {freight.remarks && (
                <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-3 pb-2 border-b">Remarks</h3>
                  <p className="text-sm text-slate-700 whitespace-pre-wrap">{freight.remarks}</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* ============ SIDEBAR ============ */}
        <div className="space-y-4 sm:space-y-5 lg:sticky lg:top-4 self-start">
          {/* Summary Card */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-4">Summary</h3>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-sm text-slate-500">Status</span>
                <StatusBadge status={freight.status_display || freight.status} />
              </div>
              {isPurchase && (() => {
                const payable = Number(freight.total_freight_cost) || Number(freight.payable_amount) || 0;
                // Freight Terms = 'PAID' → charges were settled at source.
                // Treat the whole amount as already paid in the summary so
                // the sidebar doesn't misleadingly read Balance > 0 / Unpaid.
                const isPrepaid = (freight.freight_terms || '').toUpperCase() === 'PAID';
                const paid = isPrepaid ? payable : (Number(freight.total_paid) || 0);
                const bal = isPrepaid ? 0 : (payable - paid);
                const paidPct = isPrepaid ? 100 : (payable > 0 ? Math.round((paid / payable) * 100) : 0);
                const paymentStatus = isPrepaid ? 'Paid' : (paid <= 0 ? 'Unpaid' : paid >= payable ? 'Paid' : 'Partially Paid');
                const statusColors = { 'Unpaid': 'bg-red-100 text-red-700', 'Partially Paid': 'bg-amber-100 text-amber-700', 'Paid': 'bg-emerald-50 text-emerald-700' };
                return <>
                  {!isHidden('freight_terms') && <div className="flex justify-between"><span className="text-sm text-slate-500">Freight Terms</span><span className="text-sm font-medium">{freight.freight_terms_display || '-'}</span></div>}
                  {/* Breakdown: gross freight − TDS ± round-off = payable, so the TDS
                      the transporter deducted is visible (was missing here). */}
                  <div className="flex justify-between"><span className="text-sm text-slate-500">Freight (gross)</span><span className="text-sm font-medium">{fmt(freight.base_amount)}</span></div>
                  {Number(freight.tds_less) > 0 && <div className="flex justify-between"><span className="text-sm text-slate-500">TDS (deducted)</span><span className="text-sm font-medium text-rose-600">− {fmt(freight.tds_less)}</span></div>}
                  {Number(freight.less_amount) > 0 && <div className="flex justify-between"><span className="text-sm text-slate-500">Round-off</span><span className="text-sm font-medium">{freight.less_amount_sign === 'LESS' ? '− ' : '+ '}{fmt(freight.less_amount)}</span></div>}
                  {!isHidden('payable_amount') && <div><p className="text-xs text-slate-500 uppercase">Total Payable</p><p className="text-2xl font-bold text-slate-900 mt-1">{fmt(payable)}</p></div>}
                  {!isHidden('total_paid') && <div><p className="text-xs text-slate-500 uppercase">Paid Amount</p><p className="text-xl font-bold text-emerald-700 mt-1">{fmt(paid)}</p></div>}
                  {!isHidden('balance') && <div><p className="text-xs text-slate-500 uppercase">Balance Amount</p><p className={`text-xl font-bold mt-1 ${bal > 0 ? 'text-orange-600' : 'text-slate-400'}`}>{fmt(bal)}</p></div>}
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-slate-500 uppercase">Payment Status</span>
                    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${statusColors[paymentStatus]}`}>{paymentStatus}</span>
                  </div>
                  <div><p className="text-xs text-slate-500 uppercase">Payments</p><p className="text-lg font-semibold text-slate-700 mt-1">{payments.length}</p></div>
                  <div>
                    <div className="w-full bg-slate-200 rounded-full h-2.5">
                      <div className="bg-emerald-600 h-2.5 rounded-full" style={{ width: `${Math.min(100, paidPct)}%` }}></div>
                    </div>
                    <p className="text-xs text-slate-500 mt-1">{paidPct}% paid</p>
                  </div>
                  <div className="pt-2 border-t space-y-2">
                    <div className="flex justify-between"><span className="text-sm text-slate-500">Created By</span><span className="text-sm font-medium">{freight.created_by_name || '-'}</span></div>
                    {freight.approved_by_name && <div className="flex justify-between"><span className="text-sm text-slate-500">Approved By</span><span className="text-sm font-medium">{freight.approved_by_name}</span></div>}
                    {freight.approved_at && <div className="flex justify-between"><span className="text-sm text-slate-500">Approved At</span><span className="text-sm font-medium">{fmtDate(freight.approved_at)}</span></div>}
                  </div>
                </>;
              })()}
              {!isPurchase && (() => {
                const payable = Number(freight.payable_amount) || 0;
                const isPrepaid = (freight.freight_terms || '').toUpperCase() === 'PAID';
                const totalPaid = isPrepaid ? payable : (Number(freight.total_paid) || 0);
                const bal = isPrepaid ? 0 : (Number(freight.balance) || 0);
                const paidPct = isPrepaid ? 100 : Math.round((totalPaid / Math.max(1, payable)) * 100);
                return (
                <>
                  <div><p className="text-xs text-slate-500 uppercase">Total Payable</p><p className="text-2xl font-bold text-slate-900 mt-1">{fmt(payable)}</p></div>
                  <div><p className="text-xs text-slate-500 uppercase">Total Paid</p><p className="text-xl font-bold text-emerald-700 mt-1">{fmt(totalPaid)}</p></div>
                  <div><p className="text-xs text-slate-500 uppercase">Balance</p><p className={`text-xl font-bold mt-1 ${bal > 0 ? 'text-orange-600' : 'text-slate-400'}`}>{fmt(bal)}</p></div>
                  <div><p className="text-xs text-slate-500 uppercase">Payments</p><p className="text-lg font-semibold text-slate-700 mt-1">{payments.length}</p></div>
                  <div>
                    <div className="w-full bg-slate-200 rounded-full h-2.5">
                      <div className="bg-emerald-600 h-2.5 rounded-full" style={{ width: `${Math.min(100, paidPct)}%` }}></div>
                    </div>
                    <p className="text-xs text-slate-500 mt-1">{paidPct}% paid</p>
                  </div>
                </>
                );
              })()}
            </div>
          </div>

          {/* Payment History — each payment made for THIS freight, pulled from the
              freight payments (so paid vs balance is always in step). */}
          {payments.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-3">Payment History ({payments.length})</h3>
              <div className="space-y-2">
                {payments.map((p, i) => (
                  <div key={p.id || i} className="flex items-center justify-between gap-2 text-sm border border-slate-100 rounded-lg px-3 py-2">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-800 tabular-nums">{fmtDate(p.payment_date)} · {formatCurrency(p.amount_paid)}</div>
                      <div className="text-xs text-slate-500 truncate">{[p.payment_mode, p.reference_no, p.paid_to].filter(Boolean).join(' · ') || '—'}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-4">Actions</h3>
            <div className="space-y-2">
              {(() => {
                // Freight Terms = 'PAID' means the charges were already
                // settled at source — no downstream payment is allowed.
                // Render a disabled "Already Paid" button instead of
                // the normal Make Payment CTA so the user can see the
                // action is intentionally locked and why.
                const isPrepaid = (freight.freight_terms || '').toUpperCase() === 'PAID';
                if (isPrepaid && !isCancelled) {
                  return (
                    <button
                      disabled
                      title='Freight Terms are "Paid" — settled at source, no payment to record.'
                      className="w-full px-4 py-2 text-sm bg-slate-200 text-slate-500 rounded-lg font-medium cursor-not-allowed"
                    >
                      Already Paid (Freight Terms)
                    </button>
                  );
                }
                return (
                  <>
                    {/* Pay Button - for approved/in-transit/completed freight with balance */}
                    {!isCancelled && !isPaid && ['APPROVED', 'IN_TRANSIT', 'COMPLETED', 'PARTIALLY_PAID'].includes(freight.status) && (
                      <button
                        onClick={() => navigate(`/freight/payments/new?type=${isPurchase ? 'purchase' : 'sales'}&freight_id=${id}`)}
                        className="w-full px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 font-medium"
                      >
                        Make Payment
                      </button>
                    )}
                    {/* Also show Pay when balance > 0 regardless of status */}
                    {!isCancelled && !isPaid && !['APPROVED', 'IN_TRANSIT', 'COMPLETED', 'PARTIALLY_PAID', 'DRAFT', 'PENDING_APPROVAL', 'PENDING'].includes(freight.status) && getBalance() > 0 && (
                      <button
                        onClick={() => navigate(`/freight/payments/new?type=${isPurchase ? 'purchase' : 'sales'}&freight_id=${id}`)}
                        className="w-full px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 font-medium"
                      >
                        Make Payment
                      </button>
                    )}
                  </>
                );
              })()}
              {isPurchase && (
                <>
                  {canApproveFreight && (freight.status === 'DRAFT' || freight.status === 'PENDING_APPROVAL') && (
                    <button onClick={handleApprove} disabled={isApproving} className="w-full px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                      {isApproving ? 'Approving...' : 'Approve'}
                    </button>
                  )}
                  {canEdit(freightModule) && !['PAID', 'CANCELLED'].includes(freight.status) && (
                    <button onClick={async () => { if (await confirm({ message: 'Cancel this freight?', isDangerous: true })) handleStatusChange('CANCELLED'); }} className="w-full px-4 py-2 text-sm bg-red-50 text-red-600 border border-red-200 rounded-lg hover:bg-red-100">Cancel Freight</button>
                  )}
                </>
              )}
              {!isPurchase && (
                <>
                  {freight.status === 'PENDING' && canApprove(freightModule) && (
                    <button onClick={async () => {
                      try {
                        const res = await apiClient.post(`/api/sales/freight/${id}/approve/`);
                        setFreight(res.data);
                        toast.success('Freight approved!');
                      } catch (err) { toast.error(err.response?.data?.error || 'Failed to approve'); }
                    }} className="w-full px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">Approve</button>
                  )}
                  {!isCancelled && !isPaid && canCancel(freightModule) && (
                    <button onClick={handleCancel} className="w-full px-4 py-2 text-sm bg-red-50 text-red-600 border border-red-200 rounded-lg hover:bg-red-100">Cancel Freight</button>
                  )}
                </>
              )}
              <button onClick={() => navigate(isPurchase ? '/freight/inward' : '/freight/outward')} className="w-full px-4 py-2 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
                &larr; Back to List
              </button>
            </div>
          </div>
        </div>
      </div>
      {FlowPopup}
    </MainLayout>
  );
}
