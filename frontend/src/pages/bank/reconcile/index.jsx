import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { matchesSelect } from '../../../components/common/FilterPanel';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ListState from '@/components/common/ListState.jsx';
import { Pencil, Trash2 } from 'lucide-react';
import { confirm } from '@/components/common/confirm';
import useApiData from '../../../hooks/useApiData.js';
import useUrlPage from '../../../hooks/useUrlPage.js';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import apiClient from '../../../utils/api.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { formatDate } from '@/utils/formatters';

export default function ReconcileStatementList() {
  const { canCreate, canDelete, canExport } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/finance/bank-statements/');
  const navigate = useNavigate();
  const [sortBy, setSortBy] = useState('statement_period_start');
  const [sortOrder, setSortOrder] = useState('desc');
  const [searchTerm, setSearchTerm] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  // Column filters + period live in the URL so Back / refresh / sharing restore
  // the filtered view.
  const [sp, setSp] = useSearchParams();
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    bank_account_name: '', parsing_status: '',
  });
  const [page, setPage] = useUrlPage([searchTerm, filterValues]);
  const period = usePeriodFilter(sp.get('period') || 'all', {
    anchor: sp.get('anchor'), customFrom: sp.get('cfrom'), customTo: sp.get('cto'),
  });

  // Write the active period back to the URL (replace — a filter change isn't a
  // new history entry; only opening a statement is). The column filters are
  // already URL-backed via useUrlFilters above.
  useEffect(() => {
    const p = new URLSearchParams(sp);
    const put = (k, val, keep) => { if (keep) p.set(k, val); else p.delete(k); };
    const np = period.navProps;
    put('period', np.period, np.period && np.period !== 'all');
    put('anchor', np.anchor, np.period !== 'all' && np.period !== 'custom');
    put('cfrom', np.customFrom, np.period === 'custom');
    put('cto', np.customTo, np.period === 'custom');
    if (p.toString() !== sp.toString()) setSp(p, { replace: true });
  }, [period.navProps, sp, setSp]);

  const handleDelete = async (id) => {
    if (!(await confirm({
      message: 'Delete this bank statement upload? This will also remove its parsed lines and match results.',
      isDangerous: true,
      confirmLabel: 'Delete',
    }))) return;
    try {
      await apiClient.delete(`/api/finance/bank-statements/${id}/`);
      toast.success('Statement upload deleted');
      refetch();
    } catch (err) {
      toast.error('Failed to delete statement upload');
    }
  };

  const columns = [
    { field: 'bank_account_name', header: 'Bank Account', sortable: true, width: '200px' },
    {
      field: 'statement_period_start',
      header: 'Period Start',
      sortable: true,
      width: '120px',
      render: (value) => formatDate(value),
    },
    {
      field: 'statement_period_end',
      header: 'Period End',
      sortable: true,
      width: '120px',
      render: (value) => formatDate(value),
    },
    { field: 'total_lines', header: 'Total Lines', sortable: true, width: '100px' },
    {
      field: 'matched_count',
      header: 'Matched',
      sortable: true,
      width: '100px',
      render: (value) => <span className="text-green-600 font-medium">{value}</span>,
    },
    {
      field: 'unmatched_count',
      header: 'Unmatched',
      sortable: true,
      width: '110px',
      render: (value) => <span className={`font-medium ${value > 0 ? 'text-red-600' : 'text-slate-500'}`}>{value}</span>,
    },
    {
      field: 'parsing_status',
      header: 'Status',
      sortable: true,
      width: '120px',
      render: (value) => <StatusBadge status={value} />,
    },
    {
      field: 'actions',
      header: '',
      sortable: false,
      width: canDelete('Reconcile Statement') ? '90px' : '60px',
      render: (_, row) => (
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); navigate(`/bank/reconcile/${row.id}`); }}
            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition"
            title="View reconciliation"
            aria-label="View reconciliation"
          >
            <Pencil size={15} />
          </button>
          {canDelete('Reconcile Statement') && (
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(row.id); }}
              className="p-1.5 text-red-600 hover:bg-red-50 rounded transition"
              title="Delete"
              aria-label="Delete"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ),
    },
  ];

  // Options for the structured column filters are derived from the loaded
  // rows so they always match what's actually present. The free-text
  // "Search" filter here was a duplicate of the table's built-in search bar.
  const optsFrom = (key) => [...new Set((data || []).map((r) => r[key]).filter(Boolean))]
    .sort().map((v) => ({ value: v, label: v }));

  const filterConfig = [
    { key: 'bank_account_name', label: 'Bank Account', type: 'select', options: optsFrom('bank_account_name') },
    {
      key: 'parsing_status',
      label: 'Parsing Status',
      type: 'select',
      options: [
        { value: 'PENDING', label: 'Pending' },
        { value: 'PARSED', label: 'Parsed' },
        { value: 'ERROR', label: 'Error' },
      ],
    },
  ];

  const filteredData = (data || []).filter((item) => {
    const matchesSearch =
      !searchTerm ||
      (item.bank_account_name || '').toLowerCase().includes(searchTerm.toLowerCase());
    const matchesBankAccount = matchesSelect(item.bank_account_name, filterValues.bank_account_name);
    const matchesStatus = matchesSelect(item.parsing_status, filterValues.parsing_status);
    // Each row is itself a date RANGE (a whole statement period), not a single
    // date — matched against the period filter's window by overlap, so e.g.
    // picking "FY 2025-26" surfaces any statement that touches that year at
    // all, not just one whose start date happens to fall inside it.
    const matchesPeriod = !period.range || (
      (!period.range.to || item.statement_period_start <= period.range.to)
      && (!period.range.from || item.statement_period_end >= period.range.from)
    );
    return matchesSearch && matchesBankAccount && matchesStatus && matchesPeriod;
  });

  const handleSort = (field, order) => {
    setSortBy(field);
    setSortOrder(order);
  };

  const breadcrumbs = [
    { label: 'Bank', href: '/bank/dashboard' },
    { label: 'Reconcile Statement' },
  ];

  return (
    <MainLayout>
      <div className="space-y-4 sm:space-y-5">
        <PageHeader
          title="Reconcile Statement"
          subtitle="Upload a real bank statement and reconcile it against Tally"
          breadcrumbs={breadcrumbs}
          actions={{
            onFilter: () => setShowFilters(!showFilters),
            ...(canCreate('Reconcile Statement') ? { createLink: '/bank/reconcile/new', createLabel: 'Upload Statement' } : {}),
          }}
        />

        <PeriodNavigator allowAll {...period.navProps} />

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
              exportFileName="bank-statements"
              canExport={canExport('Reconcile Statement')}
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
              searchPlaceholder="Search by bank account..."
              onRowClick={(row) => navigate(`/bank/reconcile/${row.id}`)}
              emptyMessage="No bank statement uploads found"
            />
          </div>
        </ListState>
      </div>
    </MainLayout>
  );
}
