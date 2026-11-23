import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, Eye } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { matchesSelect } from '../../../components/common/FilterPanel';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import BulkImportModal from '../../../components/common/BulkImportModal';
import MobileListCards from '../../sales/components/MobileListCards';
import ListState from '@/components/common/ListState.jsx';

export default function TransporterList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canExport, canImport } = usePermissions();
  const [showFilters, setShowFilters] = useState(false);
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({ status: '' });
  const [showImport, setShowImport] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const filters = [
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'Active', label: 'Active' },
        { value: 'Inactive', label: 'Inactive' },
      ],
    },
  ];

  const columns = [
    { key: 'transporter_code', label: 'Transporter Code', sortable: true },
    { key: 'name', label: 'Name', sortable: true },
    { key: 'gstin', label: 'GSTIN', sortable: true },
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
          onClick={(e) => { e.stopPropagation(); navigate(`/masters/transporter/${row.id}`); }}
          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
          title="Edit"
        >
          <Pencil size={15} />
        </button>
      ),
    },
  ];

  const { data, isLoading, error, refetch } = useApiData('/api/transporters/');
  const { visibleColumns, mergedColumns, showConfig, setShowConfig, handleConfigApply, visibleFieldKeys } = useConfigureFields(columns, 'transporter_master_fields', data);

  const filteredData = data.filter((row) => {
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const m = [row.transporter_code, row.name, row.gstin, row.contact_person, row.contact_phone]
        .some(v => v != null && String(v).toLowerCase().includes(s));
      if (!m) return false;
    }
    if (!matchesSelect(row.is_active ? 'Active' : 'Inactive', filterValues.status)) return false;
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Transporters"
        subtitle="Manage transporter and logistics partners"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Transporters' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          onConfigureFields: () => setShowConfig(true),
          ...(canImport('Transporter') ? { onImport: () => setShowImport(true) } : {}),
          ...(canCreate('Transporter') ? { createLink: '/masters/transporter/new', createLabel: 'Add Transporter' } : {}),
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
        searchPlaceholder="Search transporters…"
        emptyMessage="No transporters found"
        config={{
          title: (row) => row.transporter_code || '—',
          subtitle: (row) => row.name,
          badge: (row) => ({
            label: row.is_active === false ? 'Inactive' : 'Active',
            cls: row.is_active === false
              ? 'bg-slate-100 text-slate-600 border-slate-200'
              : 'bg-emerald-50 text-emerald-700 border-emerald-200',
          }),
          fields: (row) => [
            { label: 'GSTIN',   value: row.gstin },
            { label: 'Contact', value: row.contact_person },
            { label: 'Phone',   value: row.contact_phone },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/masters/transporter/${row.id}`) },
            canEdit('Transporter') && { icon: Pencil, label: 'Edit', cls: 'text-slate-700 hover:bg-slate-50', onClick: () => navigate(`/masters/transporter/${row.id}`) },
          ].filter(Boolean),
        }}
        onRowClick={(row) => navigate(`/masters/transporter/${row.id}`)}
      />

      <div className="hidden sm:block">
        <DataTable
          persistKey="transporters"
          exportFileName="transporters"
          canExport={canExport('Transporter')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onSearch={setSearchTerm}
          searchPlaceholder="Search transporters…"
          onRowClick={(row) => navigate(`/masters/transporter/${row.id}`)}
        />
      </div>
      </ListState>
      {showConfig && <ConfigureFields allColumns={mergedColumns} visibleFields={visibleFieldKeys} onApply={handleConfigApply} onClose={() => setShowConfig(false)} storageKey="transporter_master_fields" />}
      <BulkImportModal
        open={showImport}
        onClose={() => setShowImport(false)}
        entityLabel="Transporters"
        endpoint="/api/transporters/"
        onSuccess={refetch}
      />
    </MainLayout>
  );
}
