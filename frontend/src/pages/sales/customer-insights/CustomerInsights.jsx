/**
 * Customer Insights — Customer 360 (REAL data).
 *
 * A single-customer deep view wired to the live ERP:
 *   - customer list / profile  → /api/customers/  &  /api/customers/{id}/
 *   - KPIs, sales-by-month      → /api/sales/dashboard/?customer=…
 *   - opening/closing, bills,
 *     receipts, timeline        → /api/sales/receivables/customer-ledger/?customer=…
 *   - payment / aging buckets   → /api/sales/dashboard/records/?type=receivables_buckets&customer=…
 *   - top products (by qty)     → /api/sales/dashboard/records/?type=dispatches&customer=…
 *
 * Metrics the ERP doesn't track (credit/health score, credit limit, fulfilment %,
 * on-time delivery %, return rate, account manager) are intentionally omitted —
 * everything shown here is real and reconciles to Tally.
 */
import { useEffect, useMemo, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ResponsiveContainer, LineChart, Line, PieChart, Pie, XAxis, YAxis,
  CartesianGrid, Tooltip, Cell, Legend,
} from 'recharts';
import {
  TrendingUp, Wallet, AlertCircle, Building2, MapPin, CreditCard,
  Calendar, FileText, Phone, Mail, User, Receipt, SlidersHorizontal,
  Loader2, Sparkles, Package, Search, X,
} from 'lucide-react';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import CustomSelect from '@/components/ui/CustomSelect';
import { CTRL_H } from '@/components/common/controls';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { formatDate } from '@/utils/formatters';

// ── Formatting ───────────────────────────────────────────────────────
const num = (v) => Number(v) || 0;
const fmtINR = (v) => {
  const n = num(v);
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};
const fmtFull = (v) => `₹${num(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Exact full amount, no paise — e.g. ₹6,30,00,000 (not the ₹6.30Cr short form).
const fmtRup = (v) => `₹${Math.round(num(v)).toLocaleString('en-IN')}`;
// Compact duration: 3 days → "3d", 90 days → "3m" (rounded to months past 30d).
const dfmt = (d) => (num(d) >= 30 ? `${Math.round(num(d) / 30)}m` : `${Math.round(num(d))}d`);
const fmtQty = (v) => num(v).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2026-04" → "Apr '26" (no Date parsing — the ISO date's first 7 chars).
const monthLabel = (ym) => {
  const [y, m] = String(ym || '').split('-');
  const mi = parseInt(m, 10) - 1;
  return (MONTH_ABBR[mi] || '?') + " '" + String(y || '').slice(2);
};
const fmtDate = (iso) => (iso ? formatDate(iso) : '—');
const pct = (a, b) => (num(b) ? Math.round((num(a) / num(b)) * 100) : 0);
const CREDIT_DAYS = { CASH: 0, NET_15: 15, NET_30: 30, NET_45: 45, NET_60: 60 };
const tooltipStyle = { fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' };
const PIE_COLORS = ['#6366f1', '#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b', '#f43f5e', '#14b8a6', '#a855f7'];

const shortCompany = (label) => {
  const w = String(label || '').replace(/[.,]/g, ' ').split(/\s+/)
    .filter(x => x && !/^(pvt|private|ltd|limited|llp|inc|co|company|india|the|and|&)$/i.test(x));
  return (w.slice(0, 2).join(' ') || label || '').toUpperCase();
};

// Product-family taxonomy — kept identical to the Sales Analytics By-Item view
// (pages/sales/dashboard/index.jsx) so "By group" here buckets dispatches into
// the SAME meaningful families (Azadirachtin 300/1500/10000/50000 PPM, Cake,
// Karanja Oil, Kernel, Liquid Organic Manure, Compost/Manure, Others) instead of
// the single "FINISHED GOODS" Tally stock group every finished good shares.
function cleanFam(fam) {
  let f = String(fam || '').replace(/\s*-\s*(TVP|TR)\b/gi, '').replace(/\s+/g, ' ').trim();
  const m = f.match(/^azadirachtin\s+([\d,]+)\s*ppm/i);
  if (m) return `Azadirachtin ${m[1].replace(/,/g, '')} PPM`;
  return f;
}
function canonFamily(productName, rawFamily) {
  const name = String(productName || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const fam = String(rawFamily || '').trim();

  if (fam) return cleanFam(fam);          // already classified → keep, just tidy

  // Unclassified → derive the family from the product name.
  if (/\(0\.3\)|0\.3\s*%/.test(name)) return 'Azadirachtin 3000 PPM';   // 0.3% EC = 3000 ppm
  if (/1\.2\s*%/.test(name)) return 'Azadirachtin 12000 PPM';           // 1.2% EC = 12000 ppm
  if (/neem extract|\bkernal\b/.test(name)) return 'Azadirachtin Technical';   // incl. Neem Kernal
  if (/karanja/.test(name)) return 'Karanja Oil';
  if (/neem kernel|\bkernel\b/.test(name)) return 'Kernel';
  if (/cake/.test(name)) return 'Cake';                        // mixed oil / neem / de-oil cake
  if (/liquid organic manure/.test(name)) return 'Liquid Organic Manure';
  if (/yellow maize|\bmaize\b/.test(name)) return 'Yellow Maize';
  if (/compost|organic manure/.test(name)) return 'Compost / Manure';
  if (/biostimulant|protein hydrolysate|emulsifier|talc|packing|organic granules|adjuvant|wetting/.test(name))
    return 'Others';
  if (/neem oil/.test(name)) return 'Azadirachtin 300 PPM';    // plain neem oil / EC / _EC / LTR / LIT / NKP
  return 'Others';                                             // catch-all → no "Unclassified" bucket
}

// Payment / aging buckets (from the receivables_buckets endpoint).
const BUCKET_META = {
  paid_early:     { label: 'Paid early', color: '#10b981' },
  still_open:     { label: 'Still open', color: '#0ea5e9' },
  paid_late:      { label: 'Paid late', color: '#f59e0b' },
  overdue_unpaid: { label: 'Overdue', color: '#ef4444' },
};
const BUCKET_ORDER = ['paid_early', 'still_open', 'paid_late', 'overdue_unpaid'];

// ── Period navigator (ported from the Sales Analytics page so the
// Today/Week/Month/FY/Custom picker behaves identically here) ────────────
const todayISO = () => new Date().toISOString().slice(0, 10);
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseISO = (s) => { const [y, m, d] = (s || todayISO()).split('-').map(Number); return new Date(y, m - 1, d); };
const monthRangeOf = (anchorISO) => {
  const d = parseISO(anchorISO);
  return { from: isoOf(new Date(d.getFullYear(), d.getMonth(), 1)), to: isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
};
const weekRangeOf = (anchorISO) => {
  const d = parseISO(anchorISO);
  const dow = (d.getDay() + 6) % 7;            // Monday = 0
  const mon = new Date(d); mon.setDate(d.getDate() - dow);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return { from: isoOf(mon), to: isoOf(sun) };
};
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
const rangeFor = (period, anchorRaw) => {
  const today = todayISO();
  const cap = (t) => (t > today ? today : t);
  const mismatched = String(anchorRaw).includes(FY_SEP) !== (period === 'fy');
  const anchorISO = mismatched ? (period === 'fy' ? fyTokenFor(new Date()) : today) : anchorRaw;
  if (period === 'today') return { from: anchorISO, to: anchorISO };
  if (period === 'week') { const r = weekRangeOf(anchorISO); return { from: r.from, to: cap(r.to) }; }
  if (period === 'month') { const r = monthRangeOf(anchorISO); return { from: r.from, to: cap(r.to) }; }
  if (period === 'fy') {
    const r = fyRangeOf(anchorISO);
    return { from: r.from, to: (r.from <= today && r.to > today) ? today : r.to };
  }
  return null;  // custom handled by the caller
};
const monthOptions = (count = 12) => {
  const now = new Date(); const out = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ value: isoOf(d), label: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) });
  }
  return out;
};
const weekOptions = (count = 10) => {
  const now = new Date(); const dow = (now.getDay() + 6) % 7;
  const thisMon = new Date(now); thisMon.setDate(now.getDate() - dow);
  const out = [];
  for (let i = 0; i < count; i++) {
    const mon = new Date(thisMon); mon.setDate(thisMon.getDate() - i * 7);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const lbl = `${mon.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} – ${sun.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`;
    out.push({ value: isoOf(mon), label: i === 0 ? `${lbl} (this week)` : lbl });
  }
  return out;
};
const effWindow = (period, anchor, customFrom, customTo) =>
  period === 'custom'
    ? { from: customFrom, to: customTo }
    : (rangeFor(period, anchor) || { from: customFrom, to: customTo });

// Short label for the "N customers · <period>" line.
// Where a record opened from this page returns to: this page exactly as it
// stands, customer and period included. It used to be the bare string
// '/sales/customer-insights', which is the welcome screen -- so Back landed on
// "Find a customer" with everything forgotten.
//
// Module scope on purpose: the rows that use it live in Customer360, while the
// address itself is owned by CustomerInsights. Reading window.location at click
// time means neither has to hand it to the other.
const backHere = () => `${window.location.pathname}${window.location.search}`;

function periodLabelOf(period, anchor, win) {
  if (period === 'custom') return `${win.from} → ${win.to}`;
  if (period === 'today') return formatDate(win.from);
  if (period === 'week') return `${formatDate(win.from)} – ${formatDate(win.to)}`;
  if (period === 'month') return parseISO(anchor).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  return fyOptions().find(f => f.value === anchor)?.label || 'FY';
}

function PeriodNavigator({ period, setPeriod, anchor, setAnchor, customFrom, customTo, setCustomFrom, setCustomTo }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className={`flex rounded-lg border border-slate-300 overflow-hidden ${CTRL_H}`}>
        {[{ v: 'today', l: 'Today' }, { v: 'week', l: 'Week' }, { v: 'month', l: 'Month' }, { v: 'fy', l: 'FY' }, { v: 'custom', l: 'Custom' }].map((p, i) => (
          <button key={p.v} type="button" onClick={() => { setPeriod(p.v); setAnchor(p.v === 'fy' ? fyTokenFor(new Date()) : todayISO()); }}
            title={p.v === 'fy' ? 'Financial year (1 Apr – 31 Mar)' : undefined}
            className={`px-2.5 text-xs ${i > 0 ? 'border-l border-slate-200' : ''} ${period === p.v ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>{p.l}</button>
        ))}
      </div>
      {period === 'today' && (
        <CustomDatePicker value={anchor} onChange={e => setAnchor(e.target.value || todayISO())} max={todayISO()}
          className={`border border-slate-300 rounded-lg px-2 text-xs bg-white max-w-[150px] ${CTRL_H}`} />
      )}
      {period === 'week' && (
        <CustomSelect value={weekRangeOf(anchor).from} onChange={e => setAnchor(e.target.value)}
          className={`border border-slate-300 rounded-lg px-2 text-xs bg-white max-w-[190px] ${CTRL_H}`} title="Select week">
          {weekOptions().map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
        </CustomSelect>
      )}
      {period === 'month' && (
        <CustomSelect value={monthRangeOf(anchor).from} onChange={e => setAnchor(e.target.value)}
          className={`border border-slate-300 rounded-lg px-2 text-xs bg-white max-w-[140px] ${CTRL_H}`} title="Select month">
          {monthOptions().map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </CustomSelect>
      )}
      {period === 'fy' && (
        <CustomSelect value={anchor} onChange={e => setAnchor(e.target.value)}
          className={`border border-slate-300 rounded-lg px-2 text-xs bg-white max-w-[210px] ${CTRL_H}`} title="Select financial year / half">
          {fyOptions().map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </CustomSelect>
      )}
      {period === 'custom' && (
        <div className="flex items-center gap-1.5 text-xs">
          <CustomDatePicker value={customFrom} onChange={e => setCustomFrom(e.target.value)} max={customTo}
            className={`border border-slate-300 rounded px-2 text-xs ${CTRL_H}`} />
          <span className="text-slate-400">to</span>
          <CustomDatePicker value={customTo} onChange={e => setCustomTo(e.target.value)} min={customFrom} max={todayISO()}
            className={`border border-slate-300 rounded px-2 text-xs ${CTRL_H}`} />
        </div>
      )}
    </div>
  );
}

// ── Building blocks ──────────────────────────────────────────────────
const TONE = {
  indigo: 'bg-indigo-50 text-indigo-600', emerald: 'bg-emerald-50 text-emerald-600',
  rose: 'bg-rose-50 text-rose-600', amber: 'bg-amber-50 text-amber-600',
  sky: 'bg-sky-50 text-sky-600', violet: 'bg-violet-50 text-violet-600', slate: 'bg-slate-100 text-slate-600',
};
function Tile({ icon: Icon, label, value, sub, tone = 'slate', onClick }) {
  return (
    <div onClick={onClick} className={`min-w-0 bg-white rounded-xl border border-slate-200 p-3.5 sm:p-4 ${onClick ? 'cursor-pointer hover:border-indigo-300 hover:shadow-sm transition' : ''}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className={`p-1.5 rounded-lg ${TONE[tone]}`}><Icon size={16} /></span>
        <p className="text-[11px] uppercase tracking-wide text-slate-500 font-medium truncate">{label}</p>
      </div>
      <p className="text-base sm:text-lg font-bold text-slate-900 tabular-nums leading-tight break-words">{value}</p>
      {sub && <p className="text-[11px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}
function Card({ title, subtitle, children, right, className = '' }) {
  return (
    <div className={`bg-white rounded-xl border border-slate-200 p-4 ${className}`}>
      {(title || right) && (
        <div className="flex items-start justify-between gap-2 mb-3">
          <div>
            {title && <h3 className="text-sm font-semibold text-slate-800">{title}</h3>}
            {subtitle && <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>}
          </div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}
function MiniStat({ label, value, tone = 'slate' }) {
  const c = { emerald: 'text-emerald-700', rose: 'text-orange-700', indigo: 'text-indigo-700', slate: 'text-slate-800' }[tone];
  return (
    <div className="min-w-0 rounded-lg border border-slate-200 bg-slate-50/60 p-2.5">
      <p className="text-[11px] uppercase tracking-wide text-slate-500 font-medium truncate">{label}</p>
      <p className={`text-sm font-bold tabular-nums mt-0.5 break-words leading-tight ${c}`}>{value}</p>
    </div>
  );
}
const bal = (v) => { const n = num(v); return `${fmtFull(Math.abs(n))} ${n < 0 ? 'Cr' : 'Dr'}`; };
// A NEGATIVE outstanding is money sitting with us: the customer paid more than
// we invoiced, or credit notes outran the bills. Tally writes that as "Cr" and
// the Closing box on this very page already does — but the Outstanding tile
// printed a bare minus, so one screen said the same thing two ways. SS Biochem's
// KSE Limited read "₹-2,79,884" directly above "₹2,79,884.00 Cr", and the minus
// looked like a bug when the figure matched Tally exactly.
//
// Only the credit case changes. An ordinary debit balance still prints plainly,
// without a "Dr" suffix the other tiles don't carry.
const credOrPlain = (v, f) => { const n = num(v); return n < 0 ? `${f(-n)} Cr` : f(n); };
const typeCls = (t) => ({
  Invoice: 'bg-sky-50 text-sky-700', Receipt: 'bg-emerald-50 text-emerald-700',
  'Debit Note': 'bg-amber-50 text-amber-700', 'Credit Note': 'bg-blue-50 text-blue-700',
  TDS: 'bg-violet-50 text-violet-700', Journal: 'bg-slate-100 text-slate-600',
}[t] || 'bg-slate-100 text-slate-600');

// ── Customer 360 (real data) ─────────────────────────────────────────
function Customer360({ customers, custLoading, company, id, setId, from, to, periodLabel, basis = 'turnover', onPickMonth }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState(null);   // clicked KPI tile → drill-down popup
  const [bktTip, setBktTip] = useState(null);    // payment-bucket bar hover tooltip
  // Don't auto-pick a customer — the page opens on the search landing. If the
  // current pick drops out of the (re-filtered) list, fall back to the landing.
  //
  // The loading guard is the whole point: switching company re-fetches this
  // list, and an in-flight fetch shows as an EMPTY list. Without the guard the
  // check read "not in the list" and threw the user back to the landing every
  // time they touched a company chip while looking at a customer. Wait until
  // the list has actually arrived before deciding a customer is missing from
  // it. An empty result that is genuinely empty still falls through, one
  // render later, and behaves as before.
  useEffect(() => {
    if (custLoading || !customers.length) return;
    if (id && !customers.some(c => String(c.value) === String(id))) { setId(''); setSearch(''); }
  }, [customers, custLoading]);   // eslint-disable-line react-hooks/exhaustive-deps

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [profile, setProfile] = useState(null);
  const [stats, setStats] = useState(null);
  const [ledger, setLedger] = useState(null);
  // Raw dispatch lines are kept so the Product / Group switch below can
  // re-aggregate them locally. Re-fetching per switch would hit the same
  // endpoint for the same rows.
  const [dispLines, setDispLines] = useState([]);
  const [prodBasis, setProdBasis] = useState('group');   // 'product' | 'group' — opens on By group
  const [prodExpanded, setProdExpanded] = useState(false); // "Show all" for the breakdown list
  const [buckets, setBuckets] = useState(null);
  const [momTrend, setMomTrend] = useState([]);

  // Identical aggregation to the one that used to run inside the fetch --
  // same lines, same qty sum, same descending sort, same top 6. The only
  // thing the switch changes is WHICH FIELD is the key: `product` (the item)
  // or the product FAMILY (canonFamily — the same taxonomy the By-Item view
  // uses, NOT the raw Tally stock group, which is "FINISHED GOODS" for all).
  const products = useMemo(() => {
    const m = new Map();
    for (const l of dispLines) {
      const k = (prodBasis === 'group' ? canonFamily(l.product, l.family) : l.product) || '—';
      m.set(k, (m.get(k) || 0) + num(l.qty));
    }
    return [...m.entries()].map(([name, qty]) => ({ name, qty }))
      .sort((a, b) => b.qty - a.qty).slice(0, 6);
  }, [dispLines, prodBasis]);

  // Full breakdown that fills the space under the donut. Same product/family
  // basis as the donut, but ALL rows (not just top 6) and quantities kept PER
  // UOM (Ltrs and MTS never added) so each row reads "1,38,000 Ltrs" / "40 MTS"
  // like the Quantity pop-up. `total` only orders the rows.
  const prodRows = useMemo(() => {
    const m = new Map();
    for (const l of dispLines) {
      const k = (prodBasis === 'group' ? canonFamily(l.product, l.family) : l.product) || '—';
      if (!m.has(k)) m.set(k, new Map());
      const byUom = m.get(k);
      const u = l.uom || '';
      byUom.set(u, (byUom.get(u) || 0) + num(l.qty));
    }
    return [...m.entries()]
      .map(([name, byUom]) => ({
        name,
        parts: [...byUom.entries()].filter(([, q]) => q !== 0).sort((a, b) => b[1] - a[1]),
        total: [...byUom.values()].reduce((a, b) => a + b, 0),
      }))
      .filter(r => r.parts.length)
      .sort((a, b) => b.total - a.total);
  }, [dispLines, prodBasis]);

  // Month-by-month dispatched qty for the product/group clicked in the donut
  // (detail === "item:<name>"). Same basis as the donut, quantities kept PER
  // UOM, chronological. Fills the drill-down pop-up instead of one lone number.
  const itemMonths = useMemo(() => {
    if (!detail || !detail.startsWith('item:')) return [];
    const name = detail.slice(5);
    const m = new Map();   // "YYYY-MM" -> Map(uom -> qty)
    for (const l of dispLines) {
      const k = (prodBasis === 'group' ? canonFamily(l.product, l.family) : l.product) || '—';
      if (k !== name) continue;
      const mk = String(l.date || '').slice(0, 7);
      if (!mk) continue;
      if (!m.has(mk)) m.set(mk, new Map());
      const byUom = m.get(mk);
      const u = l.uom || '';
      byUom.set(u, (byUom.get(u) || 0) + num(l.qty));
    }
    return [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([mk, byUom]) => ({
        month: mk,
        parts: [...byUom.entries()].filter(([, q]) => q !== 0).sort((a, b) => b[1] - a[1]),
      }));
  }, [detail, dispLines, prodBasis]);

  // Per-UOM total across the months, for the pop-up's footer row.
  const itemMonthTotals = useMemo(() => {
    const t = new Map();
    for (const r of itemMonths) for (const [u, q] of r.parts) t.set(u, (t.get(u) || 0) + q);
    return [...t.entries()].sort((a, b) => b[1] - a[1]);
  }, [itemMonths]);

  // Same dispatch lines, split for the Quantity pop-up. Quantities are kept
  // PER UOM and never added across units -- Ltrs and MTS are different things,
  // so a product that ships in both shows both. `total` exists only to order
  // the list and is never displayed.
  const [qtyBasis, setQtyBasis] = useState('product');   // 'product' | 'group'
  const qtyRows = useMemo(() => {
    const m = new Map();
    for (const l of dispLines) {
      const k = (qtyBasis === 'group' ? canonFamily(l.product, l.family) : l.product) || '—';
      if (!m.has(k)) m.set(k, new Map());
      const byUom = m.get(k);
      const u = l.uom || '';
      byUom.set(u, (byUom.get(u) || 0) + num(l.qty));
    }
    return [...m.entries()]
      .map(([name, byUom]) => ({
        name,
        parts: [...byUom.entries()].filter(([, q]) => q !== 0).sort((a, b) => b[1] - a[1]),
        total: [...byUom.values()].reduce((a, b) => a + b, 0),
      }))
      .filter(r => r.parts.length)
      .sort((a, b) => b.total - a.total);
  }, [dispLines, qtyBasis]);

  useEffect(() => {
    if (!id) return;
    let cancel = false; setLoading(true); setErr(null);
    const qs = `customer=${id}&period=custom&from=${from}&to=${to}&basis=${basis}`;
    Promise.all([
      apiClient.get(`/api/customers/${id}/`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/sales/dashboard/?${qs}`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/sales/receivables/customer-ledger/?customer=${id}&from=${from}&to=${to}`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/sales/dashboard/records/?type=dispatches&${qs}`).then(r => r.data?.rows || []).catch(() => []),
      apiClient.get(`/api/sales/dashboard/records/?type=receivables_buckets&${qs}`).then(r => r.data).catch(() => null),
      // mom_trend lives on the ANALYTICS endpoint, not the plain /dashboard/ one
      // (which only returns `stats` + a POs/SOs `trend`). It's the same two-line
      // Invoiced-vs-Received series the Sales Analytics Month-on-Month chart uses,
      // and it honours the customer + from/to window we pass here.
      apiClient.get(`/api/sales/dashboard/analytics/?${qs}`).then(r => r.data?.mom_trend || []).catch(() => []),
    ]).then(([prof, dash, led, disp, bkt, trend]) => {
      if (cancel) return;
      setProfile(prof); setStats(dash?.stats || null); setMomTrend(trend || []); setLedger(led); setBuckets(bkt);
      // Keep the parent document's date on each line so the Top Products
      // drill-down can pivot a product/group's dispatched qty month by month.
      setDispLines(disp.flatMap(row => (row.lines || []).map(l => ({ ...l, date: row.date }))));
    }).catch(e => { if (!cancel) setErr(e.response?.data?.detail || 'Failed to load customer data.'); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [id, from, to, basis]);

  // Welcome-screen facts — a LIVE "who owes what" snapshot (outstanding is a
  // running balance, so it's not tied to the period filter), scoped to the
  // selected company. Drives the fact cards + top-debtors list on the landing.
  const [dropOpen, setDropOpen] = useState(false);
  const [factRows, setFactRows] = useState([]);
  useEffect(() => {
    let cancel = false;
    apiClient.get(`/api/sales/dashboard/records/?type=outstanding_customers${company ? `&company=${company}` : ''}`)
      .then(r => { if (!cancel) setFactRows(r.data?.rows || []); })
      .catch(() => { if (!cancel) setFactRows([]); });
    return () => { cancel = true; };
  }, [company]);
  const facts = useMemo(() => {
    const rows = (factRows || []).map(r => ({ id: String(r.id), name: r.customer_name, out: num(r.outstanding), overdue: num(r.overdue) }));
    const overdueRows = rows.filter(r => r.overdue > 0);
    return {
      rows,
      totalOut: rows.reduce((s, r) => s + r.out, 0),
      overdueCount: overdueRows.length,
      overdueAmt: overdueRows.reduce((s, r) => s + r.overdue, 0),
      top: [...rows].sort((a, b) => b.out - a.out),
      count: rows.length,
    };
  }, [factRows]);
  const outById = useMemo(() => { const m = new Map(); facts.rows.forEach(r => m.set(r.id, r)); return m; }, [facts]);
  const sortedCustomers = useMemo(() =>
    [...customers].sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: 'base' })),
    [customers]);

  if (!customers.length) {
    return <div className="bg-white rounded-xl border border-slate-200 py-16 text-center text-sm text-slate-400">No customers with sales for this company.</div>;
  }

  // Welcome screen — no customer chosen yet → big search + facts panel.
  // Picking a customer (search or a top-debtors row) opens the full 360.
  if (!id) {
    const q = search.trim().toLowerCase();
    const dropList = sortedCustomers.filter(c => !q || String(c.label).toLowerCase().includes(q));
    const quick = facts.top.slice(0, 6);
    const pick = (v) => { setId(String(v)); setSearch(''); setDropOpen(false); };
    const maxOut = facts.top[0]?.out || 1;
    const overduePct = facts.totalOut ? Math.round(facts.overdueAmt / facts.totalOut * 100) : 0;
    return (
      <div className="space-y-3">
        {/* Find a customer — clean centred search card */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 text-center">
          <p className="text-lg font-bold text-slate-900 mb-1">Find a customer</p>
          <p className="text-sm text-slate-400 mb-4">Search {customers.length} customers, or pick one below.</p>
          <div className="max-w-2xl mx-auto relative">
            <Search size={20} className="text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
            <input value={search}
              onChange={e => { setSearch(e.target.value); setDropOpen(true); }}
              onFocus={() => setDropOpen(true)}
              placeholder="Search a customer by name…"
              className="w-full pl-12 pr-4 py-3.5 rounded-2xl border border-slate-200 bg-white text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-300" />
            {dropOpen && q && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setDropOpen(false)} />
                <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden max-h-80 overflow-y-auto divide-y divide-slate-100 text-left">
                  {dropList.length ? dropList.slice(0, 40).map(c => {
                    const o = outById.get(String(c.value));
                    return (
                      <button key={c.value} type="button" onClick={() => pick(c.value)}
                        className="w-full text-left px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-indigo-50/60">
                        <span className="text-sm font-medium text-slate-700 truncate">{c.label}</span>
                        {o && <span className={`shrink-0 text-xs tabular-nums ${o.overdue > 0 ? 'text-red-600 font-semibold' : 'text-slate-500'}`}>{fmtRup(o.out)}{o.overdue > 0 ? ' • overdue' : ''}</span>}
                      </button>
                    );
                  }) : <p className="px-4 py-3 text-sm text-slate-400">No customer matches “{search}”.</p>}
                </div>
              </>
            )}
          </div>
          {quick.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">Quick pick</span>
              {quick.map(c => (
                <button key={c.id} type="button" onClick={() => pick(c.id)} title={c.name}
                  className="group inline-flex items-center px-3 py-1.5 rounded-full border border-slate-200 bg-white hover:border-indigo-300 hover:shadow-sm transition">
                  <span className="text-sm text-slate-700 group-hover:text-indigo-600">{c.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Bold glance panel + rich top-by-outstanding list */}
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-3">
          <div className="rounded-2xl p-5 bg-white border border-slate-200 h-fit">
            <p className="text-sm font-semibold text-slate-800">At a glance</p>
            <p className="text-[11px] text-slate-400 mb-3">Receivables snapshot · as at today</p>
            <p className="text-3xl font-extrabold tabular-nums text-slate-900 leading-none">{fmtRup(facts.totalOut)}</p>
            <p className="text-xs text-slate-500 mt-1">Total outstanding · {facts.count} customers</p>
            <div className="mt-4 h-2.5 rounded-full overflow-hidden bg-slate-100"><div className="h-full bg-blue-500" style={{ width: `${overduePct}%` }} /></div>
            <div className="mt-3 space-y-1.5 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">Overdue amount</span><span className="font-bold tabular-nums text-rose-600">{fmtRup(facts.overdueAmt)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Overdue customers</span><span className="font-bold text-rose-600">{facts.overdueCount}</span></div>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-3 sm:p-4">
            <div className="px-2 pb-2">
              <p className="text-sm font-bold text-slate-800">Top by outstanding</p>
              <p className="text-[11px] text-slate-400">Largest unpaid balances · tap to open</p>
            </div>
            {facts.top.length ? (
              <div className="space-y-0.5">
                {facts.top.slice(0, 4).map((c, i) => (
                  <button key={c.id} type="button" onClick={() => pick(c.id)}
                    className="w-full flex items-center gap-3 text-left px-3 py-2.5 rounded-xl hover:bg-slate-50 transition">
                    <span className={`w-6 h-6 rounded-full text-[11px] font-bold flex items-center justify-center shrink-0 ${i < 3 ? `${['bg-amber-400', 'bg-slate-400', 'bg-orange-400'][i]} text-white` : 'bg-slate-100 text-slate-400'}`}>{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-slate-800 truncate">{c.name}</span>
                      <span className="mt-1 block h-1.5 rounded-full bg-slate-100 overflow-hidden"><span className="block h-full rounded-full bg-blue-500" style={{ width: `${Math.max(6, c.out / maxOut * 100)}%` }} /></span>
                    </span>
                    <span className="text-right shrink-0">
                      <span className="block text-sm font-bold tabular-nums text-slate-900">{fmtRup(c.out)}</span>
                      {c.overdue > 0 ? <span className="text-[10px] font-semibold text-rose-600 uppercase tracking-wide">overdue</span> : <span className="text-[10px] text-slate-400">current</span>}
                    </span>
                  </button>
                ))}
              </div>
            ) : <p className="text-sm text-slate-400 py-8 text-center">No outstanding balances.</p>}
          </div>
        </div>
      </div>
    );
  }

  const rs = stats?.received_against_sales || {};
  // Ex-GST on the TURNOVER basis - the page asks the dashboard for no `basis`,
  // so the backend's default ('turnover') is what comes back. This is the pure
  // sales value: charges, freight and own-branch transfers out, notes applied.
  // It used to show `incl_gst`, which put GST inside a figure labelled Total
  // Sales and could not be compared with Tally's Sales Accounts.
  const totalSales = num(rs.taxable);
  // Collections are gross, so the "% collected" ratio keeps the GST-inclusive
  // denominator. Measuring cash received against an ex-GST figure would report
  // a percentage that can never be right.
  const salesInclGst = num(rs.incl_gst);
  // Name the basis the figures came back on, so the tile can never claim one
  // report while showing the other. `rs.basis` is echoed by the API rather than
  // assumed from the button, which keeps label and number honest even if a
  // request is in flight.
  const basisLabel = (rs.basis || basis) === 'sales_accounts' ? 'GSTR-1' : 'turnover';
  const received = num(stats?.amount_received?.total);
  const out = stats?.outstanding_receivables || {};
  const outstanding = num(out.as_at_total ?? out.total);
  const invCount = num(stats?.quantity_invoiced?.invoice_count);
  const aov = invCount ? Math.round(totalSales / invCount) : 0;
  // Quantity now comes from the INVOICE lines -- the same documents as Total
  // Sales, so the two can never disagree about what they cover, and it is net
  // of credit notes exactly as Sales Analytics is.
  //
  // The tile used to read `quantity_dispatched`, which is sourced from delivery
  // challans. A Tally-imported invoice has no DC, so a customer could show
  // crores of revenue against a dash and "0 DC(s)" -- which is what Greenstar
  // did. Sales Analytics already moved to the invoiced basis for this exact
  // reason; this brings Customer Insights into line with it. Both fields were
  // already in the API response, so nothing is asked of the backend.
  const qtyStr = (stats?.quantity_invoiced?.uom_breakdown || []).map(b => `${fmtQty(b.qty)} ${b.uom}`).join(' · ') || '—';

  const rows = ledger?.rows || [];
  const allBills = [...rows].filter(r => r.type === 'Invoice' || r.type === 'Debit Note').reverse();
  const allReceipts = [...rows].filter(r => r.type === 'Receipt').reverse();
  const bills = allBills.slice(0, 6);
  const payments = allReceipts.slice(0, 6);
  const timeline = [...rows].slice(-8).reverse();

  // Adaptive trend from the dashboard's mom_trend — day-by-day for a Month/Week,
  // month-by-month for FY — exactly like the Sales Analytics "Month-on-Month Trend"
  // (two lines: Invoiced vs Received). Shows whenever there's ANY activity, so a
  // period with receipts but no new sales still plots the Received line.
  const trend = momTrend.map(m => ({
    // `month` is the "YYYY-MM" key — kept so a click can jump the period there.
    month: m.month || '',
    label: (m.label || m.month || '').replace(' 20', " '"),
    invoiced: num(m.invoiced), received: num(m.received),
  }));
  const hasTrend = trend.some(m => m.invoiced || m.received);
  const prodChart = products.map(p => ({ name: p.name, qty: Math.round(p.qty) }));

  // Real payment / aging buckets, flattened from the two term-groups.
  const subs = (buckets?.groups || []).flatMap(g => (g.sub || []).map(s => {
    const srows = s.rows || [];
    const ds = srows.map(r => num(r.days)).filter(d => d > 0);
    return {
      key: s.key,
      amount: srows.reduce((a, r) => a + num(r.amount), 0),
      count: s.count ?? srows.length,
      // Average age for the bucket (days early / to-due / late / overdue).
      avgDays: ds.length ? Math.round(ds.reduce((a, b) => a + b, 0) / ds.length) : 0,
      // Kept so a bucket can be opened — the rows already carry everything.
      rows: srows,
    };
  }));
  const bucketRows = BUCKET_ORDER
    .map(k => ({ k, ...BUCKET_META[k], ...(subs.find(s => s.key === k) || { amount: 0, count: 0, avgDays: 0, rows: [] }) }));
  const bucketTot = bucketRows.reduce((a, b) => a + b.amount, 0) || 1;

  const creditDays = profile?.credit_terms === 'CUSTOM'
    ? `${profile?.custom_credit_days || 0} days`
    : (profile?.credit_terms ? `${CREDIT_DAYS[profile.credit_terms] ?? ''} days` : '');
  const ba = profile?.billing_address || {};
  const location = [ba.city, ba.state].filter(Boolean).join(', ') || ba.state || '';
  const name = profile?.customer_name || customers.find(c => String(c.value) === String(id))?.label || 'Customer';

  // Only show profile fields that actually have a value (hide empty ones).
  const fields = [
    { icon: FileText, label: 'GSTIN', value: profile?.gstin },
    { icon: User, label: 'Contact', value: profile?.contact_person },
    { icon: CreditCard, label: 'PAN', value: profile?.pan },
    { icon: Phone, label: 'Phone', value: profile?.contact_phone },
    { icon: MapPin, label: 'Location', value: location },
    { icon: Mail, label: 'Email', value: profile?.contact_email },
    { icon: Calendar, label: 'Credit terms', value: creditDays },
    { icon: Building2, label: 'GST type', value: (profile?.gst_treatment || '').replace(/_/g, ' ').toLowerCase() },
  ].filter(f => f.value && String(f.value).trim());

  return (
    <div className="space-y-4">
      {/* No customer picker — the header ‹ back arrow returns to the welcome list. */}
      {err && <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg p-3 text-sm flex items-center gap-2"><AlertCircle size={14} /> {err}</div>}

      {/* Profile — one compact strip: name (single line) + details inline */}
      <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white flex items-center justify-center font-bold shrink-0">{name.slice(0, 1)}</div>
            <div>
              <h3 className="text-base font-bold text-slate-900 leading-tight inline-flex items-center gap-2" title={name}>{name}{loading && <Loader2 size={14} className="animate-spin text-indigo-500" />}</h3>
              <p className="text-[11px] text-slate-400">{profile?.created_at ? `Customer since ${String(profile.created_at).slice(0, 4)}` : (profile?.customer_code || '')}</p>
            </div>
          </div>
          {fields.length > 0 && <span className="hidden md:block h-9 w-px bg-slate-100" />}
          {fields.length ? fields.map(f => {
            const Icon = f.icon;
            return (
              <span key={f.label} className="inline-flex items-center gap-1.5 text-sm">
                <Icon size={13} className="text-slate-400" />
                <span className="text-slate-400">{f.label}</span>
                <span className="font-medium text-slate-700">{f.value}</span>
              </span>
            );
          }) : <span className="text-xs text-slate-400">No profile details on file.</span>}
        </div>
      </div>

      {/* KPI tiles — real, full width */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 sm:gap-3">
        <Tile icon={TrendingUp} tone="indigo" label="Total Sales" value={fmtRup(totalSales)} sub={`ex-GST · ${basisLabel}`} onClick={() => setDetail('sales')} />
        <Tile icon={Wallet} tone="emerald" label="Received" value={fmtRup(received)} sub={`${pct(received, salesInclGst)}% collected`} onClick={() => setDetail('received')} />
        <Tile icon={AlertCircle} tone="rose" label="Outstanding" value={credOrPlain(outstanding, fmtRup)} sub={`${num(out.count)} unpaid`} onClick={() => setDetail('outstanding')} />
        <Tile icon={FileText} tone="sky" label="Invoices" value={invCount.toLocaleString('en-IN')} sub={periodLabel} onClick={() => setDetail('invoices')} />
        <Tile icon={Receipt} tone="violet" label="Avg Order Value" value={fmtRup(aov)} sub="per invoice" onClick={() => setDetail('aov')} />
        <Tile icon={Package} tone="amber" label="Quantity" value={<span className="text-sm sm:text-base">{qtyStr}</span>} sub={`${invCount.toLocaleString('en-IN')} invoice(s)`} onClick={() => setDetail('quantity')} />
      </div>

      {/* Receivables + payment buckets */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card title="Receivables" subtitle="Running ledger · reconciles to Tally">
          <div className="grid grid-cols-2 gap-2.5">
            <MiniStat label="Opening" value={ledger ? bal(ledger.opening_balance) : '—'} />
            <MiniStat label="Invoiced (Dr)" value={ledger ? fmtFull(ledger.current_debit) : '—'} />
            <MiniStat label="Received (Cr)" value={ledger ? fmtFull(ledger.current_credit) : '—'} tone="emerald" />
            <MiniStat label="Closing" value={ledger ? bal(ledger.closing_balance) : '—'} tone="rose" />
          </div>
          <p className="text-[11px] text-slate-400 mt-2.5">Outstanding as at {fmtDate(out.as_at)} · <span className="font-semibold text-orange-700">{credOrPlain(outstanding, fmtRup)}</span></p>
        </Card>

        <Card title="Payment Buckets" subtitle="Invoices by due date · this period">
          {subs.length ? (
            <>
              <div className="relative mb-3">
                {bktTip && (
                  <div className="absolute -top-7 z-10 -translate-x-1/2 whitespace-nowrap bg-slate-900 text-white text-[11px] px-2 py-1 rounded shadow pointer-events-none" style={{ left: bktTip.x }}>
                    {bktTip.label}: <span className="tabular-nums font-semibold">{fmtRup(bktTip.amount)}</span>
                  </div>
                )}
                {/* The segment carried cursor-pointer but no handler. Now it
                    actually opens the bucket. */}
                <div className="flex h-3 rounded-full overflow-hidden bg-slate-100">
                  {bucketRows.map(b => b.amount > 0
                    ? <button key={b.k} type="button" aria-label={`${b.label} — ${b.count} invoice(s)`}
                        className="h-full cursor-pointer hover:opacity-80 transition-opacity"
                        style={{ width: `${b.amount / bucketTot * 100}%`, background: b.color }}
                        onClick={() => setDetail(`bucket:${b.k}`)}
                        onMouseMove={(e) => { const r = e.currentTarget.parentElement.getBoundingClientRect(); setBktTip({ label: b.label, amount: b.amount, x: e.clientX - r.left }); }}
                        onMouseLeave={() => setBktTip(null)} />
                    : null)}
                </div>
              </div>
              <div className="space-y-0.5">
                {bucketRows.map(b => (
                  <button key={b.k} type="button" disabled={!b.count}
                    onClick={() => setDetail(`bucket:${b.k}`)}
                    className={`w-full flex items-center justify-between gap-2 text-xs rounded-lg px-1.5 py-1 transition ${b.count ? 'hover:bg-slate-50 cursor-pointer' : 'cursor-default'}`}>
                    <span className="inline-flex min-w-0 items-center gap-1.5 text-slate-500 truncate">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: b.color }} />{b.label}
                      <span className="text-slate-300">· {b.count}</span>
                      {b.avgDays > 0 && <span className="text-slate-400">· ~{dfmt(b.avgDays)}</span>}
                    </span>
                    <span className={`shrink-0 tabular-nums ${b.k === 'overdue_unpaid' && b.amount > 0 ? 'text-red-600 font-semibold' : 'text-slate-600'}`}>{b.amount > 0 ? fmtRup(b.amount) : '—'}</span>
                  </button>
                ))}
              </div>
            </>
          ) : <p className="text-sm text-slate-400 py-8 text-center">No invoices in this period.</p>}
        </Card>
      </div>

      {/* Sales trend — two-line Invoiced vs Received, exactly like the Sales
          Analytics "Month-on-Month Trend"; adaptive to the selected period. */}
      <Card title="Sales Trend" subtitle={`Invoiced vs received · ${periodLabel} · click a month to filter`}>
        {hasTrend ? (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={trend} margin={{ top: 8, right: 24, bottom: 4, left: 8 }}
              className={onPickMonth ? 'cursor-pointer' : undefined}
              onClick={(e) => { const m = e?.activePayload?.[0]?.payload?.month; if (m && onPickMonth) onPickMonth(m); }}>
              <CartesianGrid stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#475569' }} />
              <YAxis tickFormatter={fmtINR} tick={{ fontSize: 11, fill: '#94a3b8' }} width={64} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v, n) => [fmtFull(v), n]} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="invoiced" name="Invoiced" stroke="#6366f1" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
              <Line type="monotone" dataKey="received" name="Received" stroke="#10b981" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        ) : <p className="text-sm text-slate-400 py-12 text-center">No activity in {periodLabel}.</p>}
      </Card>

      {/* Top products + timeline */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card title="Top Products" subtitle={`Share of dispatched quantity · by ${prodBasis === 'group' ? 'group' : 'product'} · this period`}>
          {prodChart.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={prodChart} dataKey="qty" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={92} paddingAngle={2}
                  onClick={(d) => d?.name && setDetail(`item:${d.name}`)} className="cursor-pointer">
                  {prodChart.map((_, k) => <Cell key={k} fill={PIE_COLORS[k % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} formatter={(v, n) => [fmtQty(v), n]} />
                <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
              </PieChart>
            </ResponsiveContainer>
          ) : <p className="text-sm text-slate-400 py-12 text-center">No dispatches in this period.</p>}
          {/* Sits with the legend, under the donut, where it was asked for.
              Same segmented styling as the Turnover / GSTR-1 switch at the top
              of the page, so the two read as the same kind of control. */}
          <div className="flex justify-center pt-1">
            <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
              {[['product', 'By product'], ['group', 'By group']].map(([k, label], i) => (
                <button key={k} type="button" onClick={() => setProdBasis(k)}
                  aria-pressed={prodBasis === k}
                  className={`px-3 py-1 text-[11px] font-medium transition ${i > 0 ? 'border-l border-slate-200' : ''} ${prodBasis === k
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Breakdown filling the space under the donut: the same slices with
              their exact quantities (per UOM, like the Quantity pop-up). Colour
              dots match the donut for the top 6; the rest fold behind
              "Show all" so a long list never blows out the card. */}
          {prodRows.length > 0 && (
            <div className="mt-3 border-t border-slate-100 pt-3">
              <div className="space-y-1.5">
                {(prodExpanded ? prodRows : prodRows.slice(0, 6)).map((r, i) => (
                  <div key={r.name} className="flex items-center gap-2 text-sm">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ background: i < 6 ? PIE_COLORS[i % PIE_COLORS.length] : '#cbd5e1' }} />
                    <span className="min-w-0 flex-1 truncate text-slate-700">{r.name}</span>
                    <span className="shrink-0 tabular-nums font-medium text-slate-900">
                      {r.parts.map(([u, q]) => `${fmtQty(q)}${u ? ` ${u}` : ''}`).join(' · ')}
                    </span>
                  </div>
                ))}
              </div>
              {prodRows.length > 6 && (
                <button type="button" onClick={() => setProdExpanded(v => !v)}
                  className="mt-2 text-[11px] font-semibold text-indigo-600 hover:text-indigo-700">
                  {prodExpanded ? 'Show less' : `Show all ${prodRows.length}`}
                </button>
              )}
            </div>
          )}
        </Card>

        <Card title="Activity Timeline" subtitle="Most recent transactions">
          {timeline.length ? (
            <div className="space-y-0">
              {timeline.map((t, i) => {
                const pay = t.type === 'Receipt' || t.type === 'Credit Note';
                const amt = num(t.debit) || num(t.credit);
                // Only rows with a ref open. Everything else stays a plain row
                // rather than looking clickable and doing nothing.
                const open = t.type === 'Invoice' && t.ref_id
                  ? () => navigate(`/sales/invoices/${t.ref_id}`, { state: { backTo: backHere() } })
                  : t.ref_kind === 'receipt' && t.ref_id
                    ? () => navigate(`/sales/receivables/receipt/${encodeURIComponent(t.ref_id)}?customer=${id}`, { state: { backTo: backHere() } })
                    : null;
                return (
                  <div key={i} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span className={`w-2.5 h-2.5 rounded-full mt-1.5 shrink-0 ${pay ? 'bg-emerald-500' : 'bg-sky-500'}`} />
                      {i < timeline.length - 1 && <span className="w-px flex-1 bg-slate-200 my-1" />}
                    </div>
                    <div className={`flex-1 pb-3 min-w-0 ${open ? 'cursor-pointer group' : ''}`} onClick={open || undefined}>
                      <div className="flex items-center justify-between gap-2">
                        <p className={`text-sm truncate ${open ? 'text-slate-700 group-hover:text-blue-700 group-hover:underline' : 'text-slate-700'}`}>{t.type}{t.doc_no ? ` · ${t.doc_no}` : ''}</p>
                        <span className={`text-xs tabular-nums shrink-0 ${pay ? 'text-emerald-700' : 'text-slate-500'}`}>{fmtRup(amt)}</span>
                      </div>
                      <p className="text-[11px] text-slate-400">{fmtDate(t.date)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : <p className="text-sm text-slate-400 py-12 text-center">No transactions in this period.</p>}
        </Card>
      </div>

      {/* Recent bills + payments */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card title="Recent Bills" subtitle="Latest invoices / debit notes">
          {bills.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-y border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                  <tr><th className="px-3 py-2 text-left font-semibold">Doc No</th><th className="px-3 py-2 text-left font-semibold">Type</th>
                    <th className="px-3 py-2 text-left font-semibold">Date</th><th className="px-3 py-2 text-right font-semibold">Amount</th></tr>
                </thead>
                <tbody>
                  {bills.map((b, i) => (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="px-3 py-2 font-medium">
                        {b.type === 'Invoice' && b.ref_id
                          ? <button type="button" onClick={() => navigate(`/sales/invoices/${b.ref_id}`, { state: { backTo: backHere() } })}
                              className="text-blue-700 hover:underline">{b.doc_no || '—'}</button>
                          : <span className="text-slate-700">{b.doc_no || '—'}</span>}
                      </td>
                      <td className="px-3 py-2"><span className={`inline-flex px-1.5 py-0.5 rounded text-[11px] font-medium ${typeCls(b.type)}`}>{b.type}</span></td>
                      <td className="px-3 py-2 text-slate-500">{fmtDate(b.date)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-800">{fmtFull(b.debit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="text-sm text-slate-400 py-8 text-center">No bills in this period.</p>}
        </Card>

        <Card title="Recent Payments" subtitle="Latest receipts">
          {payments.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-y border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                  <tr><th className="px-3 py-2 text-left font-semibold">Receipt</th><th className="px-3 py-2 text-left font-semibold">Date</th>
                    <th className="px-3 py-2 text-right font-semibold">Amount</th></tr>
                </thead>
                <tbody>
                  {payments.map((p, i) => (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="px-3 py-2 font-medium">
                        {p.ref_kind === 'receipt' && p.ref_id
                          ? <button type="button" onClick={() => navigate(`/sales/receivables/receipt/${encodeURIComponent(p.ref_id)}?customer=${id}`, { state: { backTo: backHere() } })}
                              className="text-emerald-700 hover:underline">{p.doc_no || 'Receipt'}</button>
                          : <span className="text-emerald-700">{p.doc_no || 'Receipt'}</span>}
                      </td>
                      <td className="px-3 py-2 text-slate-500">{fmtDate(p.date)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-800">{fmtFull(p.credit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="text-sm text-slate-400 py-8 text-center">No receipts in this period.</p>}
        </Card>
      </div>

      {/* KPI tile drill-down popup */}
      {detail && (() => {
        // Also serves the chart drills — a bucket segment opens "bucket:<key>",
        // a pie slice opens "item:<name>".
        const bkt = detail.startsWith('bucket:') ? bucketRows.find(b => b.k === detail.slice(7)) : null;
        const item = detail.startsWith('item:') ? prodChart.find(p => p.name === detail.slice(5)) : null;
        const T = bkt
          ? { title: bkt.label, value: fmtFull(bkt.amount), sub: `${bkt.count} invoice(s)${bkt.avgDays > 0 ? ` · ~${dfmt(bkt.avgDays)}` : ''} · ${periodLabel}` }
          : item
            ? { title: item.name, value: fmtQty(item.qty), sub: `${pct(item.qty, prodChart.reduce((a, p) => a + p.qty, 0))}% of dispatched quantity · ${periodLabel}` }
            : {
              sales: { title: 'Total Sales', value: fmtFull(totalSales), sub: `ex-GST · ${basisLabel} basis · incl. GST ${fmtFull(salesInclGst)} · ${periodLabel}` },
              received: { title: 'Received', value: fmtFull(received), sub: `${pct(received, salesInclGst)}% collected · ${periodLabel}` },
              outstanding: { title: 'Outstanding', value: credOrPlain(outstanding, fmtFull), sub: `${num(out.count)} unpaid · as at ${fmtDate(out.as_at)}` },
              invoices: { title: 'Invoices', value: invCount.toLocaleString('en-IN'), sub: periodLabel },
              aov: { title: 'Avg Order Value', value: fmtFull(aov), sub: `per invoice · ${periodLabel}` },
              quantity: { title: 'Quantity', value: qtyStr, sub: `${invCount.toLocaleString('en-IN')} invoice(s) · ${periodLabel}` },
            }[detail];
        // An unrecognised key would otherwise throw on T.title below.
        if (!T) return null;
        const invoiceTable = allBills.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-y border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                <tr><th className="px-4 py-1.5 text-left font-semibold">Doc No</th><th className="px-4 py-1.5 text-left font-semibold">Date</th><th className="px-4 py-1.5 text-right font-semibold">Amount</th></tr>
              </thead>
              <tbody>
                {allBills.map((b, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="px-4 py-1.5 font-medium">
                      {b.type === 'Invoice' && b.ref_id
                        ? <button type="button" onClick={() => navigate(`/sales/invoices/${b.ref_id}`, { state: { backTo: backHere() } })} className="text-blue-700 hover:underline">{b.doc_no || '—'}</button>
                        : <span className="text-slate-700">{b.doc_no || '—'}</span>}
                    </td>
                    <td className="px-4 py-1.5 text-slate-500">{fmtDate(b.date)}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-slate-800">{fmtFull(b.debit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-slate-400 py-8 text-center">No invoices in {periodLabel}.</p>;
        return (
          <div className="fixed inset-0 z-[60] bg-slate-900/40 flex items-center justify-center p-4" onClick={() => setDetail(null)}>
            <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[85dvh] flex flex-col" onClick={e => e.stopPropagation()}>
              <div className="flex items-start justify-between border-b border-slate-200 px-4 py-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-800">{T.title}</h3>
                  <p className="text-xl font-bold text-slate-900 tabular-nums leading-tight mt-0.5">{T.value}</p>
                  <p className="text-[11px] text-slate-400">{T.sub}</p>
                </div>
                <button onClick={() => setDetail(null)} className="p-1.5 rounded hover:bg-slate-100 text-slate-500 shrink-0"><X size={16} /></button>
              </div>
              <div className="overflow-auto">
                {bkt && (
                  bkt.rows.length ? (
                    <table className="w-full text-sm">
                      <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-y border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                        <tr><th className="px-4 py-1.5 text-left font-semibold">Invoice</th><th className="px-4 py-1.5 text-left font-semibold">Due</th>
                          <th className="px-4 py-1.5 text-left font-semibold">Age</th><th className="px-4 py-1.5 text-right font-semibold">Amount</th></tr>
                      </thead>
                      <tbody>
                        {bkt.rows.map((r, i) => (
                          <tr key={i} className="border-b border-slate-100">
                            <td className="px-4 py-1.5 font-medium">
                              {r.invoice_id && !r.is_opening
                                ? <button type="button" onClick={() => navigate(`/sales/invoices/${r.invoice_id}`, { state: { backTo: backHere() } })} className="text-blue-700 hover:underline">{r.invoice_no || '—'}</button>
                                : <span className="text-slate-700">{r.invoice_no || '—'}</span>}
                            </td>
                            <td className="px-4 py-1.5 text-slate-500">{fmtDate(r.due_date)}</td>
                            <td className="px-4 py-1.5 text-slate-500">{r.days_label || '—'}</td>
                            <td className="px-4 py-1.5 text-right tabular-nums text-slate-800">{fmtFull(r.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <p className="text-sm text-slate-400 py-8 text-center">No invoices in this bucket.</p>
                )}
                {item && (
                  itemMonths.length ? (
                    <div>
                      <table className="w-full text-sm">
                        <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-y border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                          <tr><th className="px-4 py-1.5 text-left font-semibold">Month</th>
                            <th className="px-4 py-1.5 text-right font-semibold">Quantity dispatched</th></tr>
                        </thead>
                        <tbody>
                          {itemMonths.map((r) => (
                            <tr key={r.month} className="border-b border-slate-100">
                              <td className="px-4 py-1.5 text-slate-700">{monthLabel(r.month)}</td>
                              <td className="px-4 py-1.5 text-right tabular-nums text-slate-800">
                                {r.parts.map(([u, q]) => `${fmtQty(q)}${u ? ` ${u}` : ''}`).join(' · ')}
                              </td>
                            </tr>
                          ))}
                          <tr className="bg-slate-50 font-semibold">
                            <td className="px-4 py-1.5 text-slate-700">Total</td>
                            <td className="px-4 py-1.5 text-right tabular-nums text-slate-900">
                              {itemMonthTotals.map(([u, q]) => `${fmtQty(q)}${u ? ` ${u}` : ''}`).join(' · ')}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                      <p className="text-[11px] text-slate-400 px-4 py-2">Month-wise dispatched quantity for this {prodBasis === 'group' ? 'group' : 'product'} in {periodLabel}.</p>
                    </div>
                  ) : (
                    <div className="p-4 space-y-1.5">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-500">Quantity dispatched</span>
                        <span className="tabular-nums font-semibold text-slate-800">{fmtQty(item.qty)}</span>
                      </div>
                      <p className="text-[11px] text-slate-400 pt-1">Dispatched quantity for this {prodBasis === 'group' ? 'group' : 'product'} in {periodLabel}.</p>
                    </div>
                  )
                )}
                {(detail === 'sales' || detail === 'invoices') && invoiceTable}
                {detail === 'aov' && (
                  <div>
                    <p className="text-sm text-slate-600 px-4 py-3 border-b border-slate-100">{fmtFull(totalSales)} total sales ÷ {invCount || 0} invoice(s) = <span className="font-semibold text-slate-900">{fmtFull(aov)}</span> per invoice.</p>
                    {invoiceTable}
                  </div>
                )}
                {detail === 'received' && (
                  allReceipts.length ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-y border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                          <tr><th className="px-4 py-1.5 text-left font-semibold">Receipt</th><th className="px-4 py-1.5 text-left font-semibold">Date</th><th className="px-4 py-1.5 text-right font-semibold">Amount</th></tr>
                        </thead>
                        <tbody>
                          {allReceipts.map((p, i) => (
                            <tr key={i} className="border-b border-slate-100">
                              <td className="px-4 py-1.5 font-medium">
                                {p.ref_kind === 'receipt' && p.ref_id
                                  ? <button type="button" onClick={() => navigate(`/sales/receivables/receipt/${encodeURIComponent(p.ref_id)}?customer=${id}`, { state: { backTo: backHere() } })} className="text-emerald-700 hover:underline">{p.doc_no || 'Receipt'}</button>
                                  : <span className="text-emerald-700">{p.doc_no || 'Receipt'}</span>}
                              </td>
                              <td className="px-4 py-1.5 text-slate-500">{fmtDate(p.date)}</td>
                              <td className="px-4 py-1.5 text-right tabular-nums text-slate-800">{fmtFull(p.credit)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : <p className="text-sm text-slate-400 py-8 text-center">No receipts in {periodLabel}.</p>
                )}
                {detail === 'outstanding' && (
                  <div className="p-4 space-y-3">
                    <div className="grid grid-cols-2 gap-2.5">
                      <MiniStat label="Opening" value={ledger ? bal(ledger.opening_balance) : '—'} />
                      <MiniStat label="Invoiced (Dr)" value={ledger ? fmtFull(ledger.current_debit) : '—'} />
                      <MiniStat label="Received (Cr)" value={ledger ? fmtFull(ledger.current_credit) : '—'} tone="emerald" />
                      <MiniStat label="Closing" value={ledger ? bal(ledger.closing_balance) : '—'} tone="rose" />
                    </div>
                  </div>
                )}
                {detail === 'quantity' && (
                  <div className="p-4 space-y-4">
                    {(stats?.quantity_invoiced?.uom_breakdown || []).length ? (
                      <div className="space-y-1.5">
                        {stats.quantity_invoiced.uom_breakdown.map((u, i) => (
                          <div key={i} className="flex items-center justify-between text-sm border-b border-slate-100 pb-1.5">
                            <span className="text-slate-500">{u.uom}</span>
                            <span className="tabular-nums font-semibold text-slate-800">{fmtQty(u.qty)} {u.uom}</span>
                          </div>
                        ))}
                        <p className="text-[11px] text-slate-400 pt-1">Across {invCount.toLocaleString('en-IN')} invoice(s), net of credit notes.</p>
                      </div>
                    ) : <p className="text-sm text-slate-400 py-8 text-center">No quantified invoice lines in {periodLabel}.</p>}

                    {/* Which products made up that quantity. Same switch as the
                        Top Products graph, and the same source: dispatch lines.
                        The totals above come from INVOICES, so the note below
                        says where this list comes from rather than letting the
                        two quietly disagree -- a Tally-imported customer with
                        no delivery challans has an invoice quantity and no
                        lines to split it by. */}
                    {qtyRows.length > 0 && (
                      <div>
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <p className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">
                            By {qtyBasis === 'group' ? 'group' : 'product'}
                          </p>
                          <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
                            {[['product', 'By product'], ['group', 'By group']].map(([k, label], i) => (
                              <button key={k} type="button" onClick={() => setQtyBasis(k)}
                                aria-pressed={qtyBasis === k}
                                className={`px-2.5 py-1 text-[11px] font-medium transition ${i > 0 ? 'border-l border-slate-200' : ''} ${qtyBasis === k
                                  ? 'bg-indigo-600 text-white'
                                  : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="space-y-1">
                          {qtyRows.map((r, i) => (
                            <div key={i} className="flex items-start justify-between gap-3 text-sm border-b border-slate-100 pb-1">
                              <span className="text-slate-600 min-w-0 break-words">{r.name}</span>
                              <span className="tabular-nums font-semibold text-slate-800 shrink-0 text-right">
                                {r.parts.map(([u, q]) => `${fmtQty(q)}${u ? ' ' + u : ''}`).join(' · ')}
                              </span>
                            </div>
                          ))}
                        </div>
                        <p className="text-[11px] text-slate-400 pt-1.5">
                          From dispatch challans — this split may not add up to the invoiced totals above.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── Shell ────────────────────────────────────────────────────────────
export default function CustomerInsights() {
  const { options: companyOptions } = useLookup('/api/companies/');

  // Only companies that actually SELL get a chip. Biogreen is a group company
  // and a customer in SS Biochem's books — it raises no sales invoice of its
  // own, so a chip for it is noise. Exactly the rule Sales Analytics already
  // applies; this page was listing every company instead.
  //
  // `sales_companies` is a distinct over non-cancelled sales invoices, not
  // period-scoped, so `period=today` is the cheapest way to ask for it. Until
  // it arrives the list is empty, and an empty set means "show them all" —
  // so the chips never flicker or vanish while the request is in flight.
  const [sellerIds, setSellerIds] = useState([]);
  useEffect(() => {
    let cancel = false;
    apiClient.get('/api/sales/dashboard/?period=today')
      .then(r => { if (!cancel) setSellerIds((r.data?.sales_companies || []).map(String)); })
      .catch(() => { /* leave empty — every company stays visible */ });
    return () => { cancel = true; };
  }, []);
  const [sp, setSp] = useSearchParams();
  const [company, setCompany] = useState(sp.get('company') || '');   // '' = all, else company id
  // Which Tally report the figures mirror. Default 'turnover' matches the
  // dashboard API's own default, so the first render asks for exactly what it
  // would have returned anyway and nothing re-fetches on load.
  const [basis, setBasis] = useState(sp.get('basis') || 'turnover');
  // Was a customer already chosen in the URL the FIRST time this page loaded
  // -- a deep link (Dashboard chart, bookmark, pasted link, a reload while
  // already here) -- as opposed to picked afterward from this page's own list.
  // A ref, not location.state: state only survives a click made in the SAME
  // browser tab session: a reload or a fresh tab opened straight to this URL
  // carries no state at all, and the arrow still has to do the right thing.
  const deepLinkedRef = useRef(!!sp.get('cust'));
  const [id, setId] = useState(sp.get('cust') || '');   // selected customer ('' = welcome screen)
  // Opening a customer from a long list and coming back used to dump you at the
  // top of the page. The list is tall, the detail view is short, so there is
  // nothing to scroll back to at the moment the browser tries. Remember the
  // position on the way in and put it back on the way out. Navigation comfort
  // only — no figure, filter or request is affected.
  const SCROLL_KEY = 'customer-insights-scroll';
  const setIdKeepingScroll = (v) => {
    try {
      if (v) sessionStorage.setItem(SCROLL_KEY, String(window.scrollY || 0));
      else {
        const y = parseInt(sessionStorage.getItem(SCROLL_KEY) || '0', 10);
        if (y > 0) requestAnimationFrame(() => window.scrollTo(0, y));
      }
    } catch { /* private mode - just lose the position */ }
    setId(v);
  };
  const [period, setPeriod] = useState(sp.get('period') || 'fy');
  const [anchor, setAnchor] = useState(sp.get('anchor') || fyTokenFor(new Date()));
  const [customFrom, setCustomFrom] = useState(sp.get('cfrom') || todayISO());
  const [customTo, setCustomTo] = useState(sp.get('cto') || todayISO());
  const win = effWindow(period, anchor, customFrom, customTo);
  const periodLabel = periodLabelOf(period, anchor, win);

  // Keep the address in step. `replace: true`: choosing a customer or a period
  // is not a separate destination within this page -- Back should leave the
  // page, not walk back through every customer looked at on the way.
  useEffect(() => {
    const pp = new URLSearchParams(sp);
    const put = (k, v, keep) => { if (keep) pp.set(k, v); else pp.delete(k); };
    put('cust', id, !!id);
    put('company', company, !!company);
    put('basis', basis, basis && basis !== 'turnover');
    put('period', period, period && period !== 'fy');
    put('anchor', anchor, period !== 'custom');
    put('cfrom', customFrom, period === 'custom');
    put('cto', customTo, period === 'custom');
    const next = pp.toString();
    if (next !== sp.toString()) setSp(pp, { replace: true });
  }, [id, company, basis, period, anchor, customFrom, customTo, sp, setSp]);

  const custUrl = company
    ? `/api/customers/?company=${company}&has_sales=true`
    : '/api/customers/?has_sales=true';
  const { options: customers, isLoading: custLoading } =
    useLookup(custUrl, { labelField: 'customer_name' });

  // Which Tally report the whole page mirrors. It changes what every figure
  // MEANS, so it sits at the top right -- the slot the company chips used to
  // hold -- rather than buried in the filter row. It is the only thing up
  // there now, which suits it: it is the page's most consequential switch.
  // Right-aligned inside its own wrapper so it hugs the corner the way the
  // chips did.
  const sellerCompanies = sellerIds.length
    ? companyOptions.filter(co => co.value && sellerIds.includes(String(co.value)))
    : companyOptions;

  // The company filter belongs on the FIND-A-CUSTOMER screen and nowhere else.
  // There it narrows which customers you are choosing from, which is the whole
  // job of that screen. Once a customer is open the chips did nothing useful --
  // you are looking at one party, and switching company only risked knocking
  // them out of the list under you -- so the detail view gives that slot to
  // Turnover / GSTR-1 instead. The two never appear together: this renders
  // when there is no `id`, basisChips when there is.
  const companyChips = !id ? (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {sellerCompanies.map(co => {
        const active = String(company) === String(co.value);
        return (
          <button key={co.value} type="button" onClick={() => setCompany(active ? '' : co.value)}
            title={co.label}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition whitespace-nowrap ${active ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm' : 'bg-white text-slate-700 border-slate-200 hover:border-indigo-300 hover:text-indigo-600'}`}>
            {shortCompany(co.label)}
          </button>
        );
      })}
    </div>
  ) : null;

  const basisChips = id ? (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {[['turnover', 'Turnover', 'Pure sales value — charges, freight and own-branch transfers out. Compare with Tally → Profit & Loss → Sales Accounts.'],
        ['sales_accounts', 'GSTR-1', 'GSTR-1 basis — debit/credit notes applied as GSTR-1 reports them (table 9B). Compare with Tally → GSTR-1.']
       ].map(([v, l, t]) => (
        <button key={v} type="button" onClick={() => setBasis(v)} title={t}
          className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition whitespace-nowrap ${basis === v ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm' : 'bg-white text-slate-700 border-slate-200 hover:border-indigo-300 hover:text-indigo-600'}`}>
          {l}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <MainLayout>
      <PageHeader
        title="Customer Insights"
        subtitle="360° view of a customer — sales, receivables & payment history"
        icon={Sparkles}
        breadcrumbs={[{ label: 'Sales', href: '/sales/dashboard' }, { label: 'Customer Insights' }]}
        actions={{ right: id ? basisChips : companyChips }}
        onBack={id ? () => {
          if (!deepLinkedRef.current) { setIdKeepingScroll(''); return; }
          // Real history to pop -> use it, so Forward still works afterward.
          // No history (opened this tab straight to the link) -> nothing to
          // pop, so go to the Dashboard directly instead of doing nothing.
          if (window.history.state?.idx > 0) navigate(-1);
          else navigate('/sales/overview');
        } : undefined}
      />

      {/* Period filter — only on the detail (second) page, not the welcome screen. */}
      {id && (
        <div className="bg-white rounded-lg border border-slate-200 mb-4 px-3 py-2 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 font-medium"><SlidersHorizontal size={14} /> Period</span>
          <PeriodNavigator period={period} setPeriod={setPeriod} anchor={anchor} setAnchor={setAnchor}
            customFrom={customFrom} customTo={customTo} setCustomFrom={setCustomFrom} setCustomTo={setCustomTo} />
          <span className="text-[11px] text-slate-400 tabular-nums ml-auto">{periodLabel}</span>
          {period !== 'fy' && (
            <button onClick={() => { setPeriod('fy'); setAnchor(fyTokenFor(new Date())); }}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-indigo-600 border border-slate-200 rounded-lg px-2 py-1">
              Reset
            </button>
          )}
        </div>
      )}

      <Customer360 customers={customers} custLoading={custLoading} company={company} id={id} setId={setIdKeepingScroll} from={win.from} to={win.to} periodLabel={periodLabel} basis={basis}
        onPickMonth={(m) => { setAnchor(`${m}-01`); setPeriod('month'); }} />
    </MainLayout>
  );
}
