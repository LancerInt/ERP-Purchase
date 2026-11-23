// Purchase Dashboard (Zoho) — mirrors the Sales Dashboard UI/UX, fed with
// imported Zoho purchase data. Top 10 vendors + top 10 products (by quantity —
// the truth), a financial-year month-on-month billed-vs-paid trend, and
// exception reports. Backed by GET /api/purchase/zoho/dashboard/.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart3, Users, Package, TrendingUp, AlertTriangle, Loader2, Truck, ChevronRight,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts';
import CustomSelect from '@/components/ui/CustomSelect';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { useUrlState } from '../../../hooks/useUrlState.js';
import { fmtINR, fmtINRfull, fmtInt, fmtQty, fyStartISO, todayISO, ImportButton } from '../zoho/shared.jsx';

const VENDOR_COLOR = '#6366f1';
const PRODUCT_COLOR = '#0ea5e9';
const short = (s, n = 24) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : (s || ''));
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

// Period-navigator helpers (mirror the Sales Dashboard).
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseISO = (s) => { const [y, m, d] = (s || todayISO()).split('-').map(Number); return new Date(y, m - 1, d); };
const monthRangeOf = (a) => { const d = parseISO(a); return { from: isoOf(new Date(d.getFullYear(), d.getMonth(), 1)), to: isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0)) }; };
const weekRangeOf = (a) => { const d = parseISO(a); const dow = (d.getDay() + 6) % 7; const mon = new Date(d); mon.setDate(d.getDate() - dow); const sun = new Date(mon); sun.setDate(mon.getDate() + 6); return { from: isoOf(mon), to: isoOf(sun) }; };
const rangeFor = (period, a) => {
  const today = todayISO(); const cap = (t) => (t > today ? today : t);
  if (period === 'today') return { from: a, to: a };
  if (period === 'week') { const r = weekRangeOf(a); return { from: r.from, to: cap(r.to) }; }
  if (period === 'month') { const r = monthRangeOf(a); return { from: r.from, to: cap(r.to) }; }
  if (period === 'fy') return { from: fyStartISO(), to: today };
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

function SectionCard({ icon: Icon, title, subtitle, tone = 'slate', children }) {
  const toneCls = { slate: 'bg-slate-100 text-slate-600', indigo: 'bg-indigo-50 text-indigo-600', sky: 'bg-sky-50 text-sky-600', emerald: 'bg-emerald-50 text-emerald-600', rose: 'bg-rose-50 text-rose-600', amber: 'bg-amber-50 text-amber-600' }[tone];
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
      </div>
      {children}
    </div>
  );
}

function MoneyTooltip({ active, payload, label, valueKeys, qtyKeys }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-md px-3 py-2 text-xs">
      <p className="font-semibold text-slate-700 mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="flex items-center gap-2 tabular-nums">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-slate-500">{(valueKeys && valueKeys[p.dataKey]) || p.name}:</span>
          <span className="font-medium text-slate-800">{qtyKeys && qtyKeys[p.dataKey] ? fmtQty(p.value) : fmtINRfull(p.value)}</span>
        </p>
      ))}
    </div>
  );
}

function ExceptionTile({ icon: Icon, label, value, sub, tone }) {
  const toneCls = { rose: 'border-rose-200 bg-rose-50/40', amber: 'border-amber-200 bg-amber-50/40', blue: 'border-blue-200 bg-blue-50/40', slate: 'border-slate-200 bg-slate-50/40' }[tone] || 'border-slate-200';
  const iconCls = { rose: 'text-rose-600', amber: 'text-amber-600', blue: 'text-blue-600', slate: 'text-slate-500' }[tone] || 'text-slate-500';
  return (
    <div className={`rounded-lg border p-4 ${toneCls}`}>
      <div className="flex items-center gap-2 mb-2"><Icon size={16} className={iconCls} /><p className="text-[11px] uppercase tracking-wide text-slate-500 font-medium">{label}</p></div>
      <p className="text-xl font-bold text-slate-900 tabular-nums">{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

export default function ZohoPurchaseDashboard() {
  const navigate = useNavigate();
  // Filters live in the URL so Back / refresh / sharing restore them.
  const [period, setPeriod] = useUrlState('period', 'fy');           // default: this financial year
  const [anchor, setAnchor] = useUrlState('anchor', todayISO());
  const [from, setFrom] = useUrlState('cfrom', fyStartISO());
  const [to, setTo] = useUrlState('cto', todayISO());
  const [company, setCompany] = useUrlState('company', '');
  const [factory, setFactory] = useUrlState('factory', '');
  const [companies, setCompanies] = useState([]);
  const [factories, setFactories] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);   // bump to refetch after an import

  useEffect(() => {
    apiClient.get('/api/purchase/zoho/companies/', { params: company ? { company } : {} })
      .then((r) => { setCompanies(r.data?.companies || []); setFactories(r.data?.factories || []); }).catch(() => {});
  }, [company, reloadTick]);

  const effRange = period === 'custom' ? { from, to } : (rangeFor(period, anchor) || { from, to });
  const importF = { from: effRange.from, to: effRange.to, company };

  useEffect(() => {
    let cancelled = false; setLoading(true); setError(null);
    const p = { from: effRange.from, to: effRange.to };
    if (company) p.company = company;
    if (factory) p.factory = factory;
    apiClient.get('/api/purchase/zoho/dashboard/', { params: p })
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch((e) => { if (!cancelled) setError(e.response?.data?.detail || 'Failed to load.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, anchor, from, to, company, factory, reloadTick]);

  const vendorChart = useMemo(() => (data?.top_vendors || []).map((c) => ({ name: short(c.vendor_name), full: c.vendor_name, amount: Number(c.amount) || 0, bills: c.bill_count })), [data]);
  const prodChart = useMemo(() => (data?.top_products || []).map((p) => ({ name: short(p.product_name), full: p.product_name, qty: Number(p.qty) || 0, amount: Number(p.amount) || 0 })), [data]);
  const trendChart = useMemo(() => (data?.mom_trend || []).map((m) => ({ label: m.label.replace(' 20', " '"), billed: Number(m.billed) || 0, paid: Number(m.paid) || 0 })), [data]);
  const t = data?.totals || {};
  const exc = data?.exceptions;

  const filterBar = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex rounded-lg border border-slate-200 overflow-hidden">
        {[{ v: 'today', l: 'Today' }, { v: 'week', l: 'Week' }, { v: 'month', l: 'Month' }, { v: 'fy', l: 'This FY' }, { v: 'custom', l: 'Custom' }].map((pp, i) => (
          <button key={pp.v} type="button" onClick={() => { setPeriod(pp.v); setAnchor(todayISO()); }}
            className={`px-2.5 py-1.5 text-xs ${i > 0 ? 'border-l border-slate-200' : ''} ${period === pp.v ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>{pp.l}</button>
        ))}
      </div>
      {period === 'week' && <CustomSelect value={weekRangeOf(anchor).from} onChange={(e) => setAnchor(e.target.value)} title="Week" className="min-w-[180px]">{weekOptions().map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}</CustomSelect>}
      {period === 'month' && <CustomSelect value={monthRangeOf(anchor).from} onChange={(e) => setAnchor(e.target.value)} title="Month" className="min-w-[130px]">{monthOptions().map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</CustomSelect>}
      {period === 'custom' && (
        <div className="flex items-center gap-1.5 text-xs">
          <CustomDatePicker value={from} onChange={(e) => setFrom(e.target.value)} max={to} className="border border-slate-300 rounded px-2 py-1.5" />
          <span className="text-slate-400">to</span>
          <CustomDatePicker value={to} onChange={(e) => setTo(e.target.value)} min={from} max={todayISO()} className="border border-slate-300 rounded px-2 py-1.5" />
        </div>
      )}
      <CustomSelect value={company} onChange={(e) => { setCompany(e.target.value); setFactory(''); }} title="Company" className="min-w-[140px]">
        <option value="">All Companies</option>
        {companies.map((c) => <option key={c} value={c}>{c}</option>)}
      </CustomSelect>
      <CustomSelect value={factory} onChange={(e) => setFactory(e.target.value)} title="Factory" className="min-w-[120px]">
        <option value="">All Factories</option>
        {factories.map((c) => <option key={c} value={c}>{c}</option>)}
      </CustomSelect>
    </div>
  );

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Purchase Dashboard"
        subtitle="Top vendors & products, month-on-month trend, and exceptions"
        breadcrumbs={[{ label: 'Purchase' }, { label: 'Dashboard' }]}
        actions={{
          right: (
            <div className="flex items-center gap-2">
              <ImportButton what="bills" label="Import bills" f={importF} onDone={() => setReloadTick((t) => t + 1)} />
              <ImportButton what="freight" label="Import freight" f={importF} onDone={() => setReloadTick((t) => t + 1)} />
            </div>
          ),
          onPrint: () => window.print(),
        }}
      />

      <div className="px-3 sm:px-0 pb-10 space-y-4">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm px-4 py-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide font-medium">
              <BarChart3 size={15} /> Filters
              {effRange.from && <span className="text-slate-400 normal-case tracking-normal">· {effRange.from} → {effRange.to}</span>}
            </div>
            {filterBar}
          </div>
        </div>

        {loading && <div className="flex items-center justify-center py-20 text-slate-500"><Loader2 className="animate-spin mr-2" size={20} /> Loading…</div>}
        {error && <p className="text-sm text-rose-600 text-center py-10">{error}</p>}

        {!loading && !error && data && (
          <>
            {/* KPI tiles */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              <ExceptionTile icon={BarChart3} tone="blue" label="Total Purchase" value={fmtINR(t.total_value)} sub={`${fmtInt(t.bill_count)} bills`} />
              <ExceptionTile icon={TrendingUp} tone="slate" label="GST" value={fmtINR(t.total_gst)} />
              <ExceptionTile icon={Users} tone="slate" label="Vendors" value={fmtInt(t.vendor_count)} />
              <ExceptionTile icon={Truck} tone="amber" label="Freight" value={fmtINR(t.freight_total)} sub={`${fmtInt(t.freight_count)} records`} />
              <ExceptionTile icon={AlertTriangle} tone="rose" label="Outstanding" value={fmtINR(exc?.outstanding?.amount)} sub={`${fmtInt(exc?.outstanding?.count)} bills`} />
            </div>

            {/* Top vendors + top products */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <SectionCard icon={Users} title="Top 10 Vendors" subtitle="By purchase value this period" tone="indigo">
                {vendorChart.length === 0 ? <p className="px-5 py-10 text-sm text-slate-400 text-center">No purchases in this period.</p> : (
                  <div className="p-4">
                    <ResponsiveContainer width="100%" height={Math.max(220, vendorChart.length * 34)}>
                      <BarChart data={vendorChart} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                        <CartesianGrid horizontal={false} stroke="#f1f5f9" />
                        <XAxis type="number" tickFormatter={fmtINR} tick={{ fontSize: 11, fill: '#94a3b8' }} />
                        <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11, fill: '#475569' }} />
                        <Tooltip content={<MoneyTooltip valueKeys={{ amount: 'Purchased' }} />} cursor={{ fill: '#eef2ff' }} />
                        <Bar dataKey="amount" name="Purchased" fill={VENDOR_COLOR} radius={[0, 4, 4, 0]} barSize={16} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </SectionCard>

              <SectionCard icon={Package} title="Top 10 Products" subtitle="By quantity received this period" tone="sky">
                {prodChart.length === 0 ? <p className="px-5 py-10 text-sm text-slate-400 text-center">No purchases in this period.</p> : (
                  <div className="p-4">
                    <ResponsiveContainer width="100%" height={Math.max(220, prodChart.length * 34)}>
                      <BarChart data={prodChart} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                        <CartesianGrid horizontal={false} stroke="#f1f5f9" />
                        <XAxis type="number" tickFormatter={fmtQty} tick={{ fontSize: 11, fill: '#94a3b8' }} />
                        <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11, fill: '#475569' }} />
                        <Tooltip content={<MoneyTooltip valueKeys={{ qty: 'Quantity' }} qtyKeys={{ qty: true }} />} cursor={{ fill: '#e0f2fe' }} />
                        <Bar dataKey="qty" name="Quantity" fill={PRODUCT_COLOR} radius={[0, 4, 4, 0]} barSize={16} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </SectionCard>
            </div>

            {/* Vendor-wise breakdown table */}
            <SectionCard icon={Users} title="Top Vendors" subtitle="By purchase value this period" tone="indigo">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase text-slate-400 border-b border-slate-100">
                    <th className="px-4 py-2">Vendor</th><th className="px-3 py-2 text-right">Bills</th><th className="px-3 py-2 text-right">Purchase Value</th>
                  </tr></thead>
                  <tbody>
                    {(d.top_vendors || []).map((v, i) => (
                      <tr key={i} className="border-b last:border-0 border-slate-50 hover:bg-primary-50/40 transition-colors">
                        <td className="px-4 py-2 text-slate-800">{v.vendor_name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtInt(v.bill_count)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtINRfull(v.amount)}</td>
                      </tr>
                    ))}
                    {(d.top_vendors || []).length === 0 && <tr><td colSpan={3} className="px-4 py-4 sm:py-5 text-center text-slate-400">No vendors in this period.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-2 text-[11px] text-slate-400">Full vendor list on <button onClick={() => navigate('/purchase/dashboard')} className="text-indigo-600 hover:underline">Purchase Analytics</button>.</div>
            </SectionCard>

            {/* Month-on-month trend */}
            <SectionCard icon={TrendingUp} title="Month-on-Month Trend" subtitle="This financial year · billed vs paid" tone="emerald">
              <div className="p-4">
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={trendChart} margin={{ top: 8, right: 24, bottom: 4, left: 8 }}>
                    <CartesianGrid stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#475569' }} />
                    <YAxis tickFormatter={fmtINR} tick={{ fontSize: 11, fill: '#94a3b8' }} width={64} />
                    <Tooltip content={<MoneyTooltip valueKeys={{ billed: 'Billed', paid: 'Paid' }} />} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line type="monotone" dataKey="billed" name="Billed" stroke="#6366f1" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                    <Line type="monotone" dataKey="paid" name="Paid" stroke="#10b981" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </SectionCard>

            {/* Exceptions */}
            <SectionCard icon={AlertTriangle} title="Exception Reports" subtitle="Items that need attention" tone="rose">
              <div className="p-4 space-y-4">
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                  <ExceptionTile icon={AlertTriangle} tone="rose" label="Outstanding Bills" value={fmtInt(exc?.outstanding?.count)} sub={fmtINRfull(exc?.outstanding?.amount)} />
                  <ExceptionTile icon={Truck} tone="amber" label="Freight Unpaid" value={fmtInt(exc?.freight_unpaid?.count)} sub={fmtINRfull(exc?.freight_unpaid?.amount)} />
                  <ExceptionTile icon={BarChart3} tone="slate" label="GST (period)" value={fmtINR(t.total_gst)} sub={fmtINRfull(t.total_gst)} />
                </div>

                {exc?.outstanding_rows?.length > 0 && (
                  <div className="rounded-lg border border-slate-200 overflow-hidden">
                    <div className="px-4 py-2 bg-rose-50 border-b border-rose-100 flex items-center gap-2">
                      <AlertTriangle size={14} className="text-rose-600" /><span className="text-xs font-semibold text-rose-800">Largest outstanding bills</span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs sm:text-[13px]">
                        <thead className="bg-slate-100 text-slate-500 text-[11px] uppercase tracking-wide">
                          <tr>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">SRA No</th>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Bill No</th>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Date</th>
                            <th className="text-left px-3 py-2 font-semibold">Vendor</th>
                            <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Balance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {exc.outstanding_rows.map((r, i) => (
                            <tr key={i} className="border-t border-slate-100 odd:bg-white even:bg-slate-50/50">
                              <td className="px-3 py-2 text-slate-700 font-medium whitespace-nowrap">{r.bill_no}</td>
                              <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.invoice_no || '—'}</td>
                              <td className="px-3 py-2 text-slate-500 whitespace-nowrap tabular-nums">{fmtDate(r.bill_date)}</td>
                              <td className="px-3 py-2 text-slate-700 max-w-[240px] truncate" title={r.vendor_name}>{r.vendor_name}</td>
                              <td className="px-3 py-2 text-right font-semibold text-slate-800 tabular-nums whitespace-nowrap">{fmtINRfull(r.balance)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </SectionCard>

            <button type="button" onClick={() => navigate('/purchase/dashboard')} className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-700">
              Open Purchase Analytics <ChevronRight size={15} />
            </button>
            <p className="text-[11px] text-slate-400">Quantities are exact. Per-product value shown elsewhere is an estimate (bill total split by quantity) — money totals here are exact bill/vendor figures.</p>
          </>
        )}
      </div>
    </MainLayout>
  );
}
