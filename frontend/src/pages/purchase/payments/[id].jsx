import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useLookup from '../../../hooks/useLookup.js';
import FileAttachments from '../components/FileAttachments';
import { ArrowLeft } from 'lucide-react';
import { formatDate as fmtDate } from '@/utils/formatters';
import { getApiErrorMessage } from '@/utils/formHelpers';

export default function VendorPaymentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canApprove, canCreate, canEdit } = usePermissions();
  // Lookups for edit-mode receipt advice dropdown (parity with Create page)
  const { raw: receiptRaw } = useLookup('/api/purchase/receipts/');
  const [payment, setPayment] = useState(null);
  const [receiptData, setReceiptData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isApproving, setIsApproving] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentForm, setPaymentForm] = useState({
    amount_paid: '',
    payment_mode: '',
    payment_reference: '',
    payment_date: '',
    bank_name: '',
    transaction_id: '',
  });
  const [isRecording, setIsRecording] = useState(false);
  // Edit-mode state — full field-level parity with Create page
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState({});
  const [isSaving, setIsSaving] = useState(false);

  const handleEditToggle = () => {
    setEditData({ ...payment });
    setIsEditing(true);
  };
  const handleEditCancel = () => {
    setEditData({ ...payment });
    setIsEditing(false);
  };
  const handleEditChange = (e) => {
    const { name, value } = e.target;
    setEditData(prev => ({ ...prev, [name]: value }));
  };
  const handleEditSave = async () => {
    setIsSaving(true);
    try {
      const payload = {
        receipt_advice: editData.receipt_advice || null,
        invoice_no: editData.invoice_no || '',
        invoice_date: editData.invoice_date || null,
        due_date: editData.due_date || null,
        status: editData.status || payment.status,
        payment_method: editData.payment_method || '',
        amount: editData.amount,
        tds_amount: editData.tds_amount || '0',
        other_deductions: editData.other_deductions || '0',
        paid_amount: editData.paid_amount || '0',
        payment_reference: editData.payment_reference || '',
        payment_date: editData.payment_date || null,
        bank_name: editData.bank_name || '',
        transaction_id: editData.transaction_id || '',
        notes: editData.notes || '',
      };
      const res = await apiClient.patch(`/api/purchase/payments/${id}/`, payload);
      setPayment(res.data);
      setIsEditing(false);
      toast.success('Payment advice updated');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  const receiptOptions = receiptRaw.map(r => ({
    value: r.id,
    label: `${r.receipt_advice_no} — ${r.vendor_name || ''} (${r.warehouse_name || ''})`,
  }));

  const fetchPayment = () => {
    apiClient.get(`/api/purchase/payments/${id}/`)
      .then(res => {
        setPayment(res.data);
        setEditData(res.data);
        // Fetch linked receipt data for line items
        if (res.data.receipt_advice) {
          apiClient.get(`/api/purchase/receipts/${res.data.receipt_advice}/`)
            .then(rRes => setReceiptData(rRes.data))
            .catch(() => setReceiptData(null));
        }
      })
      .catch((err) => { if (err.response?.status !== 404) toast.error(getApiErrorMessage(err)); })
      .finally(() => setIsLoading(false));
  };

  useEffect(() => { fetchPayment(); }, [id]);

  const handleApprove = async () => {
    setIsApproving(true);
    try {
      const res = await apiClient.post(`/api/purchase/payments/${id}/approve/`);
      setPayment(res.data);
      toast.success('Payment advice approved!');
    } catch (error) {
      const msg = error.response?.data?.error || 'Failed to approve';
      toast.error(msg);
    } finally {
      setIsApproving(false);
    }
  };

  const handleRecordPayment = async (e) => {
    e.preventDefault();
    // UTR / payment reference is mandatory — a payment can't be marked paid
    // without proof of the bank transaction.
    if (!(paymentForm.payment_reference || '').trim()) {
      toast.error('UTR / Payment Reference is required to record a payment.');
      return;
    }
    setIsRecording(true);
    try {
      const res = await apiClient.post(`/api/purchase/payments/${id}/record-payment/`, paymentForm);
      setPayment(res.data);
      setShowPaymentModal(false);
      setPaymentForm({ amount_paid: '', payment_mode: '', payment_reference: '', payment_date: '', bank_name: '', transaction_id: '' });
      toast.success('Payment recorded successfully!');
    } catch (error) {
      const msg = error.response?.data?.error || 'Failed to record payment';
      toast.error(msg);
    } finally {
      setIsRecording(false);
    }
  };

  if (isLoading) return <MainLayout><div className="flex justify-center py-20"><div className="animate-spin h-8 w-8 border-4 border-primary-500 border-t-transparent rounded-full" /></div></MainLayout>;
  if (!payment) return (
    <MainLayout>
      <div className="text-center py-20">
        <p className="text-red-500 mb-3">Payment advice not found.</p>
        <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/purchase/payments'))} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
          <ArrowLeft size={15} /> Back to Payment Advices
        </button>
      </div>
    </MainLayout>
  );

  const formatDate = (d) => d ? fmtDate(d) : '-';
  const formatCurrency = (v) => v != null ? `\u20B9${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '\u20B90.00';

  const netPayable = Number(payment.net_payable_amount) || 0;
  const balance = Number(payment.balance_amount) || 0;
  const inputClass = "w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500";
  const isDraft = payment.status === 'DRAFT';

  // Compute live edit values for the amount breakdown (parity with Create)
  const editTotalAmount = parseFloat(editData.amount) || 0;
  const editTdsAmount = parseFloat(editData.tds_amount) || 0;
  const editOtherDeductions = parseFloat(editData.other_deductions) || 0;
  const editNetPayable = editTotalAmount - editTdsAmount - editOtherDeductions;
  const editAmountPaid = parseFloat(editData.paid_amount) || 0;
  const editBalance = editNetPayable - editAmountPaid;

  return (
    <MainLayout>
      <PageHeader
        title={payment.advice_no || 'Payment Advice'}
        subtitle={`Created on ${formatDate(payment.created_at)}`}
        breadcrumbs={[
          { label: 'Payments', href: '/purchase/payments' },
          { label: payment.advice_no },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-4 sm:space-y-6">
          {/* Bill Details */}
          <div className="bg-white rounded-lg border p-4 sm:p-6">
            <div className="flex items-center justify-between mb-3 sm:mb-4 pb-2 border-b">
              <h3 className="text-base sm:text-lg font-semibold text-slate-800">Bill Details</h3>
              <div className="flex gap-2">
                {!isEditing && canEdit && canEdit('Payment Made') && isDraft && (
                  <button onClick={handleEditToggle} className="px-4 py-2 text-sm bg-white border border-slate-300 rounded-lg hover:bg-slate-50">Edit</button>
                )}
                {isEditing && (
                  <>
                    <button onClick={handleEditCancel} className="px-4 py-2 text-sm bg-white border border-slate-300 rounded-lg hover:bg-slate-50">Cancel</button>
                    <button onClick={handleEditSave} disabled={isSaving} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50">
                      {isSaving ? 'Saving...' : 'Save'}
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <p className="text-xs text-slate-500 uppercase">Bill / Payment No</p>
                <p className="font-medium">{payment.advice_no}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500 uppercase">Vendor</p>
                <p className="font-medium">{payment.vendor_name || '-'}</p>
              </div>
              <div>
                <p className="text-xs text-slate-500 uppercase">Receipt Advice {isEditing && <span className="text-red-500">*</span>}</p>
                {isEditing ? (
                  <CustomSelect name="receipt_advice" value={editData.receipt_advice || ''} onChange={handleEditChange} className={inputClass}>
                    <option value="">Select Receipt Advice</option>
                    {receiptOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                ) : payment.receipt_advice_no ? (
                  <p className="font-medium text-primary-600 cursor-pointer" onClick={() => navigate(`/purchase/receipts/${payment.receipt_advice}`)}>
                    {payment.receipt_advice_no}
                  </p>
                ) : (<p className="font-medium">-</p>)}
              </div>
              <div>
                <p className="text-xs text-slate-500 uppercase">Bill / Invoice No</p>
                {isEditing ? (
                  <input type="text" name="invoice_no" value={editData.invoice_no || ''} onChange={handleEditChange} className={inputClass} placeholder="Vendor invoice number" />
                ) : (
                  <p className="font-medium">{payment.invoice_no || '-'}</p>
                )}
              </div>
              <div>
                <p className="text-xs text-slate-500 uppercase">Invoice Date</p>
                {isEditing ? (
                  <CustomDatePicker name="invoice_date" value={editData.invoice_date || ''} onChange={handleEditChange} className={inputClass} />
                ) : (
                  <p className="font-medium">{formatDate(payment.invoice_date)}</p>
                )}
              </div>
              <div>
                <p className="text-xs text-slate-500 uppercase">Due Date</p>
                {isEditing ? (
                  <CustomDatePicker name="due_date" value={editData.due_date || ''} onChange={handleEditChange} className={inputClass} />
                ) : (
                  <p className="font-medium">{formatDate(payment.due_date)}</p>
                )}
              </div>
              <div>
                <p className="text-xs text-slate-500 uppercase">Status</p>
                {isEditing ? (
                  <CustomSelect name="status" value={editData.status || ''} onChange={handleEditChange} className={inputClass}>
                    <option value="DRAFT">Draft</option>
                  </CustomSelect>
                ) : (
                  <StatusBadge status={payment.status_display || payment.status} />
                )}
              </div>
              <div>
                <p className="text-xs text-slate-500 uppercase">Payment Mode</p>
                {isEditing ? (
                  <CustomSelect name="payment_method" value={editData.payment_method || ''} onChange={handleEditChange} className={inputClass}>
                    <option value="">Select Payment Mode</option>
                    <option value="BANK_TRANSFER">Bank Transfer</option>
                    <option value="CASH">Cash</option>
                    <option value="CHEQUE">Cheque</option>
                    <option value="UPI">UPI</option>
                    <option value="NEFT">NEFT</option>
                    <option value="RTGS">RTGS</option>
                  </CustomSelect>
                ) : (
                  <p className="font-medium">{payment.payment_method_display || payment.payment_method || '-'}</p>
                )}
              </div>
              {payment.po_numbers && payment.po_numbers.length > 0 && (
                <div>
                  <p className="text-xs text-slate-500 uppercase">Linked PO Numbers</p>
                  <p className="font-medium text-primary-600">{payment.po_numbers.join(', ')}</p>
                </div>
              )}
            </div>
          </div>

          {/* Amount Breakdown */}
          <div className="bg-white rounded-lg border p-4 sm:p-6">
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Amount Details</h3>
            {isEditing ? (
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1 uppercase">Total Invoice Amount <span className="text-red-500">*</span></label>
                  <input type="number" step="0.01" name="amount" value={editData.amount || ''} onChange={handleEditChange} required className={inputClass} placeholder="0.00" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1 uppercase">TDS Amount</label>
                  <input type="number" step="0.01" name="tds_amount" value={editData.tds_amount || ''} onChange={handleEditChange} className={inputClass} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1 uppercase">Other Deductions</label>
                  <input type="number" step="0.01" name="other_deductions" value={editData.other_deductions || ''} onChange={handleEditChange} className={inputClass} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1 uppercase">Net Payable Amount</label>
                  <input type="text" readOnly value={formatCurrency(editNetPayable)} className={`${inputClass} bg-slate-50 cursor-not-allowed`} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1 uppercase">Amount Paid</label>
                  <input type="number" step="0.01" name="paid_amount" value={editData.paid_amount || ''} onChange={handleEditChange} className={inputClass} />
                </div>
                <div className="flex items-end">
                  <div className="w-full p-4 bg-primary-50 rounded-lg border-2 border-primary-200">
                    <span className="text-xs text-primary-600 uppercase block font-semibold">Balance Amount</span>
                    <span className={`text-xl font-bold ${editBalance > 0 ? 'text-red-700' : 'text-green-700'}`}>
                      {'₹'}{editBalance.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">Total Invoice Amount</span>
                  <span className="font-medium">{formatCurrency(payment.amount)}</span>
                </div>
                {Number(payment.tds_amount) > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">TDS Deduction</span>
                    <span className="font-medium text-red-600">-{formatCurrency(payment.tds_amount)}</span>
                  </div>
                )}
                {Number(payment.other_deductions) > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-slate-600">Other Deductions</span>
                    <span className="font-medium text-red-600">-{formatCurrency(payment.other_deductions)}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm border-t pt-3">
                  <span className="font-semibold text-slate-800">Net Payable</span>
                  <span className="font-bold text-lg text-slate-800">{formatCurrency(netPayable)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">Amount Paid</span>
                  <span className="font-medium text-green-600">{formatCurrency(payment.paid_amount)}</span>
                </div>
                <div className="flex justify-between text-sm border-t pt-3">
                  <span className="font-semibold text-slate-800">Balance Due</span>
                  <span className={`font-bold text-lg ${balance > 0 ? 'text-red-700' : 'text-green-700'}`}>
                    {formatCurrency(balance)}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Product Line Items from Receipt */}
          {receiptData && (receiptData.receipt_lines || []).length > 0 && (
            <div className="bg-white rounded-lg border p-4 sm:p-6">
              <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Product Line Items (from Receipt)</h3>
              <div className="overflow-x-auto ios-scroll">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b">
                      <th className="text-left px-3 py-2 font-medium text-slate-600">#</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Product</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">Qty Received</th>
                      <th className="text-left px-3 py-2 font-medium text-slate-600">UOM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receiptData.receipt_lines.map((line, idx) => (
                      <tr key={line.id || idx} className="border-b">
                        <td className="px-3 py-2 text-slate-500">{line.line_no || idx + 1}</td>
                        <td className="px-3 py-2 font-medium">{line.product_name || '-'}</td>
                        <td className="px-3 py-2">{line.quantity_received}</td>
                        <td className="px-3 py-2">{line.uom || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-50 font-semibold">
                      <td colSpan="2" className="px-3 py-2 text-right">Total Qty:</td>
                      <td className="px-3 py-2">{receiptData.receipt_lines.reduce((sum, l) => sum + (parseFloat(l.quantity_received) || 0), 0)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {/* Payment Information */}
          {(isEditing || payment.payment_reference || payment.bank_name || payment.transaction_id || payment.payment_date) && (
            <div className="bg-white rounded-lg border p-4 sm:p-6">
              <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Payment Information</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-slate-500 uppercase">Payment Reference No</p>
                  {isEditing ? (
                    <input type="text" name="payment_reference" value={editData.payment_reference || ''} onChange={handleEditChange} className={inputClass} placeholder="UTR / Reference number" />
                  ) : (
                    <p className="font-medium">{payment.payment_reference || '-'}</p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-slate-500 uppercase">Payment Date</p>
                  {isEditing ? (
                    <CustomDatePicker name="payment_date" value={editData.payment_date || ''} onChange={handleEditChange} className={inputClass} />
                  ) : (
                    <p className="font-medium">{formatDate(payment.payment_date)}</p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-slate-500 uppercase">Bank Name</p>
                  {isEditing ? (
                    <input type="text" name="bank_name" value={editData.bank_name || ''} onChange={handleEditChange} className={inputClass} placeholder="Bank name" />
                  ) : (
                    <p className="font-medium">{payment.bank_name || '-'}</p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-slate-500 uppercase">Transaction ID</p>
                  {isEditing ? (
                    <input type="text" name="transaction_id" value={editData.transaction_id || ''} onChange={handleEditChange} className={inputClass} placeholder="Transaction ID" />
                  ) : (
                    <p className="font-medium">{payment.transaction_id || '-'}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Remarks */}
          {(isEditing || payment.notes) && (
            <div className="bg-white rounded-lg border p-4 sm:p-6">
              <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Remarks</h3>
              {isEditing ? (
                <textarea name="notes" value={editData.notes || ''} onChange={handleEditChange} rows={3} className={inputClass} placeholder="Additional notes..." />
              ) : (
                <p className="text-sm text-slate-700">{payment.notes}</p>
              )}
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-3 sm:space-y-6">
          {/* Summary */}
          <div className="bg-white rounded-lg border p-4 sm:p-6">
            <h3 className="text-lg font-semibold text-slate-800 mb-4">Summary</h3>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-sm text-slate-500">Status</span>
                <StatusBadge status={payment.status_display || payment.status} />
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-slate-500">Total Amount</span>
                <span className="text-sm font-bold">{formatCurrency(payment.amount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-slate-500">Net Payable</span>
                <span className="text-sm font-bold">{formatCurrency(netPayable)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-slate-500">Paid</span>
                <span className="text-sm font-medium text-green-600">{formatCurrency(payment.paid_amount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-slate-500">Balance</span>
                <span className={`text-sm font-bold ${balance > 0 ? 'text-red-600' : 'text-green-600'}`}>
                  {formatCurrency(balance)}
                </span>
              </div>
              {payment.prepared_by_name && (
                <div className="flex justify-between">
                  <span className="text-sm text-slate-500">Created By</span>
                  <span className="text-sm font-medium">{payment.prepared_by_name}</span>
                </div>
              )}
              {payment.due_date && (
                <div className="flex justify-between">
                  <span className="text-sm text-slate-500">Due Date</span>
                  <span className="text-sm font-medium">{formatDate(payment.due_date)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="bg-white rounded-lg border p-4 sm:p-6">
            <h3 className="text-lg font-semibold text-slate-800 mb-4">Actions</h3>
            <div className="space-y-2">
              {canApprove('Payment Made') && (payment.status === 'DRAFT' || payment.status === 'PENDING') && (
                <button
                  onClick={handleApprove}
                  disabled={isApproving}
                  className="w-full px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                >
                  {isApproving ? 'Approving...' : 'Approve'}
                </button>
              )}
              {canCreate('Payment Made') && !['PAID', 'ON_HOLD'].includes(payment.status) && balance > 0 && (
                <button
                  onClick={() => setShowPaymentModal(true)}
                  className="w-full px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  Record Payment
                </button>
              )}
              <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/purchase/payments'))} className="w-full px-4 py-2 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
                &larr; Back to List
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Record Payment Modal */}
      {showPaymentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-4 sm:p-6 w-full max-w-lg mx-4" role="dialog" aria-modal="true" aria-label="Record Payment">
            <h3 className="text-lg font-semibold text-slate-800 mb-4">Record Payment</h3>
            <p className="text-sm text-slate-500 mb-4">
              Balance due: <span className="font-bold text-red-600">{formatCurrency(balance)}</span>
            </p>
            <form onSubmit={handleRecordPayment} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Amount <span className="text-red-500">*</span></label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={paymentForm.amount_paid}
                  onChange={e => setPaymentForm(prev => ({ ...prev, amount_paid: e.target.value }))}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="0.00"
                  max={balance}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Payment Mode</label>
                  <CustomSelect
                    value={paymentForm.payment_mode}
                    onChange={e => setPaymentForm(prev => ({ ...prev, payment_mode: e.target.value }))}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  >
                    <option value="">Select</option>
                    <option value="BANK_TRANSFER">Bank Transfer</option>
                    <option value="CASH">Cash</option>
                    <option value="CHEQUE">Cheque</option>
                    <option value="UPI">UPI</option>
                    <option value="NEFT">NEFT</option>
                    <option value="RTGS">RTGS</option>
                  </CustomSelect>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Payment Date</label>
                  <CustomDatePicker
                    value={paymentForm.payment_date}
                    onChange={e => setPaymentForm(prev => ({ ...prev, payment_date: e.target.value }))}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Payment Reference / UTR <span className="text-red-500">*</span></label>
                <input
                  type="text"
                  required
                  value={paymentForm.payment_reference}
                  onChange={e => setPaymentForm(prev => ({ ...prev, payment_reference: e.target.value }))}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="UTR / Reference number"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Bank Name</label>
                  <input
                    type="text"
                    value={paymentForm.bank_name}
                    onChange={e => setPaymentForm(prev => ({ ...prev, bank_name: e.target.value }))}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Transaction ID</label>
                  <input
                    type="text"
                    value={paymentForm.transaction_id}
                    onChange={e => setPaymentForm(prev => ({ ...prev, transaction_id: e.target.value }))}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-4 border-t">
                <button type="button" onClick={() => setShowPaymentModal(false)} className="px-4 py-2 border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-50">
                  Cancel
                </button>
                <button type="submit" disabled={isRecording} className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">
                  {isRecording ? 'Recording...' : 'Record Payment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <FileAttachments module="PAYMENT" recordId={id} />
    </MainLayout>
  );
}
