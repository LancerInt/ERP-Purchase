import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import { Pencil, Trash2, Eye, RefreshCw } from 'lucide-react';
import MobileListCards from '../components/MobileListCards';
import toast from 'react-hot-toast';
import apiClient from '../../../utils/api.js';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import UnifiedFilterPanel, { useUnifiedFilter } from '../components/UnifiedFilterPanel';
import { confirm } from '@/components/common/confirm';
import ListState from '@/components/common/ListState.jsx';
import { formatDate, formatCurrency } from '@/utils/formatters';

const FILTER_FIELDS = [
  { value: 'advice_no', label: 'Payment/Bill No', type: 'text' },
  { value: 'vendor_name', label: 'Vendor', type: 'text' },
  { value: 'receipt_advice_no', label: 'Receipt Advice No', type: 'text' },
  { value: 'invoice_date', label: 'Invoice Date', type: 'date' },
  { value: 'due_date', label: 'Due Date', type: 'date' },
  { value: 'status', label: 'Status', type: 'select', options: [
    { value: 'DRAFT', label: 'Draft' }, { value: 'PENDING', label: 'Pending' },
    { value: 'APPROVED', label: 'Approved' }, { value: 'PARTIALLY_PAID', label: 'Partially Paid' },
    { value: 'PAID', label: 'Paid' }, { value: 'ON_HOLD', label: 'On Hold' },
  ]},
];

export default function VendorPaymentAdviceList() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useApiData('/api/purchase/payments/');
  const { canCreate, canEdit, canDelete, canExport } = usePermissions();
  const [showFilters, setShowFilters] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const filter = useUnifiedFilter(FILTER_FIELDS);

  const handleDelete = async (e, row) => {
    e.stopPropagation();
    if (!(await confirm({ message: `Are you sure you want to delete ${row.advice_no}? This action cannot be undone.`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/purchase/payments/${row.id}/`);
      toast.success(`${row.advice_no} deleted successfully`);
      refetch();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Failed to delete');
    }
  };

  const columns = [
    { key: 'advice_no', label: 'Payment/Bill No', sortable: true },
    { key: 'vendor_name', label: 'Vendor Name', sortable: true },
    { key: 'receipt_advice_no', label: 'Receipt Advice No', sortable: true, render: (value, row) => row.receipt_advice ? (
      <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/receipts/${row.receipt_advice}`); }} className="text-primary-600 hover:text-primary-800 hover:underline font-medium">{value || '-'}</button>
    ) : (value || '-') },
    {
      key: 'invoice_date', label: 'Invoice Date', sortable: true,
      render: (value) => value ? formatDate(value) : '-',
    },
    {
      key: 'amount', label: 'Total Amount', sortable: true,
      render: (value) => value ? formatCurrency(value) : '-',
    },
    {
      key: 'paid_amount', label: 'Paid Amount', sortable: true,
      render: (value) => value ? formatCurrency(value) : '\u20B90.00',
    },
    {
      key: 'balance_amount', label: 'Balance', sortable: true,
      render: (value) => {
        const bal = Number(value) || 0;
        return (
          <span className={bal > 0 ? 'text-red-600 font-medium' : 'text-green-600 font-medium'}>
            {'\u20B9'}{bal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </span>
        );
      },
    },
    {
      key: 'status_display', label: 'Status',
      render: (value, row) => <StatusBadge status={value || row.status} />,
    },
    {
      key: 'due_date', label: 'Due Date', sortable: true,
      render: (value) => value ? formatDate(value) : '-',
    },
    {
      key: 'actions', label: '', sortable: false,
      render: (_, row) => (
        <div className="flex items-center gap-1">
          {canEdit('Payment Made') && row.status === 'DRAFT' && (
            <button onClick={(e) => { e.stopPropagation(); navigate(`/purchase/payments/${row.id}`); }} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition" title="Edit">
              <Pencil size={15} />
            </button>
          )}
          {canDelete('Payment Made') && row.status === 'DRAFT' && (
            <button onClick={(e) => handleDelete(e, row)} className="p-1.5 text-red-500 hover:bg-red-50 rounded transition" title="Delete">
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ),
    },
  ];

  const filteredData = (() => {
    let result = filter.filterData(data || []);
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      result = result.filter(row =>
        Object.values(row).some(v => v != null && typeof v !== 'object' && String(v).toLowerCase().includes(s))
      );
    }
    return result;
  })();

  return (
    <MainLayout>
      <PageHeader
        title="Vendor Payment Advice"
        subtitle="Manage vendor bills and payment schedules"
        breadcrumbs={[{ label: 'Vendor Payment Advice' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreate('Payment Made') ? { createLink: '/purchase/payments/new', createLabel: 'New Payment Advice' } : {}),
        }}
      />
      <UnifiedFilterPanel filterFields={FILTER_FIELDS} filter={filter} showFilters={showFilters} onClose={() => setShowFilters(false)} />
      <ListState error={error} onRetry={refetch}>
        <MobileListCards
          rows={filteredData}
          isLoading={isLoading}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          searchPlaceholder="Search advice no, vendor…"
          emptyMessage="No payment advices found"
          config={{
            title: (row) => row.advice_no,
            subtitle: (row) => row.vendor_name,
            badge: (row) => ({ label: row.status_display || row.status || '-', cls: 'bg-slate-100 text-slate-700 border-slate-200' }),
            fields: (row) => [
              { label: 'Date',   value: row.advice_date ? formatDate(row.advice_date) : null },
              { label: 'Amount', value: row.amount ? formatCurrency(row.amount) : null, cls: 'font-medium' },
            ],
            actions: (row) => [
              { icon: Eye, label: 'View', cls: 'text-blue-700 hover:bg-blue-50', onClick: () => navigate(`/purchase/payments/${row.id}`) },
            ],
          }}
          onRowClick={(row) => navigate(`/purchase/payments/${row.id}`)}
        />
        <div className="hidden sm:block">
          <DataTable persistKey="purchase-payments" exportFileName="payment-advices" canExport={canExport('Payment Made')} columns={columns} data={filteredData} isLoading={isLoading} onRowClick={(row) => navigate(`/purchase/payments/${row.id}`)} />
        </div>
      </ListState>
    </MainLayout>
  );
}
