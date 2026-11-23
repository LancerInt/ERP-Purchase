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

export default function JobWorkOrderList() {
  const { canCreate, can, canExport } = usePermissions();
  const { isHidden } = useFieldPermissions('Job Work Order');
  const { data, isLoading, error, refetch } = useApiData('/api/inventory/job-work/');
  const navigate = useNavigate();
  const [showFilters, setShowFilters] = useState(false);
  // Filters live in the URL so Back / refresh / sharing restore the filtered view.
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    vendor: '', warehouse_name: '', template_name: '', status: '', date_from: '',
  });
  const [deletingId, setDeletingId] = useState(null);
  const canDelete = can('Job Work Order', 'delete');

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Delete job work order ${row.order_no || ''}? Any ledger entries it posted will be reversed.`, isDangerous: true }))) return;
    setDeletingId(row.id);
    try {
      await apiClient.delete(`/api/inventory/job-work/${row.id}/`);
      toast.success('Job work order deleted');
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
    { key: 'vendor', label: 'Vendor', type: 'text', placeholder: 'Search vendor...' },
    { key: 'warehouse_name', label: 'Warehouse', type: 'select', options: optsFrom('warehouse_name') },
    { key: 'template_name', label: 'Template', type: 'select', options: optsFrom('template_name') },
    { key: 'status', label: 'Status', type: 'select', options: optsFrom('status') },
    { key: 'date_from', label: 'Date From', type: 'date' },
  ];

  const columns = [
    { key: 'order_no', label: 'JW Order No', sortable: true, render: (v) => v || '-' },
    { key: 'vendor_name', label: 'Vendor', sortable: true, render: (v) => v || '-' },
    { key: 'warehouse_name', label: 'Warehouse', sortable: true, render: (v) => v || '-' },
    { key: 'template_name', label: 'Template', sortable: true, render: (v) => v || '-' },
    {
      key: 'start_date',
      label: 'Issue Date',
      sortable: true,
      render: (value) => value ? formatDate(value) : '-',
    },
    {
      key: 'expected_completion_date',
      label: 'Expected Return',
      sortable: true,
      render: (value) => value ? formatDate(value) : '-',
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
      render: (_, row) => {
        const isDraft = row.status === 'DRAFT';
        return (
          <div className="flex items-center gap-1">
            {/* Approve/Issue and the whole receive lifecycle live on the detail
                page now — no inline Approve here, so stock is only moved from
                the order screen where the operator can review it first. */}
            <button
              onClick={(e) => { e.stopPropagation(); navigate(`/inventory/job-work/${row.id}`); }}
              className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
              aria-label={isDraft ? 'Edit' : 'View'}
              title={isDraft ? 'Edit' : 'View'}
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
        );
      },
    },
  ];

  // Drop columns the user is not allowed to see. Never strip the
  // actions column or the primary JW Order No link column.
  const keyFor = (c) => c.key.replace(/_(name|code|display)$/, '');
  const visibleColumns = columns.filter(
    (c) => c.key === 'order_no' || c.key === 'actions' || !isHidden(keyFor(c))
  );

  const filteredData = (data || []).filter((row) => {
    if (filterValues.vendor) {
      const vendorSearch = filterValues.vendor.toLowerCase();
      if (!(row.vendor_name || '').toLowerCase().includes(vendorSearch)) return false;
    }
    if (!matchesSelect(row.warehouse_name, filterValues.warehouse_name)) return false;
    if (!matchesSelect(row.template_name, filterValues.template_name)) return false;
    if (!matchesSelect(row.status, filterValues.status)) return false;
    if (filterValues.date_from && row.start_date < filterValues.date_from) {
      return false;
    }
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Job Work Orders"
        subtitle="Manage job work orders with vendors"
        breadcrumbs={[
          { label: 'Inventory', href: '/inventory' },
          { label: 'Job Work Orders' },
        ]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreate('Job Work Order') ? { createLink: '/inventory/job-work/new', createLabel: 'New Job Work Order' } : {}),
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
        <DataTable persistKey="inventory-job-work"
          exportFileName="job-work-orders"
          canExport={canExport('Job Work Order')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/inventory/job-work/${row.id}`)}
        />
      </ListState>
    </MainLayout>
  );
}
