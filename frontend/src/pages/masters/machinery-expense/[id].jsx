import CustomSelect from "@/components/ui/CustomSelect";
import { useEffect, useState } from 'react';
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

export default function EditMachineryExpense() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin, canEdit } = usePermissions();
  const editable = canEdit('Machinery Expense');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState({
    company: '', company_name: '',
    warehouse: '', warehouse_name: '',
    category: '', category_name: '',
    name: '', notes: '', active_flag: true,
  });

  const { options: companies } = useLookup('/api/companies/');
  const { options: warehouses } = useLookup(formData.company ? `/api/warehouses/?company=${formData.company}` : null);
  const { options: categories } = useLookup('/api/expense-categories/');

  useEffect(() => {
    apiClient.get(`/api/machinery-expenses/${id}/`)
      .then((res) => {
        const d = res.data;
        setFormData({
          company:        d.company        || '',  company_name:   d.company_name   || '',
          warehouse:      d.warehouse      || '',  warehouse_name: d.warehouse_name || '',
          category:       d.category       || '',  category_name:  d.category_name  || '',
          name: d.name || '', notes: d.notes || '',
          active_flag: d.active_flag !== false,
        });
      })
      .catch(() => toast.error('Failed to load expense'))
      .finally(() => setIsLoading(false));
  }, [id]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData((p) => ({ ...p, [name]: type === 'checkbox' ? checked : value }));
  };
  const handleCompanyChange = (e) =>
    setFormData((p) => ({ ...p, company: e.target.value, warehouse: '' }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await apiClient.patch(`/api/machinery-expenses/${id}/`, {
        company:   formData.company   || null,
        warehouse: formData.warehouse || null,
        category:  formData.category  || null,
        name: formData.name, notes: formData.notes, active_flag: formData.active_flag,
      });
      toast.success('Expense updated');
      navigate(-1);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally { setIsSaving(false); }
  };

  const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

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
        title={`Edit Expense: ${formData.name}`}
        subtitle="Update location and category."
        breadcrumbs={[
          { label: 'Masters', href: '/masters' },
          { label: 'Machinery Expense', href: '/masters/machinery-expense' },
          { label: 'Edit' },
        ]}
      />

      <form onSubmit={handleSubmit}>
        <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <header className="px-4 sm:px-6 py-4 border-b border-slate-100">
            <h3 className="text-[15px] sm:text-base font-semibold text-slate-900">Expense details</h3>
          </header>

          <div className="px-4 sm:px-6 py-5 grid grid-cols-2 md:grid-cols-2 gap-3 sm:gap-4">
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
              <CustomSelect name="warehouse" value={formData.warehouse} onChange={handleChange}
                required disabled={!formData.company}
                className={`${inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`}>
                <option value="">{formData.company ? 'Select…' : 'Pick company first…'}</option>
                {formData.warehouse && !warehouses.find((w) => String(w.value) === String(formData.warehouse)) && (
                  <option value={formData.warehouse}>{formData.warehouse_name || 'Loading…'}</option>
                )}
                {warehouses.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
              </CustomSelect>
            </div>

            <div className="col-span-2 md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Category</label>
              <CustomSelect name="category" value={formData.category} onChange={handleChange} className={inputClass}>
                <option value="">{categories.length === 0 ? 'No categories — add via Django admin' : 'Select…'}</option>
                {/* Sticky option for a saved category that has since
                    been deactivated, so the user can see + change it. */}
                {formData.category && !categories.find((c) => String(c.value) === String(formData.category)) && (
                  <option value={formData.category}>{formData.category_name ? `${formData.category_name} (inactive)` : 'Loading…'}</option>
                )}
                {categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </CustomSelect>
              <p className="text-[11px] text-slate-500 mt-1">
                New categories are added by an admin from the Django admin panel.
              </p>
            </div>

            <div className="col-span-2 md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Expense Name <span className="text-red-500">*</span></label>
              <input type="text" name="name" value={formData.name} onChange={handleChange} required className={inputClass} />
            </div>

            <div className="col-span-2 md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
              <textarea name="notes" value={formData.notes} onChange={handleChange} rows={3} className={inputClass} />
            </div>

            <div className="flex items-center gap-2 col-span-2 md:col-span-2">
              <input type="checkbox" name="active_flag" checked={formData.active_flag} onChange={handleChange} className="rounded border-slate-300" />
              <label className="text-sm text-slate-700">Active</label>
            </div>
          </div>
        </div>

        <div className="sm:hidden flex gap-2 pt-3 border-t border-slate-200">
          <button type="button" onClick={() => navigate(-1)}
            className="flex-1 px-4 py-2.5 border border-slate-300 rounded-lg text-sm font-medium text-slate-700">Cancel</button>
          <button type="submit" disabled={isSaving}
            className="flex-1 px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
            {isSaving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
        <div className="hidden sm:flex justify-between gap-3 pt-2">
          {isAdmin ? (
            <button type="button"
              onClick={async () => {
                if (!(await confirm({ message: `Deactivate Expense "${formData.name}"?`, isDangerous: true }))) return;
                try {
                  await apiClient.delete(`/api/machinery-expenses/${id}/`);
                  toast.success('Expense deactivated');
                  navigate(-1);
                } catch (err) { toast.error(getApiErrorMessage(err)); }
              }}
              className="px-4 sm:px-5 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700">Delete</button>
          ) : <div />}
          <div className="flex gap-3">
            <button type="button" onClick={() => navigate(-1)}
              className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isSaving}
              className="px-4 sm:px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {isSaving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
        </EditGate>
      </form>
    </MainLayout>
  );
}
