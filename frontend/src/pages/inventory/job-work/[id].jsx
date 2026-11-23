import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import { ArrowLeft, Save, CheckCircle, Plus, Trash2, Play, PackageCheck, X } from 'lucide-react';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const inputDisabled = 'disabled:bg-slate-100 disabled:cursor-not-allowed';
const fmtDate = (v) => v ? formatDate(v) : '-';

const emptyLine = {
  product: '',
  batch: '',
  uom: '',
  issue_qty: '',
  expected_return_qty: '',
  rate: '',
  amount: '',
  remarks: '',
};

export default function JobWorkOrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, canEdit } = usePermissions();
  const editable = canEdit('Job Work Order');
  const { isHidden } = useFieldPermissions('Job Work Order');
  const canApprove = can('Job Work Order', 'approve');

  const { options: companyOptions } = useLookup('/api/companies/');
  const { options: vendors } = useLookup('/api/vendors/');
  const { options: transporters } = useLookup('/api/transporters/');
  const { raw: productsRaw, options: productOptions } = useLookup('/api/products/');

  const [order, setOrder] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveQtys, setReceiveQtys] = useState({});   // lineId -> qty string
  const [isReceiving, setIsReceiving] = useState(false);
  const [form, setForm] = useState({
    company: '',
    vendor: '',
    warehouse: '',
    godown: '',
    job_work_date: '',
    start_date: '',
    expected_completion_date: '',
    job_work_type: '',
    reference_no: '',
    priority: 'MEDIUM',
    status: 'DRAFT',
    qc_requirement: 'REQUIRED',
    transporter: '',
    vehicle_no: '',
    lr_no: '',
    freight_charges: '',
    loading_charges: '',
    vendor_processing_charges: '',
    remarks: '',
  });
  const [lines, setLines] = useState([{ ...emptyLine }]);

  const { options: warehouses } = useLookup(
    form.company ? `/api/warehouses/?company=${form.company}&scope=true` : '/api/warehouses/?scope=true'
  );
  const { options: godownOptions } = useLookup(
    form.warehouse ? `/api/godowns/?warehouse=${form.warehouse}` : null
  );

  const isEditable = order?.status === 'DRAFT';

  // Map a fetched order onto local state — reused by the initial load and
  // after Start / Receive actions so the page reflects the new status + the
  // updated per-line received quantities without a full reload.
  const hydrate = (d) => {
    setOrder(d);
    setForm({
      company: d.company || '',
      vendor: d.vendor || '',
      warehouse: d.warehouse || '',
      godown: d.godown || '',
      job_work_date: d.job_work_date || '',
      start_date: d.start_date || '',
      expected_completion_date: d.expected_completion_date || '',
      job_work_type: d.job_work_type || '',
      reference_no: d.reference_no || '',
      priority: d.priority || 'MEDIUM',
      status: d.status || 'DRAFT',
      qc_requirement: d.qc_requirement || 'REQUIRED',
      transporter: d.transporter || '',
      vehicle_no: d.vehicle_no || '',
      lr_no: d.lr_no || '',
      freight_charges: d.freight_charges || '',
      loading_charges: d.loading_charges || '',
      vendor_processing_charges: d.vendor_processing_charges || '',
      remarks: d.remarks || '',
    });
    const mats = d.materials_supplied || [];
    setLines(mats.length > 0 ? mats.map(m => ({
      id: m.id,
      product: m.product_machine_id || '',
      batch: m.batch || '',
      uom: m.uom || '',
      issue_qty: m.quantity || '',
      expected_return_qty: m.expected_return_qty || '',
      received_qty: m.received_qty || 0,
      rate: m.rate || '',
      amount: m.amount || '',
      remarks: m.remarks || '',
    })) : [{ ...emptyLine }]);
  };

  useEffect(() => {
    apiClient.get(`/api/inventory/job-work/${id}/`)
      .then(res => hydrate(res.data))
      .catch((err) => { if (err.response?.status !== 404) toast.error(getApiErrorMessage(err)); })
      .finally(() => setIsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm(prev => ({ ...prev, [name]: value }));
  };

  const updateLine = (idx, field, value) => {
    setLines(prev => prev.map((l, i) => {
      if (i !== idx) return l;
      const next = { ...l, [field]: value };
      if (field === 'issue_qty' || field === 'rate') {
        const qty = parseFloat(field === 'issue_qty' ? value : next.issue_qty) || 0;
        const rate = parseFloat(field === 'rate' ? value : next.rate) || 0;
        const amt = qty * rate;
        next.amount = amt ? amt.toFixed(2) : '';
      }
      return next;
    }));
  };

  const onProductChange = (idx, productId) => {
    const product = productsRaw.find(p => String(p.id) === String(productId));
    setLines(prev => prev.map((l, i) => i === idx ? {
      ...l,
      product: productId,
      uom: product?.uom || l.uom || '',
    } : l));
  };

  const addLine = () => setLines(prev => [...prev, { ...emptyLine }]);
  const removeLine = (idx) => setLines(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);

  const totalLinesAmount = useMemo(() => lines.reduce((sum, l) => sum + (parseFloat(l.amount || 0) || 0), 0), [lines]);
  const totalCost = useMemo(() => (
    totalLinesAmount
    + (parseFloat(form.freight_charges || 0) || 0)
    + (parseFloat(form.loading_charges || 0) || 0)
    + (parseFloat(form.vendor_processing_charges || 0) || 0)
  ), [totalLinesAmount, form.freight_charges, form.loading_charges, form.vendor_processing_charges]);

  const handleSave = async (e) => {
    e.preventDefault();
    const payloadLines = lines
      .filter(l => l.product && parseFloat(l.issue_qty || 0) > 0)
      .map(l => ({
        product: l.product,
        batch: l.batch || '',
        uom: l.uom || '',
        issue_qty: l.issue_qty || 0,
        expected_return_qty: l.expected_return_qty || 0,
        rate: l.rate || 0,
        amount: l.amount || 0,
        remarks: l.remarks || '',
      }));
    setIsSaving(true);
    try {
      const res = await apiClient.patch(`/api/inventory/job-work/${id}/`, {
        ...cleanFormData(form),
        lines: payloadLines,
      });
      setOrder(res.data);
      toast.success('Job Work updated');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  const handleApprove = async () => {
    if (!(await confirm({ message: `Approve ${order.order_no || 'this Job Work'}? Stock will be deducted from each line's godown and the order will move from DRAFT to ISSUED.`, isDangerous: true }))) return;
    setIsApproving(true);
    try {
      const res = await apiClient.post(`/api/inventory/job-work/${id}/approve/`);
      hydrate(res.data);
      toast.success(`${order.order_no || 'Job Work'} approved — stock deducted from the ledger.`);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsApproving(false);
    }
  };

  // ── Start work: ISSUED → IN_PROGRESS (no stock impact) ──────────────────
  const handleStart = async () => {
    setIsStarting(true);
    try {
      const res = await apiClient.post(`/api/inventory/job-work/${id}/start/`);
      hydrate(res.data);
      toast.success('Marked as In Progress.');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsStarting(false);
    }
  };

  // Target qty to receive back for a line: expected return, else the issued qty.
  const lineTarget = (l) => {
    const exp = parseFloat(l.expected_return_qty || 0);
    return exp > 0 ? exp : parseFloat(l.issue_qty || 0);
  };
  const lineRemaining = (l) => Math.max(0, lineTarget(l) - parseFloat(l.received_qty || 0));

  // ── Receive Return: open the modal defaulted to each line's remaining ───
  const openReceive = () => {
    const init = {};
    lines.forEach((l) => { init[l.id] = String(lineRemaining(l) || ''); });
    setReceiveQtys(init);
    setReceiveOpen(true);
  };

  const submitReceive = async () => {
    const payloadLines = lines
      .map((l) => ({ line_id: l.id, received_qty: parseFloat(receiveQtys[l.id] || 0) }))
      .filter((x) => x.received_qty > 0);
    if (payloadLines.length === 0) { toast.error('Enter a received quantity on at least one line.'); return; }
    setIsReceiving(true);
    try {
      const res = await apiClient.post(`/api/inventory/job-work/${id}/receive/`, { lines: payloadLines });
      hydrate(res.data);
      setReceiveOpen(false);
      toast.success(res.data.status === 'COMPLETED'
        ? 'All materials received — order Completed. Stock returned to the ledger.'
        : 'Return recorded — order Partially Received. Stock returned to the ledger.');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsReceiving(false);
    }
  };

  if (isLoading) {
    return (
      <MainLayout>
        <div className="flex justify-center py-20">
          <div className="animate-spin h-8 w-8 border-4 border-primary-500 border-t-transparent rounded-full" />
        </div>
      </MainLayout>
    );
  }
  if (!order) {
    return (
      <MainLayout>
        <div className="text-center py-20">
          <p className="text-red-500 mb-3">Job Work Order not found.</p>
          <button onClick={() => navigate('/inventory/job-work')} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
            <ArrowLeft size={15} /> Back to Job Work Orders
          </button>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="text-sm text-slate-500 mb-3">
        <button onClick={() => navigate('/inventory/job-work')} className="hover:text-slate-700">Inventory</button>
        <span className="mx-2">/</span>
        <button onClick={() => navigate('/inventory/job-work')} className="hover:text-slate-700">Job Work Orders</button>
        <span className="mx-2">/</span>
        <span className="text-slate-700 font-medium">{order.order_no}</span>
      </div>

      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/inventory/job-work'))} aria-label="Back" title="Back" className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg transition">
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-2xl font-bold text-slate-900">{order.order_no}</h1>
          <StatusBadge status={order.status} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isEditable && canApprove && (
            <button
              onClick={handleApprove}
              disabled={isApproving}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition text-sm font-semibold disabled:opacity-50"
            >
              <CheckCircle size={16} /> {isApproving ? 'Approving...' : 'Approve & Issue'}
            </button>
          )}
          {order.status === 'ISSUED' && canApprove && (
            <button
              onClick={handleStart}
              disabled={isStarting}
              className="flex items-center gap-2 px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition text-sm font-semibold disabled:opacity-50"
            >
              <Play size={16} /> {isStarting ? 'Starting…' : 'Start Work'}
            </button>
          )}
          {['ISSUED', 'IN_PROGRESS', 'PARTIALLY_RECEIVED'].includes(order.status) && canApprove && (
            <button
              onClick={openReceive}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm font-semibold"
            >
              <PackageCheck size={16} /> Receive Return
            </button>
          )}
        </div>
      </div>

      <form onSubmit={handleSave} className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
        {!isEditable && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
            Read-only — only DRAFT job work orders can be edited (current status: {order.status}).
          </p>
        )}

        {/* Header */}
        <div>
          <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Job Work Details</h3>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Job Work No</label>
              <input type="text" value={order.order_no || ''} readOnly className={`${inputClass} bg-slate-50 text-slate-500`} />
            </div>
            {!isHidden('company') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Company</label>
              <CustomSelect name="company" value={form.company} onChange={(e) => setForm(prev => ({ ...prev, company: e.target.value, warehouse: '' }))} disabled={!isEditable} className={`${inputClass} ${inputDisabled}`}>
                <option value="">Select Company</option>
                {companyOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </CustomSelect>
            </div>
            )}
            {!isHidden('vendor') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Vendor <span className="text-red-500">*</span></label>
              <CustomSelect name="vendor" value={form.vendor} onChange={handleChange} required disabled={!isEditable} className={`${inputClass} ${inputDisabled}`}>
                <option value="">Select Vendor</option>
                {vendors.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
              </CustomSelect>
            </div>
            )}
            {!isHidden('warehouse') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse <span className="text-red-500">*</span></label>
              <CustomSelect name="warehouse" value={form.warehouse} onChange={handleChange} required disabled={!isEditable} className={`${inputClass} ${inputDisabled}`}>
                <option value="">Select Warehouse</option>
                {warehouses.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
              </CustomSelect>
            </div>
            )}
            {!isHidden('job_work_date') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Job Work Date</label>
              <CustomDatePicker name="job_work_date" value={form.job_work_date || ''} onChange={handleChange} disabled={!isEditable} className={`${inputClass} ${inputDisabled}`} />
            </div>
            )}
            {!isHidden('start_date') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Issue Date <span className="text-red-500">*</span></label>
              <CustomDatePicker name="start_date" value={form.start_date || ''} onChange={handleChange} required disabled={!isEditable} className={`${inputClass} ${inputDisabled}`} />
            </div>
            )}
            {!isHidden('expected_completion_date') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Expected Completion Date</label>
              <CustomDatePicker name="expected_completion_date" value={form.expected_completion_date || ''} onChange={handleChange} disabled={!isEditable} className={`${inputClass} ${inputDisabled}`} />
            </div>
            )}
            {!isHidden('job_work_type') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Job Work Type</label>
              <CustomSelect name="job_work_type" value={form.job_work_type} onChange={handleChange} disabled={!isEditable} className={`${inputClass} ${inputDisabled}`}>
                <option value="">Select Type</option>
                <option value="PROCESSING">Processing</option>
                <option value="BLENDING">Blending</option>
                <option value="GRINDING">Grinding</option>
                <option value="PACKING">Packing</option>
                <option value="REPACKING">Repacking</option>
                <option value="MANUFACTURING">Manufacturing</option>
                <option value="CUSTOM">Custom</option>
              </CustomSelect>
            </div>
            )}
            {!isHidden('reference_no') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Reference No</label>
              <input type="text" name="reference_no" value={form.reference_no} onChange={handleChange} disabled={!isEditable} className={`${inputClass} ${inputDisabled}`} />
            </div>
            )}
            {!isHidden('priority') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Priority</label>
              <CustomSelect name="priority" value={form.priority} onChange={handleChange} disabled={!isEditable} className={`${inputClass} ${inputDisabled}`}>
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
              </CustomSelect>
            </div>
            )}
            {!isHidden('status') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
              <CustomSelect name="status" value={form.status} onChange={handleChange} disabled={!isEditable} className={`${inputClass} ${inputDisabled}`}>
                <option value="DRAFT">Draft</option>
                <option value="ISSUED">Issued</option>
                <option value="IN_PROGRESS">In Progress</option>
                <option value="PARTIALLY_RECEIVED">Partially Received</option>
                <option value="COMPLETED">Completed</option>
                <option value="CANCELLED">Cancelled</option>
              </CustomSelect>
            </div>
            )}
            {!isHidden('qc_requirement') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">QC Requirement</label>
              <CustomSelect name="qc_requirement" value={form.qc_requirement} onChange={handleChange} disabled={!isEditable} className={`${inputClass} ${inputDisabled}`}>
                <option value="REQUIRED">Required</option>
                <option value="OPTIONAL">Optional</option>
                <option value="NOT_REQUIRED">Not Required</option>
              </CustomSelect>
            </div>
            )}
          </div>
        </div>

        {/* Logistics */}
        <div>
          <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Logistics</h3>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            {!isHidden('transporter') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Transporter</label>
              <CustomSelect name="transporter" value={form.transporter} onChange={handleChange} disabled={!isEditable} className={`${inputClass} ${inputDisabled}`}>
                <option value="">Select Transporter</option>
                {transporters.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </CustomSelect>
            </div>
            )}
            {!isHidden('vehicle_no') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Vehicle No</label>
              <input type="text" name="vehicle_no" value={form.vehicle_no} onChange={handleChange} disabled={!isEditable} className={`${inputClass} ${inputDisabled}`} />
            </div>
            )}
            {!isHidden('lr_no') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">LR No</label>
              <input type="text" name="lr_no" value={form.lr_no} onChange={handleChange} disabled={!isEditable} className={`${inputClass} ${inputDisabled}`} />
            </div>
            )}
          </div>
        </div>

        {/* Line items */}
        <div>
          <div className="flex items-center justify-between mb-4 pb-2 border-b">
            <h3 className="text-lg font-semibold text-slate-800">Line Items</h3>
            {isEditable && (
              <button type="button" onClick={addLine} className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-50 text-primary-700 rounded-lg text-sm font-medium hover:bg-primary-100">
                <Plus size={16} /> Add Line
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b">
                  <th className="text-left px-3 py-2 font-medium text-slate-600">#</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-600">Product <span className="text-red-500">*</span></th>
                  <th className="text-left px-3 py-2 font-medium text-slate-600">Batch No</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                  <th className="text-right px-3 py-2 font-medium text-slate-600">Issue Qty <span className="text-red-500">*</span></th>
                  <th className="text-right px-3 py-2 font-medium text-slate-600">Exp. Return Qty</th>
                  {!isEditable && <th className="text-right px-3 py-2 font-medium text-slate-600">Received</th>}
                  {!isEditable && <th className="text-right px-3 py-2 font-medium text-slate-600">Remaining</th>}
                  <th className="text-right px-3 py-2 font-medium text-slate-600">Rate</th>
                  <th className="text-right px-3 py-2 font-medium text-slate-600">Amount</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-600">Remarks</th>
                  {isEditable && <th className="px-3 py-2"></th>}
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => (
                  <tr key={idx} className="border-b">
                    <td className="px-3 py-2 text-slate-500">{idx + 1}</td>
                    <td className="px-3 py-2">
                      <CustomSelect value={line.product} onChange={(e) => onProductChange(idx, e.target.value)} required disabled={!isEditable} className={`${inputClass} ${inputDisabled}`} style={{ minWidth: '180px' }}>
                        <option value="">Select Product</option>
                        {productOptions.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                      </CustomSelect>
                    </td>
                    <td className="px-3 py-2"><input type="text" value={line.batch} onChange={(e) => updateLine(idx, 'batch', e.target.value)} disabled={!isEditable} className={`${inputClass} ${inputDisabled}`} style={{ minWidth: '120px' }} /></td>
                    <td className="px-3 py-2"><input type="text" value={line.uom} onChange={(e) => updateLine(idx, 'uom', e.target.value)} disabled={!isEditable} className={`${inputClass} ${inputDisabled}`} style={{ minWidth: '70px' }} /></td>
                    <td className="px-3 py-2"><input type="number" step="0.0001" min="0" value={line.issue_qty} onChange={(e) => updateLine(idx, 'issue_qty', e.target.value)} required disabled={!isEditable} className={`${inputClass} ${inputDisabled} text-right`} style={{ minWidth: '100px' }} /></td>
                    <td className="px-3 py-2"><input type="number" step="0.0001" min="0" value={line.expected_return_qty} onChange={(e) => updateLine(idx, 'expected_return_qty', e.target.value)} disabled={!isEditable} className={`${inputClass} ${inputDisabled} text-right`} style={{ minWidth: '100px' }} /></td>
                    {!isEditable && <td className="px-3 py-2 text-right text-emerald-700 font-medium tabular-nums whitespace-nowrap">{Number(line.received_qty || 0).toLocaleString()}</td>}
                    {!isEditable && <td className="px-3 py-2 text-right font-medium tabular-nums whitespace-nowrap">{Number(lineRemaining(line)).toLocaleString()}</td>}
                    <td className="px-3 py-2"><input type="number" step="0.01" min="0" value={line.rate} onChange={(e) => updateLine(idx, 'rate', e.target.value)} disabled={!isEditable} className={`${inputClass} ${inputDisabled} text-right`} style={{ minWidth: '90px' }} /></td>
                    <td className="px-3 py-2 text-right text-slate-700 font-medium" style={{ minWidth: '100px' }}>{line.amount || '—'}</td>
                    <td className="px-3 py-2"><input type="text" value={line.remarks} onChange={(e) => updateLine(idx, 'remarks', e.target.value)} disabled={!isEditable} className={`${inputClass} ${inputDisabled}`} style={{ minWidth: '140px' }} /></td>
                    {isEditable && (
                      <td className="px-3 py-2">
                        <button type="button" onClick={() => removeLine(idx)} disabled={lines.length <= 1} aria-label="Remove line" title="Remove line" className="text-red-500 hover:text-red-700 disabled:opacity-30">
                          <Trash2 size={16} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Costs */}
        <div>
          <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Costs</h3>
          <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {!isHidden('freight_charges') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Freight Charges</label>
              <input type="number" step="0.01" min="0" name="freight_charges" value={form.freight_charges} onChange={handleChange} disabled={!isEditable} className={`${inputClass} ${inputDisabled}`} />
            </div>
            )}
            {!isHidden('loading_charges') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Loading Charges</label>
              <input type="number" step="0.01" min="0" name="loading_charges" value={form.loading_charges} onChange={handleChange} disabled={!isEditable} className={`${inputClass} ${inputDisabled}`} />
            </div>
            )}
            {!isHidden('vendor_processing_charges') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Vendor Processing Charges</label>
              <input type="number" step="0.01" min="0" name="vendor_processing_charges" value={form.vendor_processing_charges} onChange={handleChange} disabled={!isEditable} className={`${inputClass} ${inputDisabled}`} />
            </div>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Total Cost</label>
              <input type="text" value={totalCost ? totalCost.toFixed(2) : '0.00'} readOnly className={`${inputClass} bg-slate-50 font-semibold text-slate-800`} />
            </div>
          </div>
        </div>

        {/* Notes */}
        {!isHidden('remarks') && (
        <div>
          <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Notes</h3>
          <textarea name="remarks" value={form.remarks} onChange={handleChange} rows={3} disabled={!isEditable} className={`${inputClass} ${inputDisabled}`} />
        </div>
        )}

        <div className="flex justify-between items-center pt-4 border-t">
          <div className="text-xs text-slate-500">
            Created {fmtDate(order.created_at)} · Last updated {fmtDate(order.updated_at)}
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={() => navigate('/inventory/job-work')} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Back</button>
            {isEditable && (
              <button type="submit" disabled={isSaving} className="flex items-center gap-2 px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">
                <Save size={16} /> {isSaving ? 'Saving...' : 'Save Changes'}
              </button>
            )}
          </div>
        </div>
        </EditGate>
      </form>

      {receiveOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40" onClick={() => !isReceiving && setReceiveOpen(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85dvh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3.5 border-b">
              <h3 className="text-base font-semibold text-slate-800">Receive Return — {order.order_no}</h3>
              <button onClick={() => setReceiveOpen(false)} className="p-1 text-slate-400 hover:text-slate-600"><X size={18} /></button>
            </div>
            <div className="px-5 py-4 overflow-y-auto">
              <p className="text-xs text-slate-500 mb-3">
                Enter how much came back from the vendor for each line. Stock is added back to its godown; the order completes once every line is fully received.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b text-left text-slate-600">
                      <th className="px-3 py-2 font-medium">Product</th>
                      <th className="px-3 py-2 font-medium text-right">Expected</th>
                      <th className="px-3 py-2 font-medium text-right">Received</th>
                      <th className="px-3 py-2 font-medium text-right">Remaining</th>
                      <th className="px-3 py-2 font-medium text-right">Receive now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => {
                      const remaining = lineRemaining(l);
                      const name = (productOptions.find(p => String(p.value) === String(l.product)) || {}).label || l.product;
                      return (
                        <tr key={l.id} className="border-b">
                          <td className="px-3 py-2 text-slate-800">{name}</td>
                          <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{Number(lineTarget(l)).toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-emerald-700 whitespace-nowrap">{Number(l.received_qty || 0).toLocaleString()}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium whitespace-nowrap">{Number(remaining).toLocaleString()}</td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="number" min="0" step="any"
                              value={receiveQtys[l.id] ?? ''}
                              onChange={(e) => setReceiveQtys(prev => ({ ...prev, [l.id]: e.target.value }))}
                              className="w-24 text-right border-2 border-blue-500 rounded-lg px-2 py-1 text-sm tabular-nums font-semibold"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t">
              <button onClick={() => setReceiveOpen(false)} className="px-4 py-2 text-sm border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50">Cancel</button>
              <button onClick={submitReceive} disabled={isReceiving} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5">
                <PackageCheck size={15} /> {isReceiving ? 'Receiving…' : 'Confirm Receipt'}
              </button>
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  );
}
