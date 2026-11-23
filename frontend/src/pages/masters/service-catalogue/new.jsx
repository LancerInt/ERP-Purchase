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

export default function CreateServiceCatalogue() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Service Catalogue');
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    service_code: '',
    name: '',
    category: '',
    // Direction is no longer shown on the form, but the backend
    // field is required (no default), so we send 'BOTH' which means
    // the service applies to both inbound and outbound flows.
    direction: 'BOTH',
    default_tds: '',
    default_tcs: '',
    description: '',
    active_flag: true,
    // Location (optional)
    company: '',
    warehouse: '',
    godown: '',
    division: '',
  });

  // Cascade: company → warehouses → godowns (matches Machinery form).
  const { options: companies } = useLookup('/api/companies/');
  const { options: warehouses } = useLookup(
    formData.company ? `/api/warehouses/?company=${formData.company}` : null
  );
  const { options: godowns } = useLookup(
    formData.warehouse ? `/api/godowns/?warehouse=${formData.warehouse}` : null
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
      if (import.meta.env.DEV) console.log('[CreateServiceCatalogue] payload:', payload);
      await apiClient.post('/api/service-catalogues/', payload);
      toast.success('Service catalogue entry created successfully!');
      navigate(-1);
    } catch (error) {
      if (import.meta.env.DEV) console.error('[CreateServiceCatalogue] error:', error.response?.data);
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Service Catalogue"
        subtitle="Add a new service catalogue record"
        breadcrumbs={[
          { label: 'Masters', href: '/masters' },
          { label: 'Service Catalogue', href: '/masters/service-catalogue' },
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
                <label className="block text-sm font-medium text-slate-700 mb-1">Service Code <span className="text-red-500">*</span></label>
                <input type="text" name="service_code" value={formData.service_code} onChange={handleChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter service code" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Name <span className="text-red-500">*</span></label>
                <input type="text" name="name" value={formData.name} onChange={handleChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter service name" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Category <span className="text-red-500">*</span></label>
                {/* Values must match ServiceCatalogue.CATEGORY_CHOICES on
                    the backend — anything else triggers a 400
                    "<value> is not a valid choice" rejection. */}
                <CustomSelect name="category" value={formData.category} onChange={handleChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select...</option>
                  <option value="MAINTENANCE">Maintenance</option>
                  <option value="REPAIR">Repair</option>
                </CustomSelect>
              </div>
              {/* Direction removed from the UI. formData.direction is
                  pre-set to 'BOTH' so the backend's required field is
                  satisfied without surfacing the choice to the user. */}
            </div>
          </div>

          {/* Section: Location — optional. Mirrors Machinery's cascade
              (Company → Warehouse → Godown) so the form layout is
              consistent across masters. Services that are global /
              not tied to a specific godown can simply leave it blank. */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Location</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company</label>
                <CustomSelect
                  name="company"
                  value={formData.company}
                  onChange={(e) => setFormData(prev => ({
                    ...prev, company: e.target.value, warehouse: '', godown: '',
                  }))}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                >
                  <option value="">Select...</option>
                  {companies.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse</label>
                <CustomSelect
                  name="warehouse"
                  value={formData.warehouse}
                  onChange={(e) => setFormData(prev => ({
                    ...prev, warehouse: e.target.value, godown: '',
                  }))}
                  disabled={!formData.company}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:bg-slate-100 disabled:cursor-not-allowed"
                >
                  <option value="">{formData.company ? 'Select...' : 'Select company first...'}</option>
                  {warehouses.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Godown</label>
                <CustomSelect
                  name="godown"
                  value={formData.godown}
                  onChange={handleChange}
                  disabled={!formData.warehouse}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:bg-slate-100 disabled:cursor-not-allowed"
                >
                  <option value="">{formData.warehouse ? 'Select...' : 'Select warehouse first...'}</option>
                  {godowns.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Division</label>
                <input
                  type="text"
                  name="division"
                  value={formData.division}
                  onChange={handleChange}
                  placeholder="Enter division"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
            </div>
          </div>

          {/* Tax Defaults section removed per request. The backend
              fields `default_tds`, `default_tcs` still default to 0 and
              `active_flag` still defaults to True, so no migration is
              needed — they're just no longer editable from this form. */}

          {/* Section: Additional — renamed from "Description" so the
              section naming matches Machinery's pattern. */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Additional</h3>
            <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
              <div className="col-span-2 md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
                <textarea name="description" value={formData.description} onChange={handleChange} rows={3} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter service description" />
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
