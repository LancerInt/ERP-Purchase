import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';

const PERM_COLS = [
  { key: 'can_view', label: 'View', color: 'blue' },
  { key: 'can_create', label: 'Create', color: 'green' },
  { key: 'can_edit', label: 'Edit', color: 'yellow' },
  { key: 'can_delete', label: 'Delete', color: 'red' },
  { key: 'can_approve', label: 'Approve', color: 'emerald' },
  { key: 'can_reject', label: 'Reject', color: 'orange' },
  { key: 'can_send_email', label: 'Send Email', color: 'purple' },
  { key: 'can_export', label: 'Export', color: 'cyan' },
  { key: 'can_print', label: 'Print', color: 'slate' },
];

const MODULE_GROUPS = {
  'PURCHASE': ['Purchase Request', 'RFQ', 'Quote', 'Quote Evaluation', 'Purchase Order', 'Receipt Advice', 'Freight Advice', 'Vendor Payment', 'Vendor Bill', 'Payment Made', 'Vendor Credit'],
  'SALES': ['Customer PO', 'Sales Order', 'Dispatch Challan', 'Sales Invoice', 'Sales Freight', 'Receivable'],
  'PRODUCTION': ['BOM Request', 'Work Order', 'Wage Voucher', 'Material Issue', 'Yield Log'],
  'QUALITY': ['QC Parameter', 'QC Request', 'QC Lab Job', 'QC Report', 'Counter Sample'],
  'INVENTORY': ['Stock Transfer', 'Shifting', 'Job Work Order', 'Sales Return', 'Stock Adjustment'],
  'FINANCE': ['Vendor Ledger', 'Customer Ledger', 'Payment Advice', 'Credit/Debit Note', 'GST Report', 'Petty Cash', 'Freight Ledger', 'Wage Ledger'],
  'BANK': ['Bank Dashboard', 'Bank Account', 'Bank Receipt', 'Bank Payment', 'Reconcile Statement'],
  'HR': ['Staff', 'Shift', 'Attendance', 'Leave', 'Overtime', 'Payroll'],
  'MASTERS': ['Company', 'Warehouse', 'Godown', 'Machinery', 'Product', 'Service Catalogue', 'Vendor', 'Customer', 'Transporter', 'Price List', 'Tax Master', 'Template'],
  'ADMIN': ['Audit Log', 'User Management', 'Role Management', 'Permission Management'],
};

export default function RoleDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [role, setRole] = useState(null);
  const [permissions, setPermissions] = useState([]);
  const [users, setUsers] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [mfaSaving, setMfaSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      apiClient.get(`/api/rbac/roles/${id}/`),
      apiClient.get(`/api/rbac/role-permissions/?role=${id}&page_size=500`),
      apiClient.get(`/api/rbac/users/?page_size=500`),
    ]).then(([roleRes, permRes, userRes]) => {
      setRole(roleRes.data);
      const perms = permRes.data?.results || permRes.data || [];
      setPermissions(perms);
      const allUsers = userRes.data?.results || userRes.data || [];
      const roleUsers = allUsers.filter(u => {
        const r = u.role;
        if (!r) return false;
        if (typeof r === 'object') return String(r.id) === String(id);
        return String(r) === String(id);
      });
      setUsers(roleUsers);
    }).catch((err) => { if (err.response?.status !== 404) toast.error('Failed to load role'); })
      .finally(() => setIsLoading(false));
  }, [id]);

  const toggleMfaRequired = async () => {
    setMfaSaving(true);
    try {
      const { data } = await apiClient.patch(`/api/rbac/roles/${id}/`, { mfa_required: !role.mfa_required });
      setRole(data);
      toast.success(
        data.mfa_required
          ? 'Two-factor login is now required for this role.'
          : 'Two-factor login is no longer required for this role.',
      );
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setMfaSaving(false);
    }
  };

  if (isLoading) return <MainLayout><div className="flex justify-center py-20"><div className="animate-spin h-8 w-8 border-4 border-primary-500 border-t-transparent rounded-full" /></div></MainLayout>;
  if (!role) return (
    <MainLayout>
      <div className="text-center py-20">
        <p className="text-red-500 mb-3">Role not found.</p>
        <button onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/admin/roles')} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">
          <ArrowLeft size={15} /> Back to Roles
        </button>
      </div>
    </MainLayout>
  );

  // Group permissions by module category
  const getGroup = (moduleName) => {
    for (const [group, modules] of Object.entries(MODULE_GROUPS)) {
      if (modules.includes(moduleName)) return group;
    }
    return 'OTHER';
  };

  const groupedPerms = {};
  permissions.forEach(p => {
    const group = getGroup(p.module_name);
    if (!groupedPerms[group]) groupedPerms[group] = [];
    groupedPerms[group].push(p);
  });

  // Stats
  const totalModules = permissions.length;
  const viewableModules = permissions.filter(p => p.can_view).length;
  const creatableModules = permissions.filter(p => p.can_create).length;
  const hasAnyPerm = (p) => PERM_COLS.some(c => p[c.key]);
  const activeModules = permissions.filter(hasAnyPerm).length;

  return (
    <MainLayout>
      <PageHeader
        title={`Role: ${role.name}`}
        breadcrumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Roles', href: '/admin/roles' },
          { label: role.name },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-4 sm:space-y-5">
          {/* Role Info */}
          <div className="bg-white rounded-lg border p-4 sm:p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-bold text-slate-900">{role.name}</h2>
                <StatusBadge status={role.is_active ? 'Active' : 'Inactive'} />
              </div>
              <button onClick={() => navigate(`/admin/permissions`)} className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700">
                Edit Permissions
              </button>
            </div>
            {role.description && <p className="text-sm text-slate-600">{role.description}</p>}

            <div className="mt-4 pt-4 border-t border-slate-100 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-slate-800">Two-factor login required</p>
                <p className="text-xs text-slate-500">
                  Users in this role must set up an authenticator app or a biometric device
                  before they can use anything else in the app.
                </p>
              </div>
              <button
                type="button"
                onClick={toggleMfaRequired}
                disabled={mfaSaving}
                aria-pressed={role.mfa_required}
                aria-label="Toggle two-factor login requirement for this role"
                className={`shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${role.mfa_required ? 'bg-primary-600' : 'bg-slate-200'}`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${role.mfa_required ? 'translate-x-6' : 'translate-x-1'}`}
                />
              </button>
            </div>
          </div>

          {/* Permission Grid */}
          <div className="bg-white rounded-lg border p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Permissions ({activeModules} of {totalModules} modules)</h3>
            {/* Mobile-stacked: one card per module with active perms
                as chips. Groups stack vertically with their header. */}
            <div className="sm:hidden space-y-3">
              {Object.entries(groupedPerms).map(([group, perms]) => (
                <div key={`m-${group}`} className="space-y-2">
                  <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider px-1">{group}</div>
                  {perms.sort((a, b) => a.module_name.localeCompare(b.module_name)).map(p => {
                    const activeFlags = PERM_COLS.filter(c => p[c.key]);
                    return (
                      <div key={`m-${p.id}`} className={`bg-white border border-slate-200 rounded-lg p-3 ${activeFlags.length === 0 ? 'opacity-50' : ''}`}>
                        <div className="text-sm font-semibold text-slate-800 mb-2">{p.module_name}</div>
                        <div className="flex flex-wrap gap-1.5">
                          {activeFlags.length === 0 ? (
                            <span className="text-xs text-slate-400 italic">No actions</span>
                          ) : (
                            activeFlags.map(c => (
                              <span key={c.key} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border bg-emerald-50 text-emerald-700 border-emerald-200">
                                ✓ {c.label}
                              </span>
                            ))
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm min-w-[700px]">
                <thead>
                  <tr className="border-b bg-slate-50">
                    <th className="text-left px-3 py-2 font-semibold text-slate-600 sticky left-0 bg-slate-50 min-w-[180px]">Module</th>
                    {PERM_COLS.map(c => (
                      <th key={c.key} className="text-center px-2 py-2 font-medium text-slate-500 text-[11px] uppercase">{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(groupedPerms).map(([group, perms]) => (
                    <React.Fragment key={group}>
                      {/* Group Header */}
                      <tr>
                        <td colSpan={10} className="px-3 pt-4 pb-1">
                          <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">{group}</span>
                        </td>
                      </tr>
                      {perms.sort((a, b) => a.module_name.localeCompare(b.module_name)).map(p => {
                        const hasAny = PERM_COLS.some(c => p[c.key]);
                        return (
                          <tr key={p.id} className={`border-b border-slate-50 ${hasAny ? '' : 'opacity-40'}`}>
                            <td className="px-3 py-2 font-medium text-slate-700 sticky left-0 bg-white">{p.module_name}</td>
                            {PERM_COLS.map(c => (
                              <td key={c.key} className="text-center px-2 py-2">
                                {p[c.key] ? (
                                  <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-100 text-green-600">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-slate-100 text-slate-300">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                                  </span>
                                )}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Users with this role */}
          <div className="bg-white rounded-lg border p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-slate-800 mb-4 pb-2 border-b">Users with this Role ({users.length})</h3>
            {users.length === 0 ? (
              <p className="text-sm text-slate-400 italic">No users assigned to this role</p>
            ) : (
              <div className="space-y-2">
                {users.map(u => (
                  <div key={u.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-primary-600 rounded-full flex items-center justify-center">
                        <span className="text-white text-xs font-bold">{(u.username || '?')[0].toUpperCase()}</span>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-slate-800">{u.username}</p>
                        <p className="text-xs text-slate-500">{u.email || '-'}</p>
                      </div>
                    </div>
                    <StatusBadge status={u.is_active ? 'Active' : 'Inactive'} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4 sm:space-y-5">
          {/* Stats */}
          <div className="bg-white rounded-lg border p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-slate-800 mb-4">Permission Summary</h3>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-500">Total Modules</span>
                <span className="text-lg font-bold text-slate-800">{totalModules}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-500">Can View</span>
                <span className="text-lg font-bold text-blue-600">{viewableModules}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-500">Can Create</span>
                <span className="text-lg font-bold text-green-600">{creatableModules}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-500">Active Modules</span>
                <span className="text-lg font-bold text-emerald-600">{activeModules}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-500">Users</span>
                <span className="text-lg font-bold text-purple-600">{users.length}</span>
              </div>
            </div>

            {/* Permission bar chart */}
            <div className="mt-4 space-y-2">
              {PERM_COLS.map(c => {
                const count = permissions.filter(p => p[c.key]).length;
                const pct = totalModules > 0 ? (count / totalModules * 100) : 0;
                return (
                  <div key={c.key}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-slate-500">{c.label}</span>
                      <span className="font-medium">{count}</span>
                    </div>
                    <div className="w-full bg-slate-100 rounded-full h-2">
                      <div className={`h-2 rounded-full bg-${c.color}-500`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Actions */}
          <div className="bg-white rounded-lg border p-4 sm:p-5">
            <h3 className="text-lg font-semibold text-slate-800 mb-4">Actions</h3>
            <div className="space-y-2">
              <button onClick={() => navigate('/admin/permissions')} className="w-full px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700">Edit Permissions</button>
              <button onClick={() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/admin/roles')} className="w-full px-4 py-2 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200">← Back to Roles</button>
            </div>
          </div>
        </div>
      </div>
    </MainLayout>
  );
}

// Need React for Fragment
import React from 'react';
