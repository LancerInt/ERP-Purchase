import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { CheckCircle } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ListState from '@/components/common/ListState.jsx';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';

const fmtQty = (v) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const loc = (wh, gd) => [wh, gd].filter(Boolean).join(' / ') || '-';

/**
 * Stock Movement Requests — the report of every request raised from the Stock
 * Movement Request page. A request is raised (Pending), approved here, then
 * pulled into the Stock Transfer page (fields auto-fill) to execute.
 */
export default function StockMovementList() {
  const navigate = useNavigate();
  const { canCreate, can } = usePermissions();
  const canApprove = can('Stock Movement Request', 'approve');
  const { data, isLoading, error, refetch } = useApiData('/api/inventory/movement-requests/');
  const [approvingId, setApprovingId] = useState(null);

  const handleApprove = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Approve ${row.request_no}? It can then be pulled into a ${row.movement_type === 'TRANSFER' ? 'Stock Transfer' : 'Shifting'}.` }))) return;
    setApprovingId(row.id);
    try {
      await apiClient.post(`/api/inventory/movement-requests/${row.id}/approve/`);
      toast.success(`${row.request_no} approved`);
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setApprovingId(null);
    }
  };

  const columns = [
    {
      key: 'request_no', label: 'Request No', sortable: true,
      render: (v, row) => (
        <button onClick={(e) => { e.stopPropagation(); navigate(`/inventory/stock-movement/${row.id}`); }} className="text-blue-700 hover:underline font-medium text-xs">{v || '-'}</button>
      ),
    },
    {
      key: 'movement_type', label: 'Type', sortable: true,
      render: (v, row) => (
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${
          v === 'TRANSFER' ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'bg-amber-50 text-amber-700 border-amber-200'
        }`}>{row.movement_type_display || v}</span>
      ),
    },
    { key: 'request_date', label: 'Date', sortable: true, render: (v) => v ? formatDate(v) : '-' },
    { key: 'from_warehouse_name', label: 'From', sortable: true, render: (v, row) => loc(v, row.from_godown_name) },
    { key: 'to_warehouse_name', label: 'To', sortable: true, render: (v, row) => loc(v, row.to_godown_name) },
    { key: 'total_qty', label: 'Total Qty', sortable: true, render: (v) => fmtQty(v) },
    { key: 'status', label: 'Status', sortable: true, render: (v, row) => <StatusBadge status={row.status_display || v} /> },
    {
      key: 'actions', label: '', sortable: false,
      render: (_, row) => (
        canApprove && (row.status === 'DRAFT' || row.status === 'PENDING_APPROVAL') ? (
          <button
            onClick={(e) => handleApprove(e, row)}
            disabled={approvingId === row.id}
            className="inline-flex items-center gap-1 px-2.5 py-1 bg-green-600 text-white text-xs font-medium rounded-lg hover:bg-green-700 transition disabled:opacity-50"
          >
            <CheckCircle size={13} /> {approvingId === row.id ? 'Approving…' : 'Approve'}
          </button>
        ) : null
      ),
    },
  ];

  return (
    <MainLayout>
      <PageHeader
        title="Movement Requests"
        subtitle="Raised by warehouse team, approved here, then pulled into a Stock Transfer / Shifting"
        breadcrumbs={[{ label: 'Inventory', path: '/inventory' }, { label: 'Movement Requests' }]}
        actions={{
          ...(canCreate('Stock Movement Request')
            ? { createLink: '/inventory/stock-movement/new', createLabel: 'New Movement Request' }
            : {}),
        }}
      />
      <ListState error={error} onRetry={refetch}>
        <DataTable
          persistKey="stock-movement-requests"
          exportFileName="stock-movement-requests"
          columns={columns}
          data={data || []}
          isLoading={isLoading}
          searchPlaceholder="Search by request no, type, from, to, status…"
          emptyMessage="No stock movement requests yet"
          onRowClick={(row) => navigate(`/inventory/stock-movement/${row.id}`)}
        />
      </ListState>
    </MainLayout>
  );
}
