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

export default function BankReceiptNew() {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const { data: customers } = useApiData('/api/customers/');
  const { data: accounts } = useApiData('/api/bank/accounts/');
  const [form, setForm] = useState({
    voucher_no: '', receipt_date: '', customer: '', against_invoice: '', bank_account: '',
    payment_mode: 'NEFT', amount: '', tds_deducted: '', bank_charges: '', reference_no: '',
    instrument_no: '', instrument_date: '', clearing_status: 'PENDING',
    reconciliation_status: 'UNRECONCILED', narration: '',
  });

  const change = (e) => setForm((p) => ({ ...p, [e.target.name]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      await apiClient.post('/api/bank/receipts/', cleanFormData(form));
      toast.success('Receipt voucher created!');
      navigate('/bank/receipts');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  const breadcrumbs = [{ label: 'Bank', href: '/bank/dashboard' }, { label: 'Sales · Receipts', href: '/bank/receipts' }, { label: 'New Receipt' }];

  return (
    <MainLayout>
      <PageHeader title="New Receipt Voucher" subtitle="Dr Bank / Cr Customer" breadcrumbs={breadcrumbs} />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={submit} className="space-y-4 sm:space-y-5">
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Receipt</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div><label className={label}>Voucher No <span className="text-red-500">*</span></label>
                <input name="voucher_no" value={form.voucher_no} onChange={change} required className={input} placeholder="RCP-2026-0012" /></div>
              <div><label className={label}>Receipt Date <span className="text-red-500">*</span></label>
                <input type="date" name="receipt_date" value={form.receipt_date} onChange={change} required className={input} /></div>
              <div><label className={label}>Customer (Cr) <span className="text-red-500">*</span></label>
                <select name="customer" value={form.customer} onChange={change} required className={input}>
                  <option value="">Select customer…</option>
                  {(customers || []).map((c) => <option key={c.id} value={c.id}>{c.customer_name || c.name}</option>)}
                </select></div>
              <div><label className={label}>Against Invoice</label>
                <input name="against_invoice" value={form.against_invoice} onChange={change} className={input} placeholder="INV-0042" /></div>
              <div><label className={label}>Received in Bank A/C (Dr) <span className="text-red-500">*</span></label>
                <select name="bank_account" value={form.bank_account} onChange={change} required className={input}>
                  <option value="">Select account…</option>
                  {(accounts || []).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.bank_name} {a.branch}</option>)}
                </select></div>
              <div><label className={label}>Payment Mode</label>
                <select name="payment_mode" value={form.payment_mode} onChange={change} className={input}>
                  {['NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE', 'DD', 'CASH'].map((m) => <option key={m} value={m}>{m}</option>)}
                </select></div>
            </div>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Amount &amp; Clearing</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div><label className={label}>Amount Received <span className="text-red-500">*</span></label>
                <input type="number" step="0.01" name="amount" value={form.amount} onChange={change} required className={input} placeholder="0.00" /></div>
              <div><label className={label}>TDS Deducted by Customer</label>
                <input type="number" step="0.01" name="tds_deducted" value={form.tds_deducted} onChange={change} className={input} placeholder="0.00" /></div>
              <div><label className={label}>Bank Charges</label>
                <input type="number" step="0.01" name="bank_charges" value={form.bank_charges} onChange={change} className={input} placeholder="0.00" /></div>
              <div><label className={label}>Reference / UTR No</label>
                <input name="reference_no" value={form.reference_no} onChange={change} className={input} placeholder="N0423119" /></div>
              <div><label className={label}>Cheque / DD No</label>
                <input name="instrument_no" value={form.instrument_no} onChange={change} className={input} /></div>
              <div><label className={label}>Instrument Date</label>
                <input type="date" name="instrument_date" value={form.instrument_date} onChange={change} className={input} /></div>
              <div><label className={label}>Clearing Status</label>
                <select name="clearing_status" value={form.clearing_status} onChange={change} className={input}>
                  <option value="PENDING">Pending</option><option value="CLEARED">Cleared</option><option value="BOUNCED">Bounced</option></select></div>
              <div><label className={label}>Reconciliation</label>
                <select name="reconciliation_status" value={form.reconciliation_status} onChange={change} className={input}>
                  <option value="UNRECONCILED">Unreconciled</option><option value="RECONCILED">Reconciled</option></select></div>
              <div className="md:col-span-2 lg:col-span-3"><label className={label}>Narration / Remarks</label>
                <textarea name="narration" value={form.narration} onChange={change} rows={2} className={input} /></div>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving...' : 'Save Receipt'}</button>
          </div>
        </form>
      </div>
    </MainLayout>
  );
}
