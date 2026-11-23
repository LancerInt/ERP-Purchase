import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { matchesSelect } from '../../../components/common/FilterPanel';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import { Pencil, CheckCircle2, Trash2, RefreshCw } from 'lucide-react';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';
import ListState from '@/components/common/ListState.jsx';

export default function WarehouseShiftingList() {
  const { canCreate, can, canExport } = usePermissions();
  const { isHidden } = useFieldPermissions('Shifting');
  const { data, isLoading, error, refetch } = useApiData('/api/inventory/shifting/');
  const navigate = useNavigate();
  const [showFilters, setShowFilters] = useState(false);
  // Filters live in the URL so Back / refresh / sharing restore the filtered view.
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    warehouse_name: '', from_godown_name: '', to_godown_name: '', status: '', date_from: '',
  });
  const canApprove = can('Shifting', 'approve') || can('Shifting', 'edit');
  const canDelete = can('Shifting', 'delete');
  const [deletingId, setDeletingId] = useState(null);

  const handleApprove = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Approve ${row.shifting_no}? This will move stock between godowns.`, isDangerous: true }))) return;
    try {
      await apiClient.post(`/api/inventory/shifting/${row.id}/approve/`);
      toast.success(`${row.shifting_no} approved`);
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    }
  };

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    const isPosted = row.status === 'APPROVED' || row.status === 'COMPLETED';
    const warning = isPosted
      ? `\n\nWarning: ${row.shifting_no} has already moved stock between godowns. Deleting will also reverse those ledger entries.`
      : '';
    if (!(await confirm({ message: `Delete shifting ${row.shifting_no}?${warning}`, isDangerous: true }))) return;
    setDeletingId(row.id);
    try {
      await apiClient.delete(`/api/inventory/shifting/${row.id}/`);
      toast.success(`${row.shifting_no} deleted`);
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setDeletingId(null);
    }
  };

  // The list already has an always-visible search bar (DataTable's built-in
  // search across every column), so a "Search" filter here was just a
  // duplicate. Real column filters instead — name options are derived from
  // the loaded rows so they always match what's actually present.
  const optsFrom = (key) => [...new Set((data || []).map((r) => r[key]).filter(Boolean))]
    .sort().map((v) => ({ value: v, label: v }));
  const filters = [
    { key: 'warehouse_name', label: 'Warehouse', type: 'select', options: optsFrom('warehouse_name') },
    { key: 'from_godown_name', label: 'From Godown', type: 'select', options: optsFrom('from_godown_name') },
    { key: 'to_godown_name', label: 'To Godown', type: 'select', options: optsFrom('to_godown_name') },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'DRAFT', label: 'Draft' },
        { value: 'PENDING_APPROVAL', label: 'Pending Approval' },
        { value: 'APPROVED', label: 'Approved' },
        { value: 'COMPLETED', label: 'Completed' },
      ],
    },
    { key: 'date_from', label: 'Date From', type: 'date' },
  ];

  const columns = [
    { key: 'shifting_no', label: 'Shifting No', sortable: true },
    { key: 'warehouse_name', label: 'Warehouse', sortable: true, render: (v) => v || '-' },
    { key: 'from_godown_name', label: 'From Godown', sortable: true, render: (v) => v || '-' },
    { key: 'to_godown_name', label: 'To Godown', sortable: true, render: (v) => v || '-' },
    {
      key: 'request_date',
      label: 'Request Date',
      sortable: true,
      render: (value) => value ? formatDate(value) : '-',
    },
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
      render: (_, row) => {
        const isDraft = row.status === 'DRAFT' || row.status === 'PENDING_APPROVAL';
        return (
          <div className="flex items-center gap-1">
            {isDraft && canApprove && (
              <button
                onClick={(e) => handleApprove(e, row)}
                className="inline-flex items-center gap-1 px-2.5 py-1 bg-emerald-600 text-white text-xs font-medium rounded hover:bg-emerald-700 transition"
                title="Approve shifting"
              >
                <CheckCircle2 size={13} /> Approve
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); navigate(`/inventory/shifting/${row.id}`); }}
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
  // actions column or the primary Shifting No link column.
  const keyFor = (c) => c.key.replace(/_(name|code|display)$/, '');
  const visibleColumns = columns.filter(
    (c) => c.key === 'shifting_no' || c.key === 'actions' || !isHidden(keyFor(c))
  );

  const filteredData = (data || []).filter((row) => {
    if (!matchesSelect(row.warehouse_name, filterValues.warehouse_name)) return false;
    if (!matchesSelect(row.from_godown_name, filterValues.from_godown_name)) return false;
    if (!matchesSelect(row.to_godown_name, filterValues.to_godown_name)) return false;
    if (!matchesSelect(row.status, filterValues.status)) return false;
    if (filterValues.date_from && row.request_date < filterValues.date_from) {
      return false;
    }
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Warehouse Shifting"
        subtitle="Manage intra-warehouse godown shifting"
        breadcrumbs={[
          { label: 'Inventory', href: '/inventory' },
          { label: 'Warehouse Shifting' },
        ]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreate('Shifting') ? { createLink: '/inventory/shifting/new', createLabel: 'New Shifting' } : {}),
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
        <DataTable persistKey="inventory-shifting"
          exportFileName="warehouse-shifting"
          canExport={canExport('Shifting')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/inventory/shifting/${row.id}`)}
        />
      </ListState>
    </MainLayout>
  );
}
