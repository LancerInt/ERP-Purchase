/**
 * Freight Analytics — a freight-spend overview modelled on the Purchase / Sales
 * analytics pages: a full filter bar (period / company / warehouse / transporter),
 * headline tiles with on-hover breakdown popovers, an inward / outward / local
 * split, and a top-transporters table. Computed client-side from the three
 * freight endpoints (inward = purchase advice, outward = sales advice, local =
 * standalone local-freight), so no new backend is needed.
 *
 * Note on GST: a freight advice exposes a single net PAYABLE figure (the amount
 * owed to the transporter). GST on GTA freight is reverse-charge — paid to the
 * government by the recipient, not added to the transporter's payment — so there
 * is no "taxable vs incl-GST" split to toggle the way Purchase bills have. The
 * figures here are the freight spend itself.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BarChart3, Loader2, CheckCircle2, Clock } from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import ListState from '@/components/common/ListState.jsx';
import CustomSelect from '@/components/ui/CustomSelect';
import { PeriodNavigator, usePeriodFilter, inWindow } from '@/components/common/PeriodNavigator';
import apiClient from '../../../utils/api.js';
import { formatCurrency } from '@/utils/formatters';

const fmtMoney0 = (v) => `₹${Math.round(Number(v) || 0).toLocaleString('en-IN')}`;
const fmtCrore = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Crore`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)} Lakh`;
  return fmtMoney0(n);
};

async function fetchAll(url) {
  const out = [];
  let next = `${url}${url.includes('?') ? '&' : '?'}page_size=500`;
  for (let i = 0; i < 40 && next; i++) {
    const { data } = await apiClient.get(next);
    const rows = Array.isArray(data) ? data : (data?.results || []);
    out.push(...rows);
    next = (!Array.isArray(data) && data?.next) ? data.next : null;
  }
  return out;
}

const num = (v) => Number(v) || 0;
// A freight advice exposes a single net payable; local freight the same.
const amtOf = (f) => num(f.total_freight_cost) || num(f.payable_amount) || num(f.freight_amount);
const paidOf = (f) => num(f.total_paid);
const dateOf = (f) => f.freight_date || f.date || f.advice_date || f.created_date || '';
const transporterOf = (f) => f.transporter_name || f.vendor_name || f.customer_name || '';
const warehouseOf = (f) => f.warehouse_name || f.factory_name || '';

// ── Headline tile with an on-hover breakdown popover (mirrors the Purchase /
//    Sales analytics PHeadCard: light tile, darker-indigo border, and a big
//    centred popup that reveals the hidden breakdown on hover). ────────────────
// Uniform indigo chrome (dot + popup header) like the Purchase / Sales tiles —
// only the figure colour is semantic, so the tile border and its hover popup
// always read as the same colour.
const HEAD_CHROME = { dot: 'bg-indigo-500', head: 'from-indigo-500 to-indigo-700' };
const TONE = {
  total:       { ...HEAD_CHROME, val: 'text-slate-900' },
  inward:      { ...HEAD_CHROME, val: 'text-blue-600' },
  outward:     { ...HEAD_CHROME, val: 'text-violet-600' },
  local:       { ...HEAD_CHROME, val: 'text-teal-600' },
  outstanding: { ...HEAD_CHROME, val: 'text-rose-600' },
};
function FreightTile({ label, value, words, tone = 'total', onClick, popTitle, popRows }) {
  const t = TONE[tone] || TONE.total;
  const clickable = typeof onClick === 'function';
  const Tag = clickable ? 'button' : 'div';
  const pop = (popRows || []).filter(Boolean);
  return (
    <div className="relative group min-w-0 h-full">
      <Tag type={clickable ? 'button' : undefined} onClick={clickable ? onClick : undefined}
        className={`relative flex h-full w-full min-w-0 flex-col text-left rounded-lg border-2 border-indigo-400 bg-white px-3 py-3 shadow-sm transition hover:shadow-md hover:border-transparent ${clickable ? 'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300' : ''}`}>
        <div className="flex items-center gap-1.5 min-w-0">
          <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${t.dot}`} />
          <p className="text-xs sm:text-[13px] font-semibold uppercase tracking-[0.06em] text-slate-600 truncate">{label}</p>
        </div>
        <p className={`mt-1 text-lg sm:text-xl lg:text-2xl font-bold tracking-tight money leading-tight break-words ${t.val}`}>{value}</p>
        <p className="mt-0.5 text-[11px] font-medium text-slate-500 leading-tight truncate min-h-[0.9rem]">{words || ' '}</p>
      </Tag>
      {pop.length > 0 && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150">
          <div className="absolute inset-0 bg-slate-900/20 backdrop-blur-[1.5px]" />
          <div className="relative w-[360px] max-w-[92vw] rounded-2xl bg-white shadow-2xl ring-1 ring-black/5 overflow-hidden scale-95 group-hover:scale-100 transition-transform duration-150">
            <div className={`bg-gradient-to-br ${t.head} px-5 py-4`}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-white/75">{label}</p>
              <p className="mt-0.5 text-2xl font-extrabold text-white money leading-tight">{value}</p>
              {words && <p className="mt-0.5 text-[11px] font-medium text-white/70">{words}</p>}
            </div>
            <div className="px-5 py-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400 mb-2">{popTitle || 'Breakdown'}</p>
              <div className="divide-y divide-slate-100">
                {pop.map((r, i) => (
                  <div key={i} className="flex items-center justify-between gap-4 py-2 text-[13px]">
                    <span className="text-slate-500">{r.label}</span>
                    <span className={`tabular-nums font-bold ${r.tone || 'text-slate-800'}`}>{r.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function FreightDashboard() {
  const navigate = useNavigate();
  const [inward, setInward] = useState([]);
  const [outward, setOutward] = useState([]);
  const [local, setLocal] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [sp, setSp] = useSearchParams();
  const [company, setCompany] = useState(sp.get('company') || '');
  const [warehouse, setWarehouse] = useState(sp.get('warehouse') || '');
  const [transporter, setTransporter] = useState(sp.get('transporter') || '');
  // Analytics page → default to the current month, like Purchase / Sales.
  const period = usePeriodFilter('month');

  // Keep the three string filters in the URL so Back / refresh restore them.
  useEffect(() => {
    const p = new URLSearchParams(sp);
    const setOrDel = (k, v) => { if (v) p.set(k, v); else p.delete(k); };
    setOrDel('company', company);
    setOrDel('warehouse', warehouse);
    setOrDel('transporter', transporter);
    if (p.toString() !== sp.toString()) setSp(p, { replace: true });
  }, [company, warehouse, transporter, sp, setSp]);

  const load = () => {
    setLoading(true); setError(null);
    // Per-source resilience: a role may be able to read one freight source but
    // not another (e.g. Freight Analytics without Local Freight). One 403 must
    // not blank the whole page — fall back to [] for that source instead.
    const safe = (url) => fetchAll(url).catch(() => null);
    Promise.all([
      safe('/api/purchase/freight/'),
      safe('/api/sales/freight/'),
      safe('/api/purchase/local-freight/'),
    ])
      .then(([p, s, l]) => {
        setInward(p || []); setOutward(s || []); setLocal(l || []);
        if (p === null && s === null && l === null) setError('Could not load freight.');
      })
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // Actual cash paid to transporters in the window, from PaymentMade (the
  // payment hub) — the same money the Payment Entries 'Freight' category shows.
  // Kept SEPARATE from the freight-record paid/outstanding above (which splits
  // inward/outward/local); this is the real cash-out figure that ties the
  // Purchase/Expense split.
  const [cashPaid, setCashPaid] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const r = period.range;
    const iso = (v) => (typeof v === 'string' ? v.slice(0, 10) : '');
    const qp = new URLSearchParams({ period: period.period });
    if (r?.from) qp.set('from', iso(r.from));
    if (r?.to) qp.set('to', iso(r.to));
    if (company) qp.set('company', company);
    apiClient.get(`/api/purchase/dashboard/paid-by-category/?${qp.toString()}`)
      .then(({ data }) => { if (!cancelled) setCashPaid(data?.freight != null ? Number(data.freight) : null); })
      .catch(() => { if (!cancelled) setCashPaid(null); });
    return () => { cancelled = true; };
  }, [period.range?.from, period.range?.to, period.period, company]);

  // Normalise every source into one shape so filters apply uniformly.
  // `pending` marks a separately-payable freight record that still needs
  // approval before it counts as a live payable (mirrors a DRAFT goods bill).
  // Only the gated sides carry a status: inward separate slips and local
  // freight. Outward (sales) freight has no approval gate, so it is always live.
  const records = useMemo(() => {
    const map = (arr, side) => arr.map((f) => {
      const st = f.status || '';
      const pending = (
        (side === 'local' && st === 'DRAFT') ||
        (side === 'in' && (st === 'DRAFT' || st === 'PENDING_APPROVAL')
          && (f.freight_source || 'SEPARATE_SLIP') === 'SEPARATE_SLIP')
      );
      return {
        side,
        id: f.id,
        pending,
        date: dateOf(f),
        company: f.company_name || '',
        warehouse: warehouseOf(f),
        transporter: transporterOf(f),
        amt: amtOf(f),
        paid: paidOf(f),
      };
    });
    return [
      ...map(inward, 'in'),
      ...map(outward, 'out'),
      ...map(local, 'local'),
    ];
  }, [inward, outward, local]);

  // Option lists come from the full (unfiltered) set so a filter never hides
  // its own remaining choices.
  const companies   = useMemo(() => [...new Set(records.map((r) => r.company).filter(Boolean))].sort(), [records]);
  const warehouses  = useMemo(() => [...new Set(records.map((r) => r.warehouse).filter(Boolean))].sort(), [records]);
  const transporters = useMemo(() => [...new Set(records.map((r) => r.transporter).filter(Boolean))].sort(), [records]);

  // SS Biochem is the default scope on every analytics page. Once the records
  // load, pre-select the SS company (unless one is already chosen); the user can
  // switch to United Agro or clear to see all for the session. Freight filters by
  // company NAME, so match the SS legal name.
  const didDefaultCompany = useRef(false);
  useEffect(() => {
    if (didDefaultCompany.current) return;
    if (company) { didDefaultCompany.current = true; return; }
    const ss = companies.find((c) => /biochem/i.test(c));
    if (ss) { didDefaultCompany.current = true; setCompany(ss); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companies]);

  const filtered = useMemo(() => records.filter((r) =>
    (!company || r.company === company)
    && (!warehouse || r.warehouse === warehouse)
    && (!transporter || r.transporter === transporter)
    && inWindow(r.date, period.range),
  ), [records, company, warehouse, transporter, period.range]);

  // Approved (live) rows drive every headline figure; awaiting-approval rows are
  // held out and surfaced in their own panel (a DRAFT freight record is not yet
  // a payable, just like a DRAFT goods bill).
  const live = useMemo(() => filtered.filter((r) => !r.pending), [filtered]);
  const pendingRows = useMemo(() => filtered.filter((r) => r.pending), [filtered]);
  const pendingStats = useMemo(() => ({
    count: pendingRows.length,
    amt: pendingRows.reduce((s, r) => s + r.amt, 0),
  }), [pendingRows]);

  const stats = useMemo(() => {
    const seed = () => ({ amt: 0, paid: 0, count: 0 });
    const by = { in: seed(), out: seed(), local: seed() };
    for (const r of live) {
      const b = by[r.side]; if (!b) continue;
      b.amt += r.amt; b.paid += r.paid; b.count += 1;
    }
    const total = by.in.amt + by.out.amt + by.local.amt;
    const paid = by.in.paid + by.out.paid + by.local.paid;
    const pend = (b) => Math.max(0, b.amt - b.paid);
    return { by, total, paid, pending: Math.max(0, total - paid),
             inPend: pend(by.in), outPend: pend(by.out), localPend: pend(by.local),
             count: live.length };
  }, [live]);

  // Approve awaiting-approval freight — per source endpoint (local vs inward
  // separate slip). `ids` approves a selection; omit to approve all pending.
  const [approving, setApproving] = useState(false);
  const approve = async (rows) => {
    const localIds = rows.filter((r) => r.side === 'local').map((r) => r.id).filter(Boolean);
    const inIds = rows.filter((r) => r.side === 'in').map((r) => r.id).filter(Boolean);
    if (!localIds.length && !inIds.length) return;
    setApproving(true);
    try {
      const calls = [];
      if (localIds.length) calls.push(apiClient.post('/api/purchase/local-freight/approve-all/', { ids: localIds }));
      if (inIds.length) calls.push(apiClient.post('/api/purchase/freight/approve-all/', { ids: inIds }));
      await Promise.all(calls);
      toast.success(`Approved ${localIds.length + inIds.length} freight record${localIds.length + inIds.length > 1 ? 's' : ''}.`);
      load();
    } catch (e) {
      toast.error('Could not approve freight.');
    } finally {
      setApproving(false);
    }
  };

  const topTransporters = useMemo(() => {
    const m = new Map();
    for (const r of live) {
      const name = r.transporter || '—';
      if (name === '—') continue;
      const e = m.get(name) || { name, inAmt: 0, outAmt: 0, localAmt: 0, count: 0 };
      if (r.side === 'in') e.inAmt += r.amt;
      else if (r.side === 'out') e.outAmt += r.amt;
      else e.localAmt += r.amt;
      e.count += 1; m.set(name, e);
    }
    return [...m.values()].map((e) => ({ ...e, total: e.inAmt + e.outAmt + e.localAmt }))
      .sort((a, b) => b.total - a.total).slice(0, 12);
  }, [filtered]);

  // Split bar segments (inward / outward / local as a share of total).
  const share = (v) => (stats.total ? Math.round((v / stats.total) * 100) : 0);
  const inPct = share(stats.by.in.amt), outPct = share(stats.by.out.amt), localPct = share(stats.by.local.amt);

  const SEL = 'border border-slate-300 rounded-lg px-2 text-sm bg-white h-9 min-w-[150px]';

  return (
    <MainLayout>
      <div className="space-y-4">
        <PageHeader compact title="Freight Analytics" subtitle="Freight spend across inward, outward and local"
          breadcrumbs={[{ label: 'Freight' }, { label: 'Analytics' }]} icon={BarChart3} />

        {/* Filter bar — period + company + warehouse + transporter. */}
        <div className="bg-white rounded-xl border border-slate-200 p-2.5 flex flex-wrap items-center gap-2">
          <PeriodNavigator {...period.navProps} />
          <CustomSelect value={company} onChange={(e) => setCompany(e.target.value)} title="Company" className={SEL}>
            <option value="">All Companies</option>
            {companies.map((c) => <option key={c} value={c}>{c}</option>)}
          </CustomSelect>
          <CustomSelect value={warehouse} onChange={(e) => setWarehouse(e.target.value)} title="Warehouse / Factory" className={SEL}>
            <option value="">All Warehouses</option>
            {warehouses.map((w) => <option key={w} value={w}>{w}</option>)}
          </CustomSelect>
          <CustomSelect value={transporter} onChange={(e) => setTransporter(e.target.value)} title="Transporter" className={`${SEL} min-w-[180px]`}>
            <option value="">All Transporters</option>
            {transporters.map((t) => <option key={t} value={t}>{t}</option>)}
          </CustomSelect>
          {(company || warehouse || transporter || period.period !== 'month') && (
            <button type="button"
              onClick={() => { setCompany(''); setWarehouse(''); setTransporter(''); period.navProps.setPeriod('month'); }}
              className="text-xs font-medium text-slate-500 hover:text-slate-700 px-2 h-9">Reset</button>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-slate-400"><Loader2 className="animate-spin mr-2" size={18} /> Loading freight…</div>
        ) : (
        <ListState error={error} onRetry={load}>
          {/* KEY METRICS — five tiles on an indigo backdrop, each with a hover
              breakdown popover. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 bg-indigo-100 border border-indigo-200 rounded-xl p-2.5">
            <FreightTile label="Total freight" tone="total" value={fmtMoney0(stats.total)} words={`${stats.count} records · ${fmtCrore(stats.total)}`}
              popTitle="Split by direction" popRows={[
                { label: `Inward (${stats.by.in.count})`, value: fmtMoney0(stats.by.in.amt), tone: 'text-blue-600' },
                { label: `Outward (${stats.by.out.count})`, value: fmtMoney0(stats.by.out.amt), tone: 'text-violet-600' },
                { label: `Local (${stats.by.local.count})`, value: fmtMoney0(stats.by.local.amt), tone: 'text-teal-600' },
                { label: 'Paid', value: fmtMoney0(stats.paid), tone: 'text-emerald-600' },
                { label: 'Outstanding', value: fmtMoney0(stats.pending), tone: 'text-rose-600' },
              ]} />
            <FreightTile label="Inward (purchase)" tone="inward" value={fmtMoney0(stats.by.in.amt)} words={`${stats.by.in.count} records · ${inPct}% of total`}
              popTitle="Inward freight" popRows={[
                { label: 'Records', value: String(stats.by.in.count) },
                { label: 'Paid', value: fmtMoney0(stats.by.in.paid), tone: 'text-emerald-600' },
                { label: 'Outstanding', value: fmtMoney0(stats.inPend), tone: 'text-rose-600' },
                { label: 'Share of total', value: `${inPct}%` },
              ]} />
            <FreightTile label="Outward (sales)" tone="outward" value={fmtMoney0(stats.by.out.amt)} words={`${stats.by.out.count} records · ${outPct}% of total`}
              popTitle="Outward freight" popRows={[
                { label: 'Records', value: String(stats.by.out.count) },
                { label: 'Paid', value: fmtMoney0(stats.by.out.paid), tone: 'text-emerald-600' },
                { label: 'Outstanding', value: fmtMoney0(stats.outPend), tone: 'text-rose-600' },
                { label: 'Share of total', value: `${outPct}%` },
              ]} />
            <FreightTile label="Local freight" tone="local" value={fmtMoney0(stats.by.local.amt)} words={`${stats.by.local.count} records · ${localPct}% of total`}
              popTitle="Local / charges freight" popRows={[
                { label: 'Records', value: String(stats.by.local.count) },
                { label: 'Paid', value: fmtMoney0(stats.by.local.paid), tone: 'text-emerald-600' },
                { label: 'Outstanding', value: fmtMoney0(stats.localPend), tone: 'text-rose-600' },
                { label: 'Share of total', value: `${localPct}%` },
              ]} />
            <FreightTile label="Outstanding" tone="outstanding" value={fmtMoney0(stats.pending)} words={`${fmtMoney0(stats.paid)} paid`}
              popTitle="Outstanding by direction" popRows={[
                { label: 'Inward', value: fmtMoney0(stats.inPend), tone: 'text-blue-600' },
                { label: 'Outward', value: fmtMoney0(stats.outPend), tone: 'text-violet-600' },
                { label: 'Local', value: fmtMoney0(stats.localPend), tone: 'text-teal-600' },
                { label: 'Total paid', value: fmtMoney0(stats.paid), tone: 'text-emerald-600' },
              ]} />
            {/* Actual cash paid to transporters (payment hub), the same money
                Payment Entries 'Freight' shows — distinct from the freight-record
                paid above, which may lag until advices are settled. */}
            <FreightTile label="Cash Paid (payments)" tone="inward"
              value={cashPaid == null ? '—' : fmtMoney0(cashPaid)}
              words={cashPaid == null ? 'no payment data' : fmtCrore(cashPaid)}
              popTitle="Amount Paid" popRows={[
                { label: 'Freight payments', value: cashPaid == null ? '—' : fmtMoney0(cashPaid), tone: 'text-emerald-600' },
                { label: 'From', value: 'Payment Entries' },
              ]} />
          </div>

          {/* Awaiting approval — scan-confirmed freight that is not yet a live
              payable. It is held out of the figures above until approved, the
              same gate a DRAFT goods bill passes before it becomes an open
              payable. Approve here to post it to the freight ledger. */}
          {pendingStats.count > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-2 border-b border-amber-200">
                <div className="flex items-center gap-2 min-w-0">
                  <Clock size={16} className="text-amber-600 shrink-0" />
                  <p className="text-sm font-semibold text-amber-900">
                    {pendingStats.count} freight record{pendingStats.count > 1 ? 's' : ''} awaiting approval
                    <span className="ml-2 font-bold tabular-nums">{fmtMoney0(pendingStats.amt)}</span>
                  </p>
                </div>
                <button type="button" disabled={approving} onClick={() => approve(pendingRows)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50">
                  {approving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                  Approve all ({pendingStats.count})
                </button>
              </div>
              <div className="max-h-56 overflow-auto divide-y divide-amber-100">
                {pendingRows.map((r) => (
                  <div key={`${r.side}-${r.id}`} className="px-4 py-2 flex items-center justify-between gap-3 text-[13px]">
                    <div className="min-w-0">
                      <span className="font-medium text-slate-800 truncate">{r.transporter || 'Unspecified transporter'}</span>
                      <span className="ml-2 text-[11px] uppercase tracking-wide text-slate-400">{r.side === 'local' ? 'Local' : 'Inward'}</span>
                      <span className="ml-2 text-[11px] text-slate-400">{r.date || ''}</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="tabular-nums font-semibold text-slate-700">{fmtMoney0(r.amt)}</span>
                      <button type="button" disabled={approving} onClick={() => approve([r])}
                        className="text-xs font-semibold text-amber-700 hover:underline disabled:opacity-50">Approve</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Inward / Outward / Local split */}
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <p className="text-sm font-semibold text-slate-700 mb-2">Inward · Outward · Local</p>
            <div className="h-3 w-full rounded-full overflow-hidden bg-slate-100 flex">
              <div className="bg-blue-500 h-full" style={{ width: `${inPct}%` }} title={`Inward ${inPct}%`} />
              <div className="bg-violet-500 h-full" style={{ width: `${outPct}%` }} title={`Outward ${outPct}%`} />
              <div className="bg-teal-500 h-full" style={{ width: `${localPct}%` }} title={`Local ${localPct}%`} />
            </div>
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-[11px] text-slate-500 mt-1.5">
              <span><span className="inline-block w-2 h-2 rounded-full bg-blue-500 mr-1 align-middle" />Inward {fmtMoney0(stats.by.in.amt)} ({inPct}%)</span>
              <span><span className="inline-block w-2 h-2 rounded-full bg-violet-500 mr-1 align-middle" />Outward {fmtMoney0(stats.by.out.amt)} ({outPct}%)</span>
              <span><span className="inline-block w-2 h-2 rounded-full bg-teal-500 mr-1 align-middle" />Local {fmtMoney0(stats.by.local.amt)} ({localPct}%)</span>
            </div>
          </div>

          {/* Top transporters */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 text-sm font-semibold text-slate-700">Top transporters</div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead><tr className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2 text-left font-semibold">Transporter</th>
                  <th className="px-3 py-2 text-right font-semibold">Records</th>
                  <th className="px-3 py-2 text-right font-semibold">Inward</th>
                  <th className="px-3 py-2 text-right font-semibold">Outward</th>
                  <th className="px-3 py-2 text-right font-semibold">Local</th>
                  <th className="px-3 py-2 text-right font-semibold">Total</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {topTransporters.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-400">No freight for the selected filters.</td></tr>
                  )}
                  {topTransporters.map((t) => (
                    <tr key={t.name} className="hover:bg-slate-50 cursor-pointer" onClick={() => navigate('/freight/bills')}>
                      <td className="px-4 py-2 font-medium text-slate-800">{t.name}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-500">{t.count}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-blue-600">{formatCurrency(t.inAmt)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-violet-600">{formatCurrency(t.outAmt)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-teal-600">{formatCurrency(t.localAmt)}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-bold text-slate-800">{formatCurrency(t.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </ListState>
        )}
      </div>
    </MainLayout>
  );
}
