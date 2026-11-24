import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Trash2, ArrowLeft, ExternalLink } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useLookup from '../../../hooks/useLookup.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import { confirm } from '@/components/common/confirm';
import { formatDate as fmtDate } from '@/utils/formatters';
import { getApiErrorMessage } from '@/utils/formHelpers';

export default function PaymentMadeDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Where to return on "Back". Callers (e.g. the Analytics vendor-ledger drawer,
  // the Payments list) pass the exact URL to return to via navigation state, so
  // Back restores THAT view (the open drawer, the filtered list) rather than a
  // generic list or a raw history pop that drops the drawer. Falls back to a
  // history step, then the Payment Entries list.
  const goBack = () => {
    const backTo = location.state?.backTo;
    if (backTo) navigate(backTo);
    else if (window.history.state?.idx > 0) navigate(-1);
    else navigate('/purchase/payment-entries');
  };
  const { canEdit, canDelete, canApprove } = usePermissions();
  const { isHidden, isReadOnly } = useFieldPermissions('Payment Made');
  // Lookups for editable vendor & bill fields (parity with Create page)
  const { options: vendorOptions } = useLookup('/api/vendors/');
  const { raw: allBillsRaw } = useLookup('/api/purchase/bills/');
  const [payment, setPayment] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState({});
  const [isSaving, setIsSaving] = useState(false);
  // {count, total} of this vendor's currently-open bills — deliberately just
  // a live snapshot of balance_due (a fact already stored per bill), not a
  // reconstructed historical ledger. The previous version of this page
  // rebuilt a whole running-balance ledger client-side with its own
  // "1 Week / 1 Month / ..." date cutoff, anchored to today's real date
  // instead of this payment's — so viewing a payment made a month ago could
  // show "Total Paid: 0.00" because the payment itself fell before the
  // default cutoff. A point-in-time sum has no cutoff to get wrong. The
  // full historical ledger, correctly computed, lives one click away via
  // the Vendor Ledger link below.
  const [vendorOutstanding, setVendorOutstanding] = useState(null);
  // HTTP status of a failed load (404 = gone, 5xx = server error) so the
  // not-found state can explain itself and offer a useful escape hatch.
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    fetchPayment();
  }, [id]);

  const fetchPayment = async () => {
    try {
      const res = await apiClient.get(`/api/purchase/payments-made/${id}/`);
      setPayment(res.data);
      setEditData(res.data);
      setLoadError(null);
    } catch (err) {
      const code = err.response?.status || 0;
      setLoadError(code || true);
      // 404 is an ordinary "gone" case handled by the empty state; only a real
      // server error warrants a toast.
      if (code >= 500) toast.error(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!payment?.vendor) { setVendorOutstanding(null); return; }
    apiClient.get(`/api/purchase/bills/?vendor=${payment.vendor}&page_size=500`)
      .then((res) => {
        const list = res.data?.results || res.data || [];
        const open = list.filter((b) => ['OPEN', 'PARTIALLY_PAID'].includes(b.status) && (Number(b.balance_due) || 0) > 0);
        setVendorOutstanding({
          count: open.length,
          total: open.reduce((s, b) => s + (Number(b.balance_due) || 0), 0),
        });
      })
      .catch(() => setVendorOutstanding(null));
  }, [payment?.vendor]);

  // Build Zoho-style ledger statement: bills (debit) + payments (credit) sorted by date
  const handleDelete = async () => {
    if (!(await confirm({ message: 'Are you sure you want to delete this payment? This action cannot be undone.', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/payments-made/${id}/`);
      toast.success('Payment deleted successfully');
      navigate('/purchase/payments-made');
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to delete');
    }
  };

  const handleEdit = () => {
    setIsEditing(true);
    setEditData({ ...payment });
  };

  const handleCancel = () => {
    setIsEditing(false);
    setEditData({ ...payment });
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setEditData(prev => ({ ...prev, [name]: value }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const res = await apiClient.patch(`/api/purchase/payments-made/${id}/`, {
        vendor: editData.vendor || null,
        bill: editData.bill || null,
        payment_date: editData.payment_date,
        payment_mode: editData.payment_mode,
        amount: editData.amount,
        reference_no: editData.reference_no,
        bank_name: editData.bank_name,
        notes: editData.notes,
      });
      setPayment(res.data);
      setIsEditing(false);
      toast.success('Payment updated successfully');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  const handleApprove = async () => {
    if (!(await confirm({ message: 'Approve this payment?' }))) return;
    try {
      const res = await apiClient.post(`/api/purchase/payments-made/${id}/approve/`);
      setPayment(res.data);
      toast.success('Payment approved');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to approve');
    }
  };

  const formatCurrency = (val) => `₹${Number(val || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  const formatDate = (d) => d ? fmtDate(d) : '-';

  if (isLoading) return <MainLayout><div className="flex justify-center py-20"><div className="animate-spin h-8 w-8 border-4 border-primary-500 border-t-transparent rounded-full" /></div></MainLayout>;
  if (!payment) {
    const serverError = typeof loadError === 'number' && loadError >= 500;
    return (
      <MainLayout>
        <div className="text-center py-20 max-w-md mx-auto">
          <p className="text-slate-700 mb-1 font-semibold">
            {serverError ? "This payment couldn't be opened." : 'Payment not found.'}
          </p>
          <p className="text-sm text-slate-400 mb-5">
            {serverError
              ? 'The entry is in the list but its detail view hit a server error. You can still review it from Payment Entries or in Purchase Analytics.'
              : 'It may have been deleted or merged into another record.'}
          </p>
          <div className="flex items-center justify-center gap-2">
            <button onClick={goBack} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
              <ArrowLeft size={15} /> Back
            </button>
            <button onClick={() => navigate('/purchase/dashboard')} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700">
              Purchase Analytics
            </button>
          </div>
        </div>
      </MainLayout>
    );
  }

  const isDraft = payment.status === 'DRAFT';
  const inputClass = "w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500";
  const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;

  return (
    <MainLayout>
      <PageHeader
        title={`Payment ${payment.payment_no}`}
        breadcrumbs={[
          { label: 'Payments Made', href: '/purchase/payments-made' },
          { label: payment.payment_no },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-3">
          {/* Header */}
          <div className="bg-white rounded-lg border p-3 sm:p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                {!isHidden('payment_no') && <h2 className="text-xl font-bold text-slate-900">{payment.payment_no}</h2>}
                {!isHidden('status') && <StatusBadge status={payment.status_display || payment.status} />}
                {payment.payment_mode === 'ADVANCE' && (
                  <span className="px-3 py-1 text-xs font-semibold bg-amber-100 text-amber-700 border border-amber-200 rounded-full">
                    Paid via Advance
                  </span>
                )}
                {payment.payment_mode === 'CREDIT' && (
                  <span className="px-3 py-1 text-xs font-semibold bg-purple-100 text-purple-700 border border-purple-200 rounded-full">
                    Paid via Credit
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                {!isEditing && (
                  <>
                    {/* Edit/Delete are no longer DRAFT-only: Tally-imported and
                        hand-booked payments land APPROVED, and they still need
                        corrections (wrong vendor/bill/reference). Gated on the
                        'Payment Made' edit/delete permission. Approve stays
                        DRAFT-only — approving an approved payment is meaningless. */}
                    {canEdit('Payment Made') && (
                      <button onClick={handleEdit} className="px-4 py-2 text-sm bg-white border border-slate-300 rounded-lg hover:bg-slate-50">Edit</button>
                    )}
                    {canDelete('Payment Made') && (
                      <button onClick={handleDelete} className="px-4 py-2 text-sm border border-red-300 text-red-600 rounded-lg hover:bg-red-50 flex items-center gap-1"><Trash2 size={14} /> Delete</button>
                    )}
                    {isDraft && canApprove('Payment Made') && (
                      <button onClick={handleApprove} className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700">Approve</button>
                    )}
                  </>
                )}
                {isEditing && (
                  <>
                    <button onClick={handleCancel} className="px-4 py-2 text-sm bg-white border border-slate-300 rounded-lg hover:bg-slate-50">Cancel</button>
                    <button onClick={handleSave} disabled={isSaving} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50">
                      {isSaving ? 'Saving...' : 'Save'}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Payment Details */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-2">
              {!isHidden('vendor') && (
              <div>
                <p className="text-xs font-semibold text-slate-700">Vendor</p>
                {isEditing ? (
                  <CustomSelect name="vendor" value={editData.vendor || ''} onChange={handleChange} disabled={isReadOnly('vendor')} className={isReadOnly('vendor') ? lockedInputClass : inputClass}>
                    <option value="">Select Vendor</option>
                    {vendorOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                ) : (
                  <p className="font-semibold mt-1">{payment.vendor_name || '-'}</p>
                )}
              </div>
              )}
              {!isHidden('bill') && (
              <div>
                <p className="text-xs font-semibold text-slate-700">Bill No</p>
                {isEditing ? (
                  <CustomSelect name="bill" value={editData.bill || ''} onChange={handleChange} disabled={isReadOnly('bill')} className={isReadOnly('bill') ? lockedInputClass : inputClass}>
                    <option value="">Select Bill (optional)</option>
                    {allBillsRaw
                      .filter(b => !editData.vendor || b.vendor === editData.vendor)
                      .filter(b => ['OPEN', 'PARTIALLY_PAID', 'PAID'].includes(b.status) || b.id === editData.bill)
                      .map(b => (
                        <option key={b.id} value={b.id}>
                          {b.bill_no} - Balance: {'₹'}{(Number(b.balance_due) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </option>
                      ))}
                  </CustomSelect>
                ) : (
                  <p className="font-semibold mt-1 text-primary-600 cursor-pointer" onClick={() => payment.bill && navigate(`/purchase/bills/${payment.bill}`)}>
                    {payment.bill_no || '-'}
                  </p>
                )}
              </div>
              )}
              {!isHidden('payment_date') && (
              <div>
                <p className="text-xs font-semibold text-slate-700">Payment Date</p>
                {isEditing ? (
                  <CustomDatePicker name="payment_date" value={editData.payment_date || ''} onChange={handleChange} disabled={isReadOnly('payment_date')} className={isReadOnly('payment_date') ? lockedInputClass : inputClass} />
                ) : (
                  <p className="font-semibold mt-1">{formatDate(payment.payment_date)}</p>
                )}
              </div>
              )}
              {!isHidden('payment_mode') && (
              <div>
                <p className="text-xs font-semibold text-slate-700">Payment Mode</p>
                {isEditing ? (
                  <CustomSelect name="payment_mode" value={editData.payment_mode || ''} onChange={handleChange} disabled={isReadOnly('payment_mode')} className={isReadOnly('payment_mode') ? lockedInputClass : inputClass}>
                    <option value="BANK_TRANSFER">Bank Transfer</option>
                    <option value="CASH">Cash</option>
                    <option value="CHEQUE">Cheque</option>
                    <option value="UPI">UPI</option>
                    <option value="NEFT">NEFT</option>
                    <option value="RTGS">RTGS</option>
                  </CustomSelect>
                ) : (
                  <p className="font-semibold mt-1">{payment.payment_mode_display || payment.payment_mode || '-'}</p>
                )}
              </div>
              )}
            </div>
          </div>

          {/* Amount & Reference */}
          <div className="bg-white rounded-lg border p-3 sm:p-4">
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2 pb-1.5 border-b">Payment Information</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-2">
              {!isHidden('amount') && (
              <div>
                <p className="text-xs font-semibold text-slate-700">Amount</p>
                {isEditing ? (
                  <input type="number" step="0.01" name="amount" value={editData.amount || ''} onChange={handleChange} disabled={isReadOnly('amount')} className={isReadOnly('amount') ? lockedInputClass : inputClass} />
                ) : (
                  <p className="text-2xl font-bold text-green-700 mt-1">{formatCurrency(payment.amount)}</p>
                )}
              </div>
              )}
              {!isHidden('reference_no') && (
              <div>
                <p className="text-xs font-semibold text-slate-700">Reference No</p>
                {isEditing ? (
                  <input type="text" name="reference_no" value={editData.reference_no || ''} onChange={handleChange} disabled={isReadOnly('reference_no')} className={isReadOnly('reference_no') ? lockedInputClass : inputClass} />
                ) : (
                  <p className="font-semibold mt-1">{payment.reference_no || '-'}</p>
                )}
              </div>
              )}
              {!isHidden('bank_name') && (
              <div>
                <p className="text-xs font-semibold text-slate-700">Bank Name</p>
                {isEditing ? (
                  <input type="text" name="bank_name" value={editData.bank_name || ''} onChange={handleChange} disabled={isReadOnly('bank_name')} className={isReadOnly('bank_name') ? lockedInputClass : inputClass} />
                ) : (
                  <p className="font-semibold mt-1">{payment.bank_name || '-'}</p>
                )}
              </div>
              )}
              {!isHidden('notes') && (
              <div className="md:col-span-3">
                <p className="text-xs font-semibold text-slate-700">Notes</p>
                {isEditing ? (
                  <textarea name="notes" value={editData.notes || ''} onChange={handleChange} rows={2} disabled={isReadOnly('notes')} className={isReadOnly('notes') ? lockedInputClass : inputClass} />
                ) : (
                  <p className="text-sm text-slate-700 mt-1">{payment.notes || '-'}</p>
                )}
              </div>
              )}
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-3">
          <div className="bg-white rounded-lg border p-3 sm:p-4">
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2">Actions</h3>
            <div className={`grid ${payment.bill ? 'grid-cols-2' : 'grid-cols-1'} gap-2`}>
              <button onClick={goBack} className="px-3 py-2 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
                ← Back to List
              </button>
              {payment.bill && (
                <button onClick={() => navigate(`/purchase/bills/${payment.bill}`)} className="px-3 py-2 text-sm bg-primary-50 text-primary-700 rounded-lg hover:bg-primary-100">
                  View Bill
                </button>
              )}
            </div>
          </div>

          {/* Audit */}
          <div className="bg-white rounded-lg border p-3 sm:p-4">
            <h3 className="text-sm sm:text-base font-semibold text-slate-800 mb-2">Audit Trail</h3>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
              <div>
                <p className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide">Created</p>
                <p className="text-slate-700 mt-0.5">{formatDate(payment.created_at)}</p>
              </div>
              <div>
                <p className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide">Updated</p>
                <p className="text-slate-700 mt-0.5">{formatDate(payment.updated_at)}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Vendor balance snapshot + a link to the full, correctly-computed
          ledger — NOT a re-derived historical statement on this page (see
          the vendorOutstanding state comment above for why the old version
          of this section was replaced). */}
      {payment.vendor && (
        <div className="bg-white rounded-lg border p-3 sm:p-4 mt-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h3 className="text-sm sm:text-base font-semibold text-slate-800">Vendor Balance</h3>
              <p className="text-xs text-slate-500 mt-0.5">{payment.vendor_name || 'Vendor'}</p>
            </div>
            <Link
              to={`/import/ledgers?party=${encodeURIComponent(payment.vendor_name || '')}`}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-primary-700 bg-primary-50 rounded-lg hover:bg-primary-100 transition w-fit"
            >
              View Full Ledger <ExternalLink size={14} />
            </Link>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 mt-3">
            <div className="bg-amber-50 rounded-lg px-3 py-2">
              <p className="text-[10px] font-semibold text-amber-600 uppercase">Currently Outstanding</p>
              <p className="text-sm font-bold text-amber-700">
                {vendorOutstanding ? formatCurrency(vendorOutstanding.total) : '…'}
              </p>
            </div>
            <div className="bg-slate-50 rounded-lg px-3 py-2">
              <p className="text-[10px] font-semibold text-slate-500 uppercase">Open Bills</p>
              <p className="text-sm font-bold text-slate-800">
                {vendorOutstanding ? vendorOutstanding.count : '…'}
              </p>
            </div>
          </div>
        </div>
      )}

    </MainLayout>
  );
}
