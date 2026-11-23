import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { matchesSelect } from '../../../components/common/FilterPanel';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import { Pencil, Eye } from 'lucide-react';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import MobileListCards from '../../sales/components/MobileListCards';
import ListState from '@/components/common/ListState.jsx';

export default function StakeholderUserList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canExport } = usePermissions();
  const [showFilters, setShowFilters] = useState(false);
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({ status: '' });
  const [searchTerm, setSearchTerm] = useState('');

  const filters = [
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'ACTIVE', label: 'Active' },
        { value: 'SUSPENDED', label: 'Suspended' },
        { value: 'INACTIVE', label: 'Inactive' },
      ],
    },
  ];

  const columns = [
    { key: 'portal_user_id', label: 'Portal User ID', sortable: true },
    { key: 'primary_email', label: 'Primary Email', sortable: true },
    { key: 'mobile', label: 'Mobile', sortable: true },
    {
      key: 'status',
      label: 'Status',
      render: (value, row) => <StatusBadge status={row.is_active === undefined ? value : (row.is_active ? 'Active' : 'Inactive')} />,
    },
    { key: 'default_warehouse', label: 'Default Warehouse', sortable: true },
    { key: 'last_accessed', label: 'Last Accessed', sortable: true },
    {
      key: 'actions',
      label: '',
      sortable: false,
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/masters/users/${row.id}`); }}
          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
          title="Edit"
        >
          <Pencil size={15} />
        </button>
      ),
    },
  ];

  const { data, isLoading, error, refetch } = useApiData('/api/users/');

  const filteredData = data.filter((row) => {
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const m = [row.portal_user_id, row.primary_email, row.mobile, row.default_warehouse]
        .some(v => v != null && String(v).toLowerCase().includes(s));
      if (!m) return false;
    }
    if (!matchesSelect(row.status, filterValues.status)) return false;
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Stakeholder Users"
        subtitle="Manage portal users and access"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Stakeholder Users' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreate('User') ? { createLink: '/masters/users/new', createLabel: 'Add User' } : {}),
        }}
      />
      {showFilters && (
        <FilterPanel
          filters={filters}
          values={filterValues}
          onChange={(key, value) => setFilterValue(key, value)}
          onReset={clearFilters}
          onClose={() => setShowFilters(false)}
        />
      )}
      <ListState error={error} onRetry={refetch}>
      <MobileListCards
        rows={filteredData}
        isLoading={isLoading}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search users…"
        emptyMessage="No users found"
        config={{
          title: (row) => row.portal_user_id || '—',
          subtitle: (row) => row.primary_email,
          badge: (row) => {
            const status = row.is_active === undefined ? row.status : (row.is_active ? 'Active' : 'Inactive');
            const cls = status === 'Active'
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : 'bg-slate-100 text-slate-600 border-slate-200';
            return { label: status || '—', cls };
          },
          fields: (row) => [
            { label: 'Mobile',    value: row.mobile },
            { label: 'Warehouse', value: row.default_warehouse },
            { label: 'Last Seen', value: row.last_accessed },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/masters/users/${row.id}`) },
            canEdit('User') && { icon: Pencil, label: 'Edit', cls: 'text-slate-700 hover:bg-slate-50', onClick: () => navigate(`/masters/users/${row.id}`) },
          ].filter(Boolean),
        }}
        onRowClick={(row) => navigate(`/masters/users/${row.id}`)}
      />

      <div className="hidden sm:block">
        <DataTable
          persistKey="users"
          exportFileName="users"
          canExport={canExport('User Management')}
          columns={columns}
          data={filteredData}
          isLoading={isLoading}
          onSearch={setSearchTerm}
          searchPlaceholder="Search users…"
          onRowClick={(row) => navigate(`/masters/users/${row.id}`)}
        />
      </div>
      </ListState>
    </MainLayout>
  );
}
