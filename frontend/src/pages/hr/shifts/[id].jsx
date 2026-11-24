import CustomSelect from "@/components/ui/CustomSelect";
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Save, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { confirm } from '@/components/common/confirm';

const ATTENDANCE_RULES = [
  { value: 'EIGHT_HOUR', label: '8 Hour' },
  { value: 'CUSTOM', label: 'Custom' },
];

const inputClass = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

export default function ShiftDefinitionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit, canDelete } = usePermissions();
  const { options: warehouses } = useLookup('/api/warehouses/');

  const [formData, setFormData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const res = await apiClient.get(`/api/hr/shifts/${id}/`);
        setFormData(res.data);
      } catch (err) {
        if (err.response?.status !== 404) toast.error(getApiErrorMessage(err) || 'Failed to load shift');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData((prev) => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleSave = async () => {
    if (!formData.shift_code?.trim()) { toast.error('Shift Code is required.'); return; }
    if (!formData.shift_name?.trim()) { toast.error('Shift Name is required.'); return; }
    if (!formData.warehouse) { toast.error('Warehouse is required.'); return; }
    setSaving(true);
    try {
      await apiClient.patch(`/api/hr/shifts/${id}/`, {
        shift_code: formData.shift_code.trim(),
        shift_name: formData.shift_name.trim(),
        warehouse: formData.warehouse,
        start_time: formData.start_time || null,
        end_time: formData.end_time || null,
        break_duration_mins: Number(formData.break_duration_mins) || 0,
        grace_period_minutes: Number(formData.grace_period_minutes) || 0,
        attendance_calculation_rule: formData.attendance_calculation_rule || 'EIGHT_HOUR',
        overtime_eligibility: !!formData.overtime_eligibility,
        approval_required: !!formData.approval_required,
      });
      toast.success('Shift saved.');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: `Delete shift "${formData.shift_code} — ${formData.shift_name}"? This cannot be undone.`, isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/hr/shifts/${id}/`);
      toast.success('Shift deleted.');
      navigate('/hr/shifts');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete.');
    }
  };

  if (loading) {
    return (
      <MainLayout>
        <div className="text-center py-12 text-slate-500">Loading…</div>
      </MainLayout>
    );
  }

  if (!formData) {
    return (
      <MainLayout>
        <div className="text-center py-20">
          <p className="text-red-500 mb-3">Shift not found.</p>
          <button onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/hr/shifts')} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
            <ArrowLeft size={15} /> Back to Shifts
          </button>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <PageHeader
        title={`Shift ${formData.shift_code || ''}`}
        subtitle={formData.shift_name || ''}
        breadcrumbs={[
          { label: 'HR', href: '/hr' },
          { label: 'Shifts', href: '/hr/shifts' },
          { label: formData.shift_code || 'Detail' },
        ]}
      />
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/hr/shifts')}
          className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-800"
        >
          <ArrowLeft size={16} /> Back to list
        </button>
        <div className="flex items-center gap-2">
          {canDelete('Shift') && (
            <button
              onClick={handleDelete}
              className="flex items-center gap-2 px-4 py-2 border border-red-300 text-red-700 rounded-lg text-sm font-medium hover:bg-red-50"
            >
              <Trash2 size={16} /> Delete
            </button>
          )}
          {canEdit('Shift') && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              <Save size={16} /> {saving ? 'Saving…' : 'Save Changes'}
            </button>
          )}
        </div>
      </div>

      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5 space-y-4 sm:space-y-5">
        <Section title="Identity">
          <Field label="Shift Code *">
            <input type="text" name="shift_code" value={formData.shift_code || ''} onChange={handleChange}
              className={`${inputClass} font-mono`} />
          </Field>
          <Field label="Shift Name *">
            <input type="text" name="shift_name" value={formData.shift_name || ''} onChange={handleChange}
              className={inputClass} />
          </Field>
          <Field label="Warehouse *">
            <CustomSelect name="warehouse" value={formData.warehouse || ''} onChange={handleChange} className={inputClass}>
              <option value="">Select warehouse…</option>
              {warehouses.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
            </CustomSelect>
          </Field>
        </Section>

        <Section title="Working Hours">
          <Field label="Start Time">
            <input type="time" name="start_time" value={formData.start_time || ''} onChange={handleChange}
              className={inputClass} />
          </Field>
          <Field label="End Time">
            <input type="time" name="end_time" value={formData.end_time || ''} onChange={handleChange}
              className={inputClass} />
          </Field>
          <Field label="Break (minutes)">
            <input type="number" min="0" name="break_duration_mins" value={formData.break_duration_mins || 0} onChange={handleChange}
              className={inputClass} />
          </Field>
          <Field label="Grace Period (minutes)">
            <input type="number" min="0" name="grace_period_minutes" value={formData.grace_period_minutes || 0} onChange={handleChange}
              className={inputClass} />
          </Field>
          <Field label="Attendance Rule">
            <CustomSelect name="attendance_calculation_rule" value={formData.attendance_calculation_rule || ''} onChange={handleChange} className={inputClass}>
              {ATTENDANCE_RULES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </CustomSelect>
          </Field>
          <Field label="Net Duration">
            <input
              type="text"
              value={formData.shift_duration_hours != null ? `${Number(formData.shift_duration_hours).toFixed(2)} hours` : '—'}
              readOnly
              className={`${inputClass} bg-slate-50 text-slate-600`}
            />
          </Field>
        </Section>

        <Section title="Policy">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" name="overtime_eligibility" checked={!!formData.overtime_eligibility} onChange={handleChange} />
            Overtime eligible
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" name="approval_required" checked={!!formData.approval_required} onChange={handleChange} />
            Approval required to clock in
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" name="is_active" checked={!!formData.is_active} onChange={handleChange} disabled />
            <span className="opacity-70">Active (toggle via soft-delete)</span>
          </label>
        </Section>
      </div>
    </MainLayout>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-700 mb-3">{title}</h3>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-4">
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      {children}
    </div>
  );
}
