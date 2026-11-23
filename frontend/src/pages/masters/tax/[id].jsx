import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import EditGate from '../../../components/common/EditGate.jsx';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { confirm } from '@/components/common/confirm';

export default function EditTax() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin, canEdit } = usePermissions();
  const editable = canEdit('Tax');
  const { options: companies } = useLookup('/api/companies/');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState({
    tax_type: '',
    section_reference: '',
    rate: '',
    effective_from: '',
    effective_to: '',
    applicable_on: '',
    threshold_amount: '',
    company_scope: '',
    notes: '',
  });

  useEffect(() => {
    apiClient.get(`/api/taxes/${id}/`)
      .then(res => {
        const d = res.data;
        setFormData({
          tax_type: d.tax_type || '',
          section_reference: d.section_reference || '',
          rate: d.rate || '',
          effective_from: d.effective_from || '',
          effective_to: d.effective_to || '',
          applicable_on: d.applicable_on || '',
          threshold_amount: d.threshold_amount || '',
          company_scope: d.company_scope || '',
          notes: d.notes || '',
        });
      })
      .catch(() => toast.error('Failed to load tax record'))
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
        if (payload[k] === '') delete payload[k];
      });
      await apiClient.patch(`/api/taxes/${id}/`, payload);
      toast.success('Tax record updated successfully!');
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
      <PageHeader title={`Edit Tax: ${formData.tax_type} - ${formData.rate}%`} subtitle="Update tax record details"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Tax', href: '/masters/tax' }, { label: 'Edit' }]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
          {/* Section: Tax Details */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Tax Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Tax Type <span className="text-red-500">*</span></label>
                <CustomSelect name="tax_type" value={formData.tax_type} onChange={handleChange} required className={inputClass}>
                  <option value="">Select...</option>
                  <option value="GST">GST</option>
                  <option value="TDS">TDS</option>
                  <option value="TCS">TCS</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Section Reference</label>
                <input type="text" name="section_reference" value={formData.section_reference} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Rate (%) <span className="text-red-500">*</span></label>
                <input type="number" step="any" name="rate" value={formData.rate} onChange={handleChange} required className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Applicable On <span className="text-red-500">*</span></label>
                <CustomSelect name="applicable_on" value={formData.applicable_on} onChange={handleChange} required className={inputClass}>
                  <option value="">Select...</option>
                  <option value="Product">Product</option>
                  <option value="Service">Service</option>
                  <option value="Freight">Freight</option>
                  <option value="Wage">Wage</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Threshold Amount</label>
                <input type="number" step="any" name="threshold_amount" value={formData.threshold_amount} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company Scope <span className="text-red-500">*</span></label>
                <CustomSelect name="company_scope" value={formData.company_scope} onChange={handleChange} required className={inputClass}>
                  <option value="">Select...</option>
                  {companies.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
            </div>
          </div>

          {/* Section: Validity */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Validity</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Effective From <span className="text-red-500">*</span></label>
                <CustomDatePicker name="effective_from" value={formData.effective_from} onChange={handleChange} required className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Effective To</label>
                <CustomDatePicker name="effective_to" value={formData.effective_to} onChange={handleChange} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Section: Additional */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Additional</h3>
            <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
              <div className="col-span-2 md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
                <textarea name="notes" value={formData.notes} onChange={handleChange} rows={3} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-row items-center justify-between gap-2 pt-4 border-t">
            {isAdmin ? (
              <button
                type="button"
                onClick={async () => {
                  if (!(await confirm({ message: 'Deactivate this tax record?', isDangerous: true }))) return;
                  try {
                    await apiClient.patch(`/api/taxes/${id}/`, { active_flag: false, is_active: false });
                    toast.success('Tax record deactivated');
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
