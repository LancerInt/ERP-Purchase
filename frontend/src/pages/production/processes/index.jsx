import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, Trash2, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';

import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { applyAdvancedFilters, matchesSelect } from '../../../components/common/FilterPanel';
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { useUrlFilters, useUrlAdvancedRules } from '../../../hooks/useUrlState.js';
import { confirm } from '@/components/common/confirm';
import ListState from '@/components/common/ListState.jsx';
import BulkImportModal from '../../../components/common/BulkImportModal';

export default function ProcessList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete, canExport, canImport } = usePermissions();
  const [showImport, setShowImport] = useState(false);
  // Field-level permissions — drop HIDDEN columns entirely for this role.
  const { isHidden } = useFieldPermissions('Process');
  // Pull every status — list page should show inactive rows too.
  const { data, isLoading, error, refetch } = useApiData('/api/production/processes/?status=');
  const [showFilters, setShowFilters] = useState(false);
  // Domain filters live in the URL so Back / refresh / sharing restore them.
  // (Advanced rules stay local — they're a complex rule set, not a simple map.)
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    company_name: '', warehouse_code: '', status: '',
  });
  const { rules: advancedRules, logic: advancedLogic, setAdvanced } = useUrlAdvancedRules();

  // The DataTable ships an always-visible search box, so the filter-panel
  // "Search" text field was a duplicate. Replace it with structured Company /
  // Warehouse selects (options derived from the loaded rows) plus Status.
  const optsFrom = (key) => [...new Set((data || []).map((r) => r[key]).filter(Boolean))]
    .sort().map((v) => ({ value: v, label: v }));
  const filters = [
    { key: 'company_name',   label: 'Company',   type: 'select', options: optsFrom('company_name') },
    { key: 'warehouse_code', label: 'Warehouse', type: 'select', options: optsFrom('warehouse_code') },
    {
      key: 'status', label: 'Status', type: 'select',
      options: [
        { value: 'Active', label: 'Active' },
        { value: 'Inactive', label: 'Inactive' },
      ],
    },
  ];

  const filterColumns = [
    { field: 'process_code', header: 'Code', type: 'text' },
    { field: 'process_name', header: 'Process Name', type: 'text' },
    { field: 'company_name', header: 'Company', type: 'text' },
    { field: 'warehouse_code', header: 'Warehouse', type: 'text' },
    { field: 'description', header: 'Description', type: 'text' },
    { field: 'status', header: 'Status', type: 'select', filterOptions: [
      { value: 'Active', label: 'Active' },
      { value: 'Inactive', label: 'Inactive' },
    ]},
  ];

  const handleDelete = async (row) => {
    if (!(await confirm({ message: `Delete process "${row.process_name}"? This cannot be undone.`, isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/production/processes/${row.id}/`);
      toast.success('Process deleted.');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete.');
    }
  };

  const columns = [
    { key: 'process_code', label: 'Code', sortable: true,
      render: (v, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/production/processes/${row.id}`); }}
          className="text-blue-700 hover:underline font-medium font-mono text-xs"
        >{v}</button>
      ),
    },
    { key: 'process_name', label: 'Process Name', sortable: true,
      render: (v) => <span className="font-medium text-slate-800">{v || '-'}</span> },
    { key: 'company_name', label: 'Company', sortable: true,
      render: (v) => v || '-' },
    { key: 'warehouse_code', label: 'Warehouse', sortable: true,
      render: (v) => v || '-' },
    { key: 'description', label: 'Description', sortable: false,
      render: (v) => v ? <span className="text-xs text-slate-600">{v}</span> : '-' },
    { key: 'status', label: 'Status', sortable: true,
      render: (v) => <StatusBadge status={v} /> },
    { key: 'actions', label: '', sortable: false,
      render: (_, row) => (
        <div className="flex items-center gap-1">
          {canEdit('Process') && (
            <button
              onClick={(e) => { e.stopPropagation(); navigate(`/production/processes/${row.id}`); }}
              className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
              title="Edit"
            ><Pencil size={15} /></button>
          )}
          {canDelete('Process') && (
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(row); }}
              className="p-1.5 text-red-500 hover:bg-red-50 rounded transition"
              title="Delete"
            ><Trash2 size={15} /></button>
          )}
        </div>
      ),
    },
  ];

  // Drop HIDDEN columns entirely. A column is hidden when either its raw key
  // (e.g. 'process_name', which is itself a catalog key) or its base key with
  // companion suffixes stripped (e.g. 'company_name' -> 'company') is HIDDEN.
  // Never drop the primary identifier / link column or the actions column.
  const ALWAYS_SHOW = new Set(['process_code', 'actions']);
  const columnHidden = (c) => {
    const raw = c.field || c.key || '';
    const base = raw.replace(/_(name|code|display)$/, '');
    return isHidden(raw) || isHidden(base);
  };
  const permittedColumns = columns.filter(
    (c) => ALWAYS_SHOW.has(c.field || c.key) || !columnHidden(c),
  );

  const {
    visibleColumns, mergedColumns,
    showConfig, setShowConfig, handleConfigApply, visibleFieldKeys,
  } = useConfigureFields(permittedColumns, 'production_processes_fields', data);

  const filteredData = (() => {
    let result = (data || []).filter((row) => {
      if (!matchesSelect(row.company_name, filterValues.company_name)) return false;
      if (!matchesSelect(row.warehouse_code, filterValues.warehouse_code)) return false;
      if (!matchesSelect(row.status, filterValues.status)) return false;
      return true;
    });
    if (advancedRules.length > 0) {
      result = applyAdvancedFilters(result, advancedRules, advancedLogic);
    }
    return result;
  })();

  return (
    <MainLayout>
      <PageHeader
        title="Process Master"
        subtitle="Production process names — scoped to a Company + Warehouse"
        breadcrumbs={[{ label: 'Production', href: '/production' }, { label: 'Processes' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          onConfigureFields: () => setShowConfig(true),
          ...(canImport('Process') ? { onImport: () => setShowImport(true) } : {}),
          ...(canCreate('Process') ? {
            createLink: '/production/processes/new',
            createLabel: 'New Process',
          } : {}),
        }}
      />
      {showFilters && (
        <FilterPanel
          filters={filters}
          values={filterValues}
          onChange={(key, value) => setFilterValue(key, value)}
          onReset={() => { clearFilters(); setAdvanced([], 'AND'); }}
          onClose={() => setShowFilters(false)}
          columns={filterColumns}
          data={data || []}
          onAdvancedFilter={(rules, logic) => setAdvanced(rules, logic)}
          initialRules={advancedRules}
          initialLogic={advancedLogic}
        />
      )}
      <ListState error={error} onRetry={refetch}>
        <DataTable persistKey="production-processes"
          exportFileName="processes"
          canExport={canExport('Process')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/production/processes/${row.id}`)}
        />
      </ListState>
      {showConfig && (
        <ConfigureFields
          allColumns={mergedColumns}
          visibleFields={visibleFieldKeys}
          onApply={handleConfigApply}
          onClose={() => setShowConfig(false)}
          storageKey="production_processes_fields"
        />
      )}
      <BulkImportModal
        open={showImport}
        onClose={() => setShowImport(false)}
        entityLabel="Processes"
        endpoint="/api/production/processes/"
        onSuccess={refetch}
      />
    </MainLayout>
  );
}
