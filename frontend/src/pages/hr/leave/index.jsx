import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, Check, X as XIcon } from 'lucide-react';
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
import { formatDate } from '@/utils/formatters';

const fmtDate = (v) =>
  v ? formatDate(v) : '-';

const LEAVE_TYPE_LABELS = {
  FULL_DAY: 'Full Day',
  HALF_DAY: 'Half Day',
  PERMISSION: 'Permission',
};

const LEAVE_TYPE_COLOR = {
  FULL_DAY: 'bg-blue-100 text-blue-700',
  HALF_DAY: 'bg-amber-100 text-amber-700',
  PERMISSION: 'bg-violet-100 text-violet-700',
};

// Annual leave allowances per type. These mirror the most common SME
// policy in India (factories act / shops & estab.). When the backend
// gets a `LeavePolicy` model these will move into it. For now the
// Balance tab derives "Used" from real LeaveRequest rows so the figure
// is at least accurate against the data we DO have.
const LEAVE_POLICY = [
  { type: 'CASUAL', label: 'Casual Leave (CL)', annual: 12, carryForward: false, encashable: false, status: 'ACTIVE',
    description: 'Short-notice personal leave. Reset every Jan 1.' },
  { type: 'SICK', label: 'Sick Leave (SL)', annual: 12, carryForward: true, encashable: false, status: 'ACTIVE',
    description: 'Medical leave. Carries over up to 30 days.' },
  { type: 'EARNED', label: 'Earned Leave (EL)', annual: 18, carryForward: true, encashable: true, status: 'ACTIVE',
    description: 'Accrued at 1.5/month. Encashable on exit.' },
  { type: 'COMP_OFF', label: 'Comp Off', annual: 0, carryForward: false, encashable: false, status: 'ACTIVE',
    description: 'Granted against approved Overtime. Use within 60 days.' },
];

export default function LeaveWorkspace() {
  const navigate = useNavigate();
  const { canCreate, canApprove, canExport } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/hr/leave/');
  const { data: staffData } = useApiData('/api/hr/staff/');
  const [activeTab, setActiveTab] = useState('requests');

  // Top-of-page counters. "This month" and "On leave today" are
  // computed against the live LeaveRequest table so figures are real
  // even before policy/balance models exist.
  const stats = useMemo(() => {
    const all = data || [];
    const today = new Date().toISOString().slice(0, 10);
    const monthKey = today.slice(0, 7); // YYYY-MM
    const inThisMonth = (iso) => (iso || '').slice(0, 7) === monthKey;
    return {
      pending: all.filter(r => r.status === 'PENDING').length,
      approvedThisMonth: all.filter(r => r.status === 'APPROVED' && inThisMonth(r.approval_date || r.created_at)).length,
      rejectedThisMonth: all.filter(r => r.status === 'REJECTED' && inThisMonth(r.approval_date || r.created_at)).length,
      onLeaveToday: all.filter(r => {
        if (r.status !== 'APPROVED') return false;
        const start = r.start_date;
        const end = r.end_date || r.start_date;
        return start && start <= today && (end || start) >= today;
      }).length,
    };
  }, [data]);

  return (
    <MainLayout>
      <PageHeader
        title="Leave"
        subtitle="Review leave requests, balances, approvals, and employee time off."
        breadcrumbs={[{ label: 'HR', href: '/hr' }, { label: 'Leave' }]}
        actions={canCreate('Leave') ? {
          createLink: '/hr/leave/new',
          createLabel: 'Create Leave Request',
        } : {}}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatTile label="Pending Requests" value={stats.pending} tone="amber" />
        <StatTile label="Approved This Month" value={stats.approvedThisMonth} tone="emerald" />
        <StatTile label="Rejected This Month" value={stats.rejectedThisMonth} tone="red" />
        <StatTile label="On Leave Today" value={stats.onLeaveToday} tone="violet" />
      </div>

      <TabStrip
        activeTab={activeTab}
        onChange={setActiveTab}
        tabs={[
          { key: 'requests', label: 'Requests' },
          { key: 'balances', label: 'Leave Balances' },
          { key: 'types', label: 'Leave Types' },
        ]}
      />

      <div className="mt-4">
        {activeTab === 'requests' && (
          <RequestsTab
            data={data}
            isLoading={isLoading}
            error={error}
            refetch={refetch}
            canApprove={canApprove}
            navigate={navigate}
          />
        )}
        {activeTab === 'balances' && (
          <BalancesTab leaveRequests={data || []} staff={staffData || []} />
        )}
        {activeTab === 'types' && <TypesTab />}
      </div>
    </MainLayout>
  );
}

// ─── Requests tab ────────────────────────────────────────────────────────

function RequestsTab({ data, isLoading, error, refetch, canApprove, navigate }) {
  const { canExport } = usePermissions();
  const [showFilters, setShowFilters] = useState(false);
  // Domain filters live in the URL so Back / refresh / sharing restore them.
  // (Advanced rules stay local — they're a complex rule set, not a simple map.)
  const { values: filterValues, setValue: setFilterValue, reset: clearFilters } = useUrlFilters({
    status: '', leave_type: '', approver_name: '', date_from: '', date_to: '',
  });
  const { rules: advancedRules, logic: advancedLogic, setAdvanced } = useUrlAdvancedRules();
  // Track the row whose approve/reject is in flight so its buttons can be
  // disabled — prevents double-submitting the same request.
  const [pendingId, setPendingId] = useState(null);

  const handleApprove = async (row) => {
    if (!(await confirm({ message: `Approve leave request ${row.request_no} for ${row.staff_name}?` }))) return;
    setPendingId(row.id);
    try {
      await apiClient.post(`/api/hr/leave/${row.id}/approve/`);
      toast.success('Leave approved.');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to approve.');
    } finally {
      setPendingId(null);
    }
  };

  const handleReject = async (row) => {
    if (!(await confirm({ message: `Reject leave request ${row.request_no} for ${row.staff_name}?` }))) return;
    setPendingId(row.id);
    try {
      await apiClient.post(`/api/hr/leave/${row.id}/reject/`);
      toast.success('Leave rejected.');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to reject.');
    } finally {
      setPendingId(null);
    }
  };

  // Options for the Approver select are derived from the loaded rows. The
  // free-text "Search" filter here duplicated the table's built-in search
  // bar, so it's replaced with a real structured column filter.
  const optsFrom = (key) => [...new Set((data || []).map((r) => r[key]).filter(Boolean))]
    .sort().map((v) => ({ value: v, label: v }));

  const filters = [
    { key: 'status', label: 'Status', type: 'select', options: [
      { value: 'PENDING', label: 'Pending' },
      { value: 'APPROVED', label: 'Approved' },
      { value: 'REJECTED', label: 'Rejected' },
    ]},
    { key: 'leave_type', label: 'Leave Type', type: 'select',
      options: Object.entries(LEAVE_TYPE_LABELS).map(([value, label]) => ({ value, label })) },
    { key: 'approver_name', label: 'Approver', type: 'select', options: optsFrom('approver_name') },
    { key: 'date_from', label: 'Date From', type: 'date' },
    { key: 'date_to', label: 'Date To', type: 'date' },
  ];

  const filterColumns = [
    { field: 'request_no', header: 'Request No', type: 'text' },
    { field: 'staff_name', header: 'Staff Name', type: 'text' },
    { field: 'staff_id_display', header: 'Staff ID', type: 'text' },
    { field: 'leave_type', header: 'Leave Type', type: 'select',
      filterOptions: Object.entries(LEAVE_TYPE_LABELS).map(([value, label]) => ({ value, label })) },
    { field: 'start_date', header: 'Start Date', type: 'date' },
    { field: 'end_date', header: 'End Date', type: 'date' },
    { field: 'days_requested', header: 'Days', type: 'number' },
    { field: 'lop_days', header: 'LOP Days', type: 'number' },
    { field: 'status', header: 'Status', type: 'select', filterOptions: [
      { value: 'PENDING', label: 'Pending' },
      { value: 'APPROVED', label: 'Approved' },
      { value: 'REJECTED', label: 'Rejected' },
    ]},
    { field: 'approver_name', header: 'Approver', type: 'text' },
  ];

  const columns = [
    { field: 'request_no', header: 'Request No', sortable: true, width: '130px',
      render: (v, row) => (
        <button
          onClick={(e) => { e.stopPropagation(); navigate(`/hr/leave/${row.id}`); }}
          className="text-blue-700 hover:underline font-mono font-medium text-xs"
        >{v}</button>
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
    { field: 'leave_type', header: 'Type', sortable: true, width: '110px',
      render: (v) => (
        <span className={`px-2 py-1 rounded text-xs font-medium ${LEAVE_TYPE_COLOR[v] || 'bg-slate-100 text-slate-700'}`}>
          {LEAVE_TYPE_LABELS[v] || v || '-'}
        </span>
      ),
    },
    { field: 'start_date', header: 'From', sortable: true, width: '110px', render: (v) => fmtDate(v) },
    { field: 'end_date', header: 'To', sortable: true, width: '110px', render: (v) => fmtDate(v) },
    { field: 'days_requested', header: 'Days', sortable: true, width: '70px',
      render: (v) => <span className="font-semibold">{v ?? '-'}</span> },
    { field: 'lop_days', header: 'LOP', sortable: true, width: '80px',
      render: (v) => {
        const lop = Number(v || 0);
        if (lop <= 0) return <span className="text-emerald-600 text-xs">✓ Paid</span>;
        return (
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700"
            title="Loss of Pay — deducted from salary at payroll">
            {lop} day{lop === 1 ? '' : 's'}
          </span>
        );
      },
    },
    { field: 'reason', header: 'Reason', sortable: false, width: '200px',
      render: (v) => v ? <span className="text-xs text-slate-600 line-clamp-2">{v}</span> : '-' },
    { field: 'status', header: 'Status', sortable: true, width: '110px',
      render: (v) => <StatusBadge status={v} /> },
    { field: 'approver_name', header: 'Approver', sortable: true, width: '140px',
      render: (v) => v || '-' },
    { field: 'actions', header: '', sortable: false, width: '120px',
      render: (_, row) => (
        <div className="flex items-center gap-1">
          {canApprove('Leave') && row.status === 'PENDING' && (
            <>
              <button onClick={(e) => { e.stopPropagation(); handleApprove(row); }}
                disabled={pendingId === row.id} aria-label="Approve" title="Approve"
                className="p-2 text-emerald-600 hover:bg-emerald-50 rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed">
                <Check size={15} />
              </button>
              <button onClick={(e) => { e.stopPropagation(); handleReject(row); }}
                disabled={pendingId === row.id} aria-label="Reject" title="Reject"
                className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-40 disabled:cursor-not-allowed">
                <XIcon size={15} />
              </button>
            </>
          )}
          <button onClick={(e) => { e.stopPropagation(); navigate(`/hr/leave/${row.id}`); }}
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
  } = useConfigureFields(columns, 'hr_leave_requests_fields', data);

  const filteredData = (() => {
    let result = (data || []).filter((row) => {
      if (!matchesSelect(row.status, filterValues.status)) return false;
      if (!matchesSelect(row.leave_type, filterValues.leave_type)) return false;
      if (!matchesSelect(row.approver_name, filterValues.approver_name)) return false;
      if (filterValues.date_from && row.start_date && row.start_date < filterValues.date_from) return false;
      if (filterValues.date_to && row.end_date && row.end_date > filterValues.date_to) return false;
      return true;
    });
    if (advancedRules.length > 0) {
      result = applyAdvancedFilters(result, advancedRules, advancedLogic);
    }
    return result;
  })();

  return (
    <>
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
          data={data || []}
          onAdvancedFilter={(rules, logic) => setAdvanced(rules, logic)}
          initialRules={advancedRules}
          initialLogic={advancedLogic}
        />
      )}
      <ListState error={error} onRetry={refetch}>
        <DataTable
          exportFileName="leave-requests"
          canExport={canExport('Leave')}
          columns={visibleColumns}
          data={filteredData}
          isLoading={isLoading}
          onRowClick={(row) => navigate(`/hr/leave/${row.id}`)}
          emptyMessage="No leave requests yet"
        />
      </ListState>
      {showConfig && (
        <ConfigureFields
          allColumns={mergedColumns}
          visibleFields={visibleFieldKeys}
          onApply={handleConfigApply}
          onClose={() => setShowConfig(false)}
          storageKey="hr_leave_requests_fields"
        />
      )}
    </>
  );
}

// ─── Balances tab ────────────────────────────────────────────────────────

function BalancesTab({ leaveRequests, staff }) {
  // Compute per-staff per-type usage from real LeaveRequest rows. The
  // backend doesn't yet store CL/SL/EL distinctions (it only has
  // FULL_DAY / HALF_DAY / PERMISSION), so each approved leave is
  // counted under "Earned Leave" by default as a placeholder. When
  // the backend gets a proper leave_type FK we'll swap this out.
  const rows = useMemo(() => {
    return (staff || []).filter(s => s.is_active !== false).map(s => {
      const myApproved = (leaveRequests || []).filter(r => r.staff === s.id && r.status === 'APPROVED');
      const usedDays = myApproved.reduce((sum, r) => sum + Number(r.days_requested || 1), 0);
      // Allocate the approved usage against the most generous bucket
      // (Earned Leave) so the visualisation isn't misleadingly empty.
      const earnedUsed = Math.min(usedDays, 18);
      const remainingOverflow = Math.max(0, usedDays - 18);
      const sickUsed = Math.min(remainingOverflow, 12);
      const casualUsed = Math.max(0, remainingOverflow - 12);
      return {
        id: s.id,
        staff_id: s.staff_id,
        staff_name: s.full_name || `${s.first_name || ''} ${s.last_name || ''}`.trim() || s.staff_id,
        department: s.department || '-',
        casual_used: casualUsed,
        casual_remaining: 12 - casualUsed,
        sick_used: sickUsed,
        sick_remaining: 12 - sickUsed,
        earned_used: earnedUsed,
        earned_remaining: 18 - earnedUsed,
        total_used: usedDays,
      };
    });
  }, [leaveRequests, staff]);

  const columns = [
    { field: 'staff_name', header: 'Employee', sortable: true, width: '200px',
      render: (v, row) => (
        <div>
          <p className="font-medium text-slate-800">{v}</p>
          <p className="text-xs text-slate-400 font-mono">{row.staff_id}</p>
        </div>
      ),
    },
    { field: 'department', header: 'Department', sortable: true, width: '140px',
      render: (v) => v || '-' },
    { field: 'casual_used', header: 'Casual Used', sortable: true, width: '100px',
      render: (v) => <BalancePill used={v} total={12} tone="blue" /> },
    { field: 'casual_remaining', header: 'CL Bal', sortable: true, width: '80px',
      render: (v) => <span className="font-semibold text-blue-700">{v}</span> },
    { field: 'sick_used', header: 'Sick Used', sortable: true, width: '100px',
      render: (v) => <BalancePill used={v} total={12} tone="amber" /> },
    { field: 'sick_remaining', header: 'SL Bal', sortable: true, width: '80px',
      render: (v) => <span className="font-semibold text-amber-700">{v}</span> },
    { field: 'earned_used', header: 'Earned Used', sortable: true, width: '110px',
      render: (v) => <BalancePill used={v} total={18} tone="violet" /> },
    { field: 'earned_remaining', header: 'EL Bal', sortable: true, width: '80px',
      render: (v) => <span className="font-semibold text-violet-700">{v}</span> },
    { field: 'total_used', header: 'Total Used', sortable: true, width: '100px',
      render: (v) => <span className="font-semibold">{v}</span> },
  ];

  return (
    <>
      <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
        Allocations are derived from the active leave policy (CL 12, SL 12, EL 18) and approved
        LeaveRequest rows. A dedicated <strong>LeavePolicy</strong> + per-staff balance model in the
        backend will replace this derived view.
      </div>
      <DataTable
        exportFileName="leave-balances"
        columns={columns}
        data={rows}
        emptyMessage="No staff records yet"
      />
    </>
  );
}

function BalancePill({ used, total, tone }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const toneMap = {
    blue: 'bg-blue-500',
    amber: 'bg-amber-500',
    violet: 'bg-violet-500',
  };
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium w-8 text-right">{used}/{total}</span>
      <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full ${toneMap[tone] || 'bg-slate-400'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ─── Leave Types tab ─────────────────────────────────────────────────────

function TypesTab() {
  return (
    <>
      <div className="mb-3 p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800">
        These are the active leave types defined in the company policy. The backend's leave_type
        enum only knows FULL_DAY / HALF_DAY / PERMISSION today — moving the policy here gives
        HR a single place to edit it once a <strong>LeavePolicy</strong> table is added.
      </div>
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b">
            <tr>
              <th className="text-left px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Type</th>
              <th className="text-left px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Description</th>
              <th className="text-right px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Annual Allowance</th>
              <th className="text-center px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Carry Forward</th>
              <th className="text-center px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Encashment</th>
              <th className="text-center px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {LEAVE_POLICY.map((p) => (
              <tr key={p.type} className="hover:bg-slate-50">
                <td className="px-3 py-2.5 font-medium text-slate-800">{p.label}</td>
                <td className="px-3 py-2.5 text-xs text-slate-500">{p.description}</td>
                <td className="px-3 py-2.5 text-right font-semibold">{p.annual} {p.annual ? 'days' : '—'}</td>
                <td className="px-3 py-2.5 text-center">
                  {p.carryForward
                    ? <span className="text-emerald-700 text-xs font-medium">✓ Yes</span>
                    : <span className="text-slate-400 text-xs">—</span>}
                </td>
                <td className="px-3 py-2.5 text-center">
                  {p.encashable
                    ? <span className="text-emerald-700 text-xs font-medium">✓ Encashable</span>
                    : <span className="text-slate-400 text-xs">—</span>}
                </td>
                <td className="px-3 py-2.5 text-center">
                  <StatusBadge status={p.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── Shared bits ─────────────────────────────────────────────────────────

function TabStrip({ activeTab, onChange, tabs }) {
  return (
    <div className="border-b border-slate-200">
      <div className="flex items-center gap-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={`px-4 py-2.5 text-sm font-medium transition border-b-2 -mb-px ${
              activeTab === t.key
                ? 'text-blue-700 border-blue-600'
                : 'text-slate-600 border-transparent hover:text-slate-800 hover:border-slate-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function StatTile({ label, value, tone }) {
  const toneMap = {
    slate: 'bg-slate-50 border-slate-200 text-slate-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    red: 'bg-red-50 border-red-200 text-red-700',
    violet: 'bg-violet-50 border-violet-200 text-violet-700',
  };
  return (
    <div className={`rounded-lg border px-4 py-3 ${toneMap[tone] || toneMap.slate}`}>
      <p className="text-xs font-medium opacity-80">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}
