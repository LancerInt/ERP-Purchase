import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomSelect from '@/components/ui/CustomSelect';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const label = 'block text-sm font-medium text-slate-700 mb-1';
const today = () => new Date().toISOString().slice(0, 10);

const TYPE_OPTIONS = [
  { value: 'LOCAL_FREIGHT', label: 'Local Freight' },
  { value: 'STOCK_TRANSFER', label: 'Stock Transfer' },
  { value: 'UNLOADING_CHARGES', label: 'Unloading Charges' },
  { value: 'INWARD_CHARGES', label: 'Inward Charges' },
  { value: 'OUTWARD_CHARGES', label: 'Outward Charges' },
];

// For each type, the "Received" field lists the relevant document's numbers.
// Local Freight has no source doc → free text.
const RECEIVED_SOURCE = {
  INWARD_CHARGES:    { endpoint: '/api/purchase/receipts/',   field: 'receipt_advice_no', placeholder: 'Select Receipt (GRN)' },
  UNLOADING_CHARGES: { endpoint: '/api/purchase/receipts/',   field: 'receipt_advice_no', placeholder: 'Select Receipt (GRN)' },
  OUTWARD_CHARGES:   { endpoint: '/api/sales/dc/',            field: 'dc_no',             placeholder: 'Select Dispatch Challan' },
  STOCK_TRANSFER:    { endpoint: '/api/inventory/transfers/', field: 'transfer_no',       placeholder: 'Select Stock Transfer' },
};

export default function LocalFreightNew() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Local Freight');
  const [saving, setSaving] = useState(false);
  const { options: companyOptions } = useLookup('/api/companies/');
  const { options: transporterOptions } = useLookup('/api/transporters/');

  const [form, setForm] = useState({
    received: '', date: today(), company: '', factory: '', freight_type: 'LOCAL_FREIGHT',
    total_quantity: '', bill_no: '', bill_date: '', lorry_no: '', transporter: '',
    freight_amount: '0', amount_pay: '0', payment_mode: '', remarks: '',
    additional_freight_amount: '0', less_amount: '0', tds_less: '0',
  });
  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  // Factory (warehouse) list scoped to the chosen company.
  const { options: factoryOptions } = useLookup(form.company ? `/api/warehouses/?company=${form.company}` : '/api/warehouses/');

  // "Received" source — driven by the selected type. Pull the document's
  // numbers so the dropdown shows the related record no.
  const receivedSrc = RECEIVED_SOURCE[form.freight_type] || null;
  const { raw: receivedRaw } = useLookup(receivedSrc ? receivedSrc.endpoint : null);
  const receivedNumbers = receivedSrc
    ? Array.from(new Set((receivedRaw || []).map((r) => r[receivedSrc.field]).filter(Boolean)))
    : [];

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.company) { toast.error('Company is required.'); return; }
    if (!form.lorry_no.trim()) { toast.error('Lorry No is required.'); return; }
    if (!(parseFloat(form.amount_pay) >= 0)) { toast.error('Amount Pay is required.'); return; }
    if (!form.payment_mode) { toast.error('Payment Mode is required.'); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        factory: form.factory || null,
        transporter: form.transporter || null,
        total_quantity: form.total_quantity === '' ? null : form.total_quantity,
        bill_date: form.bill_date || null,
      };
      await apiClient.post('/api/purchase/local-freight/', payload);
      toast.success('Local Freight saved!');
      navigate('/freight/local');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally { setSaving(false); }
  };

  return (
    <MainLayout>
      <PageHeader title="New Local Freight" breadcrumbs={[{ label: 'Freight', href: '/freight/local' }, { label: 'Local Freight', href: '/freight/local' }, { label: 'New' }]} />
      <form onSubmit={handleSubmit}>
        <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
        <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
            {/* Left column */}
            <div className="space-y-4">
              <div>
                <label className={label}>Received</label>
                {receivedSrc ? (
                  <CustomSelect value={form.received} onChange={(e) => set('received', e.target.value)} className={inputClass}>
                    <option value="">{receivedSrc.placeholder}</option>
                    {receivedNumbers.map((n) => <option key={n} value={n}>{n}</option>)}
                  </CustomSelect>
                ) : (
                  <input type="text" value={form.received} onChange={(e) => set('received', e.target.value)} className={inputClass} placeholder="Received from / by" />
                )}
              </div>
              <div>
                <label className={label}>Date <span className="text-red-500">*</span></label>
                <CustomDatePicker value={form.date} onChange={(e) => set('date', e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={label}>Company <span className="text-red-500">*</span></label>
                <CustomSelect value={form.company} onChange={(e) => { set('company', e.target.value); set('factory', ''); }} className={inputClass}>
                  <option value="">Select Company</option>
                  {companyOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className={label}>Factory</label>
                <CustomSelect value={form.factory} onChange={(e) => set('factory', e.target.value)} className={inputClass}>
                  <option value="">Select Factory</option>
                  {factoryOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className={label}>Total Quantity</label>
                <input type="number" step="any" value={form.total_quantity} onChange={(e) => set('total_quantity', e.target.value)} className={inputClass} placeholder="0.00" />
              </div>
            </div>

            {/* Right column */}
            <div className="space-y-4">
              <div>
                <label className={label}>Select Type <span className="text-red-500">*</span></label>
                <div className="flex flex-wrap gap-x-5 gap-y-2 pt-1">
                  {TYPE_OPTIONS.map((t) => (
                    <label key={t.value} className="flex items-center gap-1.5 text-sm cursor-pointer">
                      <input type="radio" name="freight_type" checked={form.freight_type === t.value} onChange={() => setForm((p) => ({ ...p, freight_type: t.value, received: '' }))} className="accent-primary-600" />
                      {t.label}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className={label}>Bill No</label>
                <input type="text" value={form.bill_no} onChange={(e) => set('bill_no', e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={label}>Bill Date</label>
                <CustomDatePicker value={form.bill_date} onChange={(e) => set('bill_date', e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={label}>Lorry No <span className="text-red-500">*</span></label>
                <input type="text" value={form.lorry_no} onChange={(e) => set('lorry_no', e.target.value)} className={inputClass} placeholder="e.g. TN 30 A 1234" />
              </div>
              <div>
                <label className={label}>Transport Name</label>
                <CustomSelect value={form.transporter} onChange={(e) => set('transporter', e.target.value)} className={inputClass}>
                  <option value="">Select Transporter</option>
                  {transporterOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className={label}>Freight Amount</label>
                <input type="number" step="any" value={form.freight_amount} onChange={(e) => set('freight_amount', e.target.value)} className={inputClass} />
              </div>
            </div>
          </div>
        </div>

        {/* Payment & adjustments */}
        <div className="bg-white rounded-lg border border-slate-200 p-3.5 sm:p-5">
          <h3 className="text-base font-semibold text-slate-800 mb-3 pb-2 border-b">Payment & Adjustments</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div>
              <label className={label}>Amount Pay <span className="text-red-500">*</span></label>
              <input type="number" step="any" value={form.amount_pay} onChange={(e) => set('amount_pay', e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={label}>Payment Mode <span className="text-red-500">*</span></label>
              <CustomSelect value={form.payment_mode} onChange={(e) => set('payment_mode', e.target.value)} className={inputClass}>
                <option value="">Select</option>
                <option value="CASH">Cash</option>
                <option value="BANK">Bank Transfer</option>
                <option value="UPI">UPI</option>
                <option value="CHEQUE">Cheque</option>
                <option value="CREDIT">Credit</option>
              </CustomSelect>
            </div>
            <div>
              <label className={label}>Additional Freight Amount <span className="text-red-500">*</span></label>
              <input type="number" step="any" value={form.additional_freight_amount} onChange={(e) => set('additional_freight_amount', e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={label}>Less Amount <span className="text-red-500">*</span></label>
              <input type="number" step="any" value={form.less_amount} onChange={(e) => set('less_amount', e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={label}>TDS Less <span className="text-red-500">*</span></label>
              <input type="number" step="any" value={form.tds_less} onChange={(e) => set('tds_less', e.target.value)} className={inputClass} />
            </div>
          </div>
          <div className="mt-4">
            <label className={label}>Remarks</label>
            <textarea value={form.remarks} onChange={(e) => set('remarks', e.target.value)} rows={3} className={inputClass} />
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <button type="button" onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/freight/local')} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
          <button type="submit" disabled={saving} className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{saving ? 'Saving…' : 'Save Local Freight'}</button>
        </div>
        </EditGate>
      </form>
    </MainLayout>
  );
}
