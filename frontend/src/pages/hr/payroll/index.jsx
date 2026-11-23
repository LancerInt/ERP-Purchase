import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, Download, Zap, X, FileText, Plus, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import StatusBadge from '../../../components/common/StatusBadge';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useApiData from '../../../hooks/useApiData.js';
import useLookup from '../../../hooks/useLookup.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { formatCurrency, formatDate, formatDateTime } from '@/utils/formatters';

const fmtDate = (v) =>
  v ? formatDate(v) : '-';
const fmtMoney = (v) => formatCurrency(v);

const lastMonthDefaults = () => {
  const now = new Date();
  const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 86400000);
  const firstOfPrevMonth = new Date(lastOfPrevMonth.getFullYear(), lastOfPrevMonth.getMonth(), 1);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { period_start: iso(firstOfPrevMonth), period_end: iso(lastOfPrevMonth) };
};

export default function PayrollWorkspace() {
  const navigate = useNavigate();
  const { canCreate } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/hr/payroll/');
  const { data: staffData } = useApiData('/api/hr/staff/');
  const { options: warehouses } = useLookup('/api/warehouses/');
  const [activeTab, setActiveTab] = useState('runs');

  const defaults = lastMonthDefaults();
  const [genModal, setGenModal] = useState({
    open: false, warehouse_id: '', period_start: defaults.period_start, period_end: defaults.period_end, busy: false,
  });

  const handleGenerate = async () => {
    if (!genModal.warehouse_id) { toast.error('Pick a warehouse'); return; }
    if (!genModal.period_start || !genModal.period_end) { toast.error('Pick a period'); return; }
    if (genModal.period_end < genModal.period_start) { toast.error('Period end must be after start'); return; }
    setGenModal((m) => ({ ...m, busy: true }));
    try {
      const res = await apiClient.post('/api/hr/payroll/generate/', {
        warehouse_id: genModal.warehouse_id,
        period_start: genModal.period_start,
        period_end: genModal.period_end,
      });
      toast.success(`Payroll generated: ${res.data?.export_id || 'OK'}`);
      setGenModal({ ...genModal, open: false, busy: false });
      refetch();
      if (res.data?.id) navigate(`/hr/payroll/${res.data.id}`);
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to generate payroll.');
      setGenModal((m) => ({ ...m, busy: false }));
    }
  };

  // Page-level summary numbers. Compute against the loaded payroll
  // runs. "Current payroll cost" is the sum of wages across all staff
  // summaries on the most recent run.
  const stats = useMemo(() => {
    const runs = data || [];
    const latest = runs[0]; // already ordered by -period_end on backend
    const latestSummaries = latest?.staff_summaries || [];
    const currentCost = latestSummaries.reduce((s, r) => s + Number(r.wages_amount || 0), 0);
    const employees = new Set(latestSummaries.map(s => s.staff)).size;
    return {
      currentCost,
      employees,
      pendingApprovals: 0, // wire up once a PayrollRun.approval_status exists
      payslipsGenerated: runs.reduce((sum, r) => sum + (r.total_staff || 0), 0),
    };
  }, [data]);

  return (
    <MainLayout>
      <PageHeader
        title="Payroll"
        subtitle="Review payroll runs, salary calculations, deductions, and payslip status."
        breadcrumbs={[{ label: 'HR', href: '/hr' }, { label: 'Payroll' }]}
        actions={{
          onPrint: () => window.print(),
        }}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatTile label="Current Payroll Cost" value={fmtMoney(stats.currentCost)} tone="emerald" />
        <StatTile label="Employees Included" value={stats.employees} tone="slate" />
        <StatTile label="Pending Approvals" value={stats.pendingApprovals} tone="amber" />
        <StatTile label="Payslips Generated" value={stats.payslipsGenerated} tone="violet" />
      </div>

      <div className="flex items-center justify-between mb-3">
        <TabStrip
          activeTab={activeTab}
          onChange={setActiveTab}
          tabs={[
            { key: 'runs', label: 'Payroll Runs' },
            { key: 'employees', label: 'Employees' },
            { key: 'adjustments', label: 'Adjustments' },
            { key: 'payslips', label: 'Payslips' },
          ]}
        />
        {canCreate('Payroll') && (
          <button
            onClick={() => setGenModal((m) => ({ ...m, open: true }))}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition"
          >
            <Zap size={16} /> Run Payroll
          </button>
        )}
      </div>

      <div className="mt-4">
        {activeTab === 'runs' && (
          <RunsTab data={data} isLoading={isLoading} error={error} refetch={refetch} navigate={navigate} />
        )}
        {activeTab === 'employees' && (
          <EmployeesTab runs={data || []} staff={staffData || []} />
        )}
        {activeTab === 'adjustments' && <AdjustmentsTab />}
        {activeTab === 'payslips' && (
          <PayslipsTab runs={data || []} />
        )}
      </div>

      {/* Run Payroll modal */}
      {genModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div role="dialog" aria-modal="true" aria-label="Run Payroll" className="bg-white rounded-xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-4 sm:px-5 py-4 border-b bg-blue-50">
              <div>
                <h3 className="text-lg font-bold text-blue-900">Run Payroll</h3>
                <p className="text-xs text-blue-600 mt-0.5">Aggregates attendance + OT for the period.</p>
              </div>
              <button onClick={() => setGenModal((m) => ({ ...m, open: false }))}
                className="p-1.5 text-slate-500 hover:bg-slate-200 rounded"><X size={18} /></button>
            </div>
            <div className="px-4 sm:px-5 py-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Warehouse *</label>
                <CustomSelect value={genModal.warehouse_id}
                  onChange={(e) => setGenModal((m) => ({ ...m, warehouse_id: e.target.value }))}
                  className="w-full border border-slate-300 rounded-lg px-2.5 py-2 text-sm focus:ring-2 focus:ring-blue-500">
                  <option value="">Select warehouse…</option>
                  {warehouses.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
                </CustomSelect>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Period Start *</label>
                  <CustomDatePicker value={genModal.period_start}
                    onChange={(e) => setGenModal((m) => ({ ...m, period_start: e.target.value }))}
                    className="w-full border border-slate-300 rounded-lg px-2.5 py-2 text-sm focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Period End *</label>
                  <CustomDatePicker value={genModal.period_end}
                    onChange={(e) => setGenModal((m) => ({ ...m, period_end: e.target.value }))}
                    className="w-full border border-slate-300 rounded-lg px-2.5 py-2 text-sm focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
              <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
                <strong>Heads up:</strong> the system tallies present days, absent days
                and approved overtime hours per staff and produces a downloadable summary.
                This action is logged.
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-4 sm:px-5 py-4 border-t bg-slate-50">
              <button onClick={() => setGenModal((m) => ({ ...m, open: false }))}
                className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-100">
                Cancel
              </button>
              <button onClick={handleGenerate} disabled={genModal.busy}
                className="flex items-center gap-2 px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                <Zap size={14} /> {genModal.busy ? 'Running…' : 'Run Payroll'}
              </button>
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  );
}

// ─── Runs tab ────────────────────────────────────────────────────────────

function RunsTab({ data, isLoading, error, refetch, navigate }) {
  const { canExport } = usePermissions();
  const columns = [
    { key: 'export_id', label: 'Run ID', sortable: true,
      render: (v, row) => (
        <button onClick={(e) => { e.stopPropagation(); navigate(`/hr/payroll/${row.id}`); }}
          className="text-blue-700 hover:underline font-mono font-medium text-xs">{v}</button>
      ),
    },
    { key: 'period_label', label: 'Payroll Period', sortable: false,
      render: (_, row) => `${fmtDate(row.period_start)} → ${fmtDate(row.period_end)}` },
    { key: 'warehouse_name', label: 'Warehouse', sortable: true, render: (v) => v || '-' },
    { key: 'total_staff', label: 'Employees', sortable: true,
      render: (v) => <span className="font-semibold">{v ?? 0}</span> },
    { key: 'gross_pay', label: 'Gross Pay', sortable: false,
      render: (_, row) => {
        const gross = (row.staff_summaries || []).reduce((s, r) => s + Number(r.wages_amount || 0), 0);
        return <span className="font-semibold text-emerald-700">{fmtMoney(gross)}</span>;
      },
    },
    { key: 'deductions', label: 'Deductions', sortable: false,
      render: () => <span className="text-slate-400">—</span> },
    { key: 'net_pay', label: 'Net Pay', sortable: false,
      render: (_, row) => {
        const gross = (row.staff_summaries || []).reduce((s, r) => s + Number(r.wages_amount || 0), 0);
        return <span className="font-semibold text-emerald-700">{fmtMoney(gross)}</span>;
      },
    },
    { key: 'status', label: 'Status', sortable: false,
      render: (_, row) => <StatusBadge status={row.export_file ? 'COMPLETED' : 'PROCESSING'} /> },
    { key: 'created_at', label: 'Processed On', sortable: true,
      render: (v) => v ? formatDateTime(v) : '-' },
    { key: 'actions', label: '', sortable: false,
      render: (_, row) => (
        <div className="flex items-center gap-1">
          {row.export_file && (
            <a href={row.export_file} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
              className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded transition" title="Download">
              <Download size={15} />
            </a>
          )}
          <button onClick={(e) => { e.stopPropagation(); navigate(`/hr/payroll/${row.id}`); }}
            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded transition" title="View">
            <Pencil size={15} />
          </button>
        </div>
      ),
    },
  ];

  if (isLoading) return <div className="text-center py-8 text-slate-500">Loading…</div>;
  if (error) return (
    <div className="text-center py-8">
      <p className="text-red-500 mb-3">Failed to load payroll runs.</p>
      <button onClick={() => refetch()} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700">
        <RefreshCw size={15} /> Retry
      </button>
    </div>
  );

  return (
    <DataTable
      exportFileName="payroll-runs"
      canExport={canExport('Payroll')}
      columns={columns}
      data={data || []}
      onRowClick={(row) => navigate(`/hr/payroll/${row.id}`)}
      emptyMessage="No payroll runs yet — click Run Payroll to start"
    />
  );
}

// ─── Employees tab ───────────────────────────────────────────────────────

function EmployeesTab({ runs, staff }) {
  // Collapse the most recent run's staff summaries into a per-employee
  // view with basic+overtime+net split. The backend's PayrollExport
  // only stores `wages_amount` today — for the dashboard we present
  // an indicative breakdown driven by overtime_hours so HR sees what
  // gets paid out to whom. Real components (basic/HRA/allowances)
  // belong in a future SalaryStructure model.
  const latest = runs[0];
  const summaries = latest?.staff_summaries || [];
  const staffById = useMemo(() => {
    const m = {};
    (staff || []).forEach(s => { m[s.id] = s; });
    return m;
  }, [staff]);

  const rows = summaries.map(s => {
    // The backend records only the total `wages_amount` (+ overtime hours)
    // per staff for the period. We deliberately do NOT invent a
    // basic/allowance/OT-amount/deduction split — fabricated money on a
    // payroll screen is a trust hazard. Untracked components render as "—";
    // real overtime HOURS are shown instead of a guessed amount.
    const wages = Number(s.wages_amount || 0);
    return {
      id: s.id,
      staff_id_display: s.staff_id_display,
      staff_name: s.staff_name || staffById[s.staff]?.full_name || s.staff_id_display,
      department: staffById[s.staff]?.department || '-',
      basic_salary: wages,
      allowances: null,
      overtime: null,
      overtime_hours: Number(s.overtime_hours || 0),
      deductions: null,
      leave_deductions: null,
      net_pay: wages,
      status: 'PROCESSED',
    };
  });

  const columns = [
    { key: 'staff_name', label: 'Employee', sortable: true,
      render: (v, row) => (
        <div>
          <p className="font-medium text-slate-800">{v}</p>
          <p className="text-xs text-slate-400 font-mono">{row.staff_id_display}</p>
        </div>
      ),
    },
    { key: 'department', label: 'Department', sortable: true, render: (v) => v || '-' },
    { key: 'basic_salary', label: 'Wages', sortable: true, render: (v) => fmtMoney(v) },
    { key: 'allowances', label: 'Allowances', sortable: true,
      render: (v) => v == null ? <span className="text-slate-400">—</span> : fmtMoney(v) },
    { key: 'overtime', label: 'Overtime', sortable: true,
      render: (_, row) => row.overtime_hours
        ? <span className="text-violet-700">{row.overtime_hours} h</span>
        : <span className="text-slate-400">—</span> },
    { key: 'deductions', label: 'Deductions', sortable: true,
      render: (v) => v == null ? <span className="text-slate-400">—</span> : <span className="text-red-600">{fmtMoney(v)}</span> },
    { key: 'leave_deductions', label: 'Leave Ded.', sortable: true,
      render: (v) => v ? <span className="text-red-600">{fmtMoney(v)}</span> : <span className="text-slate-400">—</span> },
    { key: 'net_pay', label: 'Net Pay', sortable: true,
      render: (v) => <span className="font-semibold text-emerald-700">{fmtMoney(v)}</span> },
    { key: 'status', label: 'Status',
      render: (v) => <StatusBadge status={v} /> },
  ];

  return (
    <>
      <div className="mb-3 p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800">
        Showing employees from the most recent payroll run
        {latest && <strong> ({latest.export_id}, {fmtDate(latest.period_start)} → {fmtDate(latest.period_end)})</strong>}.
        Only total wages (and overtime hours) are recorded today — allowances and
        deductions show “—” until a Salary Structure model is added; net pay equals wages.
      </div>
      <DataTable
        exportFileName="payroll-employees"
        columns={columns}
        data={rows}
        emptyMessage="No payroll run yet — run one from the Payroll Runs tab"
      />
    </>
  );
}

// ─── Adjustments tab ─────────────────────────────────────────────────────

function AdjustmentsTab() {
  // Adjustments aren't a backend model yet; render an instructive
  // empty state instead of fake rows so HR don't act on imaginary
  // data. The shape below documents the schema we'd want once it lands.
  const adjustments = []; // [{ id, employee, type, amount, reason, status, added_by }]

  const columns = [
    { key: 'employee', label: 'Employee', sortable: true, render: (v) => v || '-' },
    { key: 'type', label: 'Type', sortable: true,
      render: (v) => v ? <span className="px-2 py-1 rounded text-xs bg-amber-100 text-amber-700">{v}</span> : '-' },
    { key: 'amount', label: 'Amount', sortable: true,
      render: (v) => <span className="font-semibold">{fmtMoney(v)}</span> },
    { key: 'reason', label: 'Reason', sortable: false, render: (v) => v || '-' },
    { key: 'status', label: 'Status', render: (v) => <StatusBadge status={v} /> },
    { key: 'added_by', label: 'Added By', sortable: true, render: (v) => v || '-' },
    { key: 'actions', label: '', sortable: false,
      render: () => (
        <button disabled aria-label="Edit" className="p-1.5 text-slate-400 cursor-not-allowed rounded" title="Edit">
          <Pencil size={15} />
        </button>
      ),
    },
  ];

  return (
    <>
      <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex items-start gap-2">
        <FileText size={16} className="mt-0.5 flex-shrink-0" />
        <div>
          <strong>Manual adjustments</strong> let HR add bonuses, advance reversals, attendance
          penalties or one-off corrections to a payroll run. The backend doesn&apos;t store these
          separately yet — add a <code className="text-xs bg-amber-100 px-1 rounded">PayrollAdjustment</code> model
          (FK to PayrollExport + Staff, with type/amount/reason/status fields) to enable this tab.
        </div>
      </div>
      <DataTable
        exportFileName="payroll-adjustments"
        columns={columns}
        data={adjustments}
        emptyMessage="No adjustments — add a PayrollAdjustment model in the backend to enable this tab"
      />
      <div className="mt-3 flex justify-end">
        <button disabled
          className="flex items-center gap-2 px-4 py-2 bg-slate-200 text-slate-500 rounded-lg text-sm font-medium cursor-not-allowed"
          title="Backend model not yet wired">
          <Plus size={14} /> Add Adjustment
        </button>
      </div>
    </>
  );
}

// ─── Payslips tab ────────────────────────────────────────────────────────

function PayslipsTab({ runs }) {
  // Flatten staff_summaries across all runs into one payslip row per
  // (run, staff). The "generated_on" is the run's created_at.
  const rows = useMemo(() => {
    const out = [];
    (runs || []).forEach((run) => {
      (run.staff_summaries || []).forEach((s) => {
        out.push({
          id: `${run.id}-${s.id}`,
          run_id: run.id,
          staff_name: s.staff_name,
          staff_id_display: s.staff_id_display,
          period_label: `${fmtDate(run.period_start)} → ${fmtDate(run.period_end)}`,
          month_key: (run.period_end || '').slice(0, 7),
          net_pay: Number(s.wages_amount || 0),
          generated_on: run.created_at,
          status: run.export_file ? 'GENERATED' : 'PENDING',
          export_file: run.export_file,
        });
      });
    });
    return out;
  }, [runs]);

  const columns = [
    { key: 'staff_name', label: 'Employee', sortable: true,
      render: (v, row) => (
        <div>
          <p className="font-medium text-slate-800">{v}</p>
          <p className="text-xs text-slate-400 font-mono">{row.staff_id_display}</p>
        </div>
      ),
    },
    { key: 'period_label', label: 'Period', sortable: true },
    { key: 'net_pay', label: 'Net Pay', sortable: true,
      render: (v) => <span className="font-semibold text-emerald-700">{fmtMoney(v)}</span> },
    { key: 'generated_on', label: 'Generated On', sortable: true,
      render: (v) => v ? formatDateTime(v) : '-' },
    { key: 'status', label: 'Status', render: (v) => <StatusBadge status={v} /> },
    { key: 'actions', label: '', sortable: false,
      render: (_, row) => row.export_file
        ? (
          <a href={row.export_file} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-blue-600 hover:underline text-xs">
            <Download size={12} /> Payslip
          </a>
        )
        : <span className="text-slate-400 text-xs">—</span>,
    },
  ];

  return (
    <DataTable
      exportFileName="payslips"
      columns={columns}
      data={rows}
      emptyMessage="No payslips yet — run payroll to generate per-employee payslips"
    />
  );
}

// ─── Shared bits ─────────────────────────────────────────────────────────

function TabStrip({ activeTab, onChange, tabs }) {
  return (
    <div className="border-b border-slate-200 flex-1">
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
    violet: 'bg-violet-50 border-violet-200 text-violet-700',
  };
  return (
    <div className={`rounded-lg border px-4 py-3 ${toneMap[tone] || toneMap.slate}`}>
      <p className="text-xs font-medium opacity-80">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}
