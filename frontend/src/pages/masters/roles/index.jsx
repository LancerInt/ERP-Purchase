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

export default function RoleDefinitionList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canExport } = usePermissions();
  const [showFilters, setShowFilters] = useState(false);
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({ data_scope: '' });
  const [searchTerm, setSearchTerm] = useState('');

  const filters = [
    {
      key: 'data_scope',
      label: 'Data Scope',
      type: 'select',
      options: [
        { value: 'GLOBAL', label: 'Global' },
        { value: 'COMPANY', label: 'Company' },
        { value: 'WAREHOUSE', label: 'Warehouse' },
      ],
    },
  ];

  const columns = [
    { key: 'role_code', label: 'Role Code', sortable: true },
    { key: 'role_name', label: 'Role Name', sortable: true },
    { key: 'data_scope', label: 'Data Scope', sortable: true },
    {
      key: 'is_active',
      label: 'Status',
      render: (value, row) => <StatusBadge status={value === false ? 'Inactive' : (value === true ? 'Active' : value)} />,
    },
    {
      key: 'actions',
      label: '',
      sortable: false,
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/masters/roles/${row.id}`); }}
          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
          title="Edit"
        >
          <Pencil size={15} />
        </button>
      ),
    },
  ];

  const { data, isLoading, error, refetch } = useApiData('/api/roles/');

  const filteredData = data.filter((row) => {
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const m = [row.role_code, row.role_name, row.data_scope].some(v => v != null && String(v).toLowerCase().includes(s));
      if (!m) return false;
    }
    if (!matchesSelect(row.data_scope, filterValues.data_scope)) return false;
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Role Definitions"
        subtitle="Manage user roles and data access scopes"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Role Definitions' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreate('Role') ? { createLink: '/masters/roles/new', createLabel: 'Add Role' } : {}),
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
          searchPlaceholder="Search roles…"
          emptyMessage="No roles found"
          config={{
            title: (row) => row.role_code || '—',
            subtitle: (row) => row.role_name,
            badge: (row) => ({
              label: row.is_active === false ? 'Inactive' : 'Active',
              cls: row.is_active === false
                ? 'bg-slate-100 text-slate-600 border-slate-200'
                : 'bg-emerald-50 text-emerald-700 border-emerald-200',
            }),
            fields: (row) => [
              { label: 'Data Scope', value: row.data_scope },
            ],
            actions: (row) => [
              { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/masters/roles/${row.id}`) },
              canEdit('Role') && { icon: Pencil, label: 'Edit', cls: 'text-slate-700 hover:bg-slate-50', onClick: () => navigate(`/masters/roles/${row.id}`) },
            ].filter(Boolean),
          }}
          onRowClick={(row) => navigate(`/masters/roles/${row.id}`)}
        />

        <div className="hidden sm:block">
          <DataTable
            persistKey="roles"
            exportFileName="roles"
            canExport={canExport('Role Management')}
            columns={columns}
            data={filteredData}
            isLoading={isLoading}
            onSearch={setSearchTerm}
            searchPlaceholder="Search roles…"
            onRowClick={(row) => navigate(`/masters/roles/${row.id}`)}
          />
        </div>
      </ListState>
    </MainLayout>
  );
}
