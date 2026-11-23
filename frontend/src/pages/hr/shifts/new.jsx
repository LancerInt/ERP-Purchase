import CustomSelect from "@/components/ui/CustomSelect";
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';

export default function CreateShift() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Shift');
  const [selectedCompany, setSelectedCompany] = useState('');
  const { options: companyOptions } = useLookup('/api/companies/');
  const [isLoading, setIsLoading] = useState(false);
  // Field names mirror the backend `ShiftDefinition` model exactly so
  // the create POST doesn't need any massaging. The earlier version
  // sent `break_minutes` / `grace_minutes` / `active_flag` which the
  // serializer ignored and silently failed; the missing `shift_code`
  // is the required PK-display so the 400 was correct.
  const [formData, setFormData] = useState({
    shift_code: '',
    shift_name: '',
    warehouse: '',
    start_time: '',
    end_time: '',
    break_duration_mins: '0',
    grace_period_minutes: '0',
    attendance_calculation_rule: 'EIGHT_HOUR',
    overtime_eligibility: true,
    approval_required: false,
  });

  const { options: warehouses } = useLookup(
    selectedCompany ? `/api/warehouses/?company=${selectedCompany}` : null
  );

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.shift_code.trim()) { toast.error('Shift Code is required.'); return; }
    if (!formData.shift_name.trim()) { toast.error('Shift Name is required.'); return; }
    if (!formData.warehouse) { toast.error('Warehouse is required.'); return; }
    if (!formData.start_time) { toast.error('Start Time is required.'); return; }
    if (!formData.end_time) { toast.error('End Time is required.'); return; }
    const payload = {
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
    };
    setIsLoading(true);
    try {
      await apiClient.post('/api/hr/shifts/', cleanFormData(payload));
      toast.success('Shift created.');
      navigate('/hr/shifts');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || err.response?.data?.error || 'Failed to create shift');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Shift"
        breadcrumbs={[
          { label: 'HR', path: '/hr' },
          { label: 'Shifts', path: '/hr/shifts' },
          { label: 'Create Shift' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Shift Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Shift Code <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="shift_code"
                  value={formData.shift_code}
                  onChange={handleChange}
                  required
                  placeholder="e.g. MORN-001"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Shift Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="shift_name"
                  value={formData.shift_name}
                  onChange={handleChange}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="e.g. Morning Shift"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Company <span className="text-red-500">*</span>
                </label>
                <CustomSelect
                  value={selectedCompany}
                  onChange={(e) => { setSelectedCompany(e.target.value); setFormData(prev => ({ ...prev, warehouse: '' })); }}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                >
                  <option value="">Select Company</option>
                  {companyOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Warehouse <span className="text-red-500">*</span>
                </label>
                <CustomSelect
                  name="warehouse"
                  value={formData.warehouse}
                  onChange={handleChange}
                  required
                  disabled={!selectedCompany}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500 disabled:bg-slate-100 disabled:cursor-not-allowed"
                >
                  <option value="">{selectedCompany ? 'Select Warehouse' : 'Select company first…'}</option>
                  {warehouses.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Start Time <span className="text-red-500">*</span>
                </label>
                <input
                  type="time"
                  name="start_time"
                  value={formData.start_time}
                  onChange={handleChange}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  End Time <span className="text-red-500">*</span>
                </label>
                <input
                  type="time"
                  name="end_time"
                  value={formData.end_time}
                  onChange={handleChange}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Break (minutes)</label>
                <input
                  type="number"
                  min="0"
                  name="break_duration_mins"
                  value={formData.break_duration_mins}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="0"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Grace Period (minutes)</label>
                <input
                  type="number"
                  min="0"
                  name="grace_period_minutes"
                  value={formData.grace_period_minutes}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="0"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Attendance Rule</label>
                <CustomSelect
                  name="attendance_calculation_rule"
                  value={formData.attendance_calculation_rule}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                >
                  <option value="EIGHT_HOUR">8 Hour</option>
                  <option value="CUSTOM">Custom</option>
                </CustomSelect>
              </div>
              <div className="flex items-center gap-4 sm:gap-5 col-span-2 lg:col-span-3 pt-2">
                <label className="flex items-center gap-2 text-sm font-medium text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    name="overtime_eligibility"
                    checked={formData.overtime_eligibility}
                    onChange={handleChange}
                    className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                  />
                  Overtime eligible
                </label>
                <label className="flex items-center gap-2 text-sm font-medium text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    name="approval_required"
                    checked={formData.approval_required}
                    onChange={handleChange}
                    className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                  />
                  Approval required to clock in
                </label>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
            >
              {isLoading ? 'Saving…' : 'Save'}
            </button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
