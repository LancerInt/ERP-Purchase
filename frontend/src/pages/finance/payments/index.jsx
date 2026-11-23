import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Pencil, RefreshCw } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ListState from '@/components/common/ListState.jsx';
import useApiData from '../../../hooks/useApiData.js';
import useUrlPage from '../../../hooks/useUrlPage.js';
import { useUrlState } from '../../../hooks/useUrlState.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { formatDate, formatCurrency } from '@/utils/formatters';

export default function PaymentsList() {
  const { canExport } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/finance/payments/');
  const navigate = useNavigate();
  const [sortBy, setSortBy] = useState('createdDate');
  const [sortOrder, setSortOrder] = useState('desc');
  const [searchTerm, setSearchTerm] = useState('');
  // Status filter lives in the URL so Back / refresh / sharing restore it.
  const [statusFilter, setStatusFilter] = useUrlState('status', '');
  const [page, setPage] = useUrlPage([searchTerm, statusFilter]);

  const columns = [
    {
      field: 'paymentNumber',
      header: 'Payment Number',
      sortable: true,
      width: '140px',
    },
    {
      field: 'vendor',
      header: 'Vendor',
      sortable: true,
      width: '220px',
    },
    {
      field: 'amount',
      header: 'Amount',
      sortable: true,
      width: '140px',
      render: (value) => formatCurrency(value),
    },
    {
      field: 'approvalLevel',
      header: 'Approvals',
      sortable: true,
      width: '100px',
      render: (value) => (
        <div className="flex gap-1">
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={i}
              className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                i < value ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-700'
              }`}
            >
              {i + 1}
            </div>
          ))}
        </div>
      ),
    },
    {
      field: 'status',
      header: 'Status',
      sortable: true,
      width: '150px',
      render: (value) => <StatusBadge status={value} />,
    },
    {
      field: 'dueDate',
      header: 'Due Date',
      sortable: true,
      width: '120px',
      render: (value) => formatDate(value),
    },
    {
      field: 'actions',
      header: '',
      sortable: false,
      width: '60px',
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/finance/payments/${row.id}`); }}
          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
          title="Edit"
          aria-label="Edit"
        >
          <Pencil size={15} />
        </button>
      ),
    },
  ];

  const filterOptions = [
    {
      key: 'status',
      label: 'Status',
      options: [
        { value: 'PENDING_APPROVAL', label: 'Pending Approval' },
        { value: 'APPROVED', label: 'Approved' },
        { value: 'PROCESSED', label: 'Processed' },
        { value: 'REJECTED', label: 'Rejected' },
      ],
    },
  ];

  const filteredData = (data || []).filter((item) => {
    const matchesSearch =
      item.paymentNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.vendor.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = !statusFilter || item.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const handleSort = (field, order) => {
    setSortBy(field);
    setSortOrder(order);
  };

  const handleFilterChange = (filters) => {
    setStatusFilter(filters.status || '');
  };

  const breadcrumbs = [
    { label: 'Finance', href: '#' },
    { label: 'Payments' },
  ];

  return (
    <MainLayout breadcrumbs={breadcrumbs}>
      <div className="space-y-4 sm:space-y-6">
        <PageHeader
          title="Payment Advice"
          subtitle="Process vendor payments with 2-step approval"
          actions={{ createLink: '/finance/payments/new', createLabel: 'New Payment' }}
        />

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4">
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
            <p className="text-xs sm:text-sm text-slate-600 font-medium">Pending Approval</p>
            <p className="text-xl sm:text-3xl font-bold text-slate-900 mt-1 sm:mt-2">
              {(data || []).filter((p) => p.status === 'PENDING_APPROVAL').length}
            </p>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
            <p className="text-xs sm:text-sm text-slate-600 font-medium">Approved</p>
            <p className="text-xl sm:text-3xl font-bold text-slate-900 mt-1 sm:mt-2">
              {(data || []).filter((p) => p.status === 'APPROVED').length}
            </p>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-6">
            <p className="text-xs sm:text-sm text-slate-600 font-medium">Total Amount</p>
            <p className="text-xl sm:text-3xl font-bold text-slate-900 mt-1 sm:mt-2">
              {formatCurrency((data || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0))}
            </p>
          </div>
        </div>

        <ListState error={error} onRetry={refetch}>
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
            <DataTable
              exportFileName="payment-workflow"
              canExport={canExport('Payment Advice')}
              columns={columns}
              data={filteredData}
              isLoading={isLoading}
              page={page}
              pageSize={10}
              totalRecords={filteredData.length}
              onPageChange={setPage}
              onSort={handleSort}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSearch={setSearchTerm}
              searchPlaceholder="Search by payment number or vendor..."
              filters={filterOptions}
              onFilterChange={handleFilterChange}
              onRowClick={(row) => navigate(`/finance/payments/${row.id}`)}
            />
          </div>
        </ListState>
      </div>
    </MainLayout>
  );
}
