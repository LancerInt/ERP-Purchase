import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import PasswordField from '../../../components/common/PasswordField.jsx';
import { formatDateTime } from '@/utils/formatters';
import { getApiErrorMessage } from '@/utils/formHelpers';

export default function EditAdminUser() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [passwordLastChanged, setPasswordLastChanged] = useState(null);
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    is_active: true,
    role_id: '',
    // Optional — only sent to the API when non-empty so admins can
    // update other fields without forcing a password reset.
    password: '',
  });

  const { options: roleOptions } = useLookup('/api/rbac/roles/');

  // Fetch existing user data
  useEffect(() => {
    apiClient.get(`/api/rbac/users/${id}/`)
      .then(res => {
        const user = res.data;
        setFormData(prev => ({
          ...prev,
          username: user.username || '',
          email: user.email || '',
          is_active: user.is_active !== false,
          role_id: user.role?.id || '',
        }));
        setPasswordLastChanged(user.password_last_changed || null);
      })
      .catch(() => toast.error('Failed to load user'))
      .finally(() => setIsFetching(false));
  }, [id]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Light client-side check — backend hashes the password but does
    // not enforce a minimum, so we gate it here. Empty = unchanged.
    const newPassword = formData.password?.trim() || '';
    if (newPassword && newPassword.length < 12) {
      toast.error('Password must be at least 12 characters');
      return;
    }
    setIsLoading(true);
    try {
      // Build PATCH payload — only include password when the admin
      // actually typed one. The backend's perform_update() pulls it
      // off and calls set_password() so it's hashed correctly.
      const payload = {
        email: formData.email,
        is_active: formData.is_active,
      };
      if (newPassword) payload.password = newPassword;

      await apiClient.patch(`/api/rbac/users/${id}/`, payload);

      // Assign role if changed
      if (formData.role_id) {
        await apiClient.post(`/api/rbac/users/${id}/assign-role/`, {
          role_id: formData.role_id,
        });
      }

      toast.success(newPassword ? 'User and password updated' : 'User updated successfully!');
      navigate('/admin/users');
    } catch (error) {
      const data = error.response?.data;
      toast.error(data?.password?.[0] || getApiErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  if (isFetching) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center py-24">
          <div className="w-8 h-8 border-4 border-primary-600 border-t-transparent rounded-full animate-spin"></div>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <PageHeader
        title={`Edit User: ${formData.username}`}
        subtitle="Update user account and role"
        breadcrumbs={[
          { label: 'Admin' },
          { label: 'Users', href: '/admin/users' },
          { label: 'Edit' },
        ]}
      />
      <div className="bg-white rounded-lg border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-5">
          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">User Information</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Username</label>
                <input type="text" value={formData.username} disabled className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 text-slate-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                <input type="email" name="email" value={formData.email} onChange={handleChange} className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500" placeholder="user@example.com" />
              </div>
              <div className="flex items-center pt-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" name="is_active" checked={formData.is_active} onChange={handleChange} className="rounded border-slate-300 text-primary-600 focus:ring-primary-500" />
                  <span className="text-sm font-medium text-slate-700">Active</span>
                </label>
              </div>
            </div>
          </div>

          <div>
            <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 mb-4 pb-2 border-b">
              <h3 className="text-lg font-semibold text-slate-800">Password</h3>
              <div className="flex flex-col items-start sm:items-end gap-0.5">
                <span className="text-xs text-slate-500">Leave blank to keep the current password</span>
                {passwordLastChanged ? (
                  <span className="text-[11px] text-slate-400">
                    Last changed: <span className="font-medium text-slate-600">{formatDateTime(passwordLastChanged)}</span>
                  </span>
                ) : (
                  <span className="text-[11px] text-slate-400 italic">No password change recorded yet</span>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="col-span-2 lg:col-span-2">
                <label className="block text-sm font-medium text-slate-700 mb-1">New Password</label>
                <PasswordField
                  value={formData.password}
                  onChange={(next) => setFormData(prev => ({ ...prev, password: next }))}
                  hint="Minimum 12 characters. After saving, share the password with the user — they'll need it to log in."
                />
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Role Assignment</h3>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Role <span className="text-red-500">*</span></label>
                <CustomSelect name="role_id" value={formData.role_id} onChange={handleChange} required className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500">
                  <option value="">Select role...</option>
                  {roleOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </CustomSelect>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button type="button" onClick={() => navigate(-1)} className="px-4 sm:px-5 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
            <button type="submit" disabled={isLoading} className="px-4 sm:px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50">{isLoading ? 'Saving...' : 'Save Changes'}</button>
          </div>
        </form>
      </div>
    </MainLayout>
  );
}
