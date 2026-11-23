import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useLookup from '../../../hooks/useLookup.js';
import EditGate from '../../../components/common/EditGate.jsx';

export default function UploadBankStatement() {
  const navigate = useNavigate();
  // `side` scopes the whole flow to one half of the statement. A CSV carries
  // both — credits are customer receipts, debits are vendor payments — but the
  // person doing payables should not have to read past the receipts to find
  // their rows, and vice versa. Carried through to the report so the results
  // land already filtered to the side the user came in from. Absent = both,
  // which is the Bank module's own view.
  const [params] = useSearchParams();
  const side = params.get('side') || '';
  const { canCreate } = usePermissions();
  const editable = canCreate('Reconcile Statement');
  // `real_bank=1` excludes the non-bank BankAccount rows an older Tally
  // import created for every ledger leg it saw (TDS/GST payables, expense
  // heads, even literal party names) — without it, a real bank statement
  // upload target picker was 48 of 56 entries wide of anything you'd
  // actually pick. Label combines the short code with the full name — the
  // code alone is too terse to recognise, the name alone is too long to
  // scan a list of.
  const { options: bankAccountOptions } = useLookup('/api/bank/accounts/?real_bank=1', {
    labelField: (item) => `${item.code} · ${item.nickname}`, valueField: 'id',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    bank_account: '',
    statement_period_start: '',
    statement_period_end: '',
    remarks: '',
  });
  const [file, setFile] = useState(null);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleFileChange = (e) => {
    setFile(e.target.files[0] || null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) {
      toast.error('Choose a statement file first.');
      return;
    }
    setIsLoading(true);
    try {
      const payload = new FormData();
      Object.entries(formData).forEach(([key, val]) => payload.append(key, val));
      payload.append('statement_file', file);
      const { data } = await apiClient.post('/api/finance/bank-statements/', payload, {
        headers: { 'Content-Type': 'multipart/form-data' },
        // A scanned/photographed statement goes through Gemini vision on
        // upload, with one automatic retry server-side on a transient
        // failure (confirmed live: a "504 Stream cancelled" from Gemini's
        // own infrastructure, ~183s in, right at the old 180s budget with
        // zero margin on either side). This must stay comfortably above the
        // backend's own worst case (up to two 280s attempts) or the
        // frontend gives up and shows a generic "Network error" for a
        // request that actually succeeded moments later on the server.
        timeout: 700000,
      });
      if (data.parsing_status === 'ERROR') {
        toast.error(data.parse_error || 'Could not read this statement — see the row for details.');
      } else {
        toast.success('Statement uploaded and reconciled!');
      }
      navigate(`/bank/reconcile/${data.id}${side ? `?side=${side}` : ''}`);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Upload Bank Statement"
        breadcrumbs={[
          { label: 'Bank', path: '/bank/dashboard' },
          { label: 'Reconcile Statement', path: '/bank/reconcile' },
          { label: 'Upload' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Statement Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Bank Account <span className="text-red-500">*</span>
                </label>
                <CustomSelect
                  name="bank_account"
                  value={formData.bank_account}
                  onChange={handleChange}
                  required
                  placeholder="Select bank account"
                  className="w-full"
                >
                  {bankAccountOptions.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Statement Period Start <span className="text-red-500">*</span>
                </label>
                <CustomDatePicker
                  name="statement_period_start"
                  value={formData.statement_period_start}
                  onChange={handleChange}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Statement Period End <span className="text-red-500">*</span>
                </label>
                <CustomDatePicker
                  name="statement_period_end"
                  value={formData.statement_period_end}
                  onChange={handleChange}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Statement File <span className="text-red-500">*</span>
                </label>
                <input
                  type="file"
                  name="statement_file"
                  accept=".csv,.xlsx,.xls,.pdf,.png,.jpg,.jpeg"
                  onChange={handleFileChange}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 file:mr-4 file:py-1 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-primary-50 file:text-primary-700 hover:file:bg-primary-100"
                />
                <p className="text-xs text-slate-500 mt-1">
                  CSV or Excel export, or a PDF/photo of the statement — a scan is read automatically.
                </p>
              </div>
              <div className="col-span-2 md:col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">Remarks</label>
                <textarea
                  name="remarks"
                  value={formData.remarks}
                  onChange={handleChange}
                  rows={3}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Enter remarks"
                />
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
            >
              {isLoading ? 'Uploading & reconciling…' : 'Upload'}
            </button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
