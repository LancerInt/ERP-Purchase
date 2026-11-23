// Bank Dashboard (analytics) — the cash-flow companion to the Purchase/Sales
// dashboards. Company chips + period filter, top customers (by receipts) & top
// suppliers (by payments), a month-on-month received-vs-paid trend, and per-bank
// balances. Backed by GET /api/bank/accounts/analytics/.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Wallet, ArrowDownLeft, ArrowUpRight, TrendingUp, Users, Package,
  Landmark, BarChart3, Loader2,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts';
import CustomSelect from '@/components/ui/CustomSelect';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import StatsCard from '../../../components/common/StatsCard';
import apiClient from '../../../utils/api.js';
import useApiData from '../../../hooks/useApiData.js';
import { useUrlState } from '../../../hooks/useUrlState.js';
import BankImports from '../BankImports.jsx';
import BankCompanyChips from '../BankCompanyChips.jsx';

const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtINR = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};
const fmtINRfull = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const short = (s, n = 24) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : (s || ''));

const RECV_COLOR = '#10b981';   // emerald (money in)
const PAY_COLOR = '#6366f1';    // indigo  (money out)

// Period-navigator helpers (mirrors Purchase/Sales analytics).
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseISO = (s) => { const [y, m, d] = (s || todayISO()).split('-').map(Number); return new Date(y, m - 1, d); };
const monthRangeOf = (a) => { const d = parseISO(a); return { from: isoOf(new Date(d.getFullYear(), d.getMonth(), 1)), to: isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0)) }; };
const weekRangeOf = (a) => { const d = parseISO(a); const dow = (d.getDay() + 6) % 7; const mon = new Date(d); mon.setDate(d.getDate() - dow); const sun = new Date(mon); sun.setDate(mon.getDate() + 6); return { from: isoOf(mon), to: isoOf(sun) }; };
// Indian financial year: 1 Apr → 31 Mar. Jan–Mar belong to the FY that
// STARTED the previous calendar year (mirrors Purchase/Sales analytics). The FY
// anchor carries the explicit window as "FROM..TO" since a single date can't say
// whether the user picked the whole year or just one half.
const fyStartYearOf = (d) => (d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1);
const FY_SEP = '..';
const fyRangeOf = (token) => { const [f, t] = String(token || '').split(FY_SEP); return { from: f, to: t }; };
const fyLabel = (y) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
const fyTokenFor = (d) => { const y = fyStartYearOf(d); return `${y}-04-01${FY_SEP}${y + 1}-03-31`; };
const fyOptions = (count = 3) => {
  const today = todayISO();
  const cy = fyStartYearOf(new Date()); const out = [];
  for (let i = 0; i < count; i++) {
    const y = cy - i; const l = fyLabel(y);
    out.push({ value: `${y}-04-01${FY_SEP}${y + 1}-03-31`, label: i === 0 ? `FY ${l} (to date)` : `FY ${l}` });
    out.push({ value: `${y}-04-01${FY_SEP}${y}-09-30`,     label: `FY ${l} · H1 Apr–Sep` });
    out.push({ value: `${y}-10-01${FY_SEP}${y + 1}-03-31`, label: `FY ${l} · H2 Oct–Mar` });
  }
  // Drop windows that haven't started yet (e.g. H2 of the current FY in August).
  return out.filter((o) => fyRangeOf(o.value).from <= today);
};
const rangeFor = (period, aRaw) => {
  const today = todayISO(); const cap = (t) => (t > today ? today : t);
  // period + anchor can arrive mismatched (FY carries a "FROM..TO" token, the
  // others a plain date) — normalise so the wrong parser never builds a bad range.
  const mismatched = String(aRaw).includes(FY_SEP) !== (period === 'fy');
  const a = mismatched ? (period === 'fy' ? fyTokenFor(new Date()) : today) : aRaw;
  if (period === 'today') return { from: a, to: a };
  if (period === 'week') { const r = weekRangeOf(a); return { from: r.from, to: cap(r.to) }; }
  if (period === 'month') { const r = monthRangeOf(a); return { from: r.from, to: cap(r.to) }; }
  if (period === 'fy') {
    // Cap at today only once the window has started, so the current FY reads
    // "1 Apr → today" without inverting a not-yet-started half.
    const r = fyRangeOf(a);
    return { from: r.from, to: (r.from <= today && r.to > today) ? today : r.to };
  }
  return null;
};
const monthOptions = (count = 12) => {
  const now = new Date(); const out = [];
  for (let i = 0; i < count; i++) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); out.push({ value: isoOf(d), label: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) }); }
  return out;
};
const weekOptions = (count = 10) => {
  const now = new Date(); const dow = (now.getDay() + 6) % 7; const thisMon = new Date(now); thisMon.setDate(now.getDate() - dow); const out = [];
  for (let i = 0; i < count; i++) { const mon = new Date(thisMon); mon.setDate(thisMon.getDate() - i * 7); const sun = new Date(mon); sun.setDate(mon.getDate() + 6); const lbl = `${mon.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} – ${sun.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`; out.push({ value: isoOf(mon), label: i === 0 ? `${lbl} (this week)` : lbl }); }
  return out;
};

function SectionCard({ icon: Icon, title, subtitle, tone = 'slate', children, right }) {
  const toneCls = {
    slate: 'bg-slate-100 text-slate-600', indigo: 'bg-indigo-50 text-indigo-600',
    sky: 'bg-sky-50 text-sky-600', emerald: 'bg-emerald-50 text-emerald-600',
    blue: 'bg-blue-50 text-blue-600', amber: 'bg-amber-50 text-amber-600',
  }[tone];
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-slate-100">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`p-1.5 rounded-lg shrink-0 ${toneCls}`}><Icon size={17} /></span>
          <div className="min-w-0">
            <h2 className="text-sm sm:text-base font-semibold text-slate-800 truncate">{title}</h2>
            {subtitle && <p className="text-[11px] text-slate-500 truncate">{subtitle}</p>}
          </div>
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function MoneyTooltip({ active, payload, label, valueKeys }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-md px-3 py-2 text-xs">
      <p className="font-semibold text-slate-700 mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="flex items-center gap-2 tabular-nums">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-slate-500">{(valueKeys && valueKeys[p.dataKey]) || p.name}:</span>
          <span className="font-medium text-slate-800">{fmtINRfull(p.value)}</span>
        </p>
      ))}
    </div>
  );
}

export default function BankDashboard() {
  // Domain filters live in the URL so Back / refresh / sharing restore the same
  // view. Each is a drop-in for the useState it replaces (value is a string;
  // setting back to the default clears the param).
  const [period, setPeriod] = useUrlState('period', 'month');
  const [anchor, setAnchor] = useUrlState('anchor', todayISO());
  const [from, setFrom] = useUrlState('from', todayISO());
  const [to, setTo] = useUrlState('to', todayISO());
  const [companyId, setCompanyId] = useUrlState('company', '');
  const [bankId, setBankId] = useUrlState('bank', '');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);

  const { data: accountsRaw } = useApiData('/api/bank/accounts/');
  const bankAccounts = accountsRaw || [];

  const usePastWindow = period !== 'custom' && period !== 'today' && anchor !== todayISO();
  const effRange = period === 'custom' ? { from, to } : (rangeFor(period, anchor) || { from, to });

  useEffect(() => {
    let cancelled = false; setLoading(true); setError(null);
    const p = new URLSearchParams();
    if (period === 'custom' || usePastWindow) {
      p.set('period', 'custom'); p.set('from', effRange.from); p.set('to', effRange.to);
    } else {
      p.set('period', period);
    }
    if (companyId) p.set('company', companyId);
    if (bankId) p.set('bank_account', bankId);
    apiClient.get(`/api/bank/accounts/analytics/?${p.toString()}`)
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch((e) => { if (!cancelled) setError(e.response?.data?.detail || 'Failed to load analytics.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period, anchor, from, to, companyId, bankId, reloadTick]);

  const t = data?.totals || {};
  const custChart = useMemo(() => (data?.top_customers || []).map((c) => ({
    name: short(c.customer_name), full: c.customer_name, amount: Number(c.total) || 0,
  })), [data]);
  const suppChart = useMemo(() => (data?.top_suppliers || []).map((v) => ({
    name: short(v.vendor_name), full: v.vendor_name, amount: Number(v.total) || 0,
  })), [data]);
  const trendChart = useMemo(() => (data?.mom_trend || []).map((m) => ({
    label: m.label.replace(' 20', " '"), received: Number(m.received) || 0, paid: Number(m.paid) || 0,
  })), [data]);
  const byBank = data?.by_bank || [];
  const maxBal = Math.max(1, ...byBank.map((b) => Math.abs(Number(b.current_balance) || 0)));

  // Bank-account picker, scoped to the selected company.
  const bankOptions = useMemo(() => (
    (companyId ? bankAccounts.filter((a) => String(a.company) === String(companyId)) : bankAccounts)
      .map((a) => ({ value: a.id, label: `${a.bank_name}${a.branch ? ' · ' + a.branch : ''} (${a.code})` }))
  ), [bankAccounts, companyId]);

  const onCompanyChange = (v) => { setCompanyId(v); setBankId(''); };

  const exportRows = () => [
    ['Bank Account', 'Branch', 'Category', 'Received (period)', 'Paid (period)', 'Balance'],
    ...byBank.map((b) => [`${b.bank_name} (${b.code})`, b.branch, b.category, b.received, b.paid, b.current_balance]),
  ];

  const filterBar = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex rounded-lg border border-slate-200 overflow-hidden">
        {[{ v: 'today', l: 'Today' }, { v: 'week', l: 'Week' }, { v: 'month', l: 'Month' }, { v: 'fy', l: 'FY' }, { v: 'custom', l: 'Custom' }].map((pp, i) => (
          <button key={pp.v} type="button" onClick={() => { setPeriod(pp.v); setAnchor(pp.v === 'fy' ? fyTokenFor(new Date()) : todayISO()); }}
            title={pp.v === 'fy' ? 'Financial year (1 Apr – 31 Mar)' : undefined}
            className={`px-2.5 py-1.5 text-xs ${i > 0 ? 'border-l border-slate-200' : ''} ${period === pp.v ? 'bg-blue-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>{pp.l}</button>
        ))}
      </div>
      {period === 'fy' && (
        <CustomSelect value={anchor} onChange={(e) => setAnchor(e.target.value)} title="Select financial year / half"
          className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm bg-white min-w-[190px]">
          {fyOptions().map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </CustomSelect>
      )}
      {period === 'week' && (
        <CustomSelect value={weekRangeOf(anchor).from} onChange={(e) => setAnchor(e.target.value)} title="Select week"
          className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm bg-white min-w-[180px]">
          {weekOptions().map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
        </CustomSelect>
      )}
      {period === 'month' && (
        <CustomSelect value={monthRangeOf(anchor).from} onChange={(e) => setAnchor(e.target.value)} title="Select month"
          className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm bg-white min-w-[130px]">
          {monthOptions().map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </CustomSelect>
      )}
      {period === 'custom' && (
        <div className="flex items-center gap-1.5 text-xs">
          <CustomDatePicker value={from} onChange={(e) => setFrom(e.target.value)} max={to} className="border border-slate-300 rounded px-2 py-1.5" />
          <span className="text-slate-400">to</span>
          <CustomDatePicker value={to} onChange={(e) => setTo(e.target.value)} min={from} max={todayISO()} className="border border-slate-300 rounded px-2 py-1.5" />
        </div>
      )}
      <CustomSelect value={bankId} onChange={(e) => setBankId(e.target.value)}
        className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm bg-white min-w-[170px]">
        <option value="">All bank accounts</option>
        {bankOptions.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
      </CustomSelect>
    </div>
  );

  const breadcrumbs = [{ label: 'Bank', href: '/bank/dashboard' }, { label: 'Dashboard' }];

  return (
    <MainLayout>
      <PageHeader
        title="Bank Dashboard"
        breadcrumbs={breadcrumbs}
        actions={{
          right: <BankImports entity="dashboard" exportRows={exportRows} exportName="bank-dashboard.csv" onImported={() => setReloadTick((x) => x + 1)} />,
        }}
      />

      <div className="px-3 sm:px-0 pb-10 space-y-4">
        {/* Company chips */}
        <BankCompanyChips options={data?.companies || []} value={companyId} onChange={onCompanyChange} />

        {/* Filters */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm px-4 py-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide font-medium">
              <BarChart3 size={15} /> Filters
              {data?.period?.from && (
                <span className="text-slate-400 normal-case tracking-normal">· {data.period.label} ({data.period.from} → {data.period.to})</span>
              )}
            </div>
            {filterBar}
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-20 text-slate-500">
            <Loader2 className="animate-spin mr-2" size={20} /> Loading analytics…
          </div>
        )}
        {error && <p className="text-sm text-rose-600 text-center py-10">{error}</p>}

        {!loading && !error && data && (
          <>
            {/* Stat cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatsCard icon={ArrowDownLeft} label="Received" value={fmtINR(t.received)} />
              <StatsCard icon={ArrowUpRight} label="Paid" value={fmtINR(t.paid)} />
              <StatsCard icon={TrendingUp} label="Net Cash Flow" value={fmtINR(t.net)} />
              <StatsCard icon={Wallet} label="Bank Balance" value={fmtINR(t.balance)} />
            </div>

            {/* Top customers + top suppliers */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <SectionCard icon={Users} title="Top 10 Customers" subtitle="By receipts this period" tone="emerald">
                {custChart.length === 0
                  ? <p className="px-5 py-10 text-sm text-slate-400 text-center">No receipts in this period.</p>
                  : (
                    <div className="p-4">
                      <ResponsiveContainer width="100%" height={Math.max(220, custChart.length * 34)}>
                        <BarChart data={custChart} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                          <CartesianGrid horizontal={false} stroke="#f1f5f9" />
                          <XAxis type="number" tickFormatter={fmtINR} tick={{ fontSize: 11, fill: '#94a3b8' }} />
                          <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11, fill: '#475569' }} />
                          <Tooltip content={<MoneyTooltip valueKeys={{ amount: 'Received' }} />} cursor={{ fill: '#ecfdf5' }} />
                          <Bar dataKey="amount" name="Received" fill={RECV_COLOR} radius={[0, 4, 4, 0]} barSize={16} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
              </SectionCard>

              <SectionCard icon={Package} title="Top 10 Suppliers" subtitle="By payments this period" tone="indigo">
                {suppChart.length === 0
                  ? <p className="px-5 py-10 text-sm text-slate-400 text-center">No payments in this period.</p>
                  : (
                    <div className="p-4">
                      <ResponsiveContainer width="100%" height={Math.max(220, suppChart.length * 34)}>
                        <BarChart data={suppChart} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                          <CartesianGrid horizontal={false} stroke="#f1f5f9" />
                          <XAxis type="number" tickFormatter={fmtINR} tick={{ fontSize: 11, fill: '#94a3b8' }} />
                          <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11, fill: '#475569' }} />
                          <Tooltip content={<MoneyTooltip valueKeys={{ amount: 'Paid' }} />} cursor={{ fill: '#eef2ff' }} />
                          <Bar dataKey="amount" name="Paid" fill={PAY_COLOR} radius={[0, 4, 4, 0]} barSize={16} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
              </SectionCard>
            </div>

            {/* Month-on-month trend */}
            <SectionCard icon={TrendingUp} title="Month-on-Month Trend" subtitle="This financial year (Apr onward) · received vs paid" tone="blue">
              <div className="p-4">
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={trendChart} margin={{ top: 8, right: 24, bottom: 4, left: 8 }}>
                    <CartesianGrid stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#475569' }} />
                    <YAxis tickFormatter={fmtINR} tick={{ fontSize: 11, fill: '#94a3b8' }} width={64} />
                    <Tooltip content={<MoneyTooltip valueKeys={{ received: 'Received', paid: 'Paid' }} />} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line type="monotone" dataKey="received" name="Received" stroke={RECV_COLOR} strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                    <Line type="monotone" dataKey="paid" name="Paid" stroke={PAY_COLOR} strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </SectionCard>

            {/* Balance by account */}
            <SectionCard icon={Landmark} title="Balance by Account" tone="slate"
              subtitle={`${t.account_count || 0} accounts · ${t.receipt_count || 0} receipts / ${t.payment_count || 0} payments this period`}
              right={<Link to="/bank/accounts" className="text-sm text-blue-600 hover:text-blue-800 whitespace-nowrap">View all</Link>}>
              <div className="p-4 sm:p-5 space-y-4">
                {byBank.length === 0 && <p className="text-sm text-slate-400">No bank accounts yet.</p>}
                {byBank.map((b) => (
                  <div key={b.id}>
                    <div className="flex justify-between text-sm mb-1.5 gap-3">
                      <span className="text-slate-600 truncate">
                        {b.bank_name}{b.branch ? ` · ${b.branch}` : ''}
                        <span className="text-xs text-slate-400"> ({b.category === 'PRIMARY' ? 'P' : 'S'})</span>
                        <span className="text-[11px] text-emerald-600 ml-2">▲ {fmtINR(b.received)}</span>
                        <span className="text-[11px] text-indigo-600 ml-1.5">▼ {fmtINR(b.paid)}</span>
                      </span>
                      <span className="font-medium text-slate-900 tabular-nums whitespace-nowrap">{fmtINRfull(b.current_balance)}</span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${Number(b.current_balance) < 0 ? 'bg-rose-400' : 'bg-blue-500'}`}
                        style={{ width: `${(Math.abs(Number(b.current_balance) || 0) / maxBal) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          </>
        )}
      </div>
    </MainLayout>
  );
}
