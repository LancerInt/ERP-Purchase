import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { applyAdvancedFilters, matchesSelect } from '../../../components/common/FilterPanel';
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import DataTable from '../../../components/common/DataTable';
import ListState from '@/components/common/ListState.jsx';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { useUrlFilters, useUrlAdvancedRules } from '../../../hooks/useUrlState.js';
import { formatDate } from '@/utils/formatters';

const fmtDate = (v) =>
  v ? formatDate(v) : '-';
const fmtQty = (v) =>
  Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

const PRODUCT_CATEGORY_LABEL = {
  RAW_MATERIAL: 'Raw Material',
  PACKING_MATERIAL: 'Packing Material',
  FINISHED_GOOD: 'Finished Good',
  SEMI_FINISHED: 'Semi Finished',
  TRADED_PRODUCTS: 'Traded Products',
  CAPITAL_GOOD: 'Capital Good',
  MACHINE_SPARES: 'Machine Spares',
  CONSUMABLES: 'Consumables',
};

const PRODUCT_CATEGORY_OPTIONS = Object.entries(PRODUCT_CATEGORY_LABEL).map(
  ([value, label]) => ({ value, label }),
);

export default function MaterialIssueList() {
  const navigate = useNavigate();
  const { canExport } = usePermissions();
  // Read-only ledger sourced from Work Order + Packing Process input rows.
  // No POST/PUT/DELETE — it's a derived view, not a hand-entered record set.
  const { data, isLoading, error, refetch } = useApiData('/api/production/material-ledger/');
  const [showFilters, setShowFilters] = useState(false);
  // Domain filters live in the URL so Back / refresh / sharing restore them.
  // (Advanced rules stay local — they're a complex rule set, not a simple map.)
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    source_type: '', product_category: '', warehouse_name: '', company_name: '', date_from: '', date_to: '',
  });
  const { rules: advancedRules, logic: advancedLogic, setAdvanced } = useUrlAdvancedRules();

  // The DataTable ships an always-visible search box, so the filter-panel
  // "Search" text field was a duplicate. Replace it with structured Category /
  // Warehouse / Company selects (options derived from the loaded rows).
  const optsFrom = (key) => [...new Set((data || []).map((r) => r[key]).filter(Boolean))]
    .sort().map((v) => ({ value: v, label: v }));
  const filters = [
    {
      key: 'source_type',
      label: 'Source',
      type: 'select',
      options: [
        { value: 'WORK_ORDER', label: 'Work Order' },
        { value: 'PACKING_PROCESS', label: 'Packing Process' },
      ],
    },
    { key: 'product_category', label: 'Category', type: 'select', options: PRODUCT_CATEGORY_OPTIONS },
    { key: 'warehouse_name', label: 'Warehouse', type: 'select', options: optsFrom('warehouse_name') },
    { key: 'company_name', label: 'Company', type: 'select', options: optsFrom('company_name') },
    { key: 'date_from', label: 'Date From', type: 'date' },
    { key: 'date_to', label: 'Date To', type: 'date' },
  ];

  const filterColumns = [
    { field: 'date', header: 'Date', type: 'date' },
    { field: 'source_no', header: 'Source No', type: 'text' },
    { field: 'source_type', header: 'Source Type', type: 'select', filterOptions: [
      { value: 'WORK_ORDER', label: 'Work Order' },
      { value: 'PACKING_PROCESS', label: 'Packing Process' },
    ]},
    { field: 'product_name', header: 'Product', type: 'text' },
    { field: 'product_code', header: 'Product Code', type: 'text' },
    { field: 'product_category', header: 'Category', type: 'select', filterOptions: PRODUCT_CATEGORY_OPTIONS },
    { field: 'uom', header: 'UOM', type: 'text' },
    { field: 'qty_used', header: 'Qty Used', type: 'number' },
    { field: 'warehouse_name', header: 'Warehouse', type: 'text' },
    { field: 'company_name', header: 'Company', type: 'text' },
  ];

  const columns = [
    { key: 'date', label: 'Date', sortable: true, render: (v) => fmtDate(v) },
    {
      key: 'source_no',
      label: 'Source',
      sortable: true,
      render: (_, row) => {
        const path = row.source_type === 'PACKING_PROCESS'
          ? `/production/packing-processes/${row.source_id}`
          : `/production/work-orders/${row.source_id}`;
        return (
          <button
            onClick={(e) => { e.stopPropagation(); if (row.source_id) navigate(path); }}
            className="text-blue-700 hover:underline font-mono text-xs font-medium"
          >
            {row.source_no || '-'}
          </button>
        );
      },
    },
    {
      key: 'source_type',
      label: 'Type',
      sortable: true,
      render: (v) => v === 'PACKING_PROCESS' ? 'Packing' : 'Production',
    },
    { key: 'product_name', label: 'Product Used', sortable: true, render: (v) => v || '-' },
    {
      key: 'product_category',
      label: 'Category',
      sortable: true,
      render: (v) => PRODUCT_CATEGORY_LABEL[v] || v || '-',
    },
    { key: 'uom', label: 'UOM', sortable: true, render: (v) => v || '-' },
    {
      key: 'qty_used',
      label: 'Qty Used',
      sortable: true,
      render: (v) => <span className="font-medium text-emerald-700">{fmtQty(v)}</span>,
    },
    { key: 'warehouse_name', label: 'Warehouse', sortable: true, render: (v) => v || '-' },
    { key: 'company_name', label: 'Company', sortable: true, render: (v) => v || '-' },
  ];

  const {
    visibleColumns, mergedColumns,
    showConfig, setShowConfig, handleConfigApply, visibleFieldKeys,
  } = useConfigureFields(columns, 'production_material_ledger_fields', data);

  const filteredData = useMemo(() => {
    let result = (data || []).filter((row) => {
      if (!matchesSelect(row.source_type, filterValues.source_type)) return false;
      if (!matchesSelect(row.product_category, filterValues.product_category)) return false;
      if (!matchesSelect(row.warehouse_name, filterValues.warehouse_name)) return false;
      if (!matchesSelect(row.company_name, filterValues.company_name)) return false;
      if (filterValues.date_from && row.date && row.date < filterValues.date_from) return false;
      if (filterValues.date_to && row.date && row.date > filterValues.date_to) return false;
      return true;
    });
    if (advancedRules.length > 0) {
      result = applyAdvancedFilters(result, advancedRules, advancedLogic);
    }
    return result;
  }, [data, filterValues, advancedRules, advancedLogic]);

  return (
    <MainLayout>
      <PageHeader
        title="Material Usage Ledger"
        subtitle="Products used across Work Orders and Packing Processes"
        breadcrumbs={[{ label: 'Production', href: '/production' }, { label: 'Material Usage' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          onConfigureFields: () => setShowConfig(true),
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
        <DataTable persistKey="production-material-issues"
          exportFileName="material-usage-ledger"
          canExport={canExport('Material Issue')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
        />
      </ListState>
      {showConfig && (
        <ConfigureFields
          allColumns={mergedColumns}
          visibleFields={visibleFieldKeys}
          onApply={handleConfigApply}
          onClose={() => setShowConfig(false)}
          storageKey="production_material_ledger_fields"
        />
      )}
    </MainLayout>
  );
}
