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
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatDate } from '@/utils/formatters';
import { confirm } from '@/components/common/confirm';

export default function SalesReturnAdviceList() {
  const { canCreate, can, canExport } = usePermissions();
  const { isHidden } = useFieldPermissions('Sales Return');
  const { data, isLoading, error, refetch } = useApiData('/api/inventory/returns/');
  const navigate = useNavigate();
  const [showFilters, setShowFilters] = useState(false);
  // Filters live in the URL so Back / refresh / sharing restore the filtered view.
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    customer: '', warehouse_name: '', reason: '', approval_status: '', date_from: '',
  });
  const [deletingId, setDeletingId] = useState(null);
  const canDelete = can('Sales Return', 'delete');

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Delete return ${row.return_no || ''}? Any ledger entries it posted will be reversed.`, isDangerous: true }))) return;
    setDeletingId(row.id);
    try {
      await apiClient.delete(`/api/inventory/returns/${row.id}/`);
      toast.success('Sales return deleted');
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
    { key: 'customer', label: 'Customer / Vendor', type: 'text', placeholder: 'Search customer or vendor...' },
    { key: 'warehouse_name', label: 'Warehouse', type: 'select', options: optsFrom('warehouse_name') },
    { key: 'reason', label: 'Reason', type: 'select', options: optsFrom('reason') },
    { key: 'approval_status', label: 'Approval Status', type: 'select', options: optsFrom('approval_status') },
    { key: 'date_from', label: 'Date From', type: 'date' },
  ];

  const columns = [
    { key: 'return_no', label: 'Return No', sortable: true },
    {
      // Customer Returns (vendor return workflow) carry no customer
      // FK — surface the vendor name instead so the column is never
      // empty or a raw UUID.
      key: 'party',
      label: 'Customer / Vendor',
      sortable: true,
      render: (_, row) => row.customer_name || row.vendor_name || '-',
    },
    {
      key: 'warehouse_name',
      label: 'Warehouse',
      sortable: true,
      render: (_, row) => row.warehouse_name || '-',
    },
    {
      key: 'return_date',
      label: 'Return Date',
      sortable: true,
      render: (value) => value ? formatDate(value) : '-',
    },
    { key: 'reason', label: 'Reason', sortable: true },
    { key: 'total_qty', label: 'Total Qty', sortable: true },
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
            onClick={(e) => { e.stopPropagation(); navigate(`/inventory/returns/${row.id}`); }}
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
  // actions column or the primary Return No link column. The Warehouse
  // column shows the received warehouse, so it maps to the catalog's
  // received_warehouse key by meaning rather than a plain suffix strip.
  const keyFor = (c) => {
    if (c.key === 'warehouse_name') return 'received_warehouse';
    return c.key.replace(/_(name|code|display)$/, '');
  };
  const visibleColumns = columns.filter(
    (c) => c.key === 'return_no' || c.key === 'actions' || !isHidden(keyFor(c))
  );

  const filteredData = (data || []).filter((row) => {
    if (filterValues.customer) {
      const customerSearch = filterValues.customer.toLowerCase();
      const party = (row.customer_name || row.vendor_name || '').toLowerCase();
      if (!party.includes(customerSearch)) return false;
    }
    if (!matchesSelect(row.warehouse_name, filterValues.warehouse_name)) return false;
    if (!matchesSelect(row.reason, filterValues.reason)) return false;
    if (!matchesSelect(row.approval_status, filterValues.approval_status)) return false;
    if (filterValues.date_from && row.return_date < filterValues.date_from) {
      return false;
    }
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Sales Return Advice"
        subtitle="Manage sales return advice records"
        breadcrumbs={[
          { label: 'Inventory', href: '/inventory' },
          { label: 'Sales Return Advice' },
        ]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreate('Sales Return') ? { createLink: '/inventory/returns/new', createLabel: 'New Return Advice' } : {}),
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
        <DataTable persistKey="inventory-returns"
          exportFileName="sales-returns"
          canExport={canExport('Sales Return')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/inventory/returns/${row.id}`)}
        />
      </ListState>
    </MainLayout>
  );
}
