import CustomSelect from "@/components/ui/CustomSelect";
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { ChevronDown, ArrowLeft } from 'lucide-react';
import { groupByCategory, categoryForSlug } from '../../../utils/moduleCategories';
import PasswordField from '../../../components/common/PasswordField.jsx';
import { formatDate, formatDateTime } from '@/utils/formatters';
import { getApiErrorMessage } from '@/utils/formHelpers';
import { confirm } from '@/components/common/confirm';

export default function UserDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState({});
  const [isSaving, setIsSaving] = useState(false);
  const [collapsedCats, setCollapsedCats] = useState({});
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPwd, setResetPwd] = useState('');
  const [resetting, setResetting] = useState(false);
  const { options: roleOptions } = useLookup('/api/rbac/roles/');

  const fetchUser = () => {
    apiClient.get(`/api/rbac/users/${id}/`)
      .then(res => { setUser(res.data); setEditData(res.data); })
      .catch((err) => { if (err.response?.status !== 404) toast.error(getApiErrorMessage(err)); })
      .finally(() => setIsLoading(false));
  };

  useEffect(() => { fetchUser(); }, [id]);

  const handleEdit = () => { setIsEditing(true); setEditData({ ...user }); };
  const handleCancel = () => { setIsEditing(false); setEditData({ ...user }); };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setEditData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const payload = {
        email: editData.email || '',
        first_name: editData.first_name || '',
        last_name: editData.last_name || '',
        is_active: editData.is_active,
      };
      // Include role_id if changed
      const currentRoleId = user.role?.id;
      const newRoleId = editData.role_id || (typeof editData.role === 'object' ? editData.role?.id : editData.role);
      if (newRoleId && String(newRoleId) !== String(currentRoleId)) {
        payload.role_id = newRoleId;
      }
      const res = await apiClient.patch(`/api/rbac/users/${id}/`, payload);
      setUser(res.data);
      setIsEditing(false);
      toast.success('User updated successfully');
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  // Lost phone + spent backup codes = no way back in on their own, so an
  // admin has to be able to clear the second factor. Confirmed first
  // because it removes a security control, and it's the one action here
  // that can't be undone by re-running it.
  const [resettingMfa, setResettingMfa] = useState(false);
  const resetMfa = async () => {
    const ok = await confirm({
      title: 'Reset two-factor login?',
      message: `This removes ${user.username}'s authenticator app, every registered biometric device and all remaining backup codes. They'll sign in with their password alone until they set it up again.`,
      confirmLabel: 'Reset two-factor',
      isDangerous: true,
    });
    if (!ok) return;
    setResettingMfa(true);
    try {
      const { data } = await apiClient.post(`/api/rbac/users/${id}/reset-mfa/`);
      toast.success(data?.message || 'Two-factor login reset.');
      fetchUser();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setResettingMfa(false);
    }
  };

  const openReset = () => { setResetPwd(''); setResetOpen(true); };
  const submitReset = async () => {
    if ((resetPwd || '').length < 12) {
      toast.error('Password must be at least 12 characters');
      return;
    }
    setResetting(true);
    try {
      await apiClient.patch(`/api/rbac/users/${id}/`, { password: resetPwd });
      toast.success('Password reset — share it with the user');
      setResetOpen(false);
    } catch (err) {
      const data = err.response?.data;
      toast.error(data?.password?.[0] || getApiErrorMessage(err));
    } finally {
      setResetting(false);
    }
  };

  const fmtDate = (d) => d ? formatDate(d) : '-';
  const fmtDateTime = (d) => d ? formatDateTime(d) : 'Never';

  const inputClass = "w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500";

  if (isLoading) return <MainLayout><div className="flex justify-center py-20"><div className="animate-spin h-8 w-8 border-4 border-primary-500 border-t-transparent rounded-full" /></div></MainLayout>;
  if (!user) return (
    <MainLayout>
      <div className="text-center py-20">
        <p className="text-red-500 mb-3">User not found.</p>
        <button onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/admin/users')} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
          <ArrowLeft size={15} /> Back to Users
        </button>
      </div>
    </MainLayout>
  );

  const roleName = typeof user.role === 'object' ? user.role?.name : user.role || 'No role';
  const roleId = typeof user.role === 'object' ? user.role?.id : user.role;
  const permissions = user.permissions || [];
  const viewPerms = permissions.filter(p => p.can_view).length;
  // Only modules the role actually grants something on, grouped into
  // collapsible category accordions (mirrors the role permissions page).
  const grantedPerms = permissions.filter(p => p.can_view || p.can_create || p.can_edit || p.can_delete || p.can_approve);
  const permGroups = groupByCategory(grantedPerms, p => categoryForSlug(p.module_slug, p.category));
  const toggleCat = (key) => setCollapsedCats(prev => ({ ...prev, [key]: !(prev[key] ?? true) }));

  return (
    <MainLayout>
      <PageHeader
        title={`User: ${user.username}`}
        breadcrumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Users', href: '/admin/users' },
          { label: user.username },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-4 sm:space-y-6">
          {/* User Info */}
          <div className="bg-white rounded-lg border p-3.5 sm:p-5">
            <div className="flex items-start justify-between gap-2 mb-4 pb-3 border-b">
              <div className="flex items-center gap-2.5 sm:gap-4 min-w-0">
                <div className="w-11 h-11 sm:w-14 sm:h-14 bg-primary-600 rounded-full flex items-center justify-center shrink-0">
                  <span className="text-white text-base sm:text-xl font-bold">{(user.username || '?')[0].toUpperCase()}</span>
                </div>
                <div className="min-w-0">
                  <h2 className="text-base sm:text-xl font-bold text-slate-900 break-words leading-tight">{user.first_name || user.last_name ? `${user.first_name} ${user.last_name}`.trim() : user.username}</h2>
                  <p className="text-xs sm:text-sm text-slate-500 truncate">@{user.username}</p>
                </div>
              </div>
              <div className="flex gap-1.5 shrink-0">
                {!isEditing ? (
                  <>
                    <button onClick={handleEdit} className="px-2.5 py-1.5 sm:px-4 sm:py-2 text-xs sm:text-sm bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap">Edit</button>
                    <button onClick={openReset} className="px-2.5 py-1.5 sm:px-4 sm:py-2 text-xs sm:text-sm bg-yellow-50 text-yellow-700 border border-yellow-200 rounded-lg hover:bg-yellow-100 whitespace-nowrap">Reset Password</button>
                    <button onClick={resetMfa} disabled={resettingMfa} className="px-2.5 py-1.5 sm:px-4 sm:py-2 text-xs sm:text-sm bg-yellow-50 text-yellow-700 border border-yellow-200 rounded-lg hover:bg-yellow-100 disabled:opacity-50 whitespace-nowrap">{resettingMfa ? 'Resetting…' : 'Reset 2FA'}</button>
                  </>
                ) : (
                  <>
                    <button onClick={handleCancel} className="px-2.5 py-1.5 sm:px-4 sm:py-2 text-xs sm:text-sm bg-white border border-slate-300 rounded-lg hover:bg-slate-50">Cancel</button>
                    <button onClick={handleSave} disabled={isSaving} className="px-2.5 py-1.5 sm:px-4 sm:py-2 text-xs sm:text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 whitespace-nowrap">
                      {isSaving ? 'Saving...' : 'Save'}
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-3 sm:gap-6">
              <div>
                <label className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide block mb-0.5">Username</label>
                <p className="text-sm sm:text-base font-medium text-slate-800 break-words">{user.username}</p>
              </div>
              <div>
                <label className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide block mb-0.5">Email</label>
                {isEditing ? (
                  <input type="email" name="email" value={editData.email || ''} onChange={handleChange} className={inputClass} placeholder="Enter email" />
                ) : (
                  <p className="text-sm sm:text-base font-medium text-slate-800 break-words">{user.email || <span className="text-slate-400 italic">Not set</span>}</p>
                )}
              </div>
              <div>
                <label className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide block mb-0.5">First Name</label>
                {isEditing ? (
                  <input type="text" name="first_name" value={editData.first_name || ''} onChange={handleChange} className={inputClass} />
                ) : (
                  <p className="text-sm sm:text-base font-medium text-slate-800 break-words">{user.first_name || '-'}</p>
                )}
              </div>
              <div>
                <label className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide block mb-0.5">Last Name</label>
                {isEditing ? (
                  <input type="text" name="last_name" value={editData.last_name || ''} onChange={handleChange} className={inputClass} />
                ) : (
                  <p className="text-sm sm:text-base font-medium text-slate-800 break-words">{user.last_name || '-'}</p>
                )}
              </div>
              <div>
                <label className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide block mb-0.5">Role</label>
                {isEditing ? (
                  <CustomSelect name="role_id" value={editData.role_id || roleId || ''} onChange={handleChange} className={inputClass}>
                    <option value="">No Role</option>
                    {roleOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                ) : (
                  <p className="text-sm sm:text-base font-medium text-primary-700 cursor-pointer hover:underline break-words" onClick={() => roleId && navigate(`/admin/roles/${roleId}`)}>
                    {roleName}
                  </p>
                )}
              </div>
              <div>
                <label className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide block mb-0.5">Status</label>
                {isEditing ? (
                  <label className="flex items-center gap-2 mt-1">
                    <input type="checkbox" name="is_active" checked={editData.is_active} onChange={handleChange} className="rounded" />
                    <span className="text-sm">{editData.is_active ? 'Active' : 'Inactive'}</span>
                  </label>
                ) : (
                  <StatusBadge status={user.is_active ? 'Active' : 'Inactive'} />
                )}
              </div>
            </div>
          </div>

          {/* Permissions */}
          <div className="bg-white rounded-lg border p-3.5 sm:p-5">
            <div className="flex items-center justify-between gap-2 mb-3 pb-2 border-b">
              <h3 className="text-base sm:text-lg font-semibold text-slate-800 min-w-0 break-words">Permissions (via Role: {roleName})</h3>
              <button onClick={() => navigate('/admin/permissions')} className="text-xs sm:text-sm text-primary-600 hover:underline whitespace-nowrap shrink-0">Edit Permissions</button>
            </div>
            {permissions.length === 0 ? (
              <p className="text-sm text-slate-400 italic">No permissions assigned. Assign a role to grant permissions.</p>
            ) : (
              <>
              {/* Mobile: collapsible category accordions (like the role
                  permissions page) so the long module list isn't one
                  endless scroll. Each group is collapsed by default. */}
              <div className="sm:hidden space-y-2">
                {permGroups.map(group => {
                  const isCollapsed = collapsedCats[group.key] ?? true;
                  return (
                    <div key={group.key} className="border border-slate-200 rounded-lg overflow-hidden">
                      <button
                        type="button"
                        onClick={() => toggleCat(group.key)}
                        className="w-full flex items-center justify-between px-3 py-2.5 bg-slate-50 hover:bg-slate-100 transition"
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <ChevronDown size={15} className={`text-slate-400 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                          <span className="font-bold text-xs text-slate-600 tracking-wider uppercase truncate">{group.label}</span>
                        </span>
                        <span className="text-[10px] text-slate-400 bg-slate-200 px-1.5 py-0.5 rounded-full whitespace-nowrap">{group.items.length}</span>
                      </button>
                      {!isCollapsed && (
                        <div className="p-2 space-y-2 bg-white">
                          {group.items.map(p => {
                            const flags = [
                              { k: 'can_view', label: 'View' },
                              { k: 'can_create', label: 'Create' },
                              { k: 'can_edit', label: 'Edit' },
                              { k: 'can_delete', label: 'Delete' },
                              { k: 'can_approve', label: 'Approve' },
                              { k: 'can_reject', label: 'Reject' },
                              { k: 'can_send_email', label: 'Email' },
                              { k: 'can_export', label: 'Export' },
                              { k: 'can_print', label: 'Print' },
                            ].filter(f => p[f.k]);
                            return (
                              <div key={`m-${p.module_name}`} className="bg-white border border-slate-200 rounded-lg p-3">
                                <div className="text-sm font-semibold text-slate-800 mb-2">{p.module_name}</div>
                                <div className="flex flex-wrap gap-1.5">
                                  {flags.map(f => (
                                    <span key={f.k} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border bg-emerald-50 text-emerald-700 border-emerald-200">
                                      <span>✓</span> {f.label}
                                    </span>
                                  ))}
                                  {flags.length === 0 && <span className="text-xs text-slate-400 italic">No actions</span>}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {/* Hint — make it obvious that this unified table sums
                  up settings from multiple tabs on the role permissions
                  grid, so admins don't think the data is "wrong" when
                  one tab shows fewer ticks than this view. */}
              <p className="text-xs text-slate-500 mb-2">
                This table is the union of settings from the role's <span className="font-medium text-slate-700">Page Permissions</span> and <span className="font-medium text-slate-700">Button Permissions</span> tabs in the role grid.
              </p>
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-sm min-w-[600px]">
                  <thead>
                    {/* Group header row: visually splits the unified
                        permission columns into the tabs that actually
                        configure them. View/Create/Edit/Delete live on
                        the Page Permissions tab; Approve through Print
                        live on the Button Permissions tab. */}
                    <tr className="border-b">
                      <th className="px-3 py-1.5 bg-slate-50 sticky left-0"></th>
                      <th colSpan={4} className="text-center px-2 py-1.5 text-[10px] uppercase tracking-wide font-semibold text-blue-700 bg-blue-50 border-x border-blue-100">
                        Page Permissions
                      </th>
                      <th colSpan={5} className="text-center px-2 py-1.5 text-[10px] uppercase tracking-wide font-semibold text-violet-700 bg-violet-50 border-x border-violet-100">
                        Button Permissions
                      </th>
                    </tr>
                    <tr className="bg-slate-50 border-b">
                      <th className="text-left px-3 py-2 font-semibold text-slate-600 sticky left-0 bg-slate-50">Module</th>
                      <th className="text-center px-2 py-2 text-[11px] uppercase text-slate-500">View</th>
                      <th className="text-center px-2 py-2 text-[11px] uppercase text-slate-500">Create</th>
                      <th className="text-center px-2 py-2 text-[11px] uppercase text-slate-500">Edit</th>
                      <th className="text-center px-2 py-2 text-[11px] uppercase text-slate-500">Delete</th>
                      <th className="text-center px-2 py-2 text-[11px] uppercase text-slate-500">Approve</th>
                      <th className="text-center px-2 py-2 text-[11px] uppercase text-slate-500">Reject</th>
                      <th className="text-center px-2 py-2 text-[11px] uppercase text-slate-500">Email</th>
                      <th className="text-center px-2 py-2 text-[11px] uppercase text-slate-500">Export</th>
                      <th className="text-center px-2 py-2 text-[11px] uppercase text-slate-500">Print</th>
                    </tr>
                  </thead>
                  <tbody>
                    {permissions.filter(p => p.can_view || p.can_create || p.can_edit || p.can_delete || p.can_approve).map(p => (
                      <tr key={p.module_name} className="border-b border-slate-50">
                        <td className="px-3 py-1.5 font-medium text-slate-700 sticky left-0 bg-white">{p.module_name}</td>
                        {['can_view', 'can_create', 'can_edit', 'can_delete', 'can_approve', 'can_reject', 'can_send_email', 'can_export', 'can_print'].map(k => (
                          <td key={k} className="text-center px-2 py-1.5">
                            {p[k] ? (
                              <span className="text-green-500">✓</span>
                            ) : (
                              <span className="text-slate-200">–</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4 sm:space-y-6">
          <div className="bg-white rounded-lg border p-3.5 sm:p-5">
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 pb-2 border-b">Account Info</h3>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-x-3 gap-y-3">
                <div>
                  <p className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide mb-1">Status</p>
                  <StatusBadge status={user.is_active ? 'Active' : 'Inactive'} />
                </div>
                <div>
                  <p className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide">Role</p>
                  <p className="text-sm font-medium text-primary-700 mt-0.5 break-words">{roleName}</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-x-3">
                <div>
                  <p className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide">Superuser</p>
                  <p className="text-sm font-medium text-slate-900 mt-0.5">{user.is_superuser ? 'Yes' : 'No'}</p>
                </div>
                <div>
                  <p className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide">Staff</p>
                  <p className="text-sm font-medium text-slate-900 mt-0.5">{user.is_staff ? 'Yes' : 'No'}</p>
                </div>
                <div>
                  <p className="text-[10px] sm:text-xs text-slate-500 font-medium uppercase tracking-wide">Modules</p>
                  <p className="text-sm font-bold text-blue-600 mt-0.5">{viewPerms}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg border p-3.5 sm:p-5">
            <h3 className="text-base sm:text-lg font-semibold text-slate-800 mb-3 pb-2 border-b">Actions</h3>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/admin/users')} className={`px-4 py-2 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 ${roleId ? '' : 'col-span-2'}`}>← Back to Users</button>
              {roleId && (
                <button onClick={() => navigate(`/admin/roles/${roleId}`)} className="px-4 py-2 text-sm bg-primary-50 text-primary-700 rounded-lg hover:bg-primary-100">View Role Details</button>
              )}
            </div>
          </div>
        </div>
      </div>

      {resetOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !resetting && setResetOpen(false)}
        >
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5" role="dialog" aria-modal="true" aria-label="Reset Password" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-slate-800 mb-1">Reset Password</h3>
            <p className="text-xs text-slate-500 mb-4">
              Set a new password for <span className="font-medium">{user.username}</span>. Generate one and copy it so you can share it with the user.
            </p>
            <PasswordField value={resetPwd} onChange={setResetPwd} hint="Minimum 12 characters." />
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setResetOpen(false)} disabled={resetting} className="px-4 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50">Cancel</button>
              <button onClick={submitReset} disabled={resetting} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50">{resetting ? 'Saving…' : 'Reset Password'}</button>
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  );
}
