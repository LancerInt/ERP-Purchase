/**
 * Sales -> Debtors — Tally's "Sundry Debtors" Group Summary.
 *
 * The mirror of Purchase -> Creditors, and the sales half of any ERP-vs-Tally
 * comparison. Read-only: the rows are a snapshot written by `import_debtors`
 * from a Tally Day Book + ledger master.
 *
 * Why not the ERP's own receivables — the same reason the creditors page gives
 * for payables: receipts are not reliably linked to invoices and the same party
 * exists under several customer masters, so checking the ERP against itself
 * proves nothing. Tally is the ledger of record here.
 *
 * SIGNS: Tally stores credit positive / debit negative, so a customer who owes
 * us carries a NEGATIVE closing and Tally labels it "Dr". The API returns
 * `receivable` — the same figure flipped — and that is what this page shows,
 * because "owed to us" is how the business reads it. `side` is still printed
 * so the page and Tally's own screen agree line for line.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Users, Download, Loader2, RefreshCw, ChevronRight, ChevronDown } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomSelect from '@/components/ui/CustomSelect';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import exportToExcel from '../../../utils/exportExcel.js';

const fmt = (v) => `₹${Math.abs(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/**
 * Strip whatever prefix every group shares, so rows read like Tally's Group
 * Summary without naming the root anywhere. DERIVED, not hard-coded: the root
 * is configurable per company (core.Company.tally_debtor_group), so a literal
 * "Sundry Debtors" here would quietly stop stripping the moment a company used
 * anything else. With one group there is no shared prefix to find, so it is
 * left whole.
 */
function commonPrefix(names) {
  const list = (names || []).filter(Boolean);
  if (list.length < 2) return '';
  let p = list[0];
  for (const n of list.slice(1)) {
    let i = 0;
    while (i < p.length && i < n.length && p[i].toLowerCase() === n[i].toLowerCase()) i += 1;
    p = p.slice(0, i);
    if (!p) return '';
  }
  // Only cut on a separator, never mid-word: "Debtors - No" would be worse
  // than no stripping at all.
  const m = p.match(/^.*[-–—:/]\s*/);
  return m ? m[0] : '';
}
const shortGroup = (g, prefix) => {
  const s = String(g || '');
  const out = prefix && s.toLowerCase().startsWith(prefix.toLowerCase())
    ? s.slice(prefix.length).trim() : s;
  return out || s;
};

export default function SalesDebtors() {
  const [sp, setSp] = useSearchParams();
  const [companyId, setCompanyId] = useState(sp.get('company') || '');
  const [open, setOpen] = useState(null);      // expanded group
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const { options: companies } = useLookup('/api/companies/');

  useEffect(() => {
    const next = new URLSearchParams(sp);
    if (companyId) next.set('company', companyId); else next.delete('company');
    setSp(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const r = await apiClient.get('/api/sales/debtors/', {
        params: { company: companyId || undefined },
      });
      setData(r.data);
    } catch (e) {
      setError(e?.response?.data?.detail || e.message || 'Could not load debtors.');
      setData(null);
    } finally { setLoading(false); }
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  const groups = data?.groups || [];
  const ledgers = data?.ledgers || [];
  // Computed from the rows Tally actually returned, so it adapts to whatever
  // the company's debtor root is called.
  const groupPrefix = useMemo(
    () => commonPrefix(groups.map((g) => g.group)), [groups]);
  const byGroup = useMemo(() => {
    const m = {};
    ledgers.forEach((l) => { (m[l.group] = m[l.group] || []).push(l); });
    return m;
  }, [ledgers]);

  const exportRows = () => {
    if (!ledgers.length) { toast.error('Nothing to export.'); return; }
    exportToExcel(ledgers.map((l) => ({
      Group: l.group, Ledger: l.ledger, 'Under': l.ledger_parent,
      Opening: l.opening, Debit: l.debit, Credit: l.credit,
      Receivable: l.receivable, Side: l.side, 'As of': l.as_of,
    })), 'tally-debtors');
  };

  return (
    <MainLayout>
      <PageHeader
        title="Debtors"
        subtitle="Tally's Sundry Debtors — what customers owe us"
        icon={Users}
        breadcrumbs={[{ label: 'Sales', href: '/sales/dashboard' }, { label: 'Debtors' }]}
        actions={{
          right: (
            <div className="flex flex-wrap items-center gap-2">
              <CustomSelect
                name="company"
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
                placeholder="All Companies"
                className="min-w-[180px]"
              >
                {companies.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </CustomSelect>
              <button type="button" onClick={load} disabled={loading}
                className="h-9 inline-flex items-center gap-1.5 px-3 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                Refresh
              </button>
              <button type="button" onClick={exportRows} disabled={!ledgers.length}
                className="h-9 inline-flex items-center gap-1.5 px-3 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:opacity-50">
                <Download size={14} /> Export
              </button>
            </div>
          ),
        }}
      />

      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg p-3 text-sm mb-4">{error}</div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-slate-100">
          <div>
            <h3 className="text-sm font-semibold text-slate-800">Group Summary</h3>
            <p className="text-[11px] text-slate-400">
              {data?.as_of ? `As at ${data.as_of}` : 'No snapshot yet'}
              {data?.count ? ` · ${data.count} ledger(s)` : ''}
            </p>
          </div>
          {data && (
            <div className="text-right">
              <p className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">Total receivable</p>
              <p className="text-xl font-bold text-slate-900 tabular-nums leading-tight">
                {fmt(data.grand_receivable)}
                <span className="ml-1.5 text-[11px] font-semibold text-slate-400">{data.grand_side}</span>
              </p>
            </div>
          )}
        </div>

        {loading && !data ? (
          <p className="text-sm text-slate-400 py-12 text-center">Loading…</p>
        ) : !groups.length ? (
          <div className="py-12 text-center">
            <p className="text-sm text-slate-500">No Tally debtor snapshot for this company yet.</p>
            <p className="text-[11px] text-slate-400 mt-1.5">
              Pull one with <code className="bg-slate-100 px-1 py-0.5 rounded">manage.py import_debtors --company &lt;code&gt; --live --yes</code>
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2.5text-left font-semibold">Group</th>
                  <th className="px-4 py-2.5text-right font-semibold">Opening</th>
                  <th className="px-4 py-2.5text-right font-semibold">Debit</th>
                  <th className="px-4 py-2.5text-right font-semibold">Credit</th>
                  <th className="px-4 py-2.5text-right font-semibold">Receivable</th>
                  <th className="px-4 py-2.5text-right font-semibold">Ledgers</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const expanded = open === g.group;
                  const rows = byGroup[g.group] || [];
                  return (
                    <Fragment key={g.group}>
                      <tr onClick={() => setOpen(expanded ? null : g.group)}
                        className="border-b border-slate-100 hover:bg-indigo-50/50 cursor-pointer">
                        <td className="px-4 py-2.5 font-medium text-slate-800">
                          <span className="inline-flex items-center gap-1.5">
                            {expanded ? <ChevronDown size={14} className="text-slate-400" />
                                      : <ChevronRight size={14} className="text-slate-400" />}
                            {shortGroup(g.group, groupPrefix)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{fmt(g.opening)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{fmt(g.debit)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{fmt(g.credit)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-900">
                          {fmt(g.receivable)}
                          <span className="ml-1 text-[10px] text-slate-400">{g.side}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-slate-400">{g.ledgers}</td>
                      </tr>
                      {expanded && rows.map((l) => (
                        <tr key={`${g.group}-${l.ledger}`} className="border-b border-slate-50 bg-slate-50/40">
                          <td className="px-4 py-2.5pl-10 text-slate-600">
                            {l.ledger}
                            {l.ledger_parent && l.ledger_parent !== g.group && (
                              <span className="ml-1.5 text-[10px] text-slate-400">under {shortGroup(l.ledger_parent, groupPrefix)}</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5text-right tabular-nums text-slate-500">{fmt(l.opening)}</td>
                          <td className="px-4 py-2.5text-right tabular-nums text-slate-500">{fmt(l.debit)}</td>
                          <td className="px-4 py-2.5text-right tabular-nums text-slate-500">{fmt(l.credit)}</td>
                          <td className="px-4 py-2.5text-right tabular-nums text-slate-800">
                            {fmt(l.receivable)}
                            <span className="ml-1 text-[10px] text-slate-400">{l.side}</span>
                          </td>
                          <td className="px-4 py-2.5" />
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </MainLayout>
  );
}
