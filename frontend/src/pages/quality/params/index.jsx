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
import usePermissions from '../../../hooks/usePermissions.js';
import { useUrlFilters } from '../../../hooks/useUrlState.js';

export default function QCParameterList() {
  const navigate = useNavigate();
  const { canCreate, canExport } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/quality/params/');
  const [showFilters, setShowFilters] = useState(false);
  // Filters live in the URL so Back / refresh / sharing restore the filtered view.
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    critical_flag: '', test_method: '', applicable_template: '', status: '',
  });

  // Real column filters (the DataTable already ships an always-visible search
  // bar, so a "Search" filter here was just a duplicate). Name options are
  // derived from the loaded rows so they always match what's actually present.
  const optsFrom = (key) => [...new Set((data || []).map((r) => r[key]).filter(Boolean))]
    .sort().map((v) => ({ value: v, label: v }));
  const filters = [
    {
      key: 'critical_flag',
      label: 'Critical',
      type: 'select',
      options: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' },
      ],
    },
    { key: 'test_method', label: 'Test Method', type: 'select', options: optsFrom('test_method') },
    { key: 'applicable_template', label: 'Applicable Template', type: 'select', options: optsFrom('applicable_template') },
    {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { value: 'Active', label: 'Active' },
        { value: 'Inactive', label: 'Inactive' },
      ],
    },
  ];

  const columns = [
    { key: 'parameter_code', label: 'Parameter Code', sortable: true },
    { key: 'parameter_name', label: 'Parameter Name', sortable: true },
    { key: 'test_method', label: 'Test Method', sortable: true },
    {
      key: 'critical_flag',
      label: 'Critical',
      render: (value) => (
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
            value === 'Yes'
              ? 'bg-red-100 text-red-800'
              : 'bg-slate-100 text-slate-600'
          }`}
        >
          {value}
        </span>
      ),
    },
    { key: 'applicable_template', label: 'Applicable Template', sortable: true },
    {
      key: 'is_active',
      label: 'Status',
      render: (value, row) => <StatusBadge status={value === false ? 'Inactive' : (value === true ? 'Active' : value)} />,
    },
    {
      key: 'actions',
      label: '',
      sortable: false,
      render: (_, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/quality/params/${row.id}`); }}
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
    if (!matchesSelect(row.critical_flag, filterValues.critical_flag)) return false;
    if (!matchesSelect(row.test_method, filterValues.test_method)) return false;
    if (!matchesSelect(row.applicable_template, filterValues.applicable_template)) return false;
    if (!matchesSelect(row.is_active ? 'Active' : 'Inactive', filterValues.status)) return false;
    return true;
  });

  return (
    <MainLayout>
      <PageHeader
        title="QC Parameter Library"
        subtitle="Manage quality control parameters and test methods"
        breadcrumbs={[{ label: 'Quality', href: '/quality' }, { label: 'Parameters' }]}
        actions={{
          onFilter: () => setShowFilters(!showFilters),
          ...(canCreate('QC Parameter') ? { createLink: '/quality/params/new', createLabel: 'New Parameter' } : {}),
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
        <DataTable persistKey="quality-params"
          exportFileName="qc-parameters"
          canExport={canExport('QC Parameter')}
          columns={columns}
          data={filteredData}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/quality/params/${row.id}`)}
        />
      </ListState>
    </MainLayout>
  );
}
