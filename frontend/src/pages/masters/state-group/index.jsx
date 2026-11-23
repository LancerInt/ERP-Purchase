import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { matchesSelect } from '../../../components/common/FilterPanel';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import DataTable from '../../../components/common/DataTable';
import ActionButtons from '../../../components/common/ActionButtons';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import { exportServerSide } from '../../../utils/exportExcel.js';
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import BulkImportModal from '../../../components/common/BulkImportModal';
import MobileListCards from '../../sales/components/MobileListCards';
import ListState from '@/components/common/ListState.jsx';
import { Pencil, Eye, Trash2 } from 'lucide-react';
import { confirm } from '@/components/common/confirm';

const REGION_LABELS = {
  SOUTH: 'South',
  NORTH: 'North',
  EAST: 'East',
  WEST: 'West',
  NORTHEAST: 'North-East',
  CENTRAL: 'Central',
  PAN_INDIA: 'Pan India',
};

export default function StateGroupList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete, canExport, canImport } = usePermissions();
  const [showFilters, setShowFilters] = useState(false);
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({ region: '' });
  const [showImport, setShowImport] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const filters = [
    {
      key: 'region',
      label: 'Region',
      type: 'select',
      options: Object.entries(REGION_LABELS).map(([value, label]) => ({ value, label })),
    },
  ];

  const handleDelete = async (id) => {
    if (!(await confirm({ message: 'Delete this state group? Price lines that reference it will lose their state binding.', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/state-groups/${id}/`);
      toast.success('State group deleted');
      refetch();
    } catch {
      toast.error('Failed to delete');
    }
  };

  // `rows` is the DataTable's on-screen (filtered) set; the backend scopes
  // the export to those ids so it matches what the user is looking at.
  const handleExport = async (rows) => {
    try {
      await exportServerSide('/api/state-groups/export/', rows, 'state-groups');
    } catch {
      toast.error('Export failed');
    }
  };

  const columns = [
    { key: 'name', label: 'Name', sortable: true },
    {
      key: 'member_states',
      label: 'Member States',
      render: (v) => Array.isArray(v) ? v.join(', ') : '',
    },
    {
      key: 'region',
      label: 'Region',
      sortable: true,
      render: (v) => REGION_LABELS[v] || v || '-',
    },
    { key: 'notes', label: 'Notes' },
    {
      key: 'actions',
      label: 'Actions',
      sortable: false,
      render: (_, row) => (
        <ActionButtons
          moduleName="State Group"
          editPath={`/masters/state-group/${row.id}`}
          onDelete={(r) => handleDelete(r.id)}
          row={row}
        />
      ),
    },
  ];

  const { data, isLoading, error, refetch } = useApiData('/api/state-groups/');
  const { visibleColumns, mergedColumns, showConfig, setShowConfig, handleConfigApply, visibleFieldKeys } = useConfigureFields(columns, 'state_group_master_fields', data);

  const filteredData = data.filter((row) => {
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const blob = [row.name, (row.member_states || []).join(','), row.notes, REGION_LABELS[row.region] || row.region].join(' ').toLowerCase();
      if (!blob.includes(s)) return false;
    }
    if (!matchesSelect(row.region, filterValues.region)) return false;
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="State Groups"
        subtitle="Reusable clusters of Indian states for state-wise pricing"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'State Groups' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          onConfigureFields: () => setShowConfig(true),
          ...(canImport('State Group') ? { onImport: () => setShowImport(true) } : {}),
          ...(canCreate('State Group') ? { createLink: '/masters/state-group/new', createLabel: 'Add State Group' } : {}),
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
          searchPlaceholder="Search state groups…"
          emptyMessage="No state groups found"
          config={{
            title: (row) => row.name || '—',
            subtitle: (row) => REGION_LABELS[row.region] || row.region || '',
            badge: (row) => ({
              label: `${(row.member_states || []).length} states`,
              cls: 'bg-blue-50 text-blue-700 border-blue-200',
            }),
            fields: (row) => [
              { label: 'Members', value: (row.member_states || []).join(', ') },
              { label: 'Notes',   value: row.notes },
            ],
            actions: (row) => [
              { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/masters/state-group/${row.id}`) },
              canEdit('State Group') && { icon: Pencil, label: 'Edit', cls: 'text-slate-700 hover:bg-slate-50', onClick: () => navigate(`/masters/state-group/${row.id}`) },
              canDelete('State Group') && { icon: Trash2, label: 'Delete', cls: 'text-red-700 hover:bg-red-50', onClick: () => handleDelete(row.id) },
            ].filter(Boolean),
          }}
          onRowClick={(row) => navigate(`/masters/state-group/${row.id}`)}
        />

        <div className="hidden sm:block">
          <DataTable
            persistKey="state-groups"
            exportFileName="state-groups"
            canExport={canExport('State Group')}
            onExport={handleExport}
            columns={visibleColumns}
            data={filteredData}
            isLoading={isLoading}
            onSearch={setSearchTerm}
            searchPlaceholder="Search state groups…"
            onRowClick={(row) => navigate(`/masters/state-group/${row.id}`)}
          />
        </div>
      </ListState>
      {showConfig && <ConfigureFields allColumns={mergedColumns} visibleFields={visibleFieldKeys} onApply={handleConfigApply} onClose={() => setShowConfig(false)} storageKey="state_group_master_fields" />}
      <BulkImportModal
        open={showImport}
        onClose={() => setShowImport(false)}
        entityLabel="State Groups"
        endpoint="/api/state-groups/"
        onSuccess={refetch}
      />
    </MainLayout>
  );
}
