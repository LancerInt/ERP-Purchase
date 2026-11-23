import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Pencil, Trash2 } from 'lucide-react';

import MainLayout from '../../../../components/layout/MainLayout';
import PageHeader from '../../../../components/common/PageHeader';
import DataTable from '../../../../components/common/DataTable';
import StatusBadge from '../../../../components/common/StatusBadge';
import ListState from '../../../../components/common/ListState.jsx';
import useApiData from '../../../../hooks/useApiData.js';
import usePermissions from '../../../../hooks/usePermissions.js';
import { formatDate } from '../../../../utils/formatters.js';
import apiClient from '../../../../utils/api.js';
import { getApiErrorMessage } from '../../../../utils/formHelpers.js';
import { confirm } from '../../../../components/common/confirm';

/**
 * Manufacturing Batches — list view.
 *
 * Phase 1 vertical slice: pure list + create-button. Row click navigates
 * to the batch detail page (also stubbed in Phase 1 — real kernel/SLE/LLE
 * entry comes in the next slice).
 */
export default function ManufacturingBatchList() {
  const navigate = useNavigate();
  const { canCreate, canEdit, canDelete } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/production/manufacturing-batches/');

  const handleDelete = async (row) => {
    if (!(await confirm({
      title: `Delete ${row.batch_no}?`,
      message: 'Deletion is only allowed for empty batches (no kernel / SLE / LLE data yet). '
             + 'If this batch has data, cancel it instead.',
      confirmLabel: 'Delete',
      danger: true,
    }))) return;
    try {
      await apiClient.delete(`/api/production/manufacturing-batches/${row.id}/`);
      toast.success(`${row.batch_no} deleted.`);
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete batch.');
    }
  };

  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState('created_on');
  const [sortOrder, setSortOrder] = useState('desc');
  const [searchTerm, setSearchTerm] = useState('');

  const columns = [
    {
      field: 'batch_no',
      header: 'Batch No',
      sortable: true,
      width: '180px',
      render: (v, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/production/extraction/manufacturing-batches/${row.id}`); }}
          className="text-blue-700 hover:underline font-medium font-mono text-xs"
        >{v}</button>
      ),
    },
    {
      field: 'warehouse_name',
      header: 'Warehouse',
      sortable: true,
      width: '160px',
      render: (v) => v || '-',
    },
    {
      field: 'created_on',
      header: 'Batch Date',
      sortable: true,
      width: '130px',
      render: (v) => v ? formatDate(v) : '-',
    },
    {
      field: 'actual_gross_kernel_kg',
      header: 'Kernel (kg)',
      sortable: true,
      width: '150px',
      // Show actual as-run kernel weight. Falls back to planned if the
      // Kernel Input hasn't been entered yet. A small "planned" tag hints
      // at the source so operators know which they're looking at.
      render: (v, row) => {
        const actual = v;
        const planned = row.planned_kernel_qty_kg;
        if (actual) return <span title="Actual (from Kernel Input)">{Number(actual).toLocaleString()}</span>;
        if (planned) return <span className="text-slate-500" title="Planned (not yet entered)">{Number(planned).toLocaleString()} <span className="text-xs">(planned)</span></span>;
        return '-';
      },
    },
    {
      field: 'actual_sle_wash_count',
      header: 'SLE Washes',
      width: '120px',
      render: (v, row) => {
        const actual = v ?? 0;
        const planned = row.planned_wash_count;
        if (actual > 0) return <span title="Actual (saved rows)">{actual}</span>;
        if (planned) return <span className="text-slate-500" title="Planned (none saved yet)">{planned} <span className="text-xs">(planned)</span></span>;
        return '-';
      },
    },
    {
      field: 'planned_route_display',
      header: 'Planned Route',
      width: '150px',
      render: (v) => v || '-',
    },
    {
      field: 'status_display',
      header: 'Status',
      sortable: true,
      width: '130px',
      render: (v, row) => <StatusBadge status={row.status_display || row.status} />,
    },
    {
      field: '_actions',
      header: 'Actions',
      width: '110px',
      render: (_, row) => (
        <div className="flex items-center gap-1">
          {canEdit('Manufacturing Batch') && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/production/extraction/manufacturing-batches/${row.id}/edit`);
              }}
              className="p-1.5 text-slate-500 hover:text-primary-700 hover:bg-primary-50 rounded"
              title="Edit batch header"
            >
              <Pencil size={14} />
            </button>
          )}
          {canDelete('Manufacturing Batch') && (
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(row); }}
              className="p-1.5 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded"
              title="Delete (only if empty)"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      ),
    },
  ];

  const rows = Array.isArray(data) ? data : (data?.results || []);

  return (
    <MainLayout>
      <PageHeader
        title="Manufacturing Batches"
        subtitle="Azadirachtin extraction batches — kernel input, SLE, LLE, transfers, FFE, ATFE"
        breadcrumbs={[
          { label: 'Production', path: '/production/work-orders' },
          { label: 'Extraction' },
          { label: 'Manufacturing Batches' },
        ]}
        actions={canCreate('Manufacturing Batch')
          ? { createLink: '/production/extraction/manufacturing-batches/new', createLabel: 'New Batch' }
          : {}}
      />

      <ListState isLoading={isLoading} error={error} isEmpty={!isLoading && rows.length === 0}
                 emptyTitle="No batches yet"
                 emptyMessage="Create your first Azadirachtin manufacturing batch to get started."
                 onRetry={refetch}>
        <DataTable
          columns={columns}
          data={rows}
          page={page}
          setPage={setPage}
          sortBy={sortBy}
          sortOrder={sortOrder}
          onSort={(field) => {
            if (sortBy === field) {
              setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
            } else {
              setSortBy(field);
              setSortOrder('asc');
            }
          }}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
        />
      </ListState>
    </MainLayout>
  );
}
