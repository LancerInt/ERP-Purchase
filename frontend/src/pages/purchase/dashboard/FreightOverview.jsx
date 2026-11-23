/**
 * Freight Overview — the Exec freight dashboard that the Purchase Analytics
 * "Freight" tile opens. Unifies the two ways inward freight reaches us:
 *   On-bill   — freight bundled on a goods (RM) purchase bill (VendorBill.other_charges)
 *   Separate  — a standalone transporter slip (FreightAdviceInbound SEPARATE_SLIP)
 * …into one management view: the split, a per-transporter leaderboard, the
 * highest-freight purchases, and an unmatched-slip alert. Reporting-only; reads
 * /api/purchase/freight-overview/ (same figures as the Freight Inward page and
 * the operator freight module).
 *
 * Exported:
 *   <FreightTile …/>            — the KPI tile on the Purchase Analytics grid
 *   <FreightOverviewScreen …/>  — the in-page Exec screen the tile opens
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Truck, AlertTriangle, ExternalLink, Package, Loader2 } from 'lucide-react';
import apiClient from '../../../utils/api.js';

const fmtINR = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Compact form for the hero / leaderboard bars (₹8.42L, ₹1.3Cr).
const fmtShort = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${n.toLocaleString('en-IN')}`;
};

// Shared fetch — both the tile and the screen read the same endpoint, scoped to
// the dashboard's current company + date window.
const useFreightOverview = (companyId, from, to, vendorId) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    const qp = new URLSearchParams();
    if (companyId) qp.set('company', companyId);
    if (from) qp.set('from', from);
    if (to) qp.set('to', to);
    if (vendorId) qp.set('vendor', vendorId);
    apiClient.get(`/api/purchase/freight-overview/?${qp.toString()}`)
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch((e) => { if (!cancelled) setError(e.response?.data?.detail || 'Failed to load freight'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [companyId, from, to, vendorId]);
  return { data, loading, error };
};

/* ─────────────────────────── The tile ─────────────────────────── */

export function FreightTile({ companyId, from, to, vendorId, onClick }) {
  // `error` is read, not discarded. The endpoint is gated on the "Freight
  // Inward" module, so a role without it gets 403 — and dropping the error
  // left `total` undefined, which rendered as Rs 0.00. That is a FACTUAL
  // CLAIM the app cannot support: it says this company had no freight, when
  // what happened is that nobody asked. Office Management read Rs 0.00 while
  // an admin on the same filters read Rs 79,91,806.90.
  const { data, loading, error } = useFreightOverview(companyId, from, to, vendorId);
  const total = data?.total_freight;
  const denied = !!error && !data;
  return (
    <div
      className="min-w-0 bg-white rounded-lg border border-slate-200 p-3 sm:p-4 hover:shadow-md hover:border-indigo-300 transition cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-300"
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } }}
      role="button" tabIndex={0}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5 sm:mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="p-1.5 sm:p-2 rounded-lg shrink-0 bg-sky-50 text-sky-700"><Truck size={16} className="sm:w-[18px] sm:h-[18px]" /></div>
          <p title="Freight" className="text-[11px] text-slate-500 font-medium uppercase tracking-wide truncate">Freight</p>
        </div>
        <ExternalLink size={12} className="text-slate-300" />
      </div>
      <p className="text-lg sm:text-2xl font-bold text-slate-900 tabular-nums break-words leading-tight">
        {loading
          ? <Loader2 size={20} className="animate-spin text-slate-300" />
          : denied
            ? <span className="text-base font-semibold text-slate-400">—</span>
            : fmtINR(total)}
      </p>
      {denied && (
        <p className="text-[11px] text-slate-400 mt-1 leading-snug">
          No access to freight figures — needs the “Freight Inward” permission.
        </p>
      )}
      {!loading && data && (
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-sky-50 text-sky-700" title="Freight bundled on purchase bills">
            <span className="font-normal opacity-75 mr-1">On-bill</span><span className="tabular-nums">{fmtShort(data.onbill_total)}</span>
          </span>
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700" title="Separate transporter slips">
            <span className="font-normal opacity-75 mr-1">Separate</span><span className="tabular-nums">{fmtShort(data.separate_total)}</span>
          </span>
          {data.unmatched?.count > 0 && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-700" title="Separate slips not yet linked to a purchase bill">
              <span className="font-normal opacity-75 mr-1">⚠</span><span className="tabular-nums">{data.unmatched.count} unmatched</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────── The Exec screen ─────────────────────── */

const MODES = [
  { key: 'total', label: 'Total' },
  { key: 'onbill', label: 'On-bill' },
  { key: 'separate', label: 'Separate' },
];

export function FreightOverviewScreen({ companyId, from, to, vendorId }) {
  const { data, loading, error } = useFreightOverview(companyId, from, to, vendorId);
  const [mode, setMode] = useState('total');

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-10 flex items-center justify-center text-slate-400 gap-2">
        <Loader2 size={18} className="animate-spin" /> Loading freight…
      </div>
    );
  }
  if (error) {
    return (
      <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl p-4 text-sm flex items-center gap-2">
        <AlertTriangle size={15} /> {error}
      </div>
    );
  }
  if (!data) return null;

  const onbill = Number(data.onbill_total) || 0;
  const separate = Number(data.separate_total) || 0;
  const total = Number(data.total_freight) || 0;
  const onbillPct = data.onbill_pct || 0;
  const separatePct = data.separate_pct || 0;
  const heroValue = mode === 'onbill' ? onbill : mode === 'separate' ? separate : total;
  const heroLabel = mode === 'onbill' ? 'On-bill freight' : mode === 'separate' ? 'Separate freight' : 'Total freight';
  const unmatched = data.unmatched || { count: 0, amount: '0.00', rows: [] };
  const maxTrans = Math.max(1, ...(data.by_transporter || []).map((t) => Number(t.amount) || 0));

  return (
    <div className="space-y-4">
      {/* Hero + unmatched */}
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 p-5">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
            <p className="text-[11px] uppercase tracking-wide text-slate-500 font-medium">{heroLabel}</p>
            {/* View toggle — On-bill / Separate / Total, like the planned tile toggle */}
            <div className="flex gap-0.5 bg-slate-100 rounded-lg p-0.5">
              {MODES.map((m) => (
                <button key={m.key} type="button" onClick={() => setMode(m.key)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition ${mode === m.key ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <p className="text-3xl sm:text-4xl font-bold text-slate-900 tabular-nums mb-3">{fmtINR(heroValue)}</p>
          {/* Split bar */}
          <div className="h-6 rounded-lg overflow-hidden flex text-[11px] font-semibold text-white bg-slate-100">
            {onbillPct > 0 && (
              <div className={`bg-sky-500 flex items-center justify-center transition-opacity ${mode === 'separate' ? 'opacity-40' : ''}`}
                style={{ width: `${onbillPct}%` }} title={`On-bill ${fmtINR(onbill)}`}>
                {onbillPct >= 10 ? `On-bill ${onbillPct}%` : ''}
              </div>
            )}
            {separatePct > 0 && (
              <div className={`bg-emerald-500 flex items-center justify-center transition-opacity ${mode === 'onbill' ? 'opacity-40' : ''}`}
                style={{ width: `${separatePct}%` }} title={`Separate ${fmtINR(separate)}`}>
                {separatePct >= 10 ? `Separate ${separatePct}%` : ''}
              </div>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-2">
            On-bill {fmtINR(onbill)} &nbsp;·&nbsp; Separate {fmtINR(separate)} &nbsp;·&nbsp; {data.shipment_count} shipment(s)
            {Number(data.separate_pending) > 0 && <> &nbsp;·&nbsp; <span className="text-amber-700">Separate pending {fmtINR(data.separate_pending)}</span></>}
          </p>
        </div>

        <div className={`rounded-xl border p-5 flex flex-col justify-center ${unmatched.count > 0 ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'}`}>
          <p className={`text-[11px] uppercase tracking-wide font-medium flex items-center gap-1 ${unmatched.count > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
            {unmatched.count > 0 ? <AlertTriangle size={13} /> : <Package size={13} />} Unmatched freight
          </p>
          <p className={`text-2xl sm:text-3xl font-bold tabular-nums mt-1 ${unmatched.count > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>{fmtINR(unmatched.amount)}</p>
          <p className={`text-xs mt-1 ${unmatched.count > 0 ? 'text-amber-700/80' : 'text-emerald-700/80'}`}>
            {unmatched.count > 0
              ? `${unmatched.count} separate slip(s) not yet linked to a purchase — review & match.`
              : 'Every separate slip is linked to a purchase bill.'}
          </p>
        </div>
      </div>

      {/* Leaderboard + highest-freight purchases */}
      <div className="grid lg:grid-cols-2 gap-4">
        {/* Top transporters (separate freight) — compact rows */}
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">Top transporters</h3>
            <span className="text-[11px] text-slate-400">separate freight</span>
          </div>
          {(data.by_transporter || []).length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-6">No separate transporter freight in this window.</p>
          ) : (
            <div className="px-4 divide-y divide-slate-50">
              {(data.by_transporter || []).slice(0, 12).map((t, i) => (
                <div key={i} className="min-w-0 py-1.5">
                  <div className="flex items-center justify-between gap-2 text-[13px] mb-1">
                    <span className="truncate text-slate-700" title={t.name}>{t.name}</span>
                    <span className="tabular-nums font-semibold text-slate-800 shrink-0">{fmtINR(t.amount)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${Math.max(3, (Number(t.amount) / maxTrans) * 100)}%` }} />
                    </div>
                    <span className="text-[10px] text-slate-400 shrink-0 tabular-nums whitespace-nowrap">{t.count} · {t.pct}%</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Highest freight purchases */}
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-100">
            <h3 className="text-sm font-semibold text-slate-800">Highest freight purchases</h3>
          </div>
          {(data.top_purchases || []).length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">No freight on purchases in this window.</p>
          ) : (
            <table className="w-full text-sm table-fixed">
              <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-slate-500 text-[11px] uppercase tracking-wide">
                <tr className="text-left">
                  <th className="px-3 py-2 font-semibold">Bill / Supplier</th>
                  <th className="px-1.5 py-2 font-semibold text-right w-[84px]">On-bill</th>
                  <th className="px-1.5 py-2 font-semibold text-right w-[84px]">Separate</th>
                  <th className="px-3 py-2 font-semibold text-right w-[84px]">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(data.top_purchases || []).map((r) => (
                  <tr key={r.bill_id} className="hover:bg-primary-50/40 transition-colors">
                    <td className="px-3 py-2">
                      <Link to={`/purchase/bills/${r.bill_id}`} title={r.invoice_no}
                        className="block truncate font-medium text-indigo-700 hover:text-indigo-900 hover:underline">
                        {r.invoice_no || '—'}
                      </Link>
                      <div className="text-[11px] text-slate-500 truncate" title={r.party}>{r.party}</div>
                    </td>
                    <td className="px-1.5 py-2 text-right tabular-nums text-slate-600 whitespace-nowrap" title={Number(r.onbill) ? fmtINR(r.onbill) : ''}>{Number(r.onbill) ? fmtShort(r.onbill) : '—'}</td>
                    <td className="px-1.5 py-2 text-right tabular-nums text-emerald-700 whitespace-nowrap" title={Number(r.separate) ? fmtINR(r.separate) : ''}>{Number(r.separate) ? fmtShort(r.separate) : '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900 whitespace-nowrap" title={fmtINR(r.total)}>{fmtShort(r.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Unmatched detail (only when there is something to fix) */}
      {unmatched.count > 0 && (
        <div className="bg-white rounded-xl border border-amber-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-amber-100 bg-amber-50/50 flex items-center gap-2">
            <AlertTriangle size={14} className="text-amber-600" />
            <h3 className="text-sm font-semibold text-amber-800">Unmatched separate freight — {unmatched.count} to link</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-slate-500 text-[11px] uppercase tracking-wide">
                <tr className="text-left">
                  <th className="px-4 py-2.5 font-semibold">Advice No</th>
                  <th className="px-3 py-2.5 font-semibold">Date</th>
                  <th className="px-3 py-2.5 font-semibold">Transporter</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {unmatched.rows.map((r) => (
                  <tr key={r.id} className="hover:bg-primary-50/40 transition-colors">
                    <td className="px-4 py-2.5 font-medium">
                      <Link to={`/freight/purchase/${r.id}`} title="Open the freight advice to verify / link it"
                        className="text-primary-600 hover:text-primary-800 hover:underline inline-flex items-center gap-1">
                        {r.advice_no || '—'}<ExternalLink size={11} className="text-slate-300" />
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-slate-500 tabular-nums">{r.date || '—'}</td>
                    <td className="px-3 py-2.5 text-slate-700">{r.transporter}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-amber-700">{fmtINR(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
