import { useMemo, useState } from 'react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import DataTable from '../../../components/common/DataTable';
import Modal from '@/components/ui/Modal';
import CustomSelect from '@/components/ui/CustomSelect';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import useApiData from '../../../hooks/useApiData.js';
import usePermissions from '../../../hooks/usePermissions.js';
import apiClient from '../../../utils/api.js';
import { confirm } from '@/components/common/confirm';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { getApiErrorMessage } from '../../../utils/formHelpers.js';
import toast from 'react-hot-toast';
import { Plus, Trash2, Wallet, ArrowDownToLine, ArrowUpFromLine, Landmark } from 'lucide-react';

const today = () => new Date().toISOString().slice(0, 10);
const MODES = ['CASH', 'BANK', 'UPI', 'CHEQUE', 'OTHER'];

const initials = (name) => (name || '').split(/\s+/).filter(Boolean).slice(0, 2)
  .map((w) => w[0]).join('').toUpperCase() || '?';

export default function ImprestPage() {
  const { canCreate, canDelete } = usePermissions();
  const funds = useApiData('/api/expenses/funds/');
  const entries = useApiData('/api/expenses/imprest/');
  const staff = useApiData('/api/hr/staff/');
  const companies = useApiData('/api/companies/');

  const totals = useMemo(() => (funds.data || []).reduce((a, f) => ({
    balance: a.balance + Number(f.balance || 0),
    opening: a.opening + Number(f.opening_balance || 0),
    topups:  a.topups + Number(f.total_topups || 0),
    spent:   a.spent + Number(f.total_voucher_spent || 0),
    count:   a.count + 1,
  }), { balance: 0, opening: 0, topups: 0, spent: 0, count: 0 }), [funds.data]);

  const [fundModal, setFundModal] = useState(false);
  const [topupModal, setTopupModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fundForm, setFundForm] = useState({ name: '', holder: '', department: '', company: '', opening_balance: '' });
  const [topupForm, setTopupForm] = useState({ fund: '', entry_date: today(), amount: '', mode: 'CASH', reference: '', notes: '' });

  const openFund = () => { setFundForm({ name: '', holder: '', department: '', company: '', opening_balance: '' }); setFundModal(true); };
  const openTopup = () => { setTopupForm({ fund: funds.data?.[0]?.id || '', entry_date: today(), amount: '', mode: 'CASH', reference: '', notes: '' }); setTopupModal(true); };

  // Cascade for the New Fund modal: Company → Department → Holder.
  // Departments are the distinct department values of staff in the chosen
  // company; holders are staff in that company (narrowed by department).
  const staffInCompany = (staff.data || []).filter((s) => !fundForm.company
    || String(s.company) === String(fundForm.company)
    || (Array.isArray(s.company_ids) && s.company_ids.map(String).includes(String(fundForm.company))));
  const departmentOptions = [...new Set(staffInCompany.map((s) => s.department).filter(Boolean))].sort();
  const holderOptions = fundForm.department
    ? staffInCompany.filter((s) => (s.department || '') === fundForm.department)
    : staffInCompany;

  const saveFund = async () => {
    if (!fundForm.name.trim()) { toast.error('Fund name is required'); return; }
    setSaving(true);
    try {
      const payload = {
        name: fundForm.name.trim(),
        holder: fundForm.holder || null,
        department: fundForm.department,
        company: fundForm.company || null,
        opening_balance: fundForm.opening_balance || 0,
      };
      await apiClient.post('/api/expenses/funds/', payload);
      toast.success('Fund created');
      setFundModal(false);
      funds.refetch();
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setSaving(false); }
  };

  const saveTopup = async () => {
    if (!topupForm.fund) { toast.error('Choose a fund'); return; }
    if (!(Number(topupForm.amount) > 0)) { toast.error('Enter an amount'); return; }
    setSaving(true);
    try {
      await apiClient.post('/api/expenses/imprest/', { ...topupForm });
      toast.success('Top-up recorded');
      setTopupModal(false);
      entries.refetch();
      funds.refetch();
    } catch (e) { toast.error(getApiErrorMessage(e)); }
    finally { setSaving(false); }
  };

  const deleteEntry = async (row) => {
    if (!(await confirm({ message: `Delete this ${formatCurrency(row.amount)} top-up?`, isDangerous: true, confirmLabel: 'Delete' }))) return;
    try {
      await apiClient.delete(`/api/expenses/imprest/${row.id}/`);
      toast.success('Deleted');
      entries.refetch();
      funds.refetch();
    } catch (e) { toast.error(getApiErrorMessage(e)); }
  };

  const columns = [
    { key: 'entry_date', label: 'Date', render: (v) => formatDate(v) },
    { key: 'fund_name', label: 'Fund' },
    { key: 'amount', label: 'Amount', render: (v) => <span className="font-semibold text-emerald-600">+{formatCurrency(v)}</span> },
    { key: 'mode_display', label: 'Mode', render: (v, row) => <ModeBadge mode={row.mode} label={v} /> },
    { key: 'reference', label: 'Reference', render: (v) => v || '—' },
    { key: 'created_by_name', label: 'By', render: (v) => <ByCell name={v} /> },
    ...(canDelete('Imprest') ? [{
      key: 'actions', label: '', sortable: false,
      render: (_, row) => (
        <button onClick={(e) => { e.stopPropagation(); deleteEntry(row); }} className="p-1.5 text-red-500 hover:bg-red-50 rounded" title="Delete">
          <Trash2 size={15} />
        </button>
      ),
    }] : []),
  ];

  return (
    <MainLayout>
      <PageHeader
        title="Imprest"
        subtitle="Petty-cash funds and top-ups"
        breadcrumbs={[{ label: 'Expenses' }, { label: 'Imprest' }]}
        actions={{
          right: canCreate('Imprest') ? (
            <div className="flex items-center gap-2">
              <button onClick={openFund} className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-300 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-50">
                <Plus size={15} /> New Fund
              </button>
              <button onClick={openTopup} className="inline-flex items-center gap-1.5 px-3 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700">
                <Plus size={15} /> Add Top-up
              </button>
            </div>
          ) : null,
        }}
      />

      {/* Summary strip — aggregate across all funds */}
      {(funds.data || []).length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          <StatTile icon={Wallet}          tone="blue"    label="Available balance" value={formatCurrency(totals.balance)} />
          <StatTile icon={ArrowDownToLine} tone="emerald" label="Total in"          value={formatCurrency(totals.opening + totals.topups)} />
          <StatTile icon={ArrowUpFromLine} tone="rose"    label="Total spent"       value={formatCurrency(totals.spent)} />
          <StatTile icon={Landmark}        tone="slate"   label="Active funds"      value={totals.count} />
        </div>
      )}

      {/* Fund cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {(funds.data || []).map((f) => {
          const totalIn = Number(f.opening_balance || 0) + Number(f.total_topups || 0);
          const spent = Number(f.total_voucher_spent || 0);
          const availPct = totalIn > 0
            ? Math.max(0, Math.min(100, Math.round((Number(f.balance || 0) / totalIn) * 100)))
            : 0;
          const barColor = availPct <= 15 ? 'bg-rose-500' : availPct <= 40 ? 'bg-amber-500' : 'bg-emerald-500';
          const sub = [f.holder_name, f.department].filter(Boolean).join(' · ');
          return (
            <div key={f.id} className="group bg-white rounded-xl border border-slate-200 p-5 hover:shadow-md hover:border-slate-300 transition">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 text-white flex items-center justify-center shrink-0 shadow-sm">
                  <Wallet size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-slate-900 truncate">{f.name}</p>
                  <p className="text-xs text-slate-500 truncate">{sub || '—'}</p>
                </div>
                {f.holder_name && (
                  <span title={f.holder_name}
                    className="w-7 h-7 rounded-full bg-slate-100 text-slate-600 text-[11px] font-semibold flex items-center justify-center shrink-0">
                    {initials(f.holder_name)}
                  </span>
                )}
              </div>

              <p className="text-3xl font-bold text-slate-900 mt-4 tracking-tight tabular-nums">{formatCurrency(f.balance)}</p>
              <p className="text-[11px] uppercase tracking-wide text-slate-400 font-medium">Available balance</p>

              <div className="mt-4">
                <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${availPct}%` }} />
                </div>
                <p className="text-[11px] text-slate-500 mt-1.5">
                  {totalIn > 0 ? `${availPct}% available · ${formatCurrency(spent)} spent` : 'No funds added yet'}
                </p>
              </div>

              <div className="grid grid-cols-3 gap-2 mt-4 pt-4 border-t border-slate-100">
                <MiniStat label="Opening"   value={formatCurrency(f.opening_balance)} />
                <MiniStat label="Topped up" value={formatCurrency(f.total_topups)} tone="emerald" />
                <MiniStat label="Spent"     value={formatCurrency(f.total_voucher_spent)} tone="rose" />
              </div>
            </div>
          );
        })}

        {(!funds.data || funds.data.length === 0) && !funds.isLoading && (
          <div className="col-span-full flex flex-col items-center justify-center text-center py-14 bg-white rounded-xl border border-dashed border-slate-300">
            <div className="w-12 h-12 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mb-3"><Wallet size={22} /></div>
            <p className="text-sm font-medium text-slate-700">No funds yet</p>
            <p className="text-xs text-slate-500 mt-1 mb-4">Create a petty-cash fund to start tracking top-ups and spends.</p>
            {canCreate('Imprest') && (
              <button onClick={openFund} className="inline-flex items-center gap-1.5 px-3 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700">
                <Plus size={15} /> New Fund
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-700">Top-up history</h3>
        <span className="text-xs text-slate-400">{(entries.data || []).length} record{(entries.data || []).length === 1 ? '' : 's'}</span>
      </div>
      <DataTable persistKey="expenses-imprest" columns={columns} data={entries.data || []} isLoading={entries.isLoading} exportFileName="imprest-topups" />

      {/* New Fund modal */}
      <Modal isOpen={fundModal} onClose={() => setFundModal(false)} title="New Imprest Fund" footer={
        <>
          <button onClick={() => setFundModal(false)} className="px-4 py-2 border border-slate-300 rounded-lg text-sm">Cancel</button>
          <button onClick={saveFund} disabled={saving} className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">{saving ? 'Saving…' : 'Create Fund'}</button>
        </>
      }>
        <div className="space-y-4">
          <Field label="Fund name" required>
            <input value={fundForm.name} onChange={(e) => setFundForm((p) => ({ ...p, name: e.target.value }))} className={inputCls} placeholder="e.g. Erode Office Cash" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Company">
              <CustomSelect name="company" value={fundForm.company} onChange={(e) => setFundForm((p) => ({ ...p, company: e.target.value, department: '', holder: '' }))} className={selectCls}>
                <option value="">— none —</option>
                {(companies.data || []).map((c) => <option key={c.id} value={c.id}>{c.trade_name || c.legal_name || c.company_code}</option>)}
              </CustomSelect>
            </Field>
            <Field label="Department">
              <CustomSelect name="department" value={fundForm.department} onChange={(e) => setFundForm((p) => ({ ...p, department: e.target.value, holder: '' }))} className={selectCls} disabled={!fundForm.company}>
                <option value="">{!fundForm.company ? 'Pick a company first…' : (departmentOptions.length ? 'All Departments' : 'No departments for this company')}</option>
                {departmentOptions.map((d) => <option key={d} value={d}>{d}</option>)}
              </CustomSelect>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Holder">
              <CustomSelect name="holder" value={fundForm.holder} onChange={(e) => setFundForm((p) => ({ ...p, holder: e.target.value }))} className={selectCls} disabled={!fundForm.company}>
                <option value="">{!fundForm.company ? 'Pick a company first…' : '— none —'}</option>
                {holderOptions.map((s) => <option key={s.id} value={s.id}>{(s.full_name || s.name || s.employee_name)}{s.department ? ` · ${s.department}` : ''}</option>)}
              </CustomSelect>
            </Field>
            <Field label="Opening balance">
              <input type="number" step="0.01" value={fundForm.opening_balance} onChange={(e) => setFundForm((p) => ({ ...p, opening_balance: e.target.value }))} className={inputCls} placeholder="0.00" />
            </Field>
          </div>
        </div>
      </Modal>

      {/* Add Top-up modal */}
      <Modal isOpen={topupModal} onClose={() => setTopupModal(false)} title="Add Top-up" footer={
        <>
          <button onClick={() => setTopupModal(false)} className="px-4 py-2 border border-slate-300 rounded-lg text-sm">Cancel</button>
          <button onClick={saveTopup} disabled={saving} className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">{saving ? 'Saving…' : 'Record Top-up'}</button>
        </>
      }>
        <div className="space-y-4">
          <Field label="Fund" required>
            <CustomSelect name="fund" value={topupForm.fund} onChange={(e) => setTopupForm((p) => ({ ...p, fund: e.target.value }))} className={selectCls}>
              <option value="">Select fund…</option>
              {(funds.data || []).map((f) => <option key={f.id} value={f.id}>{f.name} ({formatCurrency(f.balance)})</option>)}
            </CustomSelect>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date"><CustomDatePicker value={topupForm.entry_date} onChange={(d) => setTopupForm((p) => ({ ...p, entry_date: d }))} /></Field>
            <Field label="Amount" required><input type="number" step="0.01" value={topupForm.amount} onChange={(e) => setTopupForm((p) => ({ ...p, amount: e.target.value }))} className={inputCls} placeholder="0.00" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Mode">
              <CustomSelect name="mode" value={topupForm.mode} onChange={(e) => setTopupForm((p) => ({ ...p, mode: e.target.value }))} className={selectCls}>
                {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </CustomSelect>
            </Field>
            <Field label="Reference"><input value={topupForm.reference} onChange={(e) => setTopupForm((p) => ({ ...p, reference: e.target.value }))} className={inputCls} /></Field>
          </div>
        </div>
      </Modal>
    </MainLayout>
  );
}

const inputCls = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';
const selectCls = 'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white';

function Field({ label, required, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1.5">{label}{required && <span className="text-red-500"> *</span>}</label>
      {children}
    </div>
  );
}

const TILE_TONES = {
  blue:    'bg-blue-50 text-blue-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  rose:    'bg-rose-50 text-rose-600',
  slate:   'bg-slate-100 text-slate-600',
};
function StatTile({ icon: Icon, label, value, tone = 'slate' }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${TILE_TONES[tone]}`}>
        <Icon size={18} />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-slate-400 font-medium">{label}</p>
        <p className="text-lg font-bold text-slate-900 truncate tabular-nums">{value}</p>
      </div>
    </div>
  );
}

const MINI_TONES = { slate: 'text-slate-700', emerald: 'text-emerald-600', rose: 'text-rose-600' };
function MiniStat({ label, value, tone = 'slate' }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-slate-400 font-medium">{label}</p>
      <p className={`text-sm font-semibold truncate tabular-nums ${MINI_TONES[tone]}`}>{value}</p>
    </div>
  );
}

const MODE_STYLES = {
  CASH:   'bg-emerald-50 text-emerald-700 ring-emerald-200',
  BANK:   'bg-blue-50 text-blue-700 ring-blue-200',
  UPI:    'bg-violet-50 text-violet-700 ring-violet-200',
  CHEQUE: 'bg-amber-50 text-amber-700 ring-amber-200',
  OTHER:  'bg-slate-50 text-slate-600 ring-slate-200',
};
function ModeBadge({ mode, label }) {
  const cls = MODE_STYLES[mode] || MODE_STYLES.OTHER;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ring-1 ring-inset ${cls}`}>
      {label || mode || '—'}
    </span>
  );
}

function ByCell({ name }) {
  if (!name) return <span className="text-slate-400">—</span>;
  return (
    <div className="flex items-center gap-2">
      <span className="w-6 h-6 rounded-full bg-slate-100 text-slate-600 text-[10px] font-semibold flex items-center justify-center shrink-0">
        {initials(name)}
      </span>
      <span className="text-slate-700">{name}</span>
    </div>
  );
}
