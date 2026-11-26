import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ListState from '@/components/common/ListState.jsx';
import { Eye, CheckCircle2, XCircle } from 'lucide-react';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { formatDate } from '@/utils/formatters';

export default function StockDeclarationList() {
  const navigate = useNavigate();
  const { isAdmin, isSuperuser } = usePermissions();
  const [statusFilter, setStatusFilter] = useState('ALL');

  const endpoint = statusFilter === 'ALL'
    ? '/api/inventory/stock-declarations/'
    : `/api/inventory/stock-declarations/?status=${statusFilter}`;
  const { data, isLoading, error, refetch } = useApiData(endpoint);

  const columns = [
    {
      key: 'product_name',
      label: 'Product',
      sortable: true,
      render: (val, row) => (
        <div>
          <div className="font-medium">{val}</div>
          {row.is_new_product && (
            <span className="text-[10px] px-1.5 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-full">New Product</span>
          )}
          {row.product_sku && (
            <span className="text-xs text-slate-400 ml-1">{row.product_sku}</span>
          )}
        </div>
      ),
    },
    {
      key: 'specification',
      label: 'Specification',
      sortable: false,
      render: (val) => val ? <span className="text-xs text-slate-500 line-clamp-2">{val}</span> : '-',
    },
    {
      key: 'quantity',
      label: 'Qty',
      sortable: true,
      render: (val, row) => `${Number(val).toLocaleString()} ${row.uom}`,
    },
    {
      key: 'warehouse_name',
      label: 'Warehouse',
      sortable: true,
      render: (val) => val || '-',
    },
    {
      key: 'godown_name',
      label: 'Godown',
      sortable: true,
      render: (val) => val || '-',
    },
    {
      key: 'created_by_name',
      label: 'Declared By',
      sortable: true,
    },
    {
      key: 'created_at',
      label: 'Date',
      sortable: true,
      render: (val) => val ? formatDate(val) : '-',
    },
    {
      key: 'approval_status',
      label: 'Status',
      sortable: true,
      render: (val) => <StatusBadge status={val} />,
    },
    {
      key: 'actions',
      label: '',
      sortable: false,
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/inventory/stock-declarations/${row.id}`); }}
          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
          title="View"
        >
          <Eye size={15} />
        </button>
      ),
    },
  ];

  const statusTabs = [
    { key: 'ALL', label: 'All' },
    { key: 'PENDING', label: 'Pending' },
    { key: 'APPROVED', label: 'Approved' },
    { key: 'REJECTED', label: 'Rejected' },
  ];

  return (
    <MainLayout>
      <PageHeader
        title="Stock Declarations"
        subtitle="Factory opening stock declarations"
        hideCompanyFilter
        breadcrumbs={[
          { label: 'Inventory', href: '/inventory' },
          { label: 'Stock Declarations' },
        ]}
        actions={{
          createLink: '/inventory/stock-declarations/new',
          createLabel: 'New Declaration',
        }}
      />

      <div className="flex gap-1 mb-4 px-1">
        {statusTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setStatusFilter(t.key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition ${
              statusFilter === t.key
                ? 'bg-primary-600 text-white border-primary-600'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <ListState error={error} onRetry={refetch}>
        <DataTable
          persistKey="inventory-stock-declarations"
          columns={columns}
          data={data || []}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/inventory/stock-declarations/${row.id}`)}
        />
      </ListState>
    </MainLayout>
  );
}
