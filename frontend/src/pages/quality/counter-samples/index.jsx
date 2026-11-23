import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { matchesSelect } from '../../../components/common/FilterPanel';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ListState from '@/components/common/ListState.jsx';
import { Pencil, RefreshCw } from 'lucide-react';
import { formatDate } from '@/utils/formatters';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { useUrlFilters } from '../../../hooks/useUrlState.js';

export default function CounterSampleList() {
  const navigate = useNavigate();
  const { canCreate, canExport } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/quality/counter-samples/');
  const [showFilters, setShowFilters] = useState(false);
  // Filters live in the URL so Back / refresh / sharing restore the filtered view.
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    product: '', storage_location: '', disposal_status: '', date_from: '',
  });

  // Real column filters (the DataTable already ships an always-visible search
  // bar, so a "Search" filter here was just a duplicate). Name options are
  // derived from the loaded rows so they always match what's actually present.
  const optsFrom = (key) => [...new Set((data || []).map((r) => r[key]).filter(Boolean))]
    .sort().map((v) => ({ value: v, label: v }));
  const filters = [
    { key: 'product', label: 'Product', type: 'select', options: optsFrom('product') },
    { key: 'storage_location', label: 'Storage Location', type: 'select', options: optsFrom('storage_location') },
    { key: 'disposal_status', label: 'Disposal Status', type: 'select',
      options: [{ value: 'Retained', label: 'Retained' }, { value: 'Disposed', label: 'Disposed' }] },
    { key: 'date_from', label: 'Date From', type: 'date' },
  ];

  const columns = [
    { key: 'sample_id', label: 'Sample ID', sortable: true },
    { key: 'qc_request', label: 'QC Request', sortable: true },
    { key: 'product', label: 'Product', sortable: true },
    { key: 'batch', label: 'Batch', sortable: true },
    { key: 'storage_location', label: 'Storage Location', sortable: true },
    {
      key: 'expected_return_date',
      label: 'Expected Return',
      sortable: true,
      render: (value) => value ? formatDate(value) : '-',
    },
    {
      key: 'disposal_date',
      label: 'Disposal Date',
      sortable: true,
      render: (value) =>
        value ? (
          formatDate(value)
        ) : (
          <StatusBadge status="Retained" />
        ),
    },
    {
      key: 'actions',
      label: '',
      sortable: false,
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/quality/counter-samples/${row.id}`); }}
          className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
          aria-label="Edit"
          title="Edit"
        >
          <Pencil size={15} />
        </button>
      ),
    },
  ];

  const filteredData = (data || []).filter((row) => {
    if (!matchesSelect(row.product, filterValues.product)) return false;
    if (!matchesSelect(row.storage_location, filterValues.storage_location)) return false;
    if (!matchesSelect(row.disposal_date ? 'Disposed' : 'Retained', filterValues.disposal_status)) return false;
    if (filterValues.date_from && row.expected_return_date < filterValues.date_from) return false;
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="Counter Sample Register"
        subtitle="Track retained counter samples and disposal"
        breadcrumbs={[{ label: 'Quality', href: '/quality' }, { label: 'Counter Samples' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreate('Counter Sample') ? { createLink: '/quality/counter-samples/new', createLabel: 'New Counter Sample' } : {}),
        }}
      />
      {showFilters && (
        <FilterPanel
          filters={filters}
          values={filterValues}
          onChange={(key, value) => setFilterValue(key, value)}
          onReset={clearFilters}
          onClose={() => setShowFilters(false)}
        />
      )}
      <ListState error={error} onRetry={refetch}>
        <DataTable persistKey="quality-counter-samples"
          exportFileName="counter-samples"
          canExport={canExport('Counter Sample')}
          columns={columns}
          data={filteredData}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/quality/counter-samples/${row.id}`)}
        />
      </ListState>
    </MainLayout>
  );
}
