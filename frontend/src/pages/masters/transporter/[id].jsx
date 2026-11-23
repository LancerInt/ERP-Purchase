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

export default function EditTransporter() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin, canEdit } = usePermissions();
  const editable = canEdit('Transporter');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState({
    transporter_code: '',
    name: '',
    gstin: '',
    contact_person: '',
    contact_email: '',
    contact_phone: '',
    active_flag: true,
    notes: '',
  });

  useEffect(() => {
    apiClient.get(`/api/transporters/${id}/`)
      .then(res => {
        const d = res.data;
        setFormData({
          transporter_code: d.transporter_code || '',
          name: d.name || '',
          gstin: d.gstin || '',
          contact_person: d.contact_person || '',
          contact_email: d.contact_email || '',
          contact_phone: d.contact_phone || '',
          active_flag: d.active_flag !== undefined ? d.active_flag : true,
          notes: d.notes || '',
        });
      })
      .catch(() => toast.error('Failed to load transporter'))
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
      await apiClient.patch(`/api/transporters/${id}/`, payload);
      toast.success('Transporter updated successfully!');
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
      <PageHeader title={`Edit Transporter: ${formData.name}`} subtitle="Update transporter details"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Transporter', href: '/masters/transporter' }, { label: 'Edit' }]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
          {/* Section: Basic Information */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Basic Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Transporter Code</label>
                <input type="text" value={formData.transporter_code} disabled className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 text-slate-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Name <span className="text-red-500">*</span></label>
                <input type="text" name="name" value={formData.name} onChange={handleChange} required className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">GSTIN</label>
                <input type="text" name="gstin" value={formData.gstin} onChange={handleChange} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Section: Contact Information */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Contact Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Contact Person</label>
                <input type="text" name="contact_person" value={formData.contact_person} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Contact Email</label>
                <input type="email" name="contact_email" value={formData.contact_email} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Contact Phone</label>
                <input type="text" name="contact_phone" value={formData.contact_phone} onChange={handleChange} className={inputClass} />
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
              <div className="flex items-center gap-2">
                <input type="checkbox" name="active_flag" checked={formData.active_flag} onChange={handleChange} className="rounded border-slate-300" />
                <label className="text-sm text-slate-700">Active</label>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-row items-center justify-between gap-2 pt-4 border-t">
            {isAdmin ? (
              <button
                type="button"
                onClick={async () => {
                  if (!(await confirm({ message: `Deactivate transporter "${formData.name}"?`, isDangerous: true }))) return;
                  try {
                    await apiClient.patch(`/api/transporters/${id}/`, { active_flag: false, is_active: false });
                    toast.success('Transporter deactivated');
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
