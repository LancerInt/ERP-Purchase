import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import EditGate from '../../../components/common/EditGate.jsx';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { confirm } from '@/components/common/confirm';

export default function EditServiceCatalogue() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin, canEdit } = usePermissions();
  const editable = canEdit('Service Catalogue');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState({
    service_code: '',
    name: '',
    category: '',
    direction: '',
    default_tds: '',
    default_tcs: '',
    description: '',
    active_flag: true,
  });

  useEffect(() => {
    apiClient.get(`/api/service-catalogues/${id}/`)
      .then(res => {
        const d = res.data;
        setFormData({
          service_code: d.service_code || '',
          name: d.name || '',
          category: d.category || '',
          direction: d.direction || '',
          default_tds: d.default_tds || '',
          default_tcs: d.default_tcs || '',
          description: d.description || '',
          active_flag: d.active_flag !== undefined ? d.active_flag : true,
        });
      })
      .catch(() => toast.error('Failed to load service catalogue entry'))
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
      const payload = { ...formData };
      Object.keys(payload).forEach(k => {
        if (payload[k] === '' && !['active_flag'].includes(k)) delete payload[k];
      });
      await apiClient.patch(`/api/service-catalogues/${id}/`, payload);
      toast.success('Service catalogue updated successfully!');
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
      <PageHeader title={`Edit Service: ${formData.name}`} subtitle="Update service catalogue details"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Service Catalogue', href: '/masters/service-catalogue' }, { label: 'Edit' }]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
          {/* Section: Basic Information */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Basic Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Service Code</label>
                <input type="text" value={formData.service_code} disabled className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 text-slate-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Name <span className="text-red-500">*</span></label>
                <input type="text" name="name" value={formData.name} onChange={handleChange} required className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Category <span className="text-red-500">*</span></label>
                <CustomSelect name="category" value={formData.category} onChange={handleChange} required className={inputClass}>
                  <option value="">Select...</option>
                  <option value="MAINTENANCE">Maintenance</option>
                  <option value="REPAIR">Repair</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Direction <span className="text-red-500">*</span></label>
                <CustomSelect name="direction" value={formData.direction} onChange={handleChange} required className={inputClass}>
                  <option value="">Select...</option>
                  <option value="Inbound">Inbound</option>
                  <option value="Outbound">Outbound</option>
                  <option value="Both">Both</option>
                </CustomSelect>
              </div>
            </div>
          </div>

          {/* Section: Tax Defaults */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Tax Defaults</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Default TDS (%)</label>
                <input type="number" step="any" name="default_tds" value={formData.default_tds} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Default TCS (%)</label>
                <input type="number" step="any" name="default_tcs" value={formData.default_tcs} onChange={handleChange} className={inputClass} />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" name="active_flag" checked={formData.active_flag} onChange={handleChange} className="rounded border-slate-300" />
                <label className="text-sm text-slate-700">Active</label>
              </div>
            </div>
          </div>

          {/* Section: Description */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Description</h3>
            <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
              <div className="col-span-2 md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
                <textarea name="description" value={formData.description} onChange={handleChange} rows={3} className={inputClass} placeholder="Enter service description" />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-row items-center justify-between gap-2 pt-4 border-t">
            {isAdmin ? (
              <button
                type="button"
                onClick={async () => {
                  if (!(await confirm({ message: `Deactivate service "${formData.name}"?`, isDangerous: true }))) return;
                  try {
                    await apiClient.patch(`/api/service-catalogues/${id}/`, { active_flag: false, is_active: false });
                    toast.success('Service catalogue entry deactivated');
                    navigate(-1);
                  } catch (err) {
                    toast.error(getApiErrorMessage(err));
                  }
                }}
                className="px-4 sm:px-6 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700"
              >
                Delete
              </button>
            ) : <div />}
            <div className="flex flex-row gap-2">
              <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
              <button type="submit" disabled={isSaving} className="px-4 sm:px-6 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isSaving ? 'Saving...' : 'Save Changes'}</button>
            </div>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
