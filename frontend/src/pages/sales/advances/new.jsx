import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
/**
 * Customer Advance — create page.
 *
 * Captures pre-invoice money from a customer. Once saved, the advance
 * sits with `balance_unused = amount` until invoices are raised — at
 * which point the detail page's Apply panel draws it down against
 * specific ReceivableLedger rows.
 *
 * Form layout is mobile-first: single column on phones, 2-col grid on
 * md+ for the basic info section.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const readOnlyClass = 'w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-slate-50 text-slate-600';

const todayISO = () => new Date().toISOString().slice(0, 10);

export default function CreateCustomerAdvance() {
  const navigate = useNavigate();
  const { options: companyOptions } = useLookup('/api/companies/');
  const [isLoading, setIsLoading] = useState(false);
  const [advanceNo, setAdvanceNo] = useState('');
  const [errors, setErrors] = useState({});

  const [formData, setFormData] = useState({
    customer: '',
    company: '',
    received_date: todayISO(),
    amount: '',
    payment_mode: 'BANK',
    reference_no: '',
    notes: '',
  });
  const { options: customerOptions } = useLookup(formData.company ? `/api/customers/?company=${formData.company}` : null); // customers scoped to the selected company

  // Pre-fetch the next ADV number purely for display — the backend
  // re-generates on save so this is a hint, not a binding value.
  useEffect(() => {
    apiClient.get('/api/sales/advances/next-number/')
      .then(r => setAdvanceNo(r.data?.number || ''))
      .catch(() => {});
  }, []);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    if (errors[name]) setErrors(prev => ({ ...prev, [name]: '' }));
  };

  const validate = () => {
    const e = {};
    if (!formData.customer) e.customer = 'Customer is required.';
    if (!formData.received_date) e.received_date = 'Received date is required.';
    const amt = parseFloat(formData.amount);
    if (!formData.amount || !Number.isFinite(amt) || amt <= 0) e.amount = 'Enter a positive amount.';
    if (!formData.payment_mode) e.payment_mode = 'Payment mode is required.';
    if (!formData.reference_no || !formData.reference_no.trim()) e.reference_no = 'Reference number is required.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (ev) => {
    ev.preventDefault();
    if (!validate()) return;
    setIsLoading(true);
    try {
      const payload = {
        customer: formData.customer,
        company: formData.company || null,
        received_date: formData.received_date,
        amount: formData.amount,
        payment_mode: formData.payment_mode,
        reference_no: formData.reference_no || '',
        notes: formData.notes || '',
      };
      const res = await apiClient.post('/api/sales/advances/', payload);
      toast.success(`Advance ${res.data?.advance_no || ''} recorded.`);
      // Defensive: bail out to the list if the response somehow
      // doesn't carry an id (older backends without the create-
      // serializer fix would have shipped {advance_no, ...} only
      // and the redirect would have built /sales/advances/undefined).
      const newId = res.data?.id;
      if (newId) {
        navigate(`/sales/advances/${newId}`);
      } else {
        navigate('/sales/advances');
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to record advance.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Record Customer Advance"
        subtitle="Capture pre-invoice money from a customer; apply it later against specific invoices"
        breadcrumbs={[
          { label: 'Sales' },
          { label: 'Customer Advances', href: '/sales/advances' },
          { label: 'New' },
        ]}
      />

      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-6">
        <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-6" noValidate>
          {/* Basic Information */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Basic Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Advance No</label>
                <input type="text" value={advanceNo} readOnly className={readOnlyClass} placeholder="Auto-generating…" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Customer <span className="text-red-500">*</span></label>
                <CustomSelect name="customer" value={formData.customer} onChange={handleChange} className={`${inputClass} ${errors.customer ? 'border-red-300' : ''}`}>
                  <option value="">Select Customer</option>
                  {customerOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
                {errors.customer && <p className="text-xs text-red-600 mt-1">{errors.customer}</p>}
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company</label>
                <CustomSelect name="company" value={formData.company} onChange={handleChange} className={inputClass}>
                  <option value="">Select Company</option>
                  {companyOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Received Date <span className="text-red-500">*</span></label>
                <CustomDatePicker name="received_date" value={formData.received_date} onChange={handleChange} max={todayISO()}
                  className={`${inputClass} ${errors.received_date ? 'border-red-300' : ''}`} />
                {errors.received_date && <p className="text-xs text-red-600 mt-1">{errors.received_date}</p>}
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Amount (₹) <span className="text-red-500">*</span></label>
                <input type="number" step="0.01" min="0.01" name="amount" value={formData.amount} onChange={handleChange}
                  className={`${inputClass} ${errors.amount ? 'border-red-300' : ''}`} placeholder="0.00" />
                {errors.amount && <p className="text-xs text-red-600 mt-1">{errors.amount}</p>}
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Payment Mode <span className="text-red-500">*</span></label>
                <CustomSelect name="payment_mode" value={formData.payment_mode} onChange={handleChange} className={inputClass}>
                  <option value="CASH">Cash</option>
                  <option value="BANK">Bank Transfer</option>
                  <option value="UPI">UPI</option>
                  <option value="CHEQUE">Cheque</option>
                  <option value="NEFT">NEFT</option>
                  <option value="RTGS">RTGS</option>
                  <option value="OTHER">Other</option>
                </CustomSelect>
              </div>
              <div className="col-span-2 md:col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">Reference No / Transaction ID <span className="text-red-500">*</span></label>
                <input type="text" name="reference_no" value={formData.reference_no} onChange={handleChange}
                  className={inputClass} placeholder="Cheque no, UTR, txn id…" />
                {errors.reference_no && <p className="text-xs text-red-500 mt-1">{errors.reference_no}</p>}
              </div>
              <div className="col-span-2 md:col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
                <textarea name="notes" value={formData.notes} onChange={handleChange} rows={3}
                  className={inputClass} placeholder="Any context — e.g. 'Advance against PO XYZ for the bucket order'" />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-row justify-end gap-2 pt-4 border-t">
            <button type="button" onClick={() => navigate('/sales/advances')}
              className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
              Cancel
            </button>
            <button type="submit" disabled={isLoading}
              className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">
              {isLoading ? 'Saving…' : 'Record Advance'}
            </button>
          </div>
        </form>
      </div>
    </MainLayout>
  );
}
