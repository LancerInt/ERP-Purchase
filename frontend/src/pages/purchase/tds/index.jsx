// TDS Summary — standalone Purchase TDS page (replaces the TDS blocks that used
// to sit on the bill detail). Per vendor for a company + FY: section, rate, FY
// aggregate and TDS due, from the fresh FY 2026-27 rules (194Q 0.1% over ₹50L,
// 194C 1%/2%, 206AA 5%). Backed by GET /api/purchase/tds-summary/.
import { useEffect, useState } from 'react';
import { Loader2, Percent } from 'lucide-react';
import CustomSelect from '@/components/ui/CustomSelect';
import { CTRL_H } from '@/components/common/controls';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import { useUrlState } from '../../../hooks/useUrlState.js';
import { useGlobalCompany } from '@/hooks/useGlobalCompany.js';

const fmtFull = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtINR = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};

// Current FY (Apr–Mar) and the two before it, as {value: startYear, label}.
const fyOptions = () => {
  const now = new Date();
  const curStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return [0, 1, 2].map((d) => {
    const y = curStart - d;
    return { value: String(y), label: `FY ${y}-${String(y + 1).slice(-2)}` };
  });
};

const SECTION_CLS = {
  '194Q': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  '194C': 'bg-sky-50 text-sky-700 border-sky-200',
  '194C(6)': 'bg-slate-50 text-slate-600 border-slate-200',
  '206AA': 'bg-rose-50 text-rose-700 border-rose-200',
};

// The three TDS regimes for the dropdown. Keys match the backend (tds_regime.py).
const REGIME_OPTS = [
  { value: '', label: 'All regimes' },
  { value: 'PURCHASE', label: 'Purchase · 194Q' },
  { value: 'EXPENSE', label: 'Expense · 194C' },
  { value: 'FREIGHT', label: 'Freight · 194C' },
];

export default function TdsSummary() {
  const opts = fyOptions();
  // Filters live in the URL so Back / refresh / sharing restore them.
  const [fy, setFy] = useUrlState('fy', opts[0].value);
  // Company is driven by the GLOBAL company filter in the header — not a local
  // dropdown — so every page re-scopes together. '' = All.
  const { company: globalCompany } = useGlobalCompany();
  const company = globalCompany || '';
  const [regime, setRegime] = useUrlState('regime', '');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false; setLoading(true); setError(null);
    const p = new URLSearchParams({ fy });
    if (company) p.set('company', company);
    if (regime) p.set('regime', regime);
    apiClient.get(`/api/purchase/tds-summary/?${p.toString()}`)
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch((e) => { if (!cancelled) setError(e.response?.data?.detail || 'Failed to load TDS.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fy, company, regime]);

  return (
    <MainLayout>
      <PageHeader
        title="TDS Summary"
        subtitle="Per-vendor ERP-expected vs Tally-deducted TDS — Purchase / Expense / Freight."
        breadcrumbs={[{ label: 'Tax / Compliance' }, { label: 'TDS Summary' }]}
      />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <CustomSelect value={fy} onChange={(e) => setFy(e.target.value)} title="Financial year"
          className={`border border-slate-300 rounded-lg px-2 text-sm bg-white min-w-[150px] ${CTRL_H}`}>
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </CustomSelect>
        {/* Company comes from the global header filter — no local dropdown. */}
        {/* Regime dropdown — Purchase (194Q goods) / Expense / Freight (both 194C).
            Filters the vendor list + totals to one TDS regime. */}
        <CustomSelect value={regime} onChange={(e) => setRegime(e.target.value)} title="TDS regime"
          className={`border border-slate-300 rounded-lg px-2 text-sm bg-white min-w-[170px] ${CTRL_H}`}>
          {REGIME_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </CustomSelect>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading…</div>
      ) : error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 p-4 text-sm">{error}</div>
      ) : !data ? null : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-indigo-500">ERP expected</div>
              <div className="text-xl font-bold mt-1 text-indigo-700" title={fmtFull(data.erp_total)}>{fmtINR(data.erp_total)}</div>
            </div>
            <div className="rounded-xl border border-teal-200 bg-teal-50 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-teal-600">Tally deducted</div>
              <div className="text-xl font-bold mt-1 text-teal-700" title={fmtFull(data.tally_total)}>{fmtINR(data.tally_total)}</div>
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-600">Difference</div>
              <div className="text-xl font-bold mt-1 text-amber-700" title={fmtFull(data.difference_total)}>{fmtINR(data.difference_total)}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{data.fy?.label} · Vendors</div>
              <div className="text-xl font-bold mt-1 text-slate-900">{data.vendor_count}</div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
              <Percent size={16} className="text-slate-400" />
              <h3 className="font-bold text-slate-800">Vendor TDS</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-slate-500 text-[11px] uppercase tracking-wide bg-gradient-to-r from-primary-50/70 to-sky-50/40">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-semibold">Vendor</th>
                    <th className="text-left px-4 py-2.5 font-semibold">PAN</th>
                    <th className="text-left px-4 py-2.5 font-semibold">Section</th>
                    <th className="text-right px-4 py-2.5 font-semibold">Rate %</th>
                    <th className="text-right px-4 py-2.5 font-semibold">FY aggregate</th>
                    <th className="text-right px-4 py-2.5 font-semibold text-indigo-600">ERP TDS</th>
                    <th className="text-right px-4 py-2.5 font-semibold text-teal-600">Tally TDS</th>
                    <th className="text-right px-4 py-2.5 font-semibold text-amber-600">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.rows || []).length === 0 && (
                    <tr><td colSpan={8} className="px-4 py-10 text-center text-slate-400">No vendors with purchases this FY.</td></tr>
                  )}
                  {(data.rows || []).map((r, i) => {
                    const diff = Number(r.difference) || 0;
                    // Green when ERP and Tally agree (±₹100), else amber — the gap to chase.
                    const diffCls = Math.abs(diff) <= 100 ? 'text-emerald-600' : 'text-amber-700 font-semibold';
                    return (
                      <tr key={i} className="border-t border-slate-100" title={r.reason}>
                        <td className="px-4 py-2.5 text-slate-800">{r.vendor}</td>
                        <td className="px-4 py-2.5 text-slate-500 tabular-nums">{r.pan}</td>
                        <td className="px-4 py-2.5">
                          <span className={`text-[11px] font-medium border rounded px-1.5 py-0.5 ${SECTION_CLS[r.section] || 'bg-slate-50 text-slate-600 border-slate-200'}`}>{r.section}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{r.rate_pct}%</td>
                        <td className="px-4 py-2.5 text-right tabular-nums" title={fmtFull(r.fy_aggregate)}>{fmtINR(r.fy_aggregate)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-indigo-700" title={fmtFull(r.erp_tds)}>{fmtINR(r.erp_tds)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-teal-700" title={fmtFull(r.tally_tds)}>{fmtINR(r.tally_tds)}</td>
                        <td className={`px-4 py-2.5 text-right tabular-nums ${diffCls}`} title={fmtFull(r.difference)}>{fmtINR(r.difference)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="px-4 py-2 text-[11px] text-slate-400 border-t border-slate-100">
              <b>ERP TDS</b> = engine's expected (194Q 0.1% over ₹50L · 194C 1% individual/MSME, 2% company, ≥₹30k · 206AA 5%). <b>Tally TDS</b> = actually deducted (imported TDS Payable). Difference chases the gap. Reporting only.
            </p>
          </div>
        </>
      )}
    </MainLayout>
  );
}
