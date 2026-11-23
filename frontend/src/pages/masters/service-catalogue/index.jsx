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
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import BulkImportModal from '../../../components/common/BulkImportModal';
import MobileListCards from '../../sales/components/MobileListCards';
import ListState from '@/components/common/ListState.jsx';

export default function ServiceCatalogueList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canExport, canImport } = usePermissions();
  const [showFilters, setShowFilters] = useState(false);
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({ category: '', direction: '' });
  const [showImport, setShowImport] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const filters = [
    {
      key: 'category',
      label: 'Category',
      type: 'select',
      options: [
        { value: 'MAINTENANCE', label: 'Maintenance' },
        { value: 'REPAIR', label: 'Repair' },
      ],
    },
    {
      key: 'direction',
      label: 'Direction',
      type: 'select',
      options: [
        { value: 'INBOUND', label: 'Inbound' },
        { value: 'OUTBOUND', label: 'Outbound' },
        { value: 'BOTH', label: 'Both' },
      ],
    },
  ];

  const columns = [
    { key: 'service_code', label: 'Service Code', sortable: true },
    { key: 'name', label: 'Name', sortable: true },
    { key: 'category', label: 'Category', sortable: true },
    { key: 'direction', label: 'Direction', sortable: true },
    { key: 'default_tds', label: 'Default TDS', sortable: true },
    { key: 'default_tcs', label: 'Default TCS', sortable: true },
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
          onClick={(e) => { e.stopPropagation(); navigate(`/masters/service-catalogue/${row.id}`); }}
          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
          title="Edit"
        >
          <Pencil size={15} />
        </button>
      ),
    },
  ];

  const { data, isLoading, error, refetch } = useApiData('/api/service-catalogues/');
  const { visibleColumns, mergedColumns, showConfig, setShowConfig, handleConfigApply, visibleFieldKeys } = useConfigureFields(columns, 'service_catalogue_master_fields', data);

  const filteredData = data.filter((row) => {
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const m = [row.service_code, row.name, row.category, row.direction, row.description]
        .some(v => v != null && String(v).toLowerCase().includes(s));
      if (!m) return false;
    }
    if (!matchesSelect(row.category, filterValues.category)) return false;
    if (!matchesSelect(row.direction, filterValues.direction)) return false;
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Service Catalogue"
        subtitle="Manage service definitions and tax defaults"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Service Catalogue' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          onConfigureFields: () => setShowConfig(true),
          ...(canImport('Service Catalogue') ? { onImport: () => setShowImport(true) } : {}),
          ...(canCreate('Service Catalogue') ? { createLink: '/masters/service-catalogue/new', createLabel: 'Add Service' } : {}),
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
        searchPlaceholder="Search services…"
        emptyMessage="No services found"
        config={{
          title: (row) => row.service_code || '—',
          subtitle: (row) => row.name,
          badge: (row) => ({
            label: row.is_active === false ? 'Inactive' : 'Active',
            cls: row.is_active === false
              ? 'bg-slate-100 text-slate-600 border-slate-200'
              : 'bg-emerald-50 text-emerald-700 border-emerald-200',
          }),
          fields: (row) => [
            { label: 'Category',  value: row.category },
            { label: 'Direction', value: row.direction },
            { label: 'TDS %',     value: row.default_tds },
            { label: 'TCS %',     value: row.default_tcs },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/masters/service-catalogue/${row.id}`) },
            canEdit('Service Catalogue') && { icon: Pencil, label: 'Edit', cls: 'text-slate-700 hover:bg-slate-50', onClick: () => navigate(`/masters/service-catalogue/${row.id}`) },
          ].filter(Boolean),
        }}
        onRowClick={(row) => navigate(`/masters/service-catalogue/${row.id}`)}
      />

      <div className="hidden sm:block">
        <DataTable
          persistKey="service-catalogue"
          exportFileName="service-catalogue"
          canExport={canExport('Service Catalogue')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onSearch={setSearchTerm}
          searchPlaceholder="Search services…"
          onRowClick={(row) => navigate(`/masters/service-catalogue/${row.id}`)}
        />
      </div>
      </ListState>
      {showConfig && <ConfigureFields allColumns={mergedColumns} visibleFields={visibleFieldKeys} onApply={handleConfigApply} onClose={() => setShowConfig(false)} storageKey="service_catalogue_master_fields" />}
      <BulkImportModal
        open={showImport}
        onClose={() => setShowImport(false)}
        entityLabel="Services"
        endpoint="/api/service-catalogues/"
        onSuccess={refetch}
      />
    </MainLayout>
  );
}
