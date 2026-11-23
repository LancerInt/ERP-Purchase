import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { applyAdvancedFilters, matchesSelect } from '../../../components/common/FilterPanel';
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import { Pencil, Trash2, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { useUrlFilters, useUrlAdvancedRules } from '../../../hooks/useUrlState.js';
import { confirm } from '@/components/common/confirm';
import ListState from '@/components/common/ListState.jsx';
import { formatDate, formatCurrency } from '@/utils/formatters';

// Strip companion suffixes so a list column maps back to its base catalog key.
const keyFor = (c) => (c.field || c.key || '').replace(/_(name|code|display)$/, '');

export default function WageVoucherList() {
  const navigate = useNavigate();
  const { canCreate, canDelete, canExport } = usePermissions();
  // Field-level permissions — drop HIDDEN columns entirely for this role.
  const { isHidden } = useFieldPermissions('Wage Voucher');
  const { data, isLoading, error, refetch } = useApiData('/api/production/wage-vouchers/');

  const handleDelete = async (row) => {
    if (!(await confirm({ message: `Delete wage voucher "${row.voucher_no}"? This cannot be undone.`, isDangerous: true }))) return;
    try {
      await apiClient.delete(`/api/production/wage-vouchers/${row.id}/`);
      toast.success('Wage voucher deleted.');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete.');
    }
  };
  const [showFilters, setShowFilters] = useState(false);
  // Domain filters live in the URL so Back / refresh / sharing restore them.
  // (Advanced rules stay local — they're a complex rule set, not a simple map.)
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    voucher_kind: '', status: '', warehouse_name: '', prepared_by_name: '', date_from: '',
  });
  const { rules: advancedRules, logic: advancedLogic, setAdvanced } = useUrlAdvancedRules();

  // Real column filters (the DataTable already ships an always-visible search
  // bar, so a "Search" filter here was just a duplicate). Name options are
  // derived from the loaded rows so they always match what's actually present.
  const optsFrom = (key) => [...new Set((data || []).map((r) => r[key]).filter(Boolean))]
    .sort().map((v) => ({ value: v, label: v }));
  const filters = [
    {
      key: 'voucher_kind',
      label: 'Voucher For',
      type: 'select',
      options: [
        { value: 'PRODUCTION', label: 'Production' },
        { value: 'PACKING', label: 'Packing' },
      ],
    },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'DRAFT', label: 'Draft' },
        { value: 'PENDING', label: 'Pending' },
        { value: 'APPROVED', label: 'Approved' },
        { value: 'PAID', label: 'Paid' },
      ],
    },
    { key: 'warehouse_name', label: 'Warehouse', type: 'select', options: optsFrom('warehouse_name') },
    { key: 'prepared_by_name', label: 'Prepared By', type: 'select', options: optsFrom('prepared_by_name') },
    { key: 'date_from', label: 'Date From', type: 'date' },
  ];

  const filterColumns = [
    { field: 'voucher_no', header: 'Voucher No', type: 'text' },
    { field: 'voucher_kind', header: 'For', type: 'select', filterOptions: [
      { value: 'PRODUCTION', label: 'Production' },
      { value: 'PACKING', label: 'Packing' },
    ]},
    { field: 'work_order_no', header: 'WO Number', type: 'text' },
    { field: 'packing_no', header: 'Packing No', type: 'text' },
    { field: 'warehouse_name', header: 'Warehouse', type: 'text' },
    { field: 'prepared_by_name', header: 'Prepared By', type: 'text' },
    { field: 'prepared_date', header: 'Prepared Date', type: 'date' },
    { field: 'amount', header: 'Total Amount', type: 'number' },
    { field: 'tds', header: 'TDS', type: 'number' },
    { field: 'status', header: 'Status', type: 'select', filterOptions: [
      { value: 'DRAFT', label: 'Draft' },
      { value: 'PENDING', label: 'Pending' },
      { value: 'APPROVED', label: 'Approved' },
      { value: 'PAID', label: 'Paid' },
    ]},
  ];

  const columns = [
    {
      key: 'voucher_no', label: 'Voucher No', sortable: true,
      render: (value, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/production/wage-vouchers/${row.id}`); }}
          className="text-primary-600 hover:text-primary-800 hover:underline font-medium"
        >
          {value}
        </button>
      ),
    },
    {
      key: 'voucher_kind',
      label: 'For',
      sortable: true,
      render: (value) => value === 'PACKING' ? 'Packing' : 'Production',
    },
    {
      key: 'reference',
      label: 'WO / Packing No',
      sortable: false,
      render: (_, row) =>
        row.voucher_kind === 'PACKING'
          ? (row.packing_no || '-')
          : (row.work_order_no || row.work_order_batch || '-'),
    },
    { key: 'warehouse_name', label: 'Warehouse', sortable: true, render: (v) => v || '-' },
    { key: 'prepared_by_name', label: 'Prepared By', sortable: true, render: (v) => v || '-' },
    {
      key: 'prepared_date',
      label: 'Prepared Date',
      sortable: true,
      render: (value) => value ? formatDate(value) : '-',
    },
    {
      key: 'amount',
      label: 'Total Amount',
      sortable: true,
      render: (value) => value ? formatCurrency(value) : '-',
    },
    {
      key: 'tds',
      label: 'TDS',
      sortable: true,
      render: (value) => Number(value) ? formatCurrency(value) : '-',
    },
    {
      key: 'net_amount',
      label: 'Net Payable',
      sortable: true,
      render: (value) => value != null ? formatCurrency(value) : '-',
    },
    {
      key: 'status',
      label: 'Status',
      render: (value) => <StatusBadge status={value} />,
    },
    {
      key: 'actions',
      label: '',
      sortable: false,
      render: (_, row) => (
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); navigate(`/production/wage-vouchers/${row.id}`); }}
            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
            title="View / Edit"
          >
            <Pencil size={15} />
          </button>
          {canDelete('Wage Voucher') && (
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(row); }}
              className="p-1.5 text-red-500 hover:bg-red-50 rounded transition"
              title="Delete"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ),
    },
  ];

  // Never drop the primary identifier / link column or the actions column,
  // regardless of field permissions.
  const ALWAYS_SHOW = new Set(['voucher_no', 'actions']);
  const permittedColumns = columns.filter(
    (c) => ALWAYS_SHOW.has(c.field || c.key) || !isHidden(keyFor(c)),
  );

  const {
    visibleColumns, mergedColumns,
    showConfig, setShowConfig, handleConfigApply, visibleFieldKeys,
  } = useConfigureFields(permittedColumns, 'production_wage_vouchers_fields', data);

  const filteredData = (() => {
    let result = (data || []).filter((row) => {
      if (!matchesSelect(row.voucher_kind, filterValues.voucher_kind)) return false;
      if (!matchesSelect(row.status, filterValues.status)) return false;
      if (!matchesSelect(row.warehouse_name, filterValues.warehouse_name)) return false;
      if (!matchesSelect(row.prepared_by_name, filterValues.prepared_by_name)) return false;
      if (filterValues.date_from && row.prepared_date < filterValues.date_from) return false;
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
        title="Wage Vouchers"
        subtitle="Manage production wage vouchers"
        breadcrumbs={[{ label: 'Production', href: '/production' }, { label: 'Wage Vouchers' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          onConfigureFields: () => setShowConfig(true),
          ...(canCreate('Wage Voucher') ? { createLink: '/production/wage-vouchers/new', createLabel: 'New Wage Voucher' } : {}),
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
        <DataTable persistKey="production-wage-vouchers"
          exportFileName="wage-vouchers"
          canExport={canExport('Wage Voucher')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/production/wage-vouchers/${row.id}`)}
        />
      </ListState>
      {showConfig && (
        <ConfigureFields
          allColumns={mergedColumns}
          visibleFields={visibleFieldKeys}
          onApply={handleConfigApply}
          onClose={() => setShowConfig(false)}
          storageKey="production_wage_vouchers_fields"
        />
      )}
    </MainLayout>
  );
}
