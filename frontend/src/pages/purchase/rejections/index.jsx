import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import useFieldPermissions from '../../../hooks/useFieldPermissions.js';
import apiClient from '../../../utils/api.js';
import { Pencil, Trash2, Eye, RefreshCw } from 'lucide-react';
import MobileListCards from '../components/MobileListCards';
import ListState from '@/components/common/ListState.jsx';
import { confirm } from '@/components/common/confirm';
import { formatDate } from '@/utils/formatters';

const fmt = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const fmtDate = (d) => d ? formatDate(d) : '-';

export default function MaterialRejectionList() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useApiData('/api/purchase/rejections/');
  const { canCreate, canDelete, canExport } = usePermissions();
  const { isHidden } = useFieldPermissions('Material Rejection');

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Delete ${row.rejection_no}?`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/rejections/${row.id}/`);
      toast.success('Rejection deleted');
      refetch();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete');
    }
  };

  const columns = [
    { key: 'rejection_no', label: 'Rejection No', sortable: true, render: (v) => <span className="font-medium">{v}</span> },
    { key: 'receipt_no', label: 'Receipt / GRN', sortable: true, render: (v, row) => row.receipt_advice ? (
      <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/receipts/${row.receipt_advice}`); }} className="text-primary-600 hover:underline font-medium">{v}</button>
    ) : '-' },
    { key: 'po_no', label: 'PO No', sortable: true },
    { key: 'vendor_name', label: 'Vendor', sortable: true },
    { key: 'warehouse_name', label: 'Warehouse', sortable: true },
    { key: 'rejection_date', label: 'Date', sortable: true, render: (v) => fmtDate(v) },
    { key: 'total_rejected_value', label: 'Value', sortable: true, render: (v) => fmt(v) },
    { key: 'status_display', label: 'Status', sortable: true, render: (v, row) => <StatusBadge status={v || row.status} /> },
    { key: 'return_to_vendor', label: 'Return', render: (v) => v ? <span className="text-green-600 font-medium">Yes</span> : <span className="text-slate-400">No</span> },
    { key: 'actions', label: '', sortable: false, render: (_, row) => (
      <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
        <button onClick={() => navigate(`/purchase/rejections/${row.id}`)} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded" title="View"><Pencil size={15} /></button>
        {canDelete('Material Rejection') && row.status === 'DRAFT' && (
          <button onClick={(e) => handleDelete(e, row)} className="p-1.5 text-red-500 hover:bg-red-50 rounded" title="Delete"><Trash2 size={15} /></button>
        )}
      </div>
    )},
  ];

  // Map a column key to its catalog field key (by meaning), then filter hidden ones.
  // Never drop the primary identifier (rejection_no) or the actions column.
  const columnKeyMap = {
    receipt_no: 'receipt_advice',
    po_no: 'purchase_order',
    vendor_name: 'vendor',
    warehouse_name: 'warehouse',
    status_display: 'status',
  };
  const visibleColumns = columns.filter((col) => {
    if (col.key === 'rejection_no' || col.key === 'actions') return true;
    const catalogKey = columnKeyMap[col.key] || col.key;
    return !isHidden(catalogKey);
  });

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Material Rejections"
        subtitle="Manage material rejections against receipts"
        breadcrumbs={[{ label: 'Rejections' }]}
        actions={{
          ...(canCreate('Material Rejection') ? { createLink: '/purchase/rejections/new', createLabel: 'New Rejection' } : {}),
        }}
      />
      <ListState error={error} onRetry={refetch}>
      <MobileListCards
        rows={data || []}
        isLoading={isLoading}
        emptyMessage="No rejections found"
        config={{
          title: (row) => row.rejection_no || row.id,
          subtitle: (row) => row.vendor_name,
          badge: (row) => ({ label: row.status || '-', cls: 'bg-slate-100 text-slate-700 border-slate-200' }),
          fields: (row) => [
            { label: 'Date',     value: formatDate(row.rejection_date) },
            { label: 'Product',  value: row.product_name },
            { label: 'Qty',      value: row.quantity },
            { label: 'Reason',   value: row.reason },
          ],
          actions: (row) => [
            { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/purchase/rejections/${row.id}`) },
          ],
        }}
        onRowClick={(row) => navigate(`/purchase/rejections/${row.id}`)}
      />
      <div className="hidden sm:block">
        <DataTable persistKey="purchase-rejections"
          exportFileName="material-rejections"
          canExport={canExport('Material Rejection')}
          columns={visibleColumns}
          data={data || []}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/purchase/rejections/${row.id}`)}
        />
      </div>
      </ListState>
    </MainLayout>
  );
}
