import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, RefreshCw } from 'lucide-react';

import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { applyAdvancedFilters, matchesSelect } from '../../../components/common/FilterPanel';
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import DataTable from '../../../components/common/DataTable';
import ListState from '@/components/common/ListState.jsx';
import StatusBadge from '../../../components/common/StatusBadge';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import { useUrlFilters, useUrlAdvancedRules } from '../../../hooks/useUrlState.js';
import BulkImportModal from '../../../components/common/BulkImportModal';
import { formatDate } from '@/utils/formatters';

const fmtQty = (v) =>
  Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const fmtDate = (v) =>
  v ? formatDate(v) : '-';

// Map a BOM list column to its 'BOM Request' catalog key by meaning. The list
// renders BOMTemplate rows, so a couple of columns map across names: the
// 'status' column corresponds to the catalog's 'approval_status'. Columns with
// no catalog key fall through and are never hidden.
const CATALOG_KEY_BY_FIELD = {
  status: 'approval_status',
  company_name: 'company',
  warehouse_code: 'warehouse',
  warehouse_name: 'warehouse',
};
const keyFor = (c) => {
  const raw = c.field || c.key || '';
  return CATALOG_KEY_BY_FIELD[raw] || raw.replace(/_(name|code|display)$/, '');
};

export default function BOMTemplateList() {
  const navigate = useNavigate();
  const { canCreate, canExport, canImport } = usePermissions();
  const [showImport, setShowImport] = useState(false);
  // Field-level permissions — drop HIDDEN columns entirely for this role.
  const { isHidden } = useFieldPermissions('BOM Request');
  // BOMTemplate is the canonical recipe model; the older BOMRequest workflow
  // lives elsewhere. This list shows everything created via /production/bom/new.
  const { data, isLoading, error, refetch } = useApiData('/api/production/bom-templates/');
  const [showFilters, setShowFilters] = useState(false);
  // Domain filters live in the URL so Back / refresh / sharing restore them.
  // (Advanced rules stay local — they're a complex rule set, not a simple map.)
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    company_name: '', status: '',
  });
  const { rules: advancedRules, logic: advancedLogic, setAdvanced } = useUrlAdvancedRules();

  // The DataTable ships an always-visible search box, so the filter-panel
  // "Search" text field was a duplicate. Replace it with a structured Company
  // filter (options derived from the loaded rows) alongside the Status filter.
  const optsFrom = (key) => [...new Set((data || []).map((r) => r[key]).filter(Boolean))]
    .sort().map((v) => ({ value: v, label: v }));
  const filters = [
    { key: 'company_name', label: 'Company', type: 'select', options: optsFrom('company_name') },
    {
      key: 'status', label: 'Status', type: 'select',
      options: [
        { value: 'DRAFT',    label: 'Draft' },
        { value: 'ACTIVE',   label: 'Active' },
        { value: 'INACTIVE', label: 'Inactive' },
      ],
    },
  ];

  // Advanced filter column definitions — drives the type-aware operator
  // pickers (=, !=, contains, between, on/before/after, etc.) inside the
  // advanced rules tab of FilterPanel.
  const filterColumns = [
    { field: 'template_id', header: 'Template ID', type: 'text' },
    { field: 'template_name', header: 'Template Name', type: 'text' },
    { field: 'finished_product_name', header: 'Finished Product', type: 'text' },
    { field: 'finished_product_sku', header: 'SKU', type: 'text' },
    { field: 'company_name', header: 'Company', type: 'text' },
    { field: 'batch_size', header: 'Batch Size', type: 'number' },
    { field: 'item_count', header: 'Ingredients', type: 'number' },
    { field: 'revision_no', header: 'Revision', type: 'number' },
    { field: 'effective_from', header: 'Effective From', type: 'date' },
    { field: 'status', header: 'Status', type: 'select', filterOptions: [
      { value: 'DRAFT', label: 'Draft' },
      { value: 'ACTIVE', label: 'Active' },
      { value: 'INACTIVE', label: 'Inactive' },
    ]},
  ];

  const columns = [
    { key: 'template_id', label: 'Template ID', sortable: true,
      render: (v, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/production/bom/${row.id}`); }}
          className="text-blue-700 hover:underline font-medium text-xs"
        >{v}</button>
      ),
    },
    { key: 'template_name', label: 'Template Name', sortable: true,
      render: (v) => v || '-' },
    { key: 'finished_product_name', label: 'Finished Product', sortable: true,
      render: (v, row) => v || row.finished_product_sku || '-' },
    { key: 'company_name', label: 'Company', sortable: true,
      render: (v) => v || '-' },
    { key: 'batch_size', label: 'Batch Size', sortable: true,
      render: (v, row) => `${fmtQty(v)} ${row.output_uom || ''}`.trim() },
    { key: 'item_count', label: 'Ingredients', sortable: true,
      render: (v) => Number(v || 0) },
    { key: 'revision_no', label: 'Rev', sortable: true,
      render: (v) => `v${v || 1}` },
    { key: 'effective_from', label: 'Effective', sortable: true, render: (v) => fmtDate(v) },
    { key: 'status', label: 'Status', sortable: true,
      render: (v) => <StatusBadge status={v} /> },
    { key: 'actions', label: '', sortable: false,
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/production/bom/${row.id}`); }}
          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
          title="Edit"
        >
          <Pencil size={15} />
        </button>
      ),
    },
  ];

  // Never drop the primary identifier / link column or the actions column,
  // regardless of field permissions.
  const ALWAYS_SHOW = new Set(['template_id', 'actions']);
  const permittedColumns = columns.filter(
    (c) => ALWAYS_SHOW.has(c.field || c.key) || !isHidden(keyFor(c)),
  );

  const {
    visibleColumns, mergedColumns,
    showConfig, setShowConfig, handleConfigApply, visibleFieldKeys,
  } = useConfigureFields(permittedColumns, 'production_bom_templates_fields', data);

  const filteredData = (() => {
    let result = (data || []).filter((row) => {
      if (!matchesSelect(row.company_name, filterValues.company_name)) return false;
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
        title="BOM Templates"
        subtitle="Standard recipes — one per finished goods product"
        breadcrumbs={[{ label: 'Production', href: '/production' }, { label: 'BOM Templates' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          onConfigureFields: () => setShowConfig(true),
          ...(canImport('BOM Request') ? { onImport: () => setShowImport(true) } : {}),
          ...(canCreate('BOM Request') ? {
            createLink: '/production/bom/new',
            createLabel: 'New BOM Template',
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
        <DataTable persistKey="production-bom"
          exportFileName="bom-templates"
          canExport={canExport('BOM Request')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/production/bom/${row.id}`)}
        />
      </ListState>
      {showConfig && (
        <ConfigureFields
          allColumns={mergedColumns}
          visibleFields={visibleFieldKeys}
          onApply={handleConfigApply}
          onClose={() => setShowConfig(false)}
          storageKey="production_bom_templates_fields"
        />
      )}
      <BulkImportModal
        open={showImport}
        onClose={() => setShowImport(false)}
        entityLabel="BOM Templates"
        endpoint="/api/production/bom-templates/"
        onSuccess={refetch}
      />
    </MainLayout>
  );
}
