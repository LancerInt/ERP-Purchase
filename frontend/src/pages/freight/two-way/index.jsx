/**
 * Two-way freight — transporters that carry freight in BOTH directions:
 * inward (purchase: vendor → our warehouse) AND outward (sales: our warehouse →
 * customer). Those parties run on both ledgers, so this nets the two sides on
 * one row the way a combined transporter account would read.
 *
 * Computed client-side from the same two lists the Freight page uses
 * (/api/purchase/freight/ = inward, /api/sales/freight/ = outward), keyed on the
 * transporter name — so it needs no new endpoint.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Repeat, Download, Loader2, ExternalLink } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import ListState from '@/components/common/ListState.jsx';
import apiClient from '../../../utils/api.js';
import { formatCurrency } from '@/utils/formatters';
import exportToExcel from '../../../utils/exportExcel.js';

const fmtMoney0 = (v) => `₹${Math.round(Number(v) || 0).toLocaleString('en-IN')}`;
const norm = (s) => (s || '').trim().toLowerCase();

// Pull every page of a freight list (the endpoints paginate).
async function fetchAll(url) {
  const out = [];
  let next = `${url}?page_size=500`;
  for (let i = 0; i < 40 && next; i++) {
    const { data } = await apiClient.get(next);
    const rows = Array.isArray(data) ? data : (data?.results || []);
    out.push(...rows);
    next = (!Array.isArray(data) && data?.next) ? data.next : null;
  }
  return out;
}
const amtOf = (f) => Number(f.total_freight_cost) || Number(f.payable_amount) || 0;

export default function TwoWayFreight() {
  const navigate = useNavigate();
  const [inward, setInward] = useState([]);
  const [outward, setOutward] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = () => {
    setLoading(true); setError(null);
    Promise.all([fetchAll('/api/purchase/freight/'), fetchAll('/api/sales/freight/')])
      .then(([p, s]) => { setInward(p); setOutward(s); })
      .catch(() => setError('Could not load freight.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const rows = useMemo(() => {
    const by = new Map();   // key -> { name, inCount, inAmt, outCount, outAmt }
    const add = (f, side) => {
      const name = f.transporter_name || f.vendor_name || '—';
      const k = norm(name);
      if (!k || k === '—') return;
      const r = by.get(k) || { name, inCount: 0, inAmt: 0, outCount: 0, outAmt: 0 };
      if (side === 'in') { r.inCount += 1; r.inAmt += amtOf(f); }
      else { r.outCount += 1; r.outAmt += amtOf(f); }
      by.set(k, r);
    };
    inward.forEach((f) => add(f, 'in'));
    outward.forEach((f) => add(f, 'out'));
    // Two-way only: present on BOTH sides.
    return [...by.values()]
      .filter((r) => r.inCount > 0 && r.outCount > 0)
      .map((r) => ({ ...r, total: r.inAmt + r.outAmt }))
      .sort((a, b) => b.total - a.total);
  }, [inward, outward]);

  const totals = useMemo(() => rows.reduce((a, r) => {
    a.inAmt += r.inAmt; a.outAmt += r.outAmt; a.total += r.total; return a;
  }, { inAmt: 0, outAmt: 0, total: 0 }), [rows]);

  const doExport = () => {
    if (!rows.length) return;
    exportToExcel(rows.map((r) => ({
      transporter: r.name, inward_count: r.inCount, inward_amount: r.inAmt.toFixed(2),
      outward_count: r.outCount, outward_amount: r.outAmt.toFixed(2), total: r.total.toFixed(2),
    })), [
      { field: 'transporter', header: 'Transporter' },
      { field: 'inward_count', header: 'Inward #' }, { field: 'inward_amount', header: 'Inward ₹' },
      { field: 'outward_count', header: 'Outward #' }, { field: 'outward_amount', header: 'Outward ₹' },
      { field: 'total', header: 'Total ₹' },
    ], `two-way-freight-${new Date().toISOString().slice(0, 10)}`);
  };

  const Tile = ({ label, value, tone }) => (
    <div className="px-3 py-2">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={`text-sm font-bold money ${tone || 'text-slate-900'}`}>{value}</p>
    </div>
  );

  return (
    <MainLayout>
      <div className="space-y-3 sm:space-y-4">
        <PageHeader
          compact
          title="Two-way Freight"
          subtitle="Transporters carrying freight both inward (purchase) and outward (sales)"
          breadcrumbs={[{ label: 'Freight' }, { label: 'Two-way' }]}
          icon={Repeat}
          actions={{ right: (
            <button type="button" onClick={doExport} disabled={!rows.length}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
              <Download size={14} /> Export
            </button>
          ) }}
        />

        <div className="metric-band">
          <Tile label="Two-way transporters" value={rows.length.toLocaleString('en-IN')} tone="text-slate-900 tabular-nums" />
          <Tile label="Inward freight" value={fmtMoney0(totals.inAmt)} tone="text-blue-600" />
          <Tile label="Outward freight" value={fmtMoney0(totals.outAmt)} tone="text-violet-600" />
          <Tile label="Combined" value={fmtMoney0(totals.total)} tone="text-slate-900" />
        </div>

        <ListState error={error} onRetry={load}>
          <div className="hidden sm:block overflow-x-auto border border-slate-200 rounded-xl shadow-sm bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2.5 text-left font-semibold">Transporter</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Inward #</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Inward ₹</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Outward #</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Outward ₹</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Combined</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && (
                  <tr><td colSpan={6} className="px-3 py-10 text-center text-slate-400">
                    <Loader2 className="inline animate-spin mr-2" size={16} /> Loading freight…</td></tr>
                )}
                {!loading && rows.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-10 text-center text-sm text-slate-400">
                    No transporter has both inward and outward freight.</td></tr>
                )}
                {rows.map((r) => (
                  <tr key={r.name} className="hover:bg-slate-50 cursor-pointer"
                    onClick={() => navigate(`/freight/inward?q=${encodeURIComponent(r.name)}`)}>
                    <td className="px-3 py-2.5 font-medium text-indigo-600 inline-flex items-center gap-1">
                      {r.name}<ExternalLink size={11} />
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{r.inCount}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-blue-600 font-medium">{formatCurrency(r.inAmt)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{r.outCount}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-violet-600 font-medium">{formatCurrency(r.outAmt)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-bold text-slate-800">{formatCurrency(r.total)}</td>
                  </tr>
                ))}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr className="bg-slate-50 font-bold text-slate-800 border-t border-slate-200">
                    <td className="px-3 py-2">Total · {rows.length}</td>
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2 text-right tabular-nums text-blue-600">{formatCurrency(totals.inAmt)}</td>
                    <td className="px-3 py-2" />
                    <td className="px-3 py-2 text-right tabular-nums text-violet-600">{formatCurrency(totals.outAmt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(totals.total)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </ListState>
      </div>
    </MainLayout>
  );
}
