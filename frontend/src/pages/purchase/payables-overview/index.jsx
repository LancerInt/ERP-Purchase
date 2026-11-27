import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useGlobalCompany } from '@/hooks/useGlobalCompany.js';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import useApiData from '../../../hooks/useApiData.js';
import apiClient from '../../../utils/api.js';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import { formatCurrency } from '@/utils/formatters';
import { Receipt, Wallet, CheckCircle2, AlertCircle, Layers, ExternalLink } from 'lucide-react';

// Short, friendly company name (mirrors the Payments Made / dashboard toggle).
function niceCompany(code, raw) {
  const s = `${code || ''} ${raw || ''}`.toLowerCase();
  if (/ssb|biochem|ss\s*bio/.test(s)) return 'SS Biochem';
  if (/uai|united|agro/.test(s)) return 'United Agro';
  return raw || code || '';
}

const fc = (v) => formatCurrency(v);
const TONE_ICON = {
  slate: 'bg-slate-50 text-slate-700', indigo: 'bg-indigo-50 text-indigo-700',
  emerald: 'bg-emerald-50 text-emerald-700', amber: 'bg-amber-50 text-amber-700',
  rose: 'bg-rose-50 text-rose-700', sky: 'bg-sky-50 text-sky-700',
};

// Matches the Analytics StatCard: icon-in-tile, uppercase label, dark slate value.
function StatCard({ icon: Icon, label, value, sub, tone = 'slate', onClick }) {
  const clickable = typeof onClick === 'function';
  return (
    <div
      onClick={clickable ? onClick : undefined}
      role={clickable ? 'button' : undefined} tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      className={`min-w-0 bg-white rounded-lg border border-slate-200 p-3 sm:p-4 transition ${clickable ? 'cursor-pointer hover:shadow-md hover:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-300' : 'hover:shadow-sm'}`}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5 sm:mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`p-1.5 sm:p-2 rounded-lg shrink-0 ${TONE_ICON[tone]}`}><Icon size={16} className="sm:w-[18px] sm:h-[18px]" /></div>
          <p title={label} className="text-[11px] text-slate-500 font-medium uppercase tracking-wide truncate">{label}</p>
        </div>
        {clickable && <ExternalLink size={12} className="text-slate-300" />}
      </div>
      <p className="text-lg sm:text-2xl font-bold text-slate-900 tabular-nums break-words leading-tight">{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
    </div>
  );
}

export default function PayablesOverview() {
  const navigate = useNavigate();
  const { data: bankAccounts } = useApiData('/api/bank/accounts/');
  const companies = (() => {
    const m = new Map();
    for (const a of (bankAccounts || [])) {
      const code = a.company_code || '';
      if (!code) continue;
      if (!m.has(code)) m.set(code, { code, name: niceCompany(code, a.company_name) });
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  })();

  // Company + period live in the URL so opening a drill and pressing Back (or a
  // refresh / shared link) restores the same filtered view.
  const [sp, setSp] = useSearchParams();
  const { company: globalCompany } = useGlobalCompany();
  const [company, setCompany] = useState(globalCompany || sp.get('company') || '');
  useEffect(() => { setCompany(globalCompany || ''); }, [globalCompany]);
  useEffect(() => { if (!company && companies.length) setCompany(companies[0].code); }, [companies, company]);

  const period = usePeriodFilter(sp.get('period') || 'month', {
    anchor: sp.get('anchor'), customFrom: sp.get('cfrom'), customTo: sp.get('cto'),
  });
  const rangeFrom = period.range?.from || '';
  const rangeTo = period.range?.to || '';

  // Write the active filters back to the URL (replace — a filter change isn't a
  // separate history entry; only opening a drill is).
  useEffect(() => {
    const p = new URLSearchParams(sp);
    const put = (k, val, keep) => { if (keep) p.set(k, val); else p.delete(k); };
    const np = period.navProps;
    put('period', np.period, np.period && np.period !== 'all');
    put('anchor', np.anchor, np.period !== 'all' && np.period !== 'custom');
    put('cfrom', np.customFrom, np.period === 'custom');
    put('cto', np.customTo, np.period === 'custom');
    put('company', company, !!company);
    if (p.toString() !== sp.toString()) setSp(p, { replace: true });
  }, [period.navProps, company, sp, setSp]);

  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!company) { setSummary(null); return; }
    let cancelled = false;
    setLoading(true);
    const params = { company, by_month: 1 };
    if (rangeFrom && rangeTo) { params.from = rangeFrom; params.to = rangeTo; }
    apiClient.get('/api/purchase/payments-made/summary/', { params })
      .then((res) => { if (!cancelled) setSummary(res.data); })
      .catch(() => { if (!cancelled) setSummary(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [company, rangeFrom, rangeTo]);

  // Drill-through helpers → the Bills list (period-scoped where relevant) or Payments.
  const periodQS = (withPeriod) => {
    const p = new URLSearchParams();
    if (withPeriod && rangeFrom && rangeTo) { p.set('period', 'custom'); p.set('cfrom', rangeFrom); p.set('cto', rangeTo); }
    return p;
  };
  const goBills = (extra = {}, withPeriod = false) => {
    const p = periodQS(withPeriod);
    Object.entries(extra).forEach(([k, v]) => { if (v) p.set(k, v); });
    const qs = p.toString();
    navigate(`/purchase/bills${qs ? `?${qs}` : ''}`);
  };

  const rf = summary?.rollforward || {};
  const st = summary?.status || {};
  const paidN = st.paid?.count || 0, partN = st.partial?.count || 0, openN = st.open?.count || 0;
  const totalBillsN = paidN + partN + openN;
  const pct = (n) => (totalBillsN ? Math.round((n / totalBillsN) * 100) : 0);
  const months = summary?.months || [];
  const cats = summary?.by_category || [];

  return (
    <MainLayout>
      <PageHeader
        title="Payables Overview"
        subtitle="What we owed, what we paid, and what's still outstanding"
        breadcrumbs={[{ label: 'Purchase' }, { label: 'Payables Overview' }]}
      />

      {/* Company toggle + period */}
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-700">Company:</span>
          {companies.map((c) => (
            <button key={c.code} type="button" onClick={() => setCompany(c.code)}
              className={`px-4 py-1.5 rounded-lg text-sm font-semibold border transition ${company === c.code ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm' : 'bg-white text-slate-700 border-slate-300 hover:border-indigo-300 hover:text-indigo-600'}`}>
              {c.name}
            </button>
          ))}
          {!companies.length && <span className="text-xs text-slate-400">Loading…</span>}
        </div>
        <PeriodNavigator {...period.navProps} />
      </div>

      {loading && !summary && <div className="h-28 rounded-lg border border-slate-200 bg-white animate-pulse mb-4" />}

      {summary?.rollforward && (
        <>
          {/* Roll-forward strip */}
          <div className="bg-white rounded-lg border border-slate-200 p-2 mb-4 overflow-x-auto">
            <div className="flex items-stretch gap-0 min-w-[720px]">
              {[
                { l: 'Previous outstanding', v: rf.opening, op: '' },
                { l: 'Bills this period', v: rf.bills, op: '+', sub: `${summary.bills?.count || 0} bills` },
                { l: 'Paid this period', v: rf.paid, op: '−', sub: `${summary.paid?.count || 0} payments` },
                { l: 'Returns', v: rf.returns, op: '−' },
                { l: 'Outstanding now', v: rf.closing, op: '=', hi: true },
              ].map((s, i) => (
                <div key={i} className="flex items-stretch flex-1 min-w-[140px]">
                  {s.op && <div className="self-center text-lg text-slate-300 px-1">{s.op}</div>}
                  <div className={`flex-1 px-3 py-2 text-center rounded-lg ${s.hi ? 'bg-rose-50' : ''}`}>
                    <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{s.l}</div>
                    <div className={`text-base font-bold mt-1 tabular-nums ${s.hi ? 'text-rose-700' : 'text-slate-900'}`}>{fc(s.v)}</div>
                    {s.sub && <div className="text-[10px] text-slate-400 mt-0.5">{s.sub}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* KPI cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-4">
            <StatCard icon={Receipt} tone="indigo" label="Total Bills" value={summary.bills?.count || 0}
              sub={`${fc(summary.bills?.total)} billed this period`}
              onClick={() => goBills({}, true)} />
            <StatCard icon={Wallet} tone="emerald" label="Paid this period" value={fc(summary.paid?.total)}
              sub={`${summary.paid?.count || 0} payments · Linked ${fc(summary.paid?.linked)} · On-acct ${fc(summary.paid?.on_account)}`}
              onClick={() => navigate('/purchase/payments-made')} />
            <StatCard icon={CheckCircle2} tone="sky" label="Bills cleared" value={summary.cleared?.count || 0}
              sub={`${fc(summary.cleared?.amount)} fully paid this period`}
              onClick={() => goBills({ st: 'PAID' }, true)} />
            <StatCard icon={AlertCircle} tone="rose" label="Outstanding now" value={fc(summary.outstanding?.total)}
              sub={`${summary.outstanding?.count || 0} bills still owing`}
              onClick={() => goBills({})} />
          </div>

          {/* Status split + By category */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4 mb-4">
            {/* Status split */}
            <div className="bg-white rounded-lg border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="p-1.5 rounded-lg bg-slate-50 text-slate-700"><Layers size={16} /></div>
                <p className="text-[11px] text-slate-500 font-medium uppercase tracking-wide">Bills by status · {totalBillsN} this period</p>
              </div>
              <div className="h-3 rounded-full overflow-hidden flex bg-slate-100">
                <div style={{ width: `${pct(paidN)}%` }} className="bg-emerald-500" />
                <div style={{ width: `${pct(partN)}%` }} className="bg-amber-500" />
                <div style={{ width: `${pct(openN)}%` }} className="bg-rose-500" />
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {[
                  { k: 'PAID', dot: 'bg-emerald-500', lbl: 'Paid', n: paidN, bal: null },
                  { k: 'PARTIALLY_PAID', dot: 'bg-amber-500', lbl: 'Partial', n: partN, bal: st.partial?.balance },
                  { k: 'OPEN', dot: 'bg-rose-500', lbl: 'Open', n: openN, bal: st.open?.balance },
                ].map((s) => (
                  <button key={s.k} type="button" onClick={() => goBills({ st: s.k }, true)}
                    className="text-left rounded-lg border border-slate-200 p-2.5 hover:border-indigo-300 hover:shadow-sm transition">
                    <div className="flex items-center gap-1.5 text-xs text-slate-500">
                      <span className={`inline-block w-2 h-2 rounded-sm ${s.dot}`} />{s.lbl}
                    </div>
                    <div className="text-lg font-bold text-slate-900 tabular-nums">{s.n}</div>
                    {s.bal != null && <div className="text-[11px] text-slate-400">{fc(s.bal)} due</div>}
                  </button>
                ))}
              </div>
            </div>

            {/* By category */}
            <div className="bg-white rounded-lg border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="p-1.5 rounded-lg bg-indigo-50 text-indigo-700"><Receipt size={16} /></div>
                <p className="text-[11px] text-slate-500 font-medium uppercase tracking-wide">Bills by category · this period</p>
              </div>
              <div className="space-y-1.5">
                {cats.length === 0 && <div className="text-sm text-slate-400 py-2">No open bills.</div>}
                {cats.map((c) => (
                  <button key={c.key} type="button"
                    onClick={() => c.key !== 'OTHER' && goBills({ purchase_category: c.key }, true)}
                    className={`w-full flex items-center justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2 transition ${c.key !== 'OTHER' ? 'hover:border-indigo-300 hover:bg-slate-50 cursor-pointer' : 'cursor-default'}`}>
                    <span className="text-sm font-medium text-slate-700">{c.label}</span>
                    <span className="flex items-center gap-3">
                      <span className="text-xs text-slate-400">{c.count} bills</span>
                      <span className="text-sm font-bold text-slate-900 tabular-nums">{fc(c.outstanding)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Month-by-month */}
          <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100">
              <h3 className="text-sm font-bold text-slate-800">Month-by-month</h3>
              <p className="text-xs text-slate-500">Opening + purchases − payments − returns = closing. Each closing carries to the next month's opening; the last is today's outstanding.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-slate-500 bg-gradient-to-r from-primary-50/70 to-sky-50/40">
                    <th className="text-left font-medium px-5 py-2.5">Month</th>
                    <th className="text-right font-medium px-4 py-2.5">Opening</th>
                    <th className="text-right font-medium px-4 py-2.5">+ Purchases</th>
                    <th className="text-right font-medium px-4 py-2.5">− Payments</th>
                    <th className="text-right font-medium px-4 py-2.5">− Returns</th>
                    <th className="text-right font-medium px-5 py-2.5">= Closing</th>
                  </tr>
                </thead>
                <tbody>
                  {months.length === 0 && <tr><td colSpan={6} className="px-5 py-6 text-center text-slate-400">No activity this financial year.</td></tr>}
                  {months.map((m) => (
                    <tr key={m.month} className="border-t border-slate-50 hover:bg-primary-50/40 transition-colors">
                      <td className="px-5 py-2.5 font-semibold text-slate-700">{m.month}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{fc(m.opening)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{fc(m.purchases)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{fc(m.payments)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{fc(m.returns)}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums font-bold text-slate-900">{fc(m.closing)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {!loading && !summary && company && (
        <div className="py-16 text-center text-slate-500 text-sm border border-dashed border-slate-300 rounded-lg">
          Couldn't load the overview. Try again in a moment.
        </div>
      )}
    </MainLayout>
  );
}
