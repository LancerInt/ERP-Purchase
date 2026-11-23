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

// Category is sourced from /api/expense-categories/ — a curated
// master that's read-only over the API. Only a superuser can add new
// categories from the Django admin panel.
export default function CreateMachineryExpense() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Machinery Expense');
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState({
    company: '', warehouse: '',
    category: '',
    name: '', notes: '',
  });

  const { options: companies } = useLookup('/api/companies/');
  const { options: warehouses } = useLookup(
    formData.company ? `/api/warehouses/?company=${formData.company}` : null,
  );
  const { options: categories } = useLookup('/api/expense-categories/');

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };
  const handleCompanyChange = (e) =>
    setFormData((prev) => ({
      ...prev, company: e.target.value, warehouse: '',
    }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.company || !formData.warehouse || !formData.name) {
      toast.error('Company, Warehouse and Name are required.');
      return;
    }
    setIsSaving(true);
    try {
      const payload = cleanFormData({
        company:   formData.company,
        warehouse: formData.warehouse,
        category:  formData.category || null,
        name:      formData.name,
        notes:     formData.notes,
      });
      await apiClient.post('/api/machinery-expenses/', payload);
      toast.success('Expense created');
      navigate(-1);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  const inputClass =
    'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

  return (
    <MainLayout>
      <PageHeader
        title="Create Machinery Expense"
        subtitle="Attach an Expense to a company / warehouse and a category."
        breadcrumbs={[
          { label: 'Masters', href: '/masters' },
          { label: 'Machinery Expense', href: '/masters/machinery-expense' },
          { label: 'Create New' },
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
                {companies.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </CustomSelect>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse <span className="text-red-500">*</span></label>
              <CustomSelect
                name="warehouse" value={formData.warehouse} onChange={handleChange}
                required disabled={!formData.company}
                className={`${inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`}
              >
                <option value="">{formData.company ? 'Select…' : 'Pick company first…'}</option>
                {warehouses.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
              </CustomSelect>
            </div>

            <div className="col-span-2 md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Category</label>
              <CustomSelect name="category" value={formData.category} onChange={handleChange} className={inputClass}>
                <option value="">{categories.length === 0 ? 'No categories — add via Django admin' : 'Select…'}</option>
                {categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </CustomSelect>
              <p className="text-[11px] text-slate-500 mt-1">
                New categories are added by an admin from the Django admin panel.
              </p>
            </div>

            <div className="col-span-2 md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Expense Name <span className="text-red-500">*</span></label>
              <input
                type="text" name="name" value={formData.name} onChange={handleChange}
                required className={inputClass} placeholder="Enter expense name"
              />
            </div>

            <div className="col-span-2 md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
              <textarea name="notes" value={formData.notes} onChange={handleChange} rows={3} className={inputClass} />
            </div>
          </div>
        </div>

        <div className="sm:hidden flex gap-2 pt-3 border-t border-slate-200">
          <button type="button" onClick={() => navigate(-1)}
            className="flex-1 px-4 py-2.5 border border-slate-300 rounded-lg text-sm font-medium text-slate-700">Cancel</button>
          <button type="submit" disabled={isSaving}
            className="flex-1 px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
        <div className="hidden sm:flex justify-end gap-3 pt-2">
          <button type="button" onClick={() => navigate(-1)}
            className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
          <button type="submit" disabled={isSaving}
            className="px-4 sm:px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
        </EditGate>
      </form>
    </MainLayout>
  );
}
