import CustomSelect from "@/components/ui/CustomSelect";
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Pencil, Trash2, X, Save } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import EditGate from '../../../components/common/EditGate.jsx';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { confirm } from '@/components/common/confirm';

const EMPTY = {
  company: '', company_name: '', warehouse: '', warehouse_name: '',
  godown: '', godown_name: '', name: '', notes: '', active_flag: true,
};

// Clean read-only field — small uppercase label + value (no input box).
function Field({ label, value, className = '', multiline = false }) {
  return (
    <div className={className}>
      <p className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide">{label}</p>
      <p className={`text-sm sm:text-base text-slate-900 font-medium sm:font-semibold mt-0.5 break-words ${multiline ? 'whitespace-pre-wrap' : ''}`}>
        {value || '-'}
      </p>
    </div>
  );
}

export default function MachineryDivisionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin, canEdit } = usePermissions();
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState(EMPTY);
  const [original, setOriginal] = useState(EMPTY);

  const { options: companies } = useLookup('/api/companies/');
  const { options: warehouses } = useLookup(formData.company ? `/api/warehouses/?company=${formData.company}` : null);
  const { options: godowns } = useLookup(formData.warehouse ? `/api/godowns/?warehouse=${formData.warehouse}` : null);

  useEffect(() => {
    apiClient.get(`/api/machinery-divisions/${id}/`)
      .then((res) => {
        const d = res.data;
        const mapped = {
          company: d.company || '', company_name: d.company_name || '',
          warehouse: d.warehouse || '', warehouse_name: d.warehouse_name || '',
          godown: d.godown || '', godown_name: d.godown_name || '',
          name: d.name || '', notes: d.notes || '',
          active_flag: d.active_flag !== false,
        };
        setFormData(mapped);
        setOriginal(mapped);
      })
      .catch(() => toast.error('Failed to load division'))
      .finally(() => setIsLoading(false));
  }, [id]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData((p) => ({ ...p, [name]: type === 'checkbox' ? checked : value }));
  };
  const handleCompanyChange = (e) =>
    setFormData((p) => ({ ...p, company: e.target.value, warehouse: '', godown: '' }));
  const handleWarehouseChange = (e) =>
    setFormData((p) => ({ ...p, warehouse: e.target.value, godown: '' }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await apiClient.patch(`/api/machinery-divisions/${id}/`, {
        company: formData.company || null,
        warehouse: formData.warehouse || null,
        godown: formData.godown || null,
        name: formData.name, notes: formData.notes, active_flag: formData.active_flag,
      });
      toast.success('Division updated');
      setOriginal(formData);
      setIsEditing(false);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally { setIsSaving(false); }
  };

  const handleCancel = () => { setFormData(original); setIsEditing(false); };

  const handleDelete = async () => {
    if (!(await confirm({ message: `Deactivate Division "${formData.name}"?`, isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/machinery-divisions/${id}/`);
      toast.success('Division deactivated');
      navigate(-1);
    } catch (err) { toast.error(getApiErrorMessage(err)); }
  };

  const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
  const canEditDivision = canEdit('Machinery Division');

  if (isLoading) {
    return (
      <MainLayout>
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-4 border-primary-600 border-t-transparent rounded-full animate-spin" />
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <PageHeader
        title={formData.name || 'Division'}
        subtitle="Machinery division"
        breadcrumbs={[
          { label: 'Masters', href: '/masters' },
          { label: 'Machinery Division', href: '/masters/machinery-division' },
          { label: formData.name || 'Detail' },
        ]}
      />

      {!isEditing ? (
        /* ---- View mode (read-only) ---- */
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <header className="px-4 sm:px-6 py-3.5 border-b border-slate-100 flex items-center justify-between gap-2">
            <h3 className="text-[15px] sm:text-base font-semibold text-slate-900">Division details</h3>
            <div className="flex items-center gap-2 shrink-0">
              {canEditDivision && (
                <button onClick={() => setIsEditing(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-primary-700 bg-primary-50 rounded-lg hover:bg-primary-100">
                  <Pencil size={14} /> Edit
                </button>
              )}
              {isAdmin && (
                <button onClick={handleDelete} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-red-600 bg-red-50 rounded-lg hover:bg-red-100">
                  <Trash2 size={14} /> Delete
                </button>
              )}
            </div>
          </header>
          <div className="px-4 sm:px-6 py-5 grid grid-cols-2 lg:grid-cols-3 gap-x-3 gap-y-3 sm:gap-4">
            <Field label="Company" value={formData.company_name} />
            <Field label="Warehouse" value={formData.warehouse_name} />
            <Field label="Godown" value={formData.godown_name} />
            <Field label="Division Name" value={formData.name} className="col-span-2 lg:col-span-3" />
            <Field label="Notes" value={formData.notes} className="col-span-2 lg:col-span-3" multiline />
            <Field label="Status" value={formData.active_flag ? 'Active' : 'Inactive'} />
          </div>
        </div>
      ) : (
        /* ---- Edit mode (form) ---- */
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={canEditDivision} className="space-y-4 sm:space-y-6">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <header className="px-4 sm:px-6 py-4 border-b border-slate-100">
              <h3 className="text-[15px] sm:text-base font-semibold text-slate-900">Edit division details</h3>
            </header>
            <div className="px-4 sm:px-6 py-5 grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company <span className="text-red-500">*</span></label>
                <CustomSelect name="company" value={formData.company} onChange={handleCompanyChange} required className={inputClass}>
                  <option value="">Select…</option>
                  {formData.company && !companies.find((c) => String(c.value) === String(formData.company)) && (
                    <option value={formData.company}>{formData.company_name || 'Loading…'}</option>
                  )}
                  {companies.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse <span className="text-red-500">*</span></label>
                <CustomSelect name="warehouse" value={formData.warehouse} onChange={handleWarehouseChange}
                  required disabled={!formData.company}
                  className={`${inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`}>
                  <option value="">{formData.company ? 'Select…' : 'Pick company first…'}</option>
                  {formData.warehouse && !warehouses.find((w) => String(w.value) === String(formData.warehouse)) && (
                    <option value={formData.warehouse}>{formData.warehouse_name || 'Loading…'}</option>
                  )}
                  {warehouses.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Godown</label>
                <CustomSelect name="godown" value={formData.godown} onChange={handleChange}
                  disabled={!formData.warehouse}
                  className={`${inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`}>
                  <option value="">{formData.warehouse ? '(optional)' : 'Pick warehouse first…'}</option>
                  {formData.godown && !godowns.find((g) => String(g.value) === String(formData.godown)) && (
                    <option value={formData.godown}>{formData.godown_name || 'Loading…'}</option>
                  )}
                  {godowns.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
                </CustomSelect>
              </div>
              <div className="col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">Division Name <span className="text-red-500">*</span></label>
                <input type="text" name="name" value={formData.name} onChange={handleChange} required className={inputClass} />
              </div>
              <div className="col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
                <textarea name="notes" value={formData.notes} onChange={handleChange} rows={3} className={inputClass} />
              </div>
              <div className="flex items-center gap-2 col-span-2 lg:col-span-3">
                <input type="checkbox" name="active_flag" checked={formData.active_flag} onChange={handleChange} className="rounded border-slate-300" />
                <label className="text-sm text-slate-700">Active</label>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 sm:gap-3 pt-2 border-t border-slate-200">
            <button type="button" onClick={handleCancel}
              className="inline-flex items-center gap-1.5 px-4 sm:px-6 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
              <X size={16} /> Cancel
            </button>
            <button type="submit" disabled={isSaving}
              className="inline-flex items-center gap-1.5 px-4 sm:px-6 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              <Save size={16} /> {isSaving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
          </EditGate>
        </form>
      )}
    </MainLayout>
  );
}
