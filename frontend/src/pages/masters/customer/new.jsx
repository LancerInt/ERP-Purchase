import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { panFromGstin } from '../../../utils/gst.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import EditGate from '../../../components/common/EditGate.jsx';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import AddressField from '../../../components/common/AddressField';
import { GST_TREATMENT_OPTIONS } from '../../../constants/gstTreatment.js';
import { pickPartyLink } from '@/components/common/partyLinkPicker';

export default function CreateCustomer() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Customer');
  const { options: companies } = useLookup('/api/companies/');
  const [isLoading, setIsLoading] = useState(false);
  // Live preview of the CUS-### code that will be assigned on save (global
  // sequence, so no company needed). Indicative — the real code is set on save.
  const [nextCode, setNextCode] = useState('');

  useEffect(() => {
    let cancelled = false;
    apiClient.get('/api/customers/next-code/')
      .then((res) => { if (!cancelled) setNextCode(res.data?.code || ''); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const [formData, setFormData] = useState({
    customer_code: '',
    customer_name: '',
    company: '',
    gstin: '',
    pan: '',
    gst_treatment: '',
    billing_address: '',
    credit_terms: '',
    custom_credit_days: '',
    credit_terms_effective_from: '',
    contact_person: '',
    contact_email: '',
    contact_phone: '',
    freight_split_notes: '',
    active_flag: true,
    allow_multi_po_consolidation: false,
    customer_type: 'DIRECT',   // Direct (default) / Export / Maize
    // This customer is also a vendor — on save the server creates-or-links a
    // Vendor master and wires both directions (see party_linking). Gated by a
    // picker that previews an exact match / loose suggestions / create-new.
    is_also_vendor: false,
    // Specific counterpart chosen in the picker (links to THAT vendor).
    link_to_vendor_id: null,
    notes: '',
  });

  const [shippingAddresses, setShippingAddresses] = useState([{ address_label: '', address: '', contact_person: '', contact_phone: '' }]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => {
      const next = { ...prev, [name]: type === 'checkbox' ? checked : value };
      // Auto-fill PAN from the GSTIN (PAN is chars 3–12) while PAN is blank.
      if (name === 'gstin' && !(prev.pan || '').trim()) {
        const derivedPan = panFromGstin(value);
        if (derivedPan) next.pan = derivedPan;
      }
      return next;
    });
  };

  // "Also a vendor" checkbox. Only unchecked→checked opens the picker: exact
  // deterministic match, else loose suggestions, else plain create. Picking a
  // row links to THAT vendor (link_to_vendor_id); "Create new" leaves it null
  // and the server auto-matches-or-creates. Cancel reverts. Unchecking silent.
  const handleAlsoVendorToggle = async (e) => {
    const checked = e.target.checked;
    if (!checked) {
      setFormData(prev => ({ ...prev, is_also_vendor: false, link_to_vendor_id: null }));
      return;
    }
    const gstin = (formData.gstin || '').trim();
    const pan = (formData.pan || '').trim();
    const name = (formData.customer_name || '').trim();
    let preview = null;
    try {
      const { data } = await apiClient.get('/api/master/party-match/', {
        params: { role: 'vendor', company: formData.company, gstin, pan, name },
      });
      preview = data;
    } catch {
      preview = null;
    }
    const res = await pickPartyLink({ counterpart: 'vendor', preview, name, gstin, pan });
    if (res.action === 'cancel') return;
    setFormData(prev => ({
      ...prev,
      is_also_vendor: true,
      link_to_vendor_id: res.action === 'link' ? res.id : null,
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // The named terms already cover 15/30/45/60, so a custom value equal to
    // one of them is really that named term — block it and point there, to
    // keep "CUSTOM-30" out of the data when NET_30 means the same thing.
    const _cd = Number(formData.custom_credit_days);
    if (formData.credit_terms === 'CUSTOM' && [15, 30, 45, 60].includes(_cd)) {
      toast.error(`${_cd} days is already NET_${_cd} — choose it under Credit Terms instead of Custom.`);
      return;
    }
    setIsLoading(true);
    try {
      const payload = cleanFormData(formData);
      // billing_address comes back from AddressField as a JSON string.
      // The model's JSONField expects an object — parse here so the
      // serializer accepts it instead of erroring with "Value must be
      // valid JSON".
      if (typeof payload.billing_address === 'string' && payload.billing_address) {
        try { payload.billing_address = JSON.parse(payload.billing_address); }
        catch { payload.billing_address = { full: payload.billing_address }; }
      }
      payload.shipping_addresses = shippingAddresses.filter(sa => sa.address || sa.address_label).map(sa => {
        let addr = sa.address || '';
        if (typeof addr === 'string' && addr) {
          try { addr = JSON.parse(addr); } catch { addr = { full: addr }; }
        }
        return {
          address_label: sa.address_label || '',
          address: addr || {},
          contact_person: sa.contact_person || '',
          contact_phone: sa.contact_phone || '',
        };
      });
      await apiClient.post('/api/customers/', payload);
      toast.success('Customer created successfully!');
      navigate(-1);
    } catch (error) {
      if (import.meta.env.DEV) console.error('[CreateCustomer] error:', error.response?.data);
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Customer"
        subtitle="Add a new customer record"
        breadcrumbs={[
          { label: 'Masters', href: '/masters' },
          { label: 'Customer', href: '/masters/customer' },
          { label: 'Create New' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
          {/* Section: Basic Information */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Basic Information</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Customer Code</label>
                {/* Live preview: CUS-### (global sequence). Auto-assigned on save. */}
                <input type="text" value={nextCode || 'Generating…'} disabled className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-100 text-slate-600 cursor-not-allowed" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Customer Name <span className="text-red-500">*</span></label>
                <input type="text" name="customer_name" value={formData.customer_name} onChange={handleChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter customer name" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
                <CustomSelect name="company" value={formData.company} onChange={handleChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select...</option>
                  {companies.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
            </div>
          </div>

          {/* Section: Tax & Compliance */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Tax & Compliance</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">GSTIN</label>
                <input type="text" name="gstin" value={formData.gstin} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter GSTIN" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">PAN</label>
                <input type="text" name="pan" value={formData.pan} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter PAN" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">GST Treatment</label>
                <CustomSelect name="gst_treatment" value={formData.gst_treatment} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select GST treatment</option>
                  {GST_TREATMENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
            </div>
          </div>

          {/* Section: Billing Address — single per customer, stored
              on the Customer record itself. AddressField handles the
              line / city / state / pincode / country parsing and
              writes the result back as a JSON string. */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Billing Address</h3>
            <AddressField
              value={formData.billing_address}
              onChange={(v) => setFormData(prev => ({ ...prev, billing_address: v }))}
            />
          </div>

          {/* Section: Shipping Addresses */}
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b">
              <h3 className="text-lg font-semibold text-slate-800">Shipping Addresses</h3>
              <button type="button" onClick={() => setShippingAddresses(prev => [...prev, { address_label: '', address: '', contact_person: '', contact_phone: '' }])}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-100"><Plus size={16} /> Add Address</button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              {shippingAddresses.map((sa, idx) => (
                <div key={idx} className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-semibold text-blue-800">Address #{idx + 1}</h4>
                    {shippingAddresses.length > 1 && (
                      <button type="button" onClick={() => setShippingAddresses(prev => prev.filter((_, i) => i !== idx))} className="text-red-500 hover:text-red-700"><Trash2 size={14} /></button>
                    )}
                  </div>
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                      <div><label className="block text-xs font-medium text-slate-600 mb-1">Label</label>
                        <input type="text" value={sa.address_label} onChange={(e) => setShippingAddresses(prev => prev.map((s, i) => i === idx ? { ...s, address_label: e.target.value } : s))} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500" placeholder="e.g. Head Office, Factory, Branch" /></div>
                      <div><label className="block text-xs font-medium text-slate-600 mb-1">Contact Person</label>
                        <input type="text" value={sa.contact_person} onChange={(e) => setShippingAddresses(prev => prev.map((s, i) => i === idx ? { ...s, contact_person: e.target.value } : s))} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500" /></div>
                      <div><label className="block text-xs font-medium text-slate-600 mb-1">Contact Phone</label>
                        <input type="text" value={sa.contact_phone} onChange={(e) => setShippingAddresses(prev => prev.map((s, i) => i === idx ? { ...s, contact_phone: e.target.value } : s))} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500" /></div>
                    </div>
                    <AddressField value={sa.address} onChange={(v) => setShippingAddresses(prev => prev.map((s, i) => i === idx ? { ...s, address: v } : s))} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Section: Credit & Freight */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Credit & Freight</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Credit Terms <span className="text-red-500">*</span></label>
                <CustomSelect name="credit_terms" value={formData.credit_terms} onChange={handleChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select...</option>
                  <option value="CASH">Cash (due on invoice)</option>
                  <option value="NET_15">Net 15</option>
                  <option value="NET_30">Net 30</option>
                  <option value="NET_45">Net 45</option>
                  <option value="NET_60">Net 60</option>
                  <option value="CUSTOM">Custom</option>
                </CustomSelect>
              </div>
              {/* Custom Credit Days only renders when Credit Terms is
                  CUSTOM. Hidden otherwise so the form stays compact
                  and the user can't save stray days against NET_15/30/45.
                  `freight_terms` and `default_warehouse` previously
                  lived in this row — removed per user request. Freight
                  is captured per-SO; warehouse is picked explicitly on
                  every SO. */}
              {formData.credit_terms === 'CUSTOM' && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Custom Credit Days <span className="text-red-500">*</span></label>
                  <input type="number" name="custom_credit_days" value={formData.custom_credit_days} onChange={handleChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter custom days" />
                  <p className="text-[11px] text-slate-500 mt-1">Days of credit. 0 = due on the bill date; blank = terms not set.</p>
                  {[15, 30, 45, 60].includes(Number(formData.custom_credit_days)) && (
                    <p className="text-[11px] text-red-600 mt-1">{formData.custom_credit_days} days is NET_{formData.custom_credit_days} — pick it under Credit Terms instead of Custom.</p>
                  )}
                </div>
              )}
              {/* The date these terms start deciding due dates. Undated terms
                  are ignored on purpose — credit_terms is Net 30 on every
                  master the Tally importer creates. */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Terms Effective From</label>
                <div className="flex items-center gap-2">
                  <input type="date" name="credit_terms_effective_from" value={formData.credit_terms_effective_from} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
                  <button type="button"
                    onClick={() => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; setFormData(prev => ({ ...prev, credit_terms_effective_from: `${y}-04-01` })); }}
                    className="px-3 py-2 text-sm whitespace-nowrap rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50"
                    title="Set to 1 April of the current financial year">FY start</button>
                </div>
                <p className="text-[11px] text-slate-500 mt-1">Applies to invoices dated on or after this. Blank = terms not in force.</p>
              </div>
              <div className="col-span-2 md:col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">Freight Split Notes</label>
                <textarea name="freight_split_notes" value={formData.freight_split_notes} onChange={handleChange} rows={3} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter freight split notes" />
              </div>
            </div>
          </div>

          {/* Section: Contact Information */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Contact Information</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Contact Person</label>
                <input type="text" name="contact_person" value={formData.contact_person} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter contact person" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Contact Email</label>
                <input type="email" name="contact_email" value={formData.contact_email} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter contact email" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Contact Phone</label>
                <input type="text" name="contact_phone" value={formData.contact_phone} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter contact phone" />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" name="active_flag" checked={formData.active_flag} onChange={handleChange} className="rounded border-slate-300" />
                <label className="text-sm text-slate-700">Active</label>
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" name="allow_multi_po_consolidation" checked={formData.allow_multi_po_consolidation} onChange={handleChange} className="rounded border-slate-300" />
                <label className="text-sm text-slate-700" title="Lets this customer's POs be clubbed line-by-line into one SO via the Multi-PO Sales Order screen">Allow multi-PO consolidation</label>
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" name="is_also_vendor" checked={formData.is_also_vendor} onChange={handleAlsoVendorToggle} className="rounded border-slate-300" />
                <label className="text-sm text-slate-700" title="This party is also a vendor — a linked Vendor master is created or matched on save">Also a vendor</label>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1" title="Direct = domestic (default). Export = overseas / out-of-India (drives the Domestic/Export filter in Sales Analytics). Maize = maize customer.">Customer type</label>
                <CustomSelect name="customer_type" value={formData.customer_type} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="DIRECT">Direct Customer</option>
                  <option value="EXPORT">Export Customer</option>
                  <option value="MAIZE">Maize</option>
                </CustomSelect>
              </div>
            </div>
          </div>

          {/* Section: Additional */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Additional</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="col-span-2 md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
                <textarea name="notes" value={formData.notes} onChange={handleChange} rows={3} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving...' : 'Save'}</button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
