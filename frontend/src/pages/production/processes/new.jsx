import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';

import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
// Visual treatment for a field locked READ_ONLY by field permissions.
const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;

export default function CreateProcess() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Process');
  const { options: companyOptions } = useLookup('/api/companies/');

  // Field-level permissions for the Process header — hide HIDDEN inputs
  // and lock READ_ONLY ones for the current user's role.
  const { isHidden, isReadOnly } = useFieldPermissions('Process');

  const [formData, setFormData] = useState({
    company: '',
    warehouse: '',
    process_name: '',
    description: '',
    status: 'Active',
  });
  const [isSaving, setIsSaving] = useState(false);

  const { options: warehouses } = useLookup(
    formData.company ? `/api/warehouses/?company=${formData.company}&scope=true` : null,
  );

  // Pull every existing process name (Active + Inactive) for the chosen
  // (company, warehouse) so we can warn inline before the user submits.
  // The DB also has a case-insensitive UniqueConstraint, so this is just
  // an early-warning UX layer.
  const [existingNames, setExistingNames] = useState([]);

  useEffect(() => {
    if (!formData.company || !formData.warehouse) {
      setExistingNames([]);
      return;
    }
    let cancelled = false;
    apiClient.get('/api/production/processes/', {
      params: {
        company: formData.company,
        warehouse: formData.warehouse,
        status: '',
        page_size: 500,
      },
    })
      .then((res) => {
        if (cancelled) return;
        const rows = res.data?.results || res.data || [];
        setExistingNames(rows.map((r) => String(r.process_name || '').trim().toLowerCase()));
      })
      .catch(() => { if (!cancelled) setExistingNames([]); });
    return () => { cancelled = true; };
  }, [formData.company, formData.warehouse]);

  const isDuplicateName = useMemo(() => {
    const typed = String(formData.process_name || '').trim().toLowerCase();
    if (!typed) return false;
    return existingNames.includes(typed);
  }, [formData.process_name, existingNames]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => {
      const next = { ...prev, [name]: value };
      // Warehouse is scoped to company — clear it if company changes.
      if (name === 'company') next.warehouse = '';
      return next;
    });
  };

  const validate = () => {
    if (!formData.company) return 'Company is required.';
    if (!formData.warehouse) return 'Warehouse is required.';
    if (!formData.process_name?.trim()) return 'Process Name is required.';
    if (isDuplicateName) {
      return 'Process Name already exists for this Company + Warehouse.';
    }
    return null;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const err = validate();
    if (err) { toast.error(err); return; }

    setIsSaving(true);
    try {
      await apiClient.post('/api/production/processes/', {
        company: formData.company,
        warehouse: formData.warehouse,
        process_name: formData.process_name.trim(),
        description: formData.description || '',
        status: formData.status || 'Active',
      });
      toast.success('Process Name created successfully.');
      navigate('/production/processes');
    } catch (apiErr) {
      toast.error(getApiErrorMessage(apiErr) || 'Failed to create process.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="New Process"
        subtitle="Add a process name to the master, scoped to one Company + Warehouse."
        breadcrumbs={[
          { label: 'Production', href: '/production' },
          { label: 'Processes', href: '/production/processes' },
          { label: 'New' },
        ]}
      />

      <form onSubmit={handleSubmit}>
        <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Process Details</h3>
          <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
            {!isHidden('company') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Company *</label>
              <CustomSelect name="company" value={formData.company} onChange={handleChange}
                disabled={isReadOnly('company')}
                className={isReadOnly('company') ? lockedInputClass : inputClass} required>
                <option value="">Select Company...</option>
                {companyOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </CustomSelect>
            </div>
            )}
            {!isHidden('warehouse') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse *</label>
              <CustomSelect name="warehouse" value={formData.warehouse} onChange={handleChange}
                disabled={!formData.company || isReadOnly('warehouse')}
                className={`${isReadOnly('warehouse') ? lockedInputClass : inputClass} disabled:bg-slate-100 disabled:cursor-not-allowed`} required>
                <option value="">{formData.company ? 'Select Warehouse...' : 'Select company first...'}</option>
                {warehouses.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
              </CustomSelect>
            </div>
            )}
            {!isHidden('process_name') && (
            <div className="col-span-2 md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Process Name *</label>
              <input type="text" name="process_name" value={formData.process_name}
                onChange={handleChange}
                disabled={isReadOnly('process_name')}
                className={`${isReadOnly('process_name') ? lockedInputClass : inputClass} ${isDuplicateName ? 'border-red-400 focus:ring-red-500 focus:border-red-500' : ''}`}
                placeholder="e.g. Mixing, Grinding, Roasting" required />
              {isDuplicateName ? (
                <p className="mt-1 text-xs text-red-600">
                  "{formData.process_name.trim()}" already exists for this Company + Warehouse. Pick a different name.
                </p>
              ) : (
                <p className="mt-1 text-xs text-slate-500">
                  Must be unique under this Company + Warehouse (case-insensitive).
                </p>
              )}
            </div>
            )}
            {!isHidden('description') && (
            <div className="col-span-2 md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
              <textarea name="description" value={formData.description}
                onChange={handleChange} rows={3}
                disabled={isReadOnly('description')}
                className={isReadOnly('description') ? lockedInputClass : inputClass} placeholder="Optional notes about this process" />
            </div>
            )}
            {!isHidden('status') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
              <CustomSelect name="status" value={formData.status} onChange={handleChange}
                disabled={isReadOnly('status')}
                className={isReadOnly('status') ? lockedInputClass : inputClass}>
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
              </CustomSelect>
              <p className="mt-1 text-xs text-slate-500">
                Inactive processes are hidden from the Work Order dropdown.
              </p>
            </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <button type="button" onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/production/processes')}
            className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
            Cancel
          </button>
          <button type="submit" disabled={isSaving || isDuplicateName}
            className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">
            {isSaving ? 'Saving…' : 'Save Process'}
          </button>
        </div>
        </EditGate>
      </form>
    </MainLayout>
  );
}
