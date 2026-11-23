import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { matchesSelect } from '../../../components/common/FilterPanel';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import { Pencil, Trash2, RefreshCw } from 'lucide-react';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';
import ListState from '@/components/common/ListState.jsx';

export default function StockTransferDCList() {
  const { canCreate, can, canExport } = usePermissions();
  const { isHidden } = useFieldPermissions('Stock Transfer');
  const { data, isLoading, error, refetch } = useApiData('/api/inventory/transfers/');
  const navigate = useNavigate();
  const [showFilters, setShowFilters] = useState(false);
  // Filters live in the URL so Back / refresh / sharing restore the filtered view.
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    from_warehouse_name: '', to_warehouse_name: '', status: '', date_from: '',
  });
  const [deletingId, setDeletingId] = useState(null);
  const canDelete = can('Stock Transfer', 'delete');

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    const isPosted = row.status === 'APPROVED' || row.status === 'COMPLETED';
    const warning = isPosted
      ? `\n\nWarning: ${row.transfer_no} has already moved stock. Deleting it will also reverse those ledger entries (stock returns to source).`
      : '';
    if (!(await confirm({ message: `Delete transfer ${row.transfer_no}?${warning}`, isDangerous: true }))) return;
    setDeletingId(row.id);
    try {
      await apiClient.delete(`/api/inventory/transfers/${row.id}/`);
      toast.success(`${row.transfer_no} deleted`);
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
    { key: 'from_warehouse_name', label: 'From Warehouse', type: 'select', options: optsFrom('from_warehouse_name') },
    { key: 'to_warehouse_name', label: 'To Warehouse', type: 'select', options: optsFrom('to_warehouse_name') },
    { key: 'status', label: 'Status', type: 'select', options: optsFrom('status') },
    { key: 'date_from', label: 'Date From', type: 'date' },
  ];

  const columns = [
    { key: 'transfer_no', label: 'Transfer No', sortable: true },
    {
      key: 'transfer_date',
      label: 'Transfer Date',
      sortable: true,
      render: (value, row) => {
        const v = value || row.created_date;
        return v ? formatDate(v) : '-';
      },
    },
    { key: 'from_warehouse_name', label: 'From Warehouse', sortable: true, render: (v) => v || '-' },
    { key: 'to_warehouse_name', label: 'To Warehouse', sortable: true, render: (v) => v || '-' },
    { key: 'transporter_name', label: 'Transporter', sortable: true, render: (v) => v || '-' },
    {
      key: 'total_qty', label: 'Total Qty', sortable: true,
      render: (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 }),
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
            onClick={(e) => { e.stopPropagation(); navigate(`/inventory/transfers/${row.id}`); }}
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

  // Drop columns the user is not allowed to see. Never strip the
  // actions column or the primary Transfer No link column. keyFor maps
  // a display column back to its catalog field key by stripping the
  // trailing _name/_code/_display suffix.
  const keyFor = (c) => c.key.replace(/_(name|code|display)$/, '');
  const visibleColumns = columns.filter(
    (c) => c.key === 'transfer_no' || c.key === 'actions' || !isHidden(keyFor(c))
  );

  const filteredData = (data || []).filter((row) => {
    if (!matchesSelect(row.from_warehouse_name, filterValues.from_warehouse_name)) return false;
    if (!matchesSelect(row.to_warehouse_name, filterValues.to_warehouse_name)) return false;
    if (!matchesSelect(row.status, filterValues.status)) return false;
    if (filterValues.date_from && row.created_date < filterValues.date_from) {
      return false;
    }
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Stock Transfer"
        subtitle="Manage stock transfers between warehouses"
        breadcrumbs={[
          { label: 'Inventory', href: '/inventory' },
          { label: 'Stock Transfer' },
        ]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreate('Stock Transfer') ? { createLink: '/inventory/transfers/new', createLabel: 'New Transfer' } : {}),
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
        <DataTable persistKey="inventory-transfers"
          exportFileName="stock-transfers"
          canExport={canExport('Stock Transfer')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/inventory/transfers/${row.id}`)}
        />
      </ListState>
    </MainLayout>
  );
}
