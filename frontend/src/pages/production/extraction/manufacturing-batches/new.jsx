import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';

import MainLayout from '../../../../components/layout/MainLayout';
import PageHeader from '../../../../components/common/PageHeader';
import CustomSelect from '../../../../components/ui/CustomSelect';
import CustomDatePicker from '../../../../components/ui/CustomDatePicker';
import apiClient from '../../../../utils/api.js';
import { getApiErrorMessage } from '../../../../utils/formHelpers.js';

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const readOnlyClass = `${inputClass} bg-slate-100 cursor-not-allowed text-slate-700`;

const ROUTE_OPTIONS = [
  { value: 'UNDECIDED',  label: 'Undecided' },
  { value: 'LIQUID',     label: 'Liquid concentrate' },
  { value: 'DRY_POWDER', label: 'Dry powder' },
];

/**
 * Manufacturing Batch — create OR edit form.
 *
 * Route `/production/extraction/manufacturing-batches/new`         → create
 * Route `/production/extraction/manufacturing-batches/:id/edit`    → edit
 *
 * In edit mode the form loads the existing batch, prefills all fields,
 * and PATCHes on save. Warehouse stays read-only (batch can't move
 * warehouses after creation).
 */
export default function ManufacturingBatchNew() {
  const navigate = useNavigate();
  const { id: editId } = useParams();           // set when route is /:id/edit
  const isEdit = !!editId;
  const today = new Date().toISOString().slice(0, 10);

  const [formData, setFormData] = useState({
    warehouse: '',
    created_on: today,
    planned_production_date: '',
    planned_kernel_qty_kg: '',
    planned_wash_count: '',
    planned_route: 'UNDECIDED',
    planned_equipment: '',
    remarks: '',
  });
  const [isSaving, setIsSaving] = useState(false);

  // Phase 1 — extraction only runs at SLP PLANT (`W-SLPP-*`). SLP YARD
  // is storage-only. Filter strictly to SLPP so the read-only auto-fill
  // kicks in when there's a single plant. Backend validate_warehouse
  // enforces the same rule.
  const [slpWarehouses, setSlpWarehouses] = useState([]);
  useEffect(() => {
    apiClient.get('/api/warehouses/', { params: { page_size: 500 } })
      .then((res) => {
        const rows = res.data?.results || (Array.isArray(res.data) ? res.data : []);
        const slp = rows.filter((w) => (w.warehouse_code || '').toUpperCase().includes('SLPP'));
        setSlpWarehouses(slp);
        if (slp.length === 1) {
          setFormData((f) => ({ ...f, warehouse: slp[0].id }));
        }
      })
      .catch((err) => {
        console.error('[extraction/batch/new] warehouse fetch failed:', err);
        toast.error(getApiErrorMessage(err) || 'Failed to load warehouses.');
      });
  }, []);
  const selectedWarehouse = slpWarehouses.find((w) => w.id === formData.warehouse);

  // Edit mode: load existing batch and pre-fill the form.
  const [batchNo, setBatchNo] = useState('');
  useEffect(() => {
    if (!isEdit) return;
    apiClient.get(`/api/production/manufacturing-batches/${editId}/`)
      .then((res) => {
        const b = res.data;
        setBatchNo(b.batch_no || '');
        setFormData({
          warehouse: b.warehouse || '',
          created_on: b.created_on || today,
          planned_production_date: b.planned_production_date || '',
          planned_kernel_qty_kg: b.planned_kernel_qty_kg || '',
          planned_wash_count: b.planned_wash_count || '',
          planned_route: b.planned_route || 'UNDECIDED',
          planned_equipment: b.planned_equipment || '',
          remarks: b.remarks || '',
        });
      })
      .catch((err) => toast.error(getApiErrorMessage(err) || 'Failed to load batch.'));
  }, [editId, isEdit]);

  const update = (field) => (val) => setFormData((f) => ({ ...f, [field]: val }));

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!formData.warehouse) return toast.error('Warehouse is required.');
    if (!formData.created_on) return toast.error('Batch date is required.');

    setIsSaving(true);
    try {
      const payload = {
        warehouse: formData.warehouse,
        created_on: formData.created_on,
        planned_production_date: formData.planned_production_date || null,
        planned_kernel_qty_kg: formData.planned_kernel_qty_kg || null,
        planned_wash_count: formData.planned_wash_count || null,
        planned_route: formData.planned_route,
        planned_equipment: formData.planned_equipment || '',
        remarks: formData.remarks || '',
      };
      if (isEdit) {
        const { data } = await apiClient.patch(`/api/production/manufacturing-batches/${editId}/`, payload);
        toast.success(`Batch ${data.batch_no} updated.`);
        navigate(`/production/extraction/manufacturing-batches/${editId}`);
      } else {
        const { data } = await apiClient.post('/api/production/manufacturing-batches/', payload);
        toast.success(`Batch ${data.batch_no} created.`);
        navigate('/production/extraction/manufacturing-batches');
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to create batch.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title={isEdit ? `Edit ${batchNo || 'Batch'}` : 'New Manufacturing Batch'}
        subtitle={isEdit
          ? 'Update batch planning details'
          : 'Create a new Azadirachtin extraction batch'}
        breadcrumbs={[
          { label: 'Production', path: '/production/work-orders' },
          { label: 'Extraction' },
          { label: 'Manufacturing Batches', path: '/production/extraction/manufacturing-batches' },
          { label: isEdit ? (batchNo || 'Edit') : 'New' },
        ]}
      />

      <form onSubmit={handleSubmit} className="max-w-3xl bg-white rounded-lg border border-slate-200 p-4 sm:p-5 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Warehouse <span className="text-red-500">*</span>
            </label>
            {slpWarehouses.length === 1 ? (
              /* Exactly one SLP warehouse — show read-only so the
                 operator can't accidentally change it (and doesn't need
                 to click a dropdown for a single option). */
              <input
                type="text"
                readOnly
                value={selectedWarehouse?.name || 'Loading…'}
                className={readOnlyClass}
                title="Extraction is scoped to SLP only in Phase 1."
              />
            ) : (
              /* Fallback picker if multiple SLP warehouses exist (e.g. YARD + PLANT). */
              <CustomSelect
                name="warehouse"
                value={formData.warehouse}
                onChange={(e) => update('warehouse')(e.target.value)}
                className={inputClass}
                required
              >
                <option value="">Select warehouse…</option>
                {slpWarehouses.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </CustomSelect>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Batch Date <span className="text-red-500">*</span>
            </label>
            <CustomDatePicker
              name="created_on"
              value={formData.created_on}
              onChange={(e) => update('created_on')(e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Planned Production Date
            </label>
            <CustomDatePicker
              name="planned_production_date"
              value={formData.planned_production_date}
              onChange={(e) => update('planned_production_date')(e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Planned Kernel Quantity (kg)
            </label>
            <input
              type="number"
              step="0.001"
              min="0"
              value={formData.planned_kernel_qty_kg}
              onChange={(e) => update('planned_kernel_qty_kg')(e.target.value)}
              className={inputClass}
              placeholder="e.g. 5000"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Planned Wash Count (6–10)
            </label>
            <input
              type="number"
              min="6"
              max="10"
              value={formData.planned_wash_count}
              onChange={(e) => update('planned_wash_count')(e.target.value)}
              className={inputClass}
              placeholder="e.g. 8"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Planned Route
            </label>
            <CustomSelect
              name="planned_route"
              value={formData.planned_route}
              onChange={(e) => update('planned_route')(e.target.value)}
              className={inputClass}
            >
              {ROUTE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </CustomSelect>
          </div>

          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Planned Equipment
            </label>
            <input
              type="text"
              value={formData.planned_equipment}
              onChange={(e) => update('planned_equipment')(e.target.value)}
              className={inputClass}
              placeholder="Equipment name or ID"
            />
          </div>

          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Remarks
            </label>
            <textarea
              rows={3}
              value={formData.remarks}
              onChange={(e) => update('remarks')(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/production/extraction/manufacturing-batches')}
            className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSaving}
            className="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg disabled:opacity-50"
          >
            {isSaving ? 'Saving…' : isEdit ? 'Update Batch' : 'Create Batch'}
          </button>
        </div>
      </form>
    </MainLayout>
  );
}
