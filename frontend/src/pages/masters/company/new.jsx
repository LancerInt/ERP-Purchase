import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { panFromGstin } from '../../../utils/gst.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import EditGate from '../../../components/common/EditGate.jsx';
import usePermissions from '../../../hooks/usePermissions.js';
import AddressField, { parseAddress, stringifyAddress } from '../../../components/common/AddressField';

export default function CreateCompany() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Company');
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    company_code: '',
    legal_name: '',
    trade_name: '',
    gstin: '',
    pan: '',
    cin: '',
    msme_no: '',
    msme_name: '',
    registered_address: '',
    billing_address: '',
    contact_email: '',
    contact_phone: '',
    geo_latitude: '',
    geo_longitude: '',
    default_currency: '',
    active_from: '',
    active_to: '',
    notes: '',
    books_export_flag: false,
  });

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

  // Address-card extras (label / contact_person / contact_phone) ride
  // inside the same JSON the AddressField already writes to, so all
  // three address sub-fields plus the structured address parts land
  // together in the JSONField on save.
  const setAddrExtra = (field, key, val) => {
    setFormData(prev => {
      const merged = { ...parseAddress(prev[field]), [key]: val };
      return { ...prev, [field]: stringifyAddress(merged) };
    });
  };
  const getAddrExtra = (field, key) => parseAddress(formData[field])[key] || '';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const payload = cleanFormData(formData);
      // Parse structured address JSON for backend JSONField
      if (payload.registered_address) {
        payload.registered_address = parseAddress(payload.registered_address);
      }
      if (payload.billing_address) {
        payload.billing_address = parseAddress(payload.billing_address);
      }
      if (import.meta.env.DEV) console.log('[CreateCompany] payload:', payload);
      await apiClient.post('/api/companies/', payload);
      toast.success('Company created successfully!');
      navigate(-1);
    } catch (error) {
      if (import.meta.env.DEV) console.error('[CreateCompany] error:', error.response?.data);
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Company"
        subtitle="Add a new company record"
        breadcrumbs={[
          { label: 'Masters', href: '/masters' },
          { label: 'Company', href: '/masters/company' },
          { label: 'Create New' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
          {/* Section: Basic Information */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Basic Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company Code <span className="text-red-500">*</span></label>
                <input type="text" name="company_code" value={formData.company_code} onChange={handleChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter company code" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Legal Name <span className="text-red-500">*</span></label>
                <input type="text" name="legal_name" value={formData.legal_name} onChange={handleChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter legal name" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Trade Name</label>
                <input type="text" name="trade_name" value={formData.trade_name} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter trade name" />
              </div>
            </div>
          </div>

          {/* Section: Tax & Compliance */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Tax & Compliance</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">GSTIN</label>
                <input type="text" name="gstin" value={formData.gstin} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter GSTIN" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">PAN</label>
                <input type="text" name="pan" value={formData.pan} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter PAN" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">CIN</label>
                <input type="text" name="cin" value={formData.cin} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter CIN" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">MSME No</label>
                <input type="text" name="msme_no" value={formData.msme_no} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter MSME / Udyam registration number" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">MSME Name</label>
                <input type="text" name="msme_name" value={formData.msme_name} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter registered MSME name" />
              </div>
            </div>
          </div>

          {/* Section: Address */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Address</h3>
            <div className="space-y-4">
              {[
                { field: 'registered_address', title: 'Registered Address' },
                { field: 'billing_address', title: 'Billing Address' },
              ].map(({ field, title }) => (
                <div key={field} className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                  <h4 className="text-sm font-semibold text-blue-800 mb-3">{title}</h4>
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                      <div><label className="block text-xs font-medium text-slate-600 mb-1">Label</label>
                        <input type="text" value={getAddrExtra(field, 'address_label')} onChange={(e) => setAddrExtra(field, 'address_label', e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500" placeholder="e.g. Head Office, Factory, Branch" /></div>
                      <div><label className="block text-xs font-medium text-slate-600 mb-1">Contact Person</label>
                        <input type="text" value={getAddrExtra(field, 'contact_person')} onChange={(e) => setAddrExtra(field, 'contact_person', e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500" /></div>
                      <div><label className="block text-xs font-medium text-slate-600 mb-1">Contact Phone</label>
                        <input type="text" value={getAddrExtra(field, 'contact_phone')} onChange={(e) => setAddrExtra(field, 'contact_phone', e.target.value)} className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary-500" /></div>
                    </div>
                    <AddressField value={formData[field]} onChange={(v) => setFormData(prev => ({ ...prev, [field]: v }))} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Section: Contact Information */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Contact Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Contact Email</label>
                <input type="email" name="contact_email" value={formData.contact_email} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter contact email" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Contact Phone</label>
                <input type="text" name="contact_phone" value={formData.contact_phone} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter contact phone" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Latitude</label>
                <input type="number" step="any" name="geo_latitude" value={formData.geo_latitude} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="e.g. 12.9716" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Longitude</label>
                <input type="number" step="any" name="geo_longitude" value={formData.geo_longitude} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="e.g. 77.5946" />
              </div>
            </div>
            <p className="mt-2 text-xs text-slate-500">Used to geofence attendance check-in for office staff (those based at the head office).</p>
          </div>

          {/* Section: Settings */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Settings</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Default Currency <span className="text-red-500">*</span></label>
                <CustomSelect name="default_currency" value={formData.default_currency} onChange={handleChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select...</option>
                  <option value="INR">INR</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Active From <span className="text-red-500">*</span></label>
                <CustomDatePicker name="active_from" value={formData.active_from} onChange={handleChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Active To</label>
                <CustomDatePicker name="active_to" value={formData.active_to} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" name="books_export_flag" checked={formData.books_export_flag} onChange={handleChange} className="rounded border-slate-300" />
                <label className="text-sm text-slate-700">Books Export Flag</label>
              </div>
            </div>
          </div>

          {/* Section: Additional */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Additional</h3>
            <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
              <div className="col-span-2 md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
                <textarea name="notes" value={formData.notes} onChange={handleChange} rows={3} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-row justify-end gap-2 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving...' : 'Save'}</button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
