// Purchase Dashboard (overview) — analytics companion to the Purchase
// work-tracking dashboard. Party-wise: top 10 vendors, top 10 products
// purchased, a rolling 12-month billed-vs-paid trend, and exception reports.
// Backed by GET /api/purchase/dashboard/analytics/.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart3, Users, Package, TrendingUp, AlertTriangle, Loader2,
  CalendarClock, FileWarning, RotateCcw, UserX, ChevronRight, ArrowLeftRight,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts';
import CustomSelect from '@/components/ui/CustomSelect';
import ProductPicker from '@/components/common/ProductPicker';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import { CTRL_H } from '@/components/common/controls';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import RankedBarList from '../../../components/common/RankedBarList';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { usePurchaseFilter } from '../components/purchaseFilter.js';
import SourceCompareModal from '../components/SourceCompareModal.jsx';
import useIsNarrow from '../../../hooks/useIsNarrow.js';
import { formatDate } from '@/utils/formatters';
import itemDisplay from '../../../utils/itemName.js';

const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtINR = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};
const fmtINRfull = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt = (v) => (Number(v) || 0).toLocaleString('en-IN');
const fmtDate = (iso) => (iso ? formatDate(iso) : '—');

const VENDOR_COLOR = '#6366f1';    // indigo
const PRODUCT_COLOR = '#0ea5e9';   // sky

// Wrap a category label into up to two word-aware lines so the FULL name
// shows on the chart axis (truncated labels were unreadable on mobile).
const wrapLabel = (s, max = 20) => {
  const words = String(s || '').split(/\s+/).filter(Boolean);
  const lines = [''];
  for (const w of words) {
    const i = lines.length - 1;
    const cand = lines[i] ? `${lines[i]} ${w}` : w;
    if (cand.length <= max || !lines[i]) lines[i] = cand;
    else if (lines.length < 2) lines.push(w);
    else { lines[i] = `${lines[i]}…`; break; }
  }
  return lines.map((l) => (l.length > max + 4 ? `${l.slice(0, max + 3)}…` : l));
};

// Custom Y-axis tick — renders the wrapped label as <tspan> lines.
function CatTick({ x, y, payload, max = 20 }) {
  const lines = wrapLabel(payload?.value, max);
  return (
    <text x={x} y={y + (lines.length > 1 ? -1 : 4)} textAnchor="end" fill="#475569" fontSize={10}>
      {lines.map((ln, i) => (
        <tspan key={i} x={x} dy={i === 0 ? 0 : 11}>{ln}</tspan>
      ))}
    </text>
  );
}

// Quantities span multiple unit types (PCS vs KGS can't be summed into one
// number), so we keep them split per UOM — "12,345 PCS · 678 KGS".
const fmtQtyBreakdown = (arr) => (arr || [])
  .filter((x) => Number(x.qty) > 0)
  .map((x) => `${Number(x.qty).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${x.uom}`)
  .join(' · ');

// Period-navigator helpers (month / week picker), mirroring Purchase Analytics.
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseISO = (s) => { const [y, m, d] = (s || todayISO()).split('-').map(Number); return new Date(y, m - 1, d); };
const monthRangeOf = (a) => { const d = parseISO(a); return { from: isoOf(new Date(d.getFullYear(), d.getMonth(), 1)), to: isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0)) }; };
const weekRangeOf = (a) => { const d = parseISO(a); const dow = (d.getDay() + 6) % 7; const mon = new Date(d); mon.setDate(d.getDate() - dow); const sun = new Date(mon); sun.setDate(mon.getDate() + 6); return { from: isoOf(mon), to: isoOf(sun) }; };
// Indian financial year: 1 Apr → 31 Mar (mirrors Purchase Analytics). The FY
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
    rose: 'bg-rose-50 text-rose-600', amber: 'bg-amber-50 text-amber-600',
  }[tone];
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-slate-100">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`p-1 rounded-lg shrink-0 ${toneCls}`}><Icon size={15} /></span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-800 truncate">{title}</h2>
            {subtitle && <p className="text-[10px] text-slate-500 truncate">{subtitle}</p>}
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
  // The full row sits on payload[0].payload — carries qty/bills that aren't
  // plotted as bars but we still want in the tooltip.
  const d = payload[0].payload || {};
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-md px-3 py-2 text-xs max-w-[74vw] sm:max-w-[300px]">
      <p className="font-semibold text-slate-700 mb-1 whitespace-normal break-words">{label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="flex items-center gap-2 flex-wrap tabular-nums">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-slate-500">{(valueKeys && valueKeys[p.dataKey]) || p.name}:</span>
          <span className="font-medium text-slate-800">{fmtINRfull(p.value)}</span>
        </p>
      ))}
      {d.qtyLabel && (
        <p className="flex items-center gap-2 tabular-nums mt-0.5">
          <span className="w-2 h-2 rounded-full bg-slate-300" />
          <span className="text-slate-500">Qty:</span>
          <span className="font-medium text-slate-700">{d.qtyLabel}</span>
        </p>
      )}
      {d.billCount != null && (
        <p className="flex items-center gap-2 tabular-nums">
          <span className="w-2 h-2 rounded-full bg-slate-300" />
          <span className="text-slate-500">Bills:</span>
          <span className="font-medium text-slate-700">{fmtInt(d.billCount)}</span>
        </p>
      )}
    </div>
  );
}

function ExceptionTile({ icon: Icon, label, value, sub, tone }) {
  const toneCls = {
    rose: 'border-rose-200 bg-rose-50/40', amber: 'border-amber-200 bg-amber-50/40',
    blue: 'border-blue-200 bg-blue-50/40', slate: 'border-slate-200 bg-slate-50/40',
  }[tone] || 'border-slate-200';
  const iconCls = { rose: 'text-rose-600', amber: 'text-amber-600', blue: 'text-blue-600', slate: 'text-slate-500' }[tone] || 'text-slate-500';
  return (
    <div className={`min-w-0 rounded-lg border p-2.5 sm:p-3 ${toneCls}`}>
      <div className="flex items-center gap-2 mb-1.5">
        <Icon size={14} className={iconCls} />
        <p className="text-[11px] uppercase tracking-wide text-slate-500 font-medium truncate">{label}</p>
      </div>
      <p className="text-sm sm:text-base font-bold text-slate-900 money leading-tight">{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

export default function PurchaseDashboardOverview() {
  const navigate = useNavigate();
  const isNarrow = useIsNarrow();
  // Filters live in the address (and a session mirror), not component state, so
  // the company/period picked here is still applied when you move to Purchase
  // Analytics or Vendor Insights -- and Back returns you here still filtered.
  // Same param names all three pages use; see components/purchaseFilter.js.
  const f = usePurchaseFilter({ period: 'month' });
  const period = f.get('period', 'month');
  const anchor = f.get('anchor', todayISO());
  const from = f.get('from', todayISO());
  const to = f.get('to', todayISO());
  const companyId = f.get('company');
  const productId = f.get('product');
  const vendor = f.get('vendor');
  // Period and its navigator anchor must move in ONE update: two sequential
  // writes both read the last-committed params, so the second drops the first.
  const setPeriod = (v) => f.setFilter({ period: v, anchor: v === 'fy' ? fyTokenFor(new Date()) : todayISO() });
  const setAnchor = (v) => f.setFilter({ anchor: v });
  const setFrom = (v) => f.setFilter({ from: v });
  const setTo = (v) => f.setFilter({ to: v });
  const setProductId = (v) => f.setFilter({ product: v });
  const setVendor = (v) => f.setFilter({ vendor: v });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);   // bump to refetch after a Zoho import
  const [compareOpen, setCompareOpen] = useState(false);   // Tally vs ERP modal

  const { options: companyOptions } = useLookup('/api/companies/');
  // ?slim=1 -> id + name only. This dropdown shows product NAMES; the full
  // Product filter — server-side search via ProductPicker (no rows prop).
  // The useLookup('/api/products/?slim=1') that used to sit here downloaded
  // the full catalog and was the cause of OOM on the 512 MB Render instance.
  const { options: vendorOptions } = useLookup(
    companyId ? `/api/vendors/?company=${companyId}&has_purchases=true&slim=1` : '/api/vendors/?has_purchases=true&slim=1',
  );


  // A picked past month/week (anchor ≠ today) is sent as a custom range so the
  // backend honours it; otherwise the granularity is sent and it computes.
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
    if (productId) p.set('product', productId);
    if (vendor) p.set('vendor', vendor);
    apiClient.get(`/api/purchase/dashboard/analytics/?${p.toString()}`)
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(e => { if (!cancelled) setError(e.response?.data?.detail || 'Failed to load analytics.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period, anchor, from, to, companyId, productId, vendor, reloadTick]);

  const vendChart = useMemo(() => (data?.top_vendors || []).map(v => ({
    name: v.vendor_name, full: v.vendor_name, amount: Number(v.amount) || 0, id: v.vendor_id,
    qtyLabel: fmtQtyBreakdown(v.qty_breakdown), billCount: v.bill_count,
  })), [data]);
  // Normalise item names to English and MERGE neem spellings into one bar (sum
  // value + quantities), so the chart reads "Neem Seed / Fruit" once instead of
  // the same raw material under six Tamil/Hindi/English names.
  const prodChart = useMemo(() => {
    const m = new Map();
    for (const p of (data?.top_products || [])) {
      const name = itemDisplay(p.product_name);
      const e = m.get(name) || { name, full: name, amount: 0, id: p.product_id, _qty: {} };
      e.amount += Number(p.amount) || 0;
      for (const q of (p.qty_breakdown || [])) {
        const u = String(q.uom || '').toUpperCase();
        e._qty[u] = (e._qty[u] || 0) + (Number(q.qty) || 0);
      }
      m.set(name, e);
    }
    return [...m.values()]
      .map(e => ({ name: e.name, full: e.full, amount: e.amount, id: e.id,
        qtyLabel: fmtQtyBreakdown(Object.entries(e._qty).map(([uom, qty]) => ({ uom, qty }))) }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10);
  }, [data]);
  const trendChart = useMemo(() => (data?.mom_trend || []).map(m => ({
    label: m.label.replace(' 20', " '"), billed: Number(m.billed) || 0, paid: Number(m.paid) || 0,
  })), [data]);

  const exc = data?.exceptions;

  // One write, not two: clearing the vendor alongside the company in a single
  // update, or the second call would read stale params and drop the first.
  const onCompanyChange = (v) => f.setFilter({ company: v, vendor: '' });
  // Company quick-toggle buttons (SS Biochem / United Agro) — like Sales Analytics.
  const companyButtons = (() => {
    const bioCo = companyOptions.find((c) => /biochem/i.test(c.label));
    const uaiCo = companyOptions.find((c) => /united\s*agro/i.test(c.label));
    const quick = [...(bioCo ? [bioCo] : []), ...(uaiCo ? [uaiCo] : [])];
    if (!quick.length) return null;
    // Rendered at every width. These chips ARE the company filter now --
    // the dropdown that used to sit beside the period controls is gone --
    // so hiding them on a phone would leave no way to scope by company.
    const shortName = (label) => (/biochem/i.test(label) ? 'SS Biochem' : /united\s*agro/i.test(label) ? 'United Agro' : label);
    return (
      <div className="flex items-center gap-1.5 shrink-0">
        {quick.map((c) => {
          const active = String(companyId || '') === String(c.value);
          return (
            <button key={c.value} type="button" onClick={() => onCompanyChange(active ? '' : c.value)} title={c.label}
              className={`px-2 py-1.5 rounded-lg text-xs font-semibold border transition whitespace-nowrap ${active
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                : 'bg-white text-slate-700 border-slate-200 hover:border-indigo-300 hover:text-indigo-600'}`}>
              {shortName(c.label)}
            </button>
          );
        })}
      </div>
    );
  })();

  const filterBar = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex rounded-lg border border-slate-200 overflow-hidden">
        {[{ v: 'today', l: 'Today' }, { v: 'week', l: 'Week' }, { v: 'month', l: 'Month' }, { v: 'fy', l: 'FY' }, { v: 'custom', l: 'Custom' }].map((pp, i) => (
          <button key={pp.v} type="button" onClick={() => setPeriod(pp.v)}
            title={pp.v === 'fy' ? 'Financial year (1 Apr – 31 Mar)' : undefined}
            className={`px-2.5 text-xs inline-flex items-center ${CTRL_H} ${i > 0 ? 'border-l border-slate-200' : ''} ${period === pp.v ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>{pp.l}</button>
        ))}
      </div>
      {period === 'fy' && (
        <CustomSelect value={anchor} onChange={e => setAnchor(e.target.value)} title="Select financial year / half"
          className={`border border-slate-300 rounded-lg px-2 text-sm bg-white min-w-[190px] ${CTRL_H}`}>
          {fyOptions().map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </CustomSelect>
      )}
      {period === 'week' && (
        <CustomSelect value={weekRangeOf(anchor).from} onChange={e => setAnchor(e.target.value)} title="Select week"
          className={`border border-slate-300 rounded-lg px-2 text-sm bg-white min-w-[180px] ${CTRL_H}`}>
          {weekOptions().map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
        </CustomSelect>
      )}
      {period === 'month' && (
        <CustomSelect value={monthRangeOf(anchor).from} onChange={e => setAnchor(e.target.value)} title="Select month"
          className={`border border-slate-300 rounded-lg px-2 text-sm bg-white min-w-[130px] ${CTRL_H}`}>
          {monthOptions().map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </CustomSelect>
      )}
      {period === 'custom' && (
        <div className="flex items-center gap-1.5 text-xs">
          <CustomDatePicker value={from} onChange={e => setFrom(e.target.value)} max={to} className="border border-slate-300 rounded px-2 py-1.5" />
          <span className="text-slate-400">to</span>
          <CustomDatePicker value={to} onChange={e => setTo(e.target.value)} min={from} max={todayISO()} className="border border-slate-300 rounded px-2 py-1.5" />
        </div>
      )}
      {/* No company dropdown - the chips beside the title do this, and the
          active one toggles off to clear it. It also offered companies this
          module never uses (Biogreen has no purchases). No warehouse filter
          either: everything here is bill-based and bills carry no warehouse,
          so that dropdown silently did nothing. */}
      <ProductPicker value={productId}
        onChange={e => setProductId(e.target.value)}
        className={`inline-flex items-center gap-1.5 border border-slate-300 rounded-lg px-2 text-sm bg-white text-slate-700 hover:bg-slate-50 min-w-[130px] max-w-[200px] ${CTRL_H}`} />
      <CustomSelect value={vendor} onChange={e => setVendor(e.target.value)}
        className={`border border-slate-300 rounded-lg px-2 text-sm bg-white min-w-[150px] ${CTRL_H}`}>
        <option value="">All Vendors</option>
        {vendorOptions.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
      </CustomSelect>
      {/* Tally vs ERP (scan) capture comparison for this window. */}
      <button type="button" onClick={() => setCompareOpen(true)}
        title="Compare what Tally and the ERP (scan) each captured"
        className={`inline-flex items-center gap-1.5 border border-slate-300 rounded-lg px-2.5 text-xs font-medium bg-white text-slate-700 hover:bg-slate-50 ${CTRL_H}`}>
        <ArrowLeftRight size={14} className="text-indigo-600" /> Tally vs ERP
      </button>
    </div>
  );

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Purchase Dashboard"
        subtitle="Top vendors & products, month-on-month trend, and exception reports"
        breadcrumbs={[{ label: 'Purchase', href: '/purchase/requests' }, { label: 'Dashboard' }]}
        actions={{
          right: (
            <div className="flex items-center gap-2">
              {companyButtons}
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
              {data?.period?.from && (
                <span className="text-slate-400 normal-case tracking-normal">· {data.period.label}{data.period.from ? ` (${data.period.from} → ${data.period.to})` : ''}</span>
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
            {/* Top vendors + Top products */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <SectionCard icon={Users} title="Top 10 Vendors" subtitle="By billed value this period" tone="indigo">
                {/* Phones get a ranked list: full vendor names, values inline,
                    and no floating tooltip to cover the rows below. */}
                {isNarrow ? (
                  <RankedBarList
                    items={vendChart.map((v) => ({
                      id: v.id, name: v.full, value: v.amount,
                      meta: [v.qtyLabel, v.billCount != null
                        ? `${fmtInt(v.billCount)} bill${Number(v.billCount) === 1 ? '' : 's'}` : '']
                        .filter(Boolean).join(' · '),
                    }))}
                    color={VENDOR_COLOR}
                    formatValue={fmtINRfull}
                    emptyText="No purchases in this period."
                  />
                ) : vendChart.length === 0
                  ? <p className="px-5 py-10 text-sm text-slate-400 text-center">No purchases in this period.</p>
                  : (
                    <div className="p-4">
                      <ResponsiveContainer width="100%" height={Math.max(160, vendChart.length * 40)}>
                        <BarChart data={vendChart} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                          <CartesianGrid horizontal={false} stroke="#f1f5f9" />
                          <XAxis type="number" tickFormatter={fmtINR} tick={{ fontSize: 10, fill: '#94a3b8' }} />
                          <YAxis type="category" dataKey="name" width={isNarrow ? 116 : 170} tick={<CatTick max={isNarrow ? 16 : 22} />} interval={0} />
                          <Tooltip content={<MoneyTooltip valueKeys={{ amount: 'Billed' }} />} cursor={{ fill: '#eef2ff' }} />
                          <Bar dataKey="amount" name="Billed" fill={VENDOR_COLOR} radius={[0, 4, 4, 0]} barSize={16} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
              </SectionCard>

              <SectionCard icon={Package} title="Top 10 Products" subtitle="By purchased value this period" tone="sky">
                {isNarrow ? (
                  <RankedBarList
                    items={prodChart.map((p) => ({
                      id: p.id, name: p.full, value: p.amount, meta: p.qtyLabel,
                    }))}
                    color={PRODUCT_COLOR}
                    formatValue={fmtINRfull}
                    emptyText="No purchases in this period."
                  />
                ) : prodChart.length === 0
                  ? <p className="px-5 py-10 text-sm text-slate-400 text-center">No purchases in this period.</p>
                  : (
                    <div className="p-4">
                      <ResponsiveContainer width="100%" height={Math.max(160, prodChart.length * 40)}>
                        <BarChart data={prodChart} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                          <CartesianGrid horizontal={false} stroke="#f1f5f9" />
                          <XAxis type="number" tickFormatter={fmtINR} tick={{ fontSize: 10, fill: '#94a3b8' }} />
                          <YAxis type="category" dataKey="name" width={isNarrow ? 116 : 170} tick={<CatTick max={isNarrow ? 16 : 22} />} interval={0} />
                          <Tooltip content={<MoneyTooltip valueKeys={{ amount: 'Value' }} />} cursor={{ fill: '#e0f2fe' }} />
                          <Bar dataKey="amount" name="Value" fill={PRODUCT_COLOR} radius={[0, 4, 4, 0]} barSize={16} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
              </SectionCard>
            </div>

            {/* Month-on-month trend */}
            <SectionCard icon={TrendingUp} title="Month-on-Month Trend" subtitle="This financial year (Apr onward) · billed vs paid" tone="emerald">
              <div className="p-4">
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={trendChart} margin={{ top: 8, right: 24, bottom: 4, left: 8 }}>
                    <CartesianGrid stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#475569' }} />
                    <YAxis tickFormatter={fmtINR} tick={{ fontSize: 10, fill: '#94a3b8' }} width={64} />
                    <Tooltip content={<MoneyTooltip valueKeys={{ billed: 'Billed', paid: 'Paid' }} />} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="billed" name="Billed" stroke="#6366f1" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                    <Line type="monotone" dataKey="paid" name="Paid" stroke="#10b981" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </SectionCard>

            {/* Exception reports */}
            <SectionCard icon={AlertTriangle} title="Exception Reports" subtitle="Items that need attention" tone="rose">
              <div className="p-4 space-y-4">
                <div className="metric-grid">
                  <ExceptionTile icon={CalendarClock} tone="rose" label="Overdue Bills"
                    value={fmtInt(exc?.overdue?.count)} sub={fmtINRfull(exc?.overdue?.amount)} />
                  <ExceptionTile icon={AlertTriangle} tone="rose" label="Severely Overdue (>90d)"
                    value={fmtInt(exc?.severely_overdue?.count)} sub={fmtINRfull(exc?.severely_overdue?.amount)} />
                  <ExceptionTile icon={RotateCcw} tone="amber" label="Purchase Returns"
                    value={fmtInt(exc?.returns?.count)} sub={fmtINRfull(exc?.returns?.amount)} />
                  <ExceptionTile icon={FileWarning} tone="blue" label="Draft (Unfinalised)"
                    value={fmtInt(exc?.draft_bills?.count)} sub={fmtINRfull(exc?.draft_bills?.amount)} />
                </div>

                {/* Longest-overdue bills */}
                {exc?.overdue_rows?.length > 0 && (
                  <div className="rounded-lg border border-slate-200 overflow-hidden">
                    <div className="px-4 py-2 bg-rose-50 border-b border-rose-100 flex items-center gap-2">
                      <AlertTriangle size={14} className="text-rose-600" />
                      <span className="text-xs font-semibold text-rose-800">Longest-overdue bills</span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs sm:text-[13px]">
                        <thead className="bg-slate-100 text-slate-500 text-[11px] uppercase tracking-wide">
                          <tr>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Bill</th>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Bill Date</th>
                            <th className="text-left px-3 py-2 font-semibold">Vendor</th>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Due Date</th>
                            <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Days Late</th>
                            <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Balance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {exc.overdue_rows.map((r, i) => (
                            <tr key={i} className="border-t border-slate-100 odd:bg-white even:bg-slate-50/50">
                              <td className="px-3 py-2 font-medium whitespace-nowrap">
                                {r.bill_id
                                  ? <button type="button" onClick={() => navigate(`/purchase/bills/${r.bill_id}`)}
                                      className="text-violet-700 hover:underline font-medium">{r.bill_no}</button>
                                  : <span className="text-slate-700">{r.bill_no}</span>}
                              </td>
                              <td className="px-3 py-2 text-slate-500 whitespace-nowrap tabular-nums">{fmtDate(r.bill_date)}</td>
                              <td className="px-3 py-2 text-slate-700 max-w-[240px] truncate" title={r.vendor_name}>{r.vendor_name}</td>
                              <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{fmtDate(r.due_date)}</td>
                              <td className="px-3 py-2 text-right text-rose-600 font-medium tabular-nums">{r.days_overdue != null ? `${r.days_overdue}d` : '—'}</td>
                              <td className="px-3 py-2 text-right font-semibold text-slate-800 tabular-nums whitespace-nowrap">{fmtINRfull(r.balance)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Dormant vendors */}
                <div className="rounded-lg border border-slate-200 overflow-hidden">
                  <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 flex items-center gap-2">
                    <UserX size={14} className="text-slate-500" />
                    <span className="text-xs font-semibold text-slate-700">Dormant vendors</span>
                    <span className="text-[11px] text-slate-500">— billed before, none in the last 90 days ({fmtInt(exc?.dormant_vendors?.count)})</span>
                  </div>
                  {exc?.dormant_vendors?.rows?.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs sm:text-[13px]">
                        <thead className="bg-slate-100 text-slate-500 text-[11px] uppercase tracking-wide">
                          <tr>
                            <th className="text-left px-3 py-2 font-semibold">Vendor</th>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Last Bill</th>
                            <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Total Bills</th>
                          </tr>
                        </thead>
                        <tbody>
                          {exc.dormant_vendors.rows.map((r, i) => (
                            <tr key={i} className="border-t border-slate-100 odd:bg-white even:bg-slate-50/50">
                              <td className="px-3 py-2 text-slate-700 max-w-[280px] truncate" title={r.vendor_name}>{r.vendor_name}</td>
                              <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{fmtDate(r.last_bill)}</td>
                              <td className="px-3 py-2 text-right text-slate-600 tabular-nums">{fmtInt(r.bill_count)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="px-4 py-4 sm:py-5 text-sm text-slate-400 text-center">No dormant vendors — everyone billed recently.</p>
                  )}
                </div>
              </div>
            </SectionCard>

            {/* Quick link to the work-tracking dashboard */}
            <button type="button" onClick={() => navigate(`/purchase/dashboard${f.query}`)}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-700">
              Open Purchase work-tracking dashboard <ChevronRight size={15} />
            </button>
          </>
        )}
      </div>
      {compareOpen && (
        <SourceCompareModal
          params={(() => {
            const p = new URLSearchParams();
            if (period === 'custom' || usePastWindow) { p.set('period', 'custom'); p.set('from', effRange.from); p.set('to', effRange.to); }
            else p.set('period', period);
            if (companyId) p.set('company', companyId);
            return p.toString();
          })()}
          onClose={() => setCompareOpen(false)}
        />
      )}
    </MainLayout>
  );
}
