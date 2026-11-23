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
import { formatDate, formatCurrency } from '@/utils/formatters';

export default function PettyCashList() {
  const { canCreate, canExport } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/finance/petty-cash/');
  const navigate = useNavigate();
  const [sortBy, setSortBy] = useState('register_id');
  const [sortOrder, setSortOrder] = useState('asc');
  const [searchTerm, setSearchTerm] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  // Filters live in the URL so Back / refresh / sharing restore the filtered view.
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    warehouse: '', custodian: '', status: '',
  });
  const [page, setPage] = useUrlPage([searchTerm, filterValues]);

  const columns = [
    { field: 'register_id', header: 'Register ID', sortable: true, width: '110px' },
    { field: 'warehouse', header: 'Warehouse', sortable: true, width: '160px' },
    { field: 'custodian', header: 'Custodian', sortable: true, width: '160px' },
    {
      field: 'opening_balance',
      header: 'Opening Balance',
      sortable: true,
      width: '140px',
      render: (value) => formatCurrency(value),
    },
    {
      field: 'current_balance',
      header: 'Current Balance',
      sortable: true,
      width: '140px',
      render: (value) => (
        <span className={`font-medium ${value <= 5000 ? 'text-red-600' : 'text-slate-900'}`}>
          {formatCurrency(value)}
        </span>
      ),
    },
    {
      field: 'last_replenished',
      header: 'Last Replenished',
      sortable: true,
      width: '140px',
      render: (value) => formatDate(value),
    },
    {
      field: 'status',
      header: 'Status',
      sortable: true,
      width: '110px',
      render: (value) => <StatusBadge status={value} />,
    },
    {
      field: 'actions',
      header: '',
      sortable: false,
      width: '60px',
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/finance/petty-cash/${row.id}`); }}
          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
          title="Edit"
          aria-label="Edit"
        >
          <Pencil size={15} />
        </button>
      ),
    },
  ];

  // Options for the structured column filters are derived from the loaded
  // rows so they always match what's actually present. The free-text
  // "Search" filter here was a duplicate of the table's built-in search bar.
  const optsFrom = (key) => [...new Set((data || []).map((r) => r[key]).filter(Boolean))]
    .sort().map((v) => ({ value: v, label: v }));

  const filterConfig = [
    { key: 'warehouse', label: 'Warehouse', type: 'select', options: optsFrom('warehouse') },
    { key: 'custodian', label: 'Custodian', type: 'select', options: optsFrom('custodian') },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'Active', label: 'Active' },
        { value: 'Closed', label: 'Closed' },
      ],
    },
  ];

  const filteredData = (data || []).filter((item) => {
    const matchesSearch =
      !searchTerm ||
      item.custodian.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.warehouse.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.register_id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesWarehouse = matchesSelect(item.warehouse, filterValues.warehouse);
    const matchesCustodian = matchesSelect(item.custodian, filterValues.custodian);
    const matchesStatus = matchesSelect(item.status, filterValues.status);
    return matchesSearch && matchesWarehouse && matchesCustodian && matchesStatus;
  });

  const handleSort = (field, order) => {
    setSortBy(field);
    setSortOrder(order);
  };

  const breadcrumbs = [
    { label: 'Finance', href: '/finance' },
    { label: 'Petty Cash Register' },
  ];

  return (
    <MainLayout>
      <div className="space-y-4 sm:space-y-5">
        <PageHeader
          title="Petty Cash Register"
          subtitle="Manage petty cash registers across warehouses"
          breadcrumbs={breadcrumbs}
          actions={{
            onFilter: () => setShowFilters(!showFilters),
            ...(canCreate('Petty Cash') ? { createLink: '/finance/petty-cash/new', createLabel: 'New Register' } : {}),
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
              exportFileName="petty-cash"
              canExport={canExport('Petty Cash')}
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
              searchPlaceholder="Search by custodian or warehouse..."
              onRowClick={(row) => navigate(`/finance/petty-cash/${row.id}`)}
              emptyMessage="No petty cash registers found"
            />
          </div>
        </ListState>
      </div>
    </MainLayout>
  );
}
