import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { matchesSelect } from '../../../components/common/FilterPanel';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ListState from '@/components/common/ListState.jsx';
import { Pencil, Trash2, RefreshCw } from 'lucide-react';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatDate } from '@/utils/formatters';
import { confirm } from '@/components/common/confirm';

export default function StockAdjustmentList() {
  const { canCreate, can, canExport } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/inventory/adjustments/');
  const navigate = useNavigate();
  const [showFilters, setShowFilters] = useState(false);
  // Filters live in the URL so Back / refresh / sharing restore the filtered view.
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    warehouse_name: '', adjustment_type: '', approval_status: '', date_from: '',
  });
  const [deletingId, setDeletingId] = useState(null);
  const canDelete = can('Stock Adjustment', 'delete');

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Delete adjustment ${row.adjustment_no || ''}?\n\n` +
      'Warning: this will reverse the stock change posted to the ledger.', isDangerous: true }))) return;
    setDeletingId(row.id);
    try {
      await apiClient.delete(`/api/inventory/adjustments/${row.id}/`);
      toast.success('Stock adjustment deleted');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setDeletingId(null);
    }
  };

  // The list already has an always-visible search bar (DataTable's built-in
  // search across every column), so a "Search" filter here was just a
  // duplicate. Real column filters instead — options are derived from the
  // loaded rows so they always match what's actually present.
  const optsFrom = (key) => [...new Set((data || []).map((r) => r[key]).filter(Boolean))]
    .sort().map((v) => ({ value: v, label: v }));
  const filters = [
    { key: 'warehouse_name', label: 'Warehouse', type: 'select', options: optsFrom('warehouse_name') },
    { key: 'adjustment_type', label: 'Adjustment Type', type: 'select', options: optsFrom('adjustment_type') },
    { key: 'approval_status', label: 'Approval Status', type: 'select', options: optsFrom('approval_status') },
    { key: 'date_from', label: 'Date From', type: 'date' },
  ];

  const columns = [
    { key: 'adjustment_no', label: 'Adjustment No', sortable: true },
    {
      key: 'warehouse_name',
      label: 'Warehouse',
      sortable: true,
      render: (_, row) => row.warehouse_name || '-',
    },
    {
      key: 'product_name',
      label: 'Product',
      sortable: true,
      render: (_, row) => row.product_name || '-',
    },
    { key: 'adjustment_type', label: 'Adjustment Type', sortable: true },
    { key: 'quantity', label: 'Quantity', sortable: true },
    {
      key: 'adjustment_date',
      label: 'Adjustment Date',
      sortable: true,
      render: (value) => value ? formatDate(value) : '-',
    },
    {
      key: 'approval_status',
      label: 'Approval Status',
      render: (value) => <StatusBadge status={value} />,
    },
    {
      key: 'actions',
      label: '',
      sortable: false,
      render: (_, row) => (
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); navigate(`/inventory/adjustments/${row.id}`); }}
            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
            aria-label="Edit"
            title="Edit"
          >
            <Pencil size={15} />
          </button>
          {canDelete && (
            <button
              onClick={(e) => handleDelete(e, row)}
              disabled={deletingId === row.id}
              className="p-1.5 text-red-500 hover:bg-red-50 rounded transition disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Delete"
              title="Delete"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ),
    },
  ];

  const filteredData = (data || []).filter((row) => {
    if (!matchesSelect(row.warehouse_name, filterValues.warehouse_name)) return false;
    if (!matchesSelect(row.adjustment_type, filterValues.adjustment_type)) return false;
    if (!matchesSelect(row.approval_status, filterValues.approval_status)) return false;
    if (filterValues.date_from && row.adjustment_date < filterValues.date_from) {
      return false;
    }
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Stock Adjustments"
        subtitle="Manage stock adjustment records"
        breadcrumbs={[
          { label: 'Inventory', href: '/inventory' },
          { label: 'Stock Adjustments' },
        ]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreate('Stock Adjustment') ? { createLink: '/inventory/adjustments/new', createLabel: 'New Adjustment' } : {}),
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
        <DataTable persistKey="inventory-adjustments"
          exportFileName="stock-adjustments"
          canExport={canExport('Stock Adjustment')}
          columns={columns}
          data={filteredData}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/inventory/adjustments/${row.id}`)}
        />
      </ListState>
    </MainLayout>
  );
}
