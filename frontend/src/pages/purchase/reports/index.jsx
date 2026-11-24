// Consolidated Report — one cross-module financial overview (Sales, Purchase,
// Expense, Freight, Payment) for a chosen company + period. Six summary cards,
// a Profit & Loss table (ex-GST default, incl-GST toggle) and a Billed/Settled/
// Outstanding module-totals table. Backed by GET /api/purchase/report/consolidated/,
// which assembles the figures from the existing Tally-reconciled dashboards.
import { useEffect, useState } from 'react';
import { Loader2, TrendingUp, TrendingDown } from 'lucide-react';
import CustomSelect from '@/components/ui/CustomSelect';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import { CTRL_H } from '@/components/common/controls';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { usePurchaseFilter } from '../components/purchaseFilter.js';

const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtINR = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};
const fmtFull = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Card tone → tailwind classes (matches the app's good/alert conventions).
const TONE = {
  neutral: 'bg-white border-slate-200',
  good: 'bg-emerald-50 border-emerald-200',
  alert: 'bg-rose-50 border-rose-200',
};
const VAL_TONE = { neutral: 'text-slate-900', good: 'text-emerald-700', alert: 'text-rose-700' };

const CARD_ORDER = [
  ['sales', 'Sales'], ['purchase', 'Purchase'], ['expense', 'Expense'],
  ['receivables', 'Receivables'], ['payables', 'Payables'], ['pnl', 'Profit & Loss'],
];

export default function ConsolidatedReport() {
  const f = usePurchaseFilter({ period: 'fy' });
  const period = f.get('period', 'fy');
  const from = f.get('from', todayISO());
  const to = f.get('to', todayISO());
  const companyId = f.get('company');

  const [basis, setBasis] = useState('exgst');   // 'exgst' | 'inclgst'
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const { options: companyOptions } = useLookup('/api/companies/');

  useEffect(() => {
    let cancelled = false; setLoading(true); setError(null);
    const p = new URLSearchParams();
    if (period === 'custom') { p.set('period', 'custom'); p.set('from', from); p.set('to', to); }
    else p.set('period', period);
    if (companyId) p.set('company', companyId);
    apiClient.get(`/api/purchase/report/consolidated/?${p.toString()}`)
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch((e) => { if (!cancelled) setError(e.response?.data?.detail || 'Failed to load the report.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period, from, to, companyId]);

  const pnl = data?.pnl?.[basis];
  const isProfit = pnl?.is_profit;

  const filterBar = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex rounded-lg border border-slate-200 overflow-hidden">
        {[{ v: 'month', l: 'Month' }, { v: 'fy', l: 'FY' }, { v: 'custom', l: 'Custom' }].map((pp, i) => (
          <button key={pp.v} type="button" onClick={() => f.setFilter({ period: pp.v })}
            className={`px-2.5 text-xs inline-flex items-center ${CTRL_H} ${i > 0 ? 'border-l border-slate-200' : ''} ${period === pp.v ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>{pp.l}</button>
        ))}
      </div>
      {period === 'custom' && (
        <div className="flex items-center gap-1.5 text-xs">
          <CustomDatePicker value={from} onChange={(e) => f.setFilter({ from: e.target.value })} max={to} className="border border-slate-300 rounded px-2 py-1.5" />
          <span className="text-slate-400">to</span>
          <CustomDatePicker value={to} onChange={(e) => f.setFilter({ to: e.target.value })} min={from} max={todayISO()} className="border border-slate-300 rounded px-2 py-1.5" />
        </div>
      )}
      <CustomSelect value={companyId || ''} onChange={(e) => f.setFilter({ company: e.target.value })} title="Company"
        className={`border border-slate-300 rounded-lg px-2 text-sm bg-white min-w-[180px] ${CTRL_H}`}>
        <option value="">All Companies</option>
        {(companyOptions || []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </CustomSelect>
      {/* ex-GST / incl-GST toggle for the P&L figures */}
      <div className="flex rounded-lg border border-slate-200 overflow-hidden ml-auto">
        {[{ v: 'exgst', l: 'Ex-GST' }, { v: 'inclgst', l: 'Incl-GST' }].map((b, i) => (
          <button key={b.v} type="button" onClick={() => setBasis(b.v)}
            className={`px-2.5 text-xs inline-flex items-center ${CTRL_H} ${i > 0 ? 'border-l border-slate-200' : ''} ${basis === b.v ? 'bg-slate-800 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>{b.l}</button>
        ))}
      </div>
    </div>
  );

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Consolidated Report"
        subtitle="Sales, purchase, expense, freight & payments — one financial view."
        breadcrumbs={[{ label: 'Purchase', href: '/purchase/dashboard' }, { label: 'Reports' }]}
      />
      <div className="mb-4">{filterBar}</div>

      {loading ? (
        <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading…</div>
      ) : error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 p-4 text-sm">{error}</div>
      ) : !data ? null : (
        <>
          {data.period?.label && (
            <p className="text-xs text-slate-500 mb-3">Period: <b>{data.period.label}</b> · {data.period.from} → {data.period.to}</p>
          )}

          {/* ── Six summary cards ─────────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-5">
            {CARD_ORDER.map(([key, label]) => {
              const c = data.cards?.[key]; if (!c) return null;
              const tone = c.tone || 'neutral';
              return (
                <div key={key} className={`rounded-xl border p-4 ${TONE[tone]}`}>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
                  <div className={`text-xl font-bold mt-1 ${VAL_TONE[tone]}`} title={fmtFull(c.value)}>{fmtINR(c.value)}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">{c.foot}</div>
                </div>
              );
            })}
          </div>

          {/* ── Profit & Loss ─────────────────────────────────────────────── */}
          {pnl && (
            <div className="rounded-xl border border-slate-200 bg-white mb-5 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
                <h3 className="font-bold text-slate-800">Profit &amp; Loss — {basis === 'exgst' ? 'ex-GST' : 'incl-GST'}</h3>
                <span className={`inline-flex items-center gap-1 text-xs font-semibold rounded px-2 py-1 ${isProfit ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                  {isProfit ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                  {isProfit ? 'PROFIT' : 'LOSS'} {fmtINR(pnl.operating_profit)}
                </span>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  <PnlRow label="Sales revenue" value={pnl.sales_revenue} />
                  <PnlRow label="Less: Purchases (RM + Packing)" value={pnl.less_purchases} neg />
                  <PnlRow label="Gross margin" value={pnl.gross_margin} strong
                    note={data.cards?.sales && Number(pnl.sales_revenue) ? `${Math.round(Number(pnl.gross_margin) / Number(pnl.sales_revenue) * 100)}% of sales` : ''} />
                  <PnlRow label="Less: Direct expenses" value={pnl.less_direct_expenses} neg />
                  <PnlRow label="Less: Indirect expenses" value={pnl.less_indirect_expenses} neg />
                  <PnlRow label="Less: Freight (all flows)" value={pnl.less_freight} neg />
                  <PnlRow label={`Operating ${isProfit ? 'profit' : 'loss'}`} value={pnl.operating_profit} total pos={isProfit} />
                </tbody>
              </table>
            </div>
          )}

          {/* ── Module totals ─────────────────────────────────────────────── */}
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100"><h3 className="font-bold text-slate-800">Module totals</h3></div>
            <table className="w-full text-sm">
              <thead className="text-slate-500 text-xs uppercase tracking-wide bg-gradient-to-r from-primary-50/70 to-sky-50/40">
                <tr><th className="text-left px-4 py-2 font-medium">Module</th>
                  <th className="text-right px-4 py-2 font-medium">Billed</th>
                  <th className="text-right px-4 py-2 font-medium">Settled</th>
                  <th className="text-right px-4 py-2 font-medium">Outstanding</th></tr>
              </thead>
              <tbody>
                {(data.module_totals || []).map((r) => (
                  <tr key={r.module} className="border-t border-slate-100">
                    <td className="px-4 py-2 text-slate-700">{r.module}</td>
                    <td className="px-4 py-2 text-right tabular-nums" title={fmtFull(r.billed)}>{fmtINR(r.billed)}</td>
                    <td className="px-4 py-2 text-right tabular-nums" title={fmtFull(r.settled)}>{fmtINR(r.settled)}</td>
                    <td className="px-4 py-2 text-right tabular-nums" title={fmtFull(r.outstanding)}>{fmtINR(r.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-4 py-2 text-[11px] text-slate-400 border-t border-slate-100">
              "Settled" means collected (Sales) / paid (Purchase, Freight). Outstanding is an as-of snapshot; Billed is period activity.
            </p>
          </div>
        </>
      )}
    </MainLayout>
  );
}

function PnlRow({ label, value, neg, pos, strong, total, note }) {
  const v = Number(value) || 0;
  const amount = neg ? `(${fmtFull(Math.abs(v))})` : fmtFull(Math.abs(v));
  return (
    <tr className={`border-t border-slate-100 ${strong ? 'font-semibold bg-slate-50' : ''} ${total ? 'font-bold border-t-2 border-slate-300' : ''}`}>
      <td className="px-4 py-2 text-slate-700">{label}</td>
      <td className="px-4 py-1 text-[11px] text-slate-400">{note || ''}</td>
      <td className={`px-4 py-2 text-right tabular-nums ${neg ? 'text-rose-600' : total ? (pos ? 'text-emerald-700' : 'text-rose-700') : 'text-slate-900'}`} title={fmtFull(v)}>
        {total && !pos ? `(${fmtFull(Math.abs(v))})` : amount}
      </td>
    </tr>
  );
}
