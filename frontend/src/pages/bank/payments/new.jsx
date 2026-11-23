import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import useApiData from '../../../hooks/useApiData.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';

const input = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const label = 'block text-sm font-medium text-slate-700 mb-1';

export default function BankPaymentNew() {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const { data: vendors } = useApiData('/api/vendors/');
  const { data: accounts } = useApiData('/api/bank/accounts/');
  const [form, setForm] = useState({
    voucher_no: '', payment_date: '', vendor: '', against_bill: '', bank_account: '',
    payment_mode: 'NEFT', amount: '', tds_deducted: '', bank_charges: '', reference_no: '',
    cheque_no: '', cheque_date: '', cheque_status: 'ISSUED', approval_status: 'DRAFT',
    reconciliation_status: 'UNRECONCILED', narration: '',
  });

  const change = (e) => setForm((p) => ({ ...p, [e.target.name]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      await apiClient.post('/api/bank/payments/', cleanFormData(form));
      toast.success('Payment voucher created!');
      navigate('/bank/payments');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  const breadcrumbs = [{ label: 'Bank', href: '/bank/dashboard' }, { label: 'Purchase · Payments', href: '/bank/payments' }, { label: 'New Payment' }];

  return (
    <MainLayout>
      <PageHeader title="New Payment Voucher" subtitle="Dr Supplier / Cr Bank" breadcrumbs={breadcrumbs} />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={submit} className="space-y-4 sm:space-y-5">
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Payment</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div><label className={label}>Voucher No <span className="text-red-500">*</span></label>
                <input name="voucher_no" value={form.voucher_no} onChange={change} required className={input} placeholder="PAY-2026-0020" /></div>
              <div><label className={label}>Payment Date <span className="text-red-500">*</span></label>
                <input type="date" name="payment_date" value={form.payment_date} onChange={change} required className={input} /></div>
              <div><label className={label}>Supplier / Vendor (Dr) <span className="text-red-500">*</span></label>
                <select name="vendor" value={form.vendor} onChange={change} required className={input}>
                  <option value="">Select vendor…</option>
                  {(vendors || []).map((v) => <option key={v.id} value={v.id}>{v.vendor_name || v.name}</option>)}
                </select></div>
              <div><label className={label}>Against Bill</label>
                <input name="against_bill" value={form.against_bill} onChange={change} className={input} placeholder="BILL-0311" /></div>
              <div><label className={label}>Paid from Bank A/C (Cr) <span className="text-red-500">*</span></label>
                <select name="bank_account" value={form.bank_account} onChange={change} required className={input}>
                  <option value="">Select account…</option>
                  {(accounts || []).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.bank_name} {a.branch}</option>)}
                </select></div>
              <div><label className={label}>Payment Mode</label>
                <select name="payment_mode" value={form.payment_mode} onChange={change} className={input}>
                  {['NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE', 'DD'].map((m) => <option key={m} value={m}>{m}</option>)}
                </select></div>
            </div>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Amount &amp; Approval</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div><label className={label}>Amount Paid <span className="text-red-500">*</span></label>
                <input type="number" step="0.01" name="amount" value={form.amount} onChange={change} required className={input} placeholder="0.00" /></div>
              <div><label className={label}>TDS Deducted (by us)</label>
                <input type="number" step="0.01" name="tds_deducted" value={form.tds_deducted} onChange={change} className={input} placeholder="0.00" /></div>
              <div><label className={label}>Bank Charges</label>
                <input type="number" step="0.01" name="bank_charges" value={form.bank_charges} onChange={change} className={input} placeholder="0.00" /></div>
              <div><label className={label}>Reference / UTR No</label>
                <input name="reference_no" value={form.reference_no} onChange={change} className={input} placeholder="R0233871" /></div>
              <div><label className={label}>Cheque No</label>
                <input name="cheque_no" value={form.cheque_no} onChange={change} className={input} /></div>
              <div><label className={label}>Cheque Date</label>
                <input type="date" name="cheque_date" value={form.cheque_date} onChange={change} className={input} /></div>
              <div><label className={label}>Cheque Status</label>
                <select name="cheque_status" value={form.cheque_status} onChange={change} className={input}>
                  {['ISSUED', 'PRESENTED', 'CLEARED', 'CANCELLED', 'BOUNCED'].map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
                </select></div>
              <div><label className={label}>Approval Status</label>
                <select name="approval_status" value={form.approval_status} onChange={change} className={input}>
                  <option value="DRAFT">Draft</option><option value="PENDING">Pending Approval</option><option value="APPROVED">Approved</option><option value="PAID">Paid</option></select></div>
              <div><label className={label}>Reconciliation</label>
                <select name="reconciliation_status" value={form.reconciliation_status} onChange={change} className={input}>
                  <option value="UNRECONCILED">Unreconciled</option><option value="RECONCILED">Reconciled</option></select></div>
              <div className="md:col-span-2 lg:col-span-3"><label className={label}>Narration / Remarks</label>
                <textarea name="narration" value={form.narration} onChange={change} rows={2} className={input} /></div>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving...' : 'Save Payment'}</button>
          </div>
        </form>
      </div>
    </MainLayout>
  );
}
