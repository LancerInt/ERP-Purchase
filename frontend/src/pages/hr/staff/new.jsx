import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import EditGate from '../../../components/common/EditGate.jsx';

// Fixed department picklist for the Staff form (replaces free-text entry).
const DEPARTMENT_OPTIONS = ['Sales', 'Purchase', 'Finance', 'HR', 'Accounts', 'Management', 'Manager', 'QC Team', 'Warehouse Management'];

export default function CreateStaff() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const editable = canCreate('Staff');
  const { options: companies } = useLookup('/api/companies/');
  const { options: vendors } = useLookup('/api/vendors/');
  // Designation options are the system Roles (Accounts Manager, Finance
  // Manager, …) so HR picks a real role instead of typing free text.
  const { options: roleOptions } = useLookup('/api/rbac/roles/', { labelField: 'name', valueField: 'name' });
  const [isLoading, setIsLoading] = useState(false);
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
    // Optional default godown — pre-fills Godown pickers on purchase
    // forms (Purchase Request, Receipt) so warehouse coordinators
    // don't have to pick the same godown every time. Must belong to
    // primary_location; the picker is scoped on the frontend.
    default_godown: '',
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

  // All Warehouses — filtered client-side to the selected companies below,
  // so Primary Location only offers locations of the chosen company/companies.
  const { options: warehousesRaw, raw: warehousesRawData } = useLookup('/api/warehouses/');

  // Primary Location options = warehouses of the selected companies, deduped.
  // (Warehouse.company is a single FK — see the office-default logic.)
  const warehouses = useMemo(() => {
    const coSet = new Set((formData.company_ids || []).map(String));
    const companyByWh = new Map((warehousesRawData || []).map(w => [String(w.id), String(w.company)]));
    const seen = new Set();
    const out = [];
    for (const opt of (warehousesRaw || [])) {
      const key = String(opt.value);
      if (seen.has(key)) continue;
      // Only show warehouses that belong to a selected company.
      if (coSet.size && !coSet.has(companyByWh.get(key))) continue;
      seen.add(key);
      out.push(opt);
    }
    return out;
  }, [warehousesRaw, warehousesRawData, formData.company_ids]);
  // Active shifts — scoped to the picked warehouse when one is set so
  // the dropdown only offers shifts the staff could actually be
  // rostered on. Falls back to all shifts before a warehouse is
  // chosen so the user can still see the list.
  const { options: shiftOptions } = useLookup(
    formData.primary_location
      ? `/api/hr/shifts/?warehouse=${formData.primary_location}`
      : '/api/hr/shifts/',
    { labelField: (s) => `${s.shift_code} — ${s.shift_name}` },
  );

  // Staff ID is auto-assigned from the primary location: STAFF-OFF-### for an
  // office, else STAFF-<warehouse-token>-### (e.g. NKP-UAI / NKP-SS both →
  // STAFF-NKP-###). Live preview here; the real id is generated on save.
  const [staffIdPreview, setStaffIdPreview] = useState('');
  useEffect(() => {
    const loc = formData.primary_location;
    if (!loc) { setStaffIdPreview(''); return; }
    let cancelled = false;
    apiClient.get(`/api/hr/staff/next-id/?location=${loc}`)
      .then(res => { if (!cancelled) setStaffIdPreview(res.data?.staff_id || ''); })
      .catch(() => { if (!cancelled) setStaffIdPreview(''); });
    return () => { cancelled = true; };
  }, [formData.primary_location]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    if (name === 'staff_type') {
      // Department & Designation apply to "Staff" only — clear them when
      // switching to "Employee" so stale values aren't submitted and the
      // now-hidden required selects can't block the form.
      setFormData(prev => ({
        ...prev,
        staff_type: value,
        ...(value === 'EMPLOYEE' ? { department: '', designation: '' } : {}),
      }));
      return;
    }
    if (name === 'department') {
      setFormData(prev => ({ ...prev, department: value }));
      return;
    }
    if (name === 'designation') {
      // Office designations (ending in "(Office)") default the Primary
      // Location to the Office-type warehouses of the selected companies —
      // but only when no location has been picked yet, so a manual choice
      // is never overwritten.
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

  // A staff member can span several companies; the first pick is the primary
  // (payroll/attendance scoping). Primary Location is scoped to the selected
  // companies, so removing a company also drops its warehouses from the picks.
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

  // Locations mirror companies: the first pick is the primary_location (drives
  // the shift picker).
  const toggleLocation = (value) => {
    setFormData(prev => {
      const has = prev.location_ids.includes(value);
      const nextIds = has ? prev.location_ids.filter(x => x !== value) : [...prev.location_ids, value];
      return {
        ...prev,
        location_ids: nextIds,
        primary_location: nextIds[0] || '',
      };
    });
  };

  // Resolve a location id to its name for the selected-summary line.
  const locName = (id) => {
    const w = (warehousesRawData || []).find(x => String(x.id) === String(id));
    return w ? w.name : id;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!(formData.location_ids[0] || formData.primary_location)) {
      toast.error('Pick a primary location — the Staff ID is generated from it.');
      return;
    }
    setIsLoading(true);
    try {
      const payload = {
        ...cleanFormData(formData),
        company_ids: formData.company_ids,
        company: formData.company_ids[0] || formData.company || null,
        location_ids: formData.location_ids,
        primary_location: formData.location_ids[0] || formData.primary_location || null,
        // No godown scoping — access is warehouse-level, so all godowns in a
        // staff's warehouses are reachable.
        godown_ids: [],
        default_godown: null,
      };
      delete payload.staff_id;   // server assigns it from the primary location
      await apiClient.post('/api/hr/staff/', payload);
      toast.success('Staff created!');
      navigate('/hr/staff');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create Staff"
        breadcrumbs={[
          { label: 'HR', path: '/hr' },
          { label: 'Staff', path: '/hr/staff' },
          { label: 'Create Staff' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleSubmit}>
          <EditGate canEdit={editable} className="space-y-4 sm:space-y-5">
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Personal Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Staff ID <span className="text-xs font-normal text-slate-500">(auto)</span>
                </label>
                <input
                  type="text"
                  readOnly
                  value={staffIdPreview || (formData.primary_location ? 'Generating…' : 'Pick a primary location below')}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-slate-100 text-slate-500 cursor-not-allowed"
                />
                <p className="text-xs text-slate-400 mt-1">Assigned automatically on save, from the primary location.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Staff Type <span className="text-red-500">*</span>
                </label>
                <CustomSelect
                  name="staff_type"
                  value={formData.staff_type}
                  onChange={handleChange}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                >
                  <option value="">Select Staff Type</option>
                  <option value="EMPLOYEE">Employee</option>
                  <option value="STAFF">Staff</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  First Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="first_name"
                  value={formData.first_name}
                  onChange={handleChange}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Enter first name"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Last Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="last_name"
                  value={formData.last_name}
                  onChange={handleChange}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Enter last name"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Gender</label>
                <CustomSelect
                  name="gender"
                  value={formData.gender}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                >
                  <option value="">Select Gender</option>
                  <option value="M">Male</option>
                  <option value="F">Female</option>
                  <option value="O">Other</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Date of Birth</label>
                <CustomDatePicker
                  name="date_of_birth"
                  value={formData.date_of_birth}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Employment Details</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Company <span className="text-red-500">*</span>
                </label>
                <div className="border border-slate-300 rounded-lg p-2 max-h-40 overflow-y-auto space-y-1 bg-white">
                  {companies.length === 0 ? (
                    <p className="text-sm text-slate-400 px-1">Loading companies…</p>
                  ) : companies.map(c => {
                    const checked = formData.company_ids.includes(c.value);
                    const isPrimary = formData.company_ids[0] === c.value;
                    return (
                      <label key={c.value} className="flex items-center gap-2 text-sm px-1 py-0.5 rounded hover:bg-slate-50 cursor-pointer">
                        <input type="checkbox" checked={checked} onChange={() => toggleCompany(c.value)} className="rounded border-slate-300" />
                        <span>{c.label}</span>
                        {isPrimary && <span className="text-[10px] font-medium text-primary-600 bg-primary-50 px-1.5 py-0.5 rounded">primary</span>}
                      </label>
                    );
                  })}
                </div>
                <p className="text-[11px] text-slate-400 mt-1">Pick one or more — the first is the primary company (drives location & payroll).</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Primary Location <span className="text-red-500">*</span>
                </label>
                <div className={`border border-slate-300 rounded-lg p-2 max-h-40 overflow-y-auto space-y-1 bg-white ${!formData.company ? 'opacity-60' : ''}`}>
                  {!formData.company ? (
                    <p className="text-sm text-slate-400 px-1">Select company first…</p>
                  ) : warehouses.length === 0 ? (
                    <p className="text-sm text-slate-400 px-1">No locations</p>
                  ) : warehouses.map(w => {
                    const checked = formData.location_ids.includes(w.value);
                    const isPrimary = formData.location_ids[0] === w.value;
                    return (
                      <label key={w.value} className="flex items-center gap-2 text-sm px-1 py-0.5 rounded hover:bg-slate-50 cursor-pointer">
                        <input type="checkbox" checked={checked} onChange={() => toggleLocation(w.value)} className="rounded border-slate-300" />
                        <span>{w.label}</span>
                        {isPrimary && <span className="text-[10px] font-medium text-primary-600 bg-primary-50 px-1.5 py-0.5 rounded">primary</span>}
                      </label>
                    );
                  })}
                </div>
                {formData.location_ids.some(id => !warehouses.find(w => w.value === id)) && (
                  <p className="text-[11px] text-slate-500 mt-1">Selected: {formData.location_ids.map(locName).join(', ')}</p>
                )}
                <p className="text-[11px] text-slate-400 mt-1">Pick one or more — the first is the primary location.</p>
              </div>
              {/* Department & Designation apply to "Staff" only — hidden for Employees. */}
              {formData.staff_type === 'STAFF' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">
                      Department <span className="text-red-500">*</span>
                    </label>
                    <CustomSelect
                      name="department"
                      value={formData.department}
                      onChange={handleChange}
                      required
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    >
                      <option value="">Select Department</option>
                      {DEPARTMENT_OPTIONS.map(d => <option key={d} value={d}>{d}</option>)}
                    </CustomSelect>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">
                      Designation <span className="text-red-500">*</span>
                    </label>
                    <CustomSelect
                      name="designation"
                      value={formData.designation}
                      onChange={handleChange}
                      required
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    >
                      <option value="">Select Designation</option>
                      {roleOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </CustomSelect>
                  </div>
                </>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Employment Start Date <span className="text-red-500">*</span>
                </label>
                <CustomDatePicker
                  name="employment_start_date"
                  value={formData.employment_start_date}
                  onChange={handleChange}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Employment End Date</label>
                <CustomDatePicker
                  name="employment_end_date"
                  value={formData.employment_end_date}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Employment Status <span className="text-red-500">*</span>
                </label>
                <CustomSelect
                  name="employment_status"
                  value={formData.employment_status}
                  onChange={handleChange}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                >
                  <option value="">Select Status</option>
                  <option value="ACTIVE">Active</option>
                  <option value="ON_LEAVE">On Leave</option>
                  <option value="RESIGNED">Resigned</option>
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Salary Per Day
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-2 text-slate-400 text-sm">₹</span>
                  <input
                    type="number"
                    name="salary_per_day"
                    value={formData.salary_per_day}
                    onChange={handleChange}
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    className="w-full pl-7 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  />
                </div>
                <p className="mt-1 text-xs text-slate-400">Base daily wage — multiplied by present-days in payroll.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Shift Assignment
                </label>
                <CustomSelect
                  name="shift_assignment"
                  value={formData.shift_assignment}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                >
                  <option value="">— No default shift —</option>
                  {shiftOptions.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </CustomSelect>
                <p className="mt-1 text-xs text-slate-400">Default roster shift. Auto-fills the Mark Attendance form.</p>
              </div>
              <div className="flex items-center gap-4 sm:gap-5 col-span-2 lg:col-span-3">
                <label className="flex items-center gap-2 text-sm font-medium text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    name="overtime_eligible"
                    checked={formData.overtime_eligible}
                    onChange={handleChange}
                    className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                  />
                  Overtime Eligible
                </label>
                <label className="flex items-center gap-2 text-sm font-medium text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    name="contractor_flag"
                    checked={formData.contractor_flag}
                    onChange={handleChange}
                    className="w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                  />
                  Contractor
                </label>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Face Template ID</label>
                <input
                  type="text"
                  name="face_template_id"
                  value={formData.face_template_id}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Enter face template ID"
                />
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Contact Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Contact Number <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="contact_number"
                  value={formData.contact_number}
                  onChange={handleChange}
                  required
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Enter contact number"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                <input
                  type="email"
                  name="email"
                  value={formData.email}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="name@company.com"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Emergency Contact</label>
                <input
                  type="text"
                  name="emergency_contact"
                  value={formData.emergency_contact}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Enter emergency contact"
                />
              </div>
              <div className="col-span-2 md:col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">Address</label>
                <textarea
                  name="address"
                  value={formData.address}
                  onChange={handleChange}
                  rows={3}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  placeholder="Enter address"
                />
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
