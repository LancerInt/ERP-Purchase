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

export default function QCLabJobList() {
  const navigate = useNavigate();
  const { canCreate, canExport } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/quality/lab-jobs/');
  const [showFilters, setShowFilters] = useState(false);
  // Filters live in the URL so Back / refresh / sharing restore the filtered view.
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    analyst: '', status: '', result: '', date_from: '',
  });

  // Real column filters (the DataTable already ships an always-visible search
  // bar, so a "Search" filter here was just a duplicate). Name options are
  // derived from the loaded rows so they always match what's actually present.
  const optsFrom = (key) => [...new Set((data || []).map((r) => r[key]).filter(Boolean))]
    .sort().map((v) => ({ value: v, label: v }));
  const filters = [
    { key: 'analyst', label: 'Analyst', type: 'select', options: optsFrom('analyst') },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'Pending', label: 'Pending' },
        { value: 'In Progress', label: 'In Progress' },
        { value: 'Completed', label: 'Completed' },
      ],
    },
    {
      key: 'result',
      label: 'Result',
      type: 'select',
      options: [
        { value: 'Pass', label: 'Pass' },
        { value: 'Fail', label: 'Fail' },
        { value: 'Conditional', label: 'Conditional' },
      ],
    },
    { key: 'date_from', label: 'Date From', type: 'date' },
  ];

  const columns = [
    { key: 'lab_job_id', label: 'Lab Job ID', sortable: true },
    { key: 'qc_request', label: 'QC Request', sortable: true },
    { key: 'analyst', label: 'Analyst', sortable: true },
    {
      key: 'sample_received_date',
      label: 'Sample Received',
      sortable: true,
      render: (value) => value ? formatDate(value) : '-',
    },
    {
      key: 'status',
      label: 'Status',
      render: (value) => <StatusBadge status={value} />,
    },
    {
      key: 'result',
      label: 'Result',
      render: (value) => {
        if (!value) return <span className="text-slate-400">--</span>;
        return <StatusBadge status={value} />;
      },
    },
    {
      key: 'actions',
      label: '',
      sortable: false,
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/quality/lab-jobs/${row.id}`); }}
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
    if (!matchesSelect(row.analyst, filterValues.analyst)) return false;
    if (!matchesSelect(row.status, filterValues.status)) return false;
    if (!matchesSelect(row.result, filterValues.result)) return false;
    if (filterValues.date_from && row.sample_received_date < filterValues.date_from) return false;
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="QC Lab Jobs"
        subtitle="Track laboratory testing and analysis jobs"
        breadcrumbs={[{ label: 'Quality', href: '/quality' }, { label: 'Lab Jobs' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreate('Lab Job') ? { createLink: '/quality/lab-jobs/new', createLabel: 'New Lab Job' } : {}),
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
        <DataTable persistKey="quality-lab-jobs"
          exportFileName="qc-lab-jobs"
          canExport={canExport('QC Lab Job')}
          columns={columns}
          data={filteredData}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/quality/lab-jobs/${row.id}`)}
        />
      </ListState>
    </MainLayout>
  );
}
