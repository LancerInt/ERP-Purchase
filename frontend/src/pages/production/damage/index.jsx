import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Check, Eye, RefreshCw } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import { formatDate } from '../../../utils/formatters.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useApiData from '../../../hooks/useApiData.js';
import { confirm } from '@/components/common/confirm';

export default function ProductionDamageList() {
  const navigate = useNavigate();
  const { canCreate, canApprove, canExport } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/production/damages/');

  const handleApprove = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Approve ${row.document_no}? The damaged quantities will be deducted from inventory.` }))) return;
    try {
      await apiClient.post(`/api/production/damages/${row.id}/approve/`);
      toast.success('Approved — stock deducted.');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    }
  };

  const columns = [
    {
      key: 'document_no', label: 'Document No', sortable: true,
      render: (v, row) => (
        <button onClick={(e) => { e.stopPropagation(); navigate(`/production/damage/${row.id}`); }}
          className="text-primary-600 hover:text-primary-800 hover:underline font-medium">{v || '-'}</button>
      ),
    },
    { key: 'damage_date', label: 'Date', sortable: true, render: (v) => (v ? formatDate(v) : '-') },
    { key: 'warehouse_name', label: 'Warehouse', sortable: true, render: (v) => v || '-' },
    { key: 'item_count', label: 'Items', render: (v) => v ?? 0 },
    { key: 'status', label: 'Status', render: (v, row) => <StatusBadge status={row.status_display || v} /> },
    {
      key: 'actions', label: '', sortable: false,
      render: (_, row) => (
        <div className="flex items-center gap-1">
          {canApprove('Production Damage') && (row.status === 'DRAFT' || row.status === 'PENDING_APPROVAL') && (
            <button onClick={(e) => handleApprove(e, row)} className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded transition" title="Approve (deducts stock)">
              <Check size={15} />
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); navigate(`/production/damage/${row.id}`); }} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition" title="View">
            <Eye size={15} />
          </button>
        </div>
      ),
    },
  ];

  return (
    <MainLayout>
      <PageHeader
        title="Production Damage"
        subtitle="Record products damaged during production / packing — approval deducts the quantities from inventory"
        breadcrumbs={[{ label: 'Production' }, { label: 'Damage' }]}
        actions={{
          ...(canCreate('Production Damage')
            ? { createLink: '/production/damage/new', createLabel: 'New Damage Entry' }
            : {}),
        }}
      />
      {error && !isLoading ? (
        <div className="text-center py-8">
          <p className="text-red-500 mb-3">Failed to load damage entries.</p>
          <button onClick={refetch} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700">
            <RefreshCw size={15} /> Retry
          </button>
        </div>
      ) : (
        <DataTable persistKey="production-damage"
          columns={columns}
          data={data || []}
          isLoading={isLoading}
          canExport={canExport('Production Damage')}
          exportFileName="production-damage"
          onRowClick={(row) => navigate(`/production/damage/${row.id}`)}
        />
      )}
    </MainLayout>
  );
}
