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
import usePermissions from '../../../hooks/usePermissions.js';
import { confirm } from '@/components/common/confirm';

export default function EditTemplate() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin, canEdit } = usePermissions();
  const editable = canEdit('Template');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState({
    template_id: '',
    template_type: '',
    name: '',
    revision_no: '',
    effective_from: '',
    effective_to: '',
    requires_digital_signature: false,
    status: '',
    layout_json_xml: '',
    notes: '',
  });

  useEffect(() => {
    apiClient.get(`/api/templates/${id}/`)
      .then(res => {
        const d = res.data;
        setFormData({
          template_id: d.template_id || '',
          template_type: d.template_type || '',
          name: d.name || '',
          revision_no: d.revision_no || '',
          effective_from: d.effective_from || '',
          effective_to: d.effective_to || '',
          requires_digital_signature: d.requires_digital_signature || false,
          status: d.status || '',
          layout_json_xml: d.layout_json_xml || '',
          notes: d.notes || '',
        });
      })
      .catch(() => toast.error('Failed to load template'))
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
        if (payload[k] === '' && !['requires_digital_signature'].includes(k)) delete payload[k];
      });
      await apiClient.patch(`/api/templates/${id}/`, payload);
      toast.success('Template updated successfully!');
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
      <PageHeader title={`Edit Template: ${formData.name}`} subtitle="Update template details"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Templates', href: '/masters/templates' }, { label: 'Edit' }]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
          {/* Section: Basic Information */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Basic Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Template ID</label>
                <input type="text" value={formData.template_id} disabled className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 text-slate-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Template Type <span className="text-red-500">*</span></label>
                <CustomSelect name="template_type" value={formData.template_type} onChange={handleChange} required className={inputClass}>
                  <option value="">Select...</option>
                  <option value="Production">Production</option>
                  <option value="QC Report">QC Report</option>
                  <option value="Job Work">Job Work</option>
                  <option value="Packing">Packing</option>
                  <option value="Invoice">Invoice</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Name <span className="text-red-500">*</span></label>
                <input type="text" name="name" value={formData.name} onChange={handleChange} required className={inputClass} />
              </div>
            </div>
          </div>

          {/* Section: Version & Validity */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Version & Validity</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Revision No <span className="text-red-500">*</span></label>
                <input type="number" name="revision_no" value={formData.revision_no} onChange={handleChange} required className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Effective From <span className="text-red-500">*</span></label>
                <CustomDatePicker name="effective_from" value={formData.effective_from} onChange={handleChange} required className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Effective To</label>
                <CustomDatePicker name="effective_to" value={formData.effective_to} onChange={handleChange} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Status <span className="text-red-500">*</span></label>
                <CustomSelect name="status" value={formData.status} onChange={handleChange} required className={inputClass}>
                  <option value="">Select...</option>
                  <option value="Draft">Draft</option>
                  <option value="Active">Active</option>
                  <option value="Retired">Retired</option>
                </CustomSelect>
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" name="requires_digital_signature" checked={formData.requires_digital_signature} onChange={handleChange} className="rounded border-slate-300" />
                <label className="text-sm text-slate-700">Requires Digital Signature</label>
              </div>
            </div>
          </div>

          {/* Section: Layout */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Layout</h3>
            <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
              <div className="col-span-2 md:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">Layout JSON/XML</label>
                <textarea name="layout_json_xml" value={formData.layout_json_xml} onChange={handleChange} rows={3} className={inputClass} placeholder="Enter layout in JSON or XML format" />
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
                  if (!(await confirm({ message: `Deactivate template "${formData.name}"?`, isDangerous: true }))) return;
                  try {
                    await apiClient.patch(`/api/templates/${id}/`, { active_flag: false, is_active: false });
                    toast.success('Template deactivated');
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
