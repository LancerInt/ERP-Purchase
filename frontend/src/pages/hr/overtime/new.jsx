import CustomDatePicker from "@/components/ui/CustomDatePicker";
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

export default function CreateOvertimeRequest() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Overtime');
  const { options: staffList } = useLookup('/api/hr/staff/', {
    labelField: (s) => {
      const name = s.full_name
        || [s.first_name, s.last_name].filter(Boolean).join(' ').trim();
      return name ? `${s.staff_id} — ${name}` : s.staff_id;
    },
  });
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    staff: '',
    date: '',
    hours: '',
    reason: '',
  });

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.staff) { toast.error('Pick a staff member.'); return; }
    if (!formData.date) { toast.error('Date is required.'); return; }
    if (!formData.hours || Number(formData.hours) <= 0) { toast.error('Hours must be greater than zero.'); return; }
    // Backend's OvertimeRequestViewSet.create reads `staff_id` and
    // `hours_worked` and routes through OvertimeService — match its
    // expected shape exactly, otherwise every save 400s.
    const payload = {
      staff_id: formData.staff,
      date: formData.date,
      hours_worked: Number(formData.hours),
      task_description: formData.reason || '',
    };
    setIsLoading(true);
    try {
      await apiClient.post('/api/hr/overtime/', cleanFormData(payload));
      toast.success('Overtime request created.');
      navigate('/hr/overtime');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || err.response?.data?.error || 'Failed to create overtime request');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Overtime Request"
        breadcrumbs={[
          { label: 'HR', path: '/hr' },
          { label: 'Overtime', path: '/hr/overtime' },
          { label: 'Create Overtime Request' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Overtime Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Staff <span className="text-red-500">*</span>
                </label>
                <CustomSelect
                  name="staff"
                  value={formData.staff}
                  onChange={handleChange}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                >
                  <option value="">Select Staff</option>
                  {staffList.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Date <span className="text-red-500">*</span>
                </label>
                <CustomDatePicker
                  name="date"
                  value={formData.date}
                  onChange={handleChange}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Hours <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  name="hours"
                  value={formData.hours}
                  onChange={handleChange}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Enter hours"
                />
              </div>
              <div className="col-span-2 md:col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Reason <span className="text-red-500">*</span>
                </label>
                <textarea
                  name="reason"
                  value={formData.reason}
                  onChange={handleChange}
                  required
                  rows={3}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Enter reason for overtime"
                />
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
              {isLoading ? 'Saving...' : 'Save'}
            </button>
          </div>
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
