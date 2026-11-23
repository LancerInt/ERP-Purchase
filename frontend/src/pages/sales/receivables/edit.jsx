import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { formatCurrency } from '@/utils/formatters';
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import FileAttachments, { uploadPendingFiles } from '../components/FileAttachments';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const readOnlyClass = 'w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-slate-50 text-slate-600';

export default function EditReceivable() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { options: customerOptions } = useLookup('/api/customers/');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [invoiceDetail, setInvoiceDetail] = useState(null);

  const [formData, setFormData] = useState({
    invoice_reference: '',
    customer: '',
    invoice_date: '',
    due_date: '',
    amount: '',
    amount_paid: '',
    notes: '',
  });
  // Store invoice display name
  const [invoiceDisplayLabel, setInvoiceDisplayLabel] = useState('');

  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      try {
        const res = await apiClient.get(`/api/sales/receivables/${id}/`);
        const d = res.data;
        setFormData({
          invoice_reference: d.invoice_reference || '',
          customer: d.customer || '',
          invoice_date: d.invoice_date || '',
          due_date: d.due_date || '',
          amount: d.amount || '',
          amount_paid: d.amount_paid || '0',
          notes: d.notes || '',
        });
        setInvoiceDisplayLabel(d.invoice_no || '');
        // Fetch invoice detail for summary panel
        if (d.invoice_reference) {
          try {
            const invRes = await apiClient.get(`/api/sales/invoices/${d.invoice_reference}/`);
            setInvoiceDetail(invRes.data);
          } catch {}
        }
      } catch { toast.error('Failed to load'); navigate('/sales/receivables'); }
      finally { setIsLoading(false); }
    };
    fetchData();
  }, [id]);

  const handleChange = (e) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const amount = parseFloat(formData.amount) || 0;
  const amountPaid = parseFloat(formData.amount_paid) || 0;
  const balance = Math.max(0, amount - amountPaid);
  const paymentStatus = amountPaid >= amount && amount > 0 ? 'PAID' : amountPaid > 0 ? 'PARTIALLY_PAID' : 'NOT_DUE';

  const fmt = (v) => formatCurrency(v);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await apiClient.put(`/api/sales/receivables/${id}/`, {
        invoice_reference: formData.invoice_reference,
        customer: formData.customer,
        invoice_date: formData.invoice_date || null,
        due_date: formData.due_date || null,
        amount: formData.amount,
        amount_paid: formData.amount_paid || 0,
        notes: formData.notes || '',
      });
      toast.success(paymentStatus === 'PAID' ? 'Updated — Invoice fully received & closed!' : 'Receivable updated!');
      if (pendingAttachments.length > 0) { await uploadPendingFiles('RECEIVABLE', id, pendingAttachments); }
      navigate(`/sales/receivables/${id}`);
    } catch (error) { toast.error(getApiErrorMessage(error)); }
    finally { setIsSaving(false); }
  };

  if (isLoading) return <MainLayout><div className="space-y-4">{[1, 2].map(i => <div key={i} className="h-32 bg-slate-200 rounded animate-pulse" />)}</div></MainLayout>;

  return (
    <MainLayout>
      <PageHeader title="Edit Receivable" breadcrumbs={[
        { label: 'Sales', path: '/sales' },
        { label: 'Receivables', path: '/sales/receivables' },
        { label: invoiceDisplayLabel || 'Edit', path: `/sales/receivables/${id}` },
        { label: 'Edit' },
      ]} />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
        <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-6" noValidate>

          {/* Section 1: Invoice Selection */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Invoice Selection</h3>
            <div className="mb-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
              <label className="block text-sm font-medium text-blue-800 mb-1">Invoice No <span className="text-red-500">*</span></label>
              <input type="text" value={invoiceDisplayLabel} className={`${inputClass} border-blue-300 bg-white`} readOnly />
            </div>
          </div>

          {/* Invoice Summary (when detail loaded) */}
          {invoiceDetail && (
            <div className="p-4 bg-slate-50 rounded-lg border">
              <h4 className="text-sm font-semibold text-slate-700 mb-3">Invoice Summary</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div><span className="text-slate-500">Invoice No</span><p className="font-semibold">{invoiceDetail.invoice_no}</p></div>
                <div><span className="text-slate-500">Date</span><p className="font-semibold">{invoiceDetail.invoice_date || '-'}</p></div>
                <div><span className="text-slate-500">Customer</span><p className="font-semibold">{invoiceDetail.customer_name || '-'}</p></div>
                <div><span className="text-slate-500">Grand Total</span><p className="font-semibold text-slate-900">{fmt(invoiceDetail.grand_total)}</p></div>
                <div><span className="text-slate-500">Subtotal</span><p className="font-medium">{fmt(invoiceDetail.subtotal)}</p></div>
                <div><span className="text-slate-500">CGST</span><p className="font-medium">{fmt(invoiceDetail.cgst_total)}</p></div>
                <div><span className="text-slate-500">SGST</span><p className="font-medium">{fmt(invoiceDetail.sgst_total)}</p></div>
                <div><span className="text-slate-500">IGST</span><p className="font-medium">{fmt(invoiceDetail.igst_total)}</p></div>
                {invoiceDetail.dc_no && <div><span className="text-slate-500">DC No</span><p className="font-medium">{invoiceDetail.dc_no}</p></div>}
                {invoiceDetail.so_no && <div><span className="text-slate-500">SO No</span><p className="font-medium">{invoiceDetail.so_no}</p></div>}
                {invoiceDetail.destination && <div><span className="text-slate-500">Destination</span><p className="font-medium">{invoiceDetail.destination}</p></div>}
                {invoiceDetail.buyer_name && <div><span className="text-slate-500">Buyer</span><p className="font-medium">{invoiceDetail.buyer_name}</p></div>}
              </div>
              {/* Line items */}
              {invoiceDetail.invoice_lines && invoiceDetail.invoice_lines.length > 0 && (
                <div className="mt-3 pt-3 border-t">
                  <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Line Items ({invoiceDetail.invoice_lines.length})</p>
                  <table className="w-full text-xs">
                    <thead><tr className="border-b"><th className="text-left py-1 px-2">#</th><th className="text-left py-1 px-2">Description</th><th className="text-left py-1 px-2">HSN</th><th className="text-right py-1 px-2">Qty</th><th className="text-right py-1 px-2">Rate</th><th className="text-right py-1 px-2">Amount</th></tr></thead>
                    <tbody>
                      {invoiceDetail.invoice_lines.map((l, i) => (
                        <tr key={i} className="border-b"><td className="py-1 px-2">{l.sl_no}</td><td className="py-1 px-2">{l.description}</td><td className="py-1 px-2">{l.hsn_sac}</td><td className="py-1 px-2 text-right">{l.quantity}</td><td className="py-1 px-2 text-right">{fmt(l.rate)}</td><td className="py-1 px-2 text-right font-medium">{fmt(l.amount)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Section 2: Receivable Details */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Receivable Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Customer</label>
                <CustomSelect name="customer" value={formData.customer} onChange={handleChange} className={readOnlyClass} disabled>
                  <option value="">-</option>
                  {customerOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
                <p className="text-xs text-slate-400 mt-0.5">Auto-filled from invoice</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Invoice Date</label>
                <CustomDatePicker name="invoice_date" value={formData.invoice_date} className={readOnlyClass} readOnly />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Due Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="due_date" value={formData.due_date} onChange={handleChange} required className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Invoice Amount</label>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-slate-400 text-sm">₹</span>
                  <input type="number" step="0.01" name="amount" value={formData.amount} className={`${readOnlyClass} pl-7`} readOnly />
                </div>
                <p className="text-xs text-slate-400 mt-0.5">Auto-filled from invoice grand total</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Amount Received <span className="text-red-500">*</span></label>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-slate-400 text-sm">₹</span>
                  <input type="number" step="0.01" min="0" name="amount_paid" value={formData.amount_paid} onChange={handleChange} className={`${inputClass} pl-7`} placeholder="0.00" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Balance</label>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-slate-400 text-sm">₹</span>
                  <input type="text" value={Number(balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })} className={`${readOnlyClass} pl-7`} readOnly />
                </div>
              </div>
            </div>
          </div>

          {/* Payment Status Preview */}
          <div className="p-4 rounded-lg border flex items-center justify-between" style={{ backgroundColor: paymentStatus === 'PAID' ? '#ecfdf5' : paymentStatus === 'PARTIALLY_PAID' ? '#fffbeb' : '#f8fafc', borderColor: paymentStatus === 'PAID' ? '#a7f3d0' : paymentStatus === 'PARTIALLY_PAID' ? '#fde68a' : '#e2e8f0' }}>
            <div>
              <p className="text-sm font-medium text-slate-600">Payment Status</p>
              <p className={`text-lg font-bold ${paymentStatus === 'PAID' ? 'text-green-700' : paymentStatus === 'PARTIALLY_PAID' ? 'text-amber-700' : 'text-slate-600'}`}>
                {paymentStatus === 'PAID' ? 'FULLY RECEIVED — Invoice will be closed' : paymentStatus === 'PARTIALLY_PAID' ? 'PARTIALLY RECEIVED' : 'NOT DUE'}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-slate-500">Received / Total</p>
              <p className="text-lg font-bold">{fmt(amountPaid)} / {fmt(amount)}</p>
            </div>
          </div>

          {/* Additional Notes */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Additional Notes</h3>
            <textarea name="notes" value={formData.notes} onChange={handleChange} rows={3} className={inputClass} placeholder="Any additional notes..." />
          </div>

          <FileAttachments module="RECEIVABLE" recordId={id} deferUpload onPendingChange={setPendingAttachments} />

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(`/sales/receivables/${id}`)} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isSaving} className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">
              {isSaving ? 'Saving...' : paymentStatus === 'PAID' ? 'Update & Close Invoice' : 'Update'}
            </button>
          </div>
        </form>
      </div>
    </MainLayout>
  );
}
