import { createPortal } from 'react-dom';
import CustomDatePicker from "@/components/ui/CustomDatePicker";
import CustomSelect from "@/components/ui/CustomSelect";
import ProductPicker from "@/components/common/ProductPicker";
// Shared control height. This page still carries its own local PeriodNavigator
// (see below), so importing just the token keeps its controls on the same
// baseline as the shared one until the two are merged.
import { CTRL_H, CTRL_EXPORT, CTRL_ICON } from "@/components/common/controls";
/**
 * Sales Module — Work Tracking Dashboard
 *
 * Single-page rollup of activity across the sales module. The frontend
 * fires ONE GET request — `/api/sales/dashboard/?period=...` — and the
 * backend returns every metric used on this page. No per-card requests.
 *
 * Layout:
 *   - Period selector (Today / This Week / This Month / Custom range)
 *   - Optional Company filter
 *   - Stat cards (count + delta vs equal-length previous window), incl.
 *     Debit Notes & Credit Notes raised in the period (from Tally vouchers)
 *   - Trend chart (svg bars, one bar per day)
 *   - Top 10 customers by SO amount this period
 *   - Per-company rollup (only when company filter is "All")
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  TrendingUp, TrendingDown, Minus, Calendar,
  FileText, Truck, Wallet, AlertCircle, LayoutDashboard,
  ShoppingCart, Package, X, Loader2, ExternalLink, Download,
  ChevronRight, ChevronLeft, ChevronDown, SlidersHorizontal, Search, Users,
  FileMinus, FilePlus, ArrowUp, ArrowDown, ArrowUpDown, Info, Percent,
} from 'lucide-react';
import toast from 'react-hot-toast';
import MainLayout from '../../../components/layout/MainLayout';
import MobileBottomSheet from '../../../components/mobile/MobileBottomSheet.jsx';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import usePagerKeys from '../../../hooks/usePagerKeys.js';
import exportToExcel from '../../../utils/exportExcel.js';
import { formatDate } from '@/utils/formatters';
import { FilterMultiSelect } from '@/components/common/FilterPanel';
import SalesTds from '../tds/index.jsx';

// ── Formatters ───────────────────────────────────────────────────────

const fmtINR = (v) => {
  const n = Number(v) || 0;
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};
const fmtINRfull = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Amount spelled in words beneath the figure (item 1 of the summary redesign).
// Indian magnitude words (Crore / Lakh / Thousand) rather than a full
// "Rupees …Only" sentence: under a big headline number, in a small font, the
// scale word is what a reader actually wants — "8.66 Crore" at a glance, not a
// line of prose. A trailing ".00" is dropped so round figures read "45 Crore".
const _trimDot = (s) => s.replace(/\.00$/, '');
const fmtWords = (v) => {
  const n = Math.abs(Number(v) || 0);
  const neg = (Number(v) || 0) < 0 ? '(-) ' : '';
  if (n >= 1e7) return `${neg}${_trimDot((n / 1e7).toFixed(2))} Crore`;
  if (n >= 1e5) return `${neg}${_trimDot((n / 1e5).toFixed(2))} Lakh`;
  if (n >= 1e3) return `${neg}${_trimDot((n / 1e3).toFixed(2))} Thousand`;
  return `${neg}${Math.round(n).toLocaleString('en-IN')}`;
};
// A balance below zero is money the customer paid us beyond its bills. Tally
// writes it as "Cr"; a bare minus read as an error (Bliss Corp, -25,00,000).
const fmtBal = (v) => {
  const n = Number(v) || 0;
  return n < 0 ? `${fmtINRfull(-n)} Cr (On Account)` : fmtINRfull(n);
};
// Drop trailing-zero decimals so quantities stay compact ("5,47,310" not
// "5,47,310.000") and fit the two-column card without overlapping, while real
// fractional quantities ("8,288.528") keep their precision.
const fmtQty = (v) => (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
const fmtInt = (v) => (Number(v) || 0).toLocaleString('en-IN');
// 2-digit year ('08-Apr-26') — the century is never in doubt on this dashboard,
// and the saved width keeps ledger/table date columns from clipping.
const fmtDate = (iso) => (iso ? formatDate(iso, 'dd-MMM-yy') : '—');
// Days an invoice is past its due date (0 if undated or not yet due).
const overdueDaysOf = (due) => {
  if (!due) return 0;
  const d = Math.floor((Date.now() - new Date(`${due}T00:00:00`).getTime()) / 86400000);
  return d > 0 ? d : 0;
};
// Where a due date came from, shown as a small pill beside it so the ageing can
// be trusted: 'invoice' (the invoice's own stated terms), 'credit_term' (the
// customer master credit term we derived), 'tally' (Tally's bill allocation),
// 'default' (the ERP blanket 45-day fallback — a guess).
const DUE_SRC = {
  invoice:     { label: 'invoice', title: "Due date from the invoice's own stated terms", cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  credit_term: { label: 'term',    title: "Due date derived from the customer's credit term", cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  tally:       { label: 'tally',   title: 'Due date taken from Tally', cls: 'bg-violet-50 text-violet-700 border-violet-200' },
  default:     { label: 'est.',    title: 'No real due date — ERP blanket 45-day default', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
};
const DueSourceBadge = ({ src }) => {
  const m = DUE_SRC[src];
  if (!m) return null;
  return <span title={m.title} className={`ml-1.5 text-[9px] font-medium px-1 py-0.5 rounded border align-middle whitespace-nowrap ${m.cls}`}>{m.label}</span>;
};
// Pivot bucket for Delivery Challans with no linked sales invoice: they have no
// real dispatch date (their own date is the import timestamp), so instead of
// dumping them into the import month they get their own "Un-invoiced" column.
const UNINVOICED_KEY = '__uninvoiced__';
const UNINVOICED_LABEL = 'Un-invoiced';
// 'YYYY-MM' → 'Mon YY' (e.g. '2026-08' → 'Aug 26') for pivot column headers.
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtMonth = (ym) => {
  if (ym === UNINVOICED_KEY) return UNINVOICED_LABEL;
  const [y, m] = String(ym || '').split('-');
  const mi = parseInt(m, 10) - 1;
  return (mi >= 0 && mi < 12) ? `${MONTH_ABBR[mi]} ${String(y).slice(2)}` : (ym || '—');
};
// Dispatch lines with no UOM are lump-sum, free-text billing lines (scrap /
// equipment / rate-diff / generic "Sales") typed on Tally invoices — not real
// products. In the pivots they all collapse into this single bucket.
const OTHER_LABEL = 'Other / Non-product';
const OTHER_KEY = '__other__';
const isProductLine = (l) => !!(l.uom && String(l.uom).trim());
// Tally stock-group codes (Product.goods_sub_type) → friendly labels for the
// grouped By-Item view.
const STOCK_GROUP_LABELS = {
  FINISHED_GOOD: 'Finished Goods', RAW_MATERIAL: 'Raw Materials',
  PACKING_MATERIAL: 'Packing Materials', SEMI_FINISHED: 'Semi Finished',
  TRADED_PRODUCTS: 'Traded Products', CONSUMABLES: 'Consumables',
};

// ── By-Item family taxonomy (Swetha, 2026-09-10) ─────────────────────
// Clean a Tally family label: drop the "- TVP"/"- TR" suffixes and rewrite
// "Azadirachtin 300 PPM" → "Aza 300 ppm" (and "Azadirachtin Technical" →
// "Aza Technical", etc.) so the whole view reads in the short house style.
function cleanFam(fam) {
  let f = String(fam || '').replace(/\s*-\s*(TVP|TR)\b/gi, '').replace(/\s+/g, ' ').trim();
  const m = f.match(/^azadirachtin\s+([\d,]+)\s*ppm/i);
  if (m) return `Azadirachtin ${m[1].replace(/,/g, '')} PPM`;
  return f;
}
// The canonical family a product belongs to in the By-Item view. Items already
// classified by Tally keep that family (just cleaned); the ones Tally left
// unclassified are folded in from their NAME, and stock-return / KGS-oil lines
// are split off into "Returns" (returned goods, not sales).
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

// Build the two-line filter banner printed at the top of every Excel export so
// a downloaded sheet says exactly which company / product / customer / period /
// factory produced it. `opts`/`id` pairs resolve to the selected label, else
// the "All …" fallback.
function buildFilterMeta({ companyId, companyOptions, productId, productOptions,
                          customerId, customerOptions, warehouseId, warehouseOptions,
                          periodLabel, from, to } = {}) {
  const nameOf = (opts, id, all) => {
    if (!id) return all;
    const o = (opts || []).find(x => String(x.value ?? x.id) === String(id));
    return o ? (o.label ?? o.name ?? String(id)) : all;
  };
  const filters = [
    `Company: ${nameOf(companyOptions, companyId, 'All Companies')}`,
    `Product: ${nameOf(productOptions, productId, 'All Products')}`,
    `Customer: ${nameOf(customerOptions, customerId, 'All Customers')}`,
    `Factory: ${nameOf(warehouseOptions, warehouseId, 'All Factories')}`,
  ].join('   ·   ');
  const range = (from && to) ? `${from} → ${to}` : '';
  const period = ['Period: ' + (periodLabel || ''), range].filter(s => s && s !== 'Period: ').join('   ·   ');
  return [`Filters —  ${filters}`, period].filter(l => l && l.trim());
}

const todayISO = () => new Date().toISOString().slice(0, 10);

// ── Period navigator helpers ─────────────────────────────────────────
// Local-date ISO (avoids the UTC shift toISOString() would cause).
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
// Indian financial year: 1 Apr → 31 Mar. Jan–Mar belong to the FY that
// STARTED the previous calendar year, so Feb 2027 is still FY 2026-27.
const fyStartYearOf = (d) => (d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1);
// The FY navigator can't be driven by a single anchor date the way week /
// month are — "Apr 2026" alone can't say whether the user picked the whole
// FY or just its first half. So the FY anchor carries the explicit window as
// "FROM..TO"; rangeFor still caps `to` at today, which is what makes the
// current FY read as "1 Apr → today".
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
  // Drop windows that haven't started yet (H2 of the current FY when we're
  // still in, say, August) — they'd only ever return an empty dashboard.
  return out.filter((o) => fyRangeOf(o.value).from <= today);
};
// Resolve {from,to} for a granularity + anchor date, capped at today so we
// never query future dates. Custom is resolved by the caller.
const rangeFor = (period, anchorRaw) => {
  const today = todayISO();
  const cap = (t) => (t > today ? today : t);
  // period and anchor can arrive mismatched (a drill-down seeded from a URL,
  // or state restored out of order). Never hand an FY token to the day /
  // week / month parsers (they'd build an Invalid Date), and never hand a
  // bare date to the FY reader (it has no end half).
  const mismatched = String(anchorRaw).includes(FY_SEP) !== (period === 'fy');
  const anchorISO = mismatched ? (period === 'fy' ? fyTokenFor(new Date()) : today) : anchorRaw;
  if (period === 'today') return { from: anchorISO, to: anchorISO };
  if (period === 'week') { const r = weekRangeOf(anchorISO); return { from: r.from, to: cap(r.to) }; }
  if (period === 'month') { const r = monthRangeOf(anchorISO); return { from: r.from, to: cap(r.to) }; }
  if (period === 'fy') {
    // Cap at today ONLY once the window has started, so the current FY reads
    // "1 Apr → today". Capping unconditionally would invert a not-yet-started
    // window (H2 picked in August → 1 Oct .. 22 Aug) into a backwards range.
    const r = fyRangeOf(anchorISO);
    return { from: r.from, to: (r.from <= today && r.to > today) ? today : r.to };
  }
  return null;  // custom handled separately
};
// Dropdown options: recent months / weeks (value = anchor ISO within them).
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

// Effective {from,to} for a period + navigator anchor (custom uses its pickers).
const effWindow = (period, anchor, customFrom, customTo) =>
  period === 'custom'
    ? { from: customFrom, to: customTo }
    : (rangeFor(period, anchor) || { from: customFrom, to: customTo });

// ── Period navigator ─────────────────────────────────────────────────
// The full period widget used on the analytics top bar AND inside every tile
// drill-down: Today/Week/Month/FY/Custom pills + a specific day / week /
// month / financial-year selector (or a date range for Custom). Keeps them
// consistent everywhere.
function PeriodNavigator({ period, setPeriod, anchor, setAnchor, customFrom, customTo, setCustomFrom, setCustomTo }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className={`flex rounded-lg border border-slate-300 overflow-hidden ${CTRL_H}`}>
        {[{ v: 'today', l: 'Today' }, { v: 'week', l: 'Week' }, { v: 'month', l: 'Month' }, { v: 'fy', l: 'FY' }, { v: 'custom', l: 'Custom' }].map((p, i) => (
          // Re-seed the anchor on switch: FY stores a "FROM..TO" token while
          // the others store a plain date, so carrying one shape into the
          // other period would break rangeFor().
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

// ── Delta chip ───────────────────────────────────────────────────────
// Used on every stat card. Pure pct delta vs previous period; renders
// as a coloured pill with an arrow. Zero / NaN / division-by-zero
// collapses to an em-dash so we don't show "+Infinity%" when a metric
// is new this period.

function DeltaChip({ current, previous, format = 'int' }) {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev === 0 && cur === 0) {
    return <span className="text-xs text-slate-400">no change</span>;
  }
  if (prev === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
        <TrendingUp size={12} /> new
      </span>
    );
  }
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const up = pct > 0.5;
  const down = pct < -0.5;
  const Icon = up ? TrendingUp : down ? TrendingDown : Minus;
  const cls = up ? 'text-emerald-700' : down ? 'text-red-700' : 'text-slate-500';
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${cls}`}>
      <Icon size={12} />
      {pct > 0 ? '+' : ''}{pct.toFixed(1)}%
      <span className="text-slate-400 font-normal hidden sm:inline">vs prev</span>
    </span>
  );
}

// ── Stat card ────────────────────────────────────────────────────────

// ── Note kinds ───────────────────────────────────────────────────────
// Mirrors backend/apps/sales/note_kinds.py. The backend does the classifying
// and sends `kind` on every row and `kinds` on every rollup; this is only the
// display vocabulary, kept in one place so the tiles, the drill-down popup and
// the notes list page all say the same words.
const NOTE_KIND_META = {
  trade: {
    l: 'Trade',
    hint: 'Real trading documents — sales adjustments, freight billed on, returns, discounts. This is what Tally\'s Debit/Credit Note register actually holds.',
  },
  adjustment: {
    l: 'Journal / TDS',
    hint: 'Ledger movements that arrived as notes — journals, TDS/TCS, bank charges, contras, round-offs. Not trading documents: they never reach Total Sales but do inflate Outstanding Receivables.',
  },
  other: {
    l: 'Unclassified',
    hint: 'Reason is blank or matches no known pattern — worth a look.',
  },
};
const NOTE_KIND_ORDER = ['trade', 'adjustment', 'other'];

// Build the pill row for a note tile from its `kinds` rollup. Returns null
// when the split would tell you nothing — either there are no notes, or every
// one of them is already trade. A pill row you can't learn anything from is
// worse than no pill row, and the healthy state for this data is "all trade".
function noteKindTabs(node, suffix = '') {
  const kinds = node?.kinds || {};
  const present = NOTE_KIND_ORDER
    .filter(k => Number(kinds[k]?.count || 0) > 0)
    .map(k => ({
      k,
      l: NOTE_KIND_META[k].l,
      hint: NOTE_KIND_META[k].hint,
      value: fmtInt(kinds[k].count),
      sub: `${fmtINRfull(kinds[k].amount)}${suffix}`,
    }));
  const worthShowing = present.length > 1
    || (present.length === 1 && present[0].k !== 'trade');
  if (!worthShowing) return undefined;
  return [{
    k: 'all',
    l: 'All',
    hint: 'Every customer-side note raised in the period, whatever it is',
    value: fmtInt(node?.count || 0),
    sub: `${fmtINRfull(node?.amount || 0)}${suffix}`,
  }, ...present];
}

// `tabs` (optional) turns the headline into a switchable measure, the way
// TotalSalesCard already works: [{ k, l, value, sub, hint }]. The first tab is
// the default, so passing tabs never changes what the card shows on load — it
// only adds a way to slice it. The label grows a "/ <tab>" suffix so a sliced
// number can't be misread as the whole.
// Ageing bands. Colour runs green to red as the money gets older -- semantic,
// and deliberately not the indigo this page uses for controls, so "old money"
// never reads as "a button". `other` is slate: it is not a stage of ageing at
// all, so it must not look like the end of the ramp.
// Bluish-violet (indigo → violet) age gradient: light for recent, deep for the
// oldest. Keeps the age progression via shade while staying on the app theme.
const AGE_TONE = {
  d1_30:    { dot: 'bg-indigo-300',  text: 'text-indigo-700',  bg: 'bg-indigo-50',   ring: 'border-indigo-200' },
  d31_60:   { dot: 'bg-indigo-400',  text: 'text-indigo-700',  bg: 'bg-indigo-50',   ring: 'border-indigo-200' },
  d61_90:   { dot: 'bg-indigo-500',  text: 'text-indigo-700',  bg: 'bg-indigo-100',  ring: 'border-indigo-300' },
  d91_180:  { dot: 'bg-violet-600',  text: 'text-violet-700',  bg: 'bg-violet-50',   ring: 'border-violet-200' },
  d180_plus:{ dot: 'bg-violet-800',  text: 'text-violet-800',  bg: 'bg-violet-100',  ring: 'border-violet-300' },
  other:    { dot: 'bg-slate-400',   text: 'text-slate-600',   bg: 'bg-slate-50',    ring: 'border-slate-200' },
};
// The bands this card DISPLAYS, in order -- AGE_BANDS in dashboard_views.py.
// Bills not yet due are inside the first band, the way Tally's "< 30 days"
// column holds them, so the bands plus Notes & adj add to the tile's headline.
const AGED_KEYS = ['d1_30', 'd31_60', 'd61_90', 'd91_180', 'd180_plus'];
// Age bands are shown in full rupees and paise, never shortened to L/Cr, so they
// can be ticked off against Tally's ageing report line by line. A band below
// zero (credit notes, advances) is written "Cr", the way Tally writes it.
const fmtAge = (v) => {
  const n = Number(v) || 0;
  return n < 0 ? `${fmtINRfull(-n)} Cr` : fmtINRfull(n);
};
// The remainder band holds money on no bill -- Tally's "On Account" line.
const ageLabel = (b) => (b?.key === 'other' ? 'On Account' : b?.label);

// Compact age split for the Outstanding tile (option A).
//
// These bands are the PAST-DUE part of the tile's headline, cut up. "Not due"
// is computed but not drawn (see AGED_KEYS), so the strip deliberately does not
// add to the number above it -- there is no total here because a partial one
// would invite exactly that misreading.
//
// The bar draws the age bands only. "Notes & adjustments" has no age, and
// can be negative (credit notes, overpayments), which a stacked bar cannot show
// honestly -- so it is stated as a chip underneath instead of being drawn.
function AgeingStrip({ ageing }) {
  if (!ageing || !ageing.length) return null;
  const aged = ageing.filter(b => AGED_KEYS.includes(b.key)
    && (Number(b.amount) !== 0 || b.count > 0));
  const other = ageing.find(b => b.key === 'other' && Number(b.amount) !== 0);
  if (!aged.length) return null;
  const span = aged.reduce((a, b) => a + Math.abs(Number(b.amount) || 0), 0) || 1;

  return (
    <div className="mt-2.5 pt-2.5 border-t border-slate-100">
      <p className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold mb-1.5">
        By age
      </p>
      <div className="flex h-1.5 rounded-full overflow-hidden bg-slate-100">
        {aged.map(b => (
          <span key={b.key} className={AGE_TONE[b.key]?.dot || 'bg-slate-400'}
            title={`${b.label}: ${fmtAge(b.amount)}`}
            style={{ width: `${(Math.abs(Number(b.amount) || 0) / span) * 100}%` }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5">
        {aged.map(b => (
          <span key={b.key} className="inline-flex items-center gap-1 text-[11px]">
            <span className={`w-1.5 h-1.5 rounded-full ${AGE_TONE[b.key]?.dot}`} />
            <span className="text-slate-500">{b.label}</span>
            <span className="font-semibold text-slate-700 tabular-nums">{fmtAge(b.amount)}</span>
          </span>
        ))}
        {other && (
          <span className="inline-flex items-center gap-1 text-[11px]"
            title="Money on no bill (Tally's On Account): advances, and notes or journals Tally keeps on account. With no due date it cannot be given an age.">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
            <span className="text-slate-500">On Account</span>
            <span className="font-semibold text-slate-700 tabular-nums">{fmtAge(other.amount)}</span>
          </span>
        )}
      </div>
    </div>
  );
}

// Inline preview of ONE age band's invoices, lazily fetched when the band row
// is expanded. Mirrors the Purchase Analytics bucket expansion: a few rows in
// place (no popup), with a "View all" that opens the full grouped list.
function BandInlinePreview({ bandKey, tone, companyId, warehouseId, customerId,
                             productId, period, from, to, onViewAll }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(true);
  const PREVIEW = 5;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const qp = new URLSearchParams({ type: 'receivables_ageing', band: bandKey });
    if (period && period !== 'all') { qp.set('period', 'custom'); qp.set('from', from); qp.set('to', to); }
    if (companyId) qp.set('company', companyId);
    if (warehouseId) qp.set('warehouse', warehouseId);
    if (customerId) qp.set('customer', customerId);
    if (productId) qp.set('product', productId);
    apiClient.get(`/api/sales/dashboard/records/?${qp.toString()}`)
      .then(r => { if (!cancelled) setRows(r.data?.rows || []); })
      .catch(() => { if (!cancelled) setRows([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [bandKey, companyId, warehouseId, customerId, productId, period, from, to]);

  const here = `${window.location.pathname}${window.location.search}`;

  if (loading) return (
    <div className={`${tone?.bg || 'bg-slate-50'} px-4 py-3 flex items-center gap-2 text-[11px] text-slate-400`}>
      <Loader2 size={13} className="animate-spin" /> Loading bills…
    </div>
  );
  if (!rows || !rows.length) return (
    <div className={`${tone?.bg || 'bg-slate-50'} px-4 py-3 text-[11px] text-slate-400`}>No bills in this band.</div>
  );

  const count = rows.length;
  const preview = rows.slice(0, PREVIEW);
  return (
    <div className={`${tone?.bg || 'bg-slate-50'} px-4 py-2`}>
      <div className="rounded-lg bg-white/70 border border-white overflow-hidden divide-y divide-slate-100/80">
        {preview.map((r, i) => (
          <div key={`${r.invoice_id || r.invoice_no}-${i}`} className="flex items-center gap-3 px-3 py-1.5 text-[11px]">
            <span className="text-slate-400 tabular-nums w-[66px] shrink-0">{r.invoice_date ? fmtDate(r.invoice_date) : '—'}</span>
            {(r.is_opening || !r.invoice_id)
              ? <span className="text-slate-500 italic w-24 shrink-0 truncate">{r.invoice_no || '—'}</span>
              : <button type="button" onClick={(e) => { e.stopPropagation(); navigate(`/sales/invoices/${r.invoice_id}`, { state: { backTo: here } }); }}
                  className="text-indigo-600 hover:underline font-medium w-24 shrink-0 truncate text-left">{r.invoice_no || '—'}</button>}
            <span className="text-slate-600 flex-1 min-w-0 truncate">{r.customer_name || '—'}</span>
            <span className={`font-semibold ${tone?.text || 'text-slate-600'} w-14 text-right shrink-0`}>{r.days_label || '—'}</span>
            <span className="tabular-nums font-semibold text-slate-800 w-24 text-right shrink-0">{fmtAge(r.amount)}</span>
          </div>
        ))}
      </div>
      {count > PREVIEW && onViewAll && (
        <div className="flex justify-end pt-1.5">
          <button type="button" className="text-[11px] text-indigo-600 hover:underline font-medium"
            onClick={(e) => { e.stopPropagation(); onViewAll(bandKey); }}>
            View all {count.toLocaleString('en-IN')} invoices →
          </button>
        </div>
      )}
    </div>
  );
}

// The same split at full size (option C): a card per band, then the age profile
// as one bar.
//
// `total` is the tile's headline and the bands add to it exactly -- the panel
// prints that sum rather than asking anyone to take it on trust.
// `variant`: 'card' stands alone on the dashboard; 'section' sits inside the
// drill-down, where it is one band in a stack of strips and so drops the card
// border and matches the reconciliation strip above it. Same content either way.
// `expandCtx` (+ onViewAll): when given, band rows expand INLINE to preview
// their bills (the drawer use), instead of calling onBand to open a popup.
function AgeingPanel({ ageing, total, asAt, basis, variant = 'card', onBand, activeBand = '',
                       expandCtx = null, onViewAll }) {
  const [expandedKey, setExpandedKey] = useState(null);
  if (!ageing || !ageing.length) return null;
  const aged = ageing.filter(b => AGED_KEYS.includes(b.key)
    && (Number(b.amount) !== 0 || b.count > 0));
  const other = ageing.find(b => b.key === 'other' && Number(b.amount) !== 0);
  if (!aged.length) return null;
  const grand = Number(total) || 0;
  const span = aged.reduce((a, b) => a + Math.abs(Number(b.amount) || 0), 0) || 1;
  const cards = other ? [...aged, other] : aged;
  // What the cards below add to. Bills not yet due are inside the first card,
  // so this equals `total`, the tile's full Outstanding.
  const shown = cards.reduce((a, b) => a + (Number(b.amount) || 0), 0);
  // Share that's 91+ days old — the headline risk, shown as a chip like Purchase.
  const urgentAmt = aged.filter(b => b.key === 'd91_180' || b.key === 'd180_plus')
    .reduce((a, b) => a + Math.abs(Number(b.amount) || 0), 0);
  const urgentPct = span ? Math.round((urgentAmt / span) * 100) : 0;
  const billCount = cards.reduce((a, b) => a + (Number(b.count) || 0), 0);

  const section = variant === 'section';
  // Inline mode: band rows expand in place to preview their bills (the drawer).
  const inline = !!expandCtx;

  return (
    <div className={section
      ? 'px-5 py-3 border-b border-slate-100'
      : 'bg-white rounded-xl border border-slate-200 p-3 sm:p-4'}>
      {/* Header — icon chip + title + the one-line total and 91+-day risk chip,
          matching the Purchase Analytics Outstanding-by-Age panel. */}
      {section ? (
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 min-w-0">
            Outstanding by age · {basis || 'days past due date'}{asAt ? ` · as at ${fmtDate(asAt)}` : ''}
          </p>
          {urgentPct > 0 && (
            <span className="text-[10px] font-semibold text-violet-700 bg-violet-50 border border-violet-200 rounded-full px-1.5 py-0.5 shrink-0">{urgentPct}% is 91+ days</span>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 mb-3 min-w-0">
          <span className="p-1.5 rounded-lg bg-indigo-50 text-indigo-600 shrink-0"><AlertCircle size={15} /></span>
          <div className="flex items-baseline gap-x-2 gap-y-0.5 flex-wrap min-w-0">
            <h3 className="text-sm font-semibold text-slate-800">Outstanding by age</h3>
            <span className="text-[11px] text-slate-400 tabular-nums">{billCount.toLocaleString('en-IN')} bills · {fmtAge(shown)}</span>
            {urgentPct > 0 && (
              <span className="text-[10px] font-semibold text-violet-700 bg-violet-50 border border-violet-200 rounded-full px-1.5 py-0.5">{urgentPct}% is 91+ days</span>
            )}
          </div>
        </div>
      )}

      {/* Hero segmented bar — the age profile (bands only; On Account has no age).
          In inline mode, clicking a segment expands that band below. */}
      <div className="flex h-6 overflow-hidden rounded-lg gap-px bg-slate-100 mb-3">
        {aged.map(b => {
          const pct = (Math.abs(Number(b.amount) || 0) / span) * 100;
          if (pct <= 0) return null;
          const seg = (
            <span className={`${AGE_TONE[b.key]?.dot || 'bg-slate-400'} w-full h-full flex items-center justify-center text-[10px] font-bold text-white`}>
              {pct >= 8 ? `${Math.round(pct)}%` : ''}
            </span>
          );
          return inline ? (
            <button key={b.key} type="button" style={{ width: `${pct}%` }}
              onClick={() => setExpandedKey(k => k === b.key ? null : b.key)}
              className="flex min-w-0 hover:opacity-85 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white transition"
              title={`${b.label}: ${fmtAge(b.amount)} — click to expand`}>{seg}</button>
          ) : (
            <span key={b.key} className={`${AGE_TONE[b.key]?.dot || 'bg-slate-400'} flex items-center justify-center text-[10px] font-bold text-white`}
              style={{ width: `${pct}%` }} title={`${b.label}: ${fmtAge(b.amount)}`}>
              {pct >= 8 ? `${Math.round(pct)}%` : ''}
            </span>
          );
        })}
      </div>

      {/* Dense band list — a row per band with a severity rail + a Total row,
          matching the Purchase Analytics Outstanding-by-Age panel. */}
      <div className="overflow-x-auto">
        <div className="min-w-[26rem]">
          <div className="hidden sm:grid grid-cols-[1.5fr_repeat(4,1fr)] gap-2 px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            <span>Bucket</span><span className="text-right">Bills</span><span className="text-right">Outstanding</span><span className="text-right">Share</span><span className="text-right">Oldest</span>
          </div>
          <div className="rounded-lg border border-slate-100 divide-y divide-slate-100 overflow-hidden">
            {aged.map(b => {
              const t = AGE_TONE[b.key] || AGE_TONE.other;
              // Share is of the AGED total (span) — the same denominator the hero
              // bar uses — so the bar segment and this % always read the same. The
              // net total dilutes by the On-Account credit, which has no age and is
              // reconciled on its own line below, not given a slice of the profile.
              const share = span ? (Math.abs(Number(b.amount) || 0) / span) * 100 : 0;
              const isOther = false;
              const isUrgent = b.key === 'd180_plus';
              const canExpand = inline && b.count > 0;
              const isExpanded = inline && expandedKey === b.key;
              const clickable = canExpand || (!inline && onBand);
              const Tag = clickable ? 'button' : 'div';
              const isActive = !inline && onBand && activeBand === b.key;
              const handleClick = canExpand
                ? () => setExpandedKey(k => k === b.key ? null : b.key)
                : (!inline && onBand ? () => onBand(isActive ? null : b.key) : undefined);
              return (
                <Fragment key={b.key}>
                <Tag
                  type={clickable ? 'button' : undefined}
                  onClick={handleClick}
                  aria-pressed={!inline && onBand ? !!isActive : undefined}
                  aria-expanded={canExpand ? isExpanded : undefined}
                  className={`relative grid grid-cols-[1.5fr_repeat(4,1fr)] items-center gap-2 w-full text-left pl-4 pr-2.5 py-1.5 text-xs transition ${
                    (isActive || isExpanded) ? t.bg : (clickable ? 'hover:bg-slate-50 cursor-pointer focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-400' : '')}`}
                  title={isOther
                    ? "Money on no bill (Tally's On Account): advances, and notes or journals Tally keeps on account. With no due date it cannot be given an age."
                    : (clickable ? 'Click to see the bills in this band' : undefined)}>
                  <span className={`absolute left-0 top-0 bottom-0 w-1 ${t.dot}`} aria-hidden="true" />
                  <span className="flex items-center gap-1.5 min-w-0">
                    {inline && (
                      <ChevronDown size={12} className={`shrink-0 transition-transform ${canExpand ? 'text-slate-300' : 'text-transparent'} ${isExpanded ? 'rotate-180' : ''}`} />
                    )}
                    <span className={`w-2 h-2 rounded-full shrink-0 ${t.dot}`} />
                    <span className="font-semibold text-slate-700 truncate">{ageLabel(b)}</span>
                    {isUrgent && (Number(b.amount) !== 0 || b.count > 0) && (
                      <span className="text-[9px] font-bold uppercase tracking-wide text-violet-700 bg-violet-50 border border-violet-200 rounded px-1 py-px shrink-0">Urgent</span>
                    )}
                  </span>
                  <span className="text-right tabular-nums text-slate-500 whitespace-nowrap">{isOther ? '—' : b.count.toLocaleString('en-IN')}</span>
                  <span className={`text-right tabular-nums font-bold whitespace-nowrap ${t.text}`}>{fmtAge(b.amount)}</span>
                  <span className="text-right tabular-nums text-slate-500">{share.toFixed(1)}%</span>
                  <span className="text-right tabular-nums text-slate-400 whitespace-nowrap">{b.oldest ? fmtDate(b.oldest) : '—'}</span>
                </Tag>
                {isExpanded && (
                  <BandInlinePreview bandKey={b.key} tone={t} onViewAll={onViewAll}
                    companyId={expandCtx.companyId} warehouseId={expandCtx.warehouseId}
                    customerId={expandCtx.customerId} productId={expandCtx.productId}
                    period={expandCtx.period} from={expandCtx.from} to={expandCtx.to} />
                )}
                </Fragment>
              );
            })}
            {/* Aged subtotal — the 100% the Share column and the hero bar are of. */}
            <div className="grid grid-cols-[1.5fr_repeat(4,1fr)] items-center gap-2 pl-4 pr-2.5 py-2 bg-slate-50 text-xs font-bold text-slate-800">
              <span>{other ? 'Aged total' : 'Total'}</span>
              <span className="text-right tabular-nums text-slate-600 whitespace-nowrap">{billCount.toLocaleString('en-IN')}</span>
              <span className="text-right tabular-nums text-slate-900 whitespace-nowrap">{fmtAge(span)}</span>
              <span className="text-right">100%</span>
              <span />
            </div>
            {other && (
              <>
                {/* On Account — a credit with no due date, so no age and no share.
                    Shown here only to reconcile the aged total to net outstanding. */}
                <div className="relative grid grid-cols-[1.5fr_repeat(4,1fr)] items-center gap-2 pl-4 pr-2.5 py-1.5 text-xs"
                  title="Money on no bill (Tally's On Account): advances, and notes or journals Tally keeps on account. With no due date it cannot be given an age.">
                  <span className="absolute left-0 top-0 bottom-0 w-1 bg-slate-300" aria-hidden="true" />
                  <span className="flex items-center gap-1.5 min-w-0">
                    {inline && <span className="w-3 shrink-0" aria-hidden="true" />}
                    <span className="w-2 h-2 rounded-full shrink-0 bg-slate-400" />
                    <span className="font-semibold text-slate-600 truncate">On Account</span>
                  </span>
                  <span className="text-right tabular-nums text-slate-400 whitespace-nowrap">—</span>
                  <span className="text-right tabular-nums font-bold text-slate-600 whitespace-nowrap">{fmtAge(other.amount)}</span>
                  <span className="text-right tabular-nums text-slate-400">—</span>
                  <span className="text-right tabular-nums text-slate-400 whitespace-nowrap">—</span>
                </div>
                {/* Net outstanding — aged total net of On Account; ties the tile. */}
                <div className="grid grid-cols-[1.5fr_repeat(4,1fr)] items-center gap-2 pl-4 pr-2.5 py-2 bg-slate-100 text-xs font-bold text-slate-900">
                  <span>Net outstanding</span>
                  <span />
                  <span className="text-right tabular-nums whitespace-nowrap">{fmtAge(shown)}</span>
                  <span className="text-right tabular-nums text-slate-400">—</span>
                  <span />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <p className="text-[10px] text-slate-400 mt-2">
        Unpaid bills by age
        {other && ' · On Account has no due date — counted in the total, not aged'}
      </p>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub, delta, deltaPrev, tone = 'slate', breakdown, tabs, onClick, emptyHint, footer }) {
  const [tab, setTab] = useState(tabs?.[0]?.k);
  const activeTab = tabs?.length ? (tabs.find(t => t.k === tab) || tabs[0]) : null;
  const shownValue = activeTab ? activeTab.value : value;
  const shownSub = activeTab ? activeTab.sub : sub;
  const toneCls = {
    slate:   'bg-slate-50 text-slate-700',
    indigo:  'bg-indigo-50 text-indigo-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    amber:   'bg-amber-50 text-amber-700',
    rose:    'bg-rose-50 text-rose-700',
    sky:     'bg-sky-50 text-sky-700',
    violet:  'bg-violet-50 text-violet-700',
  }[tone];
  const clickable = typeof onClick === 'function';
  // Use a div + role="button" instead of a real <button> so the
  // breakdown chips can themselves be real <button>s when they need
  // their own click handler (drill-down chips). Nesting buttons is
  // invalid HTML; the role-based pattern keeps a11y intact (keyboard
  // activation via Enter/Space).
  const handleKeyDown = (e) => {
    if (!clickable) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onClick : undefined}
      onKeyDown={clickable ? handleKeyDown : undefined}
      className={`min-w-0 bg-white rounded-lg border border-slate-200 p-2.5 sm:p-3 transition text-left w-full ${clickable ? 'hover:shadow-md hover:border-indigo-300 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-300' : 'hover:shadow-sm'}`}
    >
      {/* Icon + label share the top row so the label no longer needs a
          row of its own. Icon stays compact on mobile (decorative
          colour-coding); the label uses a smaller font and truncates on
          tight cards (full text on hover via title). */}
      <div className="flex items-center justify-between gap-2 mb-1.5 sm:mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`p-1 sm:p-1.5 rounded-lg shrink-0 ${toneCls}`}>
            <Icon size={14} className="sm:w-4 sm:h-4" />
          </div>
          <p title={activeTab ? `${label} / ${activeTab.l}` : label}
            className="text-[11px] text-slate-500 font-medium uppercase tracking-wide truncate">
            {label}
            {activeTab && activeTab.k !== tabs[0].k && <>
              <span className="text-slate-300"> / </span>
              <span className="text-slate-700 font-semibold">{activeTab.l}</span>
            </>}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* The trend compares the whole period against the whole previous
              one. On a sliced tab it would be comparing different things, so
              it hides rather than quietly mismatching the headline. */}
          {delta !== undefined && (!activeTab || activeTab.k === tabs[0].k)
            && <DeltaChip current={delta} previous={deltaPrev} />}
          {clickable && <ExternalLink size={12} className="text-slate-300" />}
        </div>
      </div>
      {/* Value on its own row; the breakdown chips move to the bottom of the
          card (a separate wrapped row) rather than crowding the value. */}
      <p className="text-sm sm:text-base font-bold text-slate-900 money leading-tight">{shownValue}</p>
      {shownSub && <p className="text-xs text-slate-500 mt-1">{shownSub}</p>}
      {/* When the headline is a genuine zero, say WHY rather than leaving a
          bare "0" that reads as broken. Only shown when the card has no
          slice tabs active (a sliced view's zero is a filter result, not
          an empty dataset). */}
      {emptyHint && !activeTab && shownValue === '0' && (
        <p className="text-[11px] text-slate-400 italic mt-1 leading-snug">{emptyHint}</p>
      )}
      {/* Whatever the card wants under its own figures -- the age strip today.
          Hidden while a slice tab is active, where it would describe the whole
          balance next to a headline showing only a slice. */}
      {footer && !activeTab && footer}
      {activeTab && (
        <div className="flex flex-wrap gap-1 mt-2">
          {tabs.map(t => (
            <button key={t.k} type="button" title={t.hint || ''}
              onClick={(e) => { e.stopPropagation(); setTab(t.k); }}
              className={`px-2.5 py-1 rounded text-[11px] font-medium transition touch-manipulation focus:outline-none focus:ring-1 focus:ring-indigo-400 ${
                activeTab.k === t.k ? 'bg-slate-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
              {t.l}
            </button>
          ))}
        </div>
      )}
      {breakdown && breakdown.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {breakdown.map((b, i) => {
            const chipClass = `inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${b.cls || 'bg-slate-100 text-slate-700'}`;
            // Stop the click from bubbling up to the parent card — otherwise
            // clicking a chip would also fire the card's open-everything handler.
            const onChipClick = b.onClick
              ? (e) => { e.stopPropagation(); b.onClick(); }
              : null;
            if (onChipClick) {
              return (
                <button
                  key={i}
                  type="button"
                  onClick={onChipClick}
                  title={b.title || ''}
                  className={`${chipClass} hover:brightness-95 focus:outline-none focus:ring-1 focus:ring-indigo-400 transition`}
                >
                  <span className="font-normal opacity-75 mr-1">{b.label}</span>
                  <span className="tabular-nums">{b.value}</span>
                </button>
              );
            }
            return (
              <span key={i} className={chipClass} title={b.title || ''}>
                <span className="font-normal opacity-75 mr-1">{b.label}</span>
                <span className="tabular-nums">{b.value}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Records popup ────────────────────────────────────────────────────
// Modal that fires when a clickable stat card is pressed. Fetches the
// matching list from /api/sales/dashboard/records/ on open and renders
// a simple table. One component handles all three card types; the
// `kind` prop picks the columns and the fetch param.
//
// Columns per kind:
//   customer_pos → PO No / Date / Customer / Status / Amount
//   dispatches   → Date / Invoice / Product-Items / Customer / Qty / UOM
//   invoices     → Invoice No / Date / Due Date / Customer / Amount
// Every one of them also gets a Company column when the window spans more
// than one company — see showCompany / coHead / coCell. (This list used to
// claim invoices had a Company column. None of them did.)

// Keep only the options that the window actually contains.
//
// `all` is the full master list (correct ids and labels, hundreds long);
// `namesSeen` is the set of names the API returned for this window, or null
// before the first response. `keep` is whatever is selected right now and is
// never dropped -- a selection disappearing from its own control would strand
// the page in a state its dropdown cannot show.
//
// Matching is by trimmed label because Tally masters carry double spaces.
function present(all = [], namesSeen, keep) {
  if (!namesSeen) return all;
  return all.filter(o => namesSeen.has(String(o.label || '').trim()) || String(o.value) === String(keep));
}

function RecordsModal({ kind, statusFilter,
  period: period0, anchor: anchor0, customFrom: from0, customTo: to0,
  companyId: companyId0, warehouseId: warehouseId0, productId: productId0, customerId: customerId0,
  companyOptions = [], warehousesRaw = [], productOptions = [], customerOptions = [],
  onClose, inline = false, backTo = '/sales/dashboard' }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null);
  // Unit of measure — Dispatches only, and applied SERVER-side because it has
  // to reach the invoice-derived "no DC raised" rows too, which are built there
  // and cannot be filtered out of the returned list by unit alone.
  const [uom, setUom] = useState('');
  // Held across fetches: the response is replaced on every filter change, and
  // letting the list blank out would collapse the picker to "All UOM" on the
  // very request the picker itself triggered.
  const [uomOptions, setUomOptions] = useState([]);
  // Which parties / factories / companies / products this window ACTUALLY
  // contains, learned from the rows the API returns. The dropdowns used to
  // offer every master in the system -- hundreds of customers, most with
  // nothing in the period being looked at.
  //
  // Each list is captured ONLY from a fetch where its own filter was not
  // applied. Capturing it from a filtered fetch would shrink the list to the
  // single value already chosen and leave no way back to the others -- the
  // same trap the UOM list is served from the server to avoid.
  //
  // null means "not learned yet": the full list passed in is used until the
  // first response arrives, so the controls are never empty on open.
  const [seen, setSeen] = useState({ customers: null, warehouses: null, companies: null, products: null });
  // Newest first on open, the same as the Total Sales drill. These lists answer
  // "what happened", so the latest work belongs at the top; the server sends
  // them grouped by customer, which buried it.
  const [dateSort, setDateSort] = useState('desc');  // 'asc' | 'desc'
  const toggleDateSort = () => setDateSort(d => (d === 'asc' ? 'desc' : 'asc'));
  const [pivot, setPivot] = useState('list');  // dispatches pivot: 'list' | 'month' | 'item' | 'customer'
  // Client-side multi-select filters for the dispatch pivots (all rows are
  // already fetched, so we filter locally — no extra API round-trips).
  const [itemSel, setItemSel] = useState([]);        // product||uom keys, [] = all
  const [custSel, setCustSel] = useState([]);        // customer names, [] = all
  const [expandedItem, setExpandedItem] = useState(null);  // By Item drill-open key
  const [itemGroupBy, setItemGroupBy] = useState('family');  // By Item grouping: 'none' | 'family' | 'group'
  const [familyModal, setFamilyModal] = useState(null);    // Family view: clicked family -> items popup
  const [docRec, setDocRec] = useState(null);        // record shown in the hyperlink popup
  const navigate = useNavigate();
  // Full, editable filter set (seeded from the dashboard) — same period navigator
  // as the analytics top bar. Outstanding kinds are live, so period is N/A there.
  const periodApplies = !['outstanding_customers', 'outstanding_invoices'].includes(kind);
  const [period, setPeriod] = useState(period0 || 'month');
  const [anchor, setAnchor] = useState(anchor0 || from0 || todayISO());
  const [from, setFrom] = useState(from0 || todayISO());
  const [to, setTo] = useState(to0 || todayISO());
  const eff = effWindow(period, anchor, from, to);   // effective window sent to the API
  const [companyId, setCompanyId] = useState(companyId0 || '');
  const [warehouseId, setWarehouseId] = useState(warehouseId0 || '');
  const [productId, setProductId] = useState(productId0 || '');
  // The drill's own customer filter lives in the ADDRESS, not component state,
  // so the browser's Back undoes it. Clicking a customer in the list used to
  // change what you saw without adding a history step, so Back skipped the
  // whole drill and dumped you on the dashboard instead of returning to the
  // unfiltered list. Its own param (`dcust`) -- `cust` already means "open this
  // customer's ledger", which is a different place entirely.
  const [recSp, setRecSp] = useSearchParams();
  const customer = recSp.get('dcust') || customerId0 || '';
  const setCustomer = (v, { push = false } = {}) => setRecSp((prev) => {
    const p = new URLSearchParams(prev);
    if (v) p.set('dcust', v); else p.delete('dcust');
    return p;
  }, { replace: !push });
  const warehouseOptions = (companyId
    ? (warehousesRaw || []).filter(w => String(w.company ?? w.company_id) === String(companyId))
    : (warehousesRaw || [])).map(w => ({ value: w.id, label: w.name || w.warehouse_name || w.code || w.id }));
  // Notes drill only: which kind of note is on screen. Everything downstream
  // reads shownRows — the footer total, the Excel export and the pager — so
  // filtering here is all it takes for the totals to follow the pills.
  const [noteKind, setNoteKind] = useState('all');
  const isNotes = kind === 'debit_notes' || kind === 'credit_notes';
  const shownRows = useMemo(() => {
    if (isNotes) {
      return noteKind === 'all' ? rows : rows.filter(r => (r.kind || 'other') === noteKind);
    }
    // Date sort for EVERY drill, not just dispatches. The server groups all of
    // these by customer name, which is why Sales Orders opened alphabetically
    // -- fine for reading one customer's run, useless for "what happened
    // lately". ISO dates sort correctly as plain text, and the sort is stable,
    // so rows sharing a date keep their customer grouping underneath.
    if (!dateSort) return rows;
    return [...rows].sort((a, b) => {
      const cmp = String(a.date || '').localeCompare(String(b.date || ''));
      return dateSort === 'asc' ? cmp : -cmp;
    });
  }, [rows, kind, isNotes, noteKind, dateSort]);

  // Pill row for the notes drill, built from the fetched rows so the counts
  // and money always describe exactly what is on screen. Only rendered when
  // there is a real mix — see noteKindTabs for why.
  const noteKindPills = useMemo(() => {
    if (!isNotes || !rows.length) return null;
    const tally = new Map();
    for (const r of rows) {
      const k = r.kind || 'other';
      const cur = tally.get(k) || { count: 0, amount: 0 };
      cur.count += 1;
      cur.amount += Number(r.amount || 0);
      tally.set(k, cur);
    }
    const present = NOTE_KIND_ORDER.filter(k => tally.has(k));
    if (present.length < 2 && !(present.length === 1 && present[0] !== 'trade')) return null;
    return [{
      k: 'all', l: 'All', count: rows.length,
      amount: rows.reduce((s, r) => s + Number(r.amount || 0), 0),
      hint: 'Every note in this period, whatever it is',
    }, ...present.map(k => ({
      k, l: NOTE_KIND_META[k].l, hint: NOTE_KIND_META[k].hint, ...tally.get(k),
    }))];
  }, [isNotes, rows]);
  // A filter that survives a reload into a different result set would silently
  // show an empty table. Drop back to All whenever the rows change shape.
  useEffect(() => { setNoteKind('all'); }, [kind]);

  // Flatten dispatch DC rows to per-line records (product × qty) for the
  // pivot views. Falls back to the DC-level row when a DC has no line detail.
  const dispLines = useMemo(() => {
    if (kind !== 'dispatches') return [];
    const out = [];
    for (const r of shownRows) {
      const uninvoiced = r.invoiced === false;   // DC with no linked sales invoice
      const ls = (r.lines && r.lines.length) ? r.lines
        : [{ product: r.items || '—', qty: r.qty, uom: r.uom }];
      for (const l of ls) {
        out.push({
          recId: r.id,
          date: r.date || '',
          // Un-invoiced DCs have no real month — bucket them separately instead
          // of on the import date (which would wrongly inflate that month).
          month: uninvoiced ? UNINVOICED_KEY : (r.date || '').slice(0, 7),
          customer: r.customer_name || '—',
          product: l.product || '—',
          uom: l.uom || '',
          qty: Number(l.qty) || 0,
          amount: Number(l.amount) || 0,
          family: l.family || '',
          group: l.group || '',
          invoiceNo: r.invoice_no || '',
          invoiceId: r.invoice_id || null,
          dcNo: r.dc_number || '',
          uninvoiced,
        });
      }
    }
    return out;
  }, [shownRows, kind]);

  // Options for the client-side Item / Customer multi-selects, drawn from the
  // fetched dispatch lines themselves.
  const dispItemOptions = useMemo(() => {
    const m = new Map();
    for (const l of dispLines) {
      if (!isProductLine(l)) { m.set(OTHER_KEY, OTHER_LABEL); continue; }
      const k = `${l.product}||${l.uom}`;
      if (!m.has(k)) m.set(k, `${l.product}${l.uom ? ` (${l.uom})` : ''}`);
    }
    return [...m.entries()].map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [dispLines]);
  const dispCustOptions = useMemo(
    () => [...new Set(dispLines.map(l => l.customer))].sort().map(c => ({ value: c, label: c })),
    [dispLines]);
  // Apply the multi-selects locally. Empty selection ⇒ everything.
  const dispLinesF = useMemo(() => {
    if (!itemSel.length && !custSel.length) return dispLines;
    const iset = new Set(itemSel), cset = new Set(custSel);
    return dispLines.filter(l => {
      const ik = isProductLine(l) ? `${l.product}||${l.uom}` : OTHER_KEY;
      return (!iset.size || iset.has(ik)) && (!cset.size || cset.has(l.customer));
    });
  }, [dispLines, itemSel, custSel]);
  // The Records list is DC-level, so honour the same filters there.
  const shownRowsF = useMemo(() => {
    if (kind !== 'dispatches' || (!itemSel.length && !custSel.length)) return shownRows;
    const iset = new Set(itemSel), cset = new Set(custSel);
    return shownRows.filter(r => {
      if (cset.size && !cset.has(r.customer_name || '—')) return false;
      if (iset.size) {
        const ls = (r.lines && r.lines.length) ? r.lines : [{ product: r.items || '—', uom: r.uom }];
        if (!ls.some(l => iset.has(isProductLine(l) ? `${l.product || '—'}||${l.uom || ''}` : OTHER_KEY))) return false;
      }
      return true;
    });
  }, [shownRows, kind, itemSel, custSel]);

  // ── Pagination ───────────────────────────────────────────────────────
  // These drills rendered EVERY row — 2,364 sales orders in one DOM is slow
  // to paint and impossible to navigate. `rows` stays whole so the Excel
  // export and the footer totals still cover the full result set; only the
  // rendered slice is paged.
  const REC_PAGE_SIZE = 25;
  const [recPage, setRecPage] = useState(1);
  // Aged outstanding invoices arrive largest-balance-first, which answers
  // "who owes the most" but not "who has been waiting longest" — and on an
  // ageing list that second question is usually the point. The server order
  // stays the default; these two re-rank what is already fetched.
  const [agedSort, setAgedSort] = useState('amount');   // amount|longest|newest
  const sortAged = (k) => { setAgedSort(k); setRecPage(1); };
  const agedRows = useMemo(() => {
    if (kind !== 'outstanding_invoices' || agedSort === 'amount') return shownRows;
    return [...shownRows].sort((a, b) => (
      agedSort === 'longest'
        ? (b.days_overdue || 0) - (a.days_overdue || 0)
        : (a.days_overdue || 0) - (b.days_overdue || 0)
    ));
  }, [shownRows, kind, agedSort]);
  const baseRows = kind === 'dispatches' ? shownRowsF
    : kind === 'outstanding_invoices' ? agedRows
      : shownRows;
  const recTotalPages = Math.max(1, Math.ceil(baseRows.length / REC_PAGE_SIZE));
  const recSafePage = Math.min(recPage, recTotalPages);
  const pagedRows = useMemo(
    () => baseRows.slice((recSafePage - 1) * REC_PAGE_SIZE, recSafePage * REC_PAGE_SIZE),
    [baseRows, recSafePage],
  );
  // Back to page 1 whenever the result set changes underneath us.
  useEffect(() => { setRecPage(1); }, [kind, statusFilter, eff.from, eff.to,
    companyId, warehouseId, productId, customer, itemSel, custSel, pivot, dateSort, noteKind,
    agedSort]);
  usePagerKeys({
    enabled: recTotalPages > 1,
    onPrev: () => setRecPage(p => Math.max(1, Math.min(p, recTotalPages) - 1)),
    onNext: () => setRecPage(p => Math.min(recTotalPages, p + 1)),
  });
  const recById = useMemo(() => {
    const m = {};
    for (const r of rows) m[r.id] = r;
    return m;
  }, [rows]);

  // By Item — one row per product (+uom) with its total dispatched qty; expands
  // to its individual dispatch lines (Date · Party · Invoice No · Qty).
  // Non-product free-text lines all collapse into one "Other" row, pinned last.
  const pivotItem = useMemo(() => {
    const m = new Map();
    for (const l of dispLinesF) {
      const prod = isProductLine(l);
      const k = prod ? `${l.product}||${l.uom}` : OTHER_KEY;
      const e = m.get(k) || { key: k, product: prod ? l.product : OTHER_LABEL, uom: prod ? l.uom : '', qty: 0, other: !prod, family: prod ? canonFamily(l.product, l.family) : '', group: prod ? (l.group || '') : '', lines: [] };
      e.qty += l.qty;
      e.lines.push({ date: l.date, month: l.month, customer: l.customer, invoiceNo: l.invoiceNo, invoiceId: l.invoiceId, recId: l.recId, qty: l.qty, amount: l.amount, uninvoiced: l.uninvoiced });
      m.set(k, e);
    }
    const arr = [...m.values()].sort((a, b) => (a.other - b.other) || (b.qty - a.qty));
    arr.forEach(e => e.lines.sort((a, b) => String(a.date).localeCompare(String(b.date))));
    return arr;
  }, [dispLinesF]);

  // Section grouping for the By-Item view — by Tally stock group (goods_sub_type)
  // or product family. Qty across items with different UOMs can't be summed, so
  // a section header shows the item count + a compact per-UOM total instead.
  const itemDisplay = useMemo(() => {
    if (itemGroupBy === 'none') return pivotItem.map(r => ({ type: 'item', r }));
    const addUom = (bag, r) => { if (!r.other) bag[r.uom || '—'] = (bag[r.uom || '—'] || 0) + r.qty; };
    // Sort groups/families in ascending NAME order (numeric-aware, so
    // "Azadirachtin 300 PPM" < 1500 < 3000 < 10000); the catch-all buckets
    // ("Unclassified", then "Other") always sink to the bottom.
    const rank = (lbl) => (lbl === 'Other' ? 3 : lbl === 'Others' ? 2 : lbl === 'Unclassified' ? 1 : 0);
    const nameCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
    const byRankThenName = (a, b) => (rank(a.label) - rank(b.label)) || nameCmp(a.label, b.label);

    // "Stock Group" nests exactly like Tally's Stock Group Summary:
    //   root group -> sub-group (family) -> items, with items that sit directly
    //   under the root group listed loose (no sub-header).
    if (itemGroupBy === 'group') {
      const groups = new Map();
      for (const r of pivotItem) {
        const gRaw = r.other ? '' : (r.group || '');
        const gLabel = r.other ? 'Other' : (STOCK_GROUP_LABELS[gRaw] || gRaw || 'Unclassified');
        let g = groups.get(gLabel);
        if (!g) { g = { label: gLabel, items: [], byUom: {}, qty: 0, fams: new Map() }; groups.set(gLabel, g); }
        g.items.push(r); addUom(g.byUom, r); if (!r.other) g.qty += r.qty;
        const fRaw = r.other ? '' : (r.family || '');
        const fKey = fRaw || '__direct__';
        let f = g.fams.get(fKey);
        if (!f) { f = { label: fRaw, direct: !fRaw, items: [], byUom: {}, qty: 0 }; g.fams.set(fKey, f); }
        f.items.push(r); addUom(f.byUom, r); if (!r.other) f.qty += r.qty;
      }
      const gArr = [...groups.values()].sort(byRankThenName);
      const out = [];
      for (const g of gArr) {
        out.push({ type: 'header', g });
        // Families first (biggest volume leads), loose "direct" items last.
        const fArr = [...g.fams.values()].sort((a, b) =>
          (a.direct - b.direct) || nameCmp(a.label, b.label));
        for (const f of fArr) {
          const nested = !f.direct && !!f.label;
          if (nested) out.push({ type: 'subheader', f });
          for (const r of f.items) out.push({ type: 'item', r, nested });
        }
      }
      return out;
    }

    // "Family" — single-level grouping by the family only.
    const m = new Map();
    for (const r of pivotItem) {
      const raw = r.other ? '' : (r.family || '');
      const label = r.other ? 'Other' : (raw || 'Unclassified');
      const e = m.get(label) || { label, items: [], byUom: {}, qty: 0 };
      e.items.push(r); addUom(e.byUom, r); if (!r.other) e.qty += r.qty;
      m.set(label, e);
    }
    const groups = [...m.values()].sort(byRankThenName);
    return groups.flatMap(g => [{ type: 'header', g }, ...g.items.map(r => ({ type: 'item', r }))]);
  }, [pivotItem, itemGroupBy]);

  // By Month — products down, months across, qty in the cells. Other pinned last.
  const pivotMonth = useMemo(() => {
    // Real month columns sorted chronologically; the Un-invoiced bucket (if any)
    // is pinned last so it never sorts in among the months.
    const realMonths = [...new Set(dispLinesF.map(l => l.month).filter(m => m && m !== UNINVOICED_KEY))].sort();
    const months = dispLinesF.some(l => l.month === UNINVOICED_KEY) ? [...realMonths, UNINVOICED_KEY] : realMonths;
    const m = new Map();
    for (const l of dispLinesF) {
      const prod = isProductLine(l);
      const k = prod ? `${l.product}||${l.uom}` : OTHER_KEY;
      const e = m.get(k) || { product: prod ? l.product : OTHER_LABEL, uom: prod ? l.uom : '', byMonth: {}, total: 0, other: !prod };
      e.byMonth[l.month] = (e.byMonth[l.month] || 0) + l.qty;
      e.total += l.qty; m.set(k, e);
    }
    return { months, rows: [...m.values()].sort((a, b) => (a.other - b.other) || (b.total - a.total)) };
  }, [dispLinesF]);

  // By Customer — mirror the By Month pivot: customers down, months across,
  // dispatched qty in the cells (summed across UOMs), Un-invoiced pinned last.
  const pivotCustomer = useMemo(() => {
    const realMonths = [...new Set(dispLinesF.map(l => l.month).filter(m => m && m !== UNINVOICED_KEY))].sort();
    const months = dispLinesF.some(l => l.month === UNINVOICED_KEY) ? [...realMonths, UNINVOICED_KEY] : realMonths;
    const m = new Map();
    for (const l of dispLinesF) {
      const e = m.get(l.customer) || { customer: l.customer, byMonth: {}, total: 0 };
      e.byMonth[l.month] = (e.byMonth[l.month] || 0) + l.qty;
      e.total += l.qty; m.set(l.customer, e);
    }
    return { months, rows: [...m.values()].sort((a, b) => b.total - a.total) };
  }, [dispLinesF]);

  // Each kind has its own detail route; centralise it here so the
  // table cells can stay declarative.
  const detailPathFor = (id, row) => {
    if (!id) return null;
    if (kind === 'customer_pos') return `/sales/customer-po/${id}`;
    if (kind === 'sales_orders') {
      // Tally-imported invoices show here as synthetic 'CLOSED' orders with no
      // SalesOrder record (so_source='invoice'); route those to the invoice
      // itself — /sales/orders/<invoice-id> would just be an empty page.
      return row?.so_source === 'invoice' ? `/sales/invoices/${id}` : `/sales/orders/${id}`;
    }
    if (kind === 'dispatches')   return `/sales/dc/${id}`;
    if (kind === 'invoices')     return `/sales/invoices/${id}`;
    if (kind === 'outstanding_invoices') return `/sales/invoices/${id}`;
    return null;  // outstanding_customers rows aren't individually navigable
  };
  const openRecord = (id, row) => {
    const path = detailPathFor(id, row);
    if (!path) return;
    // NOT onClose() first. closeView() strips `view` from the URL with
    // replace:true, rewriting the entry you are standing on -- so Back from
    // the record returned to the dashboard with this drill-down already shut.
    // The drill-down stays in the address; this component unmounts anyway the
    // moment the route changes.
    // Tell the detail page its Back button should return to THIS tile.
    navigate(path, { state: { backTo } });
  };

  // Click a Customer name cell → filter this drill-down to just that
  // customer's transactions (instead of opening the record). Resolves the id
  // from the row; falls back to matching the name against the filter options
  // for row kinds that don't carry the id.
  const applyCustomerFilter = (r, e) => {
    e.stopPropagation();
    const id = r.customer_id
      || customerOptions.find(c => (c.label || '') === (r.customer_name || ''))?.value;
    // push: this is a destination, so Back returns to the unfiltered list.
    if (id) setCustomer(String(id), { push: true });
  };
  const custCell = (r) => (
    <td className="py-2 pr-2 sm:pr-3">
      {r.customer_name
        ? (
          <button type="button" onClick={(e) => applyCustomerFilter(r, e)}
            title={`Show only ${r.customer_name}'s transactions`}
            className="text-left text-slate-700 hover:text-indigo-700 hover:underline decoration-dotted underline-offset-2">
            {r.customer_name}
          </button>
        )
        : <span className="text-slate-400">—</span>}
    </td>
  );

  // Company column. Shown only when the window actually spans more than one:
  // with a company picked the answer is already in the dropdown, and most
  // windows are single-company, so this keeps the narrow tables uncluttered.
  //
  // It exists because the company FILTER could not be used without it. The
  // dropdowns are built from the rows the API returns (see `seen` / `present`
  // below), so a field the rows don't carry leaves its control permanently
  // empty — and even where it did populate, nothing on screen said which
  // company a row belonged to, so a filter could not be checked against what
  // it produced.
  const showCompany = !companyId && (seen.companies?.size || 0) > 1;
  const coHead = showCompany
    ? <th className="py-2 pr-2 sm:pr-3 font-semibold">Company</th>
    : null;
  const coCell = (r) => (showCompany ? (
    <td className="py-2 pr-2 sm:pr-3 text-slate-600">
      {r.company_name || <span className="text-slate-400">—</span>}
    </td>
  ) : null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qp = new URLSearchParams();
    qp.set('type', kind);
    // Always send the resolved window (from the navigator) so a specific
    // day/week/month is honoured, not just "this month".
    qp.set('period', 'custom');
    qp.set('from', eff.from);
    qp.set('to', eff.to);
    if (companyId) qp.set('company', companyId);
    if (warehouseId) qp.set('warehouse', warehouseId);
    if (productId) qp.set('product', productId);
    if (uom && kind === 'dispatches') qp.set('uom', uom);
    if (customer) qp.set('customer', customer);
    // Pass the sub-filter through so the backend narrows to just the
    // chosen breakdown bucket (Pending vs Closed for sales_orders).
    if (statusFilter) qp.set('status_filter', statusFilter);
    apiClient.get(`/api/sales/dashboard/records/?${qp.toString()}`)
      .then(res => {
        if (cancelled) return;
        const got = res.data?.rows || [];
        setRows(got);
        setMeta({ count: res.data?.count || 0, period: res.data?.period });
        // Learn what this window holds. Names are compared trimmed because the
        // Tally masters carry double spaces in places.
        const names = (pick) => {
          const out = new Set();
          for (const r of got) {
            const v = pick(r);
            if (Array.isArray(v)) v.forEach(x => x && out.add(String(x).trim()));
            else if (v) out.add(String(v).trim());
          }
          return out;
        };
        setSeen(prev => ({
          customers: customer ? prev.customers : names(r => r.customer_name),
          warehouses: warehouseId ? prev.warehouses : names(r => r.warehouse || r.warehouse_name),
          companies: companyId ? prev.companies : names(r => r.company_name),
          products: productId ? prev.products
            : names(r => [...(r.lines || []).map(l => l.product), r.items, r.product]),
        }));
        if ((res.data?.uom_options || []).length) setUomOptions(res.data.uom_options);
      })
      .catch(err => { if (!cancelled) setError(err.response?.data?.detail || 'Failed to load records.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [kind, statusFilter, eff.from, eff.to, companyId, warehouseId, productId, uom, customer]);

  // Title includes the sub-filter when one is active, so the modal
  // header is unambiguous (e.g. "Sales Orders — Pending").
  const baseTitle = {
    customer_pos: 'Customer POs',
    sales_orders: 'Sales Orders',
    dispatches:   'Dispatches',
    invoices:     'Invoices Raised',
    outstanding_customers: 'Top Outstanding by Customer',
    outstanding_invoices:  'Outstanding Invoices (Aged)',
    debit_notes:  'Debit Notes',
    credit_notes: 'Credit Notes',
  }[kind] || 'Records';
  const subTitle = statusFilter === 'pending'
    ? 'Pending'
    : statusFilter === 'closed'
      ? 'Closed'
      : '';
  const title = subTitle ? `${baseTitle} — ${subTitle}` : baseTitle;

  // Excel export — picks the column set that matches the rendered table.
  const handleExportExcel = () => {
    if (!rows || rows.length === 0) { toast.error('Nothing to export.'); return; }
    const stamp = new Date().toISOString().slice(0, 10);
    const exportMeta = buildFilterMeta({
      companyId, companyOptions, productId, productOptions,
      customerId: customer, customerOptions, warehouseId, warehouseOptions,
      periodLabel: meta?.period?.label || (period ? period[0].toUpperCase() + period.slice(1) : ''),
      from: eff.from, to: eff.to,
    });
    if (kind === 'customer_pos') {
      // Match the friendly labels rendered in the popup table so the
      // exported sheet doesn't surface raw codes like SO_CREATED.
      const PO_STATUS_LABEL = {
        PENDING: 'Pending', SO_CREATED: 'SO Created', PARTIAL_DC: 'Partial DC',
        DC_CREATED: 'DC Created', CLOSED: 'Closed',
      };
      const data = rows.map(r => ({
        po_no: r.upload_id || r.po_number || '',
        printed_po: r.po_number || '',
        date: r.date || '',
        customer: r.customer_name || '',
        company: r.company_name || '',
        po_status: PO_STATUS_LABEL[r.po_status] || r.po_status || '',
        amount: Number(r.amount || 0).toFixed(2),
      }));
      exportToExcel(data, [
        { field: 'po_no', header: 'PO No' },
        { field: 'printed_po', header: 'Printed PO No' },
        { field: 'date', header: 'Date' },
        { field: 'customer', header: 'Customer' },
        { field: 'company', header: 'Company' },
        { field: 'po_status', header: 'PO Status' },
        { field: 'amount', header: 'Amount (₹)' },
      ], `dashboard-customer-pos${statusFilter ? `-${statusFilter}` : ''}-${stamp}`, 'Sheet1', null, exportMeta);
    } else if (kind === 'sales_orders') {
      const data = rows.map(r => ({
        so_no: r.so_no || '',
        date: r.date || '',
        customer: r.customer_name || '',
        company: r.company_name || '',
        status: r.status || '',
        amount: Number(r.amount || 0).toFixed(2),
      }));
      exportToExcel(data, [
        { field: 'so_no', header: 'SO No' },
        { field: 'date', header: 'Date' },
        { field: 'customer', header: 'Customer' },
        { field: 'company', header: 'Company' },
        { field: 'status', header: 'Status' },
        { field: 'amount', header: 'Amount (₹)' },
      ], `dashboard-sales-orders${statusFilter ? `-${statusFilter}` : ''}-${stamp}`, 'Sheet1', null, exportMeta);
    } else if (kind === 'dispatches') {
      const data = shownRows.map(r => ({
        date: r.date || '',
        invoice_no: r.invoice_no || '',
        items: r.items || '',
        customer: r.customer_name || '',
        company: r.company_name || '',
        qty: Number(r.qty || 0).toFixed(3),
        uom: r.uom || '',
        qty_source: r.qty_source === 'invoice' ? 'From invoice' : 'Dispatch lines',
      }));
      exportToExcel(data, [
        { field: 'date', header: 'Date' },
        { field: 'invoice_no', header: 'Invoice No' },
        { field: 'items', header: 'Product / Items' },
        { field: 'customer', header: 'Customer' },
        { field: 'company', header: 'Company' },
        { field: 'qty', header: 'Qty Dispatched' },
        { field: 'uom', header: 'UOM' },
        { field: 'qty_source', header: 'Qty Source' },
      ], `dashboard-dispatches-${stamp}`, 'Sheet1', null, exportMeta);
    } else if (kind === 'invoices') {
      const data = rows.map(r => ({
        invoice_no: r.invoice_no || '',
        date: r.date || '',
        due_date: r.due_date || '',
        customer: r.customer_name || '',
        company: r.company_name || '',
        amount: Number(r.amount || 0).toFixed(2),
      }));
      exportToExcel(data, [
        { field: 'invoice_no', header: 'Invoice No' },
        { field: 'date', header: 'Date' },
        { field: 'due_date', header: 'Due Date' },
        { field: 'customer', header: 'Customer' },
        { field: 'company', header: 'Company' },
        { field: 'amount', header: 'Amount (₹)' },
      ], `dashboard-invoices-${stamp}`, 'Sheet1', null, exportMeta);
    } else if (kind === 'outstanding_customers') {
      const data = rows.map(r => ({
        customer: r.customer_name || '',
        invoices: r.invoice_count,
        overdue: Number(r.overdue || 0).toFixed(2),
        outstanding: Number(r.outstanding || 0).toFixed(2),
      }));
      exportToExcel(data, [
        { field: 'customer', header: 'Customer' },
        { field: 'invoices', header: 'Unpaid Invoices' },
        { field: 'overdue', header: 'Overdue (₹)' },
        { field: 'outstanding', header: 'Outstanding (₹)' },
      ], `dashboard-outstanding-customers-${stamp}`, 'Sheet1', null, exportMeta);
    } else if (kind === 'outstanding_invoices') {
      const data = rows.map(r => ({
        invoice_no: r.invoice_no || '',
        customer: r.customer_name || '',
        invoice_date: r.invoice_date || '',
        due_date: r.due_date || '',
        days_overdue: r.days_overdue || 0,
        balance: Number(r.balance || 0).toFixed(2),
      }));
      exportToExcel(data, [
        { field: 'invoice_no', header: 'Invoice No' },
        { field: 'customer', header: 'Customer' },
        { field: 'invoice_date', header: 'Invoice Date' },
        { field: 'due_date', header: 'Due Date' },
        { field: 'days_overdue', header: 'Days Overdue' },
        { field: 'balance', header: 'Balance (₹)' },
      ], `dashboard-outstanding-invoices-${stamp}`, 'Sheet1', null, exportMeta);
    } else if (kind === 'debit_notes' || kind === 'credit_notes') {
      // shownRows, not rows: the kind pills are a filter the user chose, so
      // the download should be what they are looking at. (Paging is different
      // — that's why every other branch here exports the whole set.)
      const data = shownRows.map(r => ({
        note_no: r.note_no || '',
        date: r.date || '',
        customer: r.customer_name || '',
        company: r.company_name || '',
        note_kind: NOTE_KIND_META[r.kind]?.l || 'Unclassified',
        reason: r.reason || '',
        reference: r.reference || '',
        amount: Number(r.amount || 0).toFixed(2),
      }));
      exportToExcel(data, [
        { field: 'note_no', header: 'Note No' },
        { field: 'date', header: 'Date' },
        { field: 'customer', header: 'Customer' },
        { field: 'company', header: 'Company' },
        { field: 'note_kind', header: 'Kind' },
        { field: 'reason', header: 'Reason' },
        { field: 'reference', header: 'Against Ref' },
        { field: 'amount', header: 'Amount (₹)' },
      ], `dashboard-${kind.replace('_', '-')}-${stamp}`, 'Sheet1', null, exportMeta);
    }
    toast.success('Excel downloaded!');
  };

  // Lock body scroll while the modal is open so the table scroll
  // container is the only thing the wheel touches.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <div className={inline ? '' : 'fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-2 sm:p-4'} onClick={inline ? undefined : onClose}>
      <div
        className={inline
          ? 'bg-white rounded-xl border border-slate-200 shadow-sm w-full flex flex-col'
          : 'bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[95dvh] sm:max-h-[85dvh] flex flex-col'}
        role={inline ? undefined : 'dialog'}
        aria-modal={inline ? undefined : 'true'}
        aria-label={title}
        onClick={inline ? undefined : (e => e.stopPropagation())}
      >
        {/* Header — tile name + filters inline on one row, Excel/close on the
            right. Filters flex-wrap so the last dropdowns arrange onto a
            second line on narrow screens. */}
        {/* Two rows, always. The old single-row layout put the filters in a
            `flex-1` between two `shrink-0` blocks, so on a phone they were
            squeezed into a sliver and clipped off the right edge. */}
        <div className="flex flex-col gap-2.5 border-b border-slate-200 px-4 sm:px-5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-slate-800">{title}</h2>
              {meta?.period && (
                <p className="text-xs text-slate-500 mt-0.5">
                  {meta.period.label}
                  {meta.period.from ? ` · ${meta.period.from} → ${meta.period.to}` : ''}
                  {' · '}{meta.count} record{meta.count === 1 ? '' : 's'}
                  {productId && (kind === 'outstanding_customers' || kind === 'outstanding_invoices') && (
                    <span className="text-slate-400"> · all products (AR is invoice-level)</span>
                  )}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* Open the same notes in the full Debit & Credit Notes page,
                  carrying the window and company THIS drill-down is showing --
                  so the list arrives holding the same records, not every note
                  ever raised. `meta.period` is the window the API actually
                  used, which is the only honest thing to pass on. */}
              {(kind === 'debit_notes' || kind === 'credit_notes') && !loading && !error && (
                <button
                  type="button"
                  onClick={() => {
                    const qp = new URLSearchParams({
                      type: kind === 'debit_notes' ? 'DEBIT' : 'CREDIT',
                    });
                    if (meta?.period?.from) qp.set('from', meta.period.from);
                    if (meta?.period?.to) qp.set('to', meta.period.to);
                    if (companyId) qp.set('company', companyId);
                    if (customer) qp.set('customer', customer);
                    navigate(`/sales/debit-notes?${qp.toString()}`, { state: { backTo } });
                  }}
                  className={`inline-flex items-center gap-1.5 px-3 border border-slate-300 bg-white text-slate-700 rounded-lg text-xs font-medium hover:bg-slate-50 ${CTRL_H}`}
                  title="Open these notes in the Debit & Credit Notes page, keeping this period and company"
                >
                  Open in Notes
                </button>
              )}
              {!loading && !error && rows.length > 0 && (
                <button
                  onClick={handleExportExcel}
                  className={`inline-flex items-center gap-1.5 px-3 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 ${CTRL_H}`}
                >
                  <Download size={14} /> <span className="hidden sm:inline">Excel</span>
                </button>
              )}
              {/* Square, and the same height as everything else on the row, so
                  the close control lines up with the export button instead of
                  floating at its own size. */}
              <button onClick={onClose} aria-label="Close"
                className={`inline-flex items-center justify-center aspect-square rounded-lg hover:bg-slate-100 text-slate-500 ${CTRL_H}`}>
                <X size={18} />
              </button>
            </div>
          </div>
          {/* Filters get their own full-width row so they can wrap freely. */}
          <div className="flex flex-wrap items-center gap-1.5">
            {periodApplies && (
              <PeriodNavigator period={period} setPeriod={setPeriod} anchor={anchor} setAnchor={setAnchor}
                customFrom={from} customTo={to} setCustomFrom={setFrom} setCustomTo={setTo} />
            )}
            <CustomSelect value={companyId} onChange={e => { setCompanyId(e.target.value); setWarehouseId(''); }}
              className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-0 max-w-[170px] ${CTRL_H}`}>
              <option value="">All Companies</option>
              {present(companyOptions, seen.companies, companyId).map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </CustomSelect>
            {/* No Factory control here. It could not be made to work on this
                screen: Sales Orders rows carry no warehouse, so its list was
                always empty, and on the note views the server answers a
                factory with qs.none() — a control whose only possible effect
                was to blank the list. The API still accepts `warehouse_id`,
                so bringing it back is a dropdown, not a rewrite. */}
            {/* Product is real for orders, dispatches and invoices; a note has
                no product line, so the same qs.none() applies and the control
                is left out rather than offered and disappointing. */}
            {!isNotes && (
              <CustomSelect value={productId} onChange={e => setProductId(e.target.value)}
                className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-0 max-w-[170px] ${CTRL_H}`}>
                <option value="">All Products</option>
                {present(productOptions, seen.products, productId).map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </CustomSelect>
            )}
            <CustomSelect value={customer} onChange={e => setCustomer(e.target.value)}
              className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-0 max-w-[170px] ${CTRL_H}`}>
              <option value="">All Customers</option>
              {present(customerOptions, seen.customers, customer).map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </CustomSelect>
            {/* Dispatches only — a unit belongs to a dispatch LINE, so it is
                the one view where filtering by it is exact. Options come from
                the server, read off the dispatch lines themselves. */}
            {kind === 'dispatches' && uomOptions.length > 0 && (
              <CustomSelect value={uom} onChange={e => setUom(e.target.value)}
                title="Unit of measure"
                className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-0 max-w-[170px] ${CTRL_H}`}>
                <option value="">All UOM</option>
                {uomOptions.map(u => <option key={u} value={u}>{u}</option>)}
              </CustomSelect>
            )}
          </div>
        </div>
        <div className="overflow-auto p-4">
          {loading && (
            <div className="flex items-center justify-center py-10 text-slate-500 text-sm gap-2">
              <Loader2 size={16} className="animate-spin" /> Loading…
            </div>
          )}
          {!loading && error && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded p-3 text-sm">{error}</div>
          )}
          {!loading && !error && shownRows.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-8">
              {rows.length === 0 ? 'No records in this window.' : 'No records for the selected customer.'}
            </p>
          )}
          {!loading && !error && shownRows.length > 0 && kind === 'customer_pos' && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs sm:text-sm">
                <thead className="border-b">
                  <tr className="text-left text-slate-500">
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">PO No</th>
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Date</th>
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Customer</th>
                    {coHead}
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">PO Status</th>
                    <th className="py-2 font-semibold text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map(r => {
                    // Translate the raw lifecycle code into a friendlier
                    // label + colour so the popup reads at a glance and
                    // matches the chip styling on the Customer PO list
                    // page. CLOSED = emerald (done), the in-progress
                    // states share amber, PENDING (no SO yet) stays
                    // slate to signal it hasn't been actioned at all.
                    const poStatus = r.po_status || 'PENDING';
                    const poStatusMeta = {
                      PENDING:    { label: 'Pending',    cls: 'bg-slate-100 text-slate-700' },
                      SO_CREATED: { label: 'SO Created', cls: 'bg-amber-50 text-amber-700 border border-amber-200' },
                      PARTIAL_DC: { label: 'Partial DC', cls: 'bg-amber-50 text-amber-700 border border-amber-200' },
                      DC_CREATED: { label: 'DC Created', cls: 'bg-amber-50 text-amber-700 border border-amber-200' },
                      CLOSED:     { label: 'Closed',     cls: 'bg-emerald-50 text-emerald-700 border border-emerald-200' },
                    }[poStatus] || { label: poStatus, cls: 'bg-slate-100 text-slate-700' };
                    return (
                      <tr key={r.id} className="border-b last:border-b-0 hover:bg-primary-50/40 transition-colors">
                        {/* PO No cell. Headline is the system-generated
                            upload_id (our canonical CPO link). The
                            customer's printed po_number sits underneath
                            as context. The link navigates to the CPO
                            detail page. */}
                        <td className="py-2 pr-2 sm:pr-3 tabular-nums">
                          <button
                            type="button"
                            onClick={() => openRecord(r.id)}
                            className="font-medium text-indigo-700 hover:text-indigo-900 hover:underline text-left"
                          >
                            {r.upload_id || r.po_number || '—'}
                          </button>
                          {r.upload_id && r.po_number && r.po_number !== r.upload_id && (
                            <div className="text-[11px] text-slate-400">PO {r.po_number}</div>
                          )}
                        </td>
                        <td className="py-2 pr-2 sm:pr-3 text-slate-600 tabular-nums">{r.date || '—'}</td>
                        {custCell(r)}
                        {coCell(r)}
                        <td className="py-2 pr-2 sm:pr-3 text-xs">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded ${poStatusMeta.cls}`}>
                            {poStatusMeta.label}
                          </span>
                        </td>
                        <td className="py-2 text-right font-semibold tabular-nums">{fmtINRfull(r.amount)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!loading && !error && shownRows.length > 0 && kind === 'sales_orders' && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs sm:text-sm">
                <thead className="border-b">
                  <tr className="text-left text-slate-500">
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">SO No</th>
                    <th className="py-2 pr-2 sm:pr-3 font-semibold cursor-pointer select-none hover:text-slate-700"
                        onClick={toggleDateSort} title="Sort by date">
                      <span className="inline-flex items-center gap-1">Date <span className="text-[10px] text-indigo-600">{dateSort === 'asc' ? '▲' : '▼'}</span></span>
                    </th>
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Customer</th>
                    {coHead}
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Status</th>
                    <th className="py-2 font-semibold text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map(r => (
                    <tr key={r.id} onClick={() => openRecord(r.id, r)}
                      className="border-b last:border-b-0 hover:bg-indigo-50/50 cursor-pointer">
                      <td className="py-2 pr-2 sm:pr-3 tabular-nums">
                        <span className="font-medium text-indigo-700">{r.so_no || '—'}</span>
                        {r.so_source === 'invoice' && <span className="ml-1.5 text-[10px] text-slate-400">(invoice)</span>}
                      </td>
                      <td className="py-2 pr-2 sm:pr-3 text-slate-600 tabular-nums">{r.date || '—'}</td>
                      {custCell(r)}
                      {coCell(r)}
                      <td className="py-2 pr-2 sm:pr-3 text-xs">
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
                          {r.status}
                        </span>
                      </td>
                      <td className="py-2 text-right font-semibold tabular-nums">{fmtINRfull(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loading && !error && shownRows.length > 0 && kind === 'dispatches' && (
            <>
            {/* ONE row: how the rows are grouped, then what they are narrowed
                to. These were two rows with two label prefixes ("View:",
                "Filter: Items / Customers") and three different control sizes,
                which is what made the toolbar read as clutter above the data.

                The labels are gone because each control now says what it is —
                the segments are named, and an empty multi-select reads "All
                items" / "All Customers", matching the "All Companies" selects
                on the row above. Heights all come from CTRL_H, so everything
                sits on one baseline. */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              {/* Joined segments, like the period control — a segmented group
                  reads as one either/or choice; the detached bordered buttons
                  it replaced read as four independent toggles. */}
              <div className={`flex rounded-lg border border-slate-300 overflow-hidden ${CTRL_H}`}>
                {[['list', 'Records'], ['month', 'By Month'], ['item', 'By Item'], ['customer', 'By Customer']].map(([k, label], i) => (
                  <button key={k} type="button" onClick={() => setPivot(k)}
                    aria-pressed={pivot === k}
                    className={`px-2.5 text-xs font-medium transition ${i > 0 ? 'border-l border-slate-200' : ''} ${pivot === k ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                    {label}
                  </button>
                ))}
              </div>
              <FilterMultiSelect options={dispItemOptions} value={itemSel} onChange={setItemSel}
                label="Filter items" placeholder="All items"
                className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-[130px] max-w-[200px] ${CTRL_H}`} />
              <FilterMultiSelect options={dispCustOptions} value={custSel} onChange={setCustSel}
                label="Filter customers" placeholder="All Customers"
                className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-[130px] max-w-[200px] ${CTRL_H}`} />
              {(itemSel.length > 0 || custSel.length > 0) && (
                <button type="button" onClick={() => { setItemSel([]); setCustSel([]); }}
                  className="text-xs text-slate-500 hover:text-indigo-700 underline">Clear</button>
              )}
            </div>
            {pivot === 'list' && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs sm:text-sm">
                <thead className="border-b">
                  <tr className="text-left text-slate-500">
                    <th className="py-2 pr-2 sm:pr-3 font-semibold cursor-pointer select-none hover:text-slate-700"
                        onClick={toggleDateSort} title="Sort by date">
                      <span className="inline-flex items-center gap-1">Date <span className="text-[10px] text-indigo-600">{dateSort === 'asc' ? '▲' : '▼'}</span></span>
                    </th>
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Invoice</th>
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Product / Items</th>
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Customer</th>
                    {coHead}
                    <th className="py-2 pr-2 sm:pr-3 font-semibold text-right">Qty</th>
                    <th className="py-2 font-semibold">UOM</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map(r => (
                    // Row is NOT clickable: the whole-row nav went to /sales/dc/:id,
                    // but these quantity rows are invoice-sourced so that 404s
                    // ("Dispatch Challan not found"). Use the Invoice link instead.
                    <tr key={r.id}
                      className="border-b last:border-b-0 hover:bg-slate-50/50">
                      <td className="py-2 pr-2 sm:pr-3 text-slate-600 tabular-nums">{r.date || '—'}</td>
                      <td className="py-2 pr-2 sm:pr-3 tabular-nums">
                        {(r.invoice_no || r.dc_number)
                          ? <button type="button" onClick={(e) => { e.stopPropagation(); setDocRec(r); }}
                              title="View dispatch / invoice detail"
                              className="font-medium text-blue-700 hover:underline text-left">{r.invoice_no || r.dc_number || '—'}</button>
                          : <span className="text-slate-500">—</span>}
                      </td>
                      <td className="py-2 pr-2 sm:pr-3 text-slate-700 max-w-[260px] truncate" title={r.items || ''}>{r.items || '—'}</td>
                      {custCell(r)}
                      {coCell(r)}
                      {/* Qty read off the invoice (DC has no lines of its own) is
                          flagged, so a 900 from a real dispatch is never confused
                          with one inferred from the bill. */}
                      <td className="py-2 pr-2 sm:pr-3 text-right font-semibold tabular-nums"
                        title={r.qty_source === 'invoice' ? 'Taken from the invoice — this DC has no dispatch lines recorded' : undefined}>
                        {fmtQty(r.qty)}{r.qty_source === 'invoice' && <span className="text-amber-500 font-normal">*</span>}
                      </td>
                      <td className="py-2 text-slate-600">{r.uom || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}

            {pivot === 'item' && (
              <>
                {/* The Group-by switcher offered Family, Stock Group and None.
                    Only Family was wanted, so the row is gone and `itemGroupBy`
                    keeps its 'family' default -- nothing sets it away from that
                    now, so every branch below takes the family path exactly as
                    it did when Family was selected. Display grouping only: the
                    quantities were never affected by this control. */}
                <div className="overflow-x-auto">
                  <table className="w-full text-xs sm:text-sm">
                    <tbody>
                    {itemDisplay.map((d, i) => {
                      if (d.type === 'header') {
                        const uomStr = Object.entries(d.g.byUom)
                          .map(([u, q]) => `${fmtQty(q)} ${u}`).join(' · ');
                        // In Family view the list is collapsed to family names;
                        // clicking a family opens its items in a popup.
                        const clickable = itemGroupBy === 'family';
                        return (
                          <tr key={`h-${d.g.label}`}
                            className={`bg-slate-100/70 border-b ${clickable ? 'cursor-pointer hover:bg-slate-200/70' : ''}`}
                            onClick={clickable ? () => setFamilyModal(d.g) : undefined}>
                            <td className="py-2 pr-3 font-bold text-slate-900 uppercase text-xs tracking-wide">
                              <span className="inline-flex items-center gap-1">
                                {clickable && <ChevronRight size={13} className="text-slate-500" />}
                                {d.g.label}
                                <span className="ml-1 font-normal text-slate-400 normal-case">({d.g.items.length})</span>
                              </span>
                            </td>
                            <td colSpan={2} className="py-1.5 text-right text-[11px] font-bold text-slate-800 tabular-nums">{uomStr}</td>
                          </tr>
                        );
                      }
                      if (d.type === 'subheader') {
                        const uomStr = Object.entries(d.f.byUom)
                          .map(([u, q]) => `${fmtQty(q)} ${u}`).join(' · ');
                        return (
                          <tr key={`s-${d.f.label}`} className="bg-slate-50 border-b">
                            <td className="py-1 pr-3 pl-4 font-bold text-slate-700 text-[11px]">
                              {d.f.label}
                              <span className="ml-1.5 font-normal text-slate-400">({d.f.items.length})</span>
                            </td>
                            <td colSpan={2} className="py-1 text-right text-[11px] font-bold text-slate-700 tabular-nums">{uomStr}</td>
                          </tr>
                        );
                      }
                      // Family view hides item rows — they live in the popup.
                      if (itemGroupBy === 'family') return null;
                      const r = d.r;
                      const open = expandedItem === r.key;
                      const indent = d.nested ? 'pl-8' : (itemGroupBy !== 'none' ? 'pl-4' : '');
                      return (
                        <Fragment key={r.key || i}>
                          <tr onClick={() => setExpandedItem(open ? null : r.key)}
                            className="border-b last:border-b-0 hover:bg-indigo-50/50 cursor-pointer">
                            <td className={`py-2 pr-3 ${indent} ${r.other ? 'text-slate-400 italic' : 'text-slate-700'}`}>
                              <span className="inline-flex items-center gap-1">
                                <ChevronRight size={13} className={`text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} />
                                {r.product}
                              </span>
                            </td>
                            <td className="py-2 pr-3 text-right font-semibold tabular-nums">{fmtQty(r.qty)}</td>
                            <td className="py-2 text-slate-600">{r.uom || '—'}</td>
                          </tr>
                          {open && (
                            <tr className="bg-slate-50/60">
                              <td colSpan={3} className="px-3 py-2">
                                <table className="w-full text-xs">
                                  <thead><tr className="text-left text-slate-400">
                                    <th className="py-1 pr-3 font-semibold">Date</th>
                                    <th className="py-1 pr-3 font-semibold">Party</th>
                                    <th className="py-1 pr-3 font-semibold">Invoice No</th>
                                    <th className="py-1 font-semibold text-right">Qty</th>
                                  </tr></thead>
                                  <tbody>
                                    {r.lines.map((ln, li) => (
                                      <tr key={li} className="border-t border-slate-100">
                                        <td className="py-1 pr-3 text-slate-600 tabular-nums">{ln.date || '—'}</td>
                                        <td className="py-1 pr-3 text-slate-600">{ln.customer || '—'}</td>
                                        <td className="py-1 pr-3 tabular-nums">
                                          {ln.uninvoiced
                                            ? <span className="text-amber-600">Un-invoiced</span>
                                            : (ln.invoiceNo
                                                ? <button type="button" onClick={() => setDocRec(recById[ln.recId])}
                                                    className="text-blue-700 hover:underline">{ln.invoiceNo}</button>
                                                : <span className="text-slate-400">—</span>)}
                                        </td>
                                        <td className="py-1 text-right tabular-nums text-slate-700">{fmtQty(ln.qty)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {pivot === 'month' && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs sm:text-sm">
                  <thead className="border-b"><tr className="text-left text-slate-500">
                    <th className="py-2 pr-3 font-semibold sticky left-0 bg-white z-10">Item</th>
                    {pivotMonth.months.map(m => <th key={m} title={m === UNINVOICED_KEY ? 'Delivery challans with no linked sales invoice — no real dispatch date, so shown here instead of a month' : undefined} className={`py-2 px-2 font-medium text-right whitespace-nowrap ${m === UNINVOICED_KEY ? 'text-amber-600' : ''}`}>{fmtMonth(m)}</th>)}
                    <th className="py-2 pl-3 font-semibold text-right whitespace-nowrap">Total</th>
                  </tr></thead>
                  <tbody>
                    {pivotMonth.rows.map((r, i) => (
                      <tr key={i} className="border-b last:border-b-0 hover:bg-indigo-50/50">
                        <td className={`py-2 pr-3 sticky left-0 bg-white whitespace-nowrap max-w-[45vw] sm:max-w-none truncate ${r.other ? 'text-slate-400 italic' : 'text-slate-700'}`} title={r.product}>{r.product}{r.uom ? <span className="text-slate-400"> ({r.uom})</span> : ''}</td>
                        {pivotMonth.months.map(m => <td key={m} className={`py-2 px-2 text-right tabular-nums ${m === UNINVOICED_KEY ? 'text-amber-600' : 'text-slate-600'}`}>{r.byMonth[m] ? fmtQty(r.byMonth[m]) : '—'}</td>)}
                        <td className="py-2 pl-3 text-right font-semibold tabular-nums">{fmtQty(r.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {pivot === 'customer' && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs sm:text-sm">
                  <thead className="border-b"><tr className="text-left text-slate-500">
                    <th className="py-2 pr-3 font-semibold sticky left-0 bg-white z-10">Customer</th>
                    {pivotCustomer.months.map(m => <th key={m} title={m === UNINVOICED_KEY ? 'Delivery challans with no linked sales invoice — no real dispatch date, so shown here instead of a month' : undefined} className={`py-2 px-2 font-medium text-right whitespace-nowrap ${m === UNINVOICED_KEY ? 'text-amber-600' : ''}`}>{fmtMonth(m)}</th>)}
                    <th className="py-2 pl-3 font-semibold text-right whitespace-nowrap">Total</th>
                  </tr></thead>
                  <tbody>
                    {pivotCustomer.rows.map((r, i) => (
                      <tr key={i} className="border-b last:border-b-0 hover:bg-indigo-50/50">
                        <td className="py-2 pr-3 sticky left-0 bg-white whitespace-nowrap text-slate-700 max-w-[45vw] sm:max-w-[220px] truncate" title={r.customer}>{r.customer}</td>
                        {pivotCustomer.months.map(m => <td key={m} className={`py-2 px-2 text-right tabular-nums ${m === UNINVOICED_KEY ? 'text-amber-600' : 'text-slate-600'}`}>{r.byMonth[m] ? fmtQty(r.byMonth[m]) : '—'}</td>)}
                        <td className="py-2 pl-3 text-right font-semibold tabular-nums">{fmtQty(r.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Hyperlink popup — quick dispatch/invoice detail without leaving
                the drill, with links to the full invoice / DC pages. */}
            {docRec && (
              <div className="fixed inset-0 z-[70] bg-slate-900/40 flex items-center justify-center p-4" onClick={() => setDocRec(null)}>
                <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85dvh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-slate-800 truncate">{docRec.invoice_no || docRec.dc_number || 'Dispatch'}</h3>
                      <p className="text-[11px] text-slate-500">{docRec.date || '—'} · {docRec.customer_name || '—'}</p>
                    </div>
                    <button onClick={() => setDocRec(null)} className="p-1.5 rounded hover:bg-slate-100 text-slate-500 shrink-0"><X size={16} /></button>
                  </div>
                  <div className="overflow-auto px-4 py-3">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-3">
                      <div><span className="text-slate-400">DC No:</span> <span className="text-slate-700">{docRec.dc_number || '—'}</span></div>
                      <div><span className="text-slate-400">Invoice:</span> <span className="text-slate-700">{docRec.invoice_no || (docRec.invoiced === false ? 'Un-invoiced' : '—')}</span></div>
                      <div><span className="text-slate-400">SO No:</span> <span className="text-slate-700">{docRec.so_number || '—'}</span></div>
                      <div><span className="text-slate-400">Warehouse:</span> <span className="text-slate-700">{docRec.warehouse || '—'}</span></div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="border-b"><tr className="text-left text-slate-500">
                          <th className="py-1.5 pr-3 font-semibold">Product</th>
                          <th className="py-1.5 pr-3 font-semibold text-right">Qty</th>
                          <th className="py-1.5 font-semibold">UOM</th>
                        </tr></thead>
                        <tbody>
                          {((docRec.lines && docRec.lines.length) ? docRec.lines : [{ product: docRec.items, qty: docRec.qty, uom: docRec.uom }]).map((ln, li) => (
                            <tr key={li} className="border-b last:border-b-0">
                              <td className="py-1.5 pr-3 text-slate-700">{ln.product || '—'}</td>
                              <td className="py-1.5 pr-3 text-right tabular-nums">{fmtQty(ln.qty)}</td>
                              <td className="py-1.5 text-slate-600">{ln.uom || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div className="border-t border-slate-200 px-4 py-2.5 flex justify-end gap-2">
                    {docRec.invoice_id && (
                      <button onClick={() => navigate(`/sales/invoices/${docRec.invoice_id}`, { state: { backTo } })}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700"><ExternalLink size={13} /> Open invoice</button>
                    )}
                    {/* Only when a delivery challan actually exists. Rows the
                        API builds from an INVOICE with no DC raised carry the
                        invoice's own id in `id` and an empty `dc_number` -- so
                        this button was not merely showing when there was
                        nothing to open, it was navigating to /sales/dc/<an
                        invoice id> and landing on the wrong record. dc_number
                        is what distinguishes the two. */}
                    {docRec.id && docRec.dc_number && (
                      <button onClick={() => navigate(`/sales/dc/${docRec.id}`, { state: { backTo } })}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 text-slate-700 rounded-lg text-xs font-medium hover:bg-slate-50"><ExternalLink size={13} /> Open DC</button>
                    )}
                  </div>
                </div>
              </div>
            )}
            {familyModal && (
              <div className="fixed inset-0 z-[60] bg-slate-900/40 flex items-center justify-center p-4" onClick={() => setFamilyModal(null)}>
                <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[88dvh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                    <div className="min-w-0">
                      <h3 className="text-base font-semibold text-slate-900 truncate">{familyModal.label}</h3>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {familyModal.items.length} item(s) · {Object.entries(familyModal.byUom).map(([u, q]) => `${fmtQty(q)} ${u}`).join(' · ')}
                        <span className="text-slate-400"> · tap a product to see who bought it</span>
                      </p>
                    </div>
                    <button onClick={() => setFamilyModal(null)} className="p-1.5 rounded hover:bg-slate-100 text-slate-500 shrink-0"><X size={18} /></button>
                  </div>
                  <div className="overflow-auto">
                    <table className="w-full text-xs sm:text-sm">
                      <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b text-slate-500 text-[11px] uppercase tracking-wide sticky top-0 z-10"><tr className="text-left">
                        <th className="py-2.5 px-5 font-semibold">Item</th>
                        <th className="py-2.5 px-3 font-semibold text-right">Total Qty</th>
                        <th className="py-2.5 px-5 font-semibold">UOM</th>
                      </tr></thead>
                      <tbody>
                        {[...familyModal.items].sort((a, b) => b.qty - a.qty).map((it, ii) => {
                          const open = expandedItem === it.key;
                          const lines = it.lines || [];
                          return (
                            <Fragment key={it.key || ii}>
                              <tr onClick={() => lines.length && setExpandedItem(open ? null : it.key)}
                                className={`border-b last:border-b-0 hover:bg-indigo-50/50 ${lines.length ? 'cursor-pointer' : ''}`}>
                                <td className="py-3 px-5 text-slate-800">
                                  <span className="inline-flex items-center gap-1.5">
                                    {lines.length
                                      ? <ChevronRight size={14} className={`text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} />
                                      : <span className="inline-block w-[14px]" />}
                                    {it.product}
                                  </span>
                                </td>
                                <td className="py-3 px-3 text-right font-semibold tabular-nums">{fmtQty(it.qty)}</td>
                                <td className="py-3 px-5 text-slate-600">{it.uom || '—'}</td>
                              </tr>
                              {open && (() => {
                                // Per-customer, month-by-month rollup for this product:
                                // qty in each month column (Apr…Sep for an FY), a total
                                // qty and the total ex-GST amount. No invoice rows — this
                                // is the "By Customer" cut, scoped to the one product.
                                const monthsSet = [...new Set(lines.map(l => l.month).filter(m => m && m !== UNINVOICED_KEY))].sort();
                                const months = lines.some(l => l.month === UNINVOICED_KEY) ? [...monthsSet, UNINVOICED_KEY] : monthsSet;
                                const cmap = new Map();
                                for (const ln of lines) {
                                  const e = cmap.get(ln.customer) || { customer: ln.customer, byMonth: {}, qty: 0, amount: 0 };
                                  e.byMonth[ln.month] = (e.byMonth[ln.month] || 0) + (Number(ln.qty) || 0);
                                  e.qty += Number(ln.qty) || 0;
                                  e.amount += Number(ln.amount) || 0;
                                  cmap.set(ln.customer, e);
                                }
                                const custRows = [...cmap.values()].sort((a, b) => b.qty - a.qty);
                                return (
                                  <tr className="bg-slate-50/70">
                                    <td colSpan={3} className="px-5 py-3">
                                      <div className="overflow-x-auto">
                                        <table className="w-full text-xs">
                                          <thead><tr className="text-left text-slate-400 border-b border-slate-200">
                                            <th className="py-1.5 pr-3 font-semibold sticky left-0 bg-slate-50">Customer</th>
                                            {months.map(m => <th key={m} className="py-1.5 px-2 font-semibold text-right whitespace-nowrap">{fmtMonth(m)}</th>)}
                                            <th className="py-1.5 px-2 font-semibold text-right whitespace-nowrap">Total {it.uom || ''}</th>
                                            <th className="py-1.5 pl-2 font-semibold text-right whitespace-nowrap">Amount (₹)</th>
                                          </tr></thead>
                                          <tbody>
                                            {custRows.map((c, ci) => (
                                              <tr key={ci} className="border-b border-slate-100 last:border-b-0">
                                                <td className="py-1.5 pr-3 text-slate-700 whitespace-nowrap sticky left-0 bg-slate-50">{c.customer}</td>
                                                {months.map(m => <td key={m} className="py-1.5 px-2 text-right tabular-nums text-slate-600">{c.byMonth[m] ? fmtQty(c.byMonth[m]) : '—'}</td>)}
                                                <td className="py-1.5 px-2 text-right tabular-nums font-semibold text-slate-800">{fmtQty(c.qty)}</td>
                                                <td className="py-1.5 pl-2 text-right tabular-nums text-slate-800">{fmtINRfull(c.amount)}</td>
                                              </tr>
                                            ))}
                                          </tbody>
                                          <tfoot>
                                            <tr className="border-t border-slate-200 font-semibold text-slate-700">
                                              <td className="py-1.5 pr-3 sticky left-0 bg-slate-50">Total</td>
                                              {months.map(m => <td key={m} className="py-1.5 px-2 text-right tabular-nums">{fmtQty(custRows.reduce((s, c) => s + (c.byMonth[m] || 0), 0))}</td>)}
                                              <td className="py-1.5 px-2 text-right tabular-nums">{fmtQty(it.qty)}</td>
                                              <td className="py-1.5 pl-2 text-right tabular-nums">{fmtINRfull(custRows.reduce((s, c) => s + c.amount, 0))}</td>
                                            </tr>
                                          </tfoot>
                                        </table>
                                      </div>
                                    </td>
                                  </tr>
                                );
                              })()}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
            </>
          )}
          {!loading && !error && shownRows.length > 0 && kind === 'invoices' && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs sm:text-sm">
                <thead className="border-b">
                  <tr className="text-left text-slate-500">
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Invoice No</th>
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Date</th>
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Due Date</th>
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Customer</th>
                    {coHead}
                    <th className="py-2 font-semibold text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map(r => (
                    <tr key={r.id} onClick={() => openRecord(r.id)}
                      className="border-b last:border-b-0 hover:bg-indigo-50/50 cursor-pointer">
                      <td className="py-2 pr-2 sm:pr-3 tabular-nums">
                        <span className="font-medium text-indigo-700">{r.invoice_no || '—'}</span>
                      </td>
                      <td className="py-2 pr-2 sm:pr-3 text-slate-600 tabular-nums">{r.date || '—'}</td>
                      <td className="py-2 pr-2 sm:pr-3 text-slate-600 tabular-nums">{r.due_date || '—'}</td>
                      {custCell(r)}
                      {coCell(r)}
                      <td className="py-2 text-right font-semibold tabular-nums">{fmtINRfull(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loading && !error && shownRows.length > 0 && kind === 'outstanding_customers' && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs sm:text-sm">
                <thead className="border-b">
                  <tr className="text-left text-slate-500">
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Customer</th>
                    <th className="py-2 pr-2 sm:pr-3 font-semibold text-right">Unpaid Invoices</th>
                    <th className="py-2 pr-2 sm:pr-3 font-semibold text-right">Overdue</th>
                    <th className="py-2 font-semibold text-right">Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((r, i) => (
                    <tr key={r.id || i} className="border-b last:border-b-0 hover:bg-primary-50/40 transition-colors">
                      <td className="py-2 pr-2 sm:pr-3 text-slate-700 font-medium">{r.customer_name || '—'}</td>
                      <td className="py-2 pr-2 sm:pr-3 text-slate-600 text-right tabular-nums">{r.invoice_count}</td>
                      <td className="py-2 pr-2 sm:pr-3 text-right tabular-nums text-rose-600">
                        {Number(r.overdue) > 0 ? fmtINRfull(r.overdue) : '—'}
                      </td>
                      <td className="py-2 text-right font-semibold tabular-nums">{fmtBal(r.outstanding)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loading && !error && shownRows.length > 1 && kind === 'outstanding_invoices' && (
            <div className="flex items-center gap-2 pb-2">
              <span className="text-[11px] text-slate-500">Order by</span>
              <div className="flex rounded-lg border border-slate-300 overflow-hidden bg-white">
                {[['amount', 'Amount'], ['longest', 'Most overdue'], ['newest', 'Newest']].map(([k, l], i) => (
                  <button key={k} type="button" onClick={() => sortAged(k)}
                    className={`px-2 py-1 text-[11px] font-medium ${i > 0 ? 'border-l border-slate-300' : ''} ${agedSort === k ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}>{l}</button>
                ))}
              </div>
            </div>
          )}
          {!loading && !error && shownRows.length > 0 && kind === 'outstanding_invoices' && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs sm:text-sm">
                <thead className="border-b">
                  <tr className="text-left text-slate-500">
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Invoice No</th>
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Customer</th>
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Due</th>
                    <th className="py-2 pr-2 sm:pr-3 font-semibold text-right">Overdue</th>
                    <th className="py-2 font-semibold text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((r, i) => (
                    <tr key={r.id || i} className="border-b last:border-b-0 hover:bg-primary-50/40 transition-colors">
                      <td className="py-2 pr-2 sm:pr-3 tabular-nums">
                        <button
                          type="button"
                          onClick={() => openRecord(r.id)}
                          className="font-medium text-indigo-700 hover:text-indigo-900 hover:underline text-left"
                        >
                          {r.invoice_no || '—'}
                        </button>
                      </td>
                      {custCell(r)}
                      <td className="py-2 pr-2 sm:pr-3 text-slate-600 tabular-nums">{r.due_date || '—'}</td>
                      <td className="py-2 pr-2 sm:pr-3 text-right tabular-nums">
                        {r.days_overdue > 0
                          ? <span className="px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200">{r.days_overdue}d</span>
                          : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="py-2 text-right font-semibold tabular-nums">{fmtINRfull(r.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {/* Split the notes by what they actually are. Tally's Debit/Credit
              Note register holds trade documents; journals, TDS and bank
              charges reached this table by other import paths and are worth
              being able to set aside. Each pill carries its own money so you
              can see the size of what you are excluding before excluding it. */}
          {!loading && !error && noteKindPills && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {noteKindPills.map(p => (
                <button key={p.k} type="button" title={p.hint}
                  onClick={() => setNoteKind(p.k)}
                  aria-pressed={noteKind === p.k}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] sm:text-xs font-medium transition touch-manipulation focus:outline-none focus:ring-2 focus:ring-indigo-300 ${
                    noteKind === p.k
                      ? 'bg-slate-700 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                  <span>{p.l}</span>
                  <span className={`tabular-nums ${noteKind === p.k ? 'text-white/70' : 'text-slate-400'}`}>{p.count}</span>
                  <span className={`tabular-nums ${noteKind === p.k ? 'text-white' : 'text-slate-700'}`}>{fmtINRfull(p.amount)}</span>
                </button>
              ))}
            </div>
          )}
          {!loading && !error && shownRows.length > 0 && (kind === 'debit_notes' || kind === 'credit_notes') && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs sm:text-sm">
                <thead className="border-b">
                  <tr className="text-left text-slate-500">
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Note No</th>
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Date</th>
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Customer</th>
                    {coHead}
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Reason</th>
                    <th className="py-2 pr-2 sm:pr-3 font-semibold">Against Ref</th>
                    <th className="py-2 font-semibold text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((r, i) => {
                    // Clicking a note row opens THAT note. It used to navigate
                    // to the whole Debit & Credit Notes list pre-filtered to the
                    // type, which threw the clicked record away -- you asked for
                    // CN-0014 and got every credit note.
                    //
                    // `backTo` is the drill-down's own URL, so Back returns to
                    // this list still open and still filtered. A row with no id
                    // (nothing in the data has one today, but the API is not
                    // ours to promise) falls back to the old list behaviour
                    // rather than navigating to `/sales/debit-notes/undefined`.
                    const goToNotes = () => {
                      if (r.id) {
                        navigate(`/sales/debit-notes/${r.id}`, { state: { backTo } });
                      } else {
                        navigate(`/sales/debit-notes?type=${kind === 'debit_notes' ? 'DEBIT' : 'CREDIT'}`,
                          { state: { backTo } });
                      }
                    };
                    return (
                      <tr key={r.id || i} onClick={goToNotes}
                        className="border-b last:border-b-0 hover:bg-indigo-50/50 cursor-pointer">
                        <td className="py-2 pr-2 sm:pr-3 tabular-nums font-medium text-indigo-700 hover:text-indigo-900 hover:underline">{r.note_no || '—'}</td>
                        <td className="py-2 pr-2 sm:pr-3 text-slate-600 tabular-nums">{r.date || '—'}</td>
                        {custCell(r)}
                        {coCell(r)}
                        <td className="py-2 pr-2 sm:pr-3 text-slate-500 min-w-[140px] max-w-[260px] whitespace-normal break-words">
                          {/* Only the anomalies get a badge. Marking the trade
                              notes too would tag almost every row and stop the
                              badge meaning anything. */}
                          {r.kind && r.kind !== 'trade' && (
                            <span title={NOTE_KIND_META[r.kind]?.hint}
                              className="inline-block mr-1.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-semibold align-middle">
                              {NOTE_KIND_META[r.kind]?.l || r.kind}
                            </span>
                          )}
                          {r.reason || '—'}
                        </td>
                        <td className="py-2 pr-2 sm:pr-3 text-slate-500 tabular-nums">{r.reference || '—'}</td>
                        <td className={`py-2 text-right font-semibold tabular-nums ${kind === 'debit_notes' ? 'text-amber-700' : 'text-sky-700'}`}>{fmtINRfull(r.amount)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 font-bold">
                    <td className="py-2 pr-2 sm:pr-3 text-slate-700" colSpan={5}>Total · {shownRows.length} note{shownRows.length === 1 ? '' : 's'}</td>
                    <td className="py-2 text-right tabular-nums text-slate-800">
                      {fmtINRfull(shownRows.reduce((s, r) => s + Number(r.amount || 0), 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* Pager — the record tables above show one page at a time. Hidden
              on the pivot views, which are aggregated summaries, not records. */}
          {!loading && !error && recTotalPages > 1 && !(kind === 'dispatches' && pivot !== 'list') && (
            <div className="flex items-center justify-between gap-3 flex-wrap pt-3 mt-3 border-t border-slate-100 text-xs text-slate-500">
              <span>
                Showing {(recSafePage - 1) * REC_PAGE_SIZE + 1} to{' '}
                {Math.min(recSafePage * REC_PAGE_SIZE, baseRows.length)} of {baseRows.length}
                <span className="hidden lg:inline text-slate-400">
                  {' · '}
                  <kbd className="px-1 py-0.5 border border-slate-200 rounded bg-slate-50 font-sans text-[10px]">←</kbd>
                  {' '}
                  <kbd className="px-1 py-0.5 border border-slate-200 rounded bg-slate-50 font-sans text-[10px]">→</kbd>
                  {' to page'}
                </span>
              </span>
              <div className="flex items-center gap-1">
                <button onClick={() => setRecPage(recSafePage - 1)} disabled={recSafePage <= 1}
                  className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  aria-label="Previous page"><ChevronLeft size={15} /></button>
                {pageWindow(recSafePage, recTotalPages).map((p, idx) => (p === '…'
                  ? <span key={`e${idx}`} className="px-1.5 text-slate-400">…</span>
                  : <button key={p} onClick={() => setRecPage(p)}
                      className={`min-w-[30px] px-2 py-1 rounded-lg border text-xs font-medium transition ${p === recSafePage ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{p}</button>
                ))}
                <button onClick={() => setRecPage(recSafePage + 1)} disabled={recSafePage >= recTotalPages}
                  className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  aria-label="Next page"><ChevronRight size={15} /></button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Receivables buckets popup ────────────────────────────────────────
// One age band, opened out: the bills inside it, or — for the remainder band,
// which has no bills — the pieces it is made of.
//
// Every figure comes from /records/?type=receivables_ageing, which asks the
// SAME net_receivable_asof call that produced the card for its detail. The
// rows therefore add to the card above them; nothing is totalled here.
function AgeingBandPanel({ bandKey, companyId, warehouseId, customerId, productId,
                           period, from, to, onBack, backTo, variant = 'section',
                           grouped = false, onClose }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Which parties are open. A band can hold 168 bills; flat, that is a wall.
  // Grouped by party it is a short list of names, and the bills are one click
  // away for the one name the reader came for.
  const [open, setOpen] = useState(() => new Set());
  // An age band can hold hundreds of bills and the table drew every one, so the
  // page just kept going. 10 a page, as asked.
  const BAND_PAGE_SIZE = 10;
  const [bandPage, setBandPage] = useState(1);
  const toggle = (k) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  // A fresh band starts collapsed — reopening the previous band's parties on a
  // different band's list would be meaningless.
  // Switching band starts at its first page, not whatever page number the
  // last band happened to be on.
  useEffect(() => { setOpen(new Set()); setBandPage(1); }, [bandKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    const qp = new URLSearchParams({ type: 'receivables_ageing', band: bandKey });
    if (period !== 'all') { qp.set('period', 'custom'); qp.set('from', from); qp.set('to', to); }
    if (companyId) qp.set('company', companyId);
    if (warehouseId) qp.set('warehouse', warehouseId);
    if (customerId) qp.set('customer', customerId);
    if (productId) qp.set('product', productId);
    apiClient.get(`/api/sales/dashboard/records/?${qp.toString()}`)
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(e => { if (!cancelled) setError(e.response?.data?.detail || 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [bandKey, companyId, warehouseId, customerId, productId, period, from, to]);

  const tone = AGE_TONE[bandKey] || AGE_TONE.other;
  // Party groups, biggest first. Built from the SAME rows the flat table shows
  // — the grouping is presentation, so a group's total is its own rows added
  // up and the groups still add to the band.
  const groups = (() => {
    if (!grouped || !data?.rows?.length) return [];
    const by = new Map();
    for (const r of data.rows) {
      const k = r.customer_id || r.customer_name || '—';
      if (!by.has(k)) by.set(k, { key: k, name: r.customer_name || '(unknown)', rows: [], total: 0 });
      const g = by.get(k);
      g.rows.push(r);
      g.total += Number(r.amount) || 0;
    }
    return [...by.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  })();
  // Where a record opened from here comes back to: this page, this band, these
  // filters — not the bare dashboard.
  const here = backTo || `${window.location.pathname}${window.location.search}`;

  const exportRows = () => {
    if (!data) return;
    const rows = bandKey === 'other'
      ? (data.parts || []).flatMap(pt => (pt.rows || []).map(r => ({
          part: pt.label, doc_no: r.doc_no, date: r.date || '',
          customer: r.customer_name || '', detail: r.detail || '',
          amount: Number(r.amount || 0).toFixed(2),
        })))
      : (data.rows || []).map(r => ({
          part: '', doc_no: r.invoice_no, date: r.invoice_date || '',
          customer: r.customer_name || '', detail: r.days_label || '',
          amount: Number(r.amount || 0).toFixed(2),
        }));
    exportToExcel(rows, [
      ...(bandKey === 'other' ? [{ field: 'part', header: 'Part' }] : []),
      { field: 'doc_no', header: bandKey === 'other' ? 'Document' : 'Invoice No' },
      { field: 'date', header: 'Date' }, { field: 'customer', header: 'Customer' },
      { field: 'detail', header: bandKey === 'other' ? 'Narration' : 'Age' },
      { field: 'amount', header: 'Amount (₹)' },
    ], `outstanding-${bandKey}`);
  };

  const isModal = variant === 'modal';

  const body = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          {!isModal && (
            <button onClick={onBack}
              className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 shrink-0">
              <ChevronLeft size={14} /> All Bands
            </button>
          )}
          <span className={`w-2 h-2 rounded-full shrink-0 ${tone.dot}`} />
          <p className="text-sm font-semibold text-slate-900 truncate">{(bandKey === 'other' ? 'On Account' : data?.label) || '…'}</p>
          {isModal && data && (
            <span className="text-xs text-slate-400 truncate">
              · {data.count} bill{data.count === 1 ? '' : 's'}
              {groups.length ? ` · ${groups.length} customer${groups.length === 1 ? '' : 's'}` : ''}
              {data.as_at ? ` · as at ${fmtDate(data.as_at)}` : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {data && (
            <p className={`text-base font-bold tabular-nums ${tone.text}`}>
              {fmtAge(data.band_total)}
            </p>
          )}
          <button onClick={exportRows} disabled={!data}
            className={`${CTRL_EXPORT} disabled:opacity-50`}>
            <Download size={14} /> Excel
          </button>
          {isModal && (
            <button onClick={onClose}
              className={`${CTRL_ICON} hover:bg-slate-100 text-slate-400 hover:text-slate-600`}
              aria-label="Close"><X size={18} /></button>
          )}
        </div>
      </div>

      {loading && <p className="text-xs text-slate-400 py-4">Loading…</p>}
      {error && <p className="text-xs text-rose-600 py-4">{error}</p>}

      {/* ── The remainder band: its pieces ─────────────────────────────── */}
      {!loading && !error && data && bandKey === 'other' && (
        <div className="space-y-2">
          <p className="text-[11px] text-slate-500 leading-relaxed">
            None of this sits on a bill, so none of it has a due date to be aged by.
            The pieces below add to {fmtAge(data.band_total)}.
          </p>
          {(data.parts || []).map(pt => (
            <div key={pt.key} className="rounded-lg border border-slate-200 overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-50">
                <p className="text-xs font-semibold text-slate-700">
                  {pt.label}
                  {pt.count > 0 && <span className="font-normal text-slate-400"> · {pt.count}</span>}
                </p>
                <p className={`text-xs font-bold tabular-nums ${Number(pt.amount) < 0 ? 'text-rose-600' : 'text-slate-800'}`}>
                  {fmtAge(pt.amount)}
                </p>
              </div>
              {pt.rows?.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-white text-slate-500 border-y border-slate-100">
                      <tr>
                        <th className="text-left font-semibold px-3 py-1.5 whitespace-nowrap">Document</th>
                        <th className="text-left font-semibold px-3 py-1.5 whitespace-nowrap">Date</th>
                        <th className="text-left font-semibold px-3 py-1.5">Customer</th>
                        <th className="text-left font-semibold px-3 py-1.5">Narration</th>
                        <th className="text-right font-semibold px-3 py-1.5 whitespace-nowrap">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {pt.rows.map((r, i) => (
                        <tr key={`${r.doc_id || r.doc_no}-${i}`} className="hover:bg-primary-50/40 transition-colors">
                          <td className="px-3 py-1.5 whitespace-nowrap">
                            {r.doc_id
                              ? <button type="button" className="text-indigo-600 hover:underline"
                                  onClick={() => navigate(`/sales/debit-notes/${r.doc_id}`, { state: { backTo: here } })}>
                                  {r.doc_no}
                                </button>
                              : <span className="text-slate-700">{r.doc_no}</span>}
                          </td>
                          <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">{r.date ? fmtDate(r.date) : '—'}</td>
                          <td className="px-3 py-1.5 text-slate-700">{r.customer_name || '—'}</td>
                          <td className="px-3 py-1.5 text-slate-400">{r.detail || '—'}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-slate-800">{fmtAge(r.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Grouped by party (the popup) ───────────────────────────────── */}
      {!loading && !error && data && bandKey !== 'other' && grouped && (
        groups.length ? (
          <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
            {groups.map(g => {
              const isOpen = open.has(g.key);
              return (
                <div key={g.key}>
                  <button type="button" onClick={() => toggle(g.key)}
                    aria-expanded={isOpen}
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-slate-50">
                    <ChevronRight size={14}
                      className={`shrink-0 text-slate-400 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                    <span className="flex-1 min-w-0 text-xs font-semibold text-slate-800 truncate">{g.name}</span>
                    <span className="text-[11px] text-slate-400 shrink-0 tabular-nums">
                      {g.rows.length} bill{g.rows.length === 1 ? '' : 's'}
                    </span>
                    <span className={`text-xs font-bold tabular-nums shrink-0 w-32 text-right ${tone.text}`}>
                      {fmtAge(g.total)}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="overflow-x-auto bg-slate-50/60 border-t border-slate-100">
                      <table className="w-full text-xs">
                        <thead className="text-slate-500">
                          <tr>
                            <th className="text-left font-semibold px-3 py-1.5 whitespace-nowrap">Invoice</th>
                            <th className="text-left font-semibold px-3 py-1.5 whitespace-nowrap">SO</th>
                            <th className="text-left font-semibold px-3 py-1.5 whitespace-nowrap">Invoice date</th>
                            <th className="text-left font-semibold px-3 py-1.5 whitespace-nowrap">Due date</th>
                            <th className="text-left font-semibold px-3 py-1.5 whitespace-nowrap">Age</th>
                            <th className="text-right font-semibold px-3 py-1.5 whitespace-nowrap">Outstanding</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {g.rows.map((r, i) => (
                            <tr key={`${r.invoice_id}-${i}`} className="hover:bg-white">
                              <td className="px-3 py-1.5 whitespace-nowrap">
                                {(r.is_opening || !r.invoice_id)
                                  ? <span className="text-slate-500 italic">{r.invoice_no}</span>
                                  : <button type="button" className="text-indigo-600 hover:underline"
                                      onClick={() => navigate(`/sales/invoices/${r.invoice_id}`, { state: { backTo: here } })}>
                                      {r.invoice_no || '—'}
                                    </button>}
                              </td>
                              <td className="px-3 py-1.5 whitespace-nowrap">
                                {r.so_id
                                  ? <button type="button" className="text-indigo-600 hover:underline"
                                      onClick={() => navigate(`/sales/orders/${r.so_id}`, { state: { backTo: here } })}>
                                      {r.so_no}
                                    </button>
                                  : <span className="text-slate-400">—</span>}
                              </td>
                              <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">{r.invoice_date ? fmtDate(r.invoice_date) : '—'}</td>
                              <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">{r.due_date ? fmtDate(r.due_date) : '—'}<DueSourceBadge src={r.due_source} /></td>
                              <td className={`px-3 py-1.5 whitespace-nowrap ${tone.text}`}>{r.days_label || '—'}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums font-medium text-slate-800">{fmtAge(r.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : <p className="text-xs text-slate-400 py-4">No bills in this band.</p>
      )}

      {/* ── An age band: the bills in it ───────────────────────────────── */}
      {!loading && !error && data && bandKey !== 'other' && !grouped && (
        data.rows?.length ? (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">Invoice</th>
                  <th className="text-left font-semibold px-3 py-2">Customer</th>
                  <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">SO</th>
                  <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">Invoice date</th>
                  <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">Due date</th>
                  <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">Age</th>
                  <th className="text-right font-semibold px-3 py-2 whitespace-nowrap">Outstanding</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.rows
                  .slice((Math.min(bandPage, Math.max(1, Math.ceil(data.rows.length / BAND_PAGE_SIZE))) - 1) * BAND_PAGE_SIZE,
                         Math.min(bandPage, Math.max(1, Math.ceil(data.rows.length / BAND_PAGE_SIZE))) * BAND_PAGE_SIZE)
                  .map((r, i) => (
                  <tr key={`${r.invoice_id}-${i}`} className="hover:bg-primary-50/40 transition-colors">
                    <td className="px-3 py-2 whitespace-nowrap">
                      {/* An opening-balance carrier is a brought-forward lump
                          sum, not an invoice — there is no page to open. */}
                      {(r.is_opening || !r.invoice_id)
                        ? <span className="text-slate-500 italic">{r.invoice_no}</span>
                        : <button type="button" className="text-indigo-600 hover:underline"
                            onClick={() => navigate(`/sales/invoices/${r.invoice_id}`, { state: { backTo: here } })}>
                            {r.invoice_no || '—'}
                          </button>}
                    </td>
                    <td className="px-3 py-2 text-slate-700">{r.customer_name || '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {r.so_id
                        ? <button type="button" className="text-indigo-600 hover:underline"
                            onClick={() => navigate(`/sales/orders/${r.so_id}`, { state: { backTo: here } })}>
                            {r.so_no}
                          </button>
                        : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.invoice_date ? fmtDate(r.invoice_date) : '—'}</td>
                    <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.due_date ? fmtDate(r.due_date) : '—'}<DueSourceBadge src={r.due_source} /></td>
                    <td className={`px-3 py-2 whitespace-nowrap ${tone.text}`}>{r.days_label || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium text-slate-800">{fmtAge(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-50 border-t border-slate-200">
                <tr>
                  <td colSpan={6} className="px-3 py-2 text-right text-slate-500 font-semibold">
                    {data.count} bill{data.count === 1 ? '' : 's'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-bold text-slate-900">
                    {fmtAge(data.band_total)}
                  </td>
                </tr>
              </tfoot>
            </table>
            {/* The total in the table footer is the BAND's total, not this
                page's -- a page sum would be a number that means nothing. */}
            {data.rows.length > BAND_PAGE_SIZE && (() => {
              const totalPages = Math.max(1, Math.ceil(data.rows.length / BAND_PAGE_SIZE));
              const cp = Math.min(bandPage, totalPages);
              return (
                <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 text-xs text-slate-500">
                  <span>Showing {(cp - 1) * BAND_PAGE_SIZE + 1} to {Math.min(cp * BAND_PAGE_SIZE, data.rows.length)} of {data.rows.length}</span>
                  <div className="flex items-center gap-1">
                    <button onClick={() => setBandPage(cp - 1)} disabled={cp <= 1}
                      className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Previous page"><ChevronLeft size={15} /></button>
                    {pageWindow(cp, totalPages).map((pg, idx) => pg === '…'
                      ? <span key={`be${idx}`} className="px-1.5 text-slate-400">…</span>
                      : <button key={pg} onClick={() => setBandPage(pg)}
                          className={`min-w-[30px] px-2 py-1 rounded-lg border text-xs font-medium transition ${pg === cp ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{pg}</button>
                    )}
                    <button onClick={() => setBandPage(cp + 1)} disabled={cp >= totalPages}
                      className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Next page"><ChevronRight size={15} /></button>
                  </div>
                </div>
              );
            })()}
          </div>
        ) : <p className="text-xs text-slate-400 py-4">No bills in this band.</p>
      )}
    </>
  );

  if (!isModal) {
    return (
      <div className={variant === 'card'
        ? 'bg-white rounded-xl border border-slate-200 p-4 sm:p-5 mb-4 sm:mb-6'
        : 'px-5 py-3 border-b border-slate-100'}>
        {body}
      </div>
    );
  }
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-2 sm:p-4"
      onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[92dvh] flex flex-col"
        role="dialog" aria-modal="true" aria-label={data?.label || 'Outstanding by age'}
        onClick={e => e.stopPropagation()}>
        <div className="overflow-y-auto px-4 sm:px-5 py-4">{body}</div>
      </div>
    </div>
  );
}

// Outstanding-card drill-down: receivables split by payment terms —
// Within Payment Terms (Paid Early / Still Open) and Exceeded Payment
// Terms (Paid Late / Overdue), each ordered by days early/late/overdue,
// with per-bucket + grand totals, a customer filter, and hyperlinked
// invoice + Sales-Order references.

const SUB_STYLE = {
  paid_early:     { dot: 'bg-emerald-500', amt: 'text-emerald-700', tile: 'bg-emerald-50 text-emerald-700', hoverBorder: 'hover:border-emerald-300' },
  still_open:     { dot: 'bg-blue-500',    amt: 'text-blue-700',    tile: 'bg-blue-50 text-blue-700',       hoverBorder: 'hover:border-blue-300' },
  paid_late:      { dot: 'bg-amber-500',   amt: 'text-amber-700',   tile: 'bg-amber-50 text-amber-700',     hoverBorder: 'hover:border-amber-300' },
  overdue_unpaid: { dot: 'bg-rose-500',    amt: 'text-rose-700',    tile: 'bg-rose-50 text-rose-700',       hoverBorder: 'hover:border-rose-300' },
  // Not a payment-terms bucket at all — it is about WHO the party is, not when
  // the bill is due. Indigo keeps it visually apart from the four timing
  // buckets so nobody reads it as another stage of ageing.
  creditors_debit: { dot: 'bg-indigo-500', amt: 'text-indigo-700', tile: 'bg-indigo-50 text-indigo-700',   hoverBorder: 'hover:border-indigo-300' },
};

// Compact page-number list with ellipsis gaps (e.g. 1 … 4 5 6 … 20).
function pageWindow(cur, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const wanted = [1, 2, total - 1, total, cur - 1, cur, cur + 1].filter(p => p >= 1 && p <= total);
  const sorted = [...new Set(wanted)].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}

function BucketsModal({ companyId: companyId0, warehouseId: warehouseId0, customerId: customerId0, productId: productId0,
                         period: period0, anchor: anchor0, from: from0, to: to0,
                         companyOptions = [], warehousesRaw = [], customerOptions = [], onClose, inline = false, backTo = '/sales/dashboard',
                         band = '', onBand }) {
  const navigate = useNavigate();
  // The open sub-bucket, its page and its sort live in the URL (rb_sub /
  // rb_page / rb_sort) so that opening an invoice from the "Overdue — Unpaid"
  // list and pressing Back returns to THAT list, not the top buckets view —
  // the same reason `view` and `band` are in the URL. Only mirrored when this
  // panel is inline on the page (the modal is dismissed with its own close).
  const [bsp, setBsp] = useSearchParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [customer, setCustomer] = useState(customerId0 || '');
  const [custOptions, setCustOptions] = useState([]);
  const [expanded, setExpanded] = useState(() => (inline ? (bsp.get('rb_sub') || null) : null));
  const [bucketPage, setBucketPage] = useState(() => (inline ? Math.max(1, parseInt(bsp.get('rb_page'), 10) || 1) : 1));
  // How the open bucket's invoices are ordered.
  //
  // 'customer' is what the server sends and stays the default: every invoice
  // for the same party sits together, which is what you want before calling
  // them. But it means the Timing column reads 15, 16, 5, 3, 5, 5, 24 ... down
  // the page, so "who has been waiting longest" - the question an overdue list
  // exists to answer - could not be answered by looking. These add that
  // without taking the grouping away.
  const [bucketSort, setBucketSort] = useState(() => (inline ? (bsp.get('rb_sort') || 'customer') : 'customer'));  // customer|longest|newest
  const sortBucket = (k) => { setBucketSort(k); setBucketPage(1); };
  const openBucket = (k) => { setExpanded(k); setBucketPage(1); };
  // Company / Factory / Customer filters (seeded from the dashboard).
  const [companyId, setCompanyId] = useState(companyId0 || '');
  const [warehouseId, setWarehouseId] = useState(warehouseId0 || '');
  // Opens on ALL TIME, NOT the dashboard period. This popup drills the
  // Outstanding Receivables ageing, which is a LIVE balance (as of today,
  // labelled "live" on the KPI) — it spans every unpaid invoice regardless of
  // when it was raised. Seeding it to a Week/Month/FY window used to list only
  // invoices DATED in that window, so a band showing a live ₹X came up with
  // far fewer rows (or none) — the same live-vs-period trap fixed in the
  // customer/vendor ledgers. The period/date pickers below still let the user
  // narrow it. (period0 is still accepted but no longer seeds the window.)
  const [period, setPeriod] = useState('all');
  const [anchor, setAnchor] = useState(anchor0 || todayISO());
  const [from, setFrom] = useState(from0 || todayISO());
  const [to, setTo] = useState(to0 || todayISO());
  const eff = effWindow(period, anchor, from, to);   // resolved window when not "all time"
  const warehouseOptions = (companyId
    ? (warehousesRaw || []).filter(w => String(w.company ?? w.company_id) === String(companyId))
    : (warehousesRaw || [])
  ).map(w => ({ value: w.id, label: w.name || w.warehouse_name || w.code || w.id }));
  const onCompanyChange = (v) => { setCompanyId(v); setWarehouseId(''); };

  // Keep the drill state in the address so Back restores it. Preserves every
  // other param (view/band/period/...) by building from prev.
  useEffect(() => {
    if (!inline) return;
    setBsp((prev) => {
      const q = new URLSearchParams(prev);
      if (expanded) q.set('rb_sub', expanded); else q.delete('rb_sub');
      if (bucketPage > 1) q.set('rb_page', String(bucketPage)); else q.delete('rb_page');
      if (bucketSort && bucketSort !== 'customer') q.set('rb_sort', bucketSort); else q.delete('rb_sort');
      return q.toString() === prev.toString() ? prev : q;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, bucketPage, bucketSort, inline]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    const qp = new URLSearchParams({ type: 'receivables_buckets' });
    if (period !== 'all') {
      qp.set('period', 'custom');
      qp.set('from', eff.from);
      qp.set('to', eff.to);
    }
    if (companyId) qp.set('company', companyId);
    if (warehouseId) qp.set('warehouse', warehouseId);
    if (customer) qp.set('customer', customer);
    // Product isn't user-adjustable inside this popup (no selector for it
    // here) — inherit whatever the dashboard is currently scoped to, so this
    // total doesn't silently disagree with the KPI card it was opened from.
    if (productId0) qp.set('product', productId0);
    apiClient.get(`/api/sales/dashboard/records/?${qp.toString()}`)
      .then(r => {
        if (cancelled) return;
        setData(r.data);
        if (!customer) {  // build the customer dropdown from the full (unfiltered) set once
          const seen = new Map();
          (r.data.groups || []).forEach(g => g.sub.forEach(s => s.rows.forEach(row => {
            if (row.customer_id && !seen.has(row.customer_id)) seen.set(row.customer_id, row.customer_name);
          })));
          setCustOptions([...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)));
        }
      })
      .catch(e => { if (!cancelled) setError(e.response?.data?.detail || 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [companyId, warehouseId, customer, period, eff.from, eff.to, productId0]);


  const exportAll = () => {
    if (!data) return;
    const rows = [];
    data.groups.forEach(g => g.sub.forEach(s => s.rows.forEach(r => rows.push({
      group: g.label, bucket: s.label, invoice_no: r.invoice_no, customer: r.customer_name,
      so_no: r.so_no || '', invoice_date: r.invoice_date || '', due_date: r.due_date || '',
      status: r.days_label, amount: Number(r.amount || 0).toFixed(2),
    }))));
    const meta = buildFilterMeta({
      companyId, companyOptions, productId: productId0, customerId: customer, customerOptions,
      warehouseId, warehouseOptions,
      periodLabel: data?.period?.label || (period ? period[0].toUpperCase() + period.slice(1) : ''),
      from: eff.from, to: eff.to,
    });
    exportToExcel(rows, [
      { field: 'group', header: 'Payment Terms' }, { field: 'bucket', header: 'Bucket' },
      { field: 'invoice_no', header: 'Invoice No' }, { field: 'customer', header: 'Customer' },
      { field: 'so_no', header: 'SO No' }, { field: 'invoice_date', header: 'Invoice Date' },
      { field: 'due_date', header: 'Due Date' }, { field: 'status', header: 'Timing' },
      { field: 'amount', header: 'Amount (₹)' },
    ], `receivables-buckets-${new Date().toISOString().slice(0, 10)}`, 'Sheet1', null, meta);
    toast.success('Buckets downloaded!');
  };

  return (
    <div className={inline ? '' : 'fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-2 sm:p-4'} onClick={inline ? undefined : onClose}>
      <div className={inline
        ? 'bg-white rounded-xl border border-slate-200 shadow-sm w-full flex flex-col'
        : 'bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[92dvh] flex flex-col'} onClick={inline ? undefined : (e => e.stopPropagation())}>
        {/* Header — tile name + filters inline on one row, Excel/close right */}
        <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-slate-200 flex-wrap">
          <div className="flex items-center gap-3 min-w-0 shrink-0">
            <span className="p-2 rounded-xl bg-rose-50 text-rose-600 shrink-0"><AlertCircle size={20} /></span>
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-semibold text-slate-900 leading-tight">Outstanding Receivables</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {period === 'all' ? 'Live snapshot (all time)' : `Invoices dated ${data?.period?.from || ''} → ${data?.period?.to || ''}`}
              </p>
            </div>
          </div>
          {/* Inline filters — All time toggle + the shared period navigator */}
          <div className="flex flex-wrap items-center gap-1.5 w-full order-last min-w-0 sm:w-auto sm:flex-1 sm:order-none">
            <button type="button" onClick={() => setPeriod('all')}
              className={`${CTRL_H} shrink-0 inline-flex items-center px-2.5 rounded-lg text-xs font-medium border transition ${period === 'all' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'}`}>All Time</button>
            <PeriodNavigator period={period === 'all' ? '' : period} setPeriod={setPeriod} anchor={anchor} setAnchor={setAnchor}
              customFrom={from} customTo={to} setCustomFrom={setFrom} setCustomTo={setTo} />
            <CustomSelect value={companyId} onChange={(e) => onCompanyChange(e.target.value)}
              className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-0 max-w-[170px] ${CTRL_H}`}>
              <option value="">All Companies</option>
              {companyOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </CustomSelect>
            <CustomSelect value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}
              className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-0 max-w-[170px] ${CTRL_H}`}>
              <option value="">All Factories</option>
              {warehouseOptions.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
            </CustomSelect>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={exportAll} disabled={!data}
              className={`${CTRL_EXPORT} disabled:opacity-50`}>
              <Download size={14} /> Excel
            </button>
            <button onClick={onClose} className={`${CTRL_ICON} hover:bg-slate-100 text-slate-400 hover:text-slate-600`} aria-label="Close"><X size={18} /></button>
          </div>
        </div>
        {/* Summary strip — the All-customers filter sits inside the OUTSTANDING
            total box (this page's primary total), matching the other tiles. */}
        {data && (
          <div className="px-5 py-3 border-b border-slate-100 grid grid-cols-2 sm:grid-cols-3 gap-3">
            {/* min-w-0 on every grid item — without it, a grid cell defaults to
                min-width:auto and lets its content (here, the customer picker
                next to a long selected name) overflow OUTSIDE the cell into
                the neighbouring card instead of shrinking/truncating inside
                its own boundary, which is what was overlapping on mobile. */}
            <div className="min-w-0 rounded-xl border border-rose-200 bg-rose-50/60 px-4 py-2.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <p className="text-[10px] uppercase text-rose-600 font-semibold tracking-wide">Outstanding</p>
                <CustomSelect value={customer} onChange={(e) => setCustomer(e.target.value)}
                  className="border border-slate-300 rounded-lg px-2 py-1 text-xs bg-white min-w-0 max-w-full">
                  <option value="">All Customers</option>
                  {(customerOptions.length
                    ? customerOptions.map(c => ({ id: c.value, name: c.label }))
                    : custOptions
                  ).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </CustomSelect>
              </div>
              {/* THE SAME NUMBER AS THE OUTSTANDING TILE.
                  This box used to lead with `outstanding_total` — the gross sum
                  of the unpaid bill rows below, Rs 15,66,85,774.01 for SS
                  Biochem — while the tile that opens it reads
                  Rs 13,94,88,630.40. Two different figures under one word,
                  one click apart.
                  `reconciliation.net_asof` is the closing balance, produced by
                  the very same net_receivable_asof call the tile uses, with the
                  same filters and the same date. Nothing is recomputed here;
                  the popup simply now leads with the figure it was opened from.
                  The gross is not lost — it is the number the rows below add
                  to, so it stays, stated underneath and named for what it is. */}
              <p className="text-lg font-bold text-rose-700 tabular-nums mt-1">
                {fmtINRfull(data.reconciliation?.net_asof ?? data.outstanding_total)}
              </p>
              {data.reconciliation?.net_asof != null && (
                <p className="text-[10px] text-rose-500/80 mt-0.5 leading-snug">
                  as at {fmtDate(data.reconciliation.asof_date)}
                  {Number(data.reconciliation.net_asof) !== Number(data.outstanding_total) && (
                    <> · rows below add to {fmtINRfull(data.outstanding_total)} gross</>
                  )}
                </p>
              )}
            </div>
            <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5">
              <p className="text-[10px] uppercase text-slate-500 font-semibold tracking-wide">Total (incl. settled)</p>
              <p className="text-lg font-bold text-slate-800 tabular-nums">{fmtINRfull(data.total)}</p>
            </div>
            <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5">
              <p className="text-[10px] uppercase text-slate-500 font-semibold tracking-wide">Invoices</p>
              <p className="text-lg font-bold text-slate-800 tabular-nums">{(data.groups || []).reduce((s, g) => s + (g.count || 0), 0)}</p>
            </div>
          </div>
        )}

        {/* The same age split as the dashboard, here under the OUTSTANDING box
            it belongs to. The bands come from the drill-down's own payload and
            add back to the figure in that box exactly. Nothing above or below
            is removed — this is an extra strip. */}
        {/* A band, once opened, takes over from here down: the strips below
            describe the whole balance and would sit oddly under a list of one
            band's bills. The summary above stays, so the figure the band
            belongs to is still on screen. */}
        {band ? (
          <AgeingBandPanel
            bandKey={band}
            companyId={companyId} warehouseId={warehouseId}
            customerId={customer} productId={productId0}
            period={period} from={eff.from} to={eff.to}
            onBack={() => onBand && onBand(null)}
          />
        ) : data?.reconciliation?.ageing?.length > 0 && (
          <AgeingPanel
            variant="section"
            ageing={data.reconciliation.ageing}
            total={data.reconciliation.net_asof}
            asAt={data.reconciliation.asof_date}
            basis={data.reconciliation.ageing_basis}
            onBand={onBand}
          />
        )}

        {/* Tally Group-Summary reconciliation strip — Opening + Debit − Credit =
            Closing, for the selected period. Opening & Closing are point-in-time
            and tie to Tally's month-end. Debit = sales billed in the period;
            Credit is the implied collections that balance the row. Shown only for
            a bounded period (meaningless for an all-time snapshot). */}
        {!band && data && data.reconciliation?.has_period && (() => {
          const r = data.reconciliation;
          const fmtDate = (iso) => { try { return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }); } catch { return iso; } };
          const cards = [
            { label: 'Opening Balance', sub: `as of ${fmtDate(eff.from)}`, val: r.opening_balance, box: 'border-slate-200 bg-slate-50', txt: 'text-slate-800' },
            { label: 'Debit · sales billed', sub: 'invoices this period', val: r.period_debit, box: 'border-sky-200 bg-sky-50/60', txt: 'text-sky-700' },
            { label: 'Credit · collected', sub: 'receipts + credit notes + journals', val: r.period_credit, box: 'border-amber-200 bg-amber-50/60', txt: 'text-amber-700' },
            { label: 'Closing · Net Sundry Debtors', sub: `as at ${fmtDate(r.asof_date)} · compare with Tally's closing`, val: r.closing_balance, box: 'border-emerald-200 bg-emerald-50', txt: 'text-emerald-700' },
          ];
          return (
            <div className="px-5 py-3 border-b border-slate-100">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">
                Period reconciliation · Opening + Debit − Credit = Closing (mirrors Tally Group Summary)
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {cards.map((c, i) => (
                  <div key={i} className={`min-w-0 rounded-xl border px-4 py-2.5 ${c.box}`}>
                    <p className="text-[10px] uppercase font-semibold tracking-wide text-slate-500">{c.label}</p>
                    <p className={`text-lg font-bold tabular-nums ${c.txt}`}>{fmtINRfull(c.val)}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">{c.sub}</p>
                  </div>
                ))}
              </div>
              {/* The two things that make Closing differ from a plain sum of the
                  rows below. Both used to live in a separate "why this differs"
                  box which carried its OWN Net Sundry Debtors figure — a second
                  number, on the same screen, under the same name, Rs 2.25 crore
                  away from this one. One closing figure now, with its caveats
                  attached to it instead of competing with it. */}
              {(() => {
                const cd = (data.groups || []).find(g => g.key === 'creditors_debit');
                const adv = Number(r.credits || 0);
                if (!cd && !adv) return null;
                return (
                  <div className="mt-2 space-y-1">
                    {adv !== 0 && (
                      <p className="text-[11px] text-slate-500">
                        Closing includes <span className="font-semibold text-rose-600">{fmtINRfull(Math.abs(adv))}</span> of customer credits / advances — money paid ahead of an invoice. Tally nets these off too.
                      </p>
                    )}
                    {cd && (
                      <p className="text-[11px] text-slate-500">
                        Closing excludes <span className="font-semibold text-indigo-600">{fmtINRfull(cd.total)}</span> under <span className="font-medium text-slate-600">Creditors Debit Balance</span> — {cd.count} {cd.count === 1 ? 'party' : 'parties'} Tally files under Sundry Creditors, so its Sundry Debtors closing leaves them out as well.
                      </p>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        })()}

        {/* Body */}
        <div className="overflow-y-auto px-4 sm:px-5 py-4 space-y-4 bg-slate-50/50">
          {loading && <div className="flex items-center justify-center py-12 text-slate-500"><Loader2 className="animate-spin mr-2" size={18} /> Loading…</div>}
          {error && <p className="text-sm text-rose-600 text-center py-8">{error}</p>}
          {!band && !loading && !error && data && (() => {
            // Resolve the selected bucket (if any) across all groups.
            let selSub = null, selExceeded = false;
            for (const g of data.groups) {
              const found = (g.sub || []).find(s => s.key === expanded);
              if (found) { selSub = found; selExceeded = g.key === 'exceeded_terms'; break; }
            }

            // ── Detail "page": the selected bucket alone + its invoice table
            if (selSub) {
              const st = SUB_STYLE[selSub.key] || {};
              return (
                <div className={`bg-white rounded-xl border shadow-sm overflow-hidden ${selExceeded ? 'border-rose-300 ring-1 ring-rose-200' : 'border-emerald-300 ring-1 ring-emerald-200'}`}>
                  <div className={`flex items-center justify-between gap-3 px-4 py-3 border-b ${selExceeded ? 'bg-rose-50 border-rose-100' : 'bg-emerald-50 border-emerald-100'}`}>
                    <button type="button" onClick={() => setExpanded(null)}
                      className={`inline-flex items-center gap-1 text-sm font-medium shrink-0 ${selExceeded ? 'text-rose-800 hover:text-rose-900' : 'text-emerald-800 hover:text-emerald-900'}`}>
                      <ChevronLeft size={16} /> Back
                    </button>
                    <span className="flex items-center gap-2 min-w-0 truncate">
                      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${st.dot || 'bg-slate-400'}`} />
                      <span className="text-sm font-semibold text-slate-700 truncate">{selSub.label}</span>
                      <span className="text-[11px] font-medium text-slate-500 bg-white/70 rounded-full px-1.5 py-0.5 shrink-0">{selSub.count}</span>
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      {selSub.rows.length > 1 && (
                        <div className="flex rounded-lg border border-slate-300 overflow-hidden bg-white" title="Order these invoices by">
                          {[['customer', 'Customer'],
                            ['longest', (selSub.key === 'overdue_unpaid' || selSub.key === 'paid_late') ? 'Most overdue' : 'Longest'],
                            ['newest', 'Newest']].map(([k, l], i) => (
                              <button key={k} type="button" onClick={() => sortBucket(k)}
                                className={`px-2 py-1 text-[11px] font-medium ${i > 0 ? 'border-l border-slate-300' : ''} ${bucketSort === k ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}>{l}</button>
                            ))}
                        </div>
                      )}
                      <span className={`text-sm font-bold tabular-nums ${st.amt || 'text-slate-700'}`}>{fmtINRfull(selSub.total)}</span>
                    </div>
                  </div>
                  {(() => {
                    const PAGE_SIZE = 20;
                    // `days` means a different thing per bucket (overdue /
                    // late / early / days-to-due), but in all of them a BIGGER
                    // number is further from the due date - so one comparator
                    // serves every bucket and only the label changes.
                    const rows = bucketSort === 'customer'
                      ? selSub.rows
                      : (bucketSort === 'date_asc' || bucketSort === 'date_desc')
                        ? [...selSub.rows].sort((a, b) => {
                            const cmp = String(a.invoice_date || '').localeCompare(String(b.invoice_date || ''));
                            return bucketSort === 'date_asc' ? cmp : -cmp;
                          })
                        : [...selSub.rows].sort((a, b) => (
                          bucketSort === 'longest'
                            ? (b.days || 0) - (a.days || 0)
                            : (a.days || 0) - (b.days || 0)
                        ));
                    if (rows.length === 0) return <p className="px-4 py-4 sm:py-5 text-sm text-slate-400 text-center">No invoices in this bucket.</p>;
                    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
                    const cp = Math.min(bucketPage, totalPages);
                    const pageRows = rows.slice((cp - 1) * PAGE_SIZE, cp * PAGE_SIZE);
                    return (
                    <>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs sm:text-[13px]">
                        <thead className="sticky top-0 z-10">
                          <tr className="bg-slate-100 text-slate-500 text-[11px] uppercase tracking-wide">
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Invoice No</th>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">
                              <button type="button"
                                onClick={() => sortBucket(bucketSort === 'date_asc' ? 'date_desc' : 'date_asc')}
                                title="Sort by invoice date"
                                className="inline-flex items-center gap-1 hover:text-slate-700">
                                Inv. Date
                                {bucketSort === 'date_asc' ? <ArrowUp size={12} />
                                  : bucketSort === 'date_desc' ? <ArrowDown size={12} />
                                  : <ArrowUpDown size={12} className="opacity-40" />}
                              </button>
                            </th>
                            <th className="text-left px-3 py-2 font-semibold">Customer</th>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Due Date</th>
                            <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Timing</th>
                            <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pageRows.map((r, i) => {
                            const navigable = !r.is_opening && r.invoice_id;
                            return (
                            <tr key={(cp - 1) * PAGE_SIZE + i}
                              onClick={navigable ? () => navigate(`/sales/invoices/${r.invoice_id}`, { state: { backTo: `${window.location.pathname}${window.location.search}` } }) : undefined}
                              className={`border-t border-slate-100 odd:bg-white even:bg-slate-100/70 ${navigable ? 'hover:bg-indigo-50/50 cursor-pointer' : 'hover:bg-amber-50/60'}`}>
                              <td className="px-3 py-2 whitespace-nowrap">
                                {(r.is_opening || !r.invoice_id)
                                  ? <span className="text-slate-500">{r.invoice_no}</span>
                                  : <span className="text-blue-700 font-medium">{r.invoice_no || '—'}</span>}
                              </td>
                              <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.invoice_date ? fmtDate(r.invoice_date) : '—'}</td>
                              <td className="px-3 py-2 text-slate-700 max-w-[220px] truncate" title={r.customer_name}>{r.customer_name}</td>
                              <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.due_date ? fmtDate(r.due_date) : '—'}<DueSourceBadge src={r.due_source} /></td>
                              <td className="px-3 py-2 whitespace-nowrap">
                                {r.days_label ? <span className={`text-[11px] font-medium ${st.amt || 'text-slate-500'}`}>{r.days_label}</span> : <span className="text-slate-300">—</span>}
                              </td>
                              <td className="px-3 py-2 text-right font-semibold text-slate-800 whitespace-nowrap tabular-nums">{fmtINRfull(r.amount)}</td>
                            </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {rows.length > PAGE_SIZE && (
                      <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 text-xs text-slate-500">
                        <span>Showing {(cp - 1) * PAGE_SIZE + 1} to {Math.min(cp * PAGE_SIZE, rows.length)} of {rows.length}</span>
                        <div className="flex items-center gap-1">
                          <button onClick={() => setBucketPage(cp - 1)} disabled={cp <= 1}
                            className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Previous page"><ChevronLeft size={15} /></button>
                          {pageWindow(cp, totalPages).map((p, idx) => p === '…'
                            ? <span key={`e${idx}`} className="px-1.5 text-slate-400">…</span>
                            : <button key={p} onClick={() => setBucketPage(p)}
                                className={`min-w-[30px] px-2 py-1 rounded-lg border text-xs font-medium transition ${p === cp ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{p}</button>
                          )}
                          <button onClick={() => setBucketPage(cp + 1)} disabled={cp >= totalPages}
                            className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Next page"><ChevronRight size={15} /></button>
                        </div>
                      </div>
                    )}
                    </>
                    );
                  })()}
                </div>
              );
            }

            // ── Master: all four buckets as tiles in one row; click → detail page
            const allSubs = data.groups.flatMap(g => (g.sub || []).map(s => ({ ...s, exceeded: g.key === 'exceeded_terms' })));
            return (
              <div className="flex flex-wrap gap-2">
                {allSubs.map(s => {
                  const st = SUB_STYLE[s.key] || {};
                  const canOpen = s.rows.length > 0;
                  return (
                    <button key={s.key} type="button" onClick={() => canOpen && openBucket(s.key)} disabled={!canOpen}
                      className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border text-sm font-medium transition ${s.exceeded ? 'border-rose-200' : 'border-emerald-200'} ${canOpen ? `bg-white text-slate-700 hover:shadow-md cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-300 ${st.hoverBorder || ''}` : 'bg-slate-50 text-slate-400 cursor-default'}`}>
                      <span className={`w-2 h-2 rounded-full shrink-0 ${st.dot || 'bg-slate-400'}`} />
                      {s.label}
                    </button>
                  );
                })}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

// ── Amount Received card — tabbed: Receipts / Received. Received = everything
// crediting the customer account (receipts + credit notes + journal/contra),
// to reconcile with Tally's Sundry-Debtors Credit column; the Credit Notes
// and Journal/Contra components are still in that total and still visible
// in the drill-down popup, just not broken out as their own pill here.
function AmountReceivedCard({ data, padjData, onExpand }) {
  const b = data?.breakdown || {};
  const [tab, setTab] = useState('received');
  const [whyOpen, setWhyOpen] = useState(false);  // click-toggle (works on touch / PWA)
  const inr = (n) => '₹' + Math.abs(Math.round(n)).toLocaleString('en-IN');
  // Received-vs-Tally comes from the API (`amount_received.recon`), never from a
  // constant in this file. The ERP side is recomputed live per month, so a month
  // imported from Tally, one built from scans and one keyed in by hand all roll
  // up the same way; the Tally side is whatever `sync_tally_recon` last pulled.
  // Months that were never synced, months whose pull did not balance, and any
  // warehouse/product/customer slice are excluded by the backend rather than
  // compared against a figure that does not apply — so `rc` is simply null and
  // the card shows the live ERP number on its own.
  const recon = data?.recon || null;
  const cmp = (recon?.rows || []).filter((r) => r.tally != null && r.whole_month);
  const rc = recon?.comparable && cmp.length ? {
    erp: Number(recon.erp_total),
    tally: Number(recon.tally_total),
    diff: Number(recon.diff),
    label: cmp.length === 1 ? cmp[0].label : `${cmp[0].label}–${cmp[cmp.length - 1].label}`,
    synced: recon.synced_months,
    months: recon.total_months,
  } : null;
  const diff = rc ? rc.diff : 0;
  // Purchase Adjusted sits here rather than on a tile of its own: it is a third
  // way money comes off a customer, alongside cash and credit notes, so it
  // belongs next to them. It is NOT inside Received — no money changed hands,
  // and Tally does not carry it in the debtors credit column either.
  const padj = padjData?.amount;
  const tabs = [
    { k: 'receipts', l: 'Receipts', v: b.receipts, hint: 'Cash from customers Tally holds in Sundry Debtors' },
    ...(Number(b.non_debtors || 0) !== 0 ? [{
      k: 'non_debtors', l: 'Non-Debtors', v: b.non_debtors,
      hint: 'Cash from parties Tally files outside Sundry Debtors · real money, not in Received',
    }] : []),
    { k: 'received', l: 'Received', v: b.total ?? data?.total, hint: 'Receipts + credit notes + journal/contra' },
    ...(Number(padjData?.count || 0) > 0 ? [{
      k: 'padj', l: 'Purchase Adjusted', v: padj,
      hint: 'Sales settled against purchases from the same party · not cash',
    }] : []),
  ];
  const active = tabs.find(t => t.k === tab) || tabs[0];
  const open = () => onExpand && onExpand();
  const onKey = (e) => { if (onExpand && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } };
  return (
    <div role={onExpand ? 'button' : undefined} tabIndex={onExpand ? 0 : undefined}
      onClick={onExpand ? open : undefined} onKeyDown={onExpand ? onKey : undefined}
      className={`bg-white rounded-lg border border-slate-200 p-2.5 sm:p-3 transition ${onExpand ? 'hover:shadow-md hover:border-indigo-300 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-300' : 'hover:shadow-sm'}`}>
      <div className="flex items-center justify-between gap-2 mb-1.5 sm:mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="p-1 sm:p-1.5 rounded-lg shrink-0 bg-emerald-50 text-emerald-700"><Wallet size={14} className="sm:w-4 sm:h-4" /></div>
          <p className="text-[11px] text-slate-500 font-medium uppercase tracking-wide truncate">Amount Received</p>
          {/* Tap the (i) to see WHY Received differs from Tally for the selected
              period, with the numbers. Click-toggle (not hover) so it works on
              touch / the installed app. Right-anchored so it never clips off-screen. */}
          <span className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
            <button type="button" aria-label="Why Received differs from Tally"
              onClick={(e) => { e.stopPropagation(); setWhyOpen((v) => !v); }}
              className="text-slate-300 hover:text-slate-500 focus:outline-none">
              <Info size={13} />
            </button>
            {whyOpen && (
              <div className="absolute right-0 top-6 z-40 w-64 rounded-lg border border-slate-200
                              bg-white p-3 text-left shadow-xl normal-case tracking-normal">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[11px] font-semibold text-slate-700">Why the difference?</span>
                  <button type="button" onClick={(e) => { e.stopPropagation(); setWhyOpen(false); }}
                    className="text-slate-400 hover:text-slate-600"><X size={12} /></button>
                </div>
                {rc ? (
                  <div className="mb-2 text-[11px] tabular-nums text-slate-600">
                    <div className="flex justify-between"><span>ERP received</span><span className="font-medium text-slate-800">{inr(rc.erp)}</span></div>
                    <div className="flex justify-between"><span>Tally credit</span><span className="font-medium text-slate-800">{inr(rc.tally)}</span></div>
                    <div className="flex justify-between border-t border-slate-100 mt-1 pt-1">
                      <span>Difference</span>
                      <span className={`font-semibold ${diff < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{diff < 0 ? '−' : '+'}{inr(diff)}</span>
                    </div>
                    {/* Both sides cover only the synced whole months, so the
                        comparison is like-for-like even when part of the period
                        has never been pulled from Tally. */}
                    <div className="text-[10px] text-slate-400 mt-0.5">
                      {rc.label} · {rc.synced} of {rc.months} month{rc.months === 1 ? '' : 's'} synced
                    </div>
                  </div>
                ) : (
                  <p className="mb-2 text-[10px] text-slate-400">
                    {recon?.sliced
                      ? 'Tally’s figure is company-wide, so it isn’t compared under a factory, product or customer filter.'
                      : 'No month in this period has been synced from Tally yet — run sync_tally_recon to compare.'}
                  </p>
                )}
                <p className="text-[11px] leading-snug text-slate-500 font-normal">
                  <b>Receipts</b> (actual cash in) match Tally to the rupee. The gap is only in
                  <b> Received</b>, which also adds <b>credit notes + journal/contra</b> — non-cash
                  accounting entries Tally posts against customers, <b>not real money collected</b>.
                </p>
              </div>
            )}
          </span>
        </div>
        {onExpand && <ExternalLink size={13} className="text-slate-300 shrink-0" />}
      </div>
      <p className="text-sm sm:text-base font-bold text-slate-900 money leading-tight">{fmtINRfull(active.v)}</p>
      {/* Formula hint is desktop-only: at phone width it wraps to three lines
          and pushes the whole tile taller. The tab labels + the breakdown
          rows below already say what the figure is made of. */}
      {/* Received-vs-Tally for the period picked in the top filter (month or FY).
          Only on the Received tab and only when the period maps to a reconciled
          SS Biochem month/FY. Receipts tab is exact cash, so no diff is shown. */}
      {tab === 'received' && rc && (
        <p className="text-[11px] mt-1 tabular-nums">
          <span className="text-slate-400">Tally {inr(rc.tally)}</span>
          <span className={`ml-1 font-semibold ${diff < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
            · diff {diff < 0 ? '−' : '+'}{inr(diff)}
          </span>
          <span className="text-slate-400"> · {rc.label}</span>
        </p>
      )}
      {/* On the Purchase Adjusted tab, name the parties. There are only ever a
          handful and who they are is the point — these are customers you buy
          from, whose sale came off the next payment to them. */}
      {tab === 'padj' && (padjData?.rows || []).length > 0 && (
        <div className="mt-1 space-y-0.5">
          {(padjData.rows || []).slice(0, 4).map((r) => (
            <p key={r.id} className="text-[11px] tabular-nums flex justify-between gap-2">
              <span className="text-slate-500 truncate">{r.customer_name}</span>
              <span className="text-slate-700 font-medium shrink-0">{fmtINRfull(r.amount)}</span>
            </p>
          ))}
          {(padjData.rows || []).length > 4 && (
            <p className="text-[10px] text-slate-400">
              +{padjData.rows.length - 4} more
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-1 mt-2">
        {tabs.map(t => (
          <button key={t.k} type="button" onClick={(e) => { e.stopPropagation(); setTab(t.k); }}
            className={`px-2 py-0.5 rounded text-[11px] font-medium transition ${tab === t.k ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
            {t.l}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Amount Received drill-down popup — same filters as the dashboard top
// (period + dates, company, factory, product, customer), re-computing the
// Receipts / Credit Notes / Journal-Contra breakdown live.
function AmountReceivedModal({ period0, anchor0, from0, to0, companyId0, warehouseId0, customerId0, productId0,
                              companyOptions = [], warehousesRaw = [], customerOptions = [], onClose, inline = false, backTo = '/sales/dashboard' }) {
  const [period, setPeriod] = useState(period0 || 'month');
  const [anchor, setAnchor] = useState(anchor0 || from0 || todayISO());
  const [from, setFrom] = useState(from0 || todayISO());
  const [to, setTo] = useState(to0 || todayISO());
  const [companyId, setCompanyId] = useState(companyId0 || '');
  const [warehouseId, setWarehouseId] = useState(warehouseId0 || '');
  const [customer, setCustomer] = useState(customerId0 || '');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openLine, setOpenLine] = useState(null);  // 'receipts' | 'credit_notes' | 'journal' | null
  const [linePage, setLinePage] = useState(1);
  // Newest first on open, matching the Total Sales and Sales Orders drills.
  // This is the Amount Received breakdown -- Receipts, Non-Debtors, Credit
  // Notes, Journal/Contra. 'null' meant "however the server sent them", which
  // is grouped by customer name, so every row read the same date until you
  // scrolled past one customer's whole run -- the Receipts tab opened showing
  // 192 rows that all said 02-Oct, one customer, instead of the latest work.
  const [dateSort, setDateSort] = useState('desc');  // null (source order) | 'asc' | 'desc' — sorts the detail table by Date
  const openLineTo = (k) => { setOpenLine(k); setLinePage(1); setDateSort(null); };
  const navigate = useNavigate();
  const eff = effWindow(period, anchor, from, to);
  const warehouseOptions = (companyId
    ? (warehousesRaw || []).filter(w => String(w.company ?? w.company_id) === String(companyId))
    : (warehousesRaw || [])).map(w => ({ value: w.id, label: w.name || w.warehouse_name || w.code || w.id }));

  useEffect(() => {
    let cancelled = false; setLoading(true); setError(null);
    const qp = new URLSearchParams({ type: 'received_breakdown', period: 'custom', from: eff.from, to: eff.to });
    if (companyId) qp.set('company', companyId);
    if (warehouseId) qp.set('warehouse', warehouseId);
    if (customer) qp.set('customer', customer);
    // Product isn't user-adjustable inside this popup (no selector for it
    // here) — inherit whatever the dashboard is currently scoped to, so this
    // breakdown doesn't silently disagree with the Amount Received KPI card
    // (whose own total IS product-scoped) it was opened from.
    if (productId0) qp.set('product', productId0);
    apiClient.get(`/api/sales/dashboard/records/?${qp.toString()}`)
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(e => { if (!cancelled) setError(e.response?.data?.detail || 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [eff.from, eff.to, companyId, warehouseId, customer, productId0]);

  const lines = data ? [
    { key: 'receipts', l: 'Receipts (cash from customers)', v: data.receipts, dot: 'bg-emerald-500', rows: data.receipt_rows || [], kind: 'receipt' },
    // Money from parties Tally files OUTSIDE Sundry Debtors, so its Group
    // Vouchers -> Sundry Debtors -> Receipt report never shows them. Real cash,
    // kept on its own line so Receipts above can be compared straight against
    // that report and this against the difference. Not inside the Received
    // total. Hidden when there is none.
    ...(Number(data.non_debtors || 0) !== 0 ? [{
      key: 'non_debtors', l: 'Non-Debtors (outside Tally Sundry Debtors)',
      v: data.non_debtors, dot: 'bg-violet-500',
      rows: data.non_debtor_rows || [], kind: 'journal',
    }] : []),
    { key: 'credit_notes', l: 'Credit Notes / returns', v: data.credit_notes, dot: 'bg-blue-500', rows: data.credit_note_rows || [], kind: 'note' },
    { key: 'journal', l: 'Journal / Contra adjustments', v: data.journal_contra, dot: 'bg-amber-500', rows: data.journal_rows || [], kind: 'journal' },
  ] : [];

  // Hoisted out of the render closure below so usePagerKeys (a hook) can be
  // called unconditionally at the top level — it can't be called from inside
  // a conditionally-rendered IIFE. This is what was missing here: the ← / →
  // page shortcut works on other lists (DataTable) via this same hook, but
  // this detail view's hand-rolled pager never wired it up at all.
  const selLine = openLine ? lines.find(l => l.key === openLine) : null;
  const LINE_PAGE_SIZE = 20;
  const lineTotalPages = selLine ? Math.max(1, Math.ceil(selLine.rows.length / LINE_PAGE_SIZE)) : 1;
  usePagerKeys({
    enabled: !!selLine && lineTotalPages > 1,
    onPrev: () => setLinePage(p => Math.max(1, Math.min(p, lineTotalPages) - 1)),
    onNext: () => setLinePage(p => Math.min(lineTotalPages, p + 1)),
  });

  return (
    <div className={inline ? '' : 'fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-2 sm:p-4'} onClick={inline ? undefined : onClose}>
      <div className={inline
        ? 'bg-white rounded-xl border border-slate-200 shadow-sm w-full flex flex-col'
        : 'bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[92dvh] flex flex-col'} onClick={inline ? undefined : (e => e.stopPropagation())}>
        {/* Header — tile name + filters inline on one row */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-5 py-3 border-b flex-wrap">
          <h2 className="text-base sm:text-lg font-semibold text-slate-800 flex items-center gap-2 shrink-0">
            <Wallet size={18} className="text-emerald-600" /> Amount Received
          </h2>
          <div className="flex flex-wrap items-center gap-1.5 w-full order-last min-w-0 sm:w-auto sm:flex-1 sm:order-none">
            <PeriodNavigator period={period} setPeriod={setPeriod} anchor={anchor} setAnchor={setAnchor}
              customFrom={from} customTo={to} setCustomFrom={setFrom} setCustomTo={setTo} />
            <CustomSelect value={companyId} onChange={e => { setCompanyId(e.target.value); setWarehouseId(''); }}
              className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-0 max-w-[170px] ${CTRL_H}`}>
              <option value="">All Companies</option>
              {companyOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </CustomSelect>
            <CustomSelect value={warehouseId} onChange={e => setWarehouseId(e.target.value)}
              className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-0 max-w-[170px] ${CTRL_H}`}>
              <option value="">All Factories</option>
              {warehouseOptions.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
            </CustomSelect>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-100 text-slate-500 shrink-0" aria-label="Close"><X size={18} /></button>
        </div>
        {/* Breakdown */}
        <div className="overflow-y-auto px-4 sm:px-5 py-4">
          {loading && <div className="flex items-center justify-center py-10 text-slate-500"><Loader2 className="animate-spin mr-2" size={18} /> Loading…</div>}
          {error && <p className="text-sm text-rose-600 text-center py-8">{error}</p>}
          {!loading && !error && data && (
            <>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 mb-3 flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-[11px] uppercase text-emerald-700 font-semibold">Total credited to customers</p>
                  <p className="text-xs text-slate-500">{data.period?.label}{data.period?.from ? ` · ${data.period.from} → ${data.period.to}` : ''} · all products (receipts settle whole invoices)</p>
                </div>
                {/* Customer filter — inline in the total box. No product filter
                    here: receipts are invoice-level and can't be split per
                    product, so a product dropdown would silently do nothing. */}
                <div className="flex flex-wrap items-center gap-2">
                  <CustomSelect value={customer} onChange={e => setCustomer(e.target.value)}
                    className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-[180px] ${CTRL_H}`}>
                    <option value="">All Customers</option>
                    {customerOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </CustomSelect>
                </div>
                <p className="text-sm sm:text-base font-bold text-emerald-800 money leading-tight">{fmtINRfull(data.total)}</p>
              </div>
              {(() => {
                const sel = selLine;
                if (sel) {
                  // ── Detail "page": the selected line alone + its full table
                  return (
                    <div className="rounded-lg border border-emerald-300 ring-1 ring-emerald-200 shadow-sm overflow-hidden bg-white">
                      <div className="flex items-center justify-between gap-3 px-4 py-3 bg-emerald-50 border-b border-emerald-100">
                        <button type="button" onClick={() => setOpenLine(null)}
                          className="inline-flex items-center gap-1 text-sm font-medium text-emerald-800 hover:text-emerald-900 shrink-0">
                          <ChevronLeft size={16} /> Back
                        </button>
                        <span className="flex items-center gap-2 text-sm font-semibold text-slate-700 min-w-0 truncate">
                          <span className={`w-2 h-2 rounded-full shrink-0 ${sel.dot}`} />
                          <span className="truncate">{sel.l}</span>
                          {sel.rows.length ? <span className="text-[11px] text-slate-500 bg-white/70 rounded-full px-1.5 py-0.5 shrink-0">{sel.rows.length}</span> : null}
                        </span>
                        <span className="text-sm font-bold text-emerald-800 tabular-nums shrink-0">{fmtINRfull(sel.v)}</span>
                      </div>
                      {(() => {
                        const PAGE_SIZE = LINE_PAGE_SIZE;
                        // Optional Date sort: ISO date strings sort chronologically as-is;
                        // rows without a date sink to the bottom for either direction.
                        const rows = dateSort
                          ? [...sel.rows].sort((a, b) => {
                              const da = a.date || '', db = b.date || '';
                              if (!da || !db) return da ? -1 : db ? 1 : 0;
                              return dateSort === 'asc' ? da.localeCompare(db) : db.localeCompare(da);
                            })
                          : sel.rows;
                        if (rows.length === 0) return <p className="px-4 py-4 sm:py-5 text-sm text-slate-400 text-center bg-slate-50/40">No records in this period.</p>;
                        const totalPages = lineTotalPages;
                        const cp = Math.min(linePage, totalPages);
                        const pageRows = rows.slice((cp - 1) * PAGE_SIZE, cp * PAGE_SIZE);
                        return (
                        <>
                        <div className="overflow-x-auto bg-slate-50/40">
                          <table className="w-full text-xs sm:text-[13px]">
                            <thead className="sticky top-0 z-10 bg-slate-100 text-slate-500 text-[11px] uppercase tracking-wide">
                              <tr>
                                <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">{sel.kind === 'receipt' ? 'Invoice' : sel.kind === 'note' ? 'Note No' : 'Type'}</th>
                                <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">
                                  <button type="button" onClick={() => { setDateSort(d => d === 'asc' ? 'desc' : 'asc'); setLinePage(1); }}
                                    title="Sort by date" className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-slate-700">
                                    Date
                                    {dateSort === 'asc' ? <ArrowUp size={12} /> : dateSort === 'desc' ? <ArrowDown size={12} /> : <ArrowUpDown size={12} className="opacity-40" />}
                                  </button>
                                </th>
                                <th className="text-left px-3 py-2 font-semibold">Customer</th>
                                {sel.kind === 'note' && <th className="text-left px-3 py-2 font-semibold">Reason</th>}
                                {sel.kind === 'journal' && <th className="text-left px-3 py-2 font-semibold">Ledger</th>}
                                <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Amount</th>
                              </tr>
                            </thead>
                            <tbody>
                              {pageRows.map((r, i) => (
                                <tr key={(cp - 1) * PAGE_SIZE + i} className="border-t border-slate-100 odd:bg-white even:bg-slate-100/70 hover:bg-amber-50/60">
                                  <td className="px-3 py-2 whitespace-nowrap">
                                    {sel.kind === 'receipt'
                                      ? (r.invoice_id
                                          ? <button onClick={() => navigate(`/sales/invoices/${r.invoice_id}`, { state: { backTo } })} className="text-blue-700 hover:underline font-medium">{r.invoice_no || '—'}</button>
                                          : <span className="text-slate-500">{r.invoice_no || '—'}</span>)
                                      : (sel.kind === 'note' && r.id
                                        ? <button onClick={() => navigate(`/sales/debit-notes/${r.id}`, { state: { backTo } })} className="text-blue-700 hover:underline font-medium">{r.note_no}</button>
                                        : <span className="text-slate-700 font-medium">{sel.kind === 'note' ? r.note_no : r.type}</span>)}
                                  </td>
                                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.date ? fmtDate(r.date) : '—'}</td>
                                  <td className="px-3 py-2 text-slate-700 max-w-[220px] truncate" title={r.customer_name}>{r.customer_name || '—'}</td>
                                  {sel.kind === 'note' && <td className="px-3 py-2 text-slate-500 min-w-[140px] max-w-[240px] whitespace-normal break-words">{r.reason || '—'}</td>}
                                  {sel.kind === 'journal' && <td className="px-3 py-2 text-slate-500 min-w-[140px] max-w-[240px] whitespace-normal break-words">{r.ledger || '—'}</td>}
                                  <td className="px-3 py-2 text-right font-semibold text-slate-800 tabular-nums whitespace-nowrap">{fmtINRfull(r.amount)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {rows.length > PAGE_SIZE && (
                          <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 text-xs text-slate-500 bg-white">
                            <span>Showing {(cp - 1) * PAGE_SIZE + 1} to {Math.min(cp * PAGE_SIZE, rows.length)} of {rows.length}</span>
                            <div className="flex items-center gap-1">
                              <button onClick={() => setLinePage(cp - 1)} disabled={cp <= 1}
                                className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Previous page"><ChevronLeft size={15} /></button>
                              {pageWindow(cp, totalPages).map((p, idx) => p === '…'
                                ? <span key={`e${idx}`} className="px-1.5 text-slate-400">…</span>
                                : <button key={p} onClick={() => setLinePage(p)}
                                    className={`min-w-[30px] px-2 py-1 rounded-lg border text-xs font-medium transition ${p === cp ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{p}</button>
                              )}
                              <button onClick={() => setLinePage(cp + 1)} disabled={cp >= totalPages}
                                className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Next page"><ChevronRight size={15} /></button>
                            </div>
                          </div>
                        )}
                        </>
                        );
                      })()}
                    </div>
                  );
                }
                // ── Master: compact category buttons in one row; click → detail page
                return (
                  <div className="flex flex-wrap gap-2">
                    {lines.map((ln) => {
                      const canOpen = ln.rows.length > 0;
                      return (
                        <button key={ln.key} type="button" disabled={!canOpen}
                          onClick={() => openLineTo(ln.key)}
                          className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border text-sm font-medium transition ${canOpen ? 'bg-white text-slate-700 border-slate-200 hover:shadow-md hover:border-emerald-300 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-300' : 'bg-slate-50 text-slate-400 border-slate-100 cursor-default'}`}>
                          <span className={`w-2 h-2 rounded-full shrink-0 ${ln.dot}`} />
                          {ln.l}
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Total Sales card — tabbed: Total / Invoices / Debit Notes. Total =
// everything debiting the customer account (invoices + sales debit notes),
// to reconcile with Tally's Sundry-Debtors Debit column.
// Quantity is invoiced in several UOMs, but a band cell has room for one
// figure. Lead with the largest UOM and push the rest into the context line —
// the export formatter (every UOM, 3 decimals) is far too long for a cell.
function uomPrimary(rows) {
  const list = (rows || []).filter(b => Number(b.qty));
  if (!list.length) return '—';
  const b = list[0];
  return `${Number(b.qty).toLocaleString('en-IN', { maximumFractionDigits: 0 })} ${b.uom}`;
}

function uomRest(rows) {
  return (rows || []).filter(b => Number(b.qty)).slice(1)
    .map(b => `${Number(b.qty).toLocaleString('en-IN', { maximumFractionDigits: 0 })} ${b.uom}`)
    .join(' · ');
}

// One cell of the instrument band: label, figure, and a line of context.
//
// The rule along the top sorts the seven figures into the five things they
// actually are, so the band can be read by colour before it is read by word:
//
//   blue    what was billed          Total Sales
//   teal    what came in             Amount Received
//   indigo  what moved               Quantity Invoiced, Sales Orders
//   amber   owed or withheld         Debit Notes, TDS (194Q)
//   rose    given back               Credit Notes
//
// Every cell carries one — four of them used to fall through to a grey
// default, which read as "these three matter and the rest are filler" rather
// than as a group of its own. The rule is always paired with the label under
// it, so colour is never the only carrier of meaning.
const CELL_TONE = {
  billed: 'bg-blue-700',
  credit: 'bg-teal-600',
  moved: 'bg-indigo-500',
  due: 'bg-amber-600',
  back: 'bg-rose-500',
  neutral: 'bg-slate-300',
};

// Right-side slide-over, mirroring the Purchase analytics drawer: dim backdrop,
// a panel pinned to the right, Esc / backdrop to close, page scroll locked.
function RightDrawer({ open, onClose, title, subtitle, children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label={title}
        className="absolute right-0 top-0 h-full w-full max-w-3xl bg-slate-50 shadow-2xl flex flex-col">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200 bg-white shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-800 truncate">{title}</h2>
            {subtitle && <p className="text-[11px] text-slate-500 truncate">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 shrink-0"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">{children}</div>
      </div>
    </div>
  );
}

function MetricCell({ label, value, context, tone = 'neutral', onClick, title }) {
  const clickable = typeof onClick === 'function';
  const Tag = clickable ? 'button' : 'div';
  return (
    <Tag
      type={clickable ? 'button' : undefined}
      onClick={clickable ? onClick : undefined}
      title={title || ''}
      /* A column, not a stack: label, figure directly under it, context under
         that. Tightened to kill the dead vertical space the taller cells left —
         the label/figure/context now sit together instead of being stretched to
         a 112px floor, so the band reads compact. */
      className={`flex min-w-0 flex-col text-left px-3 py-2.5 ${clickable
        ? 'cursor-pointer transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600'
        : ''}`}>
      {/* Dot + label, matching the Purchase Analytics KPI strip (no top bar). */}
      <div className="flex items-center gap-1.5 min-w-0">
        <span aria-hidden="true" className={`w-2 h-2 rounded-full shrink-0 ${CELL_TONE[tone] || CELL_TONE.neutral}`} />
        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500 truncate">{label}</p>
      </div>
      {/* The figure carries the weight but is sized to MATCH the Purchase
          Analytics KPI strip (text-sm) so the two dashboards read the same —
          tight leading, tabular figures via .money. */}
      <p className="mt-1 text-sm font-bold tracking-tight text-slate-900 money leading-snug">{value}</p>
      {/* Context wraps rather than truncating — a cell that reads
          "42,042 KGS · 25,212 MTS · 10…" is hiding exactly the data the band
          exists to show. */}
      {context && <p className="mt-0.5 text-[10px] leading-snug text-slate-500">{context}</p>}
    </Tag>
  );
}

// Prominent headline card for the four summary figures (Total Sales, Amount
// Received, Outstanding, Sales Orders). Larger than MetricCell, with a coloured
// left accent, the amount in words beneath, a clear hover/selected state, and an
// optional footer line of supporting detail. Replaces the flat 8-tile band.
// Per-company colours, used consistently wherever SS / UAI appear (item 25).
const CO_BADGE = {
  SS: 'text-sky-700 bg-sky-50 border-sky-200',
  UAI: 'text-violet-700 bg-violet-50 border-violet-200',
};
// All tiles share one bluish-violet (indigo) chrome — dot, accent, focus ring
// and popup header — over a light indigo backdrop, with a darker indigo tile
// border. Only the figure colour stays semantic (green received, red
// outstanding) so the numbers still read at a glance.
const HEAD_CHROME = {
  dot: 'bg-indigo-500', bar: 'before:bg-indigo-500', ring: 'focus-visible:ring-indigo-300',
  tint: 'bg-white border-indigo-400', hover: 'hover:border-transparent',
  head: 'from-indigo-500 to-indigo-700',
};
const HEAD_TONE = {
  sales:       { ...HEAD_CHROME, val: 'text-slate-900' },
  received:    { ...HEAD_CHROME, val: 'text-emerald-700' },
  outstanding: { ...HEAD_CHROME, val: 'text-rose-600' },
  orders:      { ...HEAD_CHROME, val: 'text-slate-900' },
};
function HeadlineCard({ label, value, words, context, footer, tone = 'sales', onClick, title, popTitle, popRows }) {
  const clickable = typeof onClick === 'function';
  const t = HEAD_TONE[tone] || HEAD_TONE.sales;
  const Tag = clickable ? 'button' : 'div';
  const pop = (popRows || []).filter(Boolean);
  return (
    <div className="relative group min-w-0 h-full">
    <Tag
      type={clickable ? 'button' : undefined}
      onClick={clickable ? onClick : undefined}
      title={title || ''}
      className={`relative flex h-full w-full min-w-0 flex-col text-left rounded-lg border-2 ${t.tint} px-3 py-3 shadow-sm ${clickable
        ? `cursor-pointer transition hover:shadow-md ${t.hover} focus:outline-none focus-visible:ring-2 ${t.ring}`
        : ''}`}>
      <div className="flex items-center gap-1.5 min-w-0">
        <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${t.dot}`} />
        <p className="text-xs sm:text-[13px] font-semibold uppercase tracking-[0.06em] text-slate-600 truncate">{label}</p>
      </div>
      <p className={`mt-1 text-lg sm:text-xl lg:text-2xl font-bold tracking-tight money leading-tight break-words ${t.val}`}>{value}</p>
      {/* Words line always rendered so every card keeps the same rhythm. */}
      <p className="mt-0.5 text-[11px] font-medium text-slate-500 leading-tight truncate min-h-[0.9rem]">{words || ' '}</p>
      {context && <p className="mt-0.5 text-[10px] leading-snug text-slate-500">{context}</p>}
      {footer && <p className="mt-auto pt-0.5 text-[9px] leading-snug text-slate-400">{footer}</p>}
    </Tag>
      {/* Big centered popup on hover (mirrors Purchase): the headline figure in
          a coloured header, the breakdown beneath. pointer-events-none so it
          never blocks the page. */}
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

function TotalSalesCard({ data, onExpand }) {
  const open = () => onExpand && onExpand();
  const onKey = (e) => { if (onExpand && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } };
  return (
    <div role={onExpand ? 'button' : undefined} tabIndex={onExpand ? 0 : undefined}
      onClick={onExpand ? open : undefined} onKeyDown={onExpand ? onKey : undefined}
      className={`bg-white rounded-lg border border-slate-200 p-2.5 sm:p-3 transition ${onExpand ? 'hover:shadow-md hover:border-indigo-300 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-300' : 'hover:shadow-sm'}`}>
      <div className="flex items-center justify-between gap-2 mb-1.5 sm:mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="p-1 sm:p-1.5 rounded-lg shrink-0 bg-sky-50 text-sky-700"><TrendingUp size={14} className="sm:w-4 sm:h-4" /></div>
          <p className="text-[11px] text-slate-500 font-medium uppercase tracking-wide truncate">Total Sales</p>
        </div>
        {onExpand && <ExternalLink size={13} className="text-slate-300 shrink-0" />}
      </div>
      <p className="text-sm sm:text-base font-bold text-slate-900 money leading-tight">{fmtINRfull(data?.taxable)}</p>
      <p className="text-xs text-slate-500 mt-1">Ex-GST &middot; selected period</p>
    </div>
  );
}

// ── Total Sales drill-down popup — same filters as the dashboard top
// (period + dates, company, factory, product, customer), re-computing the
// Invoices / Debit Notes split live.
function TotalSalesModal({ period0, anchor0, from0, to0, companyId0, warehouseId0, productId0, customerId0,
                          companyOptions = [], warehousesRaw = [], productOptions = [], customerOptions = [], onClose, inline = false, backTo = '/sales/dashboard' }) {
  const [period, setPeriod] = useState(period0 || 'month');
  const [anchor, setAnchor] = useState(anchor0 || from0 || todayISO());
  const [from, setFrom] = useState(from0 || todayISO());
  const [to, setTo] = useState(to0 || todayISO());
  const [companyId, setCompanyId] = useState(companyId0 || '');
  const [warehouseId, setWarehouseId] = useState(warehouseId0 || '');
  const [productId, setProductId] = useState(productId0 || '');
  const [customer, setCustomer] = useState(customerId0 || '');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openLine, setOpenLine] = useState(null);  // 'invoices' | 'debit_notes' | null
  const [linePage, setLinePage] = useState(1);
  // Newest first on open. This is the Total Sales drill -- Invoices raised,
  // debit notes, cancelled. 'null' meant "however the server sent them", which
  // is grouped by customer name, so opening it showed one customer's run of
  // invoices rather than the latest work. The Date header still toggles it.
  const [dateSort, setDateSort] = useState('desc');  // null (source order) | 'asc' | 'desc'
  const openLineTo = (k) => { setOpenLine(k); setLinePage(1); setDateSort(null); };
  const navigate = useNavigate();
  const eff = effWindow(period, anchor, from, to);
  const warehouseOptions = (companyId
    ? (warehousesRaw || []).filter(w => String(w.company ?? w.company_id) === String(companyId))
    : (warehousesRaw || [])).map(w => ({ value: w.id, label: w.name || w.warehouse_name || w.code || w.id }));

  useEffect(() => {
    let cancelled = false; setLoading(true); setError(null);
    const qp = new URLSearchParams({ type: 'total_sales', period: 'custom', from: eff.from, to: eff.to });
    if (companyId) qp.set('company', companyId);
    if (warehouseId) qp.set('warehouse', warehouseId);
    if (productId) qp.set('product', productId);
    if (customer) qp.set('customer', customer);
    apiClient.get(`/api/sales/dashboard/records/?${qp.toString()}`)
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(e => { if (!cancelled) setError(e.response?.data?.detail || 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [eff.from, eff.to, companyId, warehouseId, productId, customer]);

  const lines = data ? [
    { key: 'invoices', l: 'Invoices raised', count: data.invoice_count, v: data.invoices, dot: 'bg-sky-500', rows: data.invoice_rows || [] },
    { key: 'debit_notes', l: 'Sales debit notes', count: data.debit_note_count, v: data.debit_notes, dot: 'bg-amber-500', rows: data.debit_note_rows || [] },
    // Counted in Tally's own total (matches the KPI card's "Cancelled" term)
    // — only shown when non-zero, since it's a source-data defect to chase
    // down, not an expected line item.
    ...(Number(data.cancelled) !== 0
      ? [{ key: 'cancelled', l: 'Cancelled (still counted, matches Tally)', count: data.cancelled_count, v: data.cancelled, dot: 'bg-rose-500', rows: data.cancelled_rows || [] }]
      : []),
  ] : [];

  // Hoisted out of the render closure below so usePagerKeys (a hook) can be
  // called unconditionally at the top level — same fix as AmountReceivedModal.
  const selLine = openLine ? lines.find(l => l.key === openLine) : null;
  const LINE_PAGE_SIZE = 20;
  const lineTotalPages = selLine ? Math.max(1, Math.ceil(selLine.rows.length / LINE_PAGE_SIZE)) : 1;
  usePagerKeys({
    enabled: !!selLine && lineTotalPages > 1,
    onPrev: () => setLinePage(p => Math.max(1, Math.min(p, lineTotalPages) - 1)),
    onNext: () => setLinePage(p => Math.min(lineTotalPages, p + 1)),
  });

  return (
    <div className={inline ? '' : 'fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-2 sm:p-4'} onClick={inline ? undefined : onClose}>
      <div className={inline
        ? 'bg-white rounded-xl border border-slate-200 shadow-sm w-full flex flex-col'
        : 'bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[92dvh] flex flex-col'} onClick={inline ? undefined : (e => e.stopPropagation())}>
        {/* Header — tile name + filters inline on one row */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-5 py-3 border-b flex-wrap">
          <h2 className="text-base sm:text-lg font-semibold text-slate-800 flex items-center gap-2 shrink-0">
            <TrendingUp size={18} className="text-sky-600" /> Total Sales
          </h2>
          <div className="flex flex-wrap items-center gap-1.5 w-full order-last min-w-0 sm:w-auto sm:flex-1 sm:order-none">
            <PeriodNavigator period={period} setPeriod={setPeriod} anchor={anchor} setAnchor={setAnchor}
              customFrom={from} customTo={to} setCustomFrom={setFrom} setCustomTo={setTo} />
            <CustomSelect value={companyId} onChange={e => { setCompanyId(e.target.value); setWarehouseId(''); }}
              className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-0 max-w-[170px] ${CTRL_H}`}>
              <option value="">All Companies</option>
              {companyOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </CustomSelect>
            <CustomSelect value={warehouseId} onChange={e => setWarehouseId(e.target.value)}
              className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-0 max-w-[170px] ${CTRL_H}`}>
              <option value="">All Factories</option>
              {warehouseOptions.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
            </CustomSelect>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-100 text-slate-500 shrink-0" aria-label="Close"><X size={18} /></button>
        </div>
        {/* Breakdown */}
        <div className="overflow-y-auto px-4 sm:px-5 py-4">
          {loading && <div className="flex items-center justify-center py-10 text-slate-500"><Loader2 className="animate-spin mr-2" size={18} /> Loading…</div>}
          {error && <p className="text-sm text-rose-600 text-center py-8">{error}</p>}
          {!loading && !error && data && (
            <>
              <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 mb-3 flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-[11px] uppercase text-sky-700 font-semibold">Total debited to customers</p>
                  <p className="text-xs text-slate-500">{data.period?.label}{data.period?.from ? ` · ${data.period.from} → ${data.period.to}` : ''}</p>
                </div>
                {/* Product + Customer filters — inline in the total box */}
                <div className="flex flex-wrap items-center gap-2">
                  <ProductPicker value={productId}
                    onChange={e => setProductId(e.target.value)}
                    className={`inline-flex items-center gap-1.5 border border-slate-300 rounded-lg px-2 text-xs bg-white text-slate-700 hover:bg-slate-50 min-w-[140px] max-w-[200px] ${CTRL_H}`} />
                  <CustomSelect value={customer} onChange={e => setCustomer(e.target.value)}
                    className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-[180px] ${CTRL_H}`}>
                    <option value="">All Customers</option>
                    {customerOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </CustomSelect>
                </div>
                <p className="text-sm sm:text-base font-bold text-sky-800 money leading-tight">{fmtINRfull(data.total)}</p>
              </div>
              {(() => {
                const sel = selLine;
                if (sel) {
                  // ── Detail "page": the selected line alone + its full table
                  return (
                    <div className="rounded-lg border border-sky-300 ring-1 ring-sky-200 shadow-sm overflow-hidden bg-white">
                      <div className="flex items-center justify-between gap-3 px-4 py-3 bg-sky-50 border-b border-sky-100">
                        <button type="button" onClick={() => setOpenLine(null)}
                          className="inline-flex items-center gap-1 text-sm font-medium text-sky-800 hover:text-sky-900 shrink-0">
                          <ChevronLeft size={16} /> Back
                        </button>
                        <span className="flex items-center gap-2 text-sm font-semibold text-slate-700 min-w-0 truncate">
                          <span className={`w-2 h-2 rounded-full shrink-0 ${sel.dot}`} />
                          <span className="truncate">{sel.l}</span>
                          {sel.count ? <span className="text-[11px] text-slate-500 bg-white/70 rounded-full px-1.5 py-0.5 shrink-0">{sel.count}</span> : null}
                        </span>
                        <span className="text-sm font-bold text-sky-800 tabular-nums shrink-0">{fmtINRfull(sel.v)}</span>
                      </div>
                      {(() => {
                        const PAGE_SIZE = LINE_PAGE_SIZE;
                        // Optional Date sort: ISO date strings sort chronologically as-is;
                        // rows without a date sink to the bottom for either direction.
                        const rows = dateSort
                          ? [...sel.rows].sort((a, b) => {
                              const da = a.date || '', db = b.date || '';
                              if (!da || !db) return da ? -1 : db ? 1 : 0;
                              return dateSort === 'asc' ? da.localeCompare(db) : db.localeCompare(da);
                            })
                          : sel.rows;
                        if (rows.length === 0) return <p className="px-4 py-4 sm:py-5 text-sm text-slate-400 text-center bg-slate-50/40">No records in this period.</p>;
                        const totalPages = lineTotalPages;
                        const cp = Math.min(linePage, totalPages);
                        const pageRows = rows.slice((cp - 1) * PAGE_SIZE, cp * PAGE_SIZE);
                        return (
                        <>
                        <div className="overflow-x-auto bg-slate-50/40">
                          <table className="w-full text-xs sm:text-[13px]">
                            <thead className="sticky top-0 z-10 bg-slate-100 text-slate-500 text-[11px] uppercase tracking-wide">
                              <tr>
                                <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">{sel.key === 'invoices' ? 'Invoice No' : 'Note No'}</th>
                                <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">
                                  <button type="button" onClick={() => { setDateSort(d => d === 'asc' ? 'desc' : 'asc'); setLinePage(1); }}
                                    title="Sort by date" className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-slate-700">
                                    Date
                                    {dateSort === 'asc' ? <ArrowUp size={12} /> : dateSort === 'desc' ? <ArrowDown size={12} /> : <ArrowUpDown size={12} className="opacity-40" />}
                                  </button>
                                </th>
                                <th className="text-left px-3 py-2 font-semibold">Customer</th>
                                {sel.key === 'debit_notes' && <th className="text-left px-3 py-2 font-semibold">Reason</th>}
                                <th className="text-right px-3 py-2 font-semibold whitespace-nowrap">Amount</th>
                              </tr>
                            </thead>
                            <tbody>
                              {pageRows.map((r, i) => (
                                <tr key={(cp - 1) * PAGE_SIZE + i} className="border-t border-slate-100 odd:bg-white even:bg-slate-100/70 hover:bg-amber-50/60">
                                  <td className="px-3 py-2 whitespace-nowrap">
                                    {sel.key === 'invoices'
                                      ? <button onClick={() => navigate(`/sales/invoices/${r.id}`, { state: { backTo } })} className="text-blue-700 hover:underline font-medium">{r.invoice_no}</button>
                                      : (r.id
                                        ? <button onClick={() => navigate(`/sales/debit-notes/${r.id}`, { state: { backTo } })} className="text-blue-700 hover:underline font-medium">{r.note_no}</button>
                                        : <span className="text-slate-700 font-medium">{r.note_no}</span>)}
                                  </td>
                                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.date ? fmtDate(r.date) : '—'}</td>
                                  <td className="px-3 py-2 text-slate-700 max-w-[240px] truncate" title={r.customer_name}>{r.customer_name || '—'}</td>
                                  {sel.key === 'debit_notes' && <td className="px-3 py-2 text-slate-500 min-w-[140px] max-w-[240px] whitespace-normal break-words">{r.reason || '—'}</td>}
                                  <td className="px-3 py-2 text-right font-semibold text-slate-800 tabular-nums whitespace-nowrap">{fmtINRfull(r.amount)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {rows.length > PAGE_SIZE && (
                          <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 text-xs text-slate-500 bg-white">
                            <span>Showing {(cp - 1) * PAGE_SIZE + 1} to {Math.min(cp * PAGE_SIZE, rows.length)} of {rows.length}</span>
                            <div className="flex items-center gap-1">
                              <button onClick={() => setLinePage(cp - 1)} disabled={cp <= 1}
                                className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Previous page"><ChevronLeft size={15} /></button>
                              {pageWindow(cp, totalPages).map((p, idx) => p === '…'
                                ? <span key={`e${idx}`} className="px-1.5 text-slate-400">…</span>
                                : <button key={p} onClick={() => setLinePage(p)}
                                    className={`min-w-[30px] px-2 py-1 rounded-lg border text-xs font-medium transition ${p === cp ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{p}</button>
                              )}
                              <button onClick={() => setLinePage(cp + 1)} disabled={cp >= totalPages}
                                className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Next page"><ChevronRight size={15} /></button>
                            </div>
                          </div>
                        )}
                        </>
                        );
                      })()}
                    </div>
                  );
                }
                // ── Master: compact category buttons in one row; click → detail page
                return (
                  <div className="flex flex-wrap gap-2">
                    {lines.map((ln) => {
                      const canOpen = ln.rows.length > 0;
                      return (
                        <button key={ln.key} type="button" disabled={!canOpen}
                          onClick={() => openLineTo(ln.key)}
                          className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border text-sm font-medium transition ${canOpen ? 'bg-white text-slate-700 border-slate-200 hover:shadow-md hover:border-sky-300 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-300' : 'bg-slate-50 text-slate-400 border-slate-100 cursor-default'}`}>
                          <span className={`w-2 h-2 rounded-full shrink-0 ${ln.dot}`} />
                          {ln.l}
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
              <p className="text-[11px] text-slate-400 mt-3">
                Matches Tally's Sundry-Debtors <strong>Debit</strong> column. Invoices are the true sales basis;
                debit notes are freight / other charges billed on top.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Quantity Invoiced card — each UOM's quantity shown prominently, for
// every UOM present (LTR / KG / MTS / PCS / any newly-added unit), since
// mixing units into one total would be misleading.
//
// Sourced from the INVOICE lines, i.e. the same documents behind Total Sales.
// It used to read dispatch challans, which can only under-count here: a
// Tally-imported invoice that never got a DC contributed revenue with no
// quantity. Clickable → dispatch drill-down (still the useful row-level view).
function QuantityInvoicedCard({ data, onExpand }) {
  const uoms = data?.uom_breakdown || [];
  const clickable = typeof onExpand === 'function';
  return (
    <div
      className={`bg-white rounded-lg border border-slate-200 p-3 sm:p-4 hover:shadow-sm transition ${clickable ? 'cursor-pointer hover:border-slate-300' : ''}`}
      onClick={clickable ? onExpand : undefined} role={clickable ? 'button' : undefined}>
      <div className="flex items-center justify-between gap-2 mb-1.5 sm:mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="p-1 sm:p-1.5 rounded-lg shrink-0 bg-amber-50 text-amber-700"><Truck size={14} className="sm:w-4 sm:h-4" /></div>
          <p className="text-[11px] text-slate-500 font-medium uppercase tracking-wide truncate">Quantity Invoiced</p>
        </div>
        {clickable && <ExternalLink size={12} className="text-slate-300" />}
      </div>
      {uoms.length === 0 ? (
        <>
          <p className="text-sm sm:text-base font-bold text-slate-900 money leading-tight">—</p>
          {/* Say WHY it's blank — a bare dash reads as a failure. */}
          <p className="text-xs text-slate-500 mt-1.5">No quantified lines on this period&apos;s invoices</p>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 mt-1">
            {uoms.map((b, i) => (
              <div key={i} className="min-w-0">
                <p className="text-sm sm:text-base font-bold text-slate-900 money leading-tight" title={`${b.qty} ${b.uom}`}>{fmtQty(b.qty)}</p>
                <p className="text-xs sm:text-sm font-bold text-amber-700 uppercase tracking-wide">{b.uom}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-1.5">across {data?.invoice_count || 0} invoice(s)</p>
        </>
      )}
    </div>
  );
}

// ── Customer transactions popup — full Tally-style running ledger for one
// customer (opening balance + every invoice / receipt / debit note / credit
// note in date order with a running balance). Opened by clicking a row in the
// Customer-details table; shown inline as an in-dashboard page.
function CustomerLedgerModal({ customerId, customerName, period0, anchor0, from0, to0, onClose, inline = false, drawer = false, showBack = false, backTo = '/sales/dashboard', onResolvedName, settledPct }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  // Seeded from the dashboard's own period, so this opens showing the same
  // window the Customer Details row was just filtered to — "All Time" is
  // still one click away for the full Tally-reconciling history.
  // The period lives in the URL as well as in state, so leaving this statement
  // for a receipt or an invoice and coming back restores the SAME window.
  // Without it the statement remounted on its own default and a customer whose
  // transactions were all in April came back reading "No transactions".
  const [lsp] = useSearchParams();
  const [period, setPeriod] = useState(lsp.get('lper') || period0 || 'all');
  const [anchor, setAnchor] = useState(lsp.get('lanchor') || anchor0 || todayISO());
  const [from, setFrom] = useState(lsp.get('lfrom') || from0 || todayISO());
  const [to, setTo] = useState(lsp.get('lto') || to0 || todayISO());
  const eff = effWindow(period, anchor, from, to);
  // Where a row sends you back to: this page, this customer, this period.
  const backHere = () => {
    const p = new URLSearchParams(window.location.search);
    p.set('lper', period);
    if (period === 'custom') { p.set('lfrom', from); p.set('lto', to); }
    else { p.set('lanchor', anchor); p.delete('lfrom'); p.delete('lto'); }
    // The search box too — coming back to an unfiltered list after typing to
    // find one voucher means finding it again.
    if (q) p.set('lq', q); else p.delete('lq');
    return `${window.location.pathname}?${p.toString()}`;
  };

  useEffect(() => {
    if (!drawer) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // The dashboard behind is a long page; without this a wheel over the scrim
    // scrolls it away under the drawer, so closing lands you somewhere else.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [drawer, onClose]);

  useEffect(() => {
    if (!customerId) return;
    let cancelled = false; setLoading(true); setError(null); setPage(1);
    const qp = new URLSearchParams({ customer: customerId });
    if (period !== 'all') { qp.set('from', eff.from); qp.set('to', eff.to); }
    apiClient.get(`/api/sales/receivables/customer-ledger/?${qp.toString()}`)
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(e => { if (!cancelled) setError(e.response?.data?.detail || 'Failed to load customer transactions.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [customerId, period, eff.from, eff.to]);

  // Collected % must track the period the DRAWER is showing, not the one the
  // Analytics row was filtered to. The `settledPct` prop is a frozen snapshot
  // from the parent's period, so switching FY → Month here left it reading the
  // old figure. Recompute from the drawer's own period-scoped balances using
  // the same formula the backend uses: credit ÷ (opening + debit). The prop is
  // kept only as the pre-load fallback and as the creditor gate — when the
  // parent passes `undefined` (a buy-and-sell party, where collection % is
  // meaningless) we stay hidden.
  const settledLive = useMemo(() => {
    if (!Number.isFinite(settledPct)) return undefined;   // creditor / N-A → hidden
    if (!data) return settledPct;                          // before this period's data arrives
    const opn = Number(data.opening_balance) || 0;
    const debit = Number(data.current_debit) || 0;
    const credit = Number(data.current_credit) || 0;
    const base = opn + debit;                              // collectible = opening + period sales
    if (!(base > 0)) return undefined;
    return Math.min(100, Math.max(0, Math.round((credit / base) * 100)));
  }, [settledPct, data]);

  // The four headline tiles (Total Sales / Amount Received / Qty Invoiced /
  // Outstanding) were REMOVED on the user's instruction 30-Oct-2026: on a single
  // customer's statement they restate what the ledger below already shows, and
  // the Opening / Total Debit / Total Credit / Closing row underneath is the
  // Tally-style summary that actually belongs here. Their `/api/sales/dashboard/`
  // fetch went with them, so opening a customer no longer costs a second request.
  const bal = (v) => { const n = Number(v) || 0; return `${fmtINRfull(Math.abs(n))} ${n < 0 ? 'Cr' : 'Dr'}`; };
  const typeCls = (t) => ({
    'Invoice': 'bg-sky-50 text-sky-700', 'Receipt': 'bg-emerald-50 text-emerald-700',
    'Debit Note': 'bg-amber-50 text-amber-700', 'Credit Note': 'bg-blue-50 text-blue-700',
    // A buyer withholding 194Q when paying, and any other book adjustment —
    // credits to the customer that are not cash and are not a receipt.
    'TDS': 'bg-violet-50 text-violet-700', 'Journal': 'bg-slate-100 text-slate-600',
    // The other side of a buy-and-sell party. Indigo, matching the Creditors
    // Debit Balance bucket, so it is obvious at a glance that these rows come
    // from the purchase module rather than from the sale.
    'Purchase': 'bg-indigo-50 text-indigo-700', 'Payment': 'bg-indigo-50 text-indigo-700',
    'Purchase Adjusted': 'bg-indigo-50 text-indigo-700',
  }[t] || 'bg-slate-100 text-slate-600');

  // Free-text search over every visible column. A customer ledger runs to
  // hundreds of rows and paginates at 20, so finding one voucher meant paging
  // through by eye. Amounts are matched on the RAW number (47202) as well as
  // the formatted text, so typing what you see on screen (47,202.00) or what
  // you have on paper both work.
  const [q, setQ] = useState(lsp.get('lq') || '');
  const [typeFilter, setTypeFilter] = useState('');   // '' = all types
  const [flagFilter, setFlagFilter] = useState('');   // '' | 'outstanding' | 'overdue'
  const [barIn, setBarIn] = useState(false);          // Settled bar grow-in animation
  // Grow-in from 0 only on first open (new customer). Changing the period keeps
  // the bar mounted, so the CSS transition animates old% -> new% directly —
  // without this guard it collapsed to 0 and regrew on every period switch.
  useEffect(() => { setBarIn(false); const t = setTimeout(() => setBarIn(true), 90); return () => clearTimeout(t); }, [customerId]);
  const allRows = data?.rows || [];
  const ledgerTypes = [...new Set(allRows.map(r => r.type).filter(Boolean))];
  const hasOutstanding = allRows.some(r => Number(r.outstanding) > 0);
  const nq = q.trim().toLowerCase().replace(/[,\s₹]/g, '');
  const rows = allRows.filter(r => {
    if (typeFilter && r.type !== typeFilter) return false;
    if (flagFilter === 'outstanding' && !(Number(r.outstanding) > 0)) return false;
    if (flagFilter === 'overdue' && !(Number(r.outstanding) > 0 && overdueDaysOf(r.due_date) > 0)) return false;
    if (!nq) return true;
    const nums = [r.debit, r.credit, r.tds, r.balance]
      .map(v => String(Number(v || 0))).join(' ');
    return `${r.date || ''} ${r.type || ''} ${r.doc_no || ''} ${nums}`
      .toLowerCase().replace(/[,\s₹]/g, '').includes(nq);
  });
  // No pagination in the ledger — show every row in one scroll, like a Tally
  // statement (user ask). The table body scrolls; the running balance stays
  // continuous instead of resetting per page.
  const PAGE_SIZE = Math.max(1, rows.length);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const cp = Math.min(page, totalPages);
  const pageRows = rows.slice((cp - 1) * PAGE_SIZE, cp * PAGE_SIZE);

  // The name in the URL is a SNAPSHOT from whenever the link was made, and a
  // master can be renamed under it -- "Green City Biotech - Coimbatore" became
  // "Green City Biotech- Rajapalayam" on 10-Sep-2026 and the chip went on
  // showing the old town while the heading right below it showed the new one.
  // The record is the truth; report it up so the chip and the URL follow.
  useEffect(() => {
    const live = data?.customer_name;
    if (live && onResolvedName) onResolvedName(live);
  }, [data?.customer_name, onResolvedName]);

  const exportAll = () => {
    if (!rows.length) return;
    const meta = buildFilterMeta({
      customerId, customerOptions: [{ value: customerId, label: data?.customer_name || customerName }],
      periodLabel: data?.period?.label || (period ? period[0].toUpperCase() + period.slice(1) : ''),
      from: eff.from, to: eff.to,
    });
    exportToExcel(rows.map(r => ({
      date: r.date, type: r.type, doc_no: r.doc_no,
      debit: Number(r.debit || 0).toFixed(2), credit: Number(r.credit || 0).toFixed(2),
      tds: Number(r.tds || 0).toFixed(2), balance: Number(r.balance || 0).toFixed(2),
    })), [
      { field: 'date', header: 'Date' }, { field: 'type', header: 'Type' },
      { field: 'doc_no', header: 'Doc No' }, { field: 'debit', header: 'Debit (₹)' },
      { field: 'credit', header: 'Credit (₹)' }, { field: 'balance', header: 'Balance (₹)' },
      { field: 'tds', header: 'TDS (₹)' },
    ], `customer-ledger-${(data?.customer_name || customerName || 'customer').replace(/[^\w-]+/g, '_')}`, 'Sheet1', null, meta);
  };

  const body = (
      <div className={drawer
        ? 'flex h-full min-h-0 flex-col bg-white'
        : inline
          ? 'bg-white rounded-xl border border-slate-200 shadow-sm w-full flex flex-col'
          : 'bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[92dvh] flex flex-col'} onClick={(inline || drawer) ? undefined : (e => e.stopPropagation())}>
        {/* Header — tile name + period filter inline, Excel/close on the right */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-5 py-3 border-b flex-wrap">
          <div className="flex items-center gap-2 min-w-0 shrink-0">
            {/* Back button. onClose is URL-driven, so Back restores the
                Analytics page with its filters intact. */}
            {(drawer || showBack) && (
              <button type="button" onClick={onClose} aria-label="Back" title="Back"
                className="inline-flex items-center justify-center p-1.5 rounded-lg text-slate-700 bg-slate-100 hover:bg-slate-200 shrink-0">
                <ChevronLeft size={18} />
              </button>
            )}
            <Users size={18} className="text-indigo-600 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-semibold text-slate-800 truncate flex items-center gap-2">
                <span className="truncate">{data?.customer_name || customerName || 'Customer'}</span>
                {/* Company identifier inside the statement too (item 9). */}
                {data?.company_short && (
                  <span className={`shrink-0 text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 border ${CO_BADGE[data.company_short] || 'text-slate-500 bg-slate-50 border-slate-200'}`}>
                    {data.company_short}
                  </span>
                )}
              </h2>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 w-full order-last sm:w-auto sm:order-none">
            <button type="button" onClick={() => setPeriod('all')}
              className={`${CTRL_H} shrink-0 inline-flex items-center px-2.5 rounded-lg text-xs font-medium border transition ${period === 'all' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'}`}>All Time</button>
            <PeriodNavigator period={period === 'all' ? '' : period} setPeriod={setPeriod} anchor={anchor} setAnchor={setAnchor}
              customFrom={from} customTo={to} setCustomFrom={setFrom} setCustomTo={setTo} />
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-auto">
            {/* Settled — small animated progress bar at the right end before Excel. */}
            {Number.isFinite(settledLive) && (
              <span className="hidden sm:flex items-center gap-1.5 whitespace-nowrap" title={`Collected ${settledLive}%`}>
                <span className="text-[11px] font-medium text-slate-500">Collected</span>
                <span className="h-1.5 w-16 rounded-full bg-slate-100 overflow-hidden">
                  <span className="block h-full rounded-full bg-emerald-500 transition-all duration-700 ease-out"
                    style={{ width: `${barIn ? settledLive : 0}%` }} />
                </span>
                <span className={`text-[11px] font-bold tabular-nums ${settledLive >= 100 ? 'text-emerald-600' : 'text-slate-700'}`}>{settledLive}%</span>
              </span>
            )}
            <button onClick={exportAll} disabled={!rows.length}
              className={`${CTRL_EXPORT} disabled:opacity-50`}>
              <Download size={14} /> <span className="hidden sm:inline">Excel</span>
            </button>
            <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-100 text-slate-500" aria-label="Close"><X size={18} /></button>
          </div>
        </div>

        <div className={`overflow-y-auto px-4 sm:px-5 py-4 ${drawer ? 'flex-1 min-h-0' : ''}`}>
          {loading && <div className="flex items-center justify-center py-10 text-slate-500"><Loader2 className="animate-spin mr-2" size={18} /> Loading transactions…</div>}
          {error && <p className="text-sm text-rose-600 text-center py-8">{error}</p>}
          {!loading && !error && data && (
            <>
              {/* Ledger balances — opening / movement / closing (Tally view).
                  Indigo backdrop behind the tiles; the tiles themselves stay
                  light so they read against it. */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-4 bg-indigo-50 border border-indigo-200 rounded-xl p-2.5">
                <div className="rounded-lg border border-slate-300 bg-white p-2.5">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500 font-medium block leading-tight min-h-[2.4em]">Opening Balance</p>
                  <p className="text-base sm:text-lg font-bold text-slate-800 tabular-nums mt-0.5 leading-tight whitespace-nowrap">{bal(data.opening_balance)}</p>
                </div>
                <div className="rounded-lg border border-slate-300 bg-white p-2.5">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500 font-medium block leading-tight min-h-[2.4em]">Total Debit</p>
                  <p className="text-base sm:text-lg font-bold text-slate-800 tabular-nums mt-0.5 leading-tight whitespace-nowrap">{fmtINRfull(data.current_debit)}</p>
                </div>
                <div className="rounded-lg border border-slate-300 bg-white p-2.5">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500 font-medium block leading-tight min-h-[2.4em]">Total Credit</p>
                  <p className="text-base sm:text-lg font-bold text-emerald-700 tabular-nums mt-0.5 leading-tight whitespace-nowrap">{fmtINRfull(data.current_credit)}</p>
                </div>
                <div className="rounded-lg border border-slate-300 bg-white p-2.5">
                  <p className="text-[10px] uppercase tracking-wide text-slate-500 font-medium block leading-tight min-h-[2.4em]">Closing Balance</p>
                  {(() => {
                    // A credit closing (Cr) means the customer is in ADVANCE, not a
                    // receivable — flag it green with an "Adv" chip so the tile
                    // isn't read as money owed. A debit (Dr) is a normal receivable.
                    const adv = Number(data.closing_balance) < -0.5;
                    return (
                      <p className={`text-base sm:text-lg font-bold tabular-nums mt-0.5 leading-tight whitespace-nowrap inline-flex items-center gap-1.5 ${adv ? 'text-emerald-600' : 'text-slate-800'}`}>
                        {adv && <span className="rounded bg-emerald-50 border border-emerald-200 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide">Adv</span>}
                        {bal(data.closing_balance)}
                      </p>
                    );
                  })()}
                </div>
              </div>

              {/* Search — sits directly above the table so it reads as part of
                  it. Shows a live match count and a clear button, and reports
                  the filtered total separately so the running Balance column is
                  never mistaken for a total of what is on screen. */}
              {allRows.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <div className="relative flex-1 min-w-[220px]">
                    <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                    <input
                      type="text" value={q}
                      onChange={(e) => { setQ(e.target.value); setPage(1); }}
                      placeholder="Search date, type, doc no or amount…"
                      aria-label="Search transactions"
                      className="w-full pl-9 pr-8 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-300"
                    />
                    {q && (
                      <button type="button" onClick={() => { setQ(''); setPage(1); }}
                        aria-label="Clear search"
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100">
                        <X size={14} />
                      </button>
                    )}
                  </div>
                  {/* Type filter chips (parity with the purchase vendor ledger). */}
                  {ledgerTypes.length > 1 && (
                    <div className="flex gap-0.5 bg-slate-100 border border-slate-200 rounded-md p-0.5 flex-wrap shrink-0">
                      {[['', 'All'], ...ledgerTypes.map((t) => [t, t])].map(([k, l]) => (
                        <button key={k || 'all'} type="button" onClick={() => { setTypeFilter(k); setPage(1); }}
                          className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${typeFilter === k ? 'bg-white text-primary-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                          {l}
                        </button>
                      ))}
                    </div>
                  )}
                  {/* Outstanding / Overdue — invoices still carrying a balance / past due. */}
                  {hasOutstanding && (
                    <div className="flex gap-0.5 bg-slate-100 border border-slate-200 rounded-md p-0.5 flex-wrap shrink-0">
                      {[['', 'All Bills'], ['outstanding', 'Outstanding'], ['overdue', 'Overdue']].map(([k, l]) => (
                        // Outstanding / Overdue are LIVE (all-time) balances — the
                        // same figure the Customer Details row shows. The ledger,
                        // though, folds every pre-window invoice into Opening and
                        // returns only rows inside the selected period, so on a
                        // Week/Month view those unpaid invoices aren't listed and
                        // the filter came up empty. Switch to All Time so the full
                        // set of unpaid/overdue invoices loads and the filter
                        // matches the live figure.
                        <button key={k || 'allflag'} type="button"
                          onClick={() => { setFlagFilter(k); setPage(1); if ((k === 'outstanding' || k === 'overdue') && period !== 'all') setPeriod('all'); }}
                          className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${flagFilter === k
                            ? (k === 'overdue' ? 'bg-white text-rose-600 shadow-sm' : k === 'outstanding' ? 'bg-white text-amber-600 shadow-sm' : 'bg-white text-slate-700 shadow-sm')
                            : 'text-slate-500 hover:text-slate-700'}`}>
                          {l}
                        </button>
                      ))}
                    </div>
                  )}
                  <span className="text-xs text-slate-500 tabular-nums shrink-0">
                    {nq
                      ? <><span className="font-semibold text-slate-700">{rows.length}</span> of {allRows.length} rows</>
                      : <>{allRows.length} rows</>}
                  </span>
                </div>
              )}

              {rows.length === 0
                ? <p className="text-sm text-slate-400 text-center py-8">
                    {nq ? `No transactions match “${q}”.`
                      : flagFilter === 'overdue'
                        ? 'No itemised overdue invoices to list. Any overdue amount sits in the opening balance — pre-ERP invoices imported from Tally as a single opening figure, which carries no line items.'
                      : flagFilter === 'outstanding'
                        ? 'No itemised outstanding invoices to list. Any balance sits in the opening balance — pre-ERP invoices imported from Tally as a single opening figure, which carries no line items.'
                      : 'No transactions for this customer.'}
                  </p>
                : (
                <div className="rounded-lg border border-slate-200 overflow-hidden">
                  <div className="overflow-auto max-h-[calc(100vh-16rem)]">
                    <table className="w-full text-xs sm:text-[13px]">
                      <thead className="bg-slate-100 text-slate-500 text-[11px] uppercase tracking-wide sticky top-0 z-10 shadow-[0_1px_0_0_rgb(226_232_240)]">
                        <tr>
                          <th className="text-left px-3 py-2 font-semibold whitespace-nowrap bg-slate-100">Date</th>
                          <th className="text-left px-3 py-2 font-semibold whitespace-nowrap bg-slate-100">Type</th>
                          <th className="text-left px-3 py-2 font-semibold bg-slate-100">Doc No</th>
                          <th className="text-right px-3 py-2 font-semibold whitespace-nowrap bg-slate-100">Debit</th>
                          <th className="text-right px-3 py-2 font-semibold whitespace-nowrap bg-slate-100">Credit</th>
                          <th className="text-right px-3 py-2 font-semibold whitespace-nowrap bg-slate-100">Balance</th>
                          <th className="text-right px-3 py-2 font-semibold whitespace-nowrap bg-slate-100">TDS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map((r, i) => (
                          <tr key={(cp - 1) * PAGE_SIZE + i} className="border-t border-slate-100 odd:bg-white even:bg-slate-100/70 hover:bg-amber-50/50">
                            <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.date ? fmtDate(r.date) : '—'}</td>
                            <td className="px-3 py-2 whitespace-nowrap"><span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${typeCls(r.type)}`}>{r.type}</span></td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              {r.type === 'Invoice' && r.ref_id
                                ? <span className="inline-flex items-center gap-1.5">
                                    <button onClick={() => navigate(`/sales/invoices/${r.ref_id}`, { state: { backTo: backHere() } })} className="text-blue-700 hover:underline font-medium">{r.doc_no || '—'}</button>
                                    {/* Per-invoice outstanding/overdue so the reader can tell
                                        which bill is still unpaid or late (user ask). */}
                                    {Number(r.outstanding) > 0 && (() => {
                                      const od = overdueDaysOf(r.due_date);
                                      return (
                                        <span className={`shrink-0 text-[9px] font-semibold rounded px-1 py-0.5 border ${od > 0 ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}
                                          title={`${fmtINRfull(r.outstanding)} still due${od > 0 ? ` · ${od} day${od > 1 ? 's' : ''} overdue` : ''}`}>
                                          {fmtINR(r.outstanding)} due{od > 0 ? ` · ${od}d` : ''}
                                        </span>
                                      );
                                    })()}
                                  </span>
                                /* Purchase side of a party we both sell to and
                                   buy from. Tally shows one ledger with both
                                   halves; the ERP keeps two modules, so these
                                   rows come from Vendor Bills and Payments Made
                                   and have to open there. */
                                : r.ref_kind === 'vendor_bill' && r.ref_id
                                  ? <button onClick={() => navigate(`/purchase/bills/${r.ref_id}`, { state: { backTo: backHere() } })} className="text-violet-700 hover:underline font-medium">{r.doc_no || 'Bill'}</button>
                                : r.ref_kind === 'payment_made' && r.ref_id
                                  ? <button onClick={() => navigate(`/purchase/payments-made/${r.ref_id}`, { state: { backTo: backHere() } })} className="text-violet-700 hover:underline font-medium">{r.doc_no || 'Payment'}</button>
                                /* Credit and Debit notes are both DebitNote rows
                                   (note_type tells them apart), so both open the
                                   same detail route. */
                                : r.ref_kind === 'note' && r.ref_id
                                  ? <button onClick={() => navigate(`/sales/debit-notes/${r.ref_id}`, { state: { backTo: backHere() } })}
                                      className="text-rose-700 hover:underline font-medium">{r.doc_no || 'Note'}</button>
                                : r.ref_kind === 'receipt' && r.ref_id
                                  /* One row per Tally receipt. Opens the receipt page
                                     inside Receivables, which breaks it back down into
                                     the invoices it settled. */
                                  ? <button
                                      onClick={() => navigate(
                                        `/sales/receivables/receipt/${encodeURIComponent(r.ref_id)}?customer=${customerId}`,
                                        { state: { backTo: backHere() } })}
                                      className="text-blue-700 hover:underline font-medium inline-flex items-center gap-1">
                                      {r.doc_no || 'Receipt'}
                                      {r.lines > 0 && (
                                        <span className="text-[10px] font-normal text-slate-400">
                                          {r.lines} invoice{r.lines > 1 ? 's' : ''}
                                        </span>
                                      )}
                                    </button>
                                  : <span className="text-slate-700">{r.doc_no || '—'}</span>}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-slate-800">{Number(r.debit) ? fmtINRfull(r.debit) : '—'}</td>
                            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-emerald-700">{Number(r.credit) ? fmtINRfull(r.credit) : '—'}</td>
                            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap font-semibold text-slate-800">{bal(r.balance)}</td>
                            <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-amber-700">{Number(r.tds) ? fmtINRfull(r.tds) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                      {/* Totals across all filtered rows (not just this page). The
                          running Balance column has no meaningful total, so it's
                          left blank. Sticky so it stays visible while scrolling. */}
                      {rows.length > 0 && (() => {
                        const tDeb = rows.reduce((s, r) => s + (Number(r.debit) || 0), 0);
                        const tCrd = rows.reduce((s, r) => s + (Number(r.credit) || 0), 0);
                        const tTds = rows.reduce((s, r) => s + (Number(r.tds) || 0), 0);
                        return (
                          <tfoot className="sticky bottom-0 z-10">
                            <tr className="bg-slate-100 border-t-2 border-slate-200 font-semibold text-slate-800">
                              <td className="px-3 py-2 whitespace-nowrap" colSpan={3}>Total · {rows.length} {rows.length === 1 ? 'row' : 'rows'}</td>
                              <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{tDeb ? fmtINRfull(tDeb) : '—'}</td>
                              <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-emerald-700">{tCrd ? fmtINRfull(tCrd) : '—'}</td>
                              <td className="px-3 py-2" />
                              <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-amber-700">{tTds ? fmtINRfull(tTds) : '—'}</td>
                            </tr>
                          </tfoot>
                        );
                      })()}
                    </table>
                  </div>
                  {rows.length > PAGE_SIZE && (
                    <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 text-xs text-slate-500 bg-white">
                      <span>Showing {(cp - 1) * PAGE_SIZE + 1} to {Math.min(cp * PAGE_SIZE, rows.length)} of {rows.length}</span>
                      <div className="flex items-center gap-1">
                        <button onClick={() => setPage(cp - 1)} disabled={cp <= 1}
                          className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Previous page"><ChevronLeft size={15} /></button>
                        {pageWindow(cp, totalPages).map((p, idx) => p === '…'
                          ? <span key={`e${idx}`} className="px-1.5 text-slate-400">…</span>
                          : <button key={p} onClick={() => setPage(p)}
                              className={`min-w-[30px] px-2 py-1 rounded-lg border text-xs font-medium transition ${p === cp ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{p}</button>
                        )}
                        <button onClick={() => setPage(cp + 1)} disabled={cp >= totalPages}
                          className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Next page"><ChevronRight size={15} /></button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
  );

  /* Docked drawer — the whole statement OVER the dashboard rather than
     instead of it. The page behind keeps its filters, search and scroll
     position, and the blur says so: it is still there, and clicking it closes
     this. Wide enough for all seven ledger columns on a laptop, full-width on
     a phone where there is nothing to dock beside. */
  if (drawer) {
    return (
      <>
        <div className="fixed inset-0 z-40 bg-slate-900/30 backdrop-blur-sm print:hidden"
          onClick={onClose} aria-hidden="true" />
        <aside role="dialog" aria-modal="true"
          aria-label={`${data?.customer_name || customerName || 'Customer'} ledger`}
          className="fixed right-0 top-0 z-50 h-dvh w-full lg:w-[min(1060px,94vw)] border-l border-slate-200 bg-white shadow-2xl print:hidden">
          {body}
        </aside>
      </>
    );
  }

  const shell = (
    <div
      className={inline ? ''
        // Drawer mode is now a FULL-SCREEN view (not a right-side slide-over):
        // opaque, edge-to-edge, with its own in-header Back button. A plain
        // modal (non-drawer, non-inline) keeps the dim centered overlay.
        : (drawer ? 'fixed inset-0 z-[200] bg-white' : 'fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-2 sm:p-4')}
      onClick={(inline || drawer) ? undefined : onClose}>
      {body}
    </div>
  );
  // The full-screen drawer must escape any transformed ancestor (the app
  // layout), or `fixed inset-0` fills only the content area and the sidebar
  // shows through. Portal it to <body> so it truly covers the viewport.
  return drawer ? createPortal(shell, document.body) : shell;
}

// ── Main dashboard page ──────────────────────────────────────────────

export default function SalesDashboard() {
  const navigate = useNavigate();
  // The filters live in the URL, not only in memory. Before this, picking
  // FY 2026-27 + SS Biochem and then opening a record meant Back returned to a
  // dashboard that had forgotten both -- it re-mounted on its defaults (Month,
  // this month, All Companies), which is why a drill-down that showed 13
  // records came back showing 0.
  //
  // Reading the initial state from the URL fixes three things at once: Back
  // restores what you had, refresh no longer wipes it, and the address can be
  // sent to someone else and show them the same figures.
  const [searchParams, setSearchParams] = useSearchParams();
  const sp0 = (k, d) => searchParams.get(k) ?? d;
  const [period, setPeriod] = useState(sp0('period', 'month'));  // today | week | month | custom
  const [metricsOpen, setMetricsOpen] = useState(true);  // KPI grid collapse/expand
  const [outstandingDrawer, setOutstandingDrawer] = useState(false);  // Outstanding-tile ageing slide-over
  const [custOpen, setCustOpen] = useState(true);        // Customer details collapse/expand
  const [anchor, setAnchor] = useState(sp0('anchor', todayISO()));  // navigator: which day/week/month
  const [customFrom, setCustomFrom] = useState(sp0('cfrom', todayISO()));
  const [customTo, setCustomTo] = useState(sp0('cto', todayISO()));
  const [companyId, setCompanyId] = useState(sp0('company', ''));
  const [warehouseId, setWarehouseId] = useState(sp0('factory', ''));  // "factory" filter
  const [productId, setProductId] = useState(sp0('product', ''));
  // `customer` here, not `cust`: `cust` already addresses the customer-ledger
  // drill-down and the two must not collide.
  const [customerId, setCustomerId] = useState(sp0('customer', ''));
  // Ex-GST basis for the Total Sales card. 'turnover' (GST view, ties to GSTR-1
  // and the Sales Register) is the default; 'sales_accounts' is the accounting
  // view that ties to Tally's Sales Accounts group. See TotalSalesCard.
  const [basis, setBasis] = useState(sp0('basis', 'turnover'));
  // With GST / Without GST — the headline money toggle (item 6), mirroring the
  // Purchase dashboard's Incl/Excl GST control. 'incl' shows the GST-inclusive
  // figure, 'excl' the taxable (ex-GST) value; both are already in the response.
  const [gstView, setGstView] = useState(sp0('gst', 'excl'));
  const [adjOpen, setAdjOpen] = useState(false);  // Adjustments dropdown (DN/CN/TDS)
  const { options: companyOptions } = useLookup('/api/companies/');
  const { raw: warehousesRaw } = useLookup('/api/warehouses/');
  // Product filter — server-side search via ProductPicker (no rows prop).
  // The useLookup('/api/products/?slim=1') that used to sit here downloaded
  // the full catalog (5,000+ rows, multiple concurrent page requests) and was
  // the cause of OOM on the 512 MB Render instance.
  const productOptions = [];
  // Customer list cascades off the selected company (so the dropdown only
  // shows that company's customers); unscoped when "All Companies".
  const { options: customerOptions } = useLookup(
    companyId
      ? `/api/customers/?company=${companyId}&has_sales=true`
      : '/api/customers/?has_sales=true',
    { labelField: 'customer_name' },
  );

  // Warehouse (factory) options cascade off the selected company.
  const warehouseOptions = (companyId
    ? (warehousesRaw || []).filter(w => String(w.company ?? w.company_id) === String(companyId))
    : (warehousesRaw || [])
  ).map(w => ({ value: w.id, label: w.name || w.warehouse_name || w.code || w.id }));

  // Switching company clears a now-irrelevant warehouse + customer selection.
  const onCompanyChange = (v) => { setCompanyId(v); setWarehouseId(''); setCustomerId(''); };

  // SS Biochem is the default scope on every analytics page. On a fresh landing
  // (no company picked yet) pre-select SS once the company list loads; the user
  // can switch to United Agro or clear it to see both, and that choice holds for
  // the session (guarded by a ref so clearing doesn't snap back to SS).
  const didDefaultCompany = useRef(false);
  useEffect(() => {
    if (didDefaultCompany.current) return;
    if (companyId) { didDefaultCompany.current = true; return; }
    const ss = (companyOptions || []).find((c) => /biochem/i.test(c.label));
    if (ss) { didDefaultCompany.current = true; onCompanyChange(String(ss.value)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyOptions]);

  const productActive = !!productId;

  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  /* Which companies actually sell comes from the response (`sales_companies`),
     so on a cold render it is unknown — and the old "unknown means no filter"
     fallback let EVERY company through, painting four chips that became two
     when the fetch landed and re-wrapping the filter row under them.
     Remembered for the tab so the strip is right on first paint; on a genuinely
     first visit it stays empty rather than wrong. */
  const SELLERS_KEY = 'sales-dashboard-sellers';
  const [sellerIds, setSellerIds] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(SELLERS_KEY) || 'null'); }
    catch { return null; }
  });
  useEffect(() => {
    const list = data?.sales_companies;
    if (!list) return;
    const ids = list.map(String);
    setSellerIds(ids);
    try { sessionStorage.setItem(SELLERS_KEY, JSON.stringify(ids)); }
    catch { /* private mode — the strip just settles a beat later */ }
  }, [data?.sales_companies]);
  // Stat-card popup: which records list is open, or null when closed.
  // For sales_orders we also support an optional `statusFilter` so the
  // Pending / Closed breakdown chips can drill into a subset.
  // Shape: { kind: 'customer_pos' | 'sales_orders' | 'dispatches' | 'invoices', statusFilter?: 'pending' | 'closed' } | null
  // In-page drill-down: which tile's detail is open (full-width, within the
  // dashboard). Mirrored in the URL (?view=&status=) so that navigating into a
  // record and pressing Back returns to THIS tile, not the bare dashboard.
  // The open tile is derived from the URL (single source of truth), so browser
  // back/forward and returning from a record both restore the right tile.
  const urlView = useMemo(() => {
    const v = searchParams.get('view');
    return v ? {
      kind: v, statusFilter: searchParams.get('status') || null,
      custId: searchParams.get('cust') || null,
      custName: searchParams.get('custname') || null,
      // Which age band is opened out inside the Outstanding drill-down. In the
      // URL for the same reason `view` is: opening an invoice from a band and
      // pressing Back has to come back to THAT band, with these filters, not
      // to the bare drill-down.
      band: searchParams.get('band') || '',
    } : null;
  }, [searchParams]);
  /* A customer is the one drill that no longer replaces the dashboard: the
     statement opens in a drawer OVER it, so `activeView` — which every section
     below reads as "hide yourself" — must not see it. Splitting it out here
     leaves the URL (and with it deep links, Back and refresh) exactly as it
     was, while the page underneath simply stays put. */
  const custDrill = urlView && urlView.kind === 'customer_detail' ? urlView : null;
  const activeView = custDrill ? null : urlView;
  // A customer master can be RENAMED after a link was made, and `custname` in
  // the URL is only a snapshot of the spelling at that moment. The chip read
  // that snapshot while the panel underneath read the record, so the same page
  // showed two different names for one customer -- "Green City Biotech -
  // Coimbatore" in the chip against "Green City Biotech- Rajapalayam" in the
  // heading, after the 10-Sep-2026 rename to Tally's spelling.
  //
  // The record wins. The panel reports the name it actually loaded, the chip
  // uses that, and the URL is rewritten to match so the stale spelling does not
  // survive into the next link somebody copies.
  const [liveCustName, setLiveCustName] = useState(null);
  const onResolvedName = useCallback((name) => {
    setLiveCustName(name || null);
    setSearchParams(prev => {
      const q = new URLSearchParams(prev);
      if (q.get('view') !== 'customer_detail' || !name) return q;
      if (q.get('custname') === name) return q;
      q.set('custname', name);
      return q;
    }, { replace: true });
  }, [setSearchParams]);
  // Drop the remembered name the moment we leave this customer, or the next
  // one opens wearing the previous one's label until its own fetch lands.
  useEffect(() => { setLiveCustName(null); },
            [searchParams.get('cust'), searchParams.get('view')]);

  // Browser Back clears `view` from the URL without calling closeView, so the
  // restore has to hang off the transition itself, not just the button.
  const hadView = useRef(false);
  useEffect(() => {
    if (!activeView && hadView.current) restoreScroll();
    hadView.current = !!activeView;
    // eslint-disable-line react-hooks/exhaustive-deps
  }, [activeView]);

  const VIEW_LABELS = {
    total_sales: 'Total Sales', amount_received: 'Amount Received',
    receivables_buckets: 'Outstanding Receivables', sales_orders: 'Sales Orders',
    invoices: 'Invoices Raised', dispatches: 'Quantity Dispatched',
    outstanding_customers: 'Top Debtors', customer_detail: 'Customer Transactions',
    debit_notes: 'Debit Notes', credit_notes: 'Credit Notes',
    tds: 'TDS (194Q)',
  };
  // ── Remember where you were before opening a drill-down ───────────────
  // The Customer details table sits near the bottom of a long page. Clicking a
  // row swapped the whole page for a short drill-down, so on the way back the
  // browser had nothing tall enough to scroll to and clamped to the top —
  // leaving you to hunt for the row you had just been reading.
  //
  // Captured in the CLICK, not in an effect: by the time an effect runs the
  // drill-down has already rendered and the scroll position is gone. Restored
  // on the next frame, once the long page is back and tall enough to accept it.
  //
  // sessionStorage rather than a ref so the position also survives the browser
  // Back button, which remounts this component — the same approach the sidebar
  // already uses to keep its own scroll position. Pure navigation comfort: no
  // figure, filter or request is touched.
  const SCROLL_KEY = 'sales-dashboard-scroll';
  const rememberScroll = () => {
    try { sessionStorage.setItem(SCROLL_KEY, String(window.scrollY || 0)); }
    catch { /* private mode — just lose the position */ }
  };
  const restoreScroll = () => {
    try {
      const y = parseInt(sessionStorage.getItem(SCROLL_KEY) || '0', 10);
      if (y > 0) requestAnimationFrame(() => window.scrollTo(0, y));
    } catch { /* ignore */ }
  };

  const openView = (kind, statusFilter = null) => {
    // Already on this exact drill (same kind + status, not drilled into a
    // customer) → ignore a fast repeat click so the open can't re-fire and race
    // its own fetch (the crash behind the "reload" card).
    if (searchParams.get('view') === kind
        && (searchParams.get('status') || '') === (statusFilter || '')
        && !searchParams.get('cust') && !searchParams.get('dcust')) return;
    rememberScroll();
    const p = new URLSearchParams(searchParams);
    p.set('view', kind);
    if (statusFilter) p.set('status', statusFilter); else p.delete('status');
    p.delete('cust'); p.delete('custname');
    p.delete('dcust');   // a drill opens unfiltered, never on the last one's customer
    setSearchParams(p);
  };
  // Drill into a single customer's full transaction ledger (in-dashboard page).
  const openCustomer = (id, name) => {
    if (!id) return;
    rememberScroll();
    const p = new URLSearchParams(searchParams);
    p.set('view', 'customer_detail');
    p.set('cust', id);
    if (name) p.set('custname', name); else p.delete('custname');
    p.delete('status');
    setSearchParams(p);
  };
  const closeView = () => {
    const p = new URLSearchParams(searchParams);
    p.delete('view'); p.delete('status'); p.delete('cust'); p.delete('custname');
    p.delete('dcust');
    p.delete('band');   // the drill-down's band; `ageband` belongs to the page
                        // itself and deliberately survives closing a tile
    p.delete('rb_sub'); p.delete('rb_page'); p.delete('rb_sort');  // buckets drill state
    setSearchParams(p, { replace: true });
    restoreScroll();
  };
  // Which age band is opened out on the analytics page itself (as opposed to
  // `band`, which is the one inside the Outstanding drill-down). Its own param,
  // because the two are different places: this one opens UNDER the age cards
  // without leaving the dashboard.
  const ageBand = searchParams.get('ageband') || '';
  const openAgeBand = (key) => {
    const p = new URLSearchParams(searchParams);
    if (key) p.set('ageband', key); else p.delete('ageband');
    // Opening pushes so Back closes it; closing replaces so Back does not walk
    // straight back in.
    setSearchParams(p, key ? undefined : { replace: true });
  };
  // Open one age band inside the Outstanding drill-down (or close it again).
  // PUSHED, not replaced: a band is a place you went to, so Back should step
  // out of it and land on the band list rather than leaving the drill-down.
  const openBand = (key) => {
    const p = new URLSearchParams(searchParams);
    p.set('view', 'receivables_buckets');
    if (key) p.set('band', key); else p.delete('band');
    // Opening pushes; closing REPLACES. Push both ways and "All Bands" would
    // leave an entry behind, so the browser Back button walked straight back
    // into the band the user had just closed.
    setSearchParams(p, key ? undefined : { replace: true });
  };
  // Back target for record hyperlinks inside a tile — the dashboard URL with
  // this tile encoded, so the record's Back button reopens the tile.
  useEffect(() => {
    const p = new URLSearchParams(searchParams);
    const put = (k, v, keep) => { if (keep) p.set(k, v); else p.delete(k); };
    put('period', period, period && period !== 'month');
    put('anchor', anchor, period !== 'custom' && anchor && anchor !== todayISO());
    put('cfrom', customFrom, period === 'custom');
    put('cto', customTo, period === 'custom');
    put('company', companyId, !!companyId);
    put('factory', warehouseId, !!warehouseId);
    put('product', productId, !!productId);
    put('customer', customerId, !!customerId);
    put('basis', basis, basis && basis !== 'turnover');
    put('gst', gstView, gstView && gstView !== 'excl');
    const next = p.toString();
    if (next !== searchParams.toString()) setSearchParams(p, { replace: true });
  }, [period, anchor, customFrom, customTo, companyId, warehouseId, productId,
      customerId, basis, gstView, searchParams, setSearchParams]);

  // Where a record opened from a drill-down returns to. It must carry the
  // filters as well as the open view, or Back lands on a reset dashboard --
  // which is exactly what it used to do.
  const drillBackTo = (() => {
    const p = new URLSearchParams(searchParams);
    if (activeView) {
      p.set('view', activeView.kind);
      if (activeView.statusFilter) p.set('status', activeView.statusFilter);
      else p.delete('status');
    }
    const qs = p.toString();
    return `/sales/dashboard${qs ? `?${qs}` : ''}`;
  })();
  // Is the mobile filter sheet showing? Purely visual, and deliberately NOT in
  // the URL: a panel opening is not a destination, and must not leave a
  // history entry for Back to land on.
  const [filtersOpen, setFiltersOpen] = useState(false);
  // How many of the existing dropdowns are set — for the badge on the Filters
  // button, so "what is filtered right now?" is answerable without opening it.
  // It COUNTS the current selections; it does not choose or change any of
  // them, and no request depends on it. Period is excluded: it always has a
  // value, so counting it would read "1 filter" on an untouched page.
  const activeFilterCount =
    [companyId, warehouseId, customerId, productId]
      .filter(v => Array.isArray(v) ? v.length : !!v).length;
  const [custSearch, setCustSearch] = useState('');   // Customer-details table search
  const [custPage, setCustPage] = useState(1);        // Customer-details pagination (10/page)
  const [custSeg, setCustSeg] = useState('');          // Domestic / Export filter (item 24): '' | 'domestic' | 'export'
  const [custOverdue, setCustOverdue] = useState('');  // Days-overdue filter: '' | 'any' | '30' | '60' | '90'

  const buildParams = () => {
    const p = new URLSearchParams();
    p.set('period', period);
    // Send an explicit window so the navigator can pin a specific day/week/
    // month; custom uses its own date pickers.
    if (period === 'custom') {
      p.set('from', customFrom);
      p.set('to', customTo);
    } else {
      const r = rangeFor(period, anchor);
      if (r) { p.set('from', r.from); p.set('to', r.to); }
    }
    if (companyId) p.set('company', companyId);
    if (warehouseId) p.set('warehouse', warehouseId);
    if (productId) p.set('product', productId);
    if (customerId) p.set('customer', customerId);
    // Ex-GST basis for the Total Sales card (see TotalSalesCard). Sent on every
    // request so the Excel export and every drill-down read the same basis the
    // screen is showing — a figure that changes between screen and export would
    // be worse than not having the toggle at all.
    if (basis && basis !== 'turnover') p.set('basis', basis);
    return p.toString();
  };

  // Effective window (from/to) for the current period + navigator anchor —
  // passed to tile drill-downs so they open on the same day/week/month.
  const effRange = period === 'custom'
    ? { from: customFrom, to: customTo }
    : (rangeFor(period, anchor) || { from: customFrom, to: customTo });
  // When a SPECIFIC (non-current) day/week/month is selected, open drill-downs
  // as a pinned custom range so they show that exact window; otherwise pass the
  // period through unchanged (live, relative-to-today).
  const drillPeriod = (period !== 'custom' && anchor !== todayISO()) ? 'custom' : period;

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    apiClient.get(`/api/sales/dashboard/?${buildParams()}`)
      .then(res => { if (!cancelled) setData(res.data); })
      .catch(err => { if (!cancelled) setError(err.response?.data?.detail || 'Failed to load dashboard.'); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, anchor, customFrom, customTo, companyId, warehouseId, productId, customerId, basis]);

  // Reset the Customer-details table to page 1 whenever the dashboard reloads.
  useEffect(() => { setCustPage(1); }, [data]);

  const stats = data?.stats;
  const _dn = stats?.debit_notes || {};
  const _cn = stats?.credit_notes || {};
  const _or = stats?.outstanding_receivables || {};
  const trend = data?.trend || [];
  const topCustomers = data?.top_customers || [];

  // Adjustments (debit/credit notes + TDS) — lifted out of the KEY METRICS block
  // so the control can sit in the filter bar. Turnover is the only basis now, so
  // TDS always shows.
  const ADJ_TONE = {
    amber:  'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100',
    blue:   'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100',
    violet: 'border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100',
  };
  const adj = useMemo(() => {
    const rs = stats?.received_against_sales || {};
    const tdsVal = Number(rs.tds || 0) + Number(rs.tds_note_debits || 0)
      + Number(rs.tds_at_payment || 0) - Number(rs.tds_reversed || 0);
    const dn = stats?.debit_notes || {}; const cn = stats?.credit_notes || {};
    const items = [
      Number(dn.amount) ? { k: 'debit_notes', label: 'Debit Notes', val: dn.amount, sub: `${fmtInt(dn.count || 0)} charged to customers`, tone: 'amber' } : null,
      Number(cn.amount) ? { k: 'credit_notes', label: 'Credit Notes', val: cn.amount, sub: `${fmtInt(cn.count || 0)} returns / discounts`, tone: 'blue' } : null,
      tdsVal ? { k: 'tds', label: 'TDS (194Q)', val: tdsVal, sub: 'withheld by buyers u/s 194Q', tone: 'violet' } : null,
    ].filter(Boolean);
    return { items, total: items.reduce((a, x) => a + Number(x.val || 0), 0) };
  }, [stats]);
  const byCompany = data?.by_company || [];
  const customerBreakdown = data?.customer_breakdown || [];

  // ← / → page the Customer-details table. It predates the shared DataTable
  // and carries its own pager, so it needs the hook wired up explicitly.
  // Mirrors the search filter applied in the table's render block below.
  const custTotalPages = useMemo(() => {
    const q = custSearch.trim().toLowerCase();
    const n = q
      ? customerBreakdown.filter(c => (c.customer_name || '').toLowerCase().includes(q)
          || (c.company_name || '').toLowerCase().includes(q)).length
      : customerBreakdown.length;
    return Math.max(1, Math.ceil(n / 10));
  }, [customerBreakdown, custSearch]);
  usePagerKeys({
    enabled: !activeView && custTotalPages > 1,
    onPrev: () => setCustPage(p => Math.max(1, Math.min(p, custTotalPages) - 1)),
    onNext: () => setCustPage(p => Math.min(custTotalPages, p + 1)),
  });

  // Whole-dashboard Excel export — bundles the headline KPIs + daily
  // trend + top customers + per-company rollup into a single sheet
  // with section headers, so the user gets a readable snapshot of
  // the page in one file.
  const handleExportDashboard = () => {
    if (!stats) { toast.error('Dashboard is still loading.'); return; }
    const periodLabel = data?.period?.label || period;
    const from = data?.period?.from || '';
    const to = data?.period?.to || '';
    const companyLabel = companyId
      ? (companyOptions.find(c => String(c.value) === String(companyId))?.label || '(filtered)')
      : 'All Companies';

    const sectionRow = (title) => ({ metric: title, value: '', extra: '' });
    const blank = { metric: '', value: '', extra: '' };
    const fmtUomList = (rows) => (rows || [])
      .map(b => `${Number(b.qty).toLocaleString('en-IN', { minimumFractionDigits: 3 })} ${b.uom}`)
      .join(' · ') || '—';
    const uomList = fmtUomList(stats.quantity_invoiced?.uom_breakdown);
    // Dispatched is exported alongside invoiced: the gap between them is the
    // useful signal (invoices with no dispatch challan behind them).
    const dispatchedUomList = fmtUomList(stats.quantity_dispatched?.uom_breakdown);

    const rows = [
      { metric: 'Period', value: periodLabel, extra: `${from} → ${to}` },
      { metric: 'Company', value: companyLabel, extra: '' },
      blank,
      sectionRow('KPI'),
      { metric: 'Total Sales (invoices + debit notes)', value: fmtINRfull(stats.received_against_sales?.total_debited || 0), extra: 'Tally Sundry-Debtors Dr' },
      { metric: 'Sales Orders (count)', value: stats.sales_orders.count, extra: fmtINRfull(stats.sales_orders.amount) },
      { metric: 'Sales Orders · Pending', value: stats.sales_orders.pending_count, extra: '' },
      { metric: 'Sales Orders · Closing', value: stats.sales_orders.closed_count, extra: '' },
      { metric: 'Quantity Invoiced', value: uomList, extra: `across ${stats.quantity_invoiced?.invoice_count || 0} invoice(s)` },
      { metric: 'Quantity Dispatched', value: dispatchedUomList, extra: `${stats.quantity_dispatched?.dc_count || 0} DC(s)` },
      { metric: 'Amount Received', value: fmtINRfull(stats.amount_received.total), extra: 'This period (any invoice)' },
      { metric: 'Debit Notes (count)', value: stats.debit_notes?.count || 0, extra: `${fmtINRfull(stats.debit_notes?.amount || 0)} · charged to customers` },
      { metric: 'Credit Notes (count)', value: stats.credit_notes?.count || 0, extra: `${fmtINRfull(stats.credit_notes?.amount || 0)} · returns / discounts` },
      { metric: 'Received on Period Sales', value: fmtINRfull(stats.received_against_sales?.received || 0), extra: `${stats.received_against_sales?.collected_pct || 0}% of ${fmtINRfull(stats.received_against_sales?.invoiced || 0)} invoiced` },
      { metric: 'Sales Debit Notes (freight/charges)', value: fmtINRfull(stats.received_against_sales?.debit_notes || 0), extra: '' },
      { metric: 'Total Debited to Customers (Tally Sundry-Debtors Dr)', value: fmtINRfull(stats.received_against_sales?.total_debited || 0), extra: 'Invoices + debit notes' },
      { metric: 'Outstanding Receivables', value: fmtINRfull(stats.outstanding_receivables.total), extra: `${stats.outstanding_receivables.count} unpaid invoice(s) · live` },
      blank,
      sectionRow('Top customers by SO amount'),
      ...topCustomers.map((c, i) => ({
        metric: `${i + 1}. ${c.customer_name}`,
        value: `${c.so_count} SO(s)`,
        extra: fmtINRfull(c.amount),
      })),
    ];

    if (!companyId && byCompany.length > 0) {
      rows.push(blank, sectionRow('By company'));
      byCompany.forEach(c => rows.push({
        metric: c.company_name,
        value: `${c.so_count} SO(s)`,
        extra: fmtINRfull(c.amount),
      }));
    }

    if (trend.length > 0) {
      rows.push(blank, sectionRow('Daily trend'));
      rows.push({ metric: 'Date', value: 'PO / SO counts · Dispatch qty', extra: 'Amount received' });
      trend.forEach(t => rows.push({
        metric: t.date,
        value: `${Number(t.po_count) || 0} PO · ${Number(t.so_count) || 0} SO · ${fmtQty(t.dispatch_qty)} qty`,
        extra: fmtINRfull(t.amount_received),
      }));
    }

    const exportMeta = buildFilterMeta({
      companyId, companyOptions, productId, productOptions, customerId, customerOptions,
      warehouseId, warehouseOptions: (warehousesRaw || []).map(w => ({ value: w.id, label: w.name || w.warehouse_name || w.code || w.id })),
      periodLabel, from, to,
    });
    exportToExcel(rows, [
      { field: 'metric', header: 'Metric' },
      { field: 'value', header: 'Value' },
      { field: 'extra', header: 'Detail' },
    ], `sales-dashboard-${periodLabel.replace(/\s+/g, '-').toLowerCase()}-${from}-to-${to}`, 'Sheet1', null, exportMeta);
    toast.success('Dashboard exported to Excel!');
  };

  // Company quick-switch buttons rendered inline with the title. One click
  // scopes the WHOLE dashboard (every tile + customer details) to that company;
  // click the active one again to clear back to all. Hidden while a tile is open.
  const companyButtons = (() => {
    // EVERY company the user can see, in the order the API returned them —
    // not a hand-written pair. Naming two companies here meant a third one
    // simply had no button, and its name had no short form either.
    // Only companies that actually sell. Biogreen is a group company and a
    // customer in SS Biochem's books — it has no sales of its own, so a chip
    // for it is noise. Driven by the data, never by a list of names.
    // null = not known yet (first ever load, still fetching) → no chips at
    // all. An empty list means the API named none, in which case every
    // company qualifies, as before.
    const sellers = sellerIds === null ? null : new Set(sellerIds);
    const quick = sellers === null ? [] : companyOptions.filter(
      c => c.value && (sellers.size === 0 || sellers.has(String(c.value))));
    if (activeView || !quick.length) return null;
    // Short chips so the header row stays on one line. Derived, not listed:
    // drop the legal-form noise every Indian company name carries and keep the
    // first couple of distinctive words. Full legal name stays on hover.
    const shortName = (label) => {
      const s = String(label || '');
      // Our two selling companies get a clean, title-cased name; everything
      // else falls back to the first couple of distinctive words.
      if (/biochem/i.test(s)) return 'SS Biochem';
      if (/united\s*agro/i.test(s)) return 'United Agro';
      const words = s
        .replace(/[.,]/g, ' ')
        .split(/\s+/)
        .filter(w => w && !/^(pvt|private|ltd|limited|llp|inc|co|company|india|the|and|&)$/i.test(w));
      return words.slice(0, 2).join(' ') || s;
    };
    return (
      <div className="hidden md:flex items-center gap-1.5 shrink-0">
        {quick.map(c => {
          const active = String(companyId || '') === String(c.value);
          const chip = shortName(c.label);
          return (
            <button key={c.value} type="button" onClick={() => onCompanyChange(active ? '' : c.value)}
              title={c.label}
              className={`px-2 py-1.5 rounded-lg text-xs font-semibold border transition whitespace-nowrap ${active
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                : 'bg-white text-slate-700 border-slate-200 hover:border-indigo-300 hover:text-indigo-600'}`}>
              {chip}
            </button>
          );
        })}
      </div>
    );
  })();

  // Filter controls — a single full-width row directly under the header, so
  // everything (period + company / factory / product / customer) sits on one
  // straight line instead of being squeezed beside the title. Mirrors the
  // Purchase Analytics filter bar. Wraps only on genuinely narrow phones.
  const filterBar = (
    // lg+ (where this bar rides on the header row) stays a single line: the
    // period group and FY picker are shrink-0, while the factory / product /
    // customer selects carry min-w-0 + truncate, so a long selected name
    // ellipsises in place instead of wrapping the customer select to a 2nd
    // row. Below lg this same bar renders inside the mobile sheet, which
    // overrides it to a full-width column, so nowrap never bites there.
    <div className="flex flex-wrap lg:flex-nowrap items-center gap-1.5">
      <div className="flex rounded-lg border border-slate-200 overflow-hidden shrink-0">
        {[
          { v: 'today', l: 'Today' },
          { v: 'week',  l: 'Week' },
          { v: 'month', l: 'Month' },
          { v: 'fy',    l: 'FY' },
          { v: 'custom', l: 'Custom' },
        ].map((p, i) => (
          <button
            key={p.v}
            // FY stores a "FROM..TO" token in the anchor; every other period
            // stores a plain date. Re-seed on switch so rangeFor() always
            // gets the shape it expects.
            onClick={() => { setPeriod(p.v); setAnchor(p.v === 'fy' ? fyTokenFor(new Date()) : todayISO()); }}
            title={p.v === 'fy' ? 'Financial year (1 Apr – 31 Mar)' : undefined}
            className={`px-2 py-1.5 text-xs whitespace-nowrap ${i > 0 ? 'border-l border-slate-200' : ''} ${period === p.v ? 'bg-indigo-600 text-white' : 'text-slate-700 hover:bg-slate-50'}`}
          >
            {p.l}
          </button>
        ))}
      </div>
      {/* Period navigator — pick the specific day / week / month */}
      {period === 'today' && (
        <CustomDatePicker value={anchor} onChange={e => setAnchor(e.target.value || todayISO())} max={todayISO()}
          className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-0 max-w-[140px] shrink-0 ${CTRL_H}`} />
      )}
      {period === 'week' && (
        <CustomSelect value={weekRangeOf(anchor).from} onChange={e => setAnchor(e.target.value)}
          className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-0 max-w-[180px] shrink-0 ${CTRL_H}`} title="Select week">
          {weekOptions().map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
        </CustomSelect>
      )}
      {period === 'month' && (
        <CustomSelect value={monthRangeOf(anchor).from} onChange={e => setAnchor(e.target.value)}
          className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-0 max-w-[130px] shrink-0 ${CTRL_H}`} title="Select month">
          {monthOptions().map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </CustomSelect>
      )}
      {period === 'fy' && (
        <CustomSelect value={anchor} onChange={e => setAnchor(e.target.value)}
          className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-0 max-w-[200px] shrink-0 ${CTRL_H}`} title="Select financial year / half">
          {fyOptions().map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </CustomSelect>
      )}
      {/* Company — only below md. From md up the quick chips beside the title
          are the company control (clicking the active one clears back to all),
          so a dropdown here would be a second way to do the same thing taking
          up room on the filter row. The chips are hidden below md, so the
          select is still the control there. */}
      <div className="md:hidden">
        <CustomSelect value={companyId} onChange={e => onCompanyChange(e.target.value)}
          className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-0 max-w-[150px] truncate ${CTRL_H}`}
          title="Company">
          <option value="">All Companies</option>
          {companyOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </CustomSelect>
      </div>
      <CustomSelect value={warehouseId} onChange={e => setWarehouseId(e.target.value)}
        className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-0 max-w-[140px] truncate ${CTRL_H}`}
        title="Factory / warehouse">
        <option value="">All Factories</option>
        {warehouseOptions.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
      </CustomSelect>
      <ProductPicker value={productId}
        onChange={e => setProductId(e.target.value)}
        className={`inline-flex items-center gap-1.5 border border-slate-300 rounded-lg px-2 text-xs bg-white text-slate-700 hover:bg-slate-50 min-w-0 max-w-[170px] ${CTRL_H}`} />
      <CustomSelect value={customerId} onChange={e => setCustomerId(e.target.value)}
        className={`border border-slate-300 rounded-lg px-2 text-xs bg-white min-w-0 max-w-[150px] truncate ${CTRL_H}`}
        title="Customer">
        <option value="">All Customers</option>
        {customerOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
      </CustomSelect>
      {period === 'custom' && (
        <div className="flex items-center gap-2 text-xs shrink-0">
          <Calendar size={14} className="text-slate-500 shrink-0" />
          <CustomDatePicker value={customFrom} onChange={e => setCustomFrom(e.target.value)} max={customTo}
            className="border border-slate-300 rounded px-2 py-1.5 min-w-0 w-[130px]" />
          <span className="text-slate-400">to</span>
          <CustomDatePicker value={customTo} onChange={e => setCustomTo(e.target.value)} min={customFrom} max={todayISO()}
            className="border border-slate-300 rounded px-2 py-1.5 min-w-0 w-[130px]" />
        </div>
      )}
      {/* Adjustments (DN/CN/TDS) + With/Without-GST — moved here from the KEY
          METRICS header so the money controls live on the filter bar. */}
      <div className="flex items-center gap-1.5 shrink-0 lg:ml-auto">
        {adj.items.length > 0 && (
          <div className="relative">
            <button type="button" onClick={() => setAdjOpen(o => !o)}
              title="Debit notes, credit notes and TDS"
              className={`inline-flex items-center gap-1.5 px-2.5 rounded-lg border text-[11px] font-semibold transition ${CTRL_H} ${adjOpen ? 'bg-amber-50 border-amber-300 text-amber-700' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'}`}>
              <SlidersHorizontal size={13} className={adjOpen ? 'text-amber-600' : 'text-slate-500'} />
              Adjustments
              <span className="tabular-nums text-slate-400">{fmtINR(adj.total)}</span>
              <ChevronDown size={12} className={`transition-transform ${adjOpen ? 'rotate-180 text-amber-500' : 'text-slate-400'}`} />
            </button>
            {adjOpen && (
              <div className="absolute top-full right-0 mt-1 z-30 bg-white border border-slate-200 rounded-lg shadow-lg p-2 flex flex-col gap-1.5 min-w-[220px]">
                {adj.items.map((it) => (
                  <button key={it.k} onClick={() => { openView(it.k); setAdjOpen(false); }}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-semibold transition text-left ${ADJ_TONE[it.tone]}`}>
                    <span className="min-w-0">
                      <span className="block">{it.label}</span>
                      <span className="block text-[10px] font-normal opacity-75">{it.sub}</span>
                    </span>
                    <span className="ml-auto tabular-nums money shrink-0">{fmtINRfull(it.val)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="flex gap-0.5 bg-slate-100 rounded-md p-0.5 shrink-0" title="Show the GST-inclusive or taxable (ex-GST) value">
          {[['excl', 'Without GST'], ['incl', 'With GST']].map(([k, l]) => (
            <button key={k} type="button" onClick={() => setGstView(k)}
              className={`px-2 py-0.5 rounded text-[10px] font-semibold transition ${gstView === k ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
              {l}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  // When a customer is open, render its ledger as a NORMAL full page inside the
  // app layout — the sidebar stays in place and there is no overlay/backdrop.
  // Back returns to the Analytics dashboard with its filters intact (URL-driven).
  if (custDrill) {
    const row = customerBreakdown.find(c => String(c.customer_id) === String(custDrill.custId));
    const settled = row && !row.is_creditor ? Math.min(100, Math.round(Number(row.collected_pct) || 0)) : undefined;
    return (
      <MainLayout>
        <div className="p-2 sm:p-3">
          <CustomerLedgerModal inline showBack backTo={drillBackTo}
            customerId={custDrill.custId} customerName={custDrill.custName}
            onResolvedName={onResolvedName} settledPct={settled}
            period0={period} anchor0={anchor} from0={effRange.from} to0={effRange.to}
            onClose={closeView} />
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <PageHeader
        compact
        title="Sales Analytics"
        icon={LayoutDashboard}
        breadcrumbs={[{ label: 'Sales', href: '/sales/orders' }, { label: 'Sales Analytics' }]}
        actions={{ right: companyButtons, onPrint: () => window.print() }}
      />

      {/* Filter bar — its own full-width row under the header (lg+), matching
          Purchase Analytics, so the controls sit on one straight line instead
          of being squeezed beside the title. Company chips stay in the header
          row above. Below lg the same bar moves into the mobile sheet. */}
      {!activeView && (
        <div className="hidden lg:block bg-white rounded-lg border border-slate-200 mb-4 px-2.5 py-2.5">
          {filterBar}
        </div>
      )}

      {!activeView && (
        <>

          {/* Below lg the same bar wraps onto four rows on a 320px screen, so
              you scroll past a wall of controls before reaching any data. The
              SAME `filterBar` moves into the sheet this app already uses for
              mobile filters, behind one button.

              Same controls, same handlers, same requests. Period, Month and FY
              are inside `filterBar`, so choosing them in the sheet runs the
              identical setPeriod/setAnchor and the tiles change exactly as
              they do on desktop. */}
          <div className="lg:hidden mb-2.5 flex items-center gap-2">
            <button type="button" onClick={() => setFiltersOpen(true)}
              aria-haspopup="dialog" aria-expanded={filtersOpen}
              className={`inline-flex items-center gap-2 rounded-lg border px-3 text-sm font-medium transition ${CTRL_H} ${activeFilterCount
                ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'}`}>
              <SlidersHorizontal size={15} />
              Filters
              {activeFilterCount > 0 && (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-indigo-600 text-white text-[11px] font-semibold tabular-nums">
                  {activeFilterCount}
                </span>
              )}
            </button>
            {/* The period stays readable without opening anything — it is the
                filter people check most and change least. Read from the same
                `data.period.label` the export uses; `periodLabel` is a local
                inside handleExportDashboard and is not in scope out here. */}
            <span className="text-xs text-slate-500 truncate">
              {data?.period?.label || period}
            </span>
          </div>

          <MobileBottomSheet
            open={filtersOpen}
            onClose={() => setFiltersOpen(false)}
            title="Filters"
            footer={(
              <button type="button" onClick={() => setFiltersOpen(false)}
                className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white">
                Show results
              </button>
            )}>
            {/* Every control from the desktop bar is here — Today, Week,
                Month, FY, Custom, the month / FY picker, and all four
                dropdowns. It is the SAME `filterBar`, so nothing is dropped
                or reduced for mobile.

                The bar is `flex flex-wrap` for a wide toolbar; in a phone-width
                sheet that wraps into ragged pairs. These arbitrary variants
                turn it into a full-width stack — CSS only, overriding layout
                without touching the markup or any handler inside it. The
                period group keeps its row so Today/Week/Month/FY/Custom stay
                side by side, which is how that control reads. */}
            <div className="[&>div]:!flex-col [&>div]:!items-stretch [&>div]:gap-2
                            [&>div>*]:w-full [&>div>div:first-child]:!flex-row
                            [&_button]:justify-center">
              {filterBar}
            </div>
          </MobileBottomSheet>
        </>
      )}

      {/* Active drill-down chip — appears when a tile is opened, with a ✕ to close */}
      {activeView && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <span className="text-xs text-slate-500">Viewing:</span>
          <span className="inline-flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-700 text-sm font-medium">
            {activeView.kind === 'customer_detail' ? (liveCustName || activeView.custName || 'Customer') : (VIEW_LABELS[activeView.kind] || 'Details')}
            {activeView.statusFilter && <span className="text-[11px] text-indigo-500 capitalize">· {activeView.statusFilter}</span>}
            <button onClick={closeView} className="p-0.5 rounded-full hover:bg-indigo-200/60 text-indigo-500 hover:text-indigo-800" aria-label="Close view" title="Close and return to dashboard">
              <X size={14} />
            </button>
          </span>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 mb-4 text-sm flex items-center gap-2">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {isLoading && (
        <>
          {/* The skeleton IS the band — same header row, same four headline
              cards — so the figures land in the boxes that were already on
              screen rather than the page rebuilding a different layout the
              moment the fetch returns. */}
          <div className="flex items-center justify-between gap-2 mb-2 animate-pulse">
            <div className="h-3 w-24 rounded bg-slate-200" />
            <div className="h-5 w-40 rounded bg-slate-200" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="relative overflow-hidden rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm animate-pulse">
                <span className="absolute left-0 top-0 h-full w-1 bg-slate-200" />
                <div className="h-2 w-20 rounded bg-slate-200" />
                <div className="mt-1.5 h-4 w-28 rounded bg-slate-200" />
                <div className="mt-1 h-2 w-16 rounded bg-slate-100" />
                <div className="mt-1 h-2.5 w-24 rounded bg-slate-100" />
              </div>
            ))}
          </div>
        </>
      )}

      {!isLoading && stats && (
        <>
          {productActive && !activeView && (
            <p className="text-[11px] text-slate-400 -mt-1.5 mb-3">
              * With a product filter, <strong>Amount Received &amp; Outstanding</strong> count the{' '}
              <span className="underline decoration-dotted cursor-help"
                title="A receipt settles a whole invoice and can't be split per line — so these two show the full value of every invoice that contains this product (the product acts as a membership filter), not a per-line amount.">
                whole invoices that include it
              </span>, not per-line amounts.
            </p>
          )}

          {/* Normal dashboard (KPI grid + customer table) — hidden while a
              tile drill-down is open in-page. */}
          {!activeView && (<>
          {/* Key metrics — collapsible KPI grid. The Turnover/GSTR-1 basis is a
              page-wide control (it also hides the TDS chip, which a GST return
              does not carry); it moved here when the Total Sales card was
              simplified to match the compact design. */}
          {(() => {
            const rs = stats.received_against_sales || {};
            const taxable = Number(rs.taxable || 0);
            const inclGst = Number(rs.incl_gst ?? rs.invoiced ?? 0);
            // Headline Total Sales follows the With/Without-GST toggle (item 6).
            const totalSales = gstView === 'incl' ? inclGst : taxable;
            const tdsVal = Number(rs.tds || 0) + Number(rs.tds_note_debits || 0)
              + Number(rs.tds_at_payment || 0) - Number(rs.tds_reversed || 0);
            const osTotal = Number(_or.ageing_total || 0);
            const osCount = (_or.ageing || []).reduce((a, b) => a + (Number(b.count) || 0), 0);
            const qtyBits = [uomPrimary(stats.quantity_invoiced?.uom_breakdown),
              `${fmtInt(stats.quantity_invoiced?.invoice_count || 0)} invoice(s)`].filter(Boolean).join(' · ');
            const adjItems = [
              Number(_dn.amount) ? { k: 'debit_notes', label: 'Debit Notes', val: _dn.amount, sub: `${fmtInt(_dn.count || 0)} charged to customers`, tone: 'amber' } : null,
              Number(_cn.amount) ? { k: 'credit_notes', label: 'Credit Notes', val: _cn.amount, sub: `${fmtInt(_cn.count || 0)} returns / discounts`, tone: 'blue' } : null,
              (basis !== 'sales_accounts' && tdsVal) ? { k: 'tds', label: 'TDS (194Q)', val: tdsVal, sub: 'withheld by buyers u/s 194Q', tone: 'violet' } : null,
            ].filter(Boolean);
            const adjTotal = adjItems.reduce((a, x) => a + Number(x.val || 0), 0);
            const TONE_BTN = {
              amber: 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100',
              blue: 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100',
              violet: 'border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100',
            };
            return (<>
          <div className="mb-2">
            <button type="button" onClick={() => setMetricsOpen(o => !o)}
              className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-700"
              aria-expanded={metricsOpen}>
              <ChevronRight size={14} className={`transition-transform ${metricsOpen ? 'rotate-90' : ''}`} />
              Key metrics
            </button>
          </div>
          {metricsOpen && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3 bg-indigo-100 border border-indigo-200 rounded-xl p-2.5">
            <HeadlineCard label="Total Sales" tone="sales"
              value={fmtINRfull(totalSales)}
              // Purchase "Amount Billed" tile style — money on top, the record
              // COUNT as the subtitle (not the crore words, which stay on hover).
              words={`${fmtInt(stats.quantity_invoiced?.invoice_count || 0)} invoices · ${gstView === 'incl' ? 'incl GST' : 'ex-GST'}`}
              title="Click to open the Total Sales breakdown."
              popTitle={`${basis === 'sales_accounts' ? 'GSTR-1' : 'Turnover'} basis`}
              popRows={[
                uomPrimary(stats.quantity_invoiced?.uom_breakdown) && { label: 'Quantity', value: uomPrimary(stats.quantity_invoiced?.uom_breakdown) },
                { label: 'Invoices', value: fmtInt(stats.quantity_invoiced?.invoice_count || 0) },
                { label: gstView === 'incl' ? 'Incl GST' : 'Ex-GST', value: fmtINRfull(totalSales), tone: 'text-indigo-700' },
              ]}
              onClick={() => openView('total_sales')} />
            <HeadlineCard label="Amount Received" tone="received"
              value={fmtINRfull(stats.amount_received?.total || 0)}
              words={`₹${fmtWords(stats.amount_received?.total || 0)}`}
              popTitle="This period"
              popRows={[
                { label: 'Receipts + notes', value: fmtINRfull(stats.amount_received?.total || 0), tone: 'text-emerald-700' },
                Number(_cn.amount) && { label: 'Credit notes', value: fmtINRfull(_cn.amount) },
                Number(_dn.amount) && { label: 'Debit notes', value: fmtINRfull(_dn.amount) },
              ]}
              onClick={() => openView('amount_received')} />
            <HeadlineCard label="Receivable" tone="outstanding"
              value={fmtINRfull(osTotal)}
              words={`₹${fmtWords(osTotal)}`}
              title="Unpaid receivables. Click for the ageing breakdown."
              popTitle="Receivables ageing"
              popRows={(_or.ageing || [])
                .filter(b => Number(b.amount))
                .map(b => ({ label: `${b.label}${Number(b.count) ? ` · ${fmtInt(b.count)}` : ''}`, value: fmtINRfull(b.amount), tone: 'text-rose-600' }))}
              onClick={() => setOutstandingDrawer(true)} />
            <HeadlineCard label="Sales Orders" tone="orders"
              value={fmtInt(stats.sales_orders.count)}
              words={`${fmtInt(stats.sales_orders.pending_count)} of ${fmtInt(stats.sales_orders.count)} pending`}
              title="Click to view order details."
              popTitle="Orders"
              popRows={[
                { label: 'Ordered value', value: fmtINRfull(stats.sales_orders.amount || 0), tone: 'text-indigo-700' },
                { label: 'Pending', value: fmtInt(stats.sales_orders.pending_count || 0) },
                { label: 'Closing', value: fmtInt(stats.sales_orders.closed_count || 0) },
              ]}
              onClick={() => openView('sales_orders')} />
          </div>
          )}
          </>);
          })()}

          {/* The Outstanding ageing used to sit here as a big inline card; it now
              opens from the Outstanding KEY METRICS tile as a right-side drawer
              (matching Purchase). Sales month-by-month moved to BELOW the Customer
              details table — see further down. */}

          {/* Outstanding receivables — ageing in a right-side slide-over, opened
              from the Outstanding KEY METRICS tile (same pattern as Purchase). */}
          <RightDrawer
            open={outstandingDrawer}
            onClose={() => setOutstandingDrawer(false)}
            title="Outstanding receivables"
            subtitle="Unpaid invoices by age — click a bucket to see the invoices behind it">
            {stats?.outstanding_receivables?.ageing?.length > 0 ? (
              <AgeingPanel
                ageing={stats.outstanding_receivables.ageing}
                total={stats.outstanding_receivables.ageing_total}
                asAt={stats.outstanding_receivables.as_at}
                basis={stats.outstanding_receivables.ageing_basis}
                // Inline expand (no popup): each band opens in place to preview its
                // invoices; "View all" REDIRECTS to the Invoices page filtered to
                // that band's unpaid invoices (mirrors Purchase → Bills), rather
                // than opening a popup.
                expandCtx={{ companyId, warehouseId, customerId, productId,
                             period, from: effRange.from, to: effRange.to }}
                onViewAll={(band) => {
                  const p = new URLSearchParams();
                  p.set('age', band);
                  if (companyId) p.set('company', companyId);
                  if (customerId) p.set('customer', customerId);
                  if (warehouseId) p.set('warehouse', warehouseId);
                  if (productId) p.set('product', productId);
                  if (period !== 'all' && effRange.from && effRange.to) {
                    p.set('from', effRange.from); p.set('to', effRange.to);
                  }
                  navigate(`/sales/invoices?${p.toString()}`);
                }}
              />
            ) : (
              <p className="text-sm text-slate-500 p-4">No outstanding receivables for the selected period.</p>
            )}
          </RightDrawer>

          {/* The open band, as a popup over the page — ANALYTICS ONLY. The
              drill-down inside the Outstanding tile keeps its inline strip;
              there the band is one section among several and a dialog on top
              of a dialog would be worse. Here the page underneath is the whole
              dashboard, so the band gets the screen while it is being read.

              Grouped by customer: a band can hold 168 bills, which flat is a
              wall of rows. A short list of names, each expandable to its own
              bills, is the same data arranged so it can be used. */}
          {ageBand && stats?.outstanding_receivables?.ageing?.length > 0 && (
            <AgeingBandPanel
              variant="modal"
              grouped
              bandKey={ageBand}
              companyId={companyId} warehouseId={warehouseId}
              customerId={customerId} productId={productId}
              period={period} from={effRange.from} to={effRange.to}
              onBack={() => openAgeBand(null)}
              onClose={() => openAgeBand(null)}
            />
          )}

          {/* Customer details — full per-customer money view (honours filters) */}
          {(() => {
            const CUST_PAGE_SIZE = 10;
            const q = custSearch.trim().toLowerCase();
            // Company scoping is handled by the top SS/UAI chips; here only the
            // Domestic / Export split (item 24) — export = billed outside India.
            let base = customerBreakdown;
            if (custSeg) base = base.filter(c => custSeg === 'export' ? c.is_export : !c.is_export);
            const odMin = custOverdue === 'any' ? 1 : (custOverdue ? Number(custOverdue) : 0);
            if (odMin) base = base.filter(c => !c.is_creditor && Number(c.overdue_days || 0) >= odMin);
            const rows = q
              ? base.filter(c => (c.customer_name || '').toLowerCase().includes(q)
                  || (c.company_name || '').toLowerCase().includes(q))
              : base;
            // Totals reflect the current search result set.
            // Suppliers (Tally: Sundry Creditors) stay in the LIST — their sales
            // are real sales — but they are never debtors: what we sell them is
            // deducted from what we owe them, on the payables side, as Tally
            // does. So no Outstanding or Overdue figure on their row, and none
            // in the total. Confirmed by the accountant, 5-Oct-2026.
            const tot = rows.reduce((a, c) => {
              const os = c.is_creditor ? 0 : Number(c.outstanding || 0);
              return {
                opening: a.opening + Number(c.opening || 0),
                invoiced: a.invoiced + Number(c.invoiced || 0),
                received: a.received + Number(c.received || 0),
                // outstanding = signed net closing; receivable = only positive
                // (what customers actually owe); overdue = sum of the overdue col.
                outstanding: a.outstanding + os,
                receivable: a.receivable + Math.max(0, os),
                overdue: a.overdue + (c.is_creditor ? 0 : Number(c.overdue || 0)),
              };
            }, { opening: 0, invoiced: 0, received: 0, outstanding: 0, receivable: 0, overdue: 0 });
            const totalPages = Math.max(1, Math.ceil(rows.length / CUST_PAGE_SIZE));
            const cp = Math.min(custPage, totalPages);
            const pageRows = rows.slice((cp - 1) * CUST_PAGE_SIZE, cp * CUST_PAGE_SIZE);
            const exportCust = () => {
              const data2 = rows.map(c => ({
                customer: c.customer_name,
                opening: Number(c.opening || 0).toFixed(2),
                invoiced: Number(c.invoiced || 0).toFixed(2), received: Number(c.received || 0).toFixed(2),
                outstanding: c.is_creditor ? '' : Number(c.outstanding || 0).toFixed(2), overdue: c.is_creditor ? '' : Number(c.overdue || 0).toFixed(2),
                overdue_days: c.is_creditor ? '' : (Number(c.overdue_days || 0) || ''),
                collected_pct: c.collected_pct,
              }));
              data2.push({ customer: 'GRAND TOTAL',
                opening: tot.opening.toFixed(2),
                invoiced: tot.invoiced.toFixed(2), received: tot.received.toFixed(2),
                outstanding: tot.outstanding.toFixed(2), overdue: '', overdue_days: '', collected_pct: '' });
              const meta = buildFilterMeta({
                companyId, companyOptions, productId, productOptions, customerId, customerOptions,
                warehouseId, warehouseOptions: (warehousesRaw || []).map(w => ({ value: w.id, label: w.name || w.warehouse_name || w.code || w.id })),
                periodLabel: data?.period?.label || '', from: data?.period?.from, to: data?.period?.to,
              });
              exportToExcel(data2, [
                { field: 'customer', header: 'Customer' },
                { field: 'opening', header: 'Opening (₹)' },
                { field: 'invoiced', header: 'Invoiced (₹)' }, { field: 'received', header: 'Received (₹)' },
                { field: 'outstanding', header: 'Outstanding (₹)' }, { field: 'overdue', header: 'Overdue (₹)' },
                { field: 'overdue_days', header: 'Overdue (days)' },
                { field: 'collected_pct', header: 'Collected %' },
              ], `customer-details-${data?.period?.from || ''}-to-${data?.period?.to || ''}`, 'Sheet1', null, meta);
              toast.success('Customer details exported!');
            };
            return (
              // Highlighted so the section reads as the page's main table, not
              // another panel (item 8): a violet ring and a tinted header bar.
              <div className="bg-white rounded-xl border border-violet-200 ring-1 ring-violet-100 shadow-sm">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 sm:px-4 py-2 border-b border-violet-100 bg-violet-50/40 rounded-t-xl">
                  <button type="button" onClick={() => setCustOpen(o => !o)} aria-expanded={custOpen}
                    className="flex items-center gap-2 min-w-0 text-left group focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 rounded-lg">
                    <ChevronRight size={14} className={`shrink-0 text-slate-400 transition-transform ${custOpen ? 'rotate-90' : ''}`} />
                    <span className="p-1.5 rounded-lg bg-violet-100 text-violet-700"><Users size={16} /></span>
                    <h3 className="text-sm font-bold text-slate-800 group-hover:text-slate-900">Customer Details</h3>
                    <span className="text-xs text-slate-500 font-medium tabular-nums bg-white border border-violet-100 rounded-full px-1.5">{rows.length}</span>
                    <span className="text-[11px] text-slate-400 hidden sm:inline" title="Invoiced & Received follow the selected period; Outstanding & Overdue are live balances (as of today), so they reconcile to Tally and do not change with the period.">· for the selected period</span>
                  </button>
                  <div className="flex flex-wrap items-center gap-2 justify-end">
                    {/* Company scoping lives in the SS / UAI chips at the top of
                        the page (they re-scope every tile), so a second company
                        filter here would be redundant — only Domestic / Export,
                        which the top chips can't do, stays in the section. */}
                    {/* Domestic / Export (item 24): export = customer billed outside India. */}
                    <div className="flex gap-0.5 bg-slate-100 rounded-md p-0.5 shrink-0" title="Domestic (GST-registered) vs Export (no GSTIN) customers">
                      {[['', 'All'], ['domestic', 'Domestic'], ['export', 'Export']].map(([k, l]) => (
                        <button key={k || 'allseg'} type="button" onClick={() => { setCustSeg(k); setCustPage(1); }}
                          className={`px-2 py-0.5 rounded text-[11px] font-semibold transition ${custSeg === k ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                          {l}
                        </button>
                      ))}
                    </div>
                    {/* Days-overdue filter — parties whose longest-overdue bill is past the chosen age. */}
                    <CustomSelect value={custOverdue} onChange={(e) => { setCustOverdue(e.target.value); setCustPage(1); }} title="Filter by days overdue"
                      className={`border rounded-md px-2 py-1.5 text-xs bg-white shrink-0 ${custOverdue ? 'border-rose-400 text-rose-700 font-semibold' : 'border-slate-300 text-slate-600'}`}>
                      <option value="">All ageing</option>
                      <option value="any">Overdue (1+ days)</option>
                      <option value="30">30+ days</option>
                      <option value="60">60+ days</option>
                      <option value="90">90+ days</option>
                    </CustomSelect>
                    <div className="relative">
                      <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                      <input value={custSearch} onChange={e => { setCustSearch(e.target.value); setCustPage(1); }} placeholder="Search customer / company…"
                        className="w-48 sm:w-60 border border-slate-300 rounded-md pl-8 pr-7 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400" />
                      {custSearch && <button onClick={() => { setCustSearch(''); setCustPage(1); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X size={13} /></button>}
                    </div>
                    <button onClick={exportCust} disabled={rows.length === 0}
                      className={`${CTRL_EXPORT} disabled:opacity-50`}>
                      <Download size={13} /> Excel
                    </button>
                  </div>
                </div>
                {!custOpen ? null : customerBreakdown.length === 0 ? (
                  <p className="text-sm text-slate-400 py-10 text-center">No invoiced customers match the current filters.</p>
                ) : (
                  <>
                  <div className="overflow-x-auto">
                    {/* Compact: smaller cell text + tighter rows, set once on the
                        table so every th/td inherits it (overrides per-cell py). */}
                    <table className="w-full text-[12px] [&_th]:!py-1.5 [&_td]:!py-1.5 [&_th]:!px-3 [&_td]:!px-3">
                      <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-b border-slate-200">
                        <tr className="text-[11px] uppercase tracking-wide text-slate-500">
                          <th className="text-left font-semibold px-4 py-2.5">Customer</th>
                          <th className="text-right font-semibold px-3 py-2.5 whitespace-nowrap" title="Brought-forward balance (opening) — not a period sale">Opening</th>
                          <th className="text-right font-semibold px-3 py-2.5 whitespace-nowrap" title="Invoiced in the selected period">Invoiced</th>
                          <th className="text-right font-semibold px-3 py-2.5 whitespace-nowrap" title="Received against those invoices">Received</th>
                          <th className="text-right font-semibold px-3 py-2.5 whitespace-nowrap" title="What the customer owes you now. A green “Adv” chip instead means the customer is in advance / on account — nothing is due.">
                            Receivable
                            <span className="ml-1 normal-case text-[9px] font-medium text-slate-400" title="Live balance as of today — it reconciles to the Tally closing balance and does NOT change with the period. Invoiced and Received follow the selected period.">live</span>
                          </th>
                          <th className="text-right font-semibold px-3 py-2.5 whitespace-nowrap">
                            Overdue
                            <span className="ml-1 normal-case text-[9px] font-medium text-slate-400" title="Live balance as of today — past-due portion of the outstanding. Does NOT change with the period.">live</span>
                          </th>
                          <th className="text-right font-semibold px-3 py-2.5 whitespace-nowrap" title="How long the customer's longest-overdue unpaid invoice has been past its due date.">Overdue (days)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map((c, i) => {
                          return (
                            <tr key={c.customer_id || i}
                              onClick={c.customer_id ? () => openCustomer(c.customer_id, c.customer_name) : undefined}
                              className={`border-b border-slate-100 ${i % 2 ? 'bg-slate-50/40' : 'bg-white'} ${c.customer_id ? 'hover:bg-indigo-50/70 cursor-pointer' : 'hover:bg-slate-50'}`}>
                              <td className="px-4 py-2.5 font-medium text-slate-800 max-w-[320px] truncate" title={c.customer_name}>
                                <span className="inline-flex items-center gap-1.5">
                                  {c.customer_name}
                                  {/* Which company this row belongs to, in its own colour so SS
                                      and UAI read apart at a glance (item 25). Only shown when BOTH
                                      companies are in view (no company filter), because that is
                                      the only time two rows can share a name — e.g. Greenstar
                                      South exists under SS and under UAI. */}
                                  {!companyId && c.company_short && (
                                    <span className={`shrink-0 text-[9px] font-bold uppercase tracking-wide rounded px-1 py-0.5 border ${CO_BADGE[c.company_short] || 'text-slate-500 bg-slate-50 border-slate-200'}`}>
                                      {c.company_short}
                                    </span>
                                  )}
                                  {c.is_creditor && (
                                    <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-indigo-50 text-indigo-700 border border-indigo-200"
                                      title="A supplier (Tally: Sundry Creditors). Our sales to them are deducted from what we owe them on the purchase side, so they are not a debtor here.">
                                      Supplier
                                    </span>
                                  )}
                                </span>
                              </td>
                              {/* A party can be in CREDIT at the start of the window — they paid
                                  in advance — and Tally shows that opening as "Cr". The test here
                                  was `> 0`, so a negative opening was hidden exactly like a zero
                                  and the row stopped reading across: Tropical Agro Chennai showed
                                  Opening blank, Invoiced 11,96,576, Received 0, yet Outstanding
                                  37,98,092 Cr. The figure was always in the API; only the cell
                                  refused to print it. Two parties in the whole book carry one
                                  (Tropical Agro Chennai -49,94,668 on SS, Tinkas Industries
                                  -6,35,044.25 on UAI); a TRUE zero still shows the dash. fmtBal is
                                  the same formatter the Outstanding column uses, so a credit reads
                                  the same wherever it appears. */}
                              <td className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap ${Number(c.opening) !== 0 ? 'text-slate-500' : 'text-slate-300'}`}>{Number(c.opening) !== 0 ? fmtBal(c.opening) : '—'}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-slate-800 whitespace-nowrap">{fmtINRfull(c.invoiced)}</td>
                              {/* A SUPPLIER's bill is settled by coming off what we OWE them, on
                                  the purchase side, which this module cannot see. Showing only the
                                  cash made a fully-settled bill read as barely collected: SS
                                  Biochem's Shree Ambica Oil Cake Industrises showed Received Rs 536
                                  against Invoiced Rs 58,12,800 and "0%", when Tally's ledger closes
                                  at NIL — Rs 58,12,264 netted against the purchase plus that Rs 536
                                  receipt IS the whole invoice. Sri Lakshmisaraswathi read 6% the
                                  same way. So the cash figure and the collection bar are left blank
                                  on a supplier row and the "netted in payables" marker beside them
                                  carries the meaning. Nothing is hidden that the sales side can
                                  actually answer. */}
                              <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700 whitespace-nowrap">{fmtINRfull(c.received)}</td>
                              <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{(() => {
                                const n = Number(c.outstanding || 0);
                                if (n > 0) return <span className="font-semibold text-orange-700">{fmtINRfull(n)}</span>;
                                if (n < -0.5) return (
                                  <span className="inline-flex items-center gap-1 text-emerald-600 font-medium">
                                    <span className="rounded bg-emerald-50 border border-emerald-200 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide not-italic">Adv</span>
                                    {fmtINRfull(Math.abs(n))}
                                  </span>
                                );
                                return <span className="text-slate-300">—</span>;
                              })()}</td>
                              <td className="px-3 py-2.5 text-right whitespace-nowrap">
                                {Number(c.overdue) > 0 && c.customer_id ? (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); navigate(`/sales/invoices?customer=${encodeURIComponent(c.customer_name)}&overdue=1`); }}
                                    title="View the overdue invoices and how many days each is past due"
                                    className="tabular-nums text-red-600 font-medium hover:underline">
                                    {fmtINRfull(c.overdue)}
                                  </button>
                                ) : (
                                  <span className={`tabular-nums ${Number(c.overdue) > 0 ? 'text-red-600 font-medium' : 'text-slate-300'}`}>{Number(c.overdue) > 0 ? fmtINRfull(c.overdue) : '—'}</span>
                                )}
                              </td>
                              <td className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap ${Number(c.overdue_days) > 0 ? 'text-rose-600 font-semibold' : 'text-slate-300'}`}>{Number(c.overdue_days) > 0 ? `${fmtInt(c.overdue_days)}d` : '—'}</td>
                            </tr>
                          );
                        })}
                        {pageRows.length === 0 && (
                          <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">No customer matches "{custSearch}".</td></tr>
                        )}
                      </tbody>
                      <tfoot>
                        <tr className="bg-slate-100 font-bold border-t-2 border-slate-300">
                          <td className="px-4 py-2.5 text-slate-700 whitespace-nowrap">Grand Total · {rows.length} customer(s)</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-slate-500 whitespace-nowrap">{fmtINRfull(tot.opening)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-slate-800 whitespace-nowrap">{fmtINRfull(tot.invoiced)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700 whitespace-nowrap">{fmtINRfull(tot.received)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-orange-700 whitespace-nowrap">{fmtINRfull(Number(tot.receivable))}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-red-600 whitespace-nowrap">{Number(tot.overdue) > 0 ? fmtINRfull(tot.overdue) : '—'}</td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  {rows.length > CUST_PAGE_SIZE && (
                    <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 text-xs text-slate-500">
                      <span>Showing {(cp - 1) * CUST_PAGE_SIZE + 1} to {Math.min(cp * CUST_PAGE_SIZE, rows.length)} of {rows.length}</span>
                      <div className="flex items-center gap-1">
                        <button onClick={() => setCustPage(cp - 1)} disabled={cp <= 1}
                          className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Previous page"><ChevronLeft size={15} /></button>
                        {Array.from({ length: totalPages }, (_, k) => k + 1).map(p => (
                          <button key={p} onClick={() => setCustPage(p)}
                            className={`min-w-[30px] px-2 py-1 rounded-lg border text-xs font-medium transition ${p === cp ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{p}</button>
                        ))}
                        <button onClick={() => setCustPage(cp + 1)} disabled={cp >= totalPages}
                          className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Next page"><ChevronRight size={15} /></button>
                      </div>
                    </div>
                  )}
                  </>
                )}
              </div>
            );
          })()}


          {/* Sales month by month moved to Reports > Summary (Sales tab), with a
              bar graph, to keep this dashboard compact (items 21, 27). A quiet
              link points there rather than repeating the table here. */}
          {!activeView && stats.sales_by_month?.length > 0 && (
            <div className="mt-3 sm:mt-4">
              <button type="button" onClick={() => navigate('/reports/summary?tab=sales')}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-700 hover:underline">
                <TrendingUp size={14} /> Sales month by month &amp; top customers — in Reports
              </button>
            </div>
          )}
          </>)}



          {/* In-page drill-down panel — full width within the dashboard */}
          {activeView && activeView.kind === 'total_sales' && (
            <TotalSalesModal inline backTo={drillBackTo} period0={period} anchor0={anchor} from0={effRange.from} to0={effRange.to}
              companyId0={companyId} warehouseId0={warehouseId} productId0={productId} customerId0={customerId}
              companyOptions={companyOptions} warehousesRaw={warehousesRaw} productOptions={productOptions}
              customerOptions={customerOptions}
              onClose={closeView} />
          )}
          {activeView && activeView.kind === 'tds' && (
            <SalesTds inline period0={period} anchor0={anchor}
              from0={effRange.from} to0={effRange.to} companyId0={companyId} />
          )}
          {activeView && activeView.kind === 'amount_received' && (
            <AmountReceivedModal inline backTo={drillBackTo} period0={period} anchor0={anchor} from0={effRange.from} to0={effRange.to}
              companyId0={companyId} warehouseId0={warehouseId} customerId0={customerId} productId0={productId}
              companyOptions={companyOptions} warehousesRaw={warehousesRaw} customerOptions={customerOptions}
              onClose={closeView} />
          )}
          {activeView && activeView.kind === 'receivables_buckets' && (
            <BucketsModal inline backTo={drillBackTo} companyId={companyId} warehouseId={warehouseId} customerId={customerId}
              productId={productId} period={period} anchor={anchor} from={effRange.from} to={effRange.to}
              companyOptions={companyOptions} warehousesRaw={warehousesRaw} customerOptions={customerOptions}
              band={activeView.band} onBand={openBand}
              onClose={closeView} />
          )}
          {activeView && ['sales_orders', 'invoices', 'dispatches', 'outstanding_customers', 'debit_notes', 'credit_notes'].includes(activeView.kind) && (
            <RecordsModal inline backTo={drillBackTo} kind={activeView.kind} statusFilter={activeView.statusFilter}
              period={period} anchor={anchor} customFrom={effRange.from} customTo={effRange.to}
              companyId={companyId} warehouseId={warehouseId} productId={productId} customerId={customerId}
              companyOptions={companyOptions} warehousesRaw={warehousesRaw} productOptions={productOptions} customerOptions={customerOptions}
              onClose={closeView} />
          )}
        </>
      )}

      {/* The customer's full statement renders as its own full page via the
          early return at the top of this component (sidebar stays, no overlay). */}
    </MainLayout>
  );
}
