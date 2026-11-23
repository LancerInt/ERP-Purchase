import { useMemo, useState } from 'react';
import { Plus, Trash2, ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import ListState from '@/components/common/ListState.jsx';
import Modal from '@/components/ui/Modal';
import CustomSelect from '@/components/ui/CustomSelect';
import apiClient from '../../../utils/api.js';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import { useUrlFilters } from '../../../hooks/useUrlState.js';
import { confirm } from '@/components/common/confirm';
import { formatCurrency } from '@/utils/formatters';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Categories offered per kind. Mirrors PayrollAdjustment.CATEGORY_CHOICES
// on the backend (stored free-form, so adding one here is enough).
const CATEGORIES = {
  EARNING: [
    ['BONUS', 'Bonus'], ['INCENTIVE', 'Incentive'], ['ARREARS', 'Arrears'],
    ['REIMBURSEMENT', 'Reimbursement'], ['OTHER', 'Other'],
  ],
  DEDUCTION: [
    ['ADVANCE_RECOVERY', 'Advance Recovery'], ['FINE', 'Fine / Penalty'],
    ['LOAN_EMI', 'Loan EMI'], ['PF', 'Provident Fund'], ['ESI', 'ESI'],
    ['TDS', 'TDS'], ['OTHER', 'Other'],
  ],
};

const now = new Date();
const YEARS = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];

const emptyForm = () => ({
  staff: '',
  period_year: now.getFullYear(),
  period_month: now.getMonth() + 1,
  kind: 'EARNING',
  category: 'BONUS',
  amount: '',
  reason: '',
  reference: '',
});

export default function PayrollAdjustments() {
  const { canCreate, canDelete } = usePermissions();
  const { data, isLoading, error, refetch } = useApiData('/api/hr/payroll-adjustments/');
  const { data: staffList } = useApiData('/api/hr/staff/');
  const { data: warehouses } = useApiData('/api/warehouses/');

  // Filters live in the URL so Back / refresh / sharing restore the filtered view.
  const { values: filters, setValue: setFilter } = useUrlFilters({
    warehouse: '', year: String(now.getFullYear()), month: '', kind: '',
  });
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);

  const staffById = useMemo(() => {
    const m = {};
    (staffList || []).forEach(s => { m[s.id] = s; });
    return m;
  }, [staffList]);

  const filtered = useMemo(() => (data || []).filter(r => {
    if (filters.year && String(r.period_year) !== filters.year) return false;
    if (filters.month && String(r.period_month) !== filters.month) return false;
    if (filters.kind && r.kind !== filters.kind) return false;
    if (filters.warehouse) {
      const s = staffById[r.staff];
      if (!s || String(s.primary_location) !== filters.warehouse) return false;
    }
    return true;
  }), [data, filters, staffById]);

  const stats = useMemo(() => {
    let earnings = 0, deductions = 0;
    filtered.forEach(r => {
      const amt = Number(r.amount || 0);
      if (r.kind === 'EARNING') earnings += amt; else deductions += amt;
    });
    return { earnings, deductions, net: earnings - deductions, count: filtered.length };
  }, [filtered]);

  const setField = (patch) => setForm(p => ({ ...p, ...patch }));

  const openAdd = () => { setForm(emptyForm()); setShowForm(true); };

  const save = async () => {
    if (!form.staff) { toast.error('Pick an employee.'); return; }
    if (!(Number(form.amount) > 0)) { toast.error('Enter an amount greater than 0.'); return; }
    setSaving(true);
    try {
      await apiClient.post('/api/hr/payroll-adjustments/', {
        staff: form.staff,
        period_year: Number(form.period_year),
        period_month: Number(form.period_month),
        kind: form.kind,
        category: form.category,
        amount: form.amount,
        reason: form.reason,
        reference: form.reference,
      });
      toast.success('Adjustment added. It will apply on the next payroll run for that month.');
      setShowForm(false);
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to add adjustment.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row) => {
    if (!(await confirm({
      message: `Delete this ${row.kind_display?.toLowerCase() || 'adjustment'} of ${formatCurrency(row.amount)} for ${row.staff_name}?`,
      isDangerous: true,
    }))) return;
    try {
      await apiClient.delete(`/api/hr/payroll-adjustments/${row.id}/`);
      toast.success('Adjustment deleted.');
      refetch();
    } catch (err) {
      toast.error(getApiErrorMessage(err) || 'Failed to delete.');
    }
  };

  const columns = [
    { field: 'staff_name', header: 'Employee', sortable: true, width: '190px',
      render: (v, row) => (
        <div>
          <p className="font-medium text-slate-800">{v || '-'}</p>
          <p className="text-xs text-slate-400 font-mono">{row.staff_id_display}</p>
        </div>
      ),
    },
    { field: 'period_month', header: 'Period', sortable: true, width: '110px',
      render: (v, row) => <span className="text-sm text-slate-700">{MONTHS[(v || 1) - 1]} {row.period_year}</span> },
    { field: 'kind', header: 'Type', sortable: true, width: '110px',
      render: (v, row) => (
        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${
          v === 'EARNING' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
          {v === 'EARNING' ? <ArrowUpRight size={12} /> : <ArrowDownLeft size={12} />}
          {row.kind_display || v}
        </span>
      ),
    },
    { field: 'category_display', header: 'Category', sortable: true, width: '150px',
      render: (v) => v || '-' },
    { field: 'amount', header: 'Amount', sortable: true, width: '130px',
      render: (v, row) => (
        <span className={`font-semibold tabular-nums ${row.kind === 'EARNING' ? 'text-emerald-700' : 'text-rose-700'}`}>
          {row.kind === 'EARNING' ? '+' : '−'}{formatCurrency(v)}
        </span>
      ),
    },
    { field: 'reason', header: 'Reason', sortable: false, width: '220px',
      render: (v) => v ? <span className="text-xs text-slate-600 line-clamp-2">{v}</span> : <span className="text-slate-400">—</span> },
    { field: 'reference', header: 'Ref', sortable: false, width: '110px',
      render: (v) => v || <span className="text-slate-400">—</span> },
    ...(canDelete('Payroll') ? [{
      field: 'actions', header: '', sortable: false, width: '60px',
      render: (_, row) => (
        <button onClick={(e) => { e.stopPropagation(); remove(row); }}
          className="p-1.5 text-red-500 hover:bg-red-50 rounded transition" title="Delete">
          <Trash2 size={15} />
        </button>
      ),
    }] : []),
  ];

  return (
    <MainLayout>
      <PageHeader
        title="Payroll Adjustments"
        subtitle="Manual earnings and deductions (bonus, incentive, advance recovery, fines, PF/ESI/TDS) applied per employee per month. Each one is rolled into payroll automatically when that month's run is generated."
        breadcrumbs={[{ label: 'HR', href: '/hr' }, { label: 'Payroll', href: '/hr/payroll' }, { label: 'Adjustments' }]}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatTile label="Total Earnings" value={formatCurrency(stats.earnings)} tone="emerald" />
        <StatTile label="Total Deductions" value={formatCurrency(stats.deductions)} tone="rose" />
        <StatTile label="Net Impact" value={`${stats.net < 0 ? '−' : ''}${formatCurrency(Math.abs(stats.net))}`} tone={stats.net < 0 ? 'rose' : 'slate'} />
        <StatTile label="Entries" value={stats.count} tone="slate" />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-end mb-3">
        <Filter label="Warehouse">
          <CustomSelect value={filters.warehouse} onChange={(e) => setFilter('warehouse', e.target.value)} className="input">
            <option value="">All Warehouses</option>
            {(warehouses || []).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </CustomSelect>
        </Filter>
        <Filter label="Year">
          <CustomSelect value={filters.year} onChange={(e) => setFilter('year', e.target.value)} className="input">
            <option value="">All</option>
            {YEARS.map(y => <option key={y} value={String(y)}>{y}</option>)}
          </CustomSelect>
        </Filter>
        <Filter label="Month">
          <CustomSelect value={filters.month} onChange={(e) => setFilter('month', e.target.value)} className="input">
            <option value="">All</option>
            {MONTHS.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
          </CustomSelect>
        </Filter>
        <Filter label="Type">
          <CustomSelect value={filters.kind} onChange={(e) => setFilter('kind', e.target.value)} className="input">
            <option value="">All</option>
            <option value="EARNING">Earning</option>
            <option value="DEDUCTION">Deduction</option>
          </CustomSelect>
        </Filter>
        <div className="col-span-2 sm:w-auto sm:ml-auto">
          {canCreate('Payroll') && (
            <button onClick={openAdd}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700">
              <Plus size={16} /> Add Adjustment
            </button>
          )}
        </div>
      </div>

      <ListState error={error} onRetry={refetch}>
        <DataTable persistKey="hr-payroll-adjustments"
          exportFileName="payroll-adjustments"
          columns={columns}
          data={filtered}
          isLoading={isLoading}
          emptyMessage="No payroll adjustments for this filter"
          emptyHint="Add a bonus, incentive, advance recovery or other one-off earning/deduction."
        />
      </ListState>

      <Modal isOpen={showForm} onClose={() => setShowForm(false)} title="Add Payroll Adjustment" size="md"
        footer={(
          <>
            <button onClick={() => setShowForm(false)} className="px-4 py-2 text-sm border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50">Cancel</button>
            <button onClick={save} disabled={saving}
              className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save Adjustment'}
            </button>
          </>
        )}>
        <div className="space-y-3">
          <Field label="Employee" required>
            <CustomSelect value={form.staff} onChange={(e) => setField({ staff: e.target.value })} className="input">
              <option value="">Select employee…</option>
              {(staffList || []).map(s => (
                <option key={s.id} value={s.id}>{s.staff_id} — {s.full_name}</option>
              ))}
            </CustomSelect>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Month" required>
              <CustomSelect value={String(form.period_month)} onChange={(e) => setField({ period_month: Number(e.target.value) })} className="input">
                {MONTHS.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
              </CustomSelect>
            </Field>
            <Field label="Year" required>
              <CustomSelect value={String(form.period_year)} onChange={(e) => setField({ period_year: Number(e.target.value) })} className="input">
                {YEARS.map(y => <option key={y} value={String(y)}>{y}</option>)}
              </CustomSelect>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type" required>
              <CustomSelect value={form.kind}
                onChange={(e) => setField({ kind: e.target.value, category: CATEGORIES[e.target.value][0][0] })}
                className="input">
                <option value="EARNING">Earning (adds to pay)</option>
                <option value="DEDUCTION">Deduction (cuts pay)</option>
              </CustomSelect>
            </Field>
            <Field label="Category" required>
              <CustomSelect value={form.category} onChange={(e) => setField({ category: e.target.value })} className="input">
                {CATEGORIES[form.kind].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </CustomSelect>
            </Field>
          </div>
          <Field label="Amount (₹)" required>
            <input type="number" min="0" step="0.01" value={form.amount}
              onChange={(e) => setField({ amount: e.target.value })}
              className="input" placeholder="0.00" />
          </Field>
          <Field label="Reason">
            <textarea value={form.reason} onChange={(e) => setField({ reason: e.target.value })}
              rows={2} className="input" placeholder="e.g. Diwali bonus, salary advance recovery instalment 2/6" />
          </Field>
          <Field label="Reference">
            <input type="text" value={form.reference} onChange={(e) => setField({ reference: e.target.value })}
              className="input" placeholder="Voucher / document no (optional)" />
          </Field>
        </div>
      </Modal>
    </MainLayout>
  );
}

function Filter({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 mb-1">{label}</label>
      <div className="w-full sm:w-44">{children}</div>
    </div>
  );
}

function Field({ label, required, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">
        {label}{required && <span className="text-red-500"> *</span>}
      </label>
      {children}
    </div>
  );
}

function StatTile({ label, value, tone }) {
  const toneMap = {
    slate: 'bg-slate-50 border-slate-200 text-slate-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    rose: 'bg-rose-50 border-rose-200 text-rose-700',
  };
  return (
    <div className={`rounded-lg border px-4 py-3 ${toneMap[tone] || toneMap.slate}`}>
      <p className="text-xs font-medium opacity-80">{label}</p>
      <p className="text-xl font-bold mt-1 tabular-nums">{value}</p>
    </div>
  );
}
