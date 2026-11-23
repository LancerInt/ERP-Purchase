import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Pencil, Check, Filter, Settings2, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import FilterPanel, { applyAdvancedFilters, matchesSelect } from '../../../components/common/FilterPanel';
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import useApiData from '../../../hooks/useApiData.js';
import useUrlPage from '../../../hooks/useUrlPage.js';
import { useUrlFilters, useUrlAdvancedRules } from '../../../hooks/useUrlState.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { confirm } from '@/components/common/confirm';
import ListState from '@/components/common/ListState.jsx';
import { formatDate } from '@/utils/formatters';
import exportToExcel from '../../../utils/exportExcel.js';

const fmtDate = (v) =>
  v ? formatDate(v) : '-';

// Strip companion suffixes so a list column maps back to its base catalog key.
const keyFor = (c) => (c.field || c.key || '').replace(/_(name|code|display)$/, '');

export default function WorkOrderList() {
  const navigate = useNavigate();
  const { canCreate, canApprove, canExport } = usePermissions();
  // Field-level permissions — drop HIDDEN columns entirely for this role.
  const { isHidden } = useFieldPermissions('Work Order');
  const { data, isLoading, error, refetch } = useApiData('/api/production/work-orders/');

  const [sortBy, setSortBy] = useState('created_at');
  const [sortOrder, setSortOrder] = useState('desc');
  const [searchTerm, setSearchTerm] = useState('');
  // Domain filters live in the URL so Back / refresh / sharing restore them.
  // (Advanced rules stay local — they're a complex rule set, not a simple map.)
  const { values: activeFilters, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    stage_status: '', approval_status: '',
  });
  const [page, setPage] = useUrlPage([searchTerm, activeFilters.stage_status, activeFilters.approval_status]);
  const [showFilters, setShowFilters] = useState(false);
  const { rules: advancedRules, logic: advancedLogic, setAdvanced } = useUrlAdvancedRules();

  const handleApprove = async (row) => {
    if (!(await confirm({ message: `Approve "${row.work_order_no || row.batch_id}"?` }))) return;
    try {
      await apiClient.post(`/api/production/work-orders/${row.id}/approve/`);
      toast.success('Work Order approved.');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to approve.');
    }
  };

  const columns = [
    {
      field: 'work_order_no',
      header: 'WO Number',
      sortable: true,
      width: '140px',
      render: (v, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/production/work-orders/${row.id}`); }}
          className="text-blue-700 hover:underline font-medium font-mono text-xs"
        >{v || row.batch_id || '-'}</button>
      ),
    },
    {
      field: 'finished_product_name',
      header: 'Product',
      sortable: true,
      width: '220px',
      render: (v) => v || '-',
    },
    {
      field: 'process_name',
      header: 'Process',
      sortable: true,
      width: '160px',
      render: (_, row) => row.process_name || row.process_name_snapshot || '-',
    },
    {
      field: 'date',
      header: 'Date',
      sortable: true,
      width: '120px',
      render: (v) => fmtDate(v),
    },
    {
      field: 'stage_status',
      header: 'Stage',
      sortable: true,
      width: '140px',
      render: (v) => <StatusBadge status={v || 'MATERIAL_ISSUE'} />,
    },
    {
      field: 'approval_status',
      header: 'Approval',
      sortable: true,
      width: '120px',
      render: (v) => <StatusBadge status={v || 'PENDING'} />,
    },
    {
      field: 'actions',
      header: '',
      sortable: false,
      width: '90px',
      render: (_, row) => (
        <div className="flex items-center gap-1">
          {canApprove('Work Order') && row.approval_status !== 'APPROVED' && (
            <button
              onClick={(e) => { e.stopPropagation(); handleApprove(row); }}
              className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded transition"
              title="Approve"
            >
              <Check size={15} />
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); navigate(`/production/work-orders/${row.id}`); }}
            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
            title="Edit"
          >
            <Pencil size={15} />
          </button>
        </div>
      ),
    },
  ];

  // Never drop the primary identifier / link column or the actions column,
  // regardless of field permissions.
  const ALWAYS_SHOW = new Set(['work_order_no', 'actions']);
  const permittedColumns = columns.filter(
    (c) => ALWAYS_SHOW.has(c.field || c.key) || !isHidden(keyFor(c)),
  );

  const {
    visibleColumns, mergedColumns,
    showConfig, setShowConfig, handleConfigApply, visibleFieldKeys,
  } = useConfigureFields(permittedColumns, 'production_work_orders_fields', data);

  const filterOptions = [
    {
      key: 'stage_status',
      label: 'Stage',
      options: [
        { value: 'MATERIAL_ISSUE', label: 'Material Issued' },
        { value: 'PACKING', label: 'Packing' },
        { value: 'QC', label: 'Quality Check' },
        { value: 'CLOSED', label: 'Closed' },
      ],
    },
    {
      key: 'approval_status',
      label: 'Approval',
      options: [
        { value: 'PENDING', label: 'Pending' },
        { value: 'APPROVED', label: 'Approved' },
        { value: 'REJECTED', label: 'Rejected' },
      ],
    },
  ];

  // Type-aware advanced filter columns (operators picked by FilterPanel).
  const filterColumns = [
    { field: 'work_order_no', header: 'WO Number', type: 'text' },
    { field: 'batch_id', header: 'Batch ID', type: 'text' },
    { field: 'finished_product_name', header: 'Product', type: 'text' },
    { field: 'process_name', header: 'Process', type: 'text' },
    { field: 'company_name', header: 'Company', type: 'text' },
    { field: 'date', header: 'Date', type: 'date' },
    { field: 'production_date', header: 'Production Date', type: 'date' },
    { field: 'stage_status', header: 'Stage', type: 'select', filterOptions: [
      { value: 'MATERIAL_ISSUE', label: 'Material Issued' },
      { value: 'PACKING', label: 'Packing' },
      { value: 'QC', label: 'Quality Check' },
      { value: 'CLOSED', label: 'Closed' },
    ]},
    { field: 'approval_status', header: 'Approval', type: 'select', filterOptions: [
      { value: 'PENDING', label: 'Pending' },
      { value: 'APPROVED', label: 'Approved' },
      { value: 'REJECTED', label: 'Rejected' },
    ]},
    { field: 'total_estimated_material_cost', header: 'Material Cost', type: 'number' },
    { field: 'cost_per_output_unit', header: 'Cost / Unit', type: 'number' },
  ];

  const filteredData = (() => {
    let result = (data || []).filter((row) => {
      const s = (searchTerm || '').toLowerCase();
      if (s) {
        const hay = [
          row.work_order_no, row.batch_id,
          row.finished_product_name, row.process_name, row.process_name_snapshot,
          row.company_name, row.warehouse_code,
        ].map((x) => String(x || '').toLowerCase()).join(' ');
        if (!hay.includes(s)) return false;
      }
      if (!matchesSelect(row.stage_status, activeFilters.stage_status)) return false;
      if (!matchesSelect(row.approval_status, activeFilters.approval_status)) return false;
      return true;
    });
    if (advancedRules.length > 0) {
      result = applyAdvancedFilters(result, advancedRules, advancedLogic);
    }
    return result;
  })();

  const handleSort = (field, order) => {
    setSortBy(field);
    setSortOrder(order);
  };

  const handleFilterChange = (filters) => {
    ['stage_status', 'approval_status'].forEach((k) => setFilterValue(k, filters?.[k] ?? ''));
  };

  // Header Export — writes the current (searched/filtered) work-order list
  // to .xlsx. Kept in the header so it's always available; the DataTable's
  // own export is disabled below to avoid two Export buttons.
  const handleExport = () => {
    const rows = filteredData.map((r) => ({
      work_order_no: r.work_order_no || r.batch_id || '',
      finished_product_name: r.finished_product_name || '',
      process_name: r.process_name || r.process_name_snapshot || '',
      company_name: r.company_name || '',
      date: r.date ? formatDate(r.date) : '',
      stage_status: r.stage_status || 'MATERIAL_ISSUE',
      approval_status: r.approval_status || 'PENDING',
      total_estimated_material_cost: r.total_estimated_material_cost ?? '',
      cost_per_output_unit: r.cost_per_output_unit ?? '',
    }));
    exportToExcel(rows, [
      { field: 'work_order_no', header: 'WO Number' },
      { field: 'finished_product_name', header: 'Product' },
      { field: 'process_name', header: 'Process' },
      { field: 'company_name', header: 'Company' },
      { field: 'date', header: 'Date' },
      { field: 'stage_status', header: 'Stage' },
      { field: 'approval_status', header: 'Approval' },
      { field: 'total_estimated_material_cost', header: 'Material Cost' },
      { field: 'cost_per_output_unit', header: 'Cost / Unit' },
    ], 'work-orders');
  };

  const breadcrumbs = [
    { label: 'Production', href: '#' },
    { label: 'Work Orders' },
  ];

  return (
    <MainLayout breadcrumbs={breadcrumbs}>
      <div className="space-y-4 sm:space-y-6">
        <PageHeader
          title="Work Orders"
          subtitle="Monitor production work orders and progress"
          actions={{
            onFilter: () => setShowFilters(!showFilters),
            onConfigureFields: () => setShowConfig(true),
            ...(canExport('Work Order') ? { onExport: handleExport } : {}),
            ...(canCreate('Work Order') ? { createLink: '/production/work-orders/new', createLabel: 'New WO' } : {}),
          }}
        />

        {showFilters && (
          <FilterPanel
            columns={filterColumns}
            filters={filterOptions}
            values={activeFilters}
            onChange={(k, v) => setFilterValue(k, v)}
            onReset={() => { clearFilters(); setAdvanced([], 'AND'); }}
            onClose={() => setShowFilters(false)}
            data={data || []}
            onAdvancedFilter={(rules, logic) => setAdvanced(rules, logic)}
            initialRules={advancedRules}
            initialLogic={advancedLogic}
          />
        )}

        <ListState error={error} onRetry={refetch}>
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
            <DataTable
              exportFileName="work-orders"
              canExport={false}
              columns={visibleColumns}
              data={filteredData}
              isLoading={isLoading}
              page={page}
              pageSize={10}
              totalRecords={filteredData.length}
              onPageChange={setPage}
              onSort={handleSort}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSearch={setSearchTerm}
              searchPlaceholder="Search by WO number, product, process or company..."
              filters={filterOptions}
              onFilterChange={handleFilterChange}
              onRowClick={(row) => navigate(`/production/work-orders/${row.id}`)}
            />
          </div>
        </ListState>
      </div>
      {showConfig && (
        <ConfigureFields
          allColumns={mergedColumns}
          visibleFields={visibleFieldKeys}
          onApply={handleConfigApply}
          onClose={() => setShowConfig(false)}
          storageKey="production_work_orders_fields"
        />
      )}
    </MainLayout>
  );
}
