import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, Trash2, Check, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';

import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { applyAdvancedFilters, matchesSelect } from '../../../components/common/FilterPanel';
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ListState from '@/components/common/ListState.jsx';
import apiClient from '../../../utils/api.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { useUrlFilters, useUrlAdvancedRules } from '../../../hooks/useUrlState.js';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';

const fmtQty = (v) =>
  Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const fmtDate = (v) =>
  v ? formatDate(v) : '-';

// Strip companion suffixes so a list column maps back to its base catalog key.
const keyFor = (c) => (c.field || c.key || '').replace(/_(name|code|display)$/, '');

export default function PackingProcessList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete, canApprove, canExport } = usePermissions();
  // Field-level permissions — drop HIDDEN columns entirely for this role.
  const { isHidden } = useFieldPermissions('Packing Process');
  const { data, isLoading, error, refetch } = useApiData('/api/production/packing-processes/');
  const [showFilters, setShowFilters] = useState(false);
  // Domain filters live in the URL so Back / refresh / sharing restore them.
  // (Advanced rules stay local — they're a complex rule set, not a simple map.)
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    company_name: '', warehouse_code: '', process_name: '', approval_status: '',
  });
  const { rules: advancedRules, logic: advancedLogic, setAdvanced } = useUrlAdvancedRules();

  // The DataTable ships an always-visible search box, so the filter-panel
  // "Search" text field was a duplicate. Replace it with structured Company /
  // Warehouse / Process selects (options derived from the loaded rows).
  const optsFrom = (key) => [...new Set((data || []).map((r) => r[key]).filter(Boolean))]
    .sort().map((v) => ({ value: v, label: v }));
  const filters = [
    { key: 'company_name',   label: 'Company',   type: 'select', options: optsFrom('company_name') },
    { key: 'warehouse_code', label: 'Warehouse', type: 'select', options: optsFrom('warehouse_code') },
    { key: 'process_name',   label: 'Process',   type: 'select', options: optsFrom('process_name') },
    {
      key: 'approval_status',
      label: 'Approval',
      type: 'select',
      options: [
        { value: 'PENDING', label: 'Pending' },
        { value: 'APPROVED', label: 'Approved' },
        { value: 'REJECTED', label: 'Rejected' },
      ],
    },
  ];

  const filterColumns = [
    { field: 'packing_no', header: 'Packing No', type: 'text' },
    { field: 'date', header: 'Date', type: 'date' },
    { field: 'batch_no', header: 'Batch No', type: 'text' },
    { field: 'company_name', header: 'Company', type: 'text' },
    { field: 'warehouse_code', header: 'Warehouse', type: 'text' },
    { field: 'process_name', header: 'Process', type: 'text' },
    { field: 'total_packing_material_qty', header: 'Total Pkg Qty', type: 'number' },
    { field: 'approval_status', header: 'Approval', type: 'select', filterOptions: [
      { value: 'PENDING', label: 'Pending' },
      { value: 'APPROVED', label: 'Approved' },
      { value: 'REJECTED', label: 'Rejected' },
    ]},
  ];

  const handleDelete = async (row) => {
    if (!(await confirm({ message: `Delete packing process "${row.packing_no}"? This cannot be undone.`, isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/production/packing-processes/${row.id}/`);
      toast.success('Packing Process deleted.');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete.');
    }
  };

  const handleApprove = async (row) => {
    if (!(await confirm({ message: `Approve "${row.packing_no}"?` }))) return;
    try {
      await apiClient.post(`/api/production/packing-processes/${row.id}/approve/`);
      toast.success('Packing Process approved.');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to approve.');
    }
  };

  const columns = [
    { key: 'packing_no', label: 'Packing No', sortable: true,
      render: (v, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/production/packing-processes/${row.id}`); }}
          className="text-blue-700 hover:underline font-medium font-mono text-xs"
        >{v}</button>
      ),
    },
    { key: 'date', label: 'Date', sortable: true, render: (v) => fmtDate(v) },
    { key: 'batch_no', label: 'Batch No', sortable: true, render: (v) => v || '-' },
    { key: 'company_name', label: 'Company', sortable: true, render: (v) => v || '-' },
    { key: 'warehouse_code', label: 'Warehouse', sortable: true, render: (v) => v || '-' },
    { key: 'process_name', label: 'Process', sortable: true, render: (v) => v || '-' },
    { key: 'total_packing_material_qty', label: 'Total Pkg Qty', sortable: true,
      render: (v) => fmtQty(v) },
    { key: 'approval_status', label: 'Approval', sortable: true,
      render: (v) => <StatusBadge status={v || 'PENDING'} /> },
    { key: 'actions', label: '', sortable: false,
      render: (_, row) => (
        <div className="flex items-center gap-1">
          {canApprove('Packing Process') && row.approval_status !== 'APPROVED' && (
            <button
              onClick={(e) => { e.stopPropagation(); handleApprove(row); }}
              className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded transition"
              title="Approve"
            ><Check size={15} /></button>
          )}
          {canEdit('Packing Process') && (
            <button
              onClick={(e) => { e.stopPropagation(); navigate(`/production/packing-processes/${row.id}/edit`); }}
              className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
              title="Edit"
            ><Pencil size={15} /></button>
          )}
          {canDelete('Packing Process') && (
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

  // Never drop the primary identifier / link column or the actions column,
  // regardless of field permissions.
  const ALWAYS_SHOW = new Set(['packing_no', 'actions']);
  const permittedColumns = columns.filter(
    (c) => ALWAYS_SHOW.has(c.field || c.key) || !isHidden(keyFor(c)),
  );

  const {
    visibleColumns, mergedColumns,
    showConfig, setShowConfig, handleConfigApply, visibleFieldKeys,
  } = useConfigureFields(permittedColumns, 'production_packing_processes_fields', data);

  const filteredData = (() => {
    let result = (data || []).filter((row) => {
      if (!matchesSelect(row.company_name, filterValues.company_name)) return false;
      if (!matchesSelect(row.warehouse_code, filterValues.warehouse_code)) return false;
      if (!matchesSelect(row.process_name, filterValues.process_name)) return false;
      if (!matchesSelect(row.approval_status, filterValues.approval_status)) return false;
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
        title="Packing Process"
        subtitle="Bulk → packed finished good runs"
        breadcrumbs={[{ label: 'Production', href: '/production' }, { label: 'Packing Process' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          onConfigureFields: () => setShowConfig(true),
          ...(canCreate('Packing Process') ? {
            createLink: '/production/packing-processes/new',
            createLabel: 'New Packing Process',
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
        <DataTable persistKey="production-packing-processes"
          exportFileName="packing-processes"
          canExport={canExport('Packing Process')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/production/packing-processes/${row.id}`)}
        />
      </ListState>
      {showConfig && (
        <ConfigureFields
          allColumns={mergedColumns}
          visibleFields={visibleFieldKeys}
          onApply={handleConfigApply}
          onClose={() => setShowConfig(false)}
          storageKey="production_packing_processes_fields"
        />
      )}
    </MainLayout>
  );
}
