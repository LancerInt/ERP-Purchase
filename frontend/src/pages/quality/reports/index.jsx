import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { matchesSelect } from '../../../components/common/FilterPanel';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ListState from '@/components/common/ListState.jsx';
import { Pencil } from 'lucide-react';
import { formatDate } from '@/utils/formatters';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { useUrlFilters } from '../../../hooks/useUrlState.js';

export default function QCFinalReportList() {
  const navigate = useNavigate();
  const { canCreate, canExport } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/quality/reports/');
  const [showFilters, setShowFilters] = useState(false);
  // Filters live in the URL so Back / refresh / sharing restore the filtered view.
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    product: '', overall_result: '', approved_by: '', date_from: '',
  });

  // Real column filters (the DataTable already ships an always-visible search
  // bar, so a "Search" filter here was just a duplicate). Name options are
  // derived from the loaded rows so they always match what's actually present.
  const optsFrom = (key) => [...new Set((data || []).map((r) => r[key]).filter(Boolean))]
    .sort().map((v) => ({ value: v, label: v }));
  const filters = [
    { key: 'product', label: 'Product', type: 'select', options: optsFrom('product') },
    {
      key: 'overall_result',
      label: 'Overall Result',
      type: 'select',
      options: [
        { value: 'Approved', label: 'Approved' },
        { value: 'Rejected', label: 'Rejected' },
        { value: 'Conditional', label: 'Conditional' },
      ],
    },
    { key: 'approved_by', label: 'Approved By', type: 'select', options: optsFrom('approved_by') },
    { key: 'date_from', label: 'Date From', type: 'date' },
  ];

  const columns = [
    { key: 'report_id', label: 'Report ID', sortable: true },
    { key: 'qc_request', label: 'QC Request', sortable: true },
    { key: 'product', label: 'Product', sortable: true },
    { key: 'batch', label: 'Batch', sortable: true },
    {
      key: 'overall_result',
      label: 'Overall Result',
      render: (value) => <StatusBadge status={value} />,
    },
    {
      key: 'prepared_date',
      label: 'Prepared Date',
      sortable: true,
      render: (value) => value ? formatDate(value) : '-',
    },
    {
      key: 'approved_by',
      label: 'Approved By',
      sortable: true,
      render: (value) => value || <span className="text-slate-400">--</span>,
    },
    {
      key: 'actions',
      label: '',
      sortable: false,
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/quality/reports/${row.id}`); }}
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
    if (!matchesSelect(row.overall_result, filterValues.overall_result)) return false;
    if (!matchesSelect(row.approved_by, filterValues.approved_by)) return false;
    if (filterValues.date_from && row.prepared_date < filterValues.date_from) return false;
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="QC Final Reports"
        subtitle="View and manage quality control final reports"
        breadcrumbs={[{ label: 'Quality', href: '/quality' }, { label: 'Final Reports' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreate('QC Report') ? { createLink: '/quality/reports/new', createLabel: 'New Report' } : {}),
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
        <DataTable persistKey="quality-reports"
          exportFileName="qc-reports"
          canExport={canExport('QC Report')}
          columns={columns}
          data={filteredData}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/quality/reports/${row.id}`)}
        />
      </ListState>
    </MainLayout>
  );
}
