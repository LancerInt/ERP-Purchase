// Sales Dashboard (overview) — analytics companion to the Sales Analytics
// drill-down page. Surfaces top 10 customers, top 10 products, a rolling
// 12-month month-on-month trend, and exception reports. Backed by the single
// GET /api/sales/dashboard/analytics/ endpoint.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  BarChart3, Users, Package, TrendingUp, AlertTriangle, Loader2,
  CalendarClock, FileWarning, RotateCcw, UserX, ChevronRight,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, Cell,
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
import useIsNarrow from '../../../hooks/useIsNarrow.js';
import { formatDate } from '@/utils/formatters';

const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtINR = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};
const fmtINRfull = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt = (v) => (Number(v) || 0).toLocaleString('en-IN');
const fmtQty = (v) => (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const fmtDate = (iso) => (iso ? formatDate(iso) : '—');

const CUSTOMER_COLOR = '#6366f1';   // indigo
const PRODUCT_COLOR = '#0ea5e9';    // sky

// Wrap a category label into up to two word-aware lines so the FULL name
// shows on the chart axis (truncated "SPAC Starch Products In…" labels were
// unreadable on mobile). A residual overlong 2nd line gets an ellipsis.
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

// Quantities span multiple unit types (LTRS vs KGS can't be summed into one
// number), so we keep them split per UOM — "12,345 LTRS · 678 KGS".
const fmtQtyBreakdown = (arr) => (arr || [])
  .filter((x) => Number(x.qty) > 0)
  .map((x) => `${Number(x.qty).toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${x.uom}`)
  .join(' · ');

// Period-navigator helpers (month / week picker), mirroring Sales Analytics.
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseISO = (s) => { const [y, m, d] = (s || todayISO()).split('-').map(Number); return new Date(y, m - 1, d); };
const monthRangeOf = (a) => { const d = parseISO(a); return { from: isoOf(new Date(d.getFullYear(), d.getMonth(), 1)), to: isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0)) }; };
const weekRangeOf = (a) => { const d = parseISO(a); const dow = (d.getDay() + 6) % 7; const mon = new Date(d); mon.setDate(d.getDate() - dow); const sun = new Date(mon); sun.setDate(mon.getDate() + 6); return { from: isoOf(mon), to: isoOf(sun) }; };
// Indian financial year: 1 Apr → 31 Mar (mirrors Sales Analytics). The FY anchor
// carries the explicit window as "FROM..TO" since a single date can't say whether
// the user picked the whole year or just one half.
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

function SectionCard({ icon: Icon, title, subtitle, tone = 'slate', children, right, clip = true }) {
  const toneCls = {
    slate: 'bg-slate-100 text-slate-600',
    indigo: 'bg-indigo-50 text-indigo-600',
    sky: 'bg-sky-50 text-sky-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    rose: 'bg-rose-50 text-rose-600',
    amber: 'bg-amber-50 text-amber-600',
  }[tone];
  return (
    // `clip={false}` for the bar charts: a joined bar's tooltip lists every
    // variant/branch, and for the lower bars it opens past the card's bottom
    // edge. Clipping cut it off; unclipped, it sits above the next section.
    <div className={`bg-white rounded-xl border border-slate-200 shadow-sm ${clip ? 'overflow-hidden' : 'relative z-10'}`}>
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

// A compact custom tooltip that formats money in full.
// Same three groups as CUSTOMER_GROUPS in backend dashboard_views.py.
const CUSTOMER_GROUPS = [
  ['KSE Limited', /^\s*kse\s+limited\b/i],
  ['T.Stanes', /^\s*t\s*\.?\s*stanes\b/i],
  ['Greenstar Fertilisers Limited', /^\s*greenstar\s+fertili[sz]ers?\s+limited\b/i],
];
const customerGroup = (name) => (CUSTOMER_GROUPS.find(([, rx]) => rx.test(name || '')) || [null])[0];
const companyShort = (code) => {
  const c = String(code || '').toUpperCase();
  return c.startsWith('UAI') ? 'UAI' : c.startsWith('SS') ? 'SS' : (code || '');
};

function MoneyTooltip({ active, payload, label, valueKeys }) {
  if (!active || !payload || !payload.length) return null;
  // The full row sits on payload[0].payload — carries qty/invoice counts that
  // aren't plotted as bars but we still want in the tooltip.
  const d = payload[0].payload || {};
  return (
    <div className={`bg-white border border-slate-200 rounded-lg shadow-md px-3 py-2 text-xs max-w-[92vw] ${d.members?.length > 8 ? 'sm:max-w-[560px] sm:min-w-[460px]' : 'sm:max-w-[300px]'}`}>
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
      {d.invoiceCount != null && (
        <p className="flex items-center gap-2 tabular-nums">
          <span className="w-2 h-2 rounded-full bg-slate-300" />
          <span className="text-slate-500">Invoices:</span>
          <span className="font-medium text-slate-700">{fmtInt(d.invoiceCount)}</span>
        </p>
      )}
      {d.members?.length > 0 && (() => {
        // A family can hold 20+ variants (Azadirachtin has 24). The tooltip
        // shows the biggest few and folds the rest into one line, so it never
        // runs off the bottom of the chart. The family's own name is dropped
        // from each line so the part that differs — the pack — is readable.
        const fam = String(label || '').replace(/\s*\((SS|UAI)\)\s*$/, '');
        const short = (n) => {
          const s = String(n || '');
          if (fam && s.toLowerCase().startsWith(fam.toLowerCase())) {
            const rest = s.slice(fam.length).replace(/^[\s\-_:]+/, '');
            return rest || s;
          }
          return s;
        };
        // Drop whatever every member SHARES, not just the group's own label.
        //
        // The label is a short display name ("T.Stanes (SS)") while the rows
        // carry the full legal one, so stripping the label alone left
        // "And Company Ltd., - Coimbatore" and "And Company Ltd - Coimbatore
        // - Exp" — two long lines whose only readable difference was at the
        // very end. Removing the common prefix leaves "Coimbatore" and
        // "Coimbatore - Exp", which is the part a reader is actually
        // comparing.
        //
        // Guarded, because a common prefix is not always a word: "Neem Oil"
        // and "Neem Oilcake" share eight characters and would leave "cake".
        // The cut only applies when every tail starts on a word boundary and
        // none of them comes out empty; otherwise it falls back to `short`.
        const names = d.members.map((m) => String(m.customer_name || m.product_name || ''));
        const tails = (() => {
          if (names.length < 2) return null;
          const min = Math.min(...names.map((s) => s.length));
          let cut = 0;
          while (cut < min
            && names.every((s) => s[cut].toLowerCase() === names[0][cut].toLowerCase())) cut++;
          // A trivially short prefix is not a company name. "T.Stanes And
          // Company Ltd., - Coimbatore" and "T. Stanes and Company Limited-
          // Bangalore" share only "T." — and because "." counts as a word
          // boundary the guard below was happy to cut there, producing
          // "Stanes And Company Ltd., - Coimbatore": two characters shorter
          // and no more readable. Worse, a non-null result here USED to
          // preempt the separator rule, which handles this shape perfectly.
          if (cut < 4) return null;
          const SEP = /^[\s\-_,.:;/|]+/;
          const endsAtBoundary = /[\s\-_,.:;/|]/.test(names[0][cut - 1] || '');
          const raw = names.map((s) => s.slice(cut));
          if (!raw.every((t) => SEP.test(t) || endsAtBoundary)) return null;
          const out = raw.map((t) => t.replace(SEP, '').trim());
          return out.every(Boolean) ? out : null;
        })();
        // A group with ONE branch has no sibling to compare against, so the
        // rule above cannot fire and the row stayed "And Company Ltd., -
        // Coimbatore". Tally names a branch "<Company> - <Branch>", so for
        // branches the part after the FIRST separator is the branch — and
        // keeping the rest of it joined means "Coimbatore - Exp" survives
        // intact rather than collapsing to "Exp".
        //
        // Branches only. A single VARIANT would lose the part that names it:
        // "Azadirachtin 300 PPM - TVP" would read "TVP".
        const isBranch = d.members[0]?.product_name == null;
        const afterFirstDash = (n) => {
          const parts = String(n || '').split(/\s*[-–—]\s+/);
          return parts.length > 1 ? parts.slice(1).join(' - ').trim() : '';
        };
        const nameFor = (m, i) => {
          const full = m.customer_name || m.product_name;
          // Branches first by SEPARATOR, not by what the names share. Tally
          // writes a branch as "<Company> - <Branch>", so the separator is
          // the reliable signal; what two branch names happen to have in
          // common depends on how consistently someone typed the company
          // part, which is exactly what went wrong above.
          if (isBranch) {
            const after = afterFirstDash(full);
            if (after) return after;
          }
          if (tails) return tails[i];
          return short(full);
        };
        // Every variant is listed. Past 8 they go in two columns with smaller
        // text, so even Azadirachtin's 24 fit inside the chart.
        const twoCol = d.members.length > 8;
        return (
          <div className="mt-1.5 pt-1.5 border-t border-slate-100">
            <p className="text-slate-400 mb-0.5">
              {d.members[0]?.product_name != null ? 'Variants' : 'Branches'} ({d.members.length})
            </p>
            <div className={twoCol ? 'grid grid-cols-2 gap-x-4 text-[10.5px] leading-[1.35]' : ''}>
              {d.members.map((m, i) => (
                <p key={m.customer_name || m.product_name} className="flex justify-between gap-2 tabular-nums">
                  <span className="text-slate-600 break-words"
                    title={m.customer_name || m.product_name}>
                    {nameFor(m, i)}
                  </span>
                  <span className="font-medium text-slate-700 shrink-0">{fmtINRfull(m.amount)}</span>
                </p>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function ExceptionTile({ icon: Icon, label, value, sub, tone }) {
  const toneCls = {
    rose: 'border-rose-200 bg-rose-50/40', amber: 'border-amber-200 bg-amber-50/40',
    blue: 'border-blue-200 bg-blue-50/40', slate: 'border-slate-200 bg-slate-50/40',
  }[tone] || 'border-slate-200';
  const iconCls = {
    rose: 'text-rose-600', amber: 'text-amber-600', blue: 'text-blue-600', slate: 'text-slate-500',
  }[tone] || 'text-slate-500';
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

export default function SalesDashboardOverview() {
  const navigate = useNavigate();
  const isNarrow = useIsNarrow();
  // Filters kept in the address, not just memory, so Back (e.g. from Customer
  // Insights after clicking a Top-10 bar) restores the exact view instead of
  // reopening on the default.
  const [sp, setSp] = useSearchParams();
  const [period, setPeriod] = useState(sp.get('period') || 'month');
  const [anchor, setAnchor] = useState(sp.get('anchor') || todayISO());
  const [from, setFrom] = useState(sp.get('from') || todayISO());
  const [to, setTo] = useState(sp.get('to') || todayISO());
  const [companyId, setCompanyId] = useState(sp.get('company') || '');
  const [warehouseId, setWarehouseId] = useState(sp.get('warehouse') || '');
  const [productId, setProductId] = useState(sp.get('product') || '');
  const [customer, setCustomer] = useState(sp.get('customer') || '');
  useEffect(() => {
    const p = new URLSearchParams();
    if (period !== 'month') p.set('period', period);
    if (period !== 'month') p.set('anchor', anchor);
    if (period === 'custom') { p.set('from', from); p.set('to', to); }
    if (companyId) p.set('company', companyId);
    if (warehouseId) p.set('warehouse', warehouseId);
    if (productId) p.set('product', productId);
    if (customer) p.set('customer', customer);
    if (p.toString() !== sp.toString()) setSp(p, { replace: true });
  }, [period, anchor, from, to, companyId, warehouseId, productId, customer]);   // eslint-disable-line
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const { options: companyOptions } = useLookup('/api/companies/');
  const { raw: warehousesRaw } = useLookup('/api/warehouses/');
  // Product filter — server-side search via ProductPicker (no rows prop).
  // Family grouping (Azadirachtin, Neem Oil, …) is computed server-side by
  // /api/products/search/?families=1 and shown automatically by the picker.
  // The useLookup('/api/products/?slim=1') that used to sit here downloaded
  // the full catalog (5,000+ rows) and was the cause of OOM on 512 MB.
  const { options: rawCustomerOptions, raw: customersRaw } = useLookup(
    companyId ? `/api/customers/?company=${companyId}&has_sales=true` : '/api/customers/?has_sales=true',
    { labelField: 'customer_name' },
  );
  // KSE / T.Stanes / Greenstar each appear ONCE per company (their branches'
  // ids joined), the same grouping the Top 10 uses — CUSTOMER_GROUPS in
  // dashboard_views.py. Everyone else is listed as before.
  const customerOptions = useMemo(() => {
    const byId = new Map((customersRaw || []).map((c) => [String(c.id), c]));
    const groups = new Map();
    const out = [];
    rawCustomerOptions.forEach((o) => {
      const grp = customerGroup(o.label);
      if (!grp) { out.push(o); return; }
      const co = byId.get(String(o.value));
      const coKey = String(co?.company ?? '');
      const key = `${coKey}|${grp}`;
      if (!groups.has(key)) {
        const g = { value: [], label: companyId ? grp : `${grp} (${companyShort(co?.company_name)})` };
        groups.set(key, g);
        out.push(g);
      }
      groups.get(key).value.push(o.value);
    });
    return out.map((o) => (Array.isArray(o.value) ? { ...o, value: o.value.join(',') } : o))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rawCustomerOptions, customersRaw, companyId]);

  const warehouseOptions = (companyId
    ? (warehousesRaw || []).filter(w => String(w.company ?? w.company_id) === String(companyId))
    : (warehousesRaw || [])).map(w => ({ value: w.id, label: w.name || w.warehouse_name || w.code || w.id }));

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
    if (warehouseId) p.set('warehouse', warehouseId);
    if (productId) p.set('product', productId);
    if (customer) p.set('customer', customer);
    apiClient.get(`/api/sales/dashboard/analytics/?${p.toString()}`)
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(e => { if (!cancelled) setError(e.response?.data?.detail || 'Failed to load analytics.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period, anchor, from, to, companyId, warehouseId, productId, customer]);

  const custChart = useMemo(() => (data?.top_customers || []).map(c => ({
    name: c.customer_name, full: c.customer_name, amount: Number(c.amount) || 0,
    invoice_count: c.invoice_count, id: c.customer_id,
    qtyLabel: fmtQtyBreakdown(c.qty_breakdown), invoiceCount: c.invoice_count,
    members: c.members || [],
  })), [data]);
  // Click a customer bar → open that customer on the Customer Insights page,
  // carrying the dashboard's current company and period so the two views match.
  // A grouped bar (e.g. KSE's two branches) has no single customer id, so it is
  // left non-navigable. Browser Back returns here because this is a normal
  // history push.
  const openCustomerInsight = (entry) => {
    const cid = entry && entry.id;
    // A grouped bar (KSE's two branches, Greenstar, T.Stanes...) sends its
    // member ids joined with a comma (see _top_customers in dashboard_views.py)
    // -- a non-empty, truthy string, so the old `if (!cid) return` here never
    // actually caught it despite the comment above saying it would. The result:
    // clicking KSE silently sent "id1,id2" as ?cust=, which matches no real
    // customer, so Customer Insights quietly reset to its own search screen
    // with no error. Checking for the comma is what the guard always meant to do.
    if (!cid || cid.includes(',')) return;
    const qp = new URLSearchParams();
    qp.set('cust', cid);
    if (companyId) qp.set('company', companyId);
    qp.set('period', period);
    if (period === 'custom') { qp.set('from', from); qp.set('to', to); }
    else qp.set('anchor', anchor);
    // A plain push (no replace), so the browser's own Back pops straight to
    // this Dashboard -- the comment below already counted on that. What it
    // missed: the in-app < arrow at the top of Customer Insights does NOT use
    // browser Back, it always clears the customer and shows that page's own
    // list instead. `backTo` tells it this particular visit has somewhere real
    // to return to, so it should pop the real history entry instead.
    navigate(`/sales/customer-insights?${qp.toString()}`, { state: { backTo: true } });
  };
  const prodChart = useMemo(() => (data?.top_products || []).map(p => ({
    name: p.product_name, full: p.product_name, amount: Number(p.amount) || 0,
    qty: p.qty, id: p.product_id, qtyLabel: fmtQtyBreakdown(p.qty_breakdown),
    members: p.members || [],
  })), [data]);
  const trendChart = useMemo(() => (data?.mom_trend || []).map(m => ({
    label: m.label.replace(' 20', " '"), invoiced: Number(m.invoiced) || 0, received: Number(m.received) || 0,
  })), [data]);

  const exc = data?.exceptions;

  const onCompanyChange = (v) => { setCompanyId(v); setWarehouseId(''); setCustomer(''); };
  // Company quick-toggle chips (SS Biochem / United Agro) — like Sales Analytics.
  const companyButtons = (() => {
    const bioCo = companyOptions.find((c) => /biochem/i.test(c.label));
    const uaiCo = companyOptions.find((c) => /united\s*agro/i.test(c.label));
    const quick = [...(bioCo ? [bioCo] : []), ...(uaiCo ? [uaiCo] : [])];
    if (!quick.length) return null;
    const shortName = (label) => (/biochem/i.test(label) ? 'SS Biochem' : /united\s*agro/i.test(label) ? 'United Agro' : label);
    return (
      <div className="hidden md:flex items-center gap-1.5 shrink-0">
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
          <button key={pp.v} type="button" onClick={() => { setPeriod(pp.v); setAnchor(pp.v === 'fy' ? fyTokenFor(new Date()) : todayISO()); }}
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
      <CustomSelect value={warehouseId} onChange={e => setWarehouseId(e.target.value)}
        className={`border border-slate-300 rounded-lg px-2 text-sm bg-white min-w-[130px] ${CTRL_H}`}>
        <option value="">All Factories</option>
        {warehouseOptions.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
      </CustomSelect>
      <ProductPicker value={productId}
        onChange={e => setProductId(e.target.value)}
        className={`inline-flex items-center gap-1.5 border border-slate-300 rounded-lg px-2 bg-white text-slate-700 hover:bg-slate-50 text-sm min-w-[130px] max-w-[200px] ${CTRL_H}`} />
      <CustomSelect value={customer} onChange={e => setCustomer(e.target.value)}
        className={`border border-slate-300 rounded-lg px-2 text-sm bg-white min-w-[150px] ${CTRL_H}`}>
        <option value="">All Customers</option>
        {customerOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
      </CustomSelect>
    </div>
  );

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Sales Dashboard"
        subtitle="Top customers & products, month-on-month trend, and exception reports"
        breadcrumbs={[{ label: 'Sales', href: '/sales/orders' }, { label: 'Dashboard' }]}
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
        {/* Filter bar */}
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
            {/* Top customers + Top products */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <SectionCard clip={false} icon={Users} title="Top 10 Customers" subtitle="By invoiced value this period" tone="indigo">
                {/* Phones get a ranked list: full customer names, values
                    inline, and no floating tooltip to cover the rows below. */}
                {isNarrow ? (
                  <RankedBarList
                    items={custChart.map((c) => ({
                      id: c.id, name: c.full, value: c.amount,
                      meta: [c.qtyLabel, c.invoiceCount != null
                        ? `${fmtInt(c.invoiceCount)} invoice${Number(c.invoiceCount) === 1 ? '' : 's'}` : '']
                        .filter(Boolean).join(' · '),
                    }))}
                    color={CUSTOMER_COLOR}
                    formatValue={fmtINRfull}
                    emptyText="No sales in this period."
                  />
                ) : custChart.length === 0
                  ? <p className="px-5 py-10 text-sm text-slate-400 text-center">No sales in this period.</p>
                  : (
                    <div className="p-4">
                      <ResponsiveContainer width="100%" height={Math.max(160, custChart.length * 40)}>
                        <BarChart data={custChart} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                          <CartesianGrid horizontal={false} stroke="#f1f5f9" />
                          <XAxis type="number" tickFormatter={fmtINR} tick={{ fontSize: 10, fill: '#94a3b8' }} />
                          <YAxis type="category" dataKey="name" width={isNarrow ? 116 : 170} tick={<CatTick max={isNarrow ? 16 : 22} />} interval={0} />
                          <Tooltip content={<MoneyTooltip valueKeys={{ amount: 'Invoiced' }} />} cursor={{ fill: '#eef2ff' }}
                            allowEscapeViewBox={{ y: true }} wrapperStyle={{ zIndex: 30 }} />
                          <Bar dataKey="amount" name="Invoiced" fill={CUSTOMER_COLOR} radius={[0, 4, 4, 0]} barSize={16}
                            cursor="pointer" onClick={openCustomerInsight} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
              </SectionCard>

              <SectionCard clip={false} icon={Package} title="Top 10 Products" subtitle="By invoiced value this period" tone="sky">
                {isNarrow ? (
                  <RankedBarList
                    items={prodChart.map((p) => ({
                      id: p.id, name: p.full, value: p.amount, meta: p.qtyLabel,
                    }))}
                    color={PRODUCT_COLOR}
                    formatValue={fmtINRfull}
                    emptyText="No sales in this period."
                  />
                ) : prodChart.length === 0
                  ? <p className="px-5 py-10 text-sm text-slate-400 text-center">No sales in this period.</p>
                  : (
                    <div className="p-4">
                      <ResponsiveContainer width="100%" height={Math.max(160, prodChart.length * 40)}>
                        <BarChart data={prodChart} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                          <CartesianGrid horizontal={false} stroke="#f1f5f9" />
                          <XAxis type="number" tickFormatter={fmtINR} tick={{ fontSize: 10, fill: '#94a3b8' }} />
                          <YAxis type="category" dataKey="name" width={isNarrow ? 116 : 170} tick={<CatTick max={isNarrow ? 16 : 22} />} interval={0} />
                          <Tooltip content={<MoneyTooltip valueKeys={{ amount: 'Value' }} />} cursor={{ fill: '#e0f2fe' }}
                            allowEscapeViewBox={{ y: true }} wrapperStyle={{ zIndex: 30 }} />
                          <Bar dataKey="amount" name="Value" fill={PRODUCT_COLOR} radius={[0, 4, 4, 0]} barSize={16} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
              </SectionCard>
            </div>

            {/* Month-on-month trend */}
            <SectionCard icon={TrendingUp} title="Month-on-Month Trend" subtitle={`${data?.period?.label || 'This financial year'} · invoiced vs received`} tone="emerald">
              <div className="p-4">
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={trendChart} margin={{ top: 8, right: 24, bottom: 4, left: 8 }}>
                    <CartesianGrid stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#475569' }} />
                    <YAxis tickFormatter={fmtINR} tick={{ fontSize: 10, fill: '#94a3b8' }} width={64} />
                    <Tooltip content={<MoneyTooltip valueKeys={{ invoiced: 'Invoiced', received: 'Received' }} />} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="invoiced" name="Invoiced" stroke="#6366f1" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                    <Line type="monotone" dataKey="received" name="Received" stroke="#10b981" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </SectionCard>

            {/* Exception reports */}
            <SectionCard icon={AlertTriangle} title="Exception Reports" subtitle="Items that need attention" tone="rose">
              <div className="p-4 space-y-4">
                <div className="metric-grid">
                  <ExceptionTile icon={CalendarClock} tone="rose" label="Overdue Invoices"
                    value={fmtInt(exc?.overdue?.count)} sub={fmtINRfull(exc?.overdue?.amount)} />
                  <ExceptionTile icon={AlertTriangle} tone="rose" label="Severely Overdue (>90d)"
                    value={fmtInt(exc?.severely_overdue?.count)} sub={fmtINRfull(exc?.severely_overdue?.amount)} />
                  <ExceptionTile icon={RotateCcw} tone="amber" label="Credit Notes / Returns"
                    value={fmtInt(exc?.credit_notes?.count)} sub={fmtINRfull(exc?.credit_notes?.amount)} />
                  <ExceptionTile icon={FileWarning} tone="blue" label="Draft (Unfinalised)"
                    value={fmtInt(exc?.draft_invoices?.count)} sub={fmtINRfull(exc?.draft_invoices?.amount)} />
                </div>

                {/* Longest-overdue invoices (real invoices, opening balances excluded) */}
                {exc?.overdue_rows?.length > 0 && (
                  <div className="rounded-lg border border-slate-200 overflow-hidden">
                    <div className="px-4 py-2 bg-rose-50 border-b border-rose-100 flex items-center gap-2">
                      <AlertTriangle size={14} className="text-rose-600" />
                      <span className="text-xs font-semibold text-rose-800">Longest-overdue invoices</span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs sm:text-[13px]">
                        <thead className="bg-slate-100 text-slate-500 text-[11px] uppercase tracking-wide">
                          <tr>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Invoice</th>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Inv. Date</th>
                            <th className="text-left px-3 py-2 font-semibold">Customer</th>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Company</th>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Due Date</th>
                            <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Days Late</th>
                            <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Balance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {exc.overdue_rows.map((r, i) => (
                            <tr key={i} className="border-t border-slate-100 odd:bg-white even:bg-slate-50/50">
                              <td className="px-3 py-2 font-medium whitespace-nowrap">
                                {r.invoice_id
                                  ? <button type="button" onClick={() => navigate(`/sales/invoices/${r.invoice_id}`)}
                                      className="text-indigo-700 hover:underline font-medium">{r.invoice_no}</button>
                                  : <span className="text-slate-700">{r.invoice_no}</span>}
                              </td>
                              <td className="px-3 py-2 text-slate-500 whitespace-nowrap tabular-nums">{fmtDate(r.invoice_date)}</td>
                              <td className="px-3 py-2 text-slate-700 max-w-[240px] truncate" title={r.customer_name}>{r.customer_name}</td>
                              <td className="px-3 py-2 whitespace-nowrap"><span className="text-[10px] font-semibold text-slate-600 bg-slate-100 border border-slate-200 rounded px-1 py-0.5 whitespace-nowrap">{r.company || '—'}</span></td>
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

                {/* Dormant customers */}
                <div className="rounded-lg border border-slate-200 overflow-hidden">
                  <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 flex items-center gap-2">
                    <UserX size={14} className="text-slate-500" />
                    <span className="text-xs font-semibold text-slate-700">Dormant customers</span>
                    <span className="text-[11px] text-slate-500">— had sales before, none in the last 90 days ({fmtInt(exc?.dormant_customers?.count)})</span>
                  </div>
                  {exc?.dormant_customers?.rows?.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs sm:text-[13px]">
                        <thead className="bg-slate-100 text-slate-500 text-[11px] uppercase tracking-wide">
                          <tr>
                            <th className="text-left px-3 py-2 font-semibold">Customer</th>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Company</th>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Last Invoice</th>
                            <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Total Invoices</th>
                          </tr>
                        </thead>
                        <tbody>
                          {exc.dormant_customers.rows.map((r, i) => (
                            <tr key={i} className="border-t border-slate-100 odd:bg-white even:bg-slate-50/50">
                              <td className="px-3 py-2 text-slate-700 max-w-[280px] truncate" title={r.customer_name}>{r.customer_name}</td>
                              <td className="px-3 py-2 whitespace-nowrap"><span className="text-[10px] font-semibold text-slate-600 bg-slate-100 border border-slate-200 rounded px-1 py-0.5 whitespace-nowrap">{r.company || '—'}</span></td>
                              <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{fmtDate(r.last_invoice)}</td>
                              <td className="px-3 py-2 text-right text-slate-600 tabular-nums">{fmtInt(r.invoice_count)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="px-4 py-4 sm:py-5 text-sm text-slate-400 text-center">No dormant customers — everyone with past sales has invoiced recently.</p>
                  )}
                </div>
              </div>
            </SectionCard>

            {/* Quick link to the detailed analytics page */}
            <button type="button" onClick={() => navigate('/sales/dashboard')}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-700">
              Open Sales Analytics (drill-down) <ChevronRight size={15} />
            </button>
          </>
        )}
      </div>
    </MainLayout>
  );
}
