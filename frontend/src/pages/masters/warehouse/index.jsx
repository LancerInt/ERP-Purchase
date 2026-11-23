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
import usePermissions from '../../../hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import { exportServerSide } from '../../../utils/exportExcel.js';
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import BulkImportModal from '../../../components/common/BulkImportModal';
import MobileListCards from '../../sales/components/MobileListCards';
import { confirm } from '@/components/common/confirm';
import ListState from '@/components/common/ListState.jsx';

export default function WarehouseList() {
  const navigate = useNavigate();
  const [showFilters, setShowFilters] = useState(false);
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({ company: '', warehouse_type: '', state: '', status: '' });
  const [showImport, setShowImport] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const { canCreate, canEdit, canDelete, canExport, canImport } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/warehouses/');

  const warehouseTypeMap = { HEAD_OFFICE: 'Head Office', FACTORY: 'Factory', JOB_WORK_PARTNER: 'Job Work Partner', WAREHOUSE: 'Warehouse' };

  // Company / State / Warehouse-Type options are derived from the loaded rows so
  // each option's value is exactly what the row holds — company is the FK id
  // (row.company), state the stored 2-letter code, warehouse_type the stored
  // code — instead of hardcoded labels that would match nothing (and so every
  // type actually present, e.g. WAREHOUSE, is offered).
  const optsFromData = (idKey, labelFor) => {
    const seen = new Map();
    for (const r of (data || [])) {
      const v = r[idKey];
      if (v == null || v === '' || seen.has(String(v))) continue;
      seen.set(String(v), typeof labelFor === 'function' ? labelFor(v, r) : (r[labelFor] || String(v)));
    }
    return [...seen].map(([value, label]) => ({ value, label }))
      .sort((a, b) => String(a.label).localeCompare(String(b.label)));
  };
  const companyOptions = optsFromData('company', 'company_name');
  const stateOptions = optsFromData('state', 'state');
  const typeOptions = optsFromData('warehouse_type', (v) => warehouseTypeMap[v] || v);

  const filters = [
    { key: 'company', label: 'Company', type: 'select', options: companyOptions },
    { key: 'warehouse_type', label: 'Warehouse Type', type: 'select', options: typeOptions },
    { key: 'state', label: 'State', type: 'select', options: stateOptions },
    {
      key: 'status', label: 'Status', type: 'select',
      options: [
        { value: 'Active', label: 'Active' },
        { value: 'Inactive', label: 'Inactive' },
      ],
    },
  ];

  const handleDelete = async (id) => {
    if (!(await confirm({ message: 'Are you sure you want to delete this record?', isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/warehouses/${id}/`);
      toast.success('Record deleted successfully');
      refetch();
    } catch (err) {
      toast.error('Failed to delete record');
    }
  };

  // Backend-driven export — keeps the JSONField address flattened to
  // the readable "Line | City | State | Pincode | Country" pipe format
  // (matches the import template). Replaces DataTable's client-side
  // stringify, which dumped raw `{"line1": "..."}` JSON into the cell.
  // `rows` is the DataTable's on-screen (filtered) set; the backend scopes
  // the export to those ids so it matches what the user is looking at.
  const handleExport = async (rows) => {
    try {
      await exportServerSide('/api/warehouses/export/', rows, 'warehouses');
    } catch (err) {
      toast.error('Export failed');
    }
  };

  const columns = [
    { key: 'warehouse_code', label: 'Warehouse Code', sortable: true },
    { key: 'name', label: 'Name', sortable: true },
    { key: 'company_name', label: 'Company', sortable: true },
    { key: 'warehouse_type', label: 'Warehouse Type', sortable: true, render: (value) => warehouseTypeMap[value] || value },
    { key: 'city', label: 'City', sortable: true },
    { key: 'state', label: 'State', sortable: true },
    {
      key: 'is_active',
      label: 'Status',
      render: (value) => <StatusBadge status={value ? 'Active' : 'Inactive'} />,
    },
    {
      key: 'actions',
      label: 'Actions',
      sortable: false,
      render: (value, row) => (
        <ActionButtons
          moduleName="Warehouse"
          editPath={`/masters/warehouse/${row.id}/edit`}
          onDelete={(r) => handleDelete(r.id)}
          row={row}
        />
      ),
    },
  ];

  const { visibleColumns, mergedColumns, showConfig, setShowConfig, handleConfigApply, visibleFieldKeys } = useConfigureFields(columns, 'warehouse_master_fields', data);

  const filteredData = data.filter((row) => {
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const m = [row.warehouse_code, row.name, row.company_name, row.warehouse_type, row.city, row.state]
        .some(v => v != null && String(v).toLowerCase().includes(s));
      if (!m) return false;
    }
    if (!matchesSelect(row.company, filterValues.company)) return false;
    if (!matchesSelect(row.warehouse_type, filterValues.warehouse_type)) return false;
    if (!matchesSelect(row.state, filterValues.state)) return false;
    if (!matchesSelect(row.is_active ? 'Active' : 'Inactive', filterValues.status)) return false;
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Warehouses"
        subtitle="Manage warehouse locations and types"
        breadcrumbs={[{ label: 'Masters', href: '/masters' }, { label: 'Warehouses' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          onConfigureFields: () => setShowConfig(true),
          ...(canImport('Warehouse') ? { onImport: () => setShowImport(true) } : {}),
          ...(canCreate('Warehouse') ? { createLink: '/masters/warehouse/new', createLabel: 'Add Warehouse' } : {}),
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
        searchPlaceholder="Search warehouses…"
        emptyMessage="No warehouses found"
        config={{
          title: (row) => row.warehouse_code || '—',
          subtitle: (row) => row.name,
          badge: (row) => ({
            label: row.is_active === false ? 'Inactive' : 'Active',
            cls: row.is_active === false
              ? 'bg-slate-100 text-slate-600 border-slate-200'
              : 'bg-emerald-50 text-emerald-700 border-emerald-200',
          }),
          fields: (row) => [
            { label: 'Company', value: row.company_name },
            { label: 'Type',    value: warehouseTypeMap[row.warehouse_type] || row.warehouse_type },
            { label: 'City',    value: row.city },
            { label: 'State',   value: row.state },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/masters/warehouse/${row.id}`) },
            canEdit('Warehouse') && { icon: Edit, label: 'Edit', cls: 'text-slate-700 hover:bg-slate-50', onClick: () => navigate(`/masters/warehouse/${row.id}/edit`) },
            canDelete('Warehouse') && { icon: Trash2, label: 'Delete', cls: 'text-red-600 hover:bg-red-50', onClick: () => handleDelete(row.id) },
          ].filter(Boolean),
        }}
        onRowClick={(row) => navigate(`/masters/warehouse/${row.id}`)}
      />

      <div className="hidden sm:block">
        <DataTable
          persistKey="warehouses"
          exportFileName="warehouses"
          canExport={canExport('Warehouse')}
          onExport={handleExport}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onSearch={setSearchTerm}
          searchPlaceholder="Search warehouses…"
          onRowClick={(row) => navigate(`/masters/warehouse/${row.id}`)}
        />
      </div>
      </ListState>
      {showConfig &&<ConfigureFields allColumns={mergedColumns} visibleFields={visibleFieldKeys} onApply={handleConfigApply} onClose={() => setShowConfig(false)} storageKey="warehouse_master_fields" />}
      <BulkImportModal
        open={showImport}
        onClose={() => setShowImport(false)}
        entityLabel="Warehouses"
        endpoint="/api/warehouses/"
        onSuccess={refetch}
      />
    </MainLayout>
  );
}
