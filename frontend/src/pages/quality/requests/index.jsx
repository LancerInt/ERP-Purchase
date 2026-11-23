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

export default function QCRequestList() {
  const { canExport } = usePermissions();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useApiData('/api/quality/requests/');
  const [sortBy, setSortBy] = useState('createdDate');
  const [sortOrder, setSortOrder] = useState('desc');
  const [searchTerm, setSearchTerm] = useState('');
  // Status filter lives in the URL so Back / refresh / sharing restore it.
  const [statusFilter, setStatusFilter] = useUrlState('status', '');
  const [page, setPage] = useUrlPage([searchTerm, statusFilter]);

  const columns = [
    {
      field: 'qcNumber',
      header: 'QC Number',
      sortable: true,
      width: '130px',
    },
    {
      field: 'product',
      header: 'Product',
      sortable: true,
      width: '220px',
    },
    {
      field: 'referenceDoc',
      header: 'Reference',
      sortable: true,
      width: '130px',
    },
    {
      field: 'quantity',
      header: 'Quantity',
      sortable: true,
      width: '100px',
    },
    {
      field: 'status',
      header: 'Status',
      sortable: true,
      width: '130px',
      render: (value) => <StatusBadge status={value} />,
    },
    {
      field: 'result',
      header: 'Result',
      sortable: true,
      width: '100px',
      render: (value) => {
        if (!value) return '-';
        return <StatusBadge status={value} label={value} />;
      },
    },
    {
      field: 'actions',
      header: '',
      sortable: false,
      width: '60px',
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/quality/requests/${row.id}`); }}
          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
          aria-label="Edit"
          title="Edit"
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
        { value: 'PENDING', label: 'Pending' },
        { value: 'IN_PROGRESS', label: 'In Progress' },
        { value: 'COMPLETED', label: 'Completed' },
      ],
    },
  ];

  const filteredData = (data || []).filter((item) => {
    const matchesSearch =
      item.qcNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.product.toLowerCase().includes(searchTerm.toLowerCase());
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
    { label: 'Quality', href: '#' },
    { label: 'Requests' },
  ];

  return (
    <MainLayout breadcrumbs={breadcrumbs}>
      <div className="space-y-4 sm:space-y-6">
        <PageHeader
          title="QC Requests"
          subtitle="Monitor quality checks and test results"
          actions={{ createLink: '/quality/requests/new', createLabel: 'New QC' }}
        />

        <ListState error={error} onRetry={refetch}>
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
            <DataTable
              exportFileName="qc-requests"
              canExport={canExport('QC Request')}
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
              searchPlaceholder="Search by QC number or product..."
              filters={filterOptions}
              onFilterChange={handleFilterChange}
              onRowClick={(row) => navigate(`/quality/requests/${row.id}`)}
            />
          </div>
        </ListState>
      </div>
    </MainLayout>
  );
}
