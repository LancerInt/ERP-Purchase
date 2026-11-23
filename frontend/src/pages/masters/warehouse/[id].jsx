import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import EditGate from '../../../components/common/EditGate.jsx';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { INDIAN_STATES_CODED, COUNTRIES, TIMEZONES } from '../../../utils/locationData.js';
import { confirm } from '@/components/common/confirm';

// Address comes back as a JSONField, which can be {full: "..."} for
// rows the form created, or {line1: "...", country: "INDIA"} for rows
// the bulk importer wrote. Render whichever shape we get as plain
// readable text — never raw JSON.
const addressAsText = (a) => {
  if (!a) return '';
  if (typeof a === 'string') return a;
  if (typeof a !== 'object') return String(a);
  if (a.full) return String(a.full);
  const lines = [a.line1, a.line2].filter(v => v && String(v).trim());
  if (lines.length) return lines.join(', ');
  // Fall back: any other string value that isn't already in a
  // dedicated form field below.
  const skip = new Set(['city', 'state', 'pincode', 'country']);
  return Object.entries(a)
    .filter(([k, v]) => !skip.has(k) && v && typeof v === 'string')
    .map(([, v]) => String(v).trim())
    .filter(Boolean)
    .join(', ');
};

export default function WarehouseDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { isAdmin, canEdit, canDelete } = usePermissions();
  const editable = canEdit('Warehouse');
  const { options: companies } = useLookup('/api/companies/');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  // Land in edit mode when the URL ends in /edit (entry point from the list's pencil icon).
  const [isEditing, setIsEditing] = useState(location.pathname.endsWith('/edit'));
  const [formData, setFormData] = useState({
    warehouse_code: '', name: '', company: '', warehouse_type: '',
    address: '', city: '', state: '', country: '', pincode: '',
    geo_latitude: '', geo_longitude: '', time_zone: '', default_currency: '',
    active_flag: true, notes: '',
  });

  useEffect(() => {
    apiClient.get(`/api/warehouses/${id}/`)
      .then(res => {
        const d = res.data;
        setFormData({
          warehouse_code: d.warehouse_code || '',
          name: d.name || '',
          company: d.company || '',
          warehouse_type: d.warehouse_type || '',
          address: addressAsText(d.address),
          city: d.city || '',
          state: d.state || '',
          country: d.country || '',
          pincode: d.pincode || '',
          geo_latitude: d.geo_latitude || '',
          geo_longitude: d.geo_longitude || '',
          time_zone: d.time_zone || '',
          default_currency: d.default_currency || '',
          active_flag: d.active_flag !== false,
          notes: d.notes || '',
        });
      })
      .catch(() => toast.error('Failed to load warehouse'))
      .finally(() => setIsLoading(false));
  }, [id]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const payload = cleanFormData(formData);
      if (typeof payload.address === 'string' && payload.address) {
        payload.address = { full: payload.address };
      }
      await apiClient.put(`/api/warehouses/${id}/`, payload);
      toast.success('Warehouse updated!');
      setIsEditing(false);
    } catch (error) {
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: 'Are you sure you want to delete this warehouse?', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/warehouses/${id}/`);
      toast.success('Warehouse deleted');
      navigate(-1);
    } catch {
      toast.error('Failed to delete');
    }
  };

  const inputClass = isEditing
    ? 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500'
    : 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 text-slate-700 cursor-default';

  if (isLoading) {
    return <MainLayout><div className="text-center py-16 text-slate-500">Loading...</div></MainLayout>;
  }

  return (
    <MainLayout>
      <PageHeader
        title={formData.name || 'Warehouse'}
        subtitle={`Code: ${formData.warehouse_code}`}
        breadcrumbs={[
          { label: 'Masters', href: '/masters' },
          { label: 'Warehouse', href: '/masters/warehouse' },
          { label: formData.warehouse_code },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
        <div className="flex justify-end gap-3 mb-4">
          {!isEditing && canEdit('Warehouse') && (
            <button type="button" onClick={() => setIsEditing(true)} className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700">Edit</button>
          )}
          {!isEditing && (isAdmin || canDelete('Warehouse')) && (
            <button type="button" onClick={handleDelete} className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700">Delete</button>
          )}
        </div>

        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Basic Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse Code</label>
                <input type="text" name="warehouse_code" value={formData.warehouse_code} onChange={handleChange} readOnly={!isEditing} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company</label>
                <CustomSelect name="company" value={formData.company} onChange={handleChange} disabled={!isEditing} className={inputClass}>
                  <option value="">Select...</option>
                  {companies.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
                <input type="text" name="name" value={formData.name} onChange={handleChange} readOnly={!isEditing} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse Type</label>
                <CustomSelect name="warehouse_type" value={formData.warehouse_type} onChange={handleChange} disabled={!isEditing} className={inputClass}>
                  <option value="">Select...</option>
                  <option value="WAREHOUSE">Warehouse</option>
                  <option value="HEAD_OFFICE">Head Office</option>
                  <option value="FACTORY">Factory / Manufacturing</option>
                  <option value="JOB_WORK_PARTNER">Job Work Partner</option>
                </CustomSelect>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Address</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <div className="col-span-2 md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Address</label>
                <textarea name="address" value={formData.address} onChange={handleChange} readOnly={!isEditing} rows={3} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">City</label>
                <input type="text" name="city" value={formData.city} onChange={handleChange} readOnly={!isEditing} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">State</label>
                <CustomSelect name="state" value={formData.state} onChange={handleChange} disabled={!isEditing} className={inputClass}>
                  <option value="">Select State...</option>
                  {INDIAN_STATES_CODED.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Country</label>
                <CustomSelect name="country" value={formData.country} onChange={handleChange} disabled={!isEditing} className={inputClass}>
                  <option value="">Select Country...</option>
                  {COUNTRIES.map(c => <option key={c.value} value={c.label}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Pincode</label>
                <input type="text" name="pincode" value={formData.pincode} onChange={handleChange} readOnly={!isEditing} className={inputClass} />
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Geo & Settings</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Geo Latitude</label>
                <input type="number" step="any" name="geo_latitude" value={formData.geo_latitude} onChange={handleChange} readOnly={!isEditing} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Geo Longitude</label>
                <input type="number" step="any" name="geo_longitude" value={formData.geo_longitude} onChange={handleChange} readOnly={!isEditing} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Time Zone</label>
                <CustomSelect name="time_zone" value={formData.time_zone} onChange={handleChange} disabled={!isEditing} className={inputClass}>
                  <option value="">Select Timezone...</option>
                  {TIMEZONES.map(tz => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Default Currency</label>
                <CustomSelect name="default_currency" value={formData.default_currency} onChange={handleChange} disabled={!isEditing} className={inputClass}>
                  <option value="">Select...</option>
                  <option value="INR">INR</option>
                  <option value="USD">USD</option>
                </CustomSelect>
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" name="active_flag" checked={formData.active_flag} onChange={handleChange} disabled={!isEditing} className="rounded border-slate-300" />
                <label className="text-sm text-slate-700">Active</label>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Additional</h3>
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
                <textarea name="notes" value={formData.notes} onChange={handleChange} readOnly={!isEditing} rows={3} className={inputClass} />
              </div>
            </div>
          </div>

          {isEditing && (
            <div className="flex flex-row items-center justify-between gap-2 pt-4 border-t">
              {isAdmin ? (
                <button
                  type="button"
                  onClick={handleDelete}
                  className="px-4 sm:px-6 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700"
                >
                  Delete
                </button>
              ) : <div />}
              <div className="flex flex-row gap-2">
                <button type="button" onClick={() => setIsEditing(false)} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
                <button type="submit" disabled={isSaving} className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isSaving ? 'Saving...' : 'Save Changes'}</button>
              </div>
            </div>
          )}
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
