import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Pencil, Trash2 } from 'lucide-react';

import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';
import { confirm } from '@/components/common/confirm';

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const inputClassRO = 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 text-slate-700';
// Visual treatment for a field locked READ_ONLY by field permissions.
const lockedInputClass = `${inputClass} bg-slate-100 cursor-not-allowed`;

export default function ProcessDetail() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { canEdit, canDelete } = usePermissions();
  const editable = canEdit('Process');
  // Field-level permissions for the Process header — hide HIDDEN inputs
  // and lock READ_ONLY ones for the current user's role.
  const { isHidden, isReadOnly } = useFieldPermissions('Process');

  const { options: companyOptions } = useLookup('/api/companies/');

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [original, setOriginal] = useState(null);
  const [formData, setFormData] = useState(null);

  const { options: warehouses } = useLookup(
    formData?.company ? `/api/warehouses/?company=${formData.company}&scope=true` : null,
  );

  // Pull other processes in this (company, warehouse) scope so we can
  // warn inline if the name collides with one of them. The DB constraint
  // is the final arbiter.
  const [otherNames, setOtherNames] = useState([]);

  useEffect(() => {
    if (!formData?.company || !formData?.warehouse) {
      setOtherNames([]);
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
        // Exclude this row itself — renaming a process shouldn't collide
        // with its own current name.
        setOtherNames(
          rows
            .filter((r) => r.id !== id)
            .map((r) => String(r.process_name || '').trim().toLowerCase()),
        );
      })
      .catch(() => { if (!cancelled) setOtherNames([]); });
    return () => { cancelled = true; };
  }, [formData?.company, formData?.warehouse, id]);

  const isDuplicateName = useMemo(() => {
    const typed = String(formData?.process_name || '').trim().toLowerCase();
    if (!typed) return false;
    return otherNames.includes(typed);
  }, [formData?.process_name, otherNames]);

  useEffect(() => {
    let cancelled = false;
    apiClient.get(`/api/production/processes/${id}/`)
      .then((res) => {
        if (cancelled) return;
        const d = res.data;
        setOriginal(d);
        setFormData({
          company: d.company || '',
          warehouse: d.warehouse || '',
          process_code: d.process_code || '',
          process_name: d.process_name || '',
          description: d.description || '',
          status: d.status || 'Active',
          company_name: d.company_name || '',
          warehouse_name: d.warehouse_name || '',
        });
      })
      .catch((err) => {
        toast.error(getApiErrorMessage(err) || 'Failed to load process.');
      })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => {
      const next = { ...prev, [name]: value };
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

  const handleSave = async (e) => {
    e?.preventDefault?.();
    const err = validate();
    if (err) { toast.error(err); return; }

    setIsSaving(true);
    try {
      const res = await apiClient.put(`/api/production/processes/${id}/`, {
        company: formData.company,
        warehouse: formData.warehouse,
        process_name: formData.process_name.trim(),
        description: formData.description || '',
        status: formData.status || 'Active',
      });
      const d = res.data;
      setOriginal(d);
      setFormData((prev) => ({
        ...prev,
        process_code: d.process_code,
        company_name: d.company_name,
        warehouse_name: d.warehouse_name,
      }));
      toast.success('Process saved.');
      setIsEditing(false);
    } catch (apiErr) {
      toast.error(getApiErrorMessage(apiErr) || 'Failed to save.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    if (!original) return;
    setFormData({
      company: original.company || '',
      warehouse: original.warehouse || '',
      process_code: original.process_code || '',
      process_name: original.process_name || '',
      description: original.description || '',
      status: original.status || 'Active',
      company_name: original.company_name || '',
      warehouse_name: original.warehouse_name || '',
    });
    setIsEditing(false);
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: `Delete process "${formData.process_name}"? This cannot be undone.`, isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/production/processes/${id}/`);
      toast.success('Process deleted.');
      navigate('/production/processes');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete.');
    }
  };

  if (isLoading) {
    return (
      <MainLayout>
        <div className="space-y-4">
          <div className="h-12 bg-slate-200 rounded animate-pulse" />
          <div className="h-64 bg-slate-200 rounded animate-pulse" />
        </div>
      </MainLayout>
    );
  }

  if (!formData) return null;

  const ro = !isEditing;

  return (
    <MainLayout>
      <PageHeader
        title={formData.process_name || 'Process'}
        subtitle={
          <span className="font-mono text-xs text-slate-500">{formData.process_code}</span>
        }
        breadcrumbs={[
          { label: 'Production', href: '/production' },
          { label: 'Processes', href: '/production/processes' },
          { label: formData.process_name || formData.process_code },
        ]}
      />

      <div className="flex justify-end gap-2 mb-4">
        {!isEditing && canEdit('Process') && (
          <button type="button" onClick={() => setIsEditing(true)}
            className="inline-flex items-center gap-1 px-4 py-2 bg-blue-50 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-100 border border-blue-200">
            <Pencil size={14} /> Edit
          </button>
        )}
        {!isEditing && canDelete('Process') && (
          <button type="button" onClick={handleDelete}
            className="inline-flex items-center gap-1 px-4 py-2 bg-red-50 text-red-700 rounded-lg text-sm font-medium hover:bg-red-100 border border-red-200">
            <Trash2 size={14} /> Delete
          </button>
        )}
      </div>

      <form onSubmit={handleSave}>
        <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
        <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
          <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Process Details</h3>
          <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
            {!isHidden('process_code') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Process Code</label>
              <input type="text" value={formData.process_code} readOnly
                className={inputClassRO} />
              <p className="mt-1 text-xs text-slate-500">Auto-generated, not editable.</p>
            </div>
            )}
            {!isHidden('status') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
              <CustomSelect name="status" value={formData.status} onChange={handleChange}
                disabled={ro || isReadOnly('status')}
                className={isReadOnly('status') ? lockedInputClass : inputClass}>
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
              </CustomSelect>
            </div>
            )}
            {!isHidden('company') && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Company *</label>
              <CustomSelect name="company" value={formData.company} onChange={handleChange}
                disabled={ro || isReadOnly('company')}
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
                disabled={ro || !formData.company || isReadOnly('warehouse')}
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
                onChange={handleChange} readOnly={ro || isReadOnly('process_name')}
                className={
                  ro
                    ? inputClassRO
                    : isReadOnly('process_name')
                      ? lockedInputClass
                      : `${inputClass} ${isDuplicateName ? 'border-red-400 focus:ring-red-500 focus:border-red-500' : ''}`
                }
                required />
              {!ro && !isReadOnly('process_name') && isDuplicateName && (
                <p className="mt-1 text-xs text-red-600">
                  "{formData.process_name.trim()}" already exists for this Company + Warehouse. Pick a different name.
                </p>
              )}
            </div>
            )}
            {!isHidden('description') && (
            <div className="col-span-2 md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
              <textarea name="description" value={formData.description}
                onChange={handleChange} readOnly={ro || isReadOnly('description')} rows={3}
                className={(ro || isReadOnly('description')) ? inputClassRO : inputClass} />
            </div>
            )}
          </div>
        </div>

        {isEditing && (
          <div className="flex justify-end gap-3">
            <button type="button" onClick={handleCancel}
              className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">
              Cancel
            </button>
            <button type="submit" disabled={isSaving || isDuplicateName}
              className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">
              {isSaving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        )}
        </EditGate>
      </form>
    </MainLayout>
  );
}
