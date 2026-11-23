import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { matchesSelect } from '../../../components/common/FilterPanel';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ListState from '@/components/common/ListState.jsx';
import { Pencil, RefreshCw } from 'lucide-react';
import useApiData from '../../../hooks/useApiData.js';
import useUrlPage from '../../../hooks/useUrlPage.js';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { formatCurrency } from '@/utils/formatters';

export default function GSTReconciliationReport() {
  const { canCreate, canExport } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/finance/gst-reconciliation/');
  const navigate = useNavigate();
  const [sortBy, setSortBy] = useState('period');
  const [sortOrder, setSortOrder] = useState('desc');
  const [searchTerm, setSearchTerm] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  // Filters live in the URL so Back / refresh / sharing restore the filtered view.
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    data_source: '', period_from: '', period_to: '',
  });
  const [page, setPage] = useUrlPage([searchTerm, filterValues]);

  const columns = [
    { field: 'period', header: 'Period', sortable: true, width: '100px' },
    { field: 'data_source', header: 'Data Source', sortable: true, width: '120px' },
    {
      field: 'total_taxable',
      header: 'Total Taxable',
      sortable: true,
      width: '140px',
      render: (value) => formatCurrency(value),
    },
    {
      field: 'cgst',
      header: 'CGST',
      sortable: true,
      width: '120px',
      render: (value) => formatCurrency(value),
    },
    {
      field: 'sgst',
      header: 'SGST',
      sortable: true,
      width: '120px',
      render: (value) => formatCurrency(value),
    },
    {
      field: 'igst',
      header: 'IGST',
      sortable: true,
      width: '120px',
      render: (value) => formatCurrency(value),
    },
    {
      field: 'total_tax',
      header: 'Total Tax',
      sortable: true,
      width: '130px',
      render: (value) => <span className="font-semibold">{formatCurrency(value)}</span>,
    },
    {
      field: 'status',
      header: 'Status',
      sortable: true,
      width: '130px',
      render: (value) => <StatusBadge status={value} />,
    },
    {
      field: 'actions',
      header: '',
      sortable: false,
      width: '60px',
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/finance/gst/${row.id}`); }}
          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
          title="Edit"
          aria-label="Edit"
        >
          <Pencil size={15} />
        </button>
      ),
    },
  ];

  const filterConfig = [
    {
      key: 'data_source',
      label: 'Data Source',
      type: 'select',
      options: [
        { value: 'Books', label: 'Books' },
        { value: 'GSTR-2A', label: 'GSTR-2A' },
        { value: 'GSTR-1', label: 'GSTR-1' },
      ],
    },
    { key: 'period_from', label: 'Period From', type: 'date' },
    { key: 'period_to', label: 'Period To', type: 'date' },
  ];

  const filteredData = (data || []).filter((item) => {
    const matchesSearch =
      !searchTerm ||
      item.period.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.data_source.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesDataSource = matchesSelect(item.data_source, filterValues.data_source);
    const matchesPeriodFrom = !filterValues.period_from || item.period >= filterValues.period_from.substring(0, 7);
    const matchesPeriodTo = !filterValues.period_to || item.period <= filterValues.period_to.substring(0, 7);
    return matchesSearch && matchesDataSource && matchesPeriodFrom && matchesPeriodTo;
  });

  const handleSort = (field, order) => {
    setSortBy(field);
    setSortOrder(order);
  };

  const breadcrumbs = [
    { label: 'Finance', href: '/finance' },
    { label: 'GST Reconciliation' },
  ];

  return (
    <MainLayout>
      <div className="space-y-4 sm:space-y-5">
        <PageHeader
          title="GST Reconciliation Report"
          subtitle="Compare Books vs GSTR-2A / GSTR-1 data for GST reconciliation"
          breadcrumbs={breadcrumbs}
          actions={{
            onFilter: () => setShowFilters(!showFilters),
            ...(canCreate('GST Reconciliation') ? { createLink: '/finance/gst/new', createLabel: 'New Reconciliation' } : {}),
          }}
        />

        {showFilters && (
          <FilterPanel
            filters={filterConfig}
            values={filterValues}
            onChange={setFilterValue}
            onReset={clearFilters}
            onClose={() => setShowFilters(false)}
          />
        )}

        <ListState error={error} onRetry={refetch}>
          <div className="bg-white rounded-lg border border-slate-200 p-3 sm:p-4">
            <DataTable
              exportFileName="gst-reconciliation"
              canExport={canExport('GST Report')}
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
              searchPlaceholder="Search by period or data source..."
              onRowClick={(row) => navigate(`/finance/gst/${row.id}`)}
              emptyMessage="No GST reconciliation records found"
            />
          </div>
        </ListState>
      </div>
    </MainLayout>
  );
}
