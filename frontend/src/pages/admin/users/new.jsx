import CustomSelect from "@/components/ui/CustomSelect";
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { cleanFormData, getApiErrorMessage } from '../../../utils/formHelpers.js';
import useLookup from '../../../hooks/useLookup.js';
import PasswordField from '../../../components/common/PasswordField.jsx';

export default function CreateAdminUser() {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    staff: '',
    username: '',
    email: '',
    first_name: '',
    last_name: '',
    password: '',
    role: '',
  });

  const { raw: staffList } = useLookup('/api/hr/staff/');
  // Hide staff who already have a login account — one user per staff.
  const staffOptions = staffList
    .filter(s => !s.has_user)
    .map(s => ({
      value: s.id,
      label: `${s.staff_id || ''} - ${s.first_name || ''} ${s.last_name || ''}`.trim() || String(s.id),
    }));

  const { options: roleOptions } = useLookup('/api/rbac/roles/');

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleStaffChange = (e) => {
    const staffId = e.target.value;
    const staff = staffList.find(s => String(s.id) === String(staffId));
    // Auto-fill the Role from the staff member's Designation. Designation
    // stores a Role name, so match it against the loaded role options:
    // first an exact (normalised) match, then a lenient fallback where a
    // role name is contained in the designation (e.g. "IT Administrator"
    // → "IT Admin"), preferring the longest / most-specific match.
    const norm = (x) => String(x || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const desig = norm(staff?.designation);
    let matchedRole = null;
    if (desig && roleOptions.length) {
      matchedRole = roleOptions.find(o => norm(o.label) === desig)
        || roleOptions
            .filter(o => norm(o.label) && desig.includes(norm(o.label)))
            .sort((a, b) => norm(b.label).length - norm(a.label).length)[0]
        || null;
    }
    setFormData(prev => ({
      ...prev,
      staff: staffId,
      username: staff ? (staff.staff_id || staff.first_name || '').toLowerCase().replace(/\s+/g, '') : prev.username,
      // Prefill the name + email from the staff record so the account isn't
      // created with staff_name === username (the old behaviour) or a blank
      // email. Each falls back to the existing value when the staff lacks it.
      first_name: staff ? (staff.first_name || prev.first_name) : prev.first_name,
      last_name: staff ? (staff.last_name || prev.last_name) : prev.last_name,
      email: staff ? (staff.email || prev.email) : prev.email,
      // Auto-fill Role from the staff's Designation when a matching role exists.
      role: matchedRole ? matchedRole.value : prev.role,
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.staff) {
      toast.error('Please select a Staff Member');
      return;
    }
    // Client-side hint for the server policy (min 12 chars). The backend
    // runs the full AUTH_PASSWORD_VALIDATORS set and is the source of truth.
    if ((formData.password || '').length < 12) {
      toast.error('Password must be at least 12 characters');
      return;
    }
    setIsLoading(true);
    try {
      const payload = {
        username: formData.username,
        password: formData.password,
        email: formData.email,
        first_name: formData.first_name,
        last_name: formData.last_name,
        staff: formData.staff || undefined,
        role_id: formData.role || undefined,
      };
      // Remove empty values
      Object.keys(payload).forEach(k => { if (payload[k] === undefined || payload[k] === '') delete payload[k]; });
      if (import.meta.env.DEV) console.log('[CreateAdminUser] payload:', payload);
      await apiClient.post('/api/rbac/users/', payload);
      toast.success('User created successfully!');
      navigate('/admin/users');
    } catch (error) {
      if (import.meta.env.DEV) console.error('[CreateAdminUser] error:', error.response?.data);
      toast.error(getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MainLayout>
      <PageHeader
        title="Create User"
        subtitle="Add a new ERP user account"
        breadcrumbs={[
          { label: 'Admin' },
          { label: 'Users', href: '/admin/users' },
          { label: 'Create New' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-5">
          {/* Section: User Information */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">User Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Staff Member <span className="text-red-500">*</span></label>
                <CustomSelect name="staff" value={formData.staff} onChange={handleStaffChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select staff...</option>
                  {staffOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </CustomSelect>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Username <span className="text-red-500">*</span></label>
                <input type="text" name="username" value={formData.username} onChange={handleChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Enter username" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                <input type="email" name="email" value={formData.email} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="user@example.com" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">First Name</label>
                <input type="text" name="first_name" value={formData.first_name} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="First name" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Last Name</label>
                <input type="text" name="last_name" value={formData.last_name} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="Last name" />
              </div>
              <div className="col-span-2 lg:col-span-3">
                <label className="block text-sm font-medium text-slate-700 mb-1">Password <span className="text-red-500">*</span></label>
                <PasswordField
                  value={formData.password}
                  onChange={(next) => setFormData(prev => ({ ...prev, password: next }))}
                  hint="Minimum 12 characters. After saving, share it with the user — they'll need it to log in."
                />
              </div>
            </div>
          </div>

          {/* Section: Role Assignment */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Role Assignment</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Role <span className="text-red-500">*</span></label>
                <CustomSelect name="role" value={formData.role} onChange={handleChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select role...</option>
                  {roleOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </CustomSelect>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving...' : 'Save'}</button>
          </div>
        </form>
      </div>
    </MainLayout>
  );
}
