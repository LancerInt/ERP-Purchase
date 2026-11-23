import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { panFromGstin } from '../../../utils/gst.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import EditGate from '../../../components/common/EditGate.jsx';
import usePermissions from '../../../hooks/usePermissions.js';
import AddressField, { stringifyAddress, parseAddress } from '../../../components/common/AddressField';
import { confirm } from '@/components/common/confirm';

export default function EditCompany() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin, canEdit } = usePermissions();
  const editable = canEdit('Company');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState({
    company_code: '',
    legal_name: '',
    trade_name: '',
    gstin: '',
    pan: '',
    cin: '',
    msme_no: '',
    msme_name: '',
    is_msme: false,
    msme_category: '',
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
  const [msmeCertFile, setMsmeCertFile] = useState(null);
  const [existingMsmeCert, setExistingMsmeCert] = useState('');

  useEffect(() => {
    apiClient.get(`/api/companies/${id}/`)
      .then(res => {
        const d = res.data;
        // Convert address objects to JSON string for AddressField component
        const regAddr = d.registered_address ? stringifyAddress(d.registered_address) : '';
        const billAddr = d.billing_address ? stringifyAddress(d.billing_address) : '';
        setFormData({
          company_code: d.company_code || '',
          legal_name: d.legal_name || '',
          trade_name: d.trade_name || '',
          gstin: d.gstin || '',
          pan: d.pan || '',
          cin: d.cin || '',
          msme_no: d.msme_no || '',
          msme_name: d.msme_name || '',
          is_msme: !!d.is_msme,
          msme_category: d.msme_category || '',
          registered_address: regAddr,
          billing_address: billAddr,
          contact_email: d.contact_email || '',
          contact_phone: d.contact_phone || '',
          geo_latitude: d.geo_latitude ?? '',
          geo_longitude: d.geo_longitude ?? '',
          default_currency: d.default_currency || '',
          active_from: d.active_from || '',
          active_to: d.active_to || '',
          notes: d.notes || '',
          books_export_flag: d.books_export_flag || false,
        });
        setExistingMsmeCert(d.msme_certificate || '');
      })
      .catch(() => toast.error('Failed to load company'))
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

  const setAddrExtra = (field, key, val) => {
    setFormData(prev => {
      const merged = { ...parseAddress(prev[field]), [key]: val };
      return { ...prev, [field]: stringifyAddress(merged) };
    });
  };
  const getAddrExtra = (field, key) => parseAddress(formData[field])[key] || '';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const payload = { ...formData };
      // Parse structured address JSON for backend JSONField
      if (payload.registered_address) {
        payload.registered_address = parseAddress(payload.registered_address);
      }
      if (payload.billing_address) {
        payload.billing_address = parseAddress(payload.billing_address);
      }
      // msme_certificate is a file — upload it in a separate multipart PATCH so
      // this JSON body (with its structured address dicts) stays clean.
      delete payload.msme_certificate;
      Object.keys(payload).forEach(k => {
        if (payload[k] === '' && !['books_export_flag'].includes(k)) delete payload[k];
      });
      await apiClient.patch(`/api/companies/${id}/`, payload);
      if (msmeCertFile) {
        const fd = new FormData();
        fd.append('msme_certificate', msmeCertFile);
        await apiClient.patch(`/api/companies/${id}/`, fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
      }
      toast.success('Company updated successfully!');
      navigate(-1);
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  };

  const inputClass = "w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500";

  if (isLoading) return <MainLayout><div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-primary-600 border-t-transparent rounded-full animate-spin" /></div></MainLayout>;

  return (
    <MainLayout>
      <PageHeader title={`Edit Company: ${formData.legal_name}`} subtitle="Update company details"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Company', href: '/masters/company' }, { label: 'Edit' }]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
          {/* Section: Basic Information */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Basic Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company Code</label>
                <input type="text" value={formData.company_code} disabled className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 text-slate-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Legal Name <span className="text-red-500">*</span></label>
                <input type="text" name="legal_name" value={formData.legal_name} onChange={handleChange} required className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Trade Name</label>
                <input type="text" name="trade_name" value={formData.trade_name} onChange={handleChange} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Section: Tax & Compliance */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Tax & Compliance</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">GSTIN</label>
                <input type="text" name="gstin" value={formData.gstin} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">PAN</label>
                <input type="text" name="pan" value={formData.pan} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">CIN</label>
                <input type="text" name="cin" value={formData.cin} onChange={handleChange} className={inputClass} />
              </div>
            </div>
            {/* MSME (we as a supplier) — drives the Udyam number printed on our
                sales invoices and the receivables-MSME view. */}
            <div className="mt-4">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" name="is_msme" checked={formData.is_msme} onChange={handleChange} className="rounded border-slate-300" />
                This company is registered as an MSME supplier
              </label>
              {formData.is_msme && (
                <div className="mt-3 grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:p-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">MSME Category</label>
                    <select name="msme_category" value={formData.msme_category} onChange={handleChange} className={inputClass}>
                      <option value="">Select...</option>
                      <option value="MICRO">Micro</option>
                      <option value="SMALL">Small</option>
                      <option value="MEDIUM">Medium</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Udyam / MSME No</label>
                    <input type="text" name="msme_no" value={formData.msme_no} onChange={handleChange} className={inputClass} placeholder="UDYAM-XX-00-0000000" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Registered MSME Name</label>
                    <input type="text" name="msme_name" value={formData.msme_name} onChange={handleChange} className={inputClass} placeholder="If different from legal name" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Udyam Certificate</label>
                    <input type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => setMsmeCertFile(e.target.files?.[0] || null)} className="w-full text-sm text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:bg-primary-50 file:text-primary-700" />
                    {existingMsmeCert && <a href={existingMsmeCert} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-primary-600 underline">Current file</a>}
                  </div>
                </div>
              )}
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
                        <input type="text" value={getAddrExtra(field, 'address_label')} onChange={(e) => setAddrExtra(field, 'address_label', e.target.value)} className={inputClass} placeholder="e.g. Head Office, Factory, Branch" /></div>
                      <div><label className="block text-xs font-medium text-slate-600 mb-1">Contact Person</label>
                        <input type="text" value={getAddrExtra(field, 'contact_person')} onChange={(e) => setAddrExtra(field, 'contact_person', e.target.value)} className={inputClass} /></div>
                      <div><label className="block text-xs font-medium text-slate-600 mb-1">Contact Phone</label>
                        <input type="text" value={getAddrExtra(field, 'contact_phone')} onChange={(e) => setAddrExtra(field, 'contact_phone', e.target.value)} className={inputClass} /></div>
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
                <input type="email" name="contact_email" value={formData.contact_email} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Contact Phone</label>
                <input type="text" name="contact_phone" value={formData.contact_phone} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Latitude</label>
                <input type="number" step="any" name="geo_latitude" value={formData.geo_latitude} onChange={handleChange} className={inputClass} placeholder="e.g. 12.9716" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Longitude</label>
                <input type="number" step="any" name="geo_longitude" value={formData.geo_longitude} onChange={handleChange} className={inputClass} placeholder="e.g. 77.5946" />
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
                <CustomSelect name="default_currency" value={formData.default_currency} onChange={handleChange} required className={inputClass}>
                  <option value="">Select...</option>
                  <option value="INR">INR</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Active From <span className="text-red-500">*</span></label>
                <CustomDatePicker name="active_from" value={formData.active_from} onChange={handleChange} required className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Active To</label>
                <CustomDatePicker name="active_to" value={formData.active_to} onChange={handleChange} className={inputClass} />
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
            <div className="grid grid-cols-2 md:grid-cols-2 gap-3 sm:gap-4">
              <div className="col-span-2 md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
                <textarea name="notes" value={formData.notes} onChange={handleChange} rows={3} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-4 border-t">
            {isAdmin && (
              <button
                type="button"
                onClick={async () => {
                  if (!(await confirm({ message: `Deactivate company "${formData.legal_name}"?`, isDangerous: true }))) return;
                  try {
                    await apiClient.patch(`/api/companies/${id}/`, { active_flag: false, is_active: false });
                    toast.success('Company deactivated');
                    navigate(-1);
                  } catch (err) {
                    toast.error(getApiErrorMessage(err));
                  }
                }}
                className="flex-1 sm:flex-none px-3 sm:px-6 py-2 bg-red-600 text-white rounded-lg text-xs sm:text-sm font-medium hover:bg-red-700"
              >
                Delete
              </button>
            )}
            <button type="button" onClick={() => navigate(-1)} className="flex-1 sm:flex-none sm:ml-auto px-3 sm:px-6 py-2 border border-slate-300 rounded-lg text-xs sm:text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isSaving} className="flex-1 sm:flex-none px-3 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-xs sm:text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isSaving ? 'Saving...' : 'Save Changes'}</button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
