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

export default function TemplateLibraryList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canExport, canImport } = usePermissions();
  const [showFilters, setShowFilters] = useState(false);
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({ template_type: '', status: '' });
  const [showImport, setShowImport] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const filters = [
    {
      key: 'template_type',
      label: 'Template Type',
      type: 'select',
      options: [
        { value: 'PRODUCTION', label: 'Production' },
        { value: 'QC_REPORT', label: 'QC Report' },
        { value: 'JOB_WORK', label: 'Job Work' },
        { value: 'PACKING', label: 'Packing' },
        { value: 'INVOICE', label: 'Invoice' },
      ],
    },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'DRAFT', label: 'Draft' },
        { value: 'ACTIVE', label: 'Active' },
        { value: 'RETIRED', label: 'Retired' },
      ],
    },
  ];

  const columns = [
    { key: 'template_id', label: 'Template ID', sortable: true },
    { key: 'name', label: 'Name', sortable: true },
    { key: 'template_type', label: 'Template Type', sortable: true },
    { key: 'revision_no', label: 'Revision No', sortable: true },
    { key: 'effective_from', label: 'Effective From', sortable: true },
    {
      key: 'status',
      label: 'Status',
      render: (value, row) => <StatusBadge status={row.is_active === undefined ? value : (row.is_active ? 'Active' : 'Inactive')} />,
    },
    {
      key: 'actions',
      label: '',
      sortable: false,
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/masters/templates/${row.id}`); }}
          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
          title="Edit"
        >
          <Pencil size={15} />
        </button>
      ),
    },
  ];

  const { data, isLoading, error, refetch } = useApiData('/api/templates/');
  const { visibleColumns, mergedColumns, showConfig, setShowConfig, handleConfigApply, visibleFieldKeys } = useConfigureFields(columns, 'template_master_fields', data);

  const filteredData = data.filter((row) => {
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const m = [row.template_id, row.name, row.template_type, row.revision_no, row.status]
        .some(v => v != null && String(v).toLowerCase().includes(s));
      if (!m) return false;
    }
    if (!matchesSelect(row.template_type, filterValues.template_type)) return false;
    if (!matchesSelect(row.status, filterValues.status)) return false;
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Template Library"
        subtitle="Manage document and report templates"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Template Library' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          onConfigureFields: () => setShowConfig(true),
          ...(canImport('Template') ? { onImport: () => setShowImport(true) } : {}),
          ...(canCreate('Template') ? { createLink: '/masters/templates/new', createLabel: 'Add Template' } : {}),
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
        searchPlaceholder="Search templates…"
        emptyMessage="No templates found"
        config={{
          title: (row) => row.template_id || '—',
          subtitle: (row) => row.name,
          badge: (row) => {
            const status = row.is_active === undefined ? row.status : (row.is_active ? 'Active' : 'Inactive');
            const cls = status === 'Active'
              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : status === 'Draft'
                ? 'bg-amber-50 text-amber-700 border-amber-200'
                : 'bg-slate-100 text-slate-600 border-slate-200';
            return { label: status || '—', cls };
          },
          fields: (row) => [
            { label: 'Type',     value: row.template_type },
            { label: 'Revision', value: row.revision_no },
            { label: 'From',     value: row.effective_from },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/masters/templates/${row.id}`) },
            canEdit('Template') && { icon: Pencil, label: 'Edit', cls: 'text-slate-700 hover:bg-slate-50', onClick: () => navigate(`/masters/templates/${row.id}`) },
          ].filter(Boolean),
        }}
        onRowClick={(row) => navigate(`/masters/templates/${row.id}`)}
      />

      <div className="hidden sm:block">
        <DataTable
          persistKey="templates"
          exportFileName="templates"
          canExport={canExport('Template')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onSearch={setSearchTerm}
          searchPlaceholder="Search templates…"
          onRowClick={(row) => navigate(`/masters/templates/${row.id}`)}
        />
      </div>
      </ListState>
      {showConfig && <ConfigureFields allColumns={mergedColumns} visibleFields={visibleFieldKeys} onApply={handleConfigApply} onClose={() => setShowConfig(false)} storageKey="template_master_fields" />}
      <BulkImportModal
        open={showImport}
        onClose={() => setShowImport(false)}
        entityLabel="Templates"
        endpoint="/api/templates/"
        onSuccess={refetch}
      />
    </MainLayout>
  );
}
