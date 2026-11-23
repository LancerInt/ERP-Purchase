import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Trash2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { panFromGstin } from '../../../utils/gst.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import EditGate from '../../../components/common/EditGate.jsx';
import { GST_TREATMENT_OPTIONS } from '../../../constants/gstTreatment.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import AddressField from '../../../components/common/AddressField';
import { confirm } from '@/components/common/confirm';
import { pickPartyLink } from '@/components/common/partyLinkPicker';

const inputClass = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

export default function EditCustomer() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin, canEdit } = usePermissions();
  const editable = canEdit('Customer');
  const { options: companies } = useLookup('/api/companies/');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const [formData, setFormData] = useState({
    customer_code: '', customer_name: '', company: '', gstin: '', pan: '', gst_treatment: '',
    billing_address: '', credit_terms: '', custom_credit_days: '',
    credit_terms_effective_from: '',
    contact_person: '', contact_email: '', contact_phone: '',
    freight_split_notes: '', active_flag: true, allow_multi_po_consolidation: false,
    customer_type: 'DIRECT',   // Direct (default) / Export / Maize
    // Also-a-vendor link (server creates-or-links the counterpart on save).
    is_also_vendor: false, linked_vendor_name: '', link_to_vendor_id: null, notes: '',
  });
  const [shippingAddresses, setShippingAddresses] = useState([]);

  useEffect(() => {
    apiClient.get(`/api/customers/${id}/`).then(r => {
      const d = r.data;
      setFormData({
        customer_code: d.customer_code || '', customer_name: d.customer_name || '',
        // company_name kept around so the dropdown can show the saved
        // selection even before useLookup loads / when the FK is orphan.
        company: d.company || '', company_name: d.company_name || '',
        gstin: d.gstin || '', pan: d.pan || '', gst_treatment: d.gst_treatment || '',
        billing_address: d.billing_address ? (typeof d.billing_address === 'object' ? JSON.stringify(d.billing_address) : d.billing_address) : '',
        credit_terms: d.credit_terms || '', custom_credit_days: d.custom_credit_days ?? '',
        credit_terms_effective_from: d.credit_terms_effective_from || '',
        contact_person: d.contact_person || '', contact_email: d.contact_email || '',
        contact_phone: d.contact_phone || '', freight_split_notes: d.freight_split_notes || '',
        active_flag: d.active_flag !== false, allow_multi_po_consolidation: !!d.allow_multi_po_consolidation,
        customer_type: d.customer_type || (d.is_export ? 'EXPORT' : 'DIRECT'),
        is_also_vendor: !!d.is_also_vendor, linked_vendor_name: d.linked_vendor_name || '', link_to_vendor_id: null, notes: d.notes || '',
      });
      const addrs = (d.shipping_addresses || []).map(sa => ({
        address_label: sa.address_label || '', contact_person: sa.contact_person || '', contact_phone: sa.contact_phone || '',
        address: sa.address ? (typeof sa.address === 'object' ? JSON.stringify(sa.address) : sa.address) : '',
      }));
      setShippingAddresses(addrs.length > 0 ? addrs : [{ address_label: '', address: '', contact_person: '', contact_phone: '' }]);
    }).catch(() => { toast.error('Failed to load'); navigate(-1); })
    .finally(() => setIsLoading(false));
  }, [id]);

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

  // "Also a vendor" checkbox — same picker flow as customer/new. Already-linked
  // customers skip the picker (re-tick just keeps it on).
  const handleAlsoVendorToggle = async (e) => {
    const checked = e.target.checked;
    if (!checked) {
      setFormData(prev => ({ ...prev, is_also_vendor: false }));
      return;
    }
    if (formData.linked_vendor_name) {
      setFormData(prev => ({ ...prev, is_also_vendor: true }));
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
    setIsSaving(true);
    try {
      const payload = { ...formData };
      // linked_vendor_name is a read-only display field — never send it back.
      delete payload.linked_vendor_name;
      // Ensure required fields have defaults
      if (!payload.credit_terms) payload.credit_terms = 'NET_30';
      // Remove empty optional fields. `freight_terms` + `default_warehouse`
      // were dropped from the model — see master/models.py.
      ['custom_credit_days', 'billing_address', 'notes',
       'credit_terms_effective_from'].forEach(k => {
        if (payload[k] === '' || payload[k] === null) delete payload[k];
      });
      // Convert billing_address string to JSON if needed
      if (typeof payload.billing_address === 'string' && payload.billing_address) {
        try { payload.billing_address = JSON.parse(payload.billing_address); } catch { payload.billing_address = { full: payload.billing_address }; }
      }
      payload.shipping_addresses = shippingAddresses.filter(sa => sa.address || sa.address_label).map(sa => {
        let addr = sa.address || '';
        if (typeof addr === 'string' && addr) {
          try { addr = JSON.parse(addr); } catch { addr = { full: addr }; }
        }
        return { address_label: sa.address_label || '', address: addr || {}, contact_person: sa.contact_person || '', contact_phone: sa.contact_phone || '' };
      });
      await apiClient.put(`/api/customers/${id}/`, payload);
      toast.success('Customer updated!');
      navigate(-1);
    } catch (error) { toast.error(getApiErrorMessage(error)); }
    finally { setIsSaving(false); }
  };

  if (isLoading) return <MainLayout><div className="space-y-4">{[1, 2].map(i => <div key={i} className="h-32 bg-slate-200 rounded animate-pulse" />)}</div></MainLayout>;

  return (
    <MainLayout>
      <PageHeader title={`Edit Customer — ${formData.customer_name}`} breadcrumbs={[
        { label: 'Masters', href: '/masters' }, { label: 'Customer', href: '/masters/customer' },
        { label: formData.customer_name }, { label: 'Edit' },
      ]} />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleSubmit} noValidate>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
          {/* Basic */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Basic Information</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Customer Code *</label>
                <input type="text" name="customer_code" value={formData.customer_code} onChange={handleChange} required className={inputClass} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Customer Name *</label>
                <input type="text" name="customer_name" value={formData.customer_name} onChange={handleChange} required className={inputClass} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Company *</label>
                <CustomSelect name="company" value={formData.company} onChange={handleChange} required className={inputClass}>
                  <option value="">Select...</option>
                  {/* Sticky fallback so the saved company stays visible
                      while useLookup is still fetching / if the FK is
                      orphan. See vendor/edit.jsx for the same pattern. */}
                  {formData.company && !companies.find(c => String(c.value) === String(formData.company)) && (
                    <option value={formData.company}>{formData.company_name || 'Loading…'}</option>
                  )}
                  {companies.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect></div>
            </div>
          </div>

          {/* Tax */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Tax & Compliance</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div><label className="block text-sm font-medium text-slate-700 mb-1">GSTIN</label>
                <input type="text" name="gstin" value={formData.gstin} onChange={handleChange} className={inputClass} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">PAN</label>
                <input type="text" name="pan" value={formData.pan} onChange={handleChange} className={inputClass} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">GST Treatment</label>
                <CustomSelect name="gst_treatment" value={formData.gst_treatment} onChange={handleChange} className={inputClass}>
                  <option value="">Select GST treatment</option>
                  {GST_TREATMENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect></div>
            </div>
          </div>

          {/* Billing Address — single per customer, stored on the
              Customer record itself (separate from the shipping
              addresses list below). The importer drops the parsed
              text in here as { full: '...' } or { line1: '...' }; the
              AddressField widget renders it as editable district /
              state / pincode rows. */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Billing Address</h3>
            <AddressField
              value={formData.billing_address}
              onChange={(v) => setFormData(prev => ({ ...prev, billing_address: v }))}
            />
          </div>

          {/* Shipping Addresses */}
          <div>
            <div className="flex items-center justify-between mb-4 pb-2 border-b">
              <h3 className="text-lg font-semibold text-slate-800">Shipping Addresses ({shippingAddresses.length})</h3>
              <button type="button" onClick={() => setShippingAddresses(prev => [...prev, { address_label: '', address: '', contact_person: '', contact_phone: '' }])}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-100"><Plus size={16} /> Add Address</button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              {shippingAddresses.map((sa, idx) => (
                <div key={idx} className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-semibold text-blue-800">Address #{idx + 1} {sa.address_label && `— ${sa.address_label}`}</h4>
                    {shippingAddresses.length > 1 && <button type="button" onClick={() => setShippingAddresses(prev => prev.filter((_, i) => i !== idx))} className="text-red-500 hover:text-red-700"><Trash2 size={14} /></button>}
                  </div>
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                      <div><label className="block text-xs font-medium text-slate-600 mb-1">Label</label>
                        <input type="text" value={sa.address_label} onChange={(e) => setShippingAddresses(prev => prev.map((s, i) => i === idx ? { ...s, address_label: e.target.value } : s))} className={inputClass} placeholder="e.g. Head Office, Factory" /></div>
                      <div><label className="block text-xs font-medium text-slate-600 mb-1">Contact Person</label>
                        <input type="text" value={sa.contact_person} onChange={(e) => setShippingAddresses(prev => prev.map((s, i) => i === idx ? { ...s, contact_person: e.target.value } : s))} className={inputClass} /></div>
                      <div><label className="block text-xs font-medium text-slate-600 mb-1">Contact Phone</label>
                        <input type="text" value={sa.contact_phone} onChange={(e) => setShippingAddresses(prev => prev.map((s, i) => i === idx ? { ...s, contact_phone: e.target.value } : s))} className={inputClass} /></div>
                    </div>
                    <AddressField value={sa.address} onChange={(v) => setShippingAddresses(prev => prev.map((s, i) => i === idx ? { ...s, address: v } : s))} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Credit & Freight */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Credit & Freight</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Credit Terms</label>
                <CustomSelect name="credit_terms" value={formData.credit_terms} onChange={handleChange} className={inputClass}>
                  <option value="">Select...</option><option value="CASH">Cash (due on invoice)</option><option value="NET_15">Net 15</option><option value="NET_30">Net 30</option><option value="NET_45">Net 45</option><option value="NET_60">Net 60</option><option value="CUSTOM">Custom</option>
                </CustomSelect></div>
              {/* Custom Credit Days renders only when CUSTOM term is
                  picked. `freight_terms` + `default_warehouse` were
                  removed per user request — see model docstring. */}
              {formData.credit_terms === 'CUSTOM' && (
                <div><label className="block text-sm font-medium text-slate-700 mb-1">Custom Credit Days <span className="text-red-500">*</span></label>
                  <input type="number" name="custom_credit_days" value={formData.custom_credit_days} onChange={handleChange} required className={inputClass} />
                  <p className="text-[11px] text-slate-500 mt-1">Days of credit. 0 means due on the bill date. Leave blank to treat the terms as not set.</p>
                  {[15, 30, 45, 60].includes(Number(formData.custom_credit_days)) && (
                    <p className="text-[11px] text-red-600 mt-1">{formData.custom_credit_days} days is NET_{formData.custom_credit_days} — pick it under Credit Terms instead of Custom.</p>
                  )}
                </div>
              )}
              {/* The date the terms start applying. It is what separates
                  "somebody agreed this" from "nobody has touched this row":
                  credit_terms defaults to Net 30 on every master the Tally
                  importer creates, so an undated term is ignored entirely. */}
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Terms Effective From</label>
                <div className="flex items-center gap-2">
                  <input type="date" name="credit_terms_effective_from" value={formData.credit_terms_effective_from} onChange={handleChange} className={inputClass} />
                  <button type="button"
                    onClick={() => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; setFormData(prev => ({ ...prev, credit_terms_effective_from: `${y}-04-01` })); }}
                    className="px-3 py-2 text-sm whitespace-nowrap rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50"
                    title="Set to 1 April of the current financial year">FY start</button>
                </div>
                <p className="text-[11px] text-slate-500 mt-1">
                  Applies to invoices dated on or after this. Earlier ones keep their current due date.
                  Left blank when terms change, it defaults to 1 April of this financial year — or click <b>FY start</b>.
                </p></div>
            </div>
            <p className="text-[11px] text-slate-500 mt-3">
              Saving changed terms re-dates this customer&apos;s unpaid invoices from the effective date —
              but never those with a due date from Tally, and never those stating their own terms.
            </p>
          </div>

          {/* Contact */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Contact Information</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Contact Person</label>
                <input type="text" name="contact_person" value={formData.contact_person} onChange={handleChange} className={inputClass} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Contact Email</label>
                <input type="email" name="contact_email" value={formData.contact_email} onChange={handleChange} className={inputClass} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">Contact Phone</label>
                <input type="text" name="contact_phone" value={formData.contact_phone} onChange={handleChange} className={inputClass} /></div>
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
            {formData.linked_vendor_name && (
              <p className="mt-2 text-xs text-slate-500">Linked vendor: <span className="font-medium text-slate-700">{formData.linked_vendor_name}</span></p>
            )}
          </div>

          {/* Notes */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
            <textarea name="notes" value={formData.notes} onChange={handleChange} rows={3} className={inputClass} />
          </div>

          <div className="flex justify-between pt-4 border-t">
            {isAdmin ? (
              <button
                type="button"
                onClick={async () => {
                  const action = (await confirm({
                    message: 'This customer has linked transactions.\n\nClick OK to deactivate (recommended) or Cancel to abort.',
                    isDangerous: true,
                  }));
                  if (!action) return;
                  try {
                    await apiClient.patch(`/api/customers/${id}/`, { active_flag: false, is_active: false });
                    toast.success('Customer deactivated');
                    navigate(-1);
                  } catch (err) {
                    toast.error(getApiErrorMessage(err));
                  }
                }}
                className="px-4 sm:px-5 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700"
              >
                Deactivate
              </button>
            ) : <div />}
            <div className="flex gap-3">
              <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
              <button type="submit" disabled={isSaving} className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isSaving ? 'Saving...' : 'Update Customer'}</button>
            </div>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
