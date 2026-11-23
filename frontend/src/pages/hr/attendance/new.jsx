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

// 24-hour "HH:MM" <-> 12-hour parts. We store check_in / check_out in
// 24h form internally (what the backend expects) and only split for the
// UI. This keeps the submit logic identical to the previous version.
const to12h = (hhmm) => {
  if (!hhmm) return { hour: '', minute: '', ampm: 'AM' };
  const [hStr, mStr = '00'] = hhmm.split(':');
  let h = parseInt(hStr, 10);
  if (Number.isNaN(h)) return { hour: '', minute: '', ampm: 'AM' };
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return { hour: String(h), minute: mStr.padStart(2, '0'), ampm };
};

const to24h = ({ hour, minute, ampm }) => {
  if (hour === '' || hour == null) return '';
  let h = parseInt(hour, 10);
  if (Number.isNaN(h) || h < 1 || h > 12) return '';
  const m = parseInt(minute || 0, 10);
  if (Number.isNaN(m) || m < 0 || m > 59) return '';
  if (ampm === 'PM' && h !== 12) h += 12;
  else if (ampm === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

function TimePickerAmPm({ value, onChange, required }) {
  const parts = to12h(value);
  const update = (patch) => onChange(to24h({ ...parts, ...patch }));
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min="1"
        max="12"
        value={parts.hour}
        onChange={(e) => update({ hour: e.target.value })}
        required={required}
        placeholder="HH"
        className="w-16 px-2 py-2 border border-slate-300 rounded-lg text-sm text-center focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
      />
      <span className="text-slate-400 font-semibold">:</span>
      <input
        type="number"
        min="0"
        max="59"
        value={parts.minute}
        onChange={(e) => update({ minute: e.target.value })}
        required={required}
        placeholder="MM"
        className="w-16 px-2 py-2 border border-slate-300 rounded-lg text-sm text-center focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
      />
      <CustomSelect
        value={parts.ampm}
        onChange={(e) => update({ ampm: e.target.value })}
        className="px-2 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
      >
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </CustomSelect>
    </div>
  );
}

export default function CreateAttendanceRecord() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Attendance');
  // Format the dropdown label as "STAFF_ID — Full Name" so the user
  // can disambiguate between staff with similar IDs (ADM-001 vs
  // ADMIN-001) without having to memorise who's who.
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
    check_in: '',
    check_out: '',
    attendance_status: '',
    remarks: '',
  });

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.staff) { toast.error('Pick a staff member.'); return; }
    if (!formData.date) { toast.error('Date is required.'); return; }
    if (!formData.check_in) { toast.error('Check-in time is required.'); return; }
    if (!formData.attendance_status) { toast.error('Attendance status is required.'); return; }
    // Combine the form's date + time inputs into a full ISO datetime.
    // CRITICAL: we go via `new Date(...)` so the browser interprets the
    // typed time in the user's local timezone, then `.toISOString()`
    // serialises it back as UTC with the `Z` suffix. Without this
    // round-trip Django would parse the naive string as UTC, and
    // displaying it back in IST would shift every time by +5:30.
    const toIsoDateTime = (dateStr, timeStr) => {
      if (!dateStr || !timeStr) return null;
      const safeTime = timeStr.length === 5 ? `${timeStr}:00` : timeStr;
      const local = new Date(`${dateStr}T${safeTime}`);
      if (Number.isNaN(local.getTime())) return null;
      return local.toISOString();
    };
    const checkIn = toIsoDateTime(formData.date, formData.check_in);
    const checkOut = toIsoDateTime(formData.date, formData.check_out);
    // Strict same-day validation. The earlier silent next-day-bump
    // produced a 21-hour shift when the user simply forgot to flip
    // AM→PM on check-out, which is the far more common case than a
    // real overnight shift. We force the user to fix the AM/PM here
    // and surface the implied duration in the toast so they spot the
    // mistake at a glance. Real night-shift support would need an
    // explicit "Check-out date" field — not implicit guessing.
    if (checkIn && checkOut && new Date(checkOut) <= new Date(checkIn)) {
      toast.error('Check-out must be later than check-in. Did you mean PM instead of AM?');
      return;
    }
    const payload = {
      staff: formData.staff,
      date: formData.date,
      check_in_time: checkIn,
      check_out_time: checkOut,
      attendance_status: formData.attendance_status,
      notes: formData.remarks || '',
    };
    setIsLoading(true);
    try {
      await apiClient.post('/api/hr/attendance/', cleanFormData(payload));
      toast.success('Attendance record created.');
      navigate('/hr/attendance');
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to create attendance record');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Attendance Record"
        breadcrumbs={[
          { label: 'HR', path: '/hr' },
          { label: 'Attendance', path: '/hr/attendance' },
          { label: 'Create Attendance Record' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Attendance Details</h3>
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
                  Check In <span className="text-red-500">*</span>
                </label>
                <TimePickerAmPm
                  value={formData.check_in}
                  onChange={(v) => setFormData(prev => ({ ...prev, check_in: v }))}
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Check Out</label>
                <TimePickerAmPm
                  value={formData.check_out}
                  onChange={(v) => setFormData(prev => ({ ...prev, check_out: v }))}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Attendance Status <span className="text-red-500">*</span>
                </label>
                <CustomSelect
                  name="attendance_status"
                  value={formData.attendance_status}
                  onChange={handleChange}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                >
                  <option value="">Select Status</option>
                  <option value="PRESENT">Present</option>
                  <option value="ABSENT">Absent</option>
                  <option value="HALF_DAY">Half Day</option>
                  <option value="PERMISSION">Permission</option>
                </CustomSelect>
              </div>
              <div className="col-span-2 md:col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">Remarks</label>
                <textarea
                  name="remarks"
                  value={formData.remarks}
                  onChange={handleChange}
                  rows={3}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Enter remarks"
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
