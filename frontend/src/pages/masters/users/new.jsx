import CustomSelect from "@/components/ui/CustomSelect";
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import EditGate from '../../../components/common/EditGate.jsx';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';

export default function CreateUser() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('User');
  const [selectedCompany, setSelectedCompany] = useState('');
  const { options: companyOptions } = useLookup('/api/companies/');
  const { options: staffMembers } = useLookup('/api/hr/staff/');
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    portal_user_id: '',
    primary_email: '',
    mobile: '',
    employee_record: '',
    default_warehouse: '',
    status: '',
    notes: '',
  });

  const { options: warehouses } = useLookup(
    selectedCompany ? `/api/warehouses/?company=${selectedCompany}` : null
  );

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const payload = cleanFormData(formData);
      if (import.meta.env.DEV) console.log('[CreateUser] payload:', payload);
      await apiClient.post('/api/users/', payload);
      toast.success('User created successfully!');
      navigate(-1);
    } catch (error) {
      if (import.meta.env.DEV) console.error('[CreateUser] error:', error.response?.data);
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create User"
        subtitle="Add a new user record"
        breadcrumbs={[
          { label: 'Masters', href: '/masters' },
          { label: 'Users', href: '/masters/users' },
          { label: 'Create New' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
          {/* Section: Basic Information */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Basic Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Portal User ID <span className="text-red-500">*</span></label>
                <input type="text" name="portal_user_id" value={formData.portal_user_id} onChange={handleChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter portal user ID" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Primary Email <span className="text-red-500">*</span></label>
                <input type="email" name="primary_email" value={formData.primary_email} onChange={handleChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter primary email" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Mobile</label>
                <input type="text" name="mobile" value={formData.mobile} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter mobile number" />
              </div>
            </div>
          </div>

          {/* Section: Settings */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Settings</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Employee Record</label>
                <CustomSelect name="employee_record" value={formData.employee_record} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select...</option>
                  {staffMembers.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company</label>
                <CustomSelect value={selectedCompany} onChange={(e) => { setSelectedCompany(e.target.value); setFormData(prev => ({ ...prev, default_warehouse: '' })); }} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select...</option>
                  {companyOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Default Warehouse</label>
                <CustomSelect name="default_warehouse" value={formData.default_warehouse} onChange={handleChange} disabled={!selectedCompany} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:bg-slate-100 disabled:cursor-not-allowed">
                  <option value="">{selectedCompany ? 'Select...' : 'Select company first...'}</option>
                  {warehouses.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Status <span className="text-red-500">*</span></label>
                <CustomSelect name="status" value={formData.status} onChange={handleChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select...</option>
                  <option value="Active">Active</option>
                  <option value="Suspended">Suspended</option>
                </CustomSelect>
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
