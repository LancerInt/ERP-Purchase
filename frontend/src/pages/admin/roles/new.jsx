import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { clearLookupCache } from '../../../hooks/useLookup.js';

export default function CreateAdminRole() {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    is_active: true,
    mfa_required: false,
  });

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const payload = {
        name: formData.name.trim(),
        description: formData.description.trim(),
        is_active: formData.is_active,
        mfa_required: formData.mfa_required,
      };
      if (import.meta.env.DEV) console.log('[CreateAdminRole] payload:', payload);
      await apiClient.post('/api/rbac/roles/', payload);
      clearLookupCache('/api/rbac/roles/');
      toast.success('Role created successfully!');
      navigate('/admin/roles');
    } catch (error) {
      if (import.meta.env.DEV) console.error('[CreateAdminRole] error:', error.response?.data);
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Role"
        subtitle="Add a new ERP role"
        breadcrumbs={[
          { label: 'Admin' },
          { label: 'Roles', href: '/admin/roles' },
          { label: 'Create New' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-5">
          {/* Section: Role Information */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Role Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Role Name <span className="text-red-500">*</span></label>
                <input type="text" name="name" value={formData.name} onChange={handleChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="e.g., Purchase Manager" />
              </div>
              <div className="flex items-center gap-2 pt-6">
                <input id="is_active" type="checkbox" name="is_active" checked={formData.is_active} onChange={handleChange} className="rounded border-slate-300" />
                <label htmlFor="is_active" className="text-sm text-slate-700">Active</label>
              </div>
              <div className="flex items-center gap-2 pt-6">
                <input id="mfa_required" type="checkbox" name="mfa_required" checked={formData.mfa_required} onChange={handleChange} className="rounded border-slate-300" />
                <label htmlFor="mfa_required" className="text-sm text-slate-700">Require two-factor login</label>
              </div>
            </div>
          </div>

          {/* Section: Description */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Description</h3>
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
                <textarea name="description" value={formData.description} onChange={handleChange} rows={3} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Briefly describe this role's responsibilities" />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving...' : 'Save'}</button>
          </div>
        </form>
      </div>
    </MainLayout>
  );
}
