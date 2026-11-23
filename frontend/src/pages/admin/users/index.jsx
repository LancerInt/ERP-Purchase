import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Eye, Edit, Trash2, RefreshCw } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { matchesSelect } from '../../../components/common/FilterPanel';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ActionButtons from '../../../components/common/ActionButtons';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useLookup from '../../../hooks/useLookup.js';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import apiClient from '../../../utils/api.js';
import exportToExcel from '../../../utils/exportExcel.js';
import MobileListCards from '../components/MobileListCards';
import ListState from '@/components/common/ListState.jsx';
import { confirm } from '@/components/common/confirm';
import { formatDate, formatDateTime } from '@/utils/formatters';

export default function AdminUserList() {
  const navigate = useNavigate();
  const [showFilters, setShowFilters] = useState(false);
  // Filters live in the URL so Back / refresh / sharing restore the filtered view.
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    is_active: '', role: '', last_login_state: '', search: '',
  });
  const { canCreate, canEdit, canDelete } = usePermissions();
  const { options: roleOptions } = useLookup('/api/rbac/roles/');

  const filters = [
    {
      key: 'is_active',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'true', label: 'Active' },
        { value: 'false', label: 'Inactive' },
      ],
    },
    {
      key: 'role',
      label: 'Role',
      type: 'select',
      // Kept single-select: the row-filter uses a '__none__' sentinel and a
      // scalar name comparison, not a plain equality, so a multi array here
      // would break that logic.
      single: true,
      options: [
        { value: '__none__', label: 'No role' },
        ...roleOptions.map((o) => ({ value: o.label, label: o.label })),
      ],
    },
    {
      key: 'last_login_state',
      label: 'Last Login',
      type: 'select',
      // Kept single-select: the filter value is read as a scalar ('never' /
      // 'logged') against row.last_login presence, not a field equality.
      single: true,
      options: [
        { value: 'never', label: 'Never logged in' },
        { value: 'logged', label: 'Has logged in' },
      ],
    },
  ];

  const handleDelete = async (id) => {
    if (!(await confirm({ message: 'Are you sure you want to delete this user?', isDangerous: true }))) return;
    try {
      const res = await apiClient.delete(`/api/rbac/users/${id}/`);
      // Backend deactivates (instead of hard-deleting) users who have
      // transaction history — surface that so the admin isn't confused
      // when the row stays in the list as Inactive.
      if (res?.data?.deactivated) {
        toast.success(res.data.detail || 'User has records — deactivated instead (login revoked, records kept).');
      } else {
        toast.success('User deleted successfully');
      }
      refetch();
    } catch (err) {
      // Surface the backend guard message (e.g. "cannot delete the last
      // active superuser" / "cannot delete your own account"). The custom
      // exception handler reshapes {detail} -> {error}.
      const d = err.response?.data;
      toast.error(d?.error || d?.detail || 'Failed to delete user');
    }
  };

  // Helper to extract role name from different API response formats
  const getRoleName = (row) => {
    if (row.role_name) return row.role_name;
    if (typeof row.role === 'object' && row.role?.name) return row.role.name;
    if (typeof row.role === 'string') return row.role;
    return '';
  };

  const columns = [
    { key: 'username', label: 'Username', sortable: true },
    { key: 'email', label: 'Email', sortable: true },
    { key: 'staff_name', label: 'Staff Name', sortable: true },
    {
      key: 'role',
      label: 'Role',
      sortable: true,
      render: (value, row) => {
        const rn = getRoleName(row);
        return rn ? (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">{rn}</span>
        ) : (
          // Amber so unprovisioned (zero-permission) accounts stand out.
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">No role</span>
        );
      },
    },
    {
      key: 'is_superuser',
      label: 'Superuser',
      sortable: true,
      render: (value) => value
        ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-violet-50 text-violet-700 border border-violet-200">Yes</span>
        : <span className="text-slate-300">—</span>,
    },
    {
      // MFA_EXEMPT_USERNAMES is an environment variable, so without this
      // column there is nowhere in the app that shows an account skips 2FA
      // — the Roles page would claim "Required" and be quietly wrong for
      // this user. Only rendered when someone IS exempt, so the column
      // stays blank (and unalarming) on a normally configured system.
      key: 'mfa_exempt',
      label: '2FA',
      sortable: true,
      render: (value) => value
        ? (
          <span
            title="Listed in MFA_EXEMPT_USERNAMES — signs in with a password only, skipping
                   two-factor even where the role requires it. Intended for machine accounts
                   such as the Tally connector."
            className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-800 border border-amber-200"
          >
            Exempt
          </span>
        )
        : <span className="text-slate-300">—</span>,
    },
    {
      key: 'is_active',
      label: 'Status',
      render: (value) => <StatusBadge status={value ? 'Active' : 'Inactive'} />,
    },
    {
      key: 'date_joined',
      label: 'Joined',
      sortable: true,
      render: (value) => value ? formatDate(value) : '—',
    },
    {
      key: 'last_login',
      label: 'Last Login',
      sortable: true,
      render: (value) => value ? formatDateTime(value) : 'Never',
    },
    {
      key: 'actions',
      label: 'Actions',
      sortable: false,
      render: (value, row) => (
        <ActionButtons
          moduleName="User Management"
          editPath={`/admin/users/${row.id}/edit`}
          onDelete={(r) => handleDelete(r.id)}
          row={row}
        />
      ),
    },
  ];

  const { data, isLoading, error, refetch } = useApiData('/api/rbac/users/');

  const filteredData = data.filter((row) => {
    if (filterValues.search) {
      const search = filterValues.search.toLowerCase();
      const roleName = getRoleName(row);
      const matchesSearch = [row.username, row.email, row.staff_name, roleName]
        .some((v) => String(v || '').toLowerCase().includes(search));
      if (!matchesSearch) return false;
    }
    if (!matchesSelect(row.is_active, filterValues.is_active)) return false;
    if (filterValues.role) {
      const rn = getRoleName(row);
      // '__none__' → only users with no role; otherwise match the role name.
      if (filterValues.role === '__none__' ? !!rn : rn !== filterValues.role) return false;
    }
    if (filterValues.last_login_state === 'never' && row.last_login) return false;
    if (filterValues.last_login_state === 'logged' && !row.last_login) return false;
    return true;
  });

  // Export a flat projection: the raw rows carry role as an object
  // ({id,name}) and is_active/last_login as raw values, which exportToExcel
  // would dump as JSON / true-false / ISO. Flatten to readable cells first.
  const handleExport = () => {
    const rows = filteredData.map((u) => ({
      username: u.username,
      email: u.email || '',
      staff_name: u.staff_name || '',
      role: getRoleName(u) || '',
      superuser: u.is_superuser ? 'Yes' : 'No',
      status: u.is_active ? 'Active' : 'Inactive',
      date_joined: u.date_joined ? formatDate(u.date_joined) : '',
      last_login: u.last_login ? formatDateTime(u.last_login) : 'Never',
    }));
    exportToExcel(rows, [
      { key: 'username', label: 'Username' },
      { key: 'email', label: 'Email' },
      { key: 'staff_name', label: 'Staff Name' },
      { key: 'role', label: 'Role' },
      { key: 'superuser', label: 'Superuser' },
      { key: 'status', label: 'Status' },
      { key: 'date_joined', label: 'Joined' },
      { key: 'last_login', label: 'Last Login' },
    ], 'admin-users');
  };

  return (
    <MainLayout>
      <PageHeader
        title="User Management"
        subtitle="Manage ERP user accounts and role assignments"
        breadcrumbs={[{ label: 'Admin' }, { label: 'Users' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreate('User Management') ? { createLink: '/admin/users/new', createLabel: 'Create User' } : {}),
        }}
      />
      {showFilters && (
        <FilterPanel
          filters={filters}
          values={filterValues}
          onChange={setFilterValue}
          onReset={clearFilters}
          onClose={() => setShowFilters(false)}
        />
      )}
      <ListState error={error} onRetry={refetch}>
      <MobileListCards
        rows={filteredData}
        isLoading={isLoading}
        searchTerm={filterValues.search || ''}
        onSearchChange={(v) => setFilterValue('search', v)}
        searchPlaceholder="Search users…"
        config={{
          title: (row) => row.username || '—',
          subtitle: (row) => row.staff_name || row.email,
          badge: (row) => ({
            label: row.is_active ? 'Active' : 'Inactive',
            cls: row.is_active ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-600 border-slate-200',
          }),
          fields: (row) => [
            { label: 'Email', value: row.email },
            { label: 'Role',  value: getRoleName(row) || 'No role' },
            ...(row.is_superuser ? [{ label: 'Superuser', value: 'Yes' }] : []),
            { label: 'Joined', value: row.date_joined ? formatDate(row.date_joined) : '—' },
            { label: 'Last',  value: row.last_login ? formatDateTime(row.last_login) : 'Never' },
          ],
          actions: (row) => [
            { icon: Eye,   label: 'View', cls: 'text-blue-700 hover:bg-blue-50',  onClick: () => navigate(`/admin/users/${row.id}`) },
            canEdit('User Management') && { icon: Edit,  label: 'Edit', cls: 'text-slate-700 hover:bg-slate-50', onClick: () => navigate(`/admin/users/${row.id}/edit`) },
            canDelete('User Management') && { icon: Trash2, label: 'Delete', cls: 'text-red-600 hover:bg-red-50', onClick: () => handleDelete(row.id) },
          ].filter(Boolean),
        }}
        onRowClick={(row) => navigate(`/admin/users/${row.id}`)}
        emptyMessage="No users found"
      />
      <div className="hidden sm:block">
        <DataTable persistKey="admin-users"
          exportFileName="admin-users"
          onExport={handleExport}
          columns={columns}
          data={filteredData}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/admin/users/${row.id}`)}
        />
      </div>
      </ListState>
    </MainLayout>
  );
}
