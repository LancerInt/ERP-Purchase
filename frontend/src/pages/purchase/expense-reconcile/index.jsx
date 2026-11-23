/**
 * Purchase -> Expense Reconcile — whole-company reconciliation of every Tally
 * expense sub-category vs the ERP, split 3 ways:
 *   ✓ in ERP   — a real bill exists (Day-Book GUID or a scanned bill from the
 *                same vendor that month)
 *   journal    — no bill expected (freight lives in the Freight module; salary /
 *                rent / electricity / interest / bank / EPF / ESIC are journal-booked)
 *   ⚠ missing  — a genuine bill gap (should have a bill, none found)
 * Data: /api/purchase/expense-reconcile/
 */
import { useEffect, useMemo, useState } from 'react';
import { Loader2, CheckCircle2, AlertTriangle, FileText } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomSelect from '@/components/ui/CustomSelect';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { useUrlState } from '../../../hooks/useUrlState.js';

const fmt = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const pct = (part, whole) => (Number(whole) ? Math.round((Number(part) / Number(whole)) * 100) : 0);

const GROUPS = [
  { key: '', label: 'Both' },
  { key: 'DIRECT', label: 'Direct' },
  { key: 'INDIRECT', label: 'Indirect' },
];

function Bar({ erp, journal, missing }) {
  const tot = Number(erp) + Number(journal) + Number(missing) || 1;
  const w = (x) => `${(Number(x) / tot) * 100}%`;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-slate-100">
      <div className="bg-emerald-500" style={{ width: w(erp) }} title={`In ERP ${fmt(erp)}`} />
      <div className="bg-slate-300" style={{ width: w(journal) }} title={`Journal ${fmt(journal)}`} />
      <div className="bg-amber-500" style={{ width: w(missing) }} title={`Missing ${fmt(missing)}`} />
    </div>
  );
}

function CompanyBlock({ c }) {
  const inPct = pct(c.erp_total, c.tally_total);
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Company header + totals */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-800">{c.company_name}</div>
          <div className="text-[11px] text-slate-500">{c.voucher_count} Tally vouchers · {fmt(c.tally_total)}</div>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1 text-emerald-700"><CheckCircle2 size={14} /> {fmt(c.erp_total)} <span className="text-slate-400">in ERP ({inPct}%)</span></span>
          <span className="flex items-center gap-1 text-slate-500"><FileText size={14} /> {fmt(c.journal_total)} <span className="text-slate-400">journal</span></span>
          <span className="flex items-center gap-1 text-amber-700"><AlertTriangle size={14} /> {fmt(c.missing_total)} <span className="text-slate-400">missing</span></span>
        </div>
      </div>
      <div className="px-4 pt-3"><Bar erp={c.erp_total} journal={c.journal_total} missing={c.missing_total} /></div>

      {/* Per-category rows */}
      <div className="overflow-x-auto p-2">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400">
              <th className="px-2 py-2 font-semibold">Category</th>
              <th className="px-2 py-2 text-right font-semibold">Tally total</th>
              <th className="px-2 py-2 text-right font-semibold text-emerald-600">✓ in ERP</th>
              <th className="px-2 py-2 text-right font-semibold text-slate-500">journal</th>
              <th className="px-2 py-2 text-right font-semibold text-amber-600">⚠ missing</th>
            </tr>
          </thead>
          <tbody>
            {c.rows.map((r) => (
              <tr key={r.sub} className="border-t border-slate-50 hover:bg-primary-50/40 transition-colors">
                <td className="px-2 py-2">
                  <span className="font-medium text-slate-700">{r.sub}</span>
                  <span className="ml-2 rounded px-1 py-0.5 text-[9px] uppercase text-slate-400 ring-1 ring-slate-200">{r.group === 'DIRECT' ? 'Direct' : r.group === 'INDIRECT' ? 'Indirect' : '—'}</span>
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-slate-700">{fmt(r.tally)}</td>
                <td className="px-2 py-2 text-right tabular-nums text-emerald-700">{Number(r.erp) ? fmt(r.erp) : <span className="text-slate-300">—</span>}</td>
                <td className="px-2 py-2 text-right tabular-nums text-slate-500">{Number(r.journal) ? fmt(r.journal) : <span className="text-slate-300">—</span>}</td>
                <td className="px-2 py-2 text-right tabular-nums font-medium text-amber-700">{Number(r.missing) ? fmt(r.missing) : <span className="text-slate-300">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const periodLabel = (p) => {
  const [y, m] = (p || '').split('-');
  return (y && m) ? `${MONTHS[Number(m) - 1]} ${y}` : p;
};

export default function ExpenseReconcile() {
  const { options: companyOptions } = useLookup('/api/companies/');
  // Filters live in the URL so Back / refresh / sharing restore them.
  const [companyId, setCompanyId] = useUrlState('company', '');
  const [group, setGroup] = useUrlState('group', '');
  const [period, setPeriod] = useUrlState('period', '');   // '' = whole year
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const q = new URLSearchParams();
    if (companyId) q.set('company', companyId);
    if (group) q.set('group', group);
    if (period) q.set('period', period);
    apiClient.get(`/api/purchase/expense-reconcile/?${q.toString()}`)
      .then((r) => { if (alive) setData(r.data); })
      .catch(() => { if (alive) setError('Could not load the reconciliation.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [companyId, group, period]);

  const companies = data?.companies || [];
  const periods = data?.periods || [];

  return (
    <MainLayout>
      <div className="mx-auto max-w-5xl space-y-4 p-4">
        <PageHeader
          title="Expense Reconcile"
          subtitle="Every Tally expense category vs the ERP — in ERP, journal (no bill expected), or a real bill gap."
        />

        <div className="flex flex-wrap items-center gap-2">
          <CustomSelect value={companyId} onChange={(e) => setCompanyId(e.target.value)} title="Company"
            className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white min-w-0 max-w-[200px] truncate">
            <option value="">All Companies</option>
            {(companyOptions || []).map((c) => (<option key={c.value} value={c.value}>{c.label}</option>))}
          </CustomSelect>
          <div className="inline-flex overflow-hidden rounded-lg border border-slate-300 text-xs">
            {GROUPS.map((g, i) => (
              <button key={g.key} onClick={() => setGroup(g.key)}
                className={`px-3 py-1.5 ${i ? 'border-l border-slate-300' : ''} ${group === g.key ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                {g.label}
              </button>
            ))}
          </div>
          <CustomSelect value={period} onChange={(e) => setPeriod(e.target.value)} title="Month"
            className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white min-w-0 max-w-[150px]">
            <option value="">All months</option>
            {periods.map((p) => (<option key={p} value={p}>{periodLabel(p)}</option>))}
          </CustomSelect>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-4 text-[11px] text-slate-500">
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" /> in ERP — a real bill exists</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-slate-300" /> journal — no bill expected (freight / salary / rent / electricity / interest / bank)</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-500" /> missing — a genuine bill gap</span>
        </div>

        {loading && <div className="flex items-center justify-center py-16 text-slate-500"><Loader2 className="mr-2 animate-spin" size={18} /> Loading…</div>}
        {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        {!loading && !error && companies.length === 0 && (
          <div className="rounded-lg bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">No expense vouchers loaded.</div>
        )}
        {!loading && !error && companies.map((c) => <CompanyBlock key={c.company_id} c={c} />)}
      </div>
    </MainLayout>
  );
}
