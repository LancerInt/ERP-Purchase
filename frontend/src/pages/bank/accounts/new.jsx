import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';

const input = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const label = 'block text-sm font-medium text-slate-700 mb-1';

export default function BankAccountNew() {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [form, setForm] = useState({
    code: '', nickname: '', bank_name: 'ICICI Bank', branch: '', account_number: '',
    category: 'PRIMARY', account_type: 'CURRENT', ifsc_code: '', swift_bic: '',
    currency: 'INR', opening_balance: '', gl_account: '', status: 'ACTIVE',
    internal_alias: '',
  });

  const change = (e) => setForm((p) => ({ ...p, [e.target.name]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      await apiClient.post('/api/bank/accounts/', cleanFormData(form));
      toast.success('Bank account created!');
      navigate('/bank/accounts');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  const breadcrumbs = [{ label: 'Bank', href: '/bank/dashboard' }, { label: 'Bank Accounts', href: '/bank/accounts' }, { label: 'New Account' }];

  return (
    <MainLayout>
      <PageHeader title="New Bank Account" breadcrumbs={breadcrumbs} />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={submit} className="space-y-4 sm:space-y-5">
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Account Details</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div><label className={label}>Account Code <span className="text-red-500">*</span></label>
                <input name="code" value={form.code} onChange={change} required className={input} placeholder="BANK-006" /></div>
              <div><label className={label}>Nickname</label>
                <input name="nickname" value={form.nickname} onChange={change} className={input} placeholder="e.g. ICICI Current" /></div>
              <div><label className={label}>Internal Alias</label>
                <input name="internal_alias" value={form.internal_alias} onChange={change} className={input} placeholder="e.g. CREDITOR — leave blank if not swept to/from" /></div>
              <div><label className={label}>Bank Name</label>
                <input name="bank_name" value={form.bank_name} onChange={change} className={input} /></div>
              <div><label className={label}>Branch</label>
                <input name="branch" value={form.branch} onChange={change} className={input} placeholder="Ambattur" /></div>
              <div><label className={label}>Account Number <span className="text-red-500">*</span></label>
                <input name="account_number" value={form.account_number} onChange={change} required className={input} placeholder="0234 5012 3456" /></div>
              <div><label className={label}>Category</label>
                <select name="category" value={form.category} onChange={change} className={input}>
                  <option value="PRIMARY">Primary</option><option value="SECONDARY">Secondary</option></select></div>
              <div><label className={label}>Account Type</label>
                <select name="account_type" value={form.account_type} onChange={change} className={input}>
                  <option value="CURRENT">Current</option><option value="SAVINGS">Savings</option><option value="CC_OD">CC / OD</option></select></div>
              <div><label className={label}>IFSC Code</label>
                <input name="ifsc_code" value={form.ifsc_code} onChange={change} className={input} placeholder="ICIC0000234" /></div>
              <div><label className={label}>SWIFT / BIC</label>
                <input name="swift_bic" value={form.swift_bic} onChange={change} className={input} placeholder="intl only" /></div>
              <div><label className={label}>Currency</label>
                <select name="currency" value={form.currency} onChange={change} className={input}>
                  <option>INR</option><option>USD</option><option>EUR</option></select></div>
              <div><label className={label}>Opening Balance</label>
                <input type="number" step="0.01" name="opening_balance" value={form.opening_balance} onChange={change} className={input} placeholder="0.00" /></div>
              <div><label className={label}>GL / Ledger Account</label>
                <input name="gl_account" value={form.gl_account} onChange={change} className={input} placeholder="1001 · Cash at Bank" /></div>
              <div><label className={label}>Status</label>
                <select name="status" value={form.status} onChange={change} className={input}>
                  <option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></div>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving...' : 'Save Account'}</button>
          </div>
        </form>
      </div>
    </MainLayout>
  );
}
