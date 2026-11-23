import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';
import { confirm } from '@/components/common/confirm';

// Fixed department picklist for the Staff form (replaces free-text entry).
const DEPARTMENT_OPTIONS = ['Sales', 'Purchase', 'Finance', 'HR', 'Accounts', 'Management', 'Manager', 'QC Team', 'Warehouse Management'];

export default function StaffDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { canEdit, canDelete } = usePermissions();
  const editable = canEdit('Staff');
  const { options: companies } = useLookup('/api/companies/');
  // Designation options are the system Roles so HR picks a real role.
  const { options: roleOptions } = useLookup('/api/rbac/roles/', { labelField: 'name', valueField: 'name' });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  // Attendance Face-ID enrollment status for this staff (read-only + reset).
  const [faceInfo, setFaceInfo] = useState({ enrolled: false, at: null });
  const [formData, setFormData] = useState({
    staff_id: '',
    staff_type: '',
    first_name: '',
    last_name: '',
    gender: '',
    date_of_birth: '',
    company: '',
    company_ids: [],
    primary_location: '',
    location_ids: [],
    godown_ids: [],
    department: '',
    designation: '',
    employment_start_date: '',
    employment_end_date: '',
    employment_status: '',
    salary_per_day: '',
    shift_assignment: '',
    overtime_eligible: false,
    contractor_flag: false,
    face_template_id: '',
    contact_number: '',
    email: '',
    emergency_contact: '',
    address: '',
    remarks: '',
  });

  const { options: warehousesRaw, raw: warehousesRawData } = useLookup('/api/warehouses/');
  // Primary Location options = warehouses of the selected companies only.
  const warehouses = useMemo(() => {
    const coSet = new Set((formData.company_ids || []).map(String));
    const companyByWh = new Map((warehousesRawData || []).map(w => [String(w.id), String(w.company)]));
    return (warehousesRaw || []).filter(opt => !coSet.size || coSet.has(companyByWh.get(String(opt.value))));
  }, [warehousesRaw, warehousesRawData, formData.company_ids]);
  // Same shift lookup as the create page — warehouse-scoped when set
  // so we don't show shifts from other plants.
  const { options: shiftOptions } = useLookup(
    formData.primary_location
      ? `/api/hr/shifts/?warehouse=${formData.primary_location}`
      : '/api/hr/shifts/',
    { labelField: (s) => `${s.shift_code} — ${s.shift_name}` },
  );

  useEffect(() => {
    apiClient.get(`/api/hr/staff/${id}/`)
      .then(res => {
        const d = res.data;
        setFormData({
          staff_id: d.staff_id || '',
          staff_type: d.staff_type || '',
          first_name: d.first_name || '',
          last_name: d.last_name || '',
          gender: d.gender || '',
          date_of_birth: d.date_of_birth || '',
          company: d.company || '',
          // Fall back to the single company for staff created before
          // multi-company support, so their primary shows checked.
          company_ids: (d.company_ids && d.company_ids.length) ? d.company_ids : (d.company ? [d.company] : []),
          primary_location: d.primary_location || '',
          location_ids: (d.location_ids && d.location_ids.length) ? d.location_ids : (d.primary_location ? [d.primary_location] : []),
          godown_ids: d.godown_ids || [],
          department: d.department || '',
          designation: d.designation || '',
          employment_start_date: d.employment_start_date || '',
          employment_end_date: d.employment_end_date || '',
          employment_status: d.employment_status || '',
          salary_per_day: d.salary_per_day != null ? String(d.salary_per_day) : '',
          shift_assignment: d.shift_assignment || '',
          overtime_eligible: d.overtime_eligible || false,
          contractor_flag: d.contractor_flag || false,
          face_template_id: d.face_template_id || '',
          contact_number: d.contact_number || '',
          email: d.email || '',
          emergency_contact: d.emergency_contact || '',
          address: typeof d.address === 'object' && d.address ? JSON.stringify(d.address) : (d.address || ''),
          remarks: d.remarks || '',
        });
        setFaceInfo({ enrolled: !!d.face_enrolled, at: d.face_enrolled_at || null });
      })
      .catch(() => toast.error('Failed to load staff record'))
      .finally(() => setIsLoading(false));
  }, [id]);

  const handleFaceReset = async () => {
    if (!(await confirm({
      message: "Reset this employee's Face ID? They'll need to re-enroll before selfie check-in works again.",
      isDangerous: true,
    }))) return;
    try {
      await apiClient.post('/api/hr/attendance/face/admin-reset/', { staff_id: id });
      setFaceInfo({ enrolled: false, at: null });
      toast.success('Face ID reset');
    } catch (e) {
      toast.error(getApiErrorMessage(e));
    }
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    if (name === 'staff_type' && value === 'EMPLOYEE') {
      // Department & Designation apply to "Staff" only — clear when Employee.
      setFormData(prev => ({ ...prev, staff_type: value, department: '', designation: '' }));
      return;
    }
    if (name === 'department') {
      setFormData(prev => ({ ...prev, department: value }));
      return;
    }
    if (name === 'designation') {
      // Office designations default Primary Location to the Office warehouses
      // of the selected companies — only when no location is picked yet.
      const isOffice = /\(office\)\s*$/i.test(value || '');
      setFormData(prev => {
        if (!isOffice || prev.location_ids.length) return { ...prev, designation: value };
        const coSet = new Set((prev.company_ids || []).map(String));
        const officeIds = (warehousesRawData || [])
          .filter(w => (w.warehouse_type || '').toUpperCase() === 'HEAD_OFFICE'
            && coSet.has(String(w.company)))
          .map(w => w.id);
        return { ...prev, designation: value, location_ids: officeIds, primary_location: officeIds[0] || '' };
      });
      return;
    }
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  // Multi-company: the first stays the primary. Primary Location is scoped to
  // the selected companies, so removing a company drops its warehouses.
  const toggleCompany = (cid) => {
    setFormData(prev => {
      const has = prev.company_ids.includes(cid);
      const nextIds = has ? prev.company_ids.filter(x => x !== cid) : [...prev.company_ids, cid];
      const coSet = new Set(nextIds.map(String));
      const validLocs = prev.location_ids.filter(lid => {
        const w = (warehousesRawData || []).find(x => String(x.id) === String(lid));
        return w && coSet.has(String(w.company));
      });
      return {
        ...prev,
        company_ids: nextIds,
        company: nextIds[0] || '',
        location_ids: validLocs,
        primary_location: validLocs[0] || '',
      };
    });
  };

  // Locations mirror companies — first pick is the primary_location.
  const toggleLocation = (value) => {
    setFormData(prev => {
      const has = prev.location_ids.includes(value);
      const nextIds = has ? prev.location_ids.filter(x => x !== value) : [...prev.location_ids, value];
      return { ...prev, location_ids: nextIds, primary_location: nextIds[0] || '' };
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const payload = {
        ...cleanFormData(formData),
        company_ids: formData.company_ids,
        company: formData.company_ids[0] || formData.company || null,
        location_ids: formData.location_ids,
        primary_location: formData.location_ids[0] || formData.primary_location || null,
        // No godown scoping — access is warehouse-level.
        godown_ids: [],
        default_godown: null,
      };
      await apiClient.put(`/api/hr/staff/${id}/`, payload);
      toast.success('Staff updated!');
      setIsEditing(false);
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: 'Are you sure you want to delete this staff record?', isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/hr/staff/${id}/`);
      toast.success('Staff deleted');
      navigate('/hr/staff');
    } catch {
      toast.error('Failed to delete');
    }
  };

  const inputClass = isEditing
    ? 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500'
    : 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 text-slate-700 cursor-default';

  if (isLoading) {
    return (
      <MainLayout>
        <div className="text-center py-16 text-slate-500">Loading...</div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <PageHeader
        title={`${formData.first_name} ${formData.last_name}`}
        subtitle={`Staff ID: ${formData.staff_id}`}
        breadcrumbs={[
          { label: 'HR', path: '/hr' },
          { label: 'Staff', path: '/hr/staff' },
          { label: formData.staff_id },
        ]}
      />

      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        {/* Action Buttons */}
        <div className="flex justify-end gap-3 mb-4">
          {!isEditing && canEdit('Staff') && (
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700"
            >
              Edit
            </button>
          )}
          {!isEditing && canDelete('Staff') && (
            <button
              type="button"
              onClick={handleDelete}
              className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700"
            >
              Delete
            </button>
          )}
        </div>

        {/* Attendance Face ID — self-enrolled by the employee; HR can reset. */}
        <div className="mb-4 flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-slate-700">Attendance Face ID:</span>
            {faceInfo.enrolled ? (
              <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                ✓ Enrolled
                {faceInfo.at && (
                  <span className="text-xs text-slate-400 font-normal">
                    · {new Date(faceInfo.at).toLocaleDateString()}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-slate-500">Not enrolled</span>
            )}
          </div>
          {faceInfo.enrolled && canEdit('Attendance') && (
            <button
              type="button"
              onClick={handleFaceReset}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 text-slate-600 hover:bg-white"
            >
              Reset
            </button>
          )}
        </div>

        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
          {/* Personal Information */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Personal Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Staff ID</label>
                <input type="text" name="staff_id" value={formData.staff_id} onChange={handleChange} readOnly={!isEditing} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Staff Type</label>
                <CustomSelect name="staff_type" value={formData.staff_type} onChange={handleChange} disabled={!isEditing} className={inputClass}>
                  <option value="">Select Staff Type</option>
                  <option value="EMPLOYEE">Employee</option>
                  <option value="STAFF">Staff</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">First Name</label>
                <input type="text" name="first_name" value={formData.first_name} onChange={handleChange} readOnly={!isEditing} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Last Name</label>
                <input type="text" name="last_name" value={formData.last_name} onChange={handleChange} readOnly={!isEditing} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Gender</label>
                <CustomSelect name="gender" value={formData.gender} onChange={handleChange} disabled={!isEditing} className={inputClass}>
                  <option value="">Select Gender</option>
                  <option value="M">Male</option>
                  <option value="F">Female</option>
                  <option value="O">Other</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Date of Birth</label>
                <CustomDatePicker name="date_of_birth" value={formData.date_of_birth} onChange={handleChange} readOnly={!isEditing} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Employment Details */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Employment Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Company</label>
                <div className="border border-slate-300 rounded-lg p-2 max-h-40 overflow-y-auto space-y-1 bg-white">
                  {companies.length === 0 ? (
                    <p className="text-sm text-slate-400 px-1">No companies</p>
                  ) : companies.map(c => {
                    const checked = formData.company_ids.includes(c.value);
                    const isPrimary = formData.company_ids[0] === c.value;
                    return (
                      <label key={c.value} className={`flex items-center gap-2 text-sm px-1 py-0.5 rounded ${isEditing ? 'hover:bg-slate-50 cursor-pointer' : 'opacity-70'}`}>
                        <input type="checkbox" checked={checked} disabled={!isEditing} onChange={() => toggleCompany(c.value)} className="rounded border-slate-300" />
                        <span>{c.label}</span>
                        {isPrimary && <span className="text-[10px] font-medium text-primary-600 bg-primary-50 px-1.5 py-0.5 rounded">primary</span>}
                      </label>
                    );
                  })}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Primary Location</label>
                <div className={`border border-slate-300 rounded-lg p-2 max-h-40 overflow-y-auto space-y-1 bg-white ${(!isEditing || !formData.company) ? 'opacity-60' : ''}`}>
                  {!formData.company ? (
                    <p className="text-sm text-slate-400 px-1">Select company first…</p>
                  ) : warehouses.length === 0 ? (
                    <p className="text-sm text-slate-400 px-1">No locations</p>
                  ) : warehouses.map(w => {
                    const checked = formData.location_ids.includes(w.value);
                    const isPrimary = formData.location_ids[0] === w.value;
                    return (
                      <label key={w.value} className={`flex items-center gap-2 text-sm px-1 py-0.5 rounded ${isEditing ? 'hover:bg-slate-50 cursor-pointer' : 'opacity-70'}`}>
                        <input type="checkbox" checked={checked} disabled={!isEditing} onChange={() => toggleLocation(w.value)} className="rounded border-slate-300" />
                        <span>{w.label}</span>
                        {isPrimary && <span className="text-[10px] font-medium text-primary-600 bg-primary-50 px-1.5 py-0.5 rounded">primary</span>}
                      </label>
                    );
                  })}
                </div>
              </div>
              {/* Department & Designation apply to "Staff" only — hidden for Employees. */}
              {formData.staff_type === 'STAFF' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Department</label>
                    <CustomSelect name="department" value={formData.department} onChange={handleChange} disabled={!isEditing} className={inputClass}>
                      <option value="">Select Department</option>
                      {DEPARTMENT_OPTIONS.map(d => <option key={d} value={d}>{d}</option>)}
                      {formData.department && !DEPARTMENT_OPTIONS.includes(formData.department) && <option value={formData.department}>{formData.department}</option>}
                    </CustomSelect>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Designation</label>
                    <CustomSelect name="designation" value={formData.designation} onChange={handleChange} disabled={!isEditing} className={inputClass}>
                      <option value="">Select Designation</option>
                      {roleOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      {formData.designation && !roleOptions.some(o => o.value === formData.designation) && <option value={formData.designation}>{formData.designation}</option>}
                    </CustomSelect>
                  </div>
                </>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Employment Start Date</label>
                <CustomDatePicker name="employment_start_date" value={formData.employment_start_date} onChange={handleChange} readOnly={!isEditing} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Employment End Date</label>
                <CustomDatePicker name="employment_end_date" value={formData.employment_end_date} onChange={handleChange} readOnly={!isEditing} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Employment Status</label>
                <CustomSelect name="employment_status" value={formData.employment_status} onChange={handleChange} disabled={!isEditing} className={inputClass}>
                  <option value="">Select Status</option>
                  <option value="ACTIVE">Active</option>
                  <option value="ON_LEAVE">On Leave</option>
                  <option value="RESIGNED">Resigned</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Salary Per Day</label>
                <div className="relative">
                  <span className="absolute left-3 top-2 text-slate-400 text-sm">₹</span>
                  <input type="number" name="salary_per_day" value={formData.salary_per_day} onChange={handleChange} readOnly={!isEditing} min="0" step="0.01" placeholder="0.00" className={`${inputClass} pl-7`} />
                </div>
                <p className="mt-1 text-xs text-slate-400">Base daily wage — multiplied by present-days in payroll.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Shift Assignment</label>
                <CustomSelect name="shift_assignment" value={formData.shift_assignment} onChange={handleChange} disabled={!isEditing} className={inputClass}>
                  <option value="">— No default shift —</option>
                  {shiftOptions.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </CustomSelect>
                <p className="mt-1 text-xs text-slate-400">Default roster shift. Auto-fills the Mark Attendance form.</p>
              </div>
              <div className="flex items-center gap-4 sm:gap-5 lg:col-span-2">
                <label className="flex items-center gap-2 text-sm font-medium text-slate-700 cursor-pointer">
                  <input type="checkbox" name="overtime_eligible" checked={formData.overtime_eligible} onChange={handleChange} disabled={!isEditing} className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500" />
                  Overtime Eligible
                </label>
                <label className="flex items-center gap-2 text-sm font-medium text-slate-700 cursor-pointer">
                  <input type="checkbox" name="contractor_flag" checked={formData.contractor_flag} onChange={handleChange} disabled={!isEditing} className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500" />
                  Contractor
                </label>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Face Template ID</label>
                <input type="text" name="face_template_id" value={formData.face_template_id} onChange={handleChange} readOnly={!isEditing} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Contact Information */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Contact Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Contact Number</label>
                <input type="text" name="contact_number" value={formData.contact_number} onChange={handleChange} readOnly={!isEditing} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                <input type="email" name="email" value={formData.email} onChange={handleChange} readOnly={!isEditing} className={inputClass} placeholder="name@company.com" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Emergency Contact</label>
                <input type="text" name="emergency_contact" value={formData.emergency_contact} onChange={handleChange} readOnly={!isEditing} className={inputClass} />
              </div>
              <div className="col-span-2 md:col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">Address</label>
                <textarea name="address" value={formData.address} onChange={handleChange} readOnly={!isEditing} rows={3} className={inputClass} />
              </div>
              <div className="col-span-2 md:col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">Remarks</label>
                <textarea name="remarks" value={formData.remarks} onChange={handleChange} readOnly={!isEditing} rows={3} className={inputClass} />
              </div>
            </div>
          </div>

          {/* Save/Cancel Buttons - only in edit mode */}
          {isEditing && (
            <div className="flex justify-end gap-3 pt-4 border-t">
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
              >
                {isSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          )}
          </EditGate>
        </form>
      </div>
    </MainLayout>
  );
}
