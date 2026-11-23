import { confirm } from '@/components/common/confirm';
import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Edit3, Trash2, FileText, Plus, XCircle, DollarSign, GitBranch } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import FileAttachments from '../components/FileAttachments';
import { useFlowDashboard } from '../../../components/common/FlowDashboardPopup';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

export default function OutwardFreightDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit, canDelete, canView } = usePermissions();
  // Flow header button — reuses Sales Flow Dashboard view permission.
  const canSeeFlow = canView('Sales Flow Dashboard');
  // Cross-module nav: linked DC table cells (`l.dc_no`). Gate on
  // Dispatch Challan view perm — show the DC number as text when
  // the user can't click through to the DC detail page.
  const canSeeDC = canView('Dispatch Challan');
  const [freight, setFreight] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentData, setPaymentData] = useState({ payment_date: new Date().toISOString().split('T')[0], amount_paid: '', payment_mode: 'BANK', reference_no: '', remarks: '' });
  const [isSavingPayment, setIsSavingPayment] = useState(false);
  const { openFlow, FlowPopup } = useFlowDashboard();

  useEffect(() => { fetchFreight(); }, [id]);

  const fetchFreight = async () => {
    setIsLoading(true);
    try {
      const res = await apiClient.get(`/api/sales/freight/${id}/`);
      setFreight(res.data);
    } catch (err) { if (err.response?.status !== 404) toast.error('Failed to load freight'); }
    finally { setIsLoading(false); }
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: `Delete Freight ${freight.advice_no}?`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/sales/freight/${id}/`);
      toast.success('Freight deleted');
      navigate('/sales/freight');
    } catch (err) { toast.error(err.response?.data?.detail || 'Failed to delete'); }
  };

  const handleCancel = async () => {
    if (!(await confirm({ message: 'Cancel this freight?', isDangerous: true, confirmLabel: 'Cancel' }))) return;
    try {
      await apiClient.post(`/api/sales/freight/${id}/cancel/`);
      toast.success('Freight cancelled');
      fetchFreight();
    } catch (err) { toast.error(err.response?.data?.detail || 'Failed to cancel'); }
  };

  const handleAddPayment = async (e) => {
    e.preventDefault();
    if (!paymentData.amount_paid || parseFloat(paymentData.amount_paid) <= 0) {
      toast.error('Payment amount must be > 0'); return;
    }
    if (parseFloat(paymentData.amount_paid) > parseFloat(freight.balance)) {
      toast.error(`Amount (${paymentData.amount_paid}) exceeds balance (${freight.balance})`); return;
    }
    setIsSavingPayment(true);
    try {
      await apiClient.post(`/api/sales/freight/${id}/add-payment/`, paymentData);
      toast.success('Payment added!');
      setShowPaymentForm(false);
      setPaymentData({ payment_date: new Date().toISOString().split('T')[0], amount_paid: '', payment_mode: 'BANK', reference_no: '', remarks: '' });
      fetchFreight();
    } catch (err) { toast.error(getApiErrorMessage(err)); }
    finally { setIsSavingPayment(false); }
  };

  const handleDeletePayment = async (paymentId) => {
    if (!(await confirm({ message: 'Delete this payment?', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/sales/freight/${id}/delete-payment/${paymentId}/`);
      toast.success('Payment deleted');
      fetchFreight();
    } catch (err) { toast.error('Failed to delete payment'); }
  };

  const fmt = (v) => formatCurrency(v);
  const fmtDate = (d) => d ? formatDate(d) : '-';

  const InfoField = ({ label, children }) => (
    <div>
      <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">{label}</p>
      <p className="text-slate-900 font-semibold mt-1">{children}</p>
    </div>
  );

  if (isLoading) return <MainLayout><div className="space-y-4">{[1, 2, 3].map(i => <div key={i} className="h-32 bg-slate-200 rounded animate-pulse" />)}</div></MainLayout>;
  if (!freight) return <MainLayout><div className="text-center py-12"><FileText className="mx-auto text-slate-300 mb-4" size={48} /><p className="text-slate-600">Freight not found</p><button onClick={() => navigate('/sales/freight')} className="mt-4 text-blue-600">Back</button></div></MainLayout>;

  const payments = freight.payments || [];
  const dcLinks = freight.dc_links || [];
  const isPending = freight.status === 'PENDING';
  const isCancelled = freight.status === 'CANCELLED';
  const isPaid = freight.status === 'PAID';

  return (
    <MainLayout>
      <div className="max-w-7xl space-y-4 sm:space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <button onClick={() => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/sales/freight'))} className="p-1 text-slate-500 hover:text-slate-700"><ArrowLeft size={20} /></button>
              <h1 className="text-xl sm:text-3xl font-bold text-slate-900">{freight.advice_no}</h1>
            </div>
            <div className="flex items-center gap-4 ml-8">
              <StatusBadge status={freight.status} />
              <p className="text-slate-500 text-sm">{fmtDate(freight.freight_date)}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap ml-8 sm:ml-0">
            {canSeeFlow && freight.linked_so_id && (
              <button onClick={() => openFlow(freight.linked_so_id)} className="flex items-center gap-2 px-4 py-2 border border-purple-300 text-purple-700 bg-purple-50 hover:bg-purple-100 rounded-lg text-sm font-medium" title="View Sales Flow">
                <GitBranch size={16} /> Flow
              </button>
            )}
            {/* Edit/Delete only while the freight advice is still
                PENDING (no payments recorded) — sales-module post-
                approval rule. */}
            {canEdit('Freight Advice') && isPending && (
              <button onClick={() => navigate(`/sales/freight/${id}/edit`)} className="flex items-center gap-2 px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 text-sm font-medium"><Edit3 size={16} /> Edit</button>
            )}
            {canDelete('Freight Advice') && isPending && (
              <button onClick={handleDelete} className="flex items-center gap-2 px-4 py-2 border border-red-300 rounded-lg text-red-600 hover:bg-red-50 text-sm font-medium"><Trash2 size={16} /> Delete</button>
            )}
            {!isCancelled && !isPaid && (
              <button onClick={handleCancel} className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium"><XCircle size={16} /> Cancel</button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
          <div className="lg:col-span-2 space-y-4 sm:space-y-6">
            {/* Basic Details */}
            <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
              <h2 className="text-lg font-semibold text-slate-900 mb-5 pb-2 border-b">Basic Details</h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-5">
                <InfoField label="Freight No">{freight.advice_no}</InfoField>
                <InfoField label="Date">{fmtDate(freight.freight_date)}</InfoField>
                <InfoField label="Customer">{freight.customer_name || '-'}</InfoField>
                <InfoField label="Transporter">{freight.transporter_name || '-'}</InfoField>
                <InfoField label="Invoice Date">{fmtDate(freight.invoice_date)}</InfoField>
                <InfoField label="Lorry No">{freight.lorry_no || '-'}</InfoField>
                <InfoField label="Destination">{freight.destination || '-'}</InfoField>
              </div>
            </div>

            {/* DC Links */}
            {dcLinks.length > 0 && (
              <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
                <h2 className="text-lg font-semibold text-slate-900 mb-5 pb-2 border-b">DC Mapping ({dcLinks.length})</h2>
                <table className="w-full text-sm">
                  <thead><tr className="border-b"><th className="text-left py-2 px-3 text-xs text-slate-500 uppercase">DC No</th><th className="text-left py-2 px-3 text-xs text-slate-500 uppercase">Invoice No</th><th className="text-left py-2 px-3 text-xs text-slate-500 uppercase">Destination</th></tr></thead>
                  <tbody>
                    {dcLinks.map((l, i) => (
                      <tr key={i} className="border-b hover:bg-primary-50/40 transition-colors">
                        {canSeeDC ? (
                          <td className="py-2 px-3 font-medium text-blue-700 cursor-pointer" onClick={() => navigate(`/sales/dc/${l.dc}`)}>{l.dc_no}</td>
                        ) : (
                          <td className="py-2 px-3 font-medium text-slate-700">{l.dc_no}</td>
                        )}
                        <td className="py-2 px-3">{l.invoice_no || '-'}</td>
                        <td className="py-2 px-3">{l.destination || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Costs */}
            <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
              <h2 className="text-lg font-semibold text-slate-900 mb-5 pb-2 border-b">Freight Value & Costs</h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                <div><span className="text-slate-500">Freight Value</span><p className="font-semibold">{fmt(freight.base_amount)}</p></div>
              </div>
              <div className="mt-4 pt-3 border-t flex justify-between text-base font-bold">
                <span>Total Payable</span><span>{fmt(freight.payable_amount)}</span>
              </div>
            </div>

            {/* Payment History */}
            <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
              <div className="flex items-center justify-between mb-5 pb-2 border-b">
                <h2 className="text-lg font-semibold text-slate-900">Payment History ({payments.length})</h2>
                {!isCancelled && !isPaid && (
                  <button onClick={() => setShowPaymentForm(!showPaymentForm)} className="inline-flex items-center gap-1 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700">
                    <Plus size={16} /> Add Payment
                  </button>
                )}
              </div>

              {/* Add Payment Form */}
              {showPaymentForm && (
                <form onSubmit={handleAddPayment} className="mb-4 p-4 bg-emerald-50 rounded-lg border border-emerald-200">
                  <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-5 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Date *</label>
                      <CustomDatePicker value={paymentData.payment_date} onChange={(e) => setPaymentData(p => ({ ...p, payment_date: e.target.value }))} required className={inputClass} />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Amount * (Max: {fmt(freight.balance)})</label>
                      <input type="number" step="0.01" min="0.01" max={freight.balance} value={paymentData.amount_paid} onChange={(e) => setPaymentData(p => ({ ...p, amount_paid: e.target.value }))} required className={inputClass} placeholder="0.00" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Mode *</label>
                      <CustomSelect value={paymentData.payment_mode} onChange={(e) => setPaymentData(p => ({ ...p, payment_mode: e.target.value }))} className={inputClass}>
                        <option value="CASH">Cash</option><option value="BANK">Bank Transfer</option><option value="UPI">UPI</option>
                        <option value="CHEQUE">Cheque</option><option value="NEFT">NEFT</option><option value="RTGS">RTGS</option><option value="OTHER">Other</option>
                      </CustomSelect>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">Reference No</label>
                      <input type="text" value={paymentData.reference_no} onChange={(e) => setPaymentData(p => ({ ...p, reference_no: e.target.value }))} className={inputClass} />
                    </div>
                    <div className="flex items-end gap-2">
                      <button type="submit" disabled={isSavingPayment} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">{isSavingPayment ? 'Saving...' : 'Save'}</button>
                      <button type="button" onClick={() => setShowPaymentForm(false)} className="px-4 py-2 border border-slate-300 rounded-lg text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
                    </div>
                  </div>
                </form>
              )}

              {payments.length === 0 ? (
                <p className="text-slate-400 text-center py-4 sm:py-6">No payments recorded yet</p>
              ) : (
                <table className="w-full text-sm">
                  <thead><tr className="border-b">
                    <th className="text-left py-2 px-3 text-xs text-slate-500 uppercase">#</th>
                    <th className="text-left py-2 px-3 text-xs text-slate-500 uppercase">Date</th>
                    <th className="text-right py-2 px-3 text-xs text-slate-500 uppercase">Amount</th>
                    <th className="text-left py-2 px-3 text-xs text-slate-500 uppercase">Mode</th>
                    <th className="text-left py-2 px-3 text-xs text-slate-500 uppercase">Ref No</th>
                    <th className="text-left py-2 px-3 text-xs text-slate-500 uppercase">Remarks</th>
                    <th className="px-3 py-2"></th>
                  </tr></thead>
                  <tbody>
                    {payments.map((p, i) => (
                      <tr key={p.id} className="border-b hover:bg-primary-50/40 transition-colors">
                        <td className="py-2 px-3 text-slate-500">{i + 1}</td>
                        <td className="py-2 px-3">{fmtDate(p.payment_date)}</td>
                        <td className="py-2 px-3 text-right font-semibold text-emerald-700">{fmt(p.amount_paid)}</td>
                        <td className="py-2 px-3">{p.payment_mode}</td>
                        <td className="py-2 px-3 text-slate-600">{p.reference_no || '-'}</td>
                        <td className="py-2 px-3 text-xs text-slate-500">{p.remarks || '-'}</td>
                        <td className="py-2 px-3">
                          {!isCancelled && (
                            <button onClick={() => handleDeletePayment(p.id)} className="text-red-500 hover:text-red-700"><Trash2 size={14} /></button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Remarks */}
            {freight.remarks && (
              <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
                <h2 className="text-lg font-semibold text-slate-900 mb-3 pb-2 border-b">Remarks</h2>
                <p className="text-sm text-slate-700 whitespace-pre-wrap">{freight.remarks}</p>
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-4">
            <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
              <h3 className="text-lg font-semibold text-slate-900 mb-4">Payment Summary</h3>
              <div className="space-y-4">
                <div><p className="text-xs text-slate-500 uppercase">Status</p><div className="mt-1"><StatusBadge status={freight.status} /></div></div>
                <div><p className="text-xs text-slate-500 uppercase">Total Payable</p><p className="text-2xl font-bold text-slate-900 mt-1">{fmt(freight.payable_amount)}</p></div>
                <div><p className="text-xs text-slate-500 uppercase">Total Paid</p><p className="text-xl font-bold text-emerald-700 mt-1">{fmt(freight.total_paid)}</p></div>
                <div><p className="text-xs text-slate-500 uppercase">Balance</p><p className={`text-xl font-bold mt-1 ${Number(freight.balance) > 0 ? 'text-orange-600' : 'text-slate-400'}`}>{fmt(freight.balance)}</p></div>
                <div><p className="text-xs text-slate-500 uppercase">Payments</p><p className="text-lg font-semibold text-slate-700 mt-1">{payments.length}</p></div>
                {/* Progress bar */}
                <div>
                  <div className="w-full bg-slate-200 rounded-full h-2.5">
                    <div className="bg-emerald-600 h-2.5 rounded-full" style={{ width: `${Math.min(100, (Number(freight.total_paid) / Math.max(1, Number(freight.payable_amount))) * 100)}%` }}></div>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">{Math.round((Number(freight.total_paid) / Math.max(1, Number(freight.payable_amount))) * 100)}% paid</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <FileAttachments module="FREIGHT" recordId={id} readOnly />
      </div>
      {FlowPopup}
    </MainLayout>
  );
}
