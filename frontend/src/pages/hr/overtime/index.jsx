import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, Check, X as XIcon, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import FilterPanel, { applyAdvancedFilters, matchesSelect } from '../../../components/common/FilterPanel';
import ConfigureFields, { useConfigureFields } from '../../../components/common/ConfigureFields';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import ListState from '@/components/common/ListState.jsx';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { useUrlFilters, useUrlAdvancedRules } from '../../../hooks/useUrlState.js';
import { confirm } from '@/components/common/confirm';
import { formatCurrency, formatDate } from '@/utils/formatters';

const fmtDate = (v) =>
  v ? formatDate(v) : '-';
const fmtMoney = (v) => formatCurrency(v);

// Rate matrix. Until the backend stores an OT-rate per shift/staff,
// the UI derives the rate from the OT date — weekend (Sat/Sun) is
// 2x, weekday is 1.5x of a notional ₹100/hr base. Holiday detection
// would also live here once a Holiday model exists.
const OT_BASE_RATE = 100;
const OT_MULTIPLIERS = {
  REGULAR: 1.5,
  WEEKEND: 2.0,
  HOLIDAY: 2.5,
};
const OT_RATE_LABEL = {
  REGULAR: 'Regular (1.5×)',
  WEEKEND: 'Weekend (2×)',
  HOLIDAY: 'Holiday (2.5×)',
};
// Only these rate types actually occur: deriveRateType() classifies every row
// as REGULAR or WEEKEND (there is no Holiday calendar yet), so HOLIDAY above is
// display-only and must NOT be offered as a filter — it would match zero rows.
const OT_FILTERABLE_RATES = ['REGULAR', 'WEEKEND'];
const OT_RATE_COLOR = {
  REGULAR: 'bg-blue-100 text-blue-700',
  WEEKEND: 'bg-amber-100 text-amber-700',
  HOLIDAY: 'bg-rose-100 text-rose-700',
};

const deriveRateType = (isoDate) => {
  if (!isoDate) return 'REGULAR';
  const d = new Date(isoDate);
  const day = d.getDay();
  if (day === 0 || day === 6) return 'WEEKEND';
  return 'REGULAR';
};

const estimatePayout = (rateType, hoursWorked) => {
  const multiplier = OT_MULTIPLIERS[rateType] || 1.5;
  return Number(hoursWorked || 0) * OT_BASE_RATE * multiplier;
};

export default function OvertimeRequestList() {
  const navigate = useNavigate();
  const { canCreate, canApprove, canExport } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/hr/overtime/');
  const [showFilters, setShowFilters] = useState(false);
  // Domain filters live in the URL so Back / refresh / sharing restore them.
  // (Advanced rules stay local — they're a complex rule set, not a simple map.)
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    approval_status: '', rate_type: '', shift_name: '', date_from: '', date_to: '',
  });
  const { rules: advancedRules, logic: advancedLogic, setAdvanced } = useUrlAdvancedRules();

  // Enrich rows with derived rate_type and estimated_amount so columns
  // and filters/sorts work off the same fields. Pure compute, no API.
  const enrichedData = useMemo(() => {
    return (data || []).map(row => {
      const rateType = deriveRateType(row.date);
      return {
        ...row,
        rate_type: rateType,
        estimated_amount: estimatePayout(rateType, row.hours_worked),
      };
    });
  }, [data]);

  const handleApprove = async (row) => {
    if (!(await confirm({ message: `Approve overtime ${row.request_no} for ${row.staff_name} (${row.hours_worked} hrs)?` }))) return;
    try {
      await apiClient.post(`/api/hr/overtime/${row.id}/approve/`);
      toast.success('Overtime approved.');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to approve.');
    }
  };

  const handleReject = async (row) => {
    if (!(await confirm({ message: `Reject overtime ${row.request_no} for ${row.staff_name}?` }))) return;
    try {
      await apiClient.post(`/api/hr/overtime/${row.id}/reject/`);
      toast.success('Overtime rejected.');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to reject.');
    }
  };

  // Options for the Shift select are derived from the loaded rows. The
  // free-text "Search" filter here duplicated the table's built-in search
  // bar, so it's replaced with a real structured column filter.
  const optsFrom = (key) => [...new Set((data || []).map((r) => r[key]).filter(Boolean))]
    .sort().map((v) => ({ value: v, label: v }));

  const filters = [
    { key: 'approval_status', label: 'Approval', type: 'select', options: [
      { value: 'PENDING', label: 'Pending' },
      { value: 'APPROVED', label: 'Approved' },
      { value: 'REJECTED', label: 'Rejected' },
    ]},
    { key: 'rate_type', label: 'Rate Type', type: 'select',
      options: OT_FILTERABLE_RATES.map((value) => ({ value, label: OT_RATE_LABEL[value] })) },
    { key: 'shift_name', label: 'Shift', type: 'select', options: optsFrom('shift_name') },
    { key: 'date_from', label: 'Date From', type: 'date' },
    { key: 'date_to', label: 'Date To', type: 'date' },
  ];

  const filterColumns = [
    { field: 'request_no', header: 'Request No', type: 'text' },
    { field: 'staff_name', header: 'Staff', type: 'text' },
    { field: 'staff_id_display', header: 'Staff ID', type: 'text' },
    { field: 'date', header: 'Date', type: 'date' },
    { field: 'shift_name', header: 'Shift', type: 'text' },
    { field: 'hours_worked', header: 'Hours', type: 'number' },
    { field: 'rate_type', header: 'Rate Type', type: 'select',
      filterOptions: OT_FILTERABLE_RATES.map((value) => ({ value, label: OT_RATE_LABEL[value] })) },
    { field: 'estimated_amount', header: 'Estimated Amount', type: 'number' },
    { field: 'approval_status', header: 'Approval', type: 'select', filterOptions: [
      { value: 'PENDING', label: 'Pending' },
      { value: 'APPROVED', label: 'Approved' },
      { value: 'REJECTED', label: 'Rejected' },
    ]},
  ];

  const columns = [
    { field: 'request_no', header: 'Request No', sortable: true, width: '140px',
      render: (v, row) => (
        <button onClick={(e) => { e.stopPropagation(); navigate(`/hr/overtime/${row.id}`); }}
          className="text-blue-700 hover:underline font-mono font-medium text-xs">{v}</button>
      ),
    },
    { field: 'staff_name', header: 'Employee', sortable: true, width: '180px',
      render: (v, row) => (
        <div>
          <p className="font-medium text-slate-800">{v || '-'}</p>
          <p className="text-xs text-slate-400 font-mono">{row.staff_id_display}</p>
        </div>
      ),
    },
    { field: 'date', header: 'Date', sortable: true, width: '110px', render: (v) => fmtDate(v) },
    { field: 'shift_name', header: 'Shift', sortable: true, width: '130px',
      render: (v) => v || <span className="text-slate-400 text-xs">—</span> },
    { field: 'hours_worked', header: 'OT Hours', sortable: true, width: '90px',
      render: (v) => <span className="font-semibold text-violet-700">{Number(v || 0).toFixed(2)}</span> },
    { field: 'rate_type', header: 'Rate Type', sortable: true, width: '140px',
      render: (v) => (
        <span className={`px-2 py-1 rounded text-xs font-medium ${OT_RATE_COLOR[v] || 'bg-slate-100 text-slate-700'}`}>
          {OT_RATE_LABEL[v] || v}
        </span>
      ),
    },
    { field: 'estimated_amount', header: 'Estimated Amount', sortable: true, width: '140px',
      render: (v) => <span className="font-semibold text-emerald-700">{fmtMoney(v)}</span> },
    { field: 'task_description', header: 'Task', sortable: false, width: '220px',
      render: (v) => v ? <span className="text-xs text-slate-600 line-clamp-2">{v}</span> : '-' },
    { field: 'approval_status', header: 'Status', sortable: true, width: '110px',
      render: (v) => <StatusBadge status={v} /> },
    { field: 'approved_by_name', header: 'Approved By', sortable: true, width: '140px',
      render: (v) => v || '-' },
    { field: 'wage_integration_flag', header: 'In Payroll', sortable: true, width: '90px',
      render: (v) => v
        ? <span className="text-xs text-emerald-700 font-medium">✓ Yes</span>
        : <span className="text-xs text-slate-400">—</span> },
    { field: 'actions', header: '', sortable: false, width: '120px',
      render: (_, row) => (
        <div className="flex items-center gap-1">
          {canApprove('Overtime') && row.approval_status === 'PENDING' && (
            <>
              <button onClick={(e) => { e.stopPropagation(); handleApprove(row); }}
                className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded transition" title="Approve">
                <Check size={15} />
              </button>
              <button onClick={(e) => { e.stopPropagation(); handleReject(row); }}
                className="p-1.5 text-red-500 hover:bg-red-50 rounded transition" title="Reject">
                <XIcon size={15} />
              </button>
            </>
          )}
          <button onClick={(e) => { e.stopPropagation(); navigate(`/hr/overtime/${row.id}`); }}
            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition" title="View">
            <Pencil size={15} />
          </button>
        </div>
      ),
    },
  ];

  const {
    visibleColumns, mergedColumns,
    showConfig, setShowConfig, handleConfigApply, visibleFieldKeys,
  } = useConfigureFields(columns, 'hr_overtime_requests_fields', enrichedData);

  const filteredData = (() => {
    let result = enrichedData.filter((row) => {
      if (!matchesSelect(row.approval_status, filterValues.approval_status)) return false;
      if (!matchesSelect(row.rate_type, filterValues.rate_type)) return false;
      if (!matchesSelect(row.shift_name, filterValues.shift_name)) return false;
      if (filterValues.date_from && row.date && row.date < filterValues.date_from) return false;
      if (filterValues.date_to && row.date && row.date > filterValues.date_to) return false;
      return true;
    });
    if (advancedRules.length > 0) {
      result = applyAdvancedFilters(result, advancedRules, advancedLogic);
    }
    return result;
  })();

  const stats = (() => {
    const pending = enrichedData.filter(r => r.approval_status === 'PENDING');
    const approved = enrichedData.filter(r => r.approval_status === 'APPROVED');
    const rejected = enrichedData.filter(r => r.approval_status === 'REJECTED');
    const totalApprovedHrs = approved.reduce((s, r) => s + Number(r.hours_worked || 0), 0);
    const estimatedPayout = approved.reduce((s, r) => s + Number(r.estimated_amount || 0), 0);
    return {
      pending: pending.length,
      approvedHrs: totalApprovedHrs,
      rejected: rejected.length,
      estimatedPayout,
    };
  })();

  return (
    <MainLayout>
      <PageHeader
        title="Overtime"
        subtitle="Track overtime requests, approvals, payable hours, and payroll impact."
        breadcrumbs={[{ label: 'HR', href: '/hr' }, { label: 'Overtime' }]}
        actions={canCreate('Overtime') ? {
          createLink: '/hr/overtime/new',
          createLabel: 'Add Overtime',
        } : {}}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatTile label="Pending Overtime" value={stats.pending} tone="amber" />
        <StatTile label="Approved Hours" value={stats.approvedHrs.toFixed(2)} tone="emerald" />
        <StatTile label="Rejected Requests" value={stats.rejected} tone="red" />
        <StatTile label="Estimated Payout" value={fmtMoney(stats.estimatedPayout)} tone="violet" />
      </div>

      <div className="flex items-center justify-end gap-2 mb-3">
        <button onClick={() => setShowFilters(!showFilters)}
          className="px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-50">
          Filters
        </button>
        <button onClick={() => setShowConfig(true)}
          className="px-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-700 hover:bg-slate-50">
          Fields
        </button>
      </div>

      {showFilters && (
        <FilterPanel
          filters={filters}
          values={filterValues}
          onChange={(key, value) => setFilterValue(key, value)}
          onReset={() => { clearFilters(); setAdvanced([], 'AND'); }}
          onClose={() => setShowFilters(false)}
          columns={filterColumns}
          data={enrichedData}
          onAdvancedFilter={(rules, logic) => setAdvanced(rules, logic)}
          initialRules={advancedRules}
          initialLogic={advancedLogic}
        />
      )}

      <div className="mb-3 p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800">
        Rate type is derived from the day of the week (weekend = 2×, weekday = 1.5×) and Estimated
        Amount uses a notional ₹100/hr base. Add an OvertimeRate / SalaryStructure backend model to
        replace these heuristics with real per-staff rates.
      </div>

      <ListState error={error} onRetry={refetch}>
        <DataTable persistKey="hr-overtime"
          exportFileName="overtime-requests"
          canExport={canExport('Overtime')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/hr/overtime/${row.id}`)}
          emptyMessage="No overtime requests yet"
        />
      </ListState>
      {showConfig && (
        <ConfigureFields
          allColumns={mergedColumns}
          visibleFields={visibleFieldKeys}
          onApply={handleConfigApply}
          onClose={() => setShowConfig(false)}
          storageKey="hr_overtime_requests_fields"
        />
      )}
    </MainLayout>
  );
}

function StatTile({ label, value, tone }) {
  const toneMap = {
    slate: 'bg-slate-50 border-slate-200 text-slate-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    violet: 'bg-violet-50 border-violet-200 text-violet-700',
    red: 'bg-red-50 border-red-200 text-red-700',
  };
  return (
    <div className={`rounded-lg border px-4 py-3 ${toneMap[tone] || toneMap.slate}`}>
      <p className="text-xs font-medium opacity-80">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}
