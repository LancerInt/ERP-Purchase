import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Eye, Edit, Trash2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { matchesSelect } from '../../../components/common/FilterPanel';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ActionButtons from '../../../components/common/ActionButtons';
import useApiData from '../../../hooks/useApiData.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import BulkImportModal from '../../../components/common/BulkImportModal';
import MobileListCards from '../../sales/components/MobileListCards';
import { confirm } from '@/components/common/confirm';
import ListState from '@/components/common/ListState.jsx';

export default function GodownList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete, canExport, canImport } = usePermissions();
  const [showFilters, setShowFilters] = useState(false);
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({ warehouse: '', storage_condition: '' });
  const [showImport, setShowImport] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  // Live warehouse list, deduped by name (TVP-under-UAI + TVP-under-SSB
  // collapse to one option; picking it shows godowns from both).
  const { options: warehousesRaw } = useLookup('/api/warehouses/');
  const warehouseOptions = (() => {
    const seen = new Set();
    const out = [];
    for (const w of warehousesRaw) {
      const name = (w.label || '').trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push({ value: name, label: name });
    }
    return out;
  })();

  const filters = [
    {
      key: 'warehouse',
      label: 'Warehouse',
      type: 'select',
      single: true,
      options: warehouseOptions,
    },
    {
      key: 'storage_condition',
      label: 'Storage Condition',
      type: 'select',
      options: [
        { value: 'AMBIENT', label: 'Ambient' },
        { value: 'COLD', label: 'Cold' },
        { value: 'HAZARDOUS', label: 'Hazardous' },
      ],
    },
  ];

  const handleDelete = async (id) => {
    if (!(await confirm({ message: 'Are you sure you want to delete this record?', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/godowns/${id}/`);
      toast.success('Record deleted successfully');
      refetch();
    } catch (err) {
      toast.error('Failed to delete record');
    }
  };

  const columns = [
    { key: 'godown_code', label: 'Godown Code', sortable: true },
    { key: 'godown_name', label: 'Godown Name', sortable: true },
    // Company is derived server-side from warehouse.company so users
    // can see ownership at a glance — godowns don't carry a direct
    // company FK (they're attached to a warehouse, which belongs to a
    // company), so we render the parent company's name here.
    { key: 'warehouse_company_name', label: 'Company', sortable: true, render: (v) => v || '-' },
    { key: 'warehouse_name', label: 'Warehouse', sortable: true },
    { key: 'storage_condition', label: 'Storage Condition', sortable: true },
    { key: 'capacity_value', label: 'Capacity', sortable: true },
    { key: 'capacity_uom', label: 'Capacity UoM', sortable: true },
    {
      key: 'is_active',
      label: 'Status',
      render: (value, row) => <StatusBadge status={value === false ? 'Inactive' : (value === true ? 'Active' : value)} />,
    },
    {
      key: 'actions',
      label: 'Actions',
      sortable: false,
      render: (_, row) => (
        <ActionButtons
          moduleName="Godown"
          editPath={`/masters/godown/${row.id}`}
          onDelete={(r) => handleDelete(r.id)}
          row={row}
        />
      ),
    },
  ];

  const { data, isLoading, error, refetch } = useApiData('/api/godowns/');
  const { visibleColumns, mergedColumns, showConfig, setShowConfig, handleConfigApply, visibleFieldKeys } = useConfigureFields(columns, 'godown_master_fields', data);

  const filteredData = data.filter((row) => {
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const m = [row.godown_code, row.godown_name, row.warehouse_name, row.warehouse_company_name, row.storage_condition]
        .some(v => v != null && String(v).toLowerCase().includes(s));
      if (!m) return false;
    }
    if (filterValues.warehouse && (row.warehouse_name || '').trim().toLowerCase() !== filterValues.warehouse.trim().toLowerCase()) return false;
    if (!matchesSelect(row.storage_condition, filterValues.storage_condition)) return false;
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Godowns"
        subtitle="Manage godown and storage locations"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Godowns' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          onConfigureFields: () => setShowConfig(true),
          ...(canImport('Godown') ? { onImport: () => setShowImport(true) } : {}),
          ...(canCreate('Godown') ? { createLink: '/masters/godown/new', createLabel: 'Add Godown' } : {}),
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
        searchPlaceholder="Search godowns…"
        emptyMessage="No godowns found"
        config={{
          title: (row) => row.godown_code || '—',
          subtitle: (row) => row.godown_name,
          badge: (row) => ({
            label: row.is_active === false ? 'Inactive' : 'Active',
            cls: row.is_active === false
              ? 'bg-slate-100 text-slate-600 border-slate-200'
              : 'bg-emerald-50 text-emerald-700 border-emerald-200',
          }),
          fields: (row) => [
            { label: 'Warehouse', value: row.warehouse_name },
            { label: 'Company',   value: row.warehouse_company_name },
            { label: 'Storage',   value: row.storage_condition },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/masters/godown/${row.id}`) },
            canEdit('Godown') && { icon: Edit, label: 'Edit', cls: 'text-slate-700 hover:bg-slate-50', onClick: () => navigate(`/masters/godown/${row.id}`) },
            canDelete('Godown') && { icon: Trash2, label: 'Delete', cls: 'text-red-600 hover:bg-red-50', onClick: () => handleDelete(row.id) },
          ].filter(Boolean),
        }}
        onRowClick={(row) => navigate(`/masters/godown/${row.id}`)}
      />

      <div className="hidden sm:block">
        <DataTable
          persistKey="godowns"
          exportFileName="godowns"
          canExport={canExport('Godown')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onSearch={setSearchTerm}
          searchPlaceholder="Search godowns…"
          onRowClick={(row) => navigate(`/masters/godown/${row.id}`)}
        />
      </div>
      </ListState>
      {showConfig && <ConfigureFields allColumns={mergedColumns} visibleFields={visibleFieldKeys} onApply={handleConfigApply} onClose={() => setShowConfig(false)} storageKey="godown_master_fields" />}
      <BulkImportModal
        open={showImport}
        onClose={() => setShowImport(false)}
        entityLabel="Godowns"
        endpoint="/api/godowns/"
        onSuccess={refetch}
      />
    </MainLayout>
  );
}
