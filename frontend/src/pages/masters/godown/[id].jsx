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

export default function EditGodown() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin, canEdit } = usePermissions();
  const editable = canEdit('Godown');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [selectedCompany, setSelectedCompany] = useState('');
  const { options: companies } = useLookup('/api/companies/');
  // Load every warehouse — Company is informational only on this form.
  // We de-dupe by name AFTER formData is declared so the saved
  // warehouse id is preserved across a name collision.
  const { options: warehousesAll } = useLookup('/api/warehouses/');
  const [formData, setFormData] = useState({
    godown_code: '',
    warehouse: '',
    godown_name: '',
    storage_condition: '',
    capacity_uom: '',
    capacity_value: '',
    batch_tracking_enabled: false,
    default_qc_hold_area: false,
    active_flag: true,
    notes: '',
  });

  // De-dupe warehouses by name; when a name has duplicates AND one of
  // them is the warehouse currently saved on this godown, prefer that
  // specific id so the dropdown stays selected after load.
  const warehouses = (() => {
    const byName = new Map();
    for (const w of warehousesAll) {
      const key = (w.label || '').trim().toLowerCase();
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(w);
    }
    const result = [];
    for (const group of byName.values()) {
      const match = group.find(g => String(g.value) === String(formData.warehouse));
      result.push(match || group[0]);
    }
    return result;
  })();

  useEffect(() => {
    apiClient.get(`/api/godowns/${id}/`)
      .then(res => {
        const d = res.data;
        setFormData({
          godown_code: d.godown_code || '',
          warehouse: d.warehouse || '',
          godown_name: d.godown_name || '',
          storage_condition: d.storage_condition || '',
          capacity_uom: d.capacity_uom || '',
          capacity_value: d.capacity_value || '',
          batch_tracking_enabled: d.batch_tracking_enabled || false,
          default_qc_hold_area: d.default_qc_hold_area || false,
          active_flag: d.active_flag !== undefined ? d.active_flag : true,
          notes: d.notes || '',
        });
        // Pre-select the Company dropdown from the godown's warehouse.
        // `warehouse_company` is a derived FK that GodownSerializer
        // surfaces specifically for this form — the godown itself
        // doesn't have a direct company FK, the parent warehouse does.
        // The cascading warehouse dropdown then loads via the company
        // selection, and the saved warehouse stays correctly selected.
        if (d.warehouse_company) {
          setSelectedCompany(String(d.warehouse_company));
        }
      })
      .catch(() => toast.error('Failed to load godown'))
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
        if (payload[k] === '' && !['batch_tracking_enabled', 'default_qc_hold_area', 'active_flag'].includes(k)) delete payload[k];
      });
      await apiClient.patch(`/api/godowns/${id}/`, payload);
      toast.success('Godown updated successfully!');
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
      <PageHeader title={`Edit Godown: ${formData.godown_name}`} subtitle="Update godown details"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Godown', href: '/masters/godown' }, { label: 'Edit' }]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-6">
          {/* Section: Basic Information */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Basic Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Godown Code</label>
                <input type="text" value={formData.godown_code} disabled className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 text-slate-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company</label>
                <CustomSelect value={selectedCompany} onChange={(e) => setSelectedCompany(e.target.value)} className={inputClass}>
                  <option value="">Select...</option>
                  {companies.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Warehouse <span className="text-red-500">*</span></label>
                <CustomSelect name="warehouse" value={formData.warehouse} onChange={handleChange} required className={inputClass}>
                  <option value="">Select...</option>
                  {warehouses.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Godown Name <span className="text-red-500">*</span></label>
                <input type="text" name="godown_name" value={formData.godown_name} onChange={handleChange} required className={inputClass} />
              </div>
            </div>
          </div>

          {/* Section: Storage Details */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Storage Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Storage Condition</label>
                <CustomSelect name="storage_condition" value={formData.storage_condition} onChange={handleChange} className={inputClass}>
                  <option value="">Select...</option>
                  <option value="AMBIENT">Ambient Temperature</option>
                  <option value="COLD">Cold Storage</option>
                  <option value="HAZARDOUS">Hazardous Materials</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Capacity UOM</label>
                <CustomSelect name="capacity_uom" value={formData.capacity_uom} onChange={handleChange} className={inputClass}>
                  <option value="">Select...</option>
                  <option value="CBM">Cubic Meter</option>
                  <option value="SQM">Square Meter</option>
                  <option value="UNIT">Units</option>
                  <option value="KG">Kilograms</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Capacity Value</label>
                <input type="number" step="any" name="capacity_value" value={formData.capacity_value} onChange={handleChange} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Section: Settings */}
          <div>
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 sm:mb-4 pb-2 border-b">Settings</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="flex items-center gap-2">
                <input type="checkbox" name="batch_tracking_enabled" checked={formData.batch_tracking_enabled} onChange={handleChange} className="rounded border-slate-300" />
                <label className="text-sm text-slate-700">Batch Tracking Enabled</label>
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" name="default_qc_hold_area" checked={formData.default_qc_hold_area} onChange={handleChange} className="rounded border-slate-300" />
                <label className="text-sm text-slate-700">Default QC Hold Area</label>
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" name="active_flag" checked={formData.active_flag} onChange={handleChange} className="rounded border-slate-300" />
                <label className="text-sm text-slate-700">Active</label>
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
                  if (!(await confirm({ message: `Deactivate godown "${formData.godown_name}"?`, isDangerous: true }))) return;
                  try {
                    await apiClient.patch(`/api/godowns/${id}/`, { active_flag: false, is_active: false });
                    toast.success('Godown deactivated');
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
