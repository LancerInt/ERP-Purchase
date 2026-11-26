import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Pencil, Save, X, Plus, Trash2, Truck, FileText, CheckCircle2, ArrowLeft } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';

import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import useLookup, { clearLookupCache } from '../../../hooks/useLookup.js';
import useAllProducts from '../components/useAllProducts.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import FileAttachments from '../components/FileAttachments';
import ActivityLog from '@/components/common/ActivityLog';
import { UOM_OPTIONS, UOM_VALUES } from '../../../constants/uom.js';
import { confirm } from '@/components/common/confirm';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { getApiErrorMessage } from '@/utils/formHelpers';

// Roles allowed to approve a Receipt Advice.
const RECEIPT_APPROVE_ROLES = new Set(['admin', 'administrator', 'purchase manager']);

const emptyReceiptLine = {
  _isNew: true, product: '', po_line: '', quantity_received: '', uom: 'KG', batch_no: '', godown_location: '', remarks: '', is_debit_note: false,
  // Optional physical-measurement fields persisted on ReceiptLine.
  // Blank = NULL in the DB; never coerced to 0.
  length: '', breadth: '', width: '', weight: '',
};
const emptyPackingLine = {
  _isNew: true, packaging_sku: '', quantity: '', net_quantity: '', uom: 'PCS', condition: 'NEW',
  length: '', breadth: '', width: '', weight: '', batch_no: '', godown_location: '', remarks: '',
};
const emptyWeighmentDetail = {
  _isNew: true, weighment_name: '', weighment_number: '',
  first_weight: '', second_weight: '', tare_weight: '', uom: 'KG',
};
const emptyFreightDetail = {
  _isNew: true, freight_type: 'LOCAL_DRAYAGE', transporter: '', freight_terms: '', tentative_charge: '', discount: '0',
  payable_by: 'COMPANY', quantity_basis: '', quantity_uom: '', destination_state: '', freight_uom: '',
};
const emptyWageLine = {
  _isNew: true, wage_type: 'UNLOADING', contractor_vendor: '', amount: '', tds_applicable: '0',
  payable_by: 'COMPANY', unloading_date: '', remarks: '',
};

export default function ReceiptAdviceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [receipt, setReceipt] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [editData, setEditData] = useState({});
  const { isAdmin, isSuperuser, role, canCreate, canEdit, canDelete, canApprove, canReject, canConvert, canCreateFreight, canApplyDebit } = usePermissions();
  // Field-level permissions (VIEW / READ_ONLY / HIDDEN per role).
  const { isHidden, isReadOnly } = useFieldPermissions('Receipt Advice');
  const { isHidden: isLineHidden, isReadOnly: isLineRO } = useFieldPermissions('Receipt Line');
  const { isHidden: isPackHidden, isReadOnly: isPackRO } = useFieldPermissions('Receipt Packing Material');
  const _roleName = (role?.role_name || role?.name || '').trim().toLowerCase();
  // Approve button — driven by the Receipt Advice "Approve" tick in
  // the Purchase Permissions grid, NOT by a hardcoded role name. The
  // hardcoded RECEIPT_APPROVE_ROLES set predates the grid and meant
  // admins couldn't revoke Approve from a role without a code change
  // (e.g. Warehouse Coordinator still saw the button even after the
  // admin unticked it). isAdmin/isSuperuser still bypass for break-
  // glass access.
  const canApproveReceipt = isAdmin || isSuperuser || canApprove('Receipt Advice');
  // Delete button gate — was previously ungated so anyone with the
  // detail page open could delete a receipt. Now respects the grid's
  // Delete tick on the Receipt Advice row.
  const canDeleteReceipt = isAdmin || isSuperuser || canDelete('Receipt Advice');
  // Edit button gate.
  const canEditReceipt = canEdit('Receipt Advice');
  // "Debit Note: All ON" toggle is an edit on the receipt's lines — gate
  // it with canEdit per the standardised pattern.
  const canUseDebitNote = canEdit('Receipt Advice');
  // Create Freight button — RBAC tick on Receipt Advice row.
  const canCreateReceiptFreight = canCreateFreight('Receipt Advice');
  // Create Bill from receipt — convert on the source module.
  const canConvertReceiptToBill = canConvert('Receipt Advice');
  // Generate Debit Note (Vendor Credit) from the receipt. Gated on the
  // Receipt Advice module's "Apply Debit" button permission so the button is
  // controllable from Purchase -> Button Permissions (Receipt Advice row).
  const canCreateDebitNote = canApplyDebit('Receipt Advice');

  // Editable sub-form states
  const [editLines, setEditLines] = useState([]);
  const [editPackingLines, setEditPackingLines] = useState([]);
  const [editWeighmentDetails, setEditWeighmentDetails] = useState([]);
  const [editFreightDetails, setEditFreightDetails] = useState([]);
  const [editWageLines, setEditWageLines] = useState([]);

  const { options: warehouseOptions } = useLookup('/api/warehouses/?scope=true');
  const { options: godownOptions } = useLookup('/api/godowns/');
  const { options: productOptions } = useAllProducts();
  const { options: transporterOptions } = useLookup('/api/transporters/');
  const { options: vendorOptions, raw: vendorRaw } = useLookup('/api/vendors/');

  // Contractor vendors for wages
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

  const initEditState = (data) => {
    setEditData({ ...data });
    setEditLines((data.receipt_lines || []).map(l => ({ ...l })));
    setEditPackingLines((data.packing_materials || []).map(l => ({ ...l })));
    setEditWeighmentDetails((data.weighment_details || []).map(l => ({ ...l })));
    setEditFreightDetails((data.freight_details || []).map(l => ({ ...l })));
    setEditWageLines((data.loading_unloading_wages || []).map(l => ({ ...l })));
  };

  const fetchReceipt = () => {
    apiClient.get(`/api/purchase/receipts/${id}/`)
      .then(res => { setReceipt(res.data); initEditState(res.data); })
      .catch((err) => { if (err.response?.status !== 404) toast.error(getApiErrorMessage(err)); })
      .finally(() => setIsLoading(false));
  };

  useEffect(() => { fetchReceipt(); }, [id]);

  const handleApprove = async () => {
    if (!(await confirm({ message: `Approve ${receipt.receipt_advice_no}? Freight, Bill, and Wages can only be created after approval.` }))) return;
    setIsApproving(true);
    try {
      const res = await apiClient.post(`/api/purchase/receipts/${id}/approve/`);
      setReceipt(res.data);
      initEditState(res.data);
      toast.success(`${receipt.receipt_advice_no} approved`);
      const adn = res.data?.auto_debit_note;
      if (adn?.credit_no) {
        toast.success(`Debit Note ${adn.credit_no} auto-generated (₹${adn.total_amount})`, { duration: 6000 });
      }
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to approve');
    } finally {
      setIsApproving(false);
    }
  };

  const [isGeneratingDebit, setIsGeneratingDebit] = useState(false);
  const handleGenerateDebitNote = async () => {
    setIsGeneratingDebit(true);
    try {
      const res = await apiClient.post(`/api/purchase/receipts/${id}/generate-debit-note/`);
      if (res.data?.created) {
        toast.success(`Debit Note ${res.data.credit_no} created`);
      } else {
        toast(res.data?.detail || 'No action taken');
      }
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to generate debit note');
    } finally {
      setIsGeneratingDebit(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: 'Are you sure you want to delete this receipt? This action cannot be undone.', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/receipts/${id}/`);
      toast.success('Receipt deleted successfully');
      navigate('/purchase/receipts');
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to delete');
    }
  };

  const handleEdit = () => { setIsEditing(true); initEditState(receipt); };
  const handleCancel = () => { setIsEditing(false); initEditState(receipt); };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setEditData(prev => ({ ...prev, [name]: value }));
  };

  // Generic sub-form change handler
  const makeLineChange = (setter) => (index, field, value) => {
    setter(prev => prev.map((line, i) => i === index ? { ...line, [field]: value } : line));
  };
  const handleLineChange = makeLineChange(setEditLines);
  const handlePackingChange = makeLineChange(setEditPackingLines);
  const handleWeighmentChange = makeLineChange(setEditWeighmentDetails);
  const handleFreightChange = makeLineChange(setEditFreightDetails);
  const handleWageChange = makeLineChange(setEditWageLines);

  // Add/remove handlers
  const handleAddLine = () => {
    const nextLineNo = editLines.length > 0 ? Math.max(...editLines.map(l => l.line_no || 0)) + 1 : 1;
    setEditLines(prev => [...prev, { ...emptyReceiptLine, line_no: nextLineNo }]);
  };
  const handleRemoveLine = (i) => setEditLines(prev => prev.filter((_, idx) => idx !== i));

  const handleAddPacking = () => setEditPackingLines(prev => [...prev, { ...emptyPackingLine }]);
  const handleRemovePacking = (i) => setEditPackingLines(prev => prev.filter((_, idx) => idx !== i));

  const handleAddWeighment = () => setEditWeighmentDetails(prev => [...prev, { ...emptyWeighmentDetail }]);
  const handleRemoveWeighment = (i) => setEditWeighmentDetails(prev => prev.filter((_, idx) => idx !== i));

  const handleAddFreight = () => {
    const uom = (receipt?.receipt_lines || [])[0]?.uom || '';
    setEditFreightDetails(prev => [...prev, { ...emptyFreightDetail, quantity_uom: uom, freight_uom: uom }]);
  };
  const handleRemoveFreight = (i) => setEditFreightDetails(prev => prev.filter((_, idx) => idx !== i));

  const handleAddWage = () => setEditWageLines(prev => [...prev, { ...emptyWageLine }]);
  const handleRemoveWage = (i) => setEditWageLines(prev => prev.filter((_, idx) => idx !== i));

  const buildNestedPayload = (items, fields) => {
    return items.map(item => {
      const obj = {};
      fields.forEach(f => { if (item[f] !== undefined) obj[f] = item[f]; });
      if (item.id && !item._isNew) obj.id = item.id;
      return obj;
    });
  };

  const handleSave = async () => {
    // Validate receipt line quantities before saving
    for (const line of editLines) {
      const qty = parseFloat(line.quantity_received) || 0;
      if (line.product && qty <= 0) {
        toast.error('Quantity received must be greater than 0.');
        return;
      }
    }

    setIsSaving(true);
    try {
      const payload = {
        warehouse: editData.warehouse || undefined,
        driver_name: editData.driver_name || '',
        driver_phone: editData.driver_phone || '',
        vehicle_number: editData.vehicle_number || '',
        advance_amount: editData.advance_amount === '' || editData.advance_amount == null ? null : editData.advance_amount,
        freight_value: editData.freight_value === '' || editData.freight_value == null ? null : editData.freight_value,
        freight_terms: editData.freight_terms || '',
        qc_routing: editData.qc_routing || '',
        qc_status: editData.qc_status || '',
        remarks: editData.remarks || '',
        // Invoice + Direct Receipt header fields. invoice_no is shown on
        // both modes; reason / date / amount only matter for Direct.
        invoice_no: editData.invoice_no || '',
        invoice_date: editData.invoice_date || null,
        invoice_amount: editData.invoice_amount === '' || editData.invoice_amount == null ? null : editData.invoice_amount,
        direct_reason: editData.direct_reason || '',
        receipt_lines: buildNestedPayload(editLines, [
          'line_no', 'product', 'po_line', 'quantity_received', 'net_quantity', 'uom', 'batch_no', 'expiry_date',
          'godown_location', 'extra_commission', 'agent_commission', 'remarks', 'is_debit_note',
          'length', 'breadth', 'width', 'weight',
        ]).map(l => ({
          ...l,
          godown_location: l.godown_location || null,
          po_line: l.po_line || null,
          expiry_date: l.expiry_date || null,
          // Blank Decimal cells → null on the backend, never 0.
          length:  l.length  === '' || l.length  == null ? null : l.length,
          breadth: l.breadth === '' || l.breadth == null ? null : l.breadth,
          width:   l.width   === '' || l.width   == null ? null : l.width,
          weight:  l.weight  === '' || l.weight  == null ? null : l.weight,
        })),
        packing_materials: buildNestedPayload(editPackingLines, [
          'packaging_sku', 'po_line', 'quantity', 'net_quantity', 'uom', 'condition',
          'length', 'breadth', 'width', 'weight', 'batch_no', 'godown_location', 'remarks',
        ]).map(p => ({
          ...p,
          po_line: p.po_line || null,
          godown_location: p.godown_location || null,
          net_quantity: p.net_quantity === '' || p.net_quantity == null ? null : p.net_quantity,
          length:  p.length  === '' || p.length  == null ? null : p.length,
          breadth: p.breadth === '' || p.breadth == null ? null : p.breadth,
          width:   p.width   === '' || p.width   == null ? null : p.width,
          weight:  p.weight  === '' || p.weight  == null ? null : p.weight,
        })),
        weighment_details: buildNestedPayload(editWeighmentDetails, [
          'weighment_name', 'weighment_number', 'first_weight', 'second_weight', 'tare_weight', 'uom',
        ]).map(w => ({
          ...w,
          first_weight:  w.first_weight  === '' || w.first_weight  == null ? null : w.first_weight,
          second_weight: w.second_weight === '' || w.second_weight == null ? null : w.second_weight,
          tare_weight:   w.tare_weight   === '' || w.tare_weight   == null ? null : w.tare_weight,
        })),
        freight_details: buildNestedPayload(editFreightDetails, [
          'freight_type', 'transporter', 'freight_terms', 'tentative_charge', 'discount',
          'payable_by', 'quantity_basis', 'quantity_uom', 'destination_state', 'cost_per_unit_calc',
        ]).map(f => ({ ...f, transporter: f.transporter || null })),
        loading_unloading_wages: buildNestedPayload(editWageLines, [
          'wage_type', 'contractor_vendor', 'amount', 'tds_applicable', 'payable_by', 'unloading_date', 'remarks',
        ]).map(w => ({ ...w, contractor_vendor: w.contractor_vendor || null })),
      };
      const res = await apiClient.patch(`/api/purchase/receipts/${id}/`, payload);
      setReceipt(res.data);
      initEditState(res.data);
      setIsEditing(false);
      toast.success('Receipt updated successfully');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  // Bulk-toggle every line's is_debit_note flag from the Actions
  // panel. Mirrors the receipt-level toggle on the create form so the
  // operator can flip the whole receipt's debit-note status without
  // entering edit mode and ticking each row. We PATCH the receipt
  // directly with the rebuilt receipt_lines payload — same shape as
  // handleSave uses — to keep the server contract consistent.
  const handleToggleDebitNote = async () => {
    const currentLines = receipt.receipt_lines || [];
    if (!currentLines.length) {
      toast.error('No receipt lines to flag');
      return;
    }
    const onCount = currentLines.filter(l => l.is_debit_note).length;
    const next = onCount !== currentLines.length;
    setIsSaving(true);
    try {
      const payload = {
        receipt_lines: currentLines.map(l => ({
          id: l.id,
          line_no: l.line_no,
          product: l.product,
          po_line: l.po_line || null,
          quantity_received: l.quantity_received,
          net_quantity: l.net_quantity,
          uom: l.uom,
          batch_no: l.batch_no,
          expiry_date: l.expiry_date || null,
          godown_location: l.godown_location || null,
          extra_commission: l.extra_commission,
          agent_commission: l.agent_commission,
          remarks: l.remarks,
          is_debit_note: next,
          // Preserve the dimension cells so toggling Debit Note from
          // the Actions panel doesn't wipe them. PATCH replaces the
          // nested list wholesale, so anything we don't echo back gets
          // dropped to NULL.
          length:  l.length  ?? null,
          breadth: l.breadth ?? null,
          width:   l.width   ?? null,
          weight:  l.weight  ?? null,
        })),
      };
      const res = await apiClient.patch(`/api/purchase/receipts/${id}/`, payload);
      setReceipt(res.data);
      toast.success(next
        ? `Debit Note enabled on ${currentLines.length} line${currentLines.length > 1 ? 's' : ''}`
        : 'Debit Note cleared on all lines');
      const adn = res.data?.auto_debit_note;
      if (adn?.credit_no) {
        toast.success(`Debit Note ${adn.credit_no} auto-generated (₹${adn.total_amount})`, { duration: 6000 });
      }
      // PO balance derives from receipt aggregation — flipping is_debit_note
      // shifts what counts toward 'received', so blow away cached PO/lookups
      // so the next Create-Receipt form picks up the fresh balance.
      clearLookupCache('/api/purchase/orders/');
      clearLookupCache('/api/purchase/receipts/');
    } catch (err) {
      const errData = err.response?.data;
      let msg = 'Failed to toggle Debit Note';
      if (errData) {
        if (typeof errData === 'string') msg = errData;
        else if (errData.detail) msg = errData.detail;
        else msg = JSON.stringify(errData);
      }
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const inputClass = "w-full px-2.5 py-1.5 border border-slate-300 rounded text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500";
  const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;

  if (isLoading) return <MainLayout><div className="flex justify-center py-20"><div className="animate-spin h-8 w-8 border-4 border-primary-500 border-t-transparent rounded-full" /></div></MainLayout>;
  if (!receipt) return (
    <MainLayout>
      <div className="text-center py-20">
        <p className="text-red-500 mb-3">Receipt not found.</p>
        <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/purchase/receipts'))} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
          <ArrowLeft size={15} /> Back to Receipts
        </button>
      </div>
    </MainLayout>
  );

  const lines = isEditing ? editLines : (receipt.receipt_lines || []);
  const packingLines = isEditing ? editPackingLines : (receipt.packing_materials || []);
  const freightDetails = isEditing ? editFreightDetails : (receipt.freight_details || []);
  const wageLines = isEditing ? editWageLines : (receipt.loading_unloading_wages || []);
  const poNumbers = receipt.linked_po_numbers || [];
  const fmtDate = (d) => d ? formatDate(d) : '-';

  // Approve control lives inline with the page title (top-right) — Admin /
  // Purchase Manager can approve; everyone else just sees the status pill.
  const approveControl =
    receipt.approval_status === 'APPROVED' ? (
      <span className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 h-9 sm:h-10 bg-emerald-50 text-emerald-700 text-xs sm:text-sm font-semibold rounded-lg border border-emerald-200 whitespace-nowrap">
        <CheckCircle2 size={15} /> Approved
      </span>
    ) : canApproveReceipt ? (
      <button
        onClick={handleApprove}
        disabled={isApproving}
        className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 h-9 sm:h-10 bg-emerald-600 text-white rounded-lg text-xs sm:text-sm font-semibold hover:bg-emerald-700 transition disabled:opacity-50 whitespace-nowrap"
      >
        <CheckCircle2 size={15} /> {isApproving ? 'Approving…' : 'Approve'}
      </button>
    ) : null;

  return (
    <MainLayout>
      <div className="max-w-6xl space-y-2">

        {/* ── Header row: Back + Receipt# + badge + chips + actions ── */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/purchase/receipts'))} className="p-1 text-slate-400 hover:text-slate-700 transition shrink-0" title="Back to list">
              <ArrowLeft size={16} />
            </button>
            <h1 className="text-lg sm:text-xl font-bold text-slate-900 truncate">{receipt.receipt_advice_no || 'Receipt Advice'}</h1>
            <StatusBadge status={receipt.approval_status === 'APPROVED' ? 'Approved' : 'Draft'} />
            <div className="hidden sm:flex items-center gap-1.5 ml-1">
              {receipt.receipt_source === 'DIRECT' && <span className="px-2 py-0.5 rounded bg-amber-50 text-[10px] font-semibold text-amber-700 border border-amber-200">Direct</span>}
              {receipt.partial_receipt_flag && <span className="px-2 py-0.5 rounded bg-orange-50 text-[10px] font-semibold text-orange-700 border border-orange-200">Partial</span>}
              {receipt.vendor_name && <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{receipt.vendor_name}</span>}
              {receipt.company_name && <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{receipt.company_name}</span>}
              {poNumbers.length > 0 && <span className="px-2 py-0.5 rounded bg-blue-50 text-[10px] font-medium text-blue-700">{poNumbers.join(', ')}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap ml-6 sm:ml-0">
            {approveControl}
          </div>
        </div>

        {/* Mobile chips row */}
        <div className="flex sm:hidden items-center gap-1.5 flex-wrap ml-7">
          {receipt.receipt_source === 'DIRECT' && <span className="px-2 py-0.5 rounded bg-amber-50 text-[10px] font-semibold text-amber-700 border border-amber-200">Direct</span>}
          {receipt.partial_receipt_flag && <span className="px-2 py-0.5 rounded bg-orange-50 text-[10px] font-semibold text-orange-700 border border-orange-200">Partial</span>}
          {receipt.vendor_name && <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{receipt.vendor_name}</span>}
          {receipt.company_name && <span className="px-2 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-600">{receipt.company_name}</span>}
          {poNumbers.length > 0 && <span className="px-2 py-0.5 rounded bg-blue-50 text-[10px] font-medium text-blue-700">{poNumbers.join(', ')}</span>}
        </div>

          {/* Receipt Details — compact field strip */}
          <div className="bg-white rounded-lg border border-slate-200 px-3 py-2">
            <div className="flex items-center justify-between mb-1.5">
              <h3 style={{ fontSize: 11 }} className="font-semibold text-slate-500 uppercase tracking-wider">Receipt Details</h3>
              {!isEditing ? (
                canEditReceipt && (
                  <button onClick={handleEdit} className="flex items-center gap-1 px-2 py-1 text-[11px] text-primary-700 bg-primary-50 rounded hover:bg-primary-100">
                    <Pencil size={12} /> Edit
                  </button>
                )
              ) : (
                <div className="flex gap-1.5">
                  <button onClick={handleCancel} className="flex items-center gap-1 px-2 py-1 text-[11px] text-slate-600 bg-slate-100 rounded hover:bg-slate-200">
                    <X size={12} /> Cancel
                  </button>
                  <button onClick={handleSave} disabled={isSaving} className="flex items-center gap-1 px-2 py-1 text-[11px] text-white bg-primary-600 rounded hover:bg-primary-700 disabled:opacity-50">
                    <Save size={12} /> {isSaving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              )}
            </div>
            {!isEditing ? (
              <div className="flex items-start gap-4 overflow-x-auto pb-1">
                {!isHidden('receipt_advice_no') && (
                <div className="shrink-0">
                  <p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Receipt No</p>
                  <p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{receipt.receipt_advice_no}</p>
                </div>
                )}
                <div className="shrink-0">
                  <p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Source</p>
                  <p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{receipt.receipt_source === 'DIRECT' ? 'Direct' : 'PO'}</p>
                </div>
                <div className="shrink-0">
                  <p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Linked POs</p>
                  <p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-primary-600 whitespace-nowrap">{poNumbers.join(', ') || '-'}</p>
                </div>
                {!isHidden('vendor') && (
                <div className="shrink-0">
                  <p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Vendor</p>
                  <p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{receipt.vendor_name || '-'}</p>
                </div>
                )}
                <div className="shrink-0">
                  <p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Company</p>
                  <p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{receipt.company_name || '-'}</p>
                </div>
                {!isHidden('warehouse') && (
                <div className="shrink-0">
                  <p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Warehouse</p>
                  <p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{receipt.warehouse_name || '-'}</p>
                </div>
                )}
                {!isHidden('receipt_date') && (
                <div className="shrink-0">
                  <p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Receipt Date</p>
                  <p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{fmtDate(receipt.receipt_date)}</p>
                </div>
                )}
                {!isHidden('invoice_no') && (
                <div className="shrink-0">
                  <p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Invoice No</p>
                  <p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{receipt.invoice_no || '-'}</p>
                </div>
                )}
                {!isHidden('driver_name') && (
                <div className="shrink-0">
                  <p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Driver</p>
                  <p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{receipt.driver_name || '-'}</p>
                </div>
                )}
                {!isHidden('vehicle_number') && (
                <div className="shrink-0">
                  <p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Lorry No</p>
                  <p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{receipt.vehicle_number || '-'}</p>
                </div>
                )}
                {!isHidden('advance_amount') && (
                <div className="shrink-0">
                  <p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Advance</p>
                  <p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{receipt.advance_amount ? formatCurrency(receipt.advance_amount) : '-'}</p>
                </div>
                )}
                {!isHidden('freight_value') && (
                <div className="shrink-0">
                  <p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Freight Value</p>
                  <p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{receipt.freight_value ? formatCurrency(receipt.freight_value) : '-'}</p>
                </div>
                )}
                {!isHidden('freight_terms') && (
                <div className="shrink-0">
                  <p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Freight Terms</p>
                  <p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 whitespace-nowrap">{receipt.freight_terms === 'PAID' ? 'Paid' : receipt.freight_terms === 'TO_PAY' ? 'To Pay' : '-'}</p>
                </div>
                )}
                {!isHidden('remarks') && receipt.remarks && (
                <div className="shrink-0 max-w-[200px]">
                  <p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase whitespace-nowrap">Remarks</p>
                  <p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-800 truncate">{receipt.remarks}</p>
                </div>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-1.5">
                {!isHidden('warehouse') && (
                <div>
                  <p className="text-[10px] text-slate-500 uppercase">Warehouse</p>
                  <CustomSelect name="warehouse" value={editData.warehouse || ''} onChange={handleChange} disabled={isReadOnly('warehouse')} className={isReadOnly('warehouse') ? lockedInputClass : inputClass}>
                    <option value="">Select...</option>
                    {warehouseOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                </div>
                )}
                {!isHidden('invoice_no') && (
                <div>
                  <p className="text-[10px] text-slate-500 uppercase">Invoice No</p>
                  <input type="text" name="invoice_no" value={editData.invoice_no || ''} onChange={handleChange} disabled={isReadOnly('invoice_no')} className={isReadOnly('invoice_no') ? lockedInputClass : inputClass} placeholder="Vendor invoice number" />
                </div>
                )}
                {!isHidden('driver_name') && (
                <div>
                  <p className="text-[10px] text-slate-500 uppercase">Driver</p>
                  <input type="text" name="driver_name" value={editData.driver_name || ''} onChange={handleChange} disabled={isReadOnly('driver_name')} className={isReadOnly('driver_name') ? lockedInputClass : inputClass} />
                </div>
                )}
                {!isHidden('driver_phone') && (
                <div>
                  <p className="text-[10px] text-slate-500 uppercase">Driver Phone</p>
                  <input type="tel" name="driver_phone" value={editData.driver_phone || ''} onChange={handleChange} disabled={isReadOnly('driver_phone')} className={isReadOnly('driver_phone') ? lockedInputClass : inputClass} placeholder="+91 98765 43210" pattern="[0-9+\-\s()]{6,20}" />
                </div>
                )}
                {!isHidden('vehicle_number') && (
                <div>
                  <p className="text-[10px] text-slate-500 uppercase">Lorry No</p>
                  <input type="text" name="vehicle_number" value={editData.vehicle_number || ''} onChange={handleChange} disabled={isReadOnly('vehicle_number')} className={isReadOnly('vehicle_number') ? lockedInputClass : inputClass} />
                </div>
                )}
                {!isHidden('advance_amount') && (
                <div>
                  <p className="text-[10px] text-slate-500 uppercase">Advance Amount</p>
                  <input type="number" step="0.01" min="0" name="advance_amount" value={editData.advance_amount || ''} onChange={handleChange} disabled={isReadOnly('advance_amount')} className={isReadOnly('advance_amount') ? lockedInputClass : inputClass} />
                </div>
                )}
                {!isHidden('freight_value') && (
                <div>
                  <p className="text-[10px] text-slate-500 uppercase">Freight Value</p>
                  <input type="number" step="0.01" min="0" name="freight_value" value={editData.freight_value || ''} onChange={handleChange} disabled={isReadOnly('freight_value')} className={isReadOnly('freight_value') ? lockedInputClass : inputClass} />
                </div>
                )}
                {!isHidden('freight_terms') && (
                <div>
                  <p className="text-[10px] text-slate-500 uppercase">Freight Terms</p>
                  <CustomSelect name="freight_terms" value={editData.freight_terms || ''} onChange={handleChange} disabled={isReadOnly('freight_terms')} className={isReadOnly('freight_terms') ? lockedInputClass : inputClass}>
                    <option value="">Select...</option>
                    <option value="PAID">Paid</option>
                    <option value="TO_PAY">To Pay</option>
                  </CustomSelect>
                </div>
                )}
                {!isHidden('remarks') && (
                <div className="col-span-2">
                  <p className="text-[10px] text-slate-500 uppercase">Remarks</p>
                  <textarea name="remarks" value={editData.remarks || ''} onChange={handleChange} rows={2} disabled={isReadOnly('remarks')} className={isReadOnly('remarks') ? lockedInputClass : inputClass} />
                </div>
                )}
              </div>
            )}
          </div>

          {/* ==================== DIRECT RECEIPT INFO ==================== */}
          {/* Only renders for Direct receipts (no PO upstream). Captures
              the justification + invoice reference so this GRN can be
              reconciled / billed later. In edit mode we also show it for
              any Direct receipt so the operator can amend the fields. */}
          {(receipt.receipt_source === 'DIRECT'
            || receipt.direct_reason
            || receipt.invoice_date
            || receipt.invoice_amount) && (
            <div className="bg-white rounded-lg border border-slate-200 px-3 py-2">
              <h3 style={{ fontSize: 11 }} className="font-semibold text-amber-700 uppercase tracking-wider mb-1.5">
                Direct Receipt Info
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-1.5">
                <div>
                  <p className="text-xs text-slate-500 uppercase">Reason</p>
                  {isEditing ? (
                    <CustomSelect
                      name="direct_reason"
                      value={editData.direct_reason || ''}
                      onChange={handleChange}
                      className={inputClass}
                    >
                      <option value="">Select Reason</option>
                      <option value="EMERGENCY">Emergency Purchase</option>
                      <option value="FREE_SAMPLE">Free Sample</option>
                      <option value="REPLACEMENT">Replacement / Warranty</option>
                      <option value="OPENING_STOCK">Opening Stock</option>
                      <option value="RETURN_FROM_JOBWORK">Returned from Job Work</option>
                      <option value="GIFT">Gift / Donation</option>
                      <option value="OTHER">Other</option>
                    </CustomSelect>
                  ) : (
                    <p className="font-medium">{receipt.direct_reason_display || receipt.direct_reason || '-'}</p>
                  )}
                </div>
                {!isHidden('invoice_date') && (
                <div>
                  <p className="text-xs text-slate-500 uppercase">Invoice Date</p>
                  {isEditing ? (
                    <CustomDatePicker
                      name="invoice_date"
                      value={editData.invoice_date || ''}
                      onChange={handleChange}
                      disabled={isReadOnly('invoice_date')}
                      className={isReadOnly('invoice_date') ? lockedInputClass : inputClass}
                    />
                  ) : (
                    <p className="font-medium">{fmtDate(receipt.invoice_date)}</p>
                  )}
                </div>
                )}
                {!isHidden('invoice_amount') && (
                <div>
                  <p className="text-xs text-slate-500 uppercase">Invoice Amount</p>
                  {isEditing ? (
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      name="invoice_amount"
                      value={editData.invoice_amount || ''}
                      onChange={handleChange}
                      disabled={isReadOnly('invoice_amount')}
                      className={isReadOnly('invoice_amount') ? lockedInputClass : inputClass}
                      placeholder="0.00"
                    />
                  ) : (
                    <p className="font-medium">{receipt.invoice_amount ? formatCurrency(receipt.invoice_amount) : '-'}</p>
                  )}
                </div>
                )}
              </div>
            </div>
          )}

          {/* ==================== WEIGHMENT DETAILS ==================== */}
          {/* Weighbridge readings recorded at receipt time. Backing fields
              stay first_weight / second_weight / tare_weight even though
              the UI label says "Net Weight" for tare_weight (= First −
              Second = cargo weight per business convention). */}
          <div className="bg-white rounded-lg border border-slate-200 px-3 py-2">
            <div className="flex items-center justify-between mb-1.5">
              <h3 style={{ fontSize: 11 }} className="font-semibold text-slate-500 uppercase tracking-wider">
                Weighment Details ({(isEditing ? editWeighmentDetails : (receipt.weighment_details || [])).length})
              </h3>
              {isEditing && (
                <button onClick={handleAddWeighment} className="inline-flex items-center gap-1 px-2 py-1 bg-primary-50 text-primary-700 rounded text-[11px] font-medium hover:bg-primary-100">
                  <Plus size={14} /> Add Weighment
                </button>
              )}
            </div>
            {(isEditing ? editWeighmentDetails : (receipt.weighment_details || [])).length === 0 ? (
              <p className="text-sm text-slate-400 italic">
                {isEditing ? 'No weighment details added. Click "Add Weighment" to record weighbridge readings.' : 'No weighment details recorded'}
              </p>
            ) : (
              <div className="overflow-x-auto ios-scroll">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">#</th>
                      <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">Weighment Name</th>
                      <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">Weighment No</th>
                      <th style={{ fontSize: 9 }} className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase">First Wt</th>
                      <th style={{ fontSize: 9 }} className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase">Second Wt</th>
                      <th style={{ fontSize: 9 }} className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase">Net Wt</th>
                      <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">UOM</th>
                      {isEditing && <th className="px-2 py-1.5"></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {(isEditing ? editWeighmentDetails : (receipt.weighment_details || [])).map((line, idx) => (
                      <tr key={line.id || `new-w-${idx}`} className="border-b border-slate-100">
                        <td className="px-2 py-1.5 text-slate-500">{idx + 1}</td>
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="text" value={line.weighment_name || ''} onChange={(e) => handleWeighmentChange(idx, 'weighment_name', e.target.value)} placeholder="Weighbridge name" className={inputClass} style={{ minWidth: '160px' }} />
                        ) : (line.weighment_name || '-')}</td>
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="text" value={line.weighment_number || ''} onChange={(e) => handleWeighmentChange(idx, 'weighment_number', e.target.value)} placeholder="Slip / Ticket No" className={inputClass} style={{ minWidth: '140px' }} />
                        ) : (line.weighment_number || '-')}</td>
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="number" step="0.001" min="0" value={line.first_weight || ''} onChange={(e) => handleWeighmentChange(idx, 'first_weight', e.target.value)} className={inputClass} style={{ minWidth: '110px' }} />
                        ) : (<span className="text-right block">{line.first_weight ?? '-'}</span>)}</td>
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="number" step="0.001" min="0" value={line.second_weight || ''} onChange={(e) => handleWeighmentChange(idx, 'second_weight', e.target.value)} className={inputClass} style={{ minWidth: '110px' }} />
                        ) : (<span className="text-right block">{line.second_weight ?? '-'}</span>)}</td>
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="number" step="0.001" min="0" value={line.tare_weight || ''} onChange={(e) => handleWeighmentChange(idx, 'tare_weight', e.target.value)} className={inputClass} style={{ minWidth: '110px' }} />
                        ) : (<span className="text-right block">{line.tare_weight ?? '-'}</span>)}</td>
                        <td className="px-2 py-1.5">{isEditing ? (
                          <CustomSelect value={line.uom || 'KG'} onChange={(e) => handleWeighmentChange(idx, 'uom', e.target.value)} className={inputClass} style={{ minWidth: '80px' }}>
                            {line.uom && !UOM_VALUES.includes(line.uom) && (
                              <option value={line.uom}>{line.uom}</option>
                            )}
                            {UOM_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </CustomSelect>
                        ) : (line.uom || '-')}</td>
                        {isEditing && (
                          <td className="px-2 py-1.5">
                            <button onClick={() => handleRemoveWeighment(idx)} className="text-red-500 hover:text-red-700"><Trash2 size={14} /></button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ==================== RECEIPT LINE ITEMS ==================== */}
          <div className="bg-white rounded-lg border border-slate-200 px-3 py-2">
            <div className="flex items-center justify-between mb-1.5">
              <h3 style={{ fontSize: 11 }} className="font-semibold text-slate-500 uppercase tracking-wider">Receipt Line Items ({lines.length})</h3>
              {isEditing && (
                <button onClick={handleAddLine} className="inline-flex items-center gap-1 px-2 py-1 bg-primary-50 text-primary-700 rounded text-[11px] font-medium hover:bg-primary-100">
                  <Plus size={14} /> Add Line
                </button>
              )}
            </div>
            {lines.length === 0 ? (
              <p className="text-sm text-slate-400 italic">
                {isEditing ? 'No line items. Click "Add Line" to add.' : 'No line items'}
              </p>
            ) : (
              <div className="overflow-x-auto ios-scroll touch-pan-x">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-slate-200">
                      {!isLineHidden('line_no') && (
                        <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">#</th>
                      )}
                      {!isLineHidden('product') && (
                        <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">Product {isEditing && <span className="text-red-500">*</span>}</th>
                      )}
                      <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">PO Line</th>
                      {!isLineHidden('quantity_received') && (
                        <th style={{ fontSize: 9 }} className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase">Inv Qty {isEditing && <span className="text-red-500">*</span>}</th>
                      )}
                      {!isLineHidden('net_quantity') && (
                        <th style={{ fontSize: 9 }} className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase">Rcvd Qty</th>
                      )}
                      <th style={{ fontSize: 9 }} className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase">Diff</th>
                      {!isLineHidden('is_debit_note') && (
                        <th style={{ fontSize: 9 }} className="text-center px-2 py-1.5 font-semibold text-slate-400 uppercase">DN</th>
                      )}
                      {!isLineHidden('uom') && (
                        <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">UOM</th>
                      )}
                      {!isLineHidden('batch_no') && (
                        <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">Batch</th>
                      )}
                      {!isLineHidden('expiry_date') && (
                        <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">Expiry</th>
                      )}
                      {!isLineHidden('godown_location') && (
                        <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">Godown</th>
                      )}
                      <th style={{ fontSize: 9 }} className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase">Extra Comm.</th>
                      <th style={{ fontSize: 9 }} className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase">Agent Comm.</th>
                      <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">Remarks</th>
                      {isEditing && <th className="px-2 py-1.5"></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, idx) => (
                      <tr key={line.id || `new-${idx}`} className="border-b border-slate-100">
                        {!isLineHidden('line_no') && (
                        <td className="px-2 py-1.5 text-slate-500">{isEditing ? (
                          <input type="number" value={line.line_no || ''} onChange={(e) => handleLineChange(idx, 'line_no', parseInt(e.target.value) || '')} disabled={isLineRO('line_no')} className={`w-14 px-1 py-1 border border-slate-300 rounded text-xs text-center${isLineRO('line_no') ? ' bg-slate-100 cursor-not-allowed' : ''}`} />
                        ) : (line.line_no || idx + 1)}</td>
                        )}
                        {!isLineHidden('product') && (
                        <td className="px-2 py-1.5">{isEditing ? (
                          // Editing Goods rows still uses the Product
                          // dropdown. Machinery / Service lines are
                          // shown as a read-only label since they live
                          // on different FKs and can't be swapped with
                          // a Goods product mid-edit.
                          line.item_type === 'MACHINERY' || line.item_type === 'SERVICE' ? (
                            <span className="font-medium">{line.item_name || '-'}</span>
                          ) : (
                            <CustomSelect value={line.product || ''} onChange={(e) => handleLineChange(idx, 'product', e.target.value)} disabled={isLineRO('product')} className={isLineRO('product') ? lockedInputClass : inputClass} style={{ minWidth: '160px' }}>
                              <option value="">Select Product</option>
                              {productOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </CustomSelect>
                          )
                        ) : (
                          <span className="font-medium">
                            {line.item_name || line.product_name || '-'}
                            {line.item_type && line.item_type !== 'PRODUCT' && (
                              <span className={`ml-1.5 inline-block px-1.5 py-0.5 rounded text-[9px] font-medium align-middle ${
                                line.item_type === 'MACHINERY' ? 'bg-indigo-50 text-indigo-700' : 'bg-emerald-50 text-emerald-700'
                              }`}>
                                {line.item_type === 'MACHINERY' ? 'Machinery' : 'Service'}
                              </span>
                            )}
                          </span>
                        )}</td>
                        )}
                        <td className="px-2 py-1.5 text-slate-600 text-[11px]">{line.po_line_info || '-'}</td>
                        {!isLineHidden('quantity_received') && (
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="number" step="0.01" min="0" value={line.quantity_received || ''} onChange={(e) => handleLineChange(idx, 'quantity_received', e.target.value)} disabled={isLineRO('quantity_received')} className={isLineRO('quantity_received') ? lockedInputClass : inputClass} style={{ minWidth: '100px' }} />
                        ) : (<span className="text-right block">{line.quantity_received}</span>)}</td>
                        )}
                        {!isLineHidden('net_quantity') && (
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="number" step="0.01" min="0" value={line.net_quantity || ''} onChange={(e) => handleLineChange(idx, 'net_quantity', e.target.value)} disabled={isLineRO('net_quantity')} className={isLineRO('net_quantity') ? lockedInputClass : inputClass} style={{ minWidth: '100px' }} />
                        ) : (
                          <span className="text-right block text-slate-800 font-medium">{line.net_quantity != null && line.net_quantity !== '' ? line.net_quantity : '-'}</span>
                        )}</td>
                        )}
                        <td className="px-2 py-1.5 text-right">
                          {(() => {
                            const rcvd = parseFloat(line.quantity_received) || 0;
                            const net = parseFloat(line.net_quantity);
                            if (!rcvd || isNaN(net)) return <span className="text-slate-400">-</span>;
                            const diff = Math.round((rcvd - net) * 100) / 100;
                            const cls = diff > 0 ? 'text-red-600' : diff < 0 ? 'text-amber-600' : 'text-emerald-600';
                            return <span className={`font-medium ${cls}`}>{diff.toFixed(2)}</span>;
                          })()}
                        </td>
                        {!isLineHidden('is_debit_note') && (
                        <td className="px-2 py-1.5 text-center">
                          {isEditing ? (
                            <button
                              type="button"
                              role="switch"
                              aria-checked={!!line.is_debit_note}
                              onClick={() => handleLineChange(idx, 'is_debit_note', !line.is_debit_note)}
                              disabled={isLineRO('is_debit_note')}
                              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 ${line.is_debit_note ? 'bg-emerald-600' : 'bg-slate-300'}${isLineRO('is_debit_note') ? ' opacity-50 cursor-not-allowed' : ''}`}
                              title={line.is_debit_note ? 'Debit Note enabled' : 'Debit Note disabled'}
                            >
                              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${line.is_debit_note ? 'translate-x-4' : 'translate-x-0.5'}`} />
                            </button>
                          ) : (
                            line.is_debit_note ? (
                              <span className="inline-flex items-center px-1.5 py-0.5 bg-emerald-50 text-emerald-700 text-[10px] font-semibold rounded border border-emerald-200">Yes</span>
                            ) : (
                              <span className="text-slate-400 text-[10px]">No</span>
                            )
                          )}
                        </td>
                        )}
                        {!isLineHidden('uom') && (
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="text" value={line.uom || ''} onChange={(e) => handleLineChange(idx, 'uom', e.target.value)} disabled={isLineRO('uom')} className={isLineRO('uom') ? lockedInputClass : inputClass} style={{ minWidth: '70px' }} placeholder="KG" />
                        ) : (line.uom || '-')}</td>
                        )}
                        {!isLineHidden('batch_no') && (
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="text" value={line.batch_no || ''} onChange={(e) => handleLineChange(idx, 'batch_no', e.target.value)} disabled={isLineRO('batch_no')} className={isLineRO('batch_no') ? lockedInputClass : inputClass} style={{ minWidth: '100px' }} />
                        ) : (line.batch_no || '-')}</td>
                        )}
                        {!isLineHidden('expiry_date') && (
                        <td className="px-2 py-1.5">{isEditing ? (
                          <CustomDatePicker value={line.expiry_date || ''} onChange={(e) => handleLineChange(idx, 'expiry_date', e.target.value)} disabled={isLineRO('expiry_date')} className={isLineRO('expiry_date') ? lockedInputClass : inputClass} style={{ minWidth: '130px' }} />
                        ) : (line.expiry_date ? fmtDate(line.expiry_date) : '-')}</td>
                        )}
                        {!isLineHidden('godown_location') && (
                        <td className="px-2 py-1.5">{isEditing ? (
                          <CustomSelect value={line.godown_location || ''} onChange={(e) => handleLineChange(idx, 'godown_location', e.target.value || null)} disabled={isLineRO('godown_location')} className={isLineRO('godown_location') ? lockedInputClass : inputClass} style={{ minWidth: '130px' }}>
                            <option value="">Select Godown</option>
                            {godownOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </CustomSelect>
                        ) : (line.godown_name || '-')}</td>
                        )}
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="number" step="0.01" min="0" value={line.extra_commission || ''} onChange={(e) => handleLineChange(idx, 'extra_commission', e.target.value)} className={inputClass} style={{ minWidth: '90px' }} />
                        ) : (<span className="text-right block">{line.extra_commission || '0'}</span>)}</td>
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="number" step="0.01" min="0" value={line.agent_commission || ''} onChange={(e) => handleLineChange(idx, 'agent_commission', e.target.value)} className={inputClass} style={{ minWidth: '90px' }} />
                        ) : (<span className="text-right block">{line.agent_commission || '0'}</span>)}</td>
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="text" value={line.remarks || ''} onChange={(e) => handleLineChange(idx, 'remarks', e.target.value)} className={inputClass} style={{ minWidth: '120px' }} />
                        ) : (line.remarks || '-')}</td>
                        {isEditing && (
                          <td className="px-2 py-1.5">
                            <button onClick={() => handleRemoveLine(idx)} className="text-red-500 hover:text-red-700"><Trash2 size={14} /></button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-50 font-semibold text-[11px]">
                      <td colSpan="3" className="px-2 py-1.5 text-right">Total:</td>
                      <td className="px-2 py-1.5 text-right">{lines.reduce((s, l) => s + (parseFloat(l.quantity_received) || 0), 0)}</td>
                      <td className="px-2 py-1.5 text-right text-slate-800">{lines.reduce((s, l) => s + (parseFloat(l.net_quantity) || 0), 0) || '-'}</td>
                      <td className="px-2 py-1.5 text-right text-red-600">{lines.reduce((s, l) => {
                        const rcvd = parseFloat(l.quantity_received) || 0;
                        const net = parseFloat(l.net_quantity);
                        return !isNaN(net) ? s + Math.round((rcvd - net) * 100) / 100 : s;
                      }, 0).toFixed(2)}</td>
                      <td colSpan={isEditing ? 9 : 8}></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          {/* Totals — Total Received + Receipt Status on one row
              (replaces the old Summary card). */}
          <div className="bg-white rounded-lg border border-slate-200 px-3 py-2">
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <span style={{ fontSize: 9, letterSpacing: '0.05em' }} className="text-slate-400 font-semibold uppercase">Total Received</span>
                <span className="text-[13px] font-bold text-slate-900">{receipt.total_received || '0'}</span>
              </div>
              <div className="flex items-center gap-2">
                <span style={{ fontSize: 9, letterSpacing: '0.05em' }} className="text-slate-400 font-semibold uppercase">Status</span>
                <StatusBadge status={receipt.receipt_status || (receipt.partial_receipt_flag ? 'Partial' : 'Full')} />
              </div>
            </div>
          </div>
          {/* ==================== PACKING MATERIALS ==================== */}
          {/* Pulled out to its own full-width row so the wider column set
              (dimensions, Invoice/Received qty, Diff, Batch, Godown,
              Remarks) has room to render — mirrors the Create form. */}
          <div className="bg-white rounded-lg border border-slate-200 px-3 py-2">
            <div className="flex items-center justify-between mb-1.5">
              <h3 style={{ fontSize: 11 }} className="font-semibold text-slate-500 uppercase tracking-wider">Packing Materials ({packingLines.length})</h3>
              {isEditing && (
                <button onClick={handleAddPacking} className="inline-flex items-center gap-1 px-2 py-1 bg-primary-50 text-primary-700 rounded text-[11px] font-medium hover:bg-primary-100">
                  <Plus size={14} /> Add Packing
                </button>
              )}
            </div>
            {packingLines.length === 0 ? (
              <p className="text-sm text-slate-400 italic">
                {isEditing ? 'No packing materials added. Click "Add Packing Material" to add.' : 'No packing materials'}
              </p>
            ) : (
              <div className="overflow-x-auto ios-scroll touch-pan-x">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">#</th>
                      {!isPackHidden('packaging_sku') && (
                        <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">SKU</th>
                      )}
                      <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">PO Line</th>
                      {!isPackHidden('length') && (
                        <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">L</th>
                      )}
                      {!isPackHidden('breadth') && (
                        <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">B</th>
                      )}
                      {!isPackHidden('width') && (
                        <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">W</th>
                      )}
                      {!isPackHidden('weight') && (
                        <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">Wt</th>
                      )}
                      {!isPackHidden('quantity') && (
                        <th style={{ fontSize: 9 }} className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase">Inv Qty</th>
                      )}
                      {!isPackHidden('net_quantity') && (
                        <th style={{ fontSize: 9 }} className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase">Rcvd Qty</th>
                      )}
                      <th style={{ fontSize: 9 }} className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase">Diff</th>
                      {!isPackHidden('uom') && (
                        <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">UOM</th>
                      )}
                      {!isPackHidden('batch_no') && (
                        <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">Batch</th>
                      )}
                      {!isPackHidden('godown_location') && (
                        <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">Godown</th>
                      )}
                      {!isPackHidden('remarks') && (
                        <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">Remarks</th>
                      )}
                      <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">Cond.</th>
                      {isEditing && <th className="px-2 py-1.5"></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {packingLines.map((line, idx) => (
                      <tr key={line.id || `new-p-${idx}`} className="border-b border-slate-100">
                        <td className="px-2 py-1.5 text-slate-500">{idx + 1}</td>
                        {!isPackHidden('packaging_sku') && (
                        <td className="px-2 py-1.5">{isEditing ? (
                          <CustomSelect value={line.packaging_sku || ''} onChange={(e) => handlePackingChange(idx, 'packaging_sku', e.target.value)} disabled={isPackRO('packaging_sku')} className={isPackRO('packaging_sku') ? lockedInputClass : inputClass} style={{ minWidth: '180px' }}>
                            <option value="">Select Product</option>
                            {productOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </CustomSelect>
                        ) : (line.packaging_sku_name || '-')}</td>
                        )}
                        <td className="px-2 py-1.5 text-slate-600 text-[11px] whitespace-nowrap">{line.po_line_info || '-'}</td>
                        {!isPackHidden('length') && (
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="number" min="0" step="any" value={line.length || ''} onChange={(e) => handlePackingChange(idx, 'length', e.target.value)} disabled={isPackRO('length')} placeholder="Length" className={isPackRO('length') ? lockedInputClass : inputClass} style={{ minWidth: '90px' }} />
                        ) : (line.length ?? '-')}</td>
                        )}
                        {!isPackHidden('breadth') && (
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="number" min="0" step="any" value={line.breadth || ''} onChange={(e) => handlePackingChange(idx, 'breadth', e.target.value)} disabled={isPackRO('breadth')} placeholder="Breadth" className={isPackRO('breadth') ? lockedInputClass : inputClass} style={{ minWidth: '90px' }} />
                        ) : (line.breadth ?? '-')}</td>
                        )}
                        {!isPackHidden('width') && (
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="number" min="0" step="any" value={line.width || ''} onChange={(e) => handlePackingChange(idx, 'width', e.target.value)} disabled={isPackRO('width')} placeholder="Width" className={isPackRO('width') ? lockedInputClass : inputClass} style={{ minWidth: '90px' }} />
                        ) : (line.width ?? '-')}</td>
                        )}
                        {!isPackHidden('weight') && (
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="number" min="0" step="any" value={line.weight || ''} onChange={(e) => handlePackingChange(idx, 'weight', e.target.value)} disabled={isPackRO('weight')} placeholder="Weight" className={isPackRO('weight') ? lockedInputClass : inputClass} style={{ minWidth: '90px' }} />
                        ) : (line.weight ?? '-')}</td>
                        )}
                        {!isPackHidden('quantity') && (
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="number" step="0.01" min="0" value={line.quantity || ''} onChange={(e) => handlePackingChange(idx, 'quantity', e.target.value)} disabled={isPackRO('quantity')} placeholder="0.00" className={isPackRO('quantity') ? lockedInputClass : inputClass} style={{ minWidth: '100px' }} />
                        ) : (<span className="text-right block">{line.quantity}</span>)}</td>
                        )}
                        {!isPackHidden('net_quantity') && (
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="number" step="0.01" min="0" value={line.net_quantity || ''} onChange={(e) => handlePackingChange(idx, 'net_quantity', e.target.value)} disabled={isPackRO('net_quantity')} placeholder="0.00" className={isPackRO('net_quantity') ? lockedInputClass : inputClass} style={{ minWidth: '100px' }} />
                        ) : (<span className="text-right block">{line.net_quantity ?? '-'}</span>)}</td>
                        )}
                        <td className="px-2 py-1.5 text-right">
                          {(() => {
                            const inv = parseFloat(line.quantity) || 0;
                            const rcv = parseFloat(line.net_quantity);
                            if (!inv && isNaN(rcv)) return <span className="text-slate-400">-</span>;
                            if (isNaN(rcv)) return <span className="text-slate-400">-</span>;
                            const diff = Math.round((inv - rcv) * 100) / 100;
                            const cls = diff > 0 ? 'text-red-600' : diff < 0 ? 'text-amber-600' : 'text-emerald-600';
                            return <span className={`font-medium ${cls}`}>{diff.toFixed(2)}</span>;
                          })()}
                        </td>
                        {!isPackHidden('uom') && (
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="text" value={line.uom || ''} onChange={(e) => handlePackingChange(idx, 'uom', e.target.value)} disabled={isPackRO('uom')} className={isPackRO('uom') ? lockedInputClass : inputClass} style={{ minWidth: '70px' }} />
                        ) : (line.uom || '-')}</td>
                        )}
                        {!isPackHidden('batch_no') && (
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="text" value={line.batch_no || ''} onChange={(e) => handlePackingChange(idx, 'batch_no', e.target.value)} disabled={isPackRO('batch_no')} placeholder="Batch" className={isPackRO('batch_no') ? lockedInputClass : inputClass} style={{ minWidth: '100px' }} />
                        ) : (line.batch_no || '-')}</td>
                        )}
                        {!isPackHidden('godown_location') && (
                        <td className="px-2 py-1.5">{isEditing ? (
                          <CustomSelect value={line.godown_location || ''} onChange={(e) => handlePackingChange(idx, 'godown_location', e.target.value)} disabled={isPackRO('godown_location')} className={isPackRO('godown_location') ? lockedInputClass : inputClass} style={{ minWidth: '130px' }}>
                            <option value="">Select Godown</option>
                            {godownOptions.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                          </CustomSelect>
                        ) : (line.godown_name || '-')}</td>
                        )}
                        {!isPackHidden('remarks') && (
                        <td className="px-2 py-1.5">{isEditing ? (
                          <input type="text" value={line.remarks || ''} onChange={(e) => handlePackingChange(idx, 'remarks', e.target.value)} disabled={isPackRO('remarks')} placeholder="Remarks" className={isPackRO('remarks') ? lockedInputClass : inputClass} style={{ minWidth: '120px' }} />
                        ) : (line.remarks || '-')}</td>
                        )}
                        <td className="px-2 py-1.5">{isEditing ? (
                          <CustomSelect value={line.condition || ''} onChange={(e) => handlePackingChange(idx, 'condition', e.target.value)} className={inputClass} style={{ minWidth: '110px' }}>
                            <option value="NEW">New</option>
                            <option value="DAMAGED">Damaged</option>
                          </CustomSelect>
                        ) : (line.condition_display || line.condition || '-')}</td>
                        {isEditing && (
                          <td className="px-2 py-1.5">
                            <button onClick={() => handleRemovePacking(idx)} className="text-red-500 hover:text-red-700"><Trash2 size={14} /></button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ==================== ADDITIONAL INFORMATION ==================== */}
          {!isHidden('remarks') && receipt.remarks && !isEditing && (
          <div className="bg-white rounded-lg border border-slate-200 px-3 py-2">
            <p style={{ fontSize: 9, lineHeight: '12px', letterSpacing: '0.05em' }} className="font-semibold text-slate-400 uppercase">Remarks</p>
            <p style={{ fontSize: 12, lineHeight: '16px' }} className="font-medium text-slate-700 mt-0.5">{receipt.remarks}</p>
          </div>
          )}

          {/* ==================== FREIGHT DETAILS (removed by request) ==================== */}
          {false && (
          <div className="bg-white rounded-lg border p-3 sm:p-4">
            <div className="flex items-center justify-between mb-2 pb-1.5 border-b">
              <h3 className="text-sm sm:text-base font-semibold text-slate-800">Freight Details ({freightDetails.length})</h3>
              {isEditing && (
                <button onClick={handleAddFreight} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100">
                  <Plus size={16} /> Add Freight
                </button>
              )}
            </div>
            {freightDetails.length === 0 ? (
              <p className="text-sm text-slate-400 italic">
                {isEditing ? 'No freight details added. Click "Add Freight" to add.' : 'No freight details'}
              </p>
            ) : (
              <div className="overflow-x-auto ios-scroll touch-pan-x">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                      <th className="text-left px-3 py-2 font-medium text-slate-600">#</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Freight Type</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Transporter</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Freight Terms</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Quantity</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Charge</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Discount</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Payable By</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Origin</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                      {isEditing && <th className="px-3 py-2"></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {freightDetails.map((line, idx) => (
                      <tr key={line.id || `new-f-${idx}`} className="border-b">
                        <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          <CustomSelect value={line.freight_type || ''} onChange={(e) => handleFreightChange(idx, 'freight_type', e.target.value)} className={inputClass} style={{ minWidth: '140px' }}>
                            <option value="LOCAL_DRAYAGE">Local Drayage</option>
                            <option value="LINEHAUL">Linehaul</option>
                          </CustomSelect>
                        ) : (line.freight_type_display || line.freight_type || '-')}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          <CustomSelect value={line.transporter || ''} onChange={(e) => handleFreightChange(idx, 'transporter', e.target.value)} className={inputClass} style={{ minWidth: '160px' }}>
                            <option value="">Select Transporter</option>
                            {transporterOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </CustomSelect>
                        ) : (line.transporter_name || '-')}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          <CustomSelect value={line.freight_terms || ''} onChange={(e) => handleFreightChange(idx, 'freight_terms', e.target.value)} className={inputClass} style={{ minWidth: '100px' }}>
                            <option value="">Select...</option>
                            <option value="TO_PAY">To Pay</option>
                            <option value="PAID">Paid</option>
                          </CustomSelect>
                        ) : (line.freight_terms || '-')}</td>
                        <td className="px-3 py-2">
                          {isEditing ? (
                            <input type="number" step="0.01" min="0" value={line.quantity_basis || ''} onChange={(e) => handleFreightChange(idx, 'quantity_basis', e.target.value)} className={inputClass} style={{ minWidth: '90px' }} />
                          ) : (<span className="text-right block">{line.quantity_basis || '-'}</span>)}
                        </td>
                        <td className="px-3 py-2">{isEditing ? (
                          <input type="number" step="0.01" min="0" value={line.tentative_charge || ''} onChange={(e) => handleFreightChange(idx, 'tentative_charge', e.target.value)} className={inputClass} style={{ minWidth: '100px' }} />
                        ) : (<span className="text-right block">{'\u20B9'}{Number(line.tentative_charge || 0).toLocaleString()}</span>)}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          <input type="number" step="0.01" min="0" value={line.discount || ''} onChange={(e) => handleFreightChange(idx, 'discount', e.target.value)} className={inputClass} style={{ minWidth: '80px' }} />
                        ) : (<span className="text-right block">{line.discount || '0'}</span>)}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          <CustomSelect value={line.payable_by || ''} onChange={(e) => handleFreightChange(idx, 'payable_by', e.target.value)} className={inputClass} style={{ minWidth: '110px' }}>
                            <option value="COMPANY">Company</option>
                            <option value="VENDOR">Vendor</option>
                          </CustomSelect>
                        ) : (line.payable_by_display || line.payable_by || '-')}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          <input type="text" value={line.destination_state || ''} onChange={(e) => handleFreightChange(idx, 'destination_state', e.target.value)} className={inputClass} style={{ minWidth: '120px' }} />
                        ) : (line.destination_state || '-')}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          <CustomSelect value={line.quantity_uom || ''} onChange={(e) => handleFreightChange(idx, 'quantity_uom', e.target.value)} className={inputClass} style={{ minWidth: '90px' }}>
                            <option value="">Select</option>
                            {line.quantity_uom && !UOM_VALUES.includes(line.quantity_uom) && (
                              <option value={line.quantity_uom}>{line.quantity_uom}</option>
                            )}
                            {UOM_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </CustomSelect>
                        ) : (line.quantity_uom || '-')}</td>
                        {isEditing && (
                          <td className="px-3 py-2">
                            <button onClick={() => handleRemoveFreight(idx)} className="text-red-500 hover:text-red-700"><Trash2 size={16} /></button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          )}

          {/* ==================== LOADING / UNLOADING WAGES (removed by request) ==================== */}
          {false && (
          <div className="bg-white rounded-lg border p-3 sm:p-4">
            <div className="flex items-center justify-between mb-2 pb-1.5 border-b">
              <h3 className="text-sm sm:text-base font-semibold text-slate-800">Loading / Unloading Wages ({wageLines.length})</h3>
              {isEditing && (
                <button onClick={handleAddWage} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100">
                  <Plus size={16} /> Add Wage Entry
                </button>
              )}
            </div>
            {wageLines.length === 0 ? (
              <p className="text-sm text-slate-400 italic">
                {isEditing ? 'No wage entries added. Click "Add Wage Entry" to add.' : 'No wage entries'}
              </p>
            ) : (
              <div className="overflow-x-auto ios-scroll touch-pan-x">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                      <th className="text-left px-3 py-2 font-medium text-slate-600">#</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Type</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Contractor</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">Amount</th>
                      <th className="text-right px-3 py-2 font-medium text-slate-600">TDS %</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Payable By</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Unloading Date</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Remarks</th>
                      {isEditing && <th className="px-3 py-2"></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {wageLines.map((line, idx) => (
                      <tr key={line.id || `new-w-${idx}`} className="border-b">
                        <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          <CustomSelect value={line.wage_type || ''} onChange={(e) => handleWageChange(idx, 'wage_type', e.target.value)} className={inputClass} style={{ minWidth: '120px' }}>
                            <option value="LOADING">Loading</option>
                            <option value="UNLOADING">Unloading</option>
                          </CustomSelect>
                        ) : (line.wage_type_display || line.wage_type || '-')}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          <CustomSelect value={line.contractor_vendor || ''} onChange={(e) => handleWageChange(idx, 'contractor_vendor', e.target.value)} className={inputClass} style={{ minWidth: '160px' }}>
                            <option value="">Select Contractor</option>
                            {contractorVendorOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </CustomSelect>
                        ) : (line.contractor_vendor_name || '-')}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          <input type="number" step="0.01" min="0" value={line.amount || ''} onChange={(e) => handleWageChange(idx, 'amount', e.target.value)} className={inputClass} style={{ minWidth: '100px' }} />
                        ) : (<span className="text-right block">{'\u20B9'}{Number(line.amount || 0).toLocaleString()}</span>)}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          <input type="number" step="0.01" min="0" value={line.tds_applicable || ''} onChange={(e) => handleWageChange(idx, 'tds_applicable', e.target.value)} className={inputClass} style={{ minWidth: '70px' }} />
                        ) : (<span className="text-right block">{line.tds_applicable || '0'}</span>)}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          <CustomSelect value={line.payable_by || ''} onChange={(e) => handleWageChange(idx, 'payable_by', e.target.value)} className={inputClass} style={{ minWidth: '110px' }}>
                            <option value="COMPANY">Company</option>
                            <option value="VENDOR">Vendor</option>
                          </CustomSelect>
                        ) : (line.payable_by_display || line.payable_by || '-')}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          <CustomDatePicker value={line.unloading_date || ''} onChange={(e) => handleWageChange(idx, 'unloading_date', e.target.value)} className={inputClass} style={{ minWidth: '130px' }} />
                        ) : (line.unloading_date ? fmtDate(line.unloading_date) : '-')}</td>
                        <td className="px-3 py-2">{isEditing ? (
                          <input type="text" value={line.remarks || ''} onChange={(e) => handleWageChange(idx, 'remarks', e.target.value)} className={inputClass} style={{ minWidth: '120px' }} />
                        ) : (line.remarks || '-')}</td>
                        {isEditing && (
                          <td className="px-3 py-2">
                            <button onClick={() => handleRemoveWage(idx)} className="text-red-500 hover:text-red-700"><Trash2 size={16} /></button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          )}

          {/* ==================== LINKED FREIGHT ADVICES ==================== */}
          {(receipt.freight_advices || []).length > 0 && (
            <div className="bg-white rounded-lg border border-slate-200 px-3 py-2">
              <h3 style={{ fontSize: 11 }} className="font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Linked Freight Advices ({receipt.freight_advices.length})</h3>
              <div className="overflow-x-auto ios-scroll touch-pan-x">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">Advice No</th>
                      <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">Type</th>
                      <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">Transporter</th>
                      <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">Terms</th>
                      <th style={{ fontSize: 9 }} className="text-right px-2 py-1.5 font-semibold text-slate-400 uppercase">Amount</th>
                      <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">Lorry No</th>
                      <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">Origin</th>
                      <th style={{ fontSize: 9 }} className="text-left px-2 py-1.5 font-semibold text-slate-400 uppercase">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receipt.freight_advices.map((fa, idx) => (
                      <tr key={fa.id || idx} className="border-b border-slate-100 hover:bg-primary-50/40 transition-colors cursor-pointer" onClick={() => navigate(`/freight/purchase/${fa.id}`)}>
                        <td className="px-2 py-1.5 text-primary-600 font-medium">{fa.advice_no}</td>
                        <td className="px-2 py-1.5">{fa.freight_type_display || fa.freight_type || '-'}</td>
                        <td className="px-2 py-1.5">{fa.transporter_name || '-'}</td>
                        <td className="px-2 py-1.5">{fa.freight_terms_display || fa.freight_terms || '-'}</td>
                        <td className="px-2 py-1.5 text-right font-medium">{'\u20B9'}{Number(fa.payable_amount || fa.base_amount || 0).toLocaleString()}</td>
                        <td className="px-2 py-1.5">{fa.lorry_no || '-'}</td>
                        <td className="px-2 py-1.5">{fa.destination_state || '-'}</td>
                        <td className="px-2 py-1.5"><StatusBadge status={fa.status_display || fa.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Bottom Action Bar */}
          {isEditing && (
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={handleCancel} className="px-3 py-1.5 text-[12px] font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50">
                Cancel
              </button>
              <button onClick={handleSave} disabled={isSaving} className="px-3 py-1.5 text-[12px] font-medium text-white bg-primary-600 rounded hover:bg-primary-700 disabled:opacity-50">
                {isSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          )}

      {/* Actions (left) + Attachments & Activity (right, collapsible) */}
      <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-2 mt-2 items-start">
          {/* Left: Actions */}
          <div className="bg-white rounded-lg border border-slate-200 px-3 py-2">
            <h3 style={{ fontSize: 11 }} className="font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Actions</h3>
              <div className="grid grid-cols-2 gap-2">
                {!isEditing && (() => {
                  const isApproved = receipt.approval_status === 'APPROVED';
                  const lockTitle = 'Approve the receipt to enable this action';
                  return (
                    <>
                      {canEditReceipt && (
                        <button onClick={handleEdit} className="w-full flex items-center justify-center gap-1.5 px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs leading-tight bg-primary-600 text-white rounded-lg hover:bg-primary-700">
                          <Pencil size={14} /> Edit Receipt
                        </button>
                      )}
                      {Array.isArray(receipt.freight_advices) && receipt.freight_advices.length > 0 ? (
                        <button
                          onClick={() => navigate(`/freight/purchase/${receipt.freight_advices[0].id}`)}
                          title={
                            receipt.freight_advices.length === 1
                              ? `Freight advice ${receipt.freight_advices[0].advice_no} already raised — click to open`
                              : `${receipt.freight_advices.length} freight advices already linked — click to open the first`
                          }
                          className="w-full flex items-center justify-center gap-1.5 px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs leading-tight bg-orange-50 text-orange-700 border border-orange-200 rounded-lg hover:bg-orange-100"
                        >
                          <CheckCircle2 size={14} />
                          Freight Raised: {receipt.freight_advices[0].advice_no}
                          {receipt.freight_advices.length > 1 && (
                            <span className="text-xs text-orange-500">+{receipt.freight_advices.length - 1}</span>
                          )}
                        </button>
                      ) : isApproved ? (
                        canCreateReceiptFreight && (
                          <button onClick={() => navigate(`/freight/inward/new?receipt_id=${id}`)} className="w-full flex items-center justify-center gap-1.5 px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs leading-tight bg-orange-600 text-white rounded-lg hover:bg-orange-700">
                            <Truck size={14} /> Create Freight
                          </button>
                        )
                      ) : (
                        canCreateReceiptFreight && (
                          <button disabled title={lockTitle} className="w-full flex items-center justify-center gap-1.5 px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs leading-tight bg-slate-100 text-slate-400 rounded-lg cursor-not-allowed">
                            <Truck size={14} /> Create Freight
                          </button>
                        )
                      )}
                      {receipt.bill_info ? (
                        <button
                          onClick={() => navigate(`/purchase/bills/${receipt.bill_info.id}`)}
                          title={`Bill ${receipt.bill_info.bill_no} already raised — click to open`}
                          className="w-full flex items-center justify-center gap-1.5 px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs leading-tight bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-lg hover:bg-emerald-100"
                        >
                          <CheckCircle2 size={14} /> Bill Raised: {receipt.bill_info.bill_no}
                        </button>
                      ) : isApproved ? (
                        canConvertReceiptToBill && (
                          <button onClick={() => navigate(`/purchase/bills/new?receipt_id=${id}`)} className="w-full flex items-center justify-center gap-1.5 px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs leading-tight bg-emerald-600 text-white rounded-lg hover:bg-emerald-700">
                            <FileText size={14} /> Create Bill
                          </button>
                        )
                      ) : (
                        canConvertReceiptToBill && (
                          <button disabled title={lockTitle} className="w-full flex items-center justify-center gap-1.5 px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs leading-tight bg-slate-100 text-slate-400 rounded-lg cursor-not-allowed">
                            <FileText size={14} /> Create Bill
                          </button>
                        )
                      )}
                      {canReject('Receipt Advice') && (isApproved ? (
                        <button onClick={() => navigate(`/purchase/rejections/new?receipt_id=${id}`)} className="w-full flex items-center justify-center gap-1.5 px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs leading-tight bg-red-600 text-white rounded-lg hover:bg-red-700">
                          Reject Material
                        </button>
                      ) : (
                        <button disabled title={lockTitle} className="w-full flex items-center justify-center gap-1.5 px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs leading-tight bg-slate-100 text-slate-400 rounded-lg cursor-not-allowed">
                          Reject Material
                        </button>
                      ))}
                      {canDeleteReceipt && (
                        <button onClick={handleDelete} className="w-full flex items-center justify-center gap-1.5 px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs leading-tight bg-red-50 text-red-600 border border-red-200 rounded-lg hover:bg-red-100">
                          <Trash2 size={14} /> Delete Receipt
                        </button>
                      )}
                      <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/purchase/receipts'))} className="w-full px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs leading-tight bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
                        ← Back to List
                      </button>
                    </>
                  );
                })()}
              </div>
            </div>

          {/* Right: Attachments + Activity stacked, both collapsible */}
          <div className="space-y-2">
            <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
              <details className="group" open>
                <summary className="flex items-center justify-between px-3 py-2 cursor-pointer select-none hover:bg-slate-50 transition">
                  <span style={{ fontSize: 11 }} className="font-semibold text-slate-500 uppercase tracking-wider">Attachments</span>
                  <span className="text-[10px] text-blue-600 font-medium group-open:hidden">View ↓</span>
                  <span className="text-[10px] text-blue-600 font-medium hidden group-open:inline">Hide ↑</span>
                </summary>
                <div className="border-t border-slate-100">
                  <FileAttachments module="RECEIPT" recordId={id} className="mt-0" />
                </div>
              </details>
            </div>
            <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
              <details className="group" open>
                <summary className="flex items-center justify-between px-3 py-2 cursor-pointer select-none hover:bg-slate-50 transition">
                  <span style={{ fontSize: 11 }} className="font-semibold text-slate-500 uppercase tracking-wider">Activity</span>
                  <span className="text-[10px] text-blue-600 font-medium group-open:hidden">View ↓</span>
                  <span className="text-[10px] text-blue-600 font-medium hidden group-open:inline">Hide ↑</span>
                </summary>
                <div className="border-t border-slate-100">
                  <ActivityLog module="Receipt Advice" recordId={id} />
                </div>
              </details>
            </div>
          </div>
      </div>

      </div>{/* /max-w-6xl */}
    </MainLayout>
  );
}
