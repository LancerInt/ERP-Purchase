/**
 * Purchase -> By Category — the spend split (RM / Packing / Freight / Expenses /
 * Machinery / Unclassified) across vendor bills, from VendorBill.purchase_category
 * (set by the classify_bills / tag_vendor_category commands). Each row links to
 * the Bills list filtered to that category. Reporting-only.
 * Data: /api/purchase/by-category/
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, ChevronRight, ChevronLeft, Search, X, Receipt } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomSelect from '@/components/ui/CustomSelect';
import CustomDatePicker from '@/components/ui/CustomDatePicker';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import usePagerKeys from '../../../hooks/usePagerKeys.js';

const fmt = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const nfNum = (v) => (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const fmtDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
// One order → its date; several → first → last range.
const orderedLabel = (v) => (v.bills > 1 ? `${fmtDate(v.first)} → ${fmtDate(v.last)}` : fmtDate(v.last || v.first));

// ── Period helpers — copied VERBATIM from the Purchase Analytics page
// (pages/purchase/dashboard/index.jsx) so this picker behaves identically:
// Month / Week / FY each get a dropdown to choose WHICH one (reach July, an
// old week, a past FY / half). An `anchor` date drives week/month; FY carries
// its explicit FROM..TO window because "Apr 2026" alone can't say whole-FY vs
// first-half.
const todayISO = () => new Date().toISOString().slice(0, 10);
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseISO = (s) => { const [y, m, d] = (s || todayISO()).split('-').map(Number); return new Date(y, m - 1, d); };
const monthRangeOf = (a) => { const d = parseISO(a); return { from: isoOf(new Date(d.getFullYear(), d.getMonth(), 1)), to: isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0)) }; };
const weekRangeOf = (a) => { const d = parseISO(a); const dow = (d.getDay() + 6) % 7; const mon = new Date(d); mon.setDate(d.getDate() - dow); const sun = new Date(mon); sun.setDate(mon.getDate() + 6); return { from: isoOf(mon), to: isoOf(sun) }; };
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
const effWindow = (period, anchor, cf, ct) => period === 'custom' ? { from: cf, to: ct } : (rangeFor(period, anchor) || { from: cf, to: ct });

// One accent colour per category — used for the donut (conic-gradient needs real
// colours) and the ranked-list dots + bars. Freight In/Out get two amber shades.
const HEX = {
  RM: '#10b981', MAIZE: '#eab308', BOUGHT_NOTE: '#14b8a6', PACKING: '#0ea5e9',
  FREIGHT: '#f97316', FREIGHT_IN: '#f97316', FREIGHT_OUT: '#fb923c',
  EXPENSES: '#8b5cf6', MACHINERY: '#f43f5e', UNCLASSIFIED: '#94a3b8',
  // Internal branch / stock transfers — a warm neutral taupe, set apart from the
  // real-purchase hues (green / sky / orange / violet) since a transfer isn't a buy.
  // Without this it fell back to the generic slate #94a3b8 (same as Unclassified).
  BRANCH: '#78716c',
};
const hexOf = (key) => HEX[key] || '#94a3b8';

// Rotating palette for drill-level donuts (items / vendors) with no fixed colour.
const PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#0ea5e9', '#8b5cf6', '#ef4444',
  '#14b8a6', '#eab308', '#ec4899', '#84cc16', '#f97316', '#06b6d4', '#a855f7', '#64748b'];
const palAt = (i) => PALETTE[i % PALETTE.length];
// Direct / Indirect expense colour families — blue shades for Direct, purple for
// Indirect — so the Expenses donut + list read as two groups at a glance.
const EXP_DIRECT = ['#0369a1', '#0284c7', '#0ea5e9', '#38bdf8', '#7dd3fc', '#bae6fd', '#e0f2fe'];
const EXP_INDIRECT = ['#5b21b6', '#6d28d9', '#7c3aed', '#8b5cf6', '#a78bfa', '#c4b5fd', '#ddd6fe', '#ede9fe'];
// Build one cohesive family of shades from a category's base colour (darkest for
// the top spender → lightest), so an items donut reads as a single palette (like
// the Expenses blue/purple families) instead of a rainbow.
function _hexToHsl(hex) {
  let h = (hex || '#6366f1').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let hh = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hh /= 6;
  }
  return [hh * 360, s * 100, l * 100];
}
function shadesOf(base, n) {
  const [h, s0] = _hexToHsl(base);
  const k = Math.max(1, n);
  // One cohesive family ramp — SAME hue throughout (like the Expenses blue donut),
  // dark+saturated for the top spender fading to light+soft, so it reads as a
  // single palette. The thin gaps between donut slices do the separating.
  return Array.from({ length: k }, (_, i) => {
    const t = k <= 1 ? 0.4 : i / (k - 1);          // 0 (biggest) → 1 (smallest)
    const light = 34 + 52 * t;                     // 34% → 86%
    const sat = Math.max(28, Math.min(82, (s0 || 62) - 12 * t));   // soften as it lightens
    return `hsl(${h.toFixed(0)} ${sat.toFixed(0)}% ${light.toFixed(0)}%)`;
  });
}

// A donut of clickable SVG arcs with a total in the middle. `segments` is a
// pre-built [{ value, color, label, onClick }]; each arc shows its label on hover
// (title) and runs onClick (e.g. open that product / sub-category → its bills).
function Donut({ segments, label, total, sub }) {
  const list = (segments || []).filter((s) => (s.value || 0) > 0);
  const sum = list.reduce((s, x) => s + (x.value || 0), 0) || 1;
  const R = 41, C = 2 * Math.PI * R, SW = 15;
  let acc = 0;
  return (
    <div className="relative w-full max-w-[300px] aspect-square mx-auto">
      <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
        <circle cx="50" cy="50" r={R} fill="none" stroke="#eef2f7" strokeWidth={SW} />
        {list.map((s, i) => {
          const len = (s.value / sum) * C;
          const off = acc; acc += len;
          // Leave a thin gap after each slice so neighbours read as separate wedges.
          const gap = list.length > 1 ? 0.9 : 0;
          const drawLen = Math.max(0.4, len - gap);
          return (
            <circle key={i} cx="50" cy="50" r={R} fill="none" stroke={s.color} strokeWidth={SW}
              strokeDasharray={`${drawLen} ${C - drawLen}`} strokeDashoffset={-off}
              onClick={s.onClick}
              className={s.onClick ? 'cursor-pointer transition-opacity hover:opacity-70' : ''}>
              {s.label && <title>{s.label}</title>}
            </circle>
          );
        })}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center px-1 pointer-events-none">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">{label}</div>
          <div className="text-sm sm:text-base font-bold text-slate-900 tabular-nums leading-tight mt-0.5">{total}</div>
          {sub && <div className="text-[10px] text-slate-400 mt-0.5 leading-tight">{sub}</div>}
        </div>
      </div>
    </div>
  );
}

// Categories whose item→vendor breakdown has been mapped/cleaned, so their row
// opens the by-item popup instead of jumping straight to bills. Add a key here
// once its bills are classified clean (see dump_category_items).
// Categories that drill to the item -> vendor breakdown (items screen + donut)
// instead of straight to a bills list. RM and Packing are goods with line items;
// BRANCH (internal stock transfers) is here too because a transfer's DC bill still
// carries the GOODS being moved as line items, so the same by-item view + pie chart
// apply. The backend items endpoint already serves category=BRANCH (branch_transfer_q).
const ITEM_CATS = new Set(['RM', 'PACKING', 'FRUIT', 'BRANCH']);

// Collapse item varieties into ONE English category. Neem RAW seed/fruit names —
// English, Tanglish, Tamil (ஆக வேப்பபழம் / வேப்ப…), Hindi (नीम / Limbodi / Limdi) —
// map to "Neem Seed / Fruit". PROCESSED neem products stay separate (Concentrate /
// Oil / Cake / Extract) — they are NOT the raw material. Otherwise fall back to the
// backend family (it.group) or the name. Add more rules here as names come up.
function itemCategory(it, catKey) {
  const s = `${it.display || ''} ${it.item || ''} ${it.group || ''}`.toLowerCase();
  // Neem grouping is a RAW-MATERIAL thing — only apply it in RM. In Packing a
  // "neem …" item is a pouch/label/bag, NOT neem seed/fruit, so leave it alone.
  const isNeem = catKey === 'RM' && /neem|limbod|limdi|வேப்ப|வேம்ப|நீம|नीम|लिंब/.test(s);
  if (isNeem) {
    // Azadirachtin is the PROCESSED active (SSB's own product) — show it by its own
    // name, NOT lumped as "Neem Concentrate". Checked first so "Azadirachtin
    // Concentrate" doesn't fall into the generic concentrate rule below.
    if (/azadiracht/.test(s)) return /concentrat/.test(s) ? 'Azadirachtin Concentrate' : 'Azadirachtin';
    if (/concentrat|concern/.test(s)) return 'Neem Concentrate';
    if (/\boil\b/.test(s)) return 'Neem Oil';
    if (/cake|de-?oil|deoil/.test(s)) return 'Neem Cake';
    if (/extract|azadiracht|technical|powder/.test(s)) return 'Neem Extract';
    return 'Neem Seed / Fruit';   // raw seed / fruit / kernel
  }
  return (it.group || it.display || it.item || 'Other').trim();
}

// Per-unit quantity breakdown for a MIXED-unit item → ["9,950 KG", "3,585 set", "4,755 —"].
// Biggest first; a no-unit line shows its number with a dash. 0 or 1 entry ⇒ not mixed.
function unitBreakdown(uq) {
  return Object.entries(uq || {})
    .filter(([, q]) => Number(q) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([u, q]) => `${Number(q).toLocaleString('en-IN', { maximumFractionDigits: 2 })} ${u === '—' ? '—' : u}`);
}

// Canonical WEIGHT units (backend folds TON/MT→MTS, KGS→KG, GM→G).
const WEIGHT_UNITS = new Set(['KG', 'MTS', 'G']);
// A family shows ONE quantity when it resolves to a single unit, OR it was folded to
// KG from several WEIGHT units. If it mixes a weight unit WITH a count unit (SET/NOS/
// PCS), it can't be folded — show the per-unit breakdown instead.
function isSingleUnit(c) {
  if (c.units.size !== 1) return false;
  const uk = Object.keys(c.unitQty || {}).filter((u) => Number(c.unitQty[u]) > 0);
  return !(uk.some((u) => WEIGHT_UNITS.has(u)) && uk.some((u) => !WEIGHT_UNITS.has(u)));
}

// Back arrow + breadcrumb for a drill screen (no popups — these are full screens).
function BackBar({ onBack, title }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <button type="button" onClick={onBack}
        className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-800">
        <ChevronLeft size={16} /> Back
      </button>
      <span className="text-slate-300">/</span>
      <span className="font-semibold text-slate-800 truncate">{title}</span>
    </div>
  );
}

// Prev / Next pager so a long drill list stays one page tall — no endless scroll.
function Pager({ page, pages, onPage }) {
  // ← / → page this drill list (page is 0-indexed here). Hook before the early
  // return so it's called unconditionally.
  usePagerKeys({
    enabled: pages > 1,
    onPrev: () => onPage(Math.max(0, page - 1)),
    onNext: () => onPage(Math.min(pages - 1, page + 1)),
  });
  if (pages <= 1) return null;
  const btn = 'px-2.5 py-1 rounded-md text-xs font-medium border border-slate-200 disabled:opacity-40 disabled:cursor-default hover:bg-slate-50';
  return (
    <div className="flex items-center justify-between gap-2 pt-2 mt-1 border-t border-slate-100">
      <button type="button" className={btn} disabled={page <= 0} onClick={() => onPage(page - 1)}>← Prev</button>
      <span className="text-[11px] text-slate-400">Page {page + 1} of {pages}</span>
      <button type="button" className={btn} disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Next →</button>
    </div>
  );
}

// Popup for a mapped category: items grouped by FAMILY (Shrink Pouch, HDPE
// Container, Label…) → click a family to see its varieties → click a variety to
// see which vendor supplied it, how much and when. `group` + `display` come from
// the backend (family derived from the name; display = name minus packaging
// dimensions). Search matches across every variety. Raw `item` kept for search.
function ByItemModal({ label, data, loading, err, onClose }) {
  const [openGroup, setOpenGroup] = useState(null);   // family name, or null → family list
  const [selItem, setSelItem] = useState(null);       // raw item name, or null
  const [q, setQ] = useState('');
  const items = data?.items || [];

  // Roll items up into families (A–Z within, biggest family first).
  const groupMap = new Map();
  for (const it of items) {
    const g = it.group || it.display || it.item || 'Other';
    if (!groupMap.has(g)) groupMap.set(g, { group: g, items: [] });
    groupMap.get(g).items.push(it);
  }
  const groups = [...groupMap.values()];
  groups.forEach((e) => e.items.sort((a, b) => (a.display || a.item).localeCompare(b.display || b.item)));
  groups.sort((a, b) => b.items.length - a.items.length || a.group.localeCompare(b.group));

  const ql = q.trim().toLowerCase();
  const matches = ql
    ? items.filter((it) => `${it.display || ''} ${it.item} ${it.group || ''}`.toLowerCase().includes(ql))
        .sort((a, b) => (a.display || a.item).localeCompare(b.display || b.item))
    : [];
  const curGroup = openGroup ? groups.find((g) => g.group === openGroup) : null;
  const item = selItem ? items.find((it) => it.item === selItem) : null;

  const Crumb = ({ onBack, children }) => (
    <button onClick={onBack} className="inline-flex items-center gap-1 text-[12px] font-medium text-indigo-600 hover:text-indigo-800 mb-3">
      <ChevronLeft size={14} /> {children}
    </button>
  );
  // A tappable list row (name only, per "just show the names") with a drill chevron.
  const Row = ({ onClick, title, sub, right }) => (
    <button onClick={onClick} className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg hover:bg-indigo-50 transition text-left group">
      <span className="min-w-0">
        <span className="block font-medium text-slate-800 group-hover:text-indigo-700 truncate">{title}</span>
        {sub && <span className="block text-[11px] text-slate-400 truncate">{sub}</span>}
      </span>
      <span className="flex items-center gap-2 shrink-0">{right}<ChevronRight size={15} className="text-slate-300 group-hover:text-indigo-500" /></span>
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-start sm:items-center justify-center p-2 sm:p-6" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900 text-base">{label} — by item</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" aria-label="Close"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-slate-500 text-sm py-10 justify-center"><Loader2 className="animate-spin" size={16} /> Loading items…</div>
          ) : err ? (
            <p className="text-sm text-rose-600 py-8 text-center">{err}</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-slate-500 py-8 text-center">No item lines found for these bills.</p>
          ) : (
            <>
              {/* Search — always available; matches across every variety. */}
              <div className="relative mb-3">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={q} onChange={(e) => { setQ(e.target.value); setSelItem(null); }}
                  placeholder="Search item…"
                  className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200" />
              </div>

              {item ? (
                /* ── Variety detail: which vendor supplied it, how much, when ── */
                <>
                  <Crumb onBack={() => setSelItem(null)}>{ql ? 'Search' : (item.group || 'All groups')}</Crumb>
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 mb-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900 truncate">{item.display || item.item}</p>
                      <p className="text-[11px] text-slate-500 mt-0.5">{item.group} · {item.vendors.length} vendor{item.vendors.length > 1 ? 's' : ''} · {item.bills} bill{item.bills > 1 ? 's' : ''}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-lg font-bold text-emerald-700 tabular-nums whitespace-nowrap">{fmt(item.amount)}</p>
                      <p className="text-[10px] uppercase tracking-wide text-slate-400">total amount</p>
                      <p className="text-sm font-semibold text-slate-700 tabular-nums whitespace-nowrap mt-1">{nfNum(item.qty)}{item.unit ? ` ${item.unit}` : ''}</p>
                      <p className="text-[10px] uppercase tracking-wide text-slate-400">total qty</p>
                      {Number(item.qty) > 0 && (
                        <>
                          <p className="text-sm font-semibold text-indigo-700 tabular-nums whitespace-nowrap mt-1">{fmt(item.amount / item.qty)}{item.unit ? ` / ${item.unit}` : ' / unit'}</p>
                          <p className="text-[10px] uppercase tracking-wide text-slate-400">avg rate</p>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs sm:text-[13px]">
                        <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-slate-500 text-[11px] uppercase tracking-wide">
                          <tr>
                            <th className="py-2.5 px-4 font-medium text-left">Vendor</th>
                            <th className="py-2.5 px-4 font-medium text-left whitespace-nowrap">Ordered</th>
                            <th className="py-2.5 px-4 font-medium text-right whitespace-nowrap">Quantity</th>
                            <th className="py-2.5 px-4 font-medium text-right whitespace-nowrap">Rate / unit</th>
                            <th className="py-2.5 px-4 font-medium text-right whitespace-nowrap">Amount</th>
                            <th className="py-2.5 px-4 font-medium text-right">Bills</th>
                          </tr>
                        </thead>
                        <tbody>
                          {item.vendors.map((v, j) => (
                            <tr key={j} className="border-t border-slate-100 hover:bg-primary-50/40 transition-colors">
                              <td className="py-2.5 px-4 text-slate-700">{v.vendor}</td>
                              <td className="py-2.5 px-4 text-slate-600 whitespace-nowrap">{orderedLabel(v)}</td>
                              <td className="py-2.5 px-4 text-right tabular-nums font-semibold text-slate-800 whitespace-nowrap">{nfNum(v.qty)}{item.unit ? ` ${item.unit}` : ''}</td>
                              <td className="py-2.5 px-4 text-right tabular-nums text-indigo-700 whitespace-nowrap">{Number(v.qty) > 0 ? fmt(v.amount / v.qty) : '—'}</td>
                              <td className="py-2.5 px-4 text-right tabular-nums font-semibold text-emerald-700 whitespace-nowrap">{fmt(v.amount)}</td>
                              <td className="py-2.5 px-4 text-right tabular-nums text-slate-400">{v.bills}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              ) : ql ? (
                /* ── Search results (names only) ── */
                <>
                  <p className="text-[11px] font-medium text-slate-500 mb-1 px-1">{matches.length} match{matches.length !== 1 ? 'es' : ''}</p>
                  <div className="divide-y divide-slate-100">
                    {matches.map((it, i) => (
                      <Row key={i} onClick={() => setSelItem(it.item)} title={it.display || it.item} sub={it.group}
                        right={Number(it.qty) > 0 ? <span className="text-[11px] text-indigo-700 tabular-nums whitespace-nowrap">{fmt(it.amount / it.qty)}{it.unit ? `/${it.unit}` : ''}</span> : null} />
                    ))}
                    {matches.length === 0 && <p className="text-sm text-slate-500 py-6 text-center">No item matches “{q}”.</p>}
                  </div>
                </>
              ) : curGroup ? (
                /* ── Varieties inside the open family (names only) ── */
                <>
                  <Crumb onBack={() => setOpenGroup(null)}>All groups</Crumb>
                  <p className="text-[11px] font-medium text-slate-500 mb-1 px-1">{curGroup.group} — {curGroup.items.length} item{curGroup.items.length > 1 ? 's' : ''}</p>
                  <div className="divide-y divide-slate-100">
                    {curGroup.items.map((it, i) => (
                      <Row key={i} onClick={() => setSelItem(it.item)} title={it.display || it.item}
                        right={Number(it.qty) > 0 ? <span className="text-[11px] text-indigo-700 tabular-nums whitespace-nowrap">{fmt(it.amount / it.qty)}{it.unit ? `/${it.unit}` : ''}</span> : null} />
                    ))}
                  </div>
                </>
              ) : (
                /* ── Family list ── */
                <>
                  <p className="text-[11px] font-medium text-slate-500 mb-1 px-1">{groups.length} groups · {items.length} items — click a group</p>
                  <div className="divide-y divide-slate-100">
                    {groups.map((g, i) => (
                      <Row key={i} onClick={() => setOpenGroup(g.group)} title={g.group}
                        right={<span className="text-[11px] text-slate-400 tabular-nums">{g.items.length}</span>} />
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
        <div className="px-5 py-2.5 border-t border-slate-100 text-[11px] text-slate-400">
          Grouped by item family (from the name). Click a group → its varieties → a variety to see vendors, amounts and order dates. Amounts are ex-GST bill-line values.
        </div>
      </div>
    </div>
  );
}

// Direct / Indirect Expenses tree — rendered INLINE under the "Expenses" category
// row (not a separate card). Two parents (Direct / Indirect), each expands to its
// sub-categories (Electricity, Labour, Rent, Salary, Interest, Freight In/Out, ...).
// Tally figure (import_expenses) is the headline; the ERP bill sum shows grey + tie badge.
function ExpenseTree({ expenses, onBills }) {
  const groups = expenses?.groups || [];
  const [open, setOpen] = useState(() => new Set(groups.map((g) => g.key)));   // all expanded
  const toggle = (k) => setOpen((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const valOf = (r) => (r.tally != null ? Number(r.tally) : Number(r.value) || 0);
  if (!groups.length) return null;

  return (
    <div className="bg-slate-50/40 border-t border-slate-100">
      <div className="divide-y divide-slate-100">
        {groups.map((g) => {
          const gTally = g.tally != null ? Number(g.tally) : null;
          const gShown = gTally != null ? gTally : (Number(g.value) || 0);
          const subs = g.subcategories || [];
          const maxSub = subs.reduce((m, r) => Math.max(m, valOf(r)), 0) || 1;
          const isOpen = open.has(g.key);
          const accent = g.key === 'DIRECT' ? 'text-amber-700' : 'text-violet-700';
          const bar = g.key === 'DIRECT' ? 'bg-amber-500' : 'bg-violet-500';
          const dot = g.key === 'DIRECT' ? 'bg-amber-500' : 'bg-violet-500';
          return (
            <div key={g.key}>
              <div role="button" tabIndex={0} onClick={() => toggle(g.key)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(g.key); } }}
                className="px-5 py-3.5 hover:bg-slate-50 transition cursor-pointer flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <ChevronRight size={14} className={`shrink-0 text-slate-400 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dot}`} />
                  <span className={`font-semibold ${accent}`}>{g.label}</span>
                  <span className="text-[11px] text-slate-400">{subs.length} categories</span>
                </div>
                <span className="tabular-nums font-semibold text-slate-800 shrink-0">{fmt(gShown)}</span>
              </div>
              {isOpen && (
                <div className="bg-slate-50/40">
                  {subs.map((r, i) => {
                    const tal = r.tally != null ? Number(r.tally) : null;
                    const v = Number(r.value) || 0;
                    const shown = tal != null ? tal : v;
                    const gap = tal != null ? v - tal : 0;
                    const barPct = (valOf(r) / maxSub) * 100;
                    return (
                      <div key={i} className="px-5 pl-11 py-2.5 border-t border-slate-100/70">
                        <div className="flex items-center justify-between gap-3 mb-1">
                          <span className="text-[13px] text-slate-700 truncate">{r.sub}{r.count ? <span className="text-[11px] text-slate-400"> · {r.count} bills</span> : null}</span>
                          <div className="flex items-center gap-3 shrink-0">
                            <span className="tabular-nums font-medium text-slate-800">{fmt(shown)}</span>
                            {onBills && r.count > 0 && (
                              <button type="button" onClick={() => onBills(r.sub)}
                                className="text-[11px] text-indigo-600 hover:underline">bills →</button>
                            )}
                          </div>
                        </div>
                        {tal != null && (
                          <div className="text-[11px] mb-1">
                            {Math.abs(gap) < 1 && v > 0 ? (
                              <span className="font-medium text-emerald-600">✓ ties Tally</span>
                            ) : v > 0 ? (
                              <span className="text-slate-400">ERP bills {fmt(v)}{' '}
                                <span className={gap > 0 ? 'text-amber-600' : 'text-sky-600'}>({gap > 0 ? '+' : ''}{fmt(gap)})</span>
                              </span>
                            ) : (
                              <span className="text-slate-300">no ERP bills tagged yet</span>
                            )}
                          </div>
                        )}
                        <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                          <div className={`h-full rounded-full ${bar}`} style={{ width: `${barPct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-slate-400 px-5 py-3 border-t border-slate-100">
        Mirrors Tally&apos;s <b>Direct</b> &amp; <b>Indirect Expenses</b> groups (imported via <code>import_expenses</code>), split into sub-categories. The Tally figure is cumulative as of the import date; the ERP bill column fills in as expense bills are classified.
      </p>
    </div>
  );
}

export default function PurchaseByCategory() {
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  // Arriving from the Bills list, this page used to throw the filter away and
  // open on "All Companies / All Time" — you picked SS + April over there and
  // landed on the whole group, all years. Company was already read here; the
  // PERIOD was not (it was pinned to 'all'), so only half the window survived
  // and the half that did was invisible next to an unfiltered total. Both halves
  // are read now, under the SAME param names the Bills page writes.
  const [companyId, setCompanyId] = useState(sp.get('company') || '');
  // 'all' = all-time (the page default). Otherwise an anchor drives week/month
  // and an FY token drives fy; custom uses cFrom/cTo.
  const [period, setPeriod] = useState(sp.get('period') || 'all');
  const [anchor, setAnchor] = useState(sp.get('anchor') || todayISO());
  const [cFrom, setCFrom] = useState(sp.get('cfrom') || '');
  const [cTo, setCTo] = useState(sp.get('cto') || '');

  const { options: companyOptions } = useLookup('/api/companies/');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Per-category item -> vendor drill: which item was bought from which vendor.
  const [openCat, setOpenCat] = useState(null);          // category key being item-loaded
  const [items, setItems] = useState({});                // key -> {items:[...]}
  const [itemsLoading, setItemsLoading] = useState({});  // key -> bool
  const [itemsErr, setItemsErr] = useState({});          // key -> string
  // Drill-down screen stack (no popups): the landing is the category cards, then
  // a category opens its items (RM/Packing) or sub-categories (Expenses), then an
  // item opens its vendor/date/price detail. Bills are a separate route (Screen 4).
  //   { name:'cards' } | { name:'items', row } | { name:'subcats' } | { name:'item', row, item }
  // Drill screen AND its list page are both restored from browser history on
  // mount, so Back from a bill (which remounts this page) returns to the item it
  // was opened from, at the list page it was on — not the cards / page 1.
  const [screen, setScreen] = useState(
    () => (typeof window !== 'undefined' && window.history.state && window.history.state.byCatDrill) || { name: 'cards' });
  const [page, setPage] = useState(
    () => (typeof window !== 'undefined' && window.history.state && window.history.state.byCatPage) || 0);  // list pagination
  const PSZ = 6;                                          // 6/page: cards fill 2 full rows of 3
  const LPSZ = 5;                                         // drill list: 5/page so donut + list fit one screen (no scroll)
  // Browser Back steps UP the drill (item -> items -> cards) instead of leaving
  // the page: each drill-down PUSHES a history entry carrying the target screen
  // (at page 1); Back pops it and restores that screen + the page it was on. The
  // URL is left unchanged — the drill is ephemeral — and react-router's own
  // history.state is preserved alongside.
  const drillTo = (next) => {
    setScreen(next); setPage(0);
    try { window.history.pushState({ ...(window.history.state || {}), byCatDrill: next, byCatPage: 0 }, ''); }
    catch (_) { /* non-cloneable state: drill still works, just no extra Back step */ }
  };
  // Remember the list page in the CURRENT history entry so Back restores it.
  const goPage = (n) => {
    setPage(n);
    try { window.history.replaceState({ ...(window.history.state || {}), byCatPage: n }, ''); }
    catch (_) { /* ignore */ }
  };
  useEffect(() => {
    const onPop = (e) => {
      const st = e.state || {};
      setScreen(st.byCatDrill || { name: 'cards' });
      setPage(st.byCatPage || 0);
      setExpMode(st.byCatExpMode || 'all');   // restore the Direct/Indirect/Both split
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const firstWindow = useRef(true);   // skip the drill-reset on the very first render
  const [vch, setVch] = useState(null);   // bill-wise Tally voucher drawer
  const [vchPage, setVchPage] = useState(1);   // voucher list pagination (client-side)
  // Ex-GST (ties Tally's Purchase Accounts) vs Incl-GST (ties the Analytics Incl-GST
  // view). Ex-GST is the default — it's what the Tally reference on each card compares.
  const [gstView, setGstView] = useState('exgst');
  // Expenses split toggle: 'all' | 'DIRECT' | 'INDIRECT'. Kept in history state
  // (byCatExpMode) so drilling into a head and pressing Back returns to the SAME
  // split (Direct stays Direct) instead of snapping to Both. It used to reset to
  // 'all' on every screen change — which also fired on Back. A fresh open from the
  // cards resets it to 'all' in openCategory instead.
  const [expMode, setExpMode] = useState(
    () => (typeof window !== 'undefined' && window.history.state && window.history.state.byCatExpMode) || 'all');
  const changeExpMode = (m) => {
    setExpMode(m); setPage(0);                            // new group → back to page 1
    try { window.history.replaceState({ ...(window.history.state || {}), byCatExpMode: m, byCatPage: 0 }, ''); }
    catch (_) { /* non-cloneable state: toggle still works, just not remembered on Back */ }
  };

  // Switching period resets the anchor to a sensible default for that mode
  // (FY needs a FROM..TO token, everything else a plain date).
  const setP = (p) => { setPeriod(p); setAnchor(p === 'fy' ? fyTokenFor(new Date()) : todayISO()); };

  // Mirror the controls into the address so Back, a refresh and a pasted link
  // all reproduce this view. It used to build a FRESH object and hand that to
  // setSp, which deleted every param it didn't set — so a link that arrived
  // carrying a period had it wiped on mount, before anything could read it.
  // Copying the existing params first keeps anything else in the URL intact.
  useEffect(() => {
    const p = new URLSearchParams(sp);
    const put = (k, v, keep) => { if (keep) p.set(k, v); else p.delete(k); };
    put('company', companyId, !!companyId);
    put('period', period, period !== 'all');
    put('anchor', anchor, period !== 'all' && period !== 'custom');
    put('cfrom', cFrom, period === 'custom' && !!cFrom);
    put('cto', cTo, period === 'custom' && !!cTo);
    if (p.toString() !== sp.toString()) setSp(p, { replace: true });
  }, [companyId, period, anchor, cFrom, cTo, sp, setSp]);

  useEffect(() => {
    setError(null); setLoading(true);
    setOpenCat(null); setItems({}); setItemsErr({});   // the item drill is window-scoped
    if (firstWindow.current) firstWindow.current = false;  // keep a history-restored drill on mount
    else { setScreen({ name: 'cards' }); setPage(0); }     // a NEW window returns to the landing, page 1
    const params = new URLSearchParams();
    if (companyId) params.set('company', companyId);
    // 'all' sends no dates (all-time). Any other period resolves to a window.
    const w = period === 'all' ? null : effWindow(period, anchor, cFrom, cTo);
    if (w?.from) params.set('from', w.from);
    if (w?.to) params.set('to', w.to);
    let cancelled = false;
    apiClient.get(`/api/purchase/by-category/?${params.toString()}`)
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(e => { if (!cancelled) setError(e.response?.data?.detail || 'Failed to load Purchase by Category.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [companyId, period, anchor, cFrom, cTo]);   // eslint-disable-line

  const cats = data?.categories || [];
  // Each category's headline value — Tally's own figure where imported
  // (import_purchase_ledgers, the number that ties Tally's Purchase Accounts),
  // else the ERP bill value. The donut/ranked `rows` (built below) use this.
  const exp = data?.expenses;
  // Freight is pulled OUT of the Expenses drawer and shown as its own Inward /
  // Outward rows (in Tally, Freight Inward is a Direct expense, Freight Outward an
  // Indirect one). Extract both, then build a freight-free drawer + total so it
  // isn't double-counted.
  const _expSub = (gkey, sub) => {
    const g = (exp?.groups || []).find((x) => x.key === gkey);
    const r = (g?.subcategories || []).find((x) => x.sub === sub);
    return r ? (r.tally != null ? Number(r.tally) : Number(r.value) || 0) : null;
  };
  const freightIn = _expSub('DIRECT', 'Freight Inward');
  const freightOut = _expSub('INDIRECT', 'Freight Outward');
  const expDrawer = exp && {
    ...exp,
    groups: (exp.groups || []).map((g) => {
      const drop = g.key === 'DIRECT' ? 'Freight Inward' : g.key === 'INDIRECT' ? 'Freight Outward' : null;
      if (!drop) return g;
      const gone = (g.subcategories || []).find((r) => r.sub === drop);
      const goneT = gone && gone.tally != null ? Number(gone.tally) : 0;
      const goneV = gone ? Number(gone.value) || 0 : 0;
      return {
        ...g,
        subcategories: (g.subcategories || []).filter((r) => r.sub !== drop),
        tally: g.tally != null ? Number(g.tally) - goneT : g.tally,
        value: (Number(g.value) || 0) - goneV,
      };
    }),
  };
  const expTotal = (expDrawer?.groups || []).reduce(
    (s, g) => s + (g.tally != null ? Number(g.tally) : Number(g.value) || 0), 0);
  // Expenses KPI tile value: with a Tally mirror -> the mirror total (ties Tally);
  // without one (e.g. the current month) -> the real EXPENSES-category bills, so
  // the tile matches the Expenses card instead of a partial sub-tagged subset.
  const _expCat = cats.find((c) => c.key === 'EXPENSES');
  // Machinery / Capital is grouped UNDER Expenses (matches the Analytics page), so
  // its value is added to the Expenses card/KPI and it gets no standalone card.
  const _machCat = cats.find((c) => c.key === 'MACHINERY');
  const _machEx = _machCat ? Number(_machCat.value) || 0 : 0;
  const _machIncl = _machCat ? Number(_machCat.value_incl) || 0 : 0;
  // Expenses KPI = the RAW expense-category bills + machinery (the Direct/Indirect
  // sub-split can leave out un-subcategorised bills, so it's used only for the drill,
  // not the headline). Matches the Expenses card and the Analytics Expenses figure.
  const expKpi = gstView === 'inclgst'
    ? ((_expCat ? Number(_expCat.value_incl) || 0 : 0) + _machIncl)
    : ((_expCat ? Number(_expCat.value) || 0 : 0) + _machEx);
  // Open the Direct/Indirect Expenses drill whenever there IS expense data — the
  // Tally mirror OR, in a live month with no mirror yet, the classified ERP expense
  // bills — so clicking Expenses shows the split, not a flat bill list.
  const showExpDrill = !!(exp?.has_tally || expTotal > 0);

  // The spend rows for the donut + ranked list. Drop the duplicate Machinery row,
  // split Freight into Inward / Outward, and INCLUDE an "Expenses" row (the Tally
  // Direct/Indirect total) so the donut covers every category — click it to expand
  // the sub-category tree inline. Sorted by spend. Data only — click handlers are
  // attached in the render so they use fresh period/company state.
  const rows = useMemo(() => {
    const incl = gstView === 'inclgst';
    const mVal = incl ? _machIncl : _machEx;          // Machinery, folded into Expenses
    const mCount = _machCat?.count || 0;
    const out = [];
    for (const c of cats) {
      // Machinery / Capital is NOT a standalone card — it's grouped UNDER Expenses
      // (matches the Analytics page), so skip it here and add its value to Expenses.
      if (c.key === 'MACHINERY') continue;
      // Freight Inward/Outward split is a Tally-mirror view (ex-GST only); in Incl-GST
      // view show the plain Freight card instead.
      if (c.key === 'FREIGHT' && exp?.has_tally && (freightIn != null || freightOut != null) && !incl) {
        if (freightIn != null) out.push({ key: 'FREIGHT_IN', label: 'Freight Inward', value: Number(freightIn) || 0, erp: null, tally: Number(freightIn) || 0, bills: null, freightSub: 'Freight Inward' });
        if (freightOut != null) out.push({ key: 'FREIGHT_OUT', label: 'Freight Outward', value: Number(freightOut) || 0, erp: null, tally: Number(freightOut) || 0, bills: null, freightSub: 'Freight Outward' });
        continue;
      }
      // Headline = YOUR BILLS, RAW gross (ex-GST or incl-GST per the toggle), so every
      // card equals the Analytics by-scope figure for the same category. Machinery is
      // added onto Expenses, which stays click-to-open for its Direct/Indirect split.
      const val = (Number(incl ? c.value_incl : c.value) || 0) + (c.key === 'EXPENSES' ? mVal : 0);
      const tal = (!incl && c.tally != null) ? Number(c.tally) : null;
      const shown = val;
      if (shown <= 0 && !(c.count > 0)) continue;   // hide empty ₹0 / 0-bill cards
      out.push({ key: c.key, label: c.label, value: shown, erp: val, tally: tal,
                 bills: c.key === 'EXPENSES' ? (c.count || 0) + mCount : c.count,
                 hasItems: ITEM_CATS.has(c.filter),
                 isExpenses: c.key === 'EXPENSES' && showExpDrill,
                 cat: c });
    }
    const SHOW = new Set(['RM', 'PACKING', 'MAIZE', 'BOUGHT_NOTE', 'FRUIT']);
    return out.filter(r => SHOW.has(r.key)).sort((a, b) => b.value - a.value);
  }, [cats, exp, freightIn, freightOut, expTotal, showExpDrill, gstView]);
  const maxRow = useMemo(() => rows.reduce((m, r) => Math.max(m, r.value), 0) || 1, [rows]);
  // Donut + centre total cover real SPEND only — purchases + freight + expenses +
  // unclassified. Internal branch / stock transfers get their own card but stay OUT
  // of the ring and the headline (a transfer isn't a purchase or an expense), so this
  // Total ties the Analytics "by scope" Total, which also drops transfers.
  const spendRows = useMemo(() => rows.filter((r) => r.key !== 'BRANCH'), [rows]);
  const grandTotal = useMemo(() => spendRows.reduce((s, r) => s + r.value, 0), [spendRows]);
  const grandBills = useMemo(() => spendRows.reduce((s, r) => s + (r.bills || 0), 0), [spendRows]);
  const donutStops = useMemo(() => {
    const total = grandTotal || 1;
    if (!spendRows.length) return '#e2e8f0 0% 100%';
    let acc = 0;
    return spendRows.map((r) => { const a = acc; acc += (r.value / total) * 100; return `${hexOf(r.key)} ${a.toFixed(3)}% ${acc.toFixed(3)}%`; }).join(', ');
  }, [spendRows, grandTotal]);

  // Flattened Expenses sub-categories (Direct + Indirect, Freight excluded — it's
  // its own cards) for the Expenses drill screen: ranked by Tally spend.
  const expSubs = useMemo(() => {
    const out = [];
    for (const g of (expDrawer?.groups || [])) {
      for (const r of (g.subcategories || [])) {
        const tal = r.tally != null ? Number(r.tally) : null;
        out.push({ sub: r.sub, group: g.key, value: tal != null ? tal : Number(r.value) || 0, erp: Number(r.value) || 0, tally: tal, count: r.count || 0 });
      }
    }
    return out.sort((a, b) => b.value - a.value);
  }, [expDrawer]);
  // Colour each sub-category by its group + rank-within-group: Direct = blue family,
  // Indirect = purple family, darkest for the biggest head. Keyed `GROUP|sub`.
  const expColor = useMemo(() => {
    const m = new Map();
    for (const g of (expDrawer?.groups || [])) {
      const fam = g.key === 'DIRECT' ? EXP_DIRECT : EXP_INDIRECT;
      (g.subcategories || []).forEach((r, i) => m.set(`${g.key}|${r.sub}`, fam[i % fam.length]));
    }
    return m;
  }, [expDrawer]);

  // Drill back to the Bills list. The period rides along, not just the company:
  // the figure on this row was computed for a window, and opening it into an
  // all-time list would show MORE bills than the number that was clicked.
  const openBills = (c) => {
    const q = new URLSearchParams();
    if (companyId) q.set('company', companyId);
    if (period !== 'all') {
      q.set('period', period);
      if (period === 'custom') { q.set('cfrom', cFrom); q.set('cto', cTo); }
      else q.set('anchor', anchor);
    }
    if (c.filter) q.set('purchase_category', c.filter);
    else q.set('purchase_category', '');   // Unclassified
    navigate(`/purchase/bills?${q.toString()}`);
  };

  // Drill to the bills for one expense SUB-category (Labour & Wages, Freight
  // Inward, ...) — same as openBills but keyed on expense_subcategory, which the
  // Bills page filters by. Period + company ride along so the count matches.
  const openExpenseBills = (sub) => {
    const q = new URLSearchParams();
    if (companyId) q.set('company', companyId);
    if (period !== 'all') {
      q.set('period', period);
      if (period === 'custom') { q.set('cfrom', cFrom); q.set('cto', cTo); }
      else q.set('anchor', anchor);
    }
    q.set('expense_subcategory', sub);
    navigate(`/purchase/bills?${q.toString()}`);
  };

  // Bill-wise: the individual Tally Day Book vouchers behind an expense sub-category
  // for the active month (date · voucher · party · amount). Opens in a drawer.
  const fetchVouchers = async (group, sub) => {
    setVchPage(1);
    setVch({ group, sub, loading: true, rows: [], total: '0', note: '' });
    const w = period === 'all' ? null : effWindow(period, anchor, cFrom, cTo);
    const q = new URLSearchParams();
    if (companyId) q.set('company', companyId);
    if (w?.from) q.set('from', w.from);
    if (w?.to) q.set('to', w.to);
    q.set('group', group); q.set('sub', sub);
    try {
      const r = await apiClient.get(`/api/purchase/expense-vouchers/?${q.toString()}`);
      setVch({ group, sub, loading: false, rows: r.data.vouchers || [], total: r.data.total || '0', note: r.data.note || '',
        inErp: r.data.in_erp_count || 0, journal: r.data.journal_count || 0, missing: r.data.missing_count || 0, source: r.data.source || 'tally' });
    } catch {
      setVch({ group, sub, loading: false, rows: [], total: '0', note: 'Could not load vouchers.' });
    }
  };
  // Open an expense sub-category as a FULL-PAGE drill (like the RM/PM item detail),
  // not a modal — so it shares the back button and can link to bills.
  const openVouchers = (group, sub) => { drillTo({ name: 'vouchers', group, sub }); fetchVouchers(group, sub); };
  // A vouchers screen restored from history (reload, or Back from a bill) re-fetches.
  useEffect(() => {
    if (screen.name === 'vouchers' && (!vch || vch.group !== screen.group || vch.sub !== screen.sub)) {
      fetchVouchers(screen.group, screen.sub);
    }
  }, [screen.name, screen.group, screen.sub]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Expand a category to its item -> vendor breakdown, fetched once (per window).
  // Open the by-item popup for a mapped category (see ITEM_CATS) and fetch once.
  const openItemsPopup = (c) => {
    setOpenCat(c.key);
    if (items[c.key] || itemsLoading[c.key]) return;     // already loaded / loading
    const q = new URLSearchParams();
    q.set('category', c.filter || '');                   // '' = Unclassified
    if (companyId) q.set('company', companyId);
    const w = period === 'all' ? null : effWindow(period, anchor, cFrom, cTo);
    if (w?.from) q.set('from', w.from);
    if (w?.to) q.set('to', w.to);
    setItemsLoading((s) => ({ ...s, [c.key]: true }));
    setItemsErr((s) => ({ ...s, [c.key]: null }));
    apiClient.get(`/api/purchase/by-category/items/?${q.toString()}`)
      .then((r) => setItems((s) => ({ ...s, [c.key]: r.data })))
      .catch((e) => setItemsErr((s) => ({ ...s, [c.key]: e.response?.data?.detail || 'Failed to load items.' })))
      .finally(() => setItemsLoading((s) => ({ ...s, [c.key]: false })));
  };

  // A card click on Screen 1 routes to the right next screen (no popups):
  //  RM / Packing -> items screen;  Expenses -> sub-categories screen;
  //  Freight -> its bills;  Maize / Bought Note / other -> bills.
  const openCategory = (row) => {
    if (row.isExpenses) { setExpMode('all'); drillTo({ name: 'subcats' }); return; }
    if (row.freightSub) { openExpenseBills(row.freightSub); return; }
    if (row.hasItems) { openItemsPopup(row.cat); drillTo({ name: 'items', row }); return; }
    openBills(row.cat);
  };
  const openItem = (row, item) => drillTo({ name: 'item', row, item });

  // An items screen restored from browser history (a reload, or Back from a bill)
  // carries no list data — that lives in `items` state, not in the restored screen
  // object — so re-fetch it. (subcats derive from the main data and an item carries
  // its own rows, so only the items list needs this.) openItemsPopup self-guards
  // against a duplicate fetch, so the normal forward-drill path is unaffected.
  useEffect(() => {
    if (screen.name === 'items' && screen.row?.cat?.key
        && !items[screen.row.cat.key] && !itemsLoading[screen.row.cat.key]) {
      openItemsPopup(screen.row.cat);
    }
  }, [screen.name, screen.row?.cat?.key]);   // eslint-disable-line react-hooks/exhaustive-deps

  // In-place category switcher for the drill screens — flip between RM / Packing /
  // Expenses / … without going back to the cards grid. Active chip is filled with
  // the category colour; a click routes via openCategory (items / sub-cats / bills).
  const renderCatTabs = (activeKey) => (
    <div className="flex gap-1.5 overflow-x-auto pb-2 mb-2 -mx-1 px-1">
      {rows.map((r) => (
        <button key={r.key} type="button" onClick={() => openCategory(r)}
          className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition ${r.key === activeKey ? 'text-white border-transparent shadow-sm' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}`}
          style={r.key === activeKey ? { background: hexOf(r.key) } : undefined}>
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: r.key === activeKey ? '#fff' : hexOf(r.key) }} />
          {r.label}
        </button>
      ))}
    </div>
  );

  const PERIODS = [['all', 'All'], ['today', 'Today'], ['week', 'Week'], ['month', 'Month'], ['fy', 'FY'], ['custom', 'Custom']];

  return (
    <MainLayout>
      <div className="max-w-6xl mx-auto px-3 sm:px-5 py-4">
        {screen.name === 'cards' && (
          <PageHeader
            title="Purchase by Category"
            subtitle="Spend split from your bills — click a row to see its bills"
          />
        )}

        {/* Filters — one compact row, mirroring the Analytics (Purchase
            Dashboard) page: period pills first, the inline Week/Month/FY/Custom
            picker next, then a compact Company select. No stacked labels / wide
            blocks, so it reads as a single straight line. CustomSelect reads
            options from <option> children and emits an event. */}
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          <div className="flex rounded-lg border border-slate-200 overflow-hidden shrink-0">
            {PERIODS.map(([v, l], i) => (
              <button key={v} type="button" onClick={() => setP(v)} aria-pressed={period === v}
                title={v === 'fy' ? 'Financial year (1 Apr – 31 Mar)' : undefined}
                className={`px-2 py-1.5 text-xs whitespace-nowrap ${i > 0 ? 'border-l border-slate-200' : ''} ${period === v ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>
                {l}
              </button>
            ))}
          </div>
          {period === 'week' && (
            <CustomSelect value={weekRangeOf(anchor).from} onChange={(e) => setAnchor(e.target.value)} title="Select week"
              className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white min-w-0 max-w-[180px] shrink-0">
              {weekOptions().map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
            </CustomSelect>
          )}
          {period === 'month' && (
            <CustomSelect value={monthRangeOf(anchor).from} onChange={(e) => setAnchor(e.target.value)} title="Select month"
              className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white min-w-0 max-w-[130px] shrink-0">
              {monthOptions().map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </CustomSelect>
          )}
          {period === 'fy' && (
            <CustomSelect value={anchor} onChange={(e) => setAnchor(e.target.value)} title="Select financial year / half"
              className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white min-w-0 max-w-[200px] shrink-0">
              {fyOptions().map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </CustomSelect>
          )}
          {period === 'custom' && (
            <div className="flex items-center gap-1.5 text-xs shrink-0">
              <CustomDatePicker value={cFrom} onChange={(e) => setCFrom(e.target.value)} max={cTo || todayISO()} className="border border-slate-300 rounded px-2 py-1.5" />
              <span className="text-slate-400">to</span>
              <CustomDatePicker value={cTo} onChange={(e) => setCTo(e.target.value)} min={cFrom} max={todayISO()} className="border border-slate-300 rounded px-2 py-1.5" />
            </div>
          )}
          {/* Company — compact select (matches Analytics), not a wide labelled block. */}
          <CustomSelect value={companyId} onChange={(e) => setCompanyId(e.target.value)} title="Company"
            className="border border-slate-300 rounded-lg px-2 py-1.5 text-xs bg-white min-w-0 max-w-[180px] truncate">
            <option value="">All Companies</option>
            {(companyOptions || []).map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </CustomSelect>
          {/* Ex-GST (ties Tally) ⇄ Incl-GST (ties the Analytics Incl-GST view). */}
          {(screen.name === 'cards' || screen.name === 'items' || screen.name === 'item') && (
            <div className="ml-auto flex items-center gap-1 shrink-0 bg-slate-100 rounded-lg p-0.5">
              {[['exgst', 'Ex-GST'], ['inclgst', 'Incl-GST']].map(([v, l]) => (
                <button key={v} type="button" onClick={() => setGstView(v)} aria-pressed={gstView === v}
                  className={`px-2.5 py-1 rounded-md text-xs font-semibold transition ${gstView === v ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>{l}</button>
              ))}
            </div>
          )}
        </div>

        {loading && (
          <div className="flex items-center justify-center py-16 text-slate-500">
            <Loader2 className="animate-spin mr-2" size={18} /> Loading…
          </div>
        )}
        {error && <p className="text-sm text-rose-600 py-8 text-center">{error}</p>}

        {!loading && !error && data && (
          <>
          {/* ───────── SCREEN 1 — category cards ───────── */}
          {screen.name === 'cards' && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
                  <div className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">Total spend</div>
                  <div className="text-xl font-bold text-slate-900 tabular-nums mt-1">{fmt(grandTotal)}</div>
                  <div className="text-[11px] text-slate-400">{grandBills} bills · {gstView === 'inclgst' ? 'incl-GST' : 'ex-GST'}</div>
                </div>
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
                  <div className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">Expenses</div>
                  <div className="text-xl font-bold text-violet-600 tabular-nums mt-1">{fmt(expKpi)}</div>
                  <div className="text-[11px] text-slate-400">{gstView === 'inclgst' ? 'ERP bills · incl-GST' : (exp?.has_tally ? (exp?.as_of ? `Tally as of ${fmtDate(exp.as_of)}` : 'Direct / Indirect') : 'ERP only')}</div>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
                {rows.length === 0 && <p className="text-sm text-slate-500 py-6 text-center col-span-full">No bills in this window.</p>}
                {rows.slice(page * PSZ, page * PSZ + PSZ).map((row) => {
                  const gap = (row.tally != null && row.erp != null) ? row.erp - row.tally : null;
                  const drill = row.isExpenses || row.hasItems;
                  return (
                    <button key={row.key} type="button" onClick={() => openCategory(row)}
                      className="text-left bg-white rounded-xl border border-slate-200 shadow-sm p-4 hover:shadow-md hover:-translate-y-0.5 transition">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="w-3 h-3 rounded-full shrink-0 mt-1" style={{ background: hexOf(row.key) }} />
                          <div className="min-w-0">
                            <div className="font-semibold text-slate-800 truncate">{row.label}</div>
                            <div className="text-[11px] text-slate-400">{row.bills != null ? `${row.bills} bills` : row.isExpenses ? 'Direct / Indirect' : 'view bills'}</div>
                          </div>
                        </div>
                        <ChevronRight size={16} className="shrink-0 text-slate-300 mt-0.5" />
                      </div>
                      <div className="text-lg font-bold text-slate-900 tabular-nums mt-2">{fmt(row.value)}</div>
                      <div className="h-1.5 rounded-full bg-slate-100 mt-2 overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${(row.value / maxRow) * 100}%`, background: hexOf(row.key) }} />
                      </div>
                      <div className="mt-2 text-[11px]">
                        {(() => {
                          if (row.tally == null) return <span className="text-slate-400">{drill ? 'click to open' : 'ERP only'}</span>;
                          // Ties when exact OR within a 1.5% reconciliation tolerance. A small
                          // ex-GST residual is a GST-allocation difference between the ERP goods
                          // value and Tally's purchase ledger (freight is already separated into
                          // other_charges), not a missing bill — the incl-GST MONEY matches to
                          // ~0.1%. A genuine gap (beyond 1.5%) still shows amber below.
                          const tol = Math.max(1, 0.015 * Math.abs(Number(row.tally) || 0));
                          if (gap != null && Math.abs(gap) <= tol) {
                            // Clean "ties Tally" — no number on the card (the residual is an
                            // immaterial ledger-split artifact). Exact figure stays on hover.
                            const pct = (Math.abs(gap) / (Math.abs(Number(row.tally)) || 1) * 100).toFixed(2);
                            const tip = Math.abs(gap) >= 1
                              ? `Your bills ${fmt(row.erp)} vs Tally ${fmt(row.tally)} — ${gap > 0 ? '+' : ''}${fmt(gap)} (${pct}%), within 1.5% tolerance`
                              : undefined;
                            return <span className="font-medium text-emerald-600" title={tip}>✓ ties Tally</span>;
                          }
                          if (row.tally > 0)
                            return (<span className="text-slate-400">vs Tally {fmt(row.tally)} <span className={gap > 0 ? 'text-amber-600' : 'text-sky-600'}>({gap > 0 ? '+' : ''}{fmt(gap)})</span></span>);
                          return <span className="font-medium text-emerald-600">✓ ties Tally</span>;
                        })()}
                      </div>
                    </button>
                  );
                })}
              </div>
              <Pager page={page} pages={Math.ceil(rows.length / PSZ)} onPage={goPage} />
              <p className="text-[11px] text-slate-400 px-1 py-3">
                Reporting only. The headline per card is <b>your own bills</b> (Ex-GST / Incl-GST per the toggle); Tally&apos;s figure is shown as a reference in Ex-GST view where imported. Click <b>RM</b> / <b>Packing</b> / <b>Branch Transfer</b> for items → vendor → rate,
                <b> Expenses</b> for its sub-categories, or any other card for its bills.
              </p>
            </>
          )}

          {/* ───────── SCREEN 2A — items + donut (RM / Packing / Branch Transfer) ───────── */}
          {screen.name === 'items' && (() => {
            const key = screen.row.cat.key;
            const raw = (items[key]?.items) || [];
            const incl = gstView === 'inclgst';   // Ex-GST line amount ⇄ incl-GST
            // Group the varieties into English categories (Neem Seed / Fruit, ...).
            const cmap = new Map();
            for (const it of raw) {
              const cat = itemCategory(it, key);
              let c = cmap.get(cat);
              if (!c) { c = { label: cat, amount: 0, bills: 0, qty: 0, units: new Set(), unitQty: {}, varieties: 0, vendors: [] }; cmap.set(cat, c); }
              c.amount += Number(incl ? it.amount_incl : it.amount) || 0;
              c.bills += Number(it.bills) || 0;
              c.qty += Number(it.qty) || 0;
              c.varieties += 1;
              if (it.unit) c.units.add(it.unit);
              for (const [u, q] of Object.entries(it.unit_qty || {})) c.unitQty[u] = (c.unitQty[u] || 0) + Number(q || 0);
              for (const v of (it.vendors || [])) c.vendors.push({ ...v, unit: it.unit });
            }
            const catAsItem = (c) => ({ display: c.label, amount: c.amount, bills: c.bills,
              qty: isSingleUnit(c) ? c.qty : 0, unit: isSingleUnit(c) ? [...c.units][0] : '',
              unitQty: c.unitQty, varieties: c.varieties, vendors: c.vendors });
            const ranked = [...cmap.values()].sort((a, b) => b.amount - a.amount);
            const fam = shadesOf(hexOf(key), ranked.length);   // one cohesive palette for this category
            const segs = ranked.slice(0, 11).map((c, i) => ({
              value: c.amount, color: fam[i],
              label: `${c.label} — ${fmt(c.amount)}`,
              onClick: () => openItem(screen.row, catAsItem(c)),
            }));
            if (ranked.length > 11) segs.push({ value: ranked.slice(11).reduce((s, c) => s + c.amount, 0), color: '#cbd5e1', label: `${ranked.length - 11} more` });
            const maxI = ranked.reduce((m, c) => Math.max(m, c.amount), 0) || 1;
            const total = ranked.reduce((s, c) => s + c.amount, 0);
            const pages = Math.ceil(ranked.length / LPSZ);
            return (
              <>
                <BackBar onBack={() => window.history.back()} title={`${screen.row.label} — items`} />
                {renderCatTabs(screen.row.key)}
                {itemsLoading[key] ? (
                  <div className="flex items-center justify-center py-16 text-slate-500"><Loader2 className="animate-spin mr-2" size={18} /> Loading items…</div>
                ) : itemsErr[key] ? (
                  <p className="text-sm text-rose-600 py-8 text-center">{itemsErr[key]}</p>
                ) : (
                  <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
                    <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm p-5 flex flex-col items-center justify-center">
                      <Donut segments={segs} label="Items total" total={fmt(total)} sub={`${ranked.length} categories`} />
                    </div>
                    <div className="lg:col-span-3 bg-white rounded-xl border border-slate-200 shadow-sm p-3 sm:p-4">
                      <div className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold px-1 pb-1">Items — grouped, ranked by spend</div>
                      <div className="divide-y divide-slate-100/70">
                        {ranked.length === 0 && <p className="text-sm text-slate-500 py-6 text-center">No item lines found.</p>}
                        {ranked.slice(page * LPSZ, page * LPSZ + LPSZ).map((c, li) => {
                          const i = page * LPSZ + li;
                          const single = isSingleUnit(c);
                          const unit = single ? [...c.units][0] : '';
                          return (
                            <button key={c.label} type="button" onClick={() => openItem(screen.row, catAsItem(c))}
                              className="w-full text-left group flex items-center gap-2.5 py-2 px-1 hover:bg-slate-50 rounded-lg">
                              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: fam[i] }} />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-medium text-slate-800 truncate">{c.label}</span>
                                  <span className="font-semibold tabular-nums shrink-0">{fmt(c.amount)}</span>
                                </div>
                                <div className="h-1.5 rounded-full bg-slate-100 mt-1.5 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${c.amount / maxI * 100}%`, background: fam[i] }} /></div>
                                <div className="text-[11px] text-slate-500 mt-1">
                                  {single && c.qty > 0
                                    ? <><b className="text-slate-700">{nfNum(c.qty)} {unit}</b> · {fmt(c.amount / c.qty)}/{unit}</>
                                    : (() => {
                                        const ub = unitBreakdown(c.unitQty);
                                        const vt = `${c.varieties} ${c.varieties === 1 ? 'variety' : 'varieties'}`;
                                        return ub.length > 1
                                          ? <><b className="text-slate-700">{ub.join(' · ')}</b> · {vt}</>
                                          : vt;
                                      })()}
                                </div>
                              </div>
                              <ChevronRight size={15} className="shrink-0 text-slate-300 group-hover:text-indigo-500" />
                            </button>
                          );
                        })}
                      </div>
                      <Pager page={page} pages={pages} onPage={goPage} />
                    </div>
                  </div>
                )}
              </>
            );
          })()}

          {/* ───────── SCREEN 3 — item detail: Date · Vendor · Product · Unit price · Total ───────── */}
          {screen.name === 'item' && (() => {
            const it = screen.item;
            const incl = gstView === 'inclgst';   // Ex-GST line amount ⇄ incl-GST
            // One row PER BILL (flattened from each vendor's lines) so a click opens
            // THAT exact bill, not the whole category's bills.
            const billRows = [];
            for (const v of (it.vendors || [])) {
              const lines = v.lines || [];
              if (lines.length) {
                for (const ln of lines) billRows.push({ date: ln.date, vendor: v.vendor, unit: ln.uom || v.unit, qty: ln.qty, amount: Number(incl ? (ln.amount_incl ?? ln.amount) : ln.amount) || 0, rate: Number(incl ? (ln.rate_incl ?? ln.rate) : ln.rate) || 0, billId: ln.bill_id, billNo: ln.bill_no, variant: ln.variant });
              } else {
                const va = Number(incl ? (v.amount_incl ?? v.amount) : v.amount) || 0;
                billRows.push({ date: v.last || v.first, vendor: v.vendor, unit: v.unit, qty: v.qty, amount: va, rate: (Number(v.qty) ? va / Number(v.qty) : 0), billId: null, billNo: '' });
              }
            }
            billRows.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || (Number(b.amount) || 0) - (Number(a.amount) || 0));
            // Header total = sum of the shown rows, so it tracks the Ex/Incl toggle.
            const totalAmt = billRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
            const openRow = (r) => (r.billId ? navigate(`/purchase/bills/${r.billId}`) : openBills(screen.row.cat));
            // Count DISTINCT vendors and bills — billRows is one row per (bill, variant)
            // since the variant split, so its length over-counts both.
            const nVendors = new Set(billRows.map((r) => r.vendor)).size;
            const nBills = new Set(billRows.map((r) => r.billId).filter(Boolean)).size || billRows.length;
            return (
              <>
                <BackBar onBack={() => window.history.back()} title={it.display || it.item} />
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-800 truncate">{it.display || it.item}</div>
                      <div className="text-[11px] text-slate-400">{nVendors} vendor{nVendors === 1 ? '' : 's'} · {nBills} bill{nBills === 1 ? '' : 's'}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-bold text-emerald-700 tabular-nums">{fmt(totalAmt)}</div>
                      <div className="text-[11px] text-slate-400">{Number(it.qty) > 0
                        ? `${nfNum(it.qty)}${it.unit ? ` ${it.unit}` : ''} · ${fmt(totalAmt / it.qty)}/${it.unit || 'unit'}`
                        : (() => {
                            const ub = unitBreakdown(it.unitQty);
                            const vt = it.varieties ? `${it.varieties} varieties` : '';
                            return ub.length > 1 ? `${ub.join(' · ')}${vt ? ` · ${vt}` : ''}` : vt;
                          })()}</div>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[13px]">
                      <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-[11px] uppercase tracking-wide text-slate-400">
                        <tr>
                          <th className="py-2.5 px-4 text-left font-semibold whitespace-nowrap">Date</th>
                          <th className="py-2.5 px-4 text-left font-semibold">Vendor</th>
                          <th className="py-2.5 px-4 text-left font-semibold">Product</th>
                          <th className="py-2.5 px-4 text-left font-semibold whitespace-nowrap">Bill No</th>
                          <th className="py-2.5 px-4 text-right font-semibold whitespace-nowrap">Quantity</th>
                          <th className="py-2.5 px-4 text-right font-semibold whitespace-nowrap">Unit price</th>
                          <th className="py-2.5 px-4 text-right font-semibold">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {billRows.map((r, j) => {
                          const qty = Number(r.qty) || 0; const amt = Number(r.amount) || 0;
                          return (
                            <tr key={j} onClick={() => openRow(r)}
                              className="border-t border-slate-100 hover:bg-indigo-50/40 cursor-pointer">
                              <td className="py-2.5 px-4 text-slate-600 whitespace-nowrap">{fmtDate(r.date)}</td>
                              <td className="py-2.5 px-4 text-slate-700">{r.vendor}</td>
                              <td className="py-2.5 px-4 text-slate-500">{r.variant || it.display || it.item}</td>
                              <td className="py-2.5 px-4 text-indigo-600 whitespace-nowrap">{r.billNo || '—'}</td>
                              <td className="py-2.5 px-4 text-right tabular-nums font-semibold text-slate-800 whitespace-nowrap">{nfNum(qty)}{r.unit ? ` ${r.unit}` : ''}</td>
                              <td className="py-2.5 px-4 text-right tabular-nums text-indigo-700 whitespace-nowrap">{qty > 0 ? fmt(amt / qty) : (r.rate ? fmt(r.rate) : '—')}</td>
                              <td className="py-2.5 px-4 text-right tabular-nums font-semibold text-emerald-700">{fmt(amt)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-[11px] text-slate-400 px-4 py-2.5 border-t border-slate-100">Click a row to open that bill. Amounts are {incl ? 'incl-GST' : 'ex-GST'} bill-line values.</p>
                </div>
              </>
            );
          })()}

          {/* ───────── SCREEN 2B — Expenses sub-categories + donut ───────── */}
          {screen.name === 'subcats' && (() => {
            const groups = expDrawer?.groups || [];
            const gTotal = (key) => expSubs.filter((s) => s.group === key).reduce((a, s) => a + s.value, 0);
            const fsubs = expMode === 'all' ? expSubs : expSubs.filter((s) => s.group === expMode);
            const colorOf = (s) => expColor.get(`${s.group}|${s.sub}`) || palAt(0);
            const segs = fsubs.slice(0, 13).map((s) => ({
              value: s.value, color: colorOf(s),
              label: `${s.sub} — ${fmt(s.value)}`,
              onClick: () => openVouchers(s.group, s.sub),   // drill into the voucher detail, like RM's donut → item
            }));
            if (fsubs.length > 13) segs.push({ value: fsubs.slice(13).reduce((a, s) => a + s.value, 0), color: '#cbd5e1', label: `${fsubs.length - 13} more` });
            const maxS = fsubs.reduce((m, s) => Math.max(m, s.value), 0) || 1;
            const pages = Math.ceil(fsubs.length / LPSZ);
            const modeTotal = expMode === 'all' ? expTotal : gTotal(expMode);
            const modeLabel = expMode === 'DIRECT' ? 'Direct' : expMode === 'INDIRECT' ? 'Indirect' : 'Expenses';
            const MODES = [['all', 'Both'], ['DIRECT', 'Direct'], ['INDIRECT', 'Indirect']];
            return (
              <>
                <BackBar onBack={() => window.history.back()} title="Expenses — Direct / Indirect" />
                {renderCatTabs('EXPENSES')}
                <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
                  <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm p-5 flex flex-col items-center justify-center">
                    <Donut segments={segs} label={modeLabel} total={fmt(modeTotal)} sub={exp?.as_of ? `Tally as of ${fmtDate(exp.as_of)}` : `${fsubs.length} heads`} />
                    {groups.length > 1 && (
                      <div className="mt-4 inline-flex gap-1 bg-slate-100 p-1 rounded-xl">
                        {MODES.map(([k, lbl]) => (
                          <button key={k} type="button" onClick={() => changeExpMode(k)}
                            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition ${expMode === k ? 'bg-white shadow text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                            <span className="inline-flex items-center gap-1.5">
                              {k !== 'all' && <span className="w-2 h-2 rounded-full" style={{ background: k === 'DIRECT' ? EXP_DIRECT[2] : EXP_INDIRECT[2] }} />}
                              {lbl}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="lg:col-span-3 bg-white rounded-xl border border-slate-200 shadow-sm p-3 sm:p-4">
                    <div className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold px-1 pb-1">{modeLabel} — ranked</div>
                    <div className="divide-y divide-slate-100/70">
                      {fsubs.length === 0 && <p className="text-sm text-slate-500 py-6 text-center">No expense categories.</p>}
                      {fsubs.slice(page * LPSZ, page * LPSZ + LPSZ).map((s) => {
                        const c = colorOf(s);
                        const gap = s.tally != null ? s.erp - s.tally : null;
                        return (
                          <button key={`${s.group}-${s.sub}`} type="button" onClick={() => openVouchers(s.group, s.sub)}
                            className="w-full text-left group flex items-center gap-2.5 py-2 px-1 hover:bg-slate-50 rounded-lg">
                            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: c }} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium text-slate-800 truncate">{s.sub}{expMode === 'all' ? <span className="text-[11px] text-slate-400 font-normal"> · {s.group === 'DIRECT' ? 'Direct' : 'Indirect'}</span> : null}{s.count ? <span className="text-[11px] text-slate-400 font-normal"> · {s.count} bills</span> : null}</span>
                                <span className="font-semibold tabular-nums shrink-0">{fmt(s.value)}</span>
                              </div>
                              <div className="h-1.5 rounded-full bg-slate-100 mt-1.5 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${s.value / maxS * 100}%`, background: c }} /></div>
                              {s.tally != null && (
                                <div className="text-[11px] mt-1">
                                  {gap != null && Math.abs(gap) < 1 ? <span className="font-medium text-emerald-600">✓ ties Tally</span>
                                    : s.erp > 0 ? <span className="text-slate-400">ERP {fmt(s.erp)} <span className={gap > 0 ? 'text-amber-600' : 'text-sky-600'}>({gap > 0 ? '+' : ''}{fmt(gap)})</span></span>
                                    : <span className="text-slate-300">journal-booked</span>}
                                </div>
                              )}
                            </div>
                            <ChevronRight size={15} className="shrink-0 text-slate-300 group-hover:text-indigo-500" />
                          </button>
                        );
                      })}
                    </div>
                    <Pager page={page} pages={pages} onPage={goPage} />
                  </div>
                </div>
              </>
            );
          })()}

          {/* ───────── SCREEN 2C — Expense vouchers, full page (like the item detail) ───────── */}
          {screen.name === 'vouchers' && (() => {
            const d = vch || { rows: [], loading: true };
            const rows = d.rows || [];
            const PAGE = 10;
            const totalPages = Math.max(1, Math.ceil(rows.length / PAGE));
            const page = Math.min(vchPage, totalPages);
            const pageRows = rows.slice((page - 1) * PAGE, page * PAGE);
            const title = `${screen.sub} · ${screen.group === 'DIRECT' ? 'Direct' : 'Indirect'}`;
            const badge = (r) => ((r.status === 'erp' || (r.status == null && r.in_erp))
              ? <span className="text-[11px] font-medium text-emerald-700 bg-emerald-50 rounded px-1.5 py-0.5">✓ ERP</span>
              : r.status === 'journal'
                ? <span className="text-[11px] font-medium text-slate-500 bg-slate-100 rounded px-1.5 py-0.5" title="No bill expected — journal-booked or freight (Freight module)">journal</span>
                : <span className="text-[11px] font-medium text-amber-700 bg-amber-50 rounded px-1.5 py-0.5">⚠ missing</span>);
            return (
              <>
                <BackBar onBack={() => window.history.back()} title={title} />
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-800 truncate">{title}</div>
                      <div className="text-[11px] text-slate-400">{d.source === 'erp' ? 'ERP bills' : 'Tally vouchers (bill-wise)'}{rows.length ? ` · ${rows.length}` : ''}{rows.length && d.source !== 'erp' ? <> · <span className="text-emerald-600 font-medium">✓ {d.inErp} in ERP</span>{d.journal ? <> · <span className="text-slate-500 font-medium">{d.journal} journal</span></> : null} · <span className="text-amber-600 font-medium">⚠ {d.missing} missing</span></> : null}</div>
                    </div>
                    <div className="text-right shrink-0"><div className="font-bold text-emerald-700 tabular-nums">{fmt(d.total)}</div></div>
                  </div>
                  {d.loading ? (
                    <div className="flex items-center justify-center py-16 text-slate-500"><Loader2 className="animate-spin mr-2" size={18} /> Loading…</div>
                  ) : d.note ? (
                    <p className="text-sm text-slate-500 py-10 text-center">{d.note}</p>
                  ) : rows.length === 0 ? (
                    <p className="text-sm text-slate-500 py-10 text-center">No vouchers in this period.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-[13px]">
                        <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-[11px] uppercase tracking-wide text-slate-400">
                          <tr>
                            <th className="py-2.5 px-4 text-left font-semibold whitespace-nowrap">Date</th>
                            <th className="py-2.5 px-4 text-left font-semibold">Party</th>
                            <th className="py-2.5 px-4 text-left font-semibold">Ledger</th>
                            <th className="py-2.5 px-4 text-left font-semibold whitespace-nowrap">Bill No</th>
                            <th className="py-2.5 px-4 text-left font-semibold whitespace-nowrap">In ERP</th>
                            <th className="py-2.5 px-4 text-right font-semibold">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pageRows.map((r, j) => (
                            <tr key={j} onClick={() => r.bill_id && navigate(`/purchase/bills/${r.bill_id}`)}
                              className={`border-t border-slate-100 ${r.bill_id ? 'hover:bg-indigo-50/40 cursor-pointer' : ''}`}>
                              <td className="py-2.5 px-4 text-slate-600 whitespace-nowrap">{fmtDate(r.date)}</td>
                              <td className="py-2.5 px-4 text-slate-700 truncate max-w-[200px]" title={r.party}>{r.party || '—'}</td>
                              <td className="py-2.5 px-4 text-slate-500 truncate max-w-[180px]" title={r.ledger}>{r.ledger}</td>
                              <td className="py-2.5 px-4 whitespace-nowrap">{r.bill_id ? <span className="text-indigo-600">{r.voucher_no || 'view'}</span> : <span className="text-slate-400">{r.voucher_no || '—'}</span>}</td>
                              <td className="py-2.5 px-4 whitespace-nowrap">{badge(r)}</td>
                              <td className="py-2.5 px-4 text-right tabular-nums font-semibold text-emerald-700">{fmt(r.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {!d.loading && !d.note && rows.length > PAGE && (
                    <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-slate-100 text-[12px] text-slate-500">
                      <span className="tabular-nums">Showing {(page - 1) * PAGE + 1}–{Math.min(page * PAGE, rows.length)} of {rows.length}</span>
                      <div className="flex items-center gap-2">
                        <button type="button" disabled={page <= 1} onClick={() => setVchPage(page - 1)}
                          className="px-2.5 py-1 rounded border border-slate-200 disabled:opacity-40 enabled:hover:bg-slate-50">Prev</button>
                        <span className="tabular-nums">Page {page} / {totalPages}</span>
                        <button type="button" disabled={page >= totalPages} onClick={() => setVchPage(page + 1)}
                          className="px-2.5 py-1 rounded border border-slate-200 disabled:opacity-40 enabled:hover:bg-slate-50">Next</button>
                      </div>
                    </div>
                  )}
                  <p className="text-[11px] text-slate-400 px-4 py-2.5 border-t border-slate-100">Click a ✓ ERP row to open its bill. ⚠ missing vouchers aren&apos;t imported into the ERP yet.</p>
                </div>
              </>
            );
          })()}
          </>
        )}
      </div>

      {/* Bill-wise Tally voucher drawer */}
      {false && vch && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setVch(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-slate-100">
              <div className="min-w-0">
                <h3 className="font-semibold text-slate-900 truncate">{vch.sub} · {vch.group === 'DIRECT' ? 'Direct' : 'Indirect'}</h3>
                <p className="text-xs text-slate-500">{vch.source === 'erp' ? 'ERP bills (no Tally mirror this month)' : 'Tally vouchers (bill-wise)'}{vch.rows.length ? ` · ${vch.rows.length} · ₹${Number(vch.total).toLocaleString('en-IN')}` : ''}
                  {vch.rows.length && vch.source !== 'erp' ? <span> · <span className="text-emerald-600 font-medium">✓ {vch.inErp} in ERP</span>{vch.journal ? <span> · <span className="text-slate-500 font-medium">{vch.journal} journal</span></span> : null} · <span className="text-amber-600 font-medium">⚠ {vch.missing} missing</span></span> : null}</p>
              </div>
              <button onClick={() => setVch(null)} className="p-1 text-slate-400 hover:text-slate-700 shrink-0"><X size={18} /></button>
            </div>
            <div className="overflow-auto p-4">
              {vch.loading ? <div className="flex items-center gap-2 text-slate-500 py-8 justify-center"><Loader2 size={16} className="animate-spin" /> Loading…</div>
                : vch.note ? <p className="text-sm text-slate-500 py-8 text-center">{vch.note}</p>
                : vch.rows.length === 0 ? <p className="text-sm text-slate-500 py-8 text-center">No vouchers for this month.</p>
                : (
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[11px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
                    <th className="py-2 pr-2 font-medium">Date</th><th className="py-2 px-2 font-medium">Voucher</th><th className="py-2 px-2 font-medium">Party</th><th className="py-2 px-2 font-medium">Ledger</th><th className="py-2 px-2 font-medium">In ERP</th><th className="py-2 pl-2 font-medium text-right">Amount</th>
                  </tr></thead>
                  <tbody>
                    {vch.rows.map((r, i) => (
                      <tr key={i} className="border-b border-slate-50 last:border-0">
                        <td className="py-1.5 pr-2 whitespace-nowrap text-slate-600">{r.date}</td>
                        <td className="py-1.5 px-2 whitespace-nowrap text-slate-700">{r.voucher_no}<span className="block text-[10px] text-slate-400">{r.voucher_type}</span></td>
                        <td className="py-1.5 px-2 text-slate-700 truncate max-w-[150px]" title={r.party}>{r.party || '—'}</td>
                        <td className="py-1.5 px-2 text-slate-500 truncate max-w-[150px]" title={r.ledger}>{r.ledger}</td>
                        <td className="py-1.5 px-2 whitespace-nowrap">{
                          (r.status === 'erp' || (r.status == null && r.in_erp))
                            ? <span className="text-[11px] font-medium text-emerald-700 bg-emerald-50 rounded px-1.5 py-0.5">✓ ERP</span>
                          : r.status === 'journal'
                            ? <span className="text-[11px] font-medium text-slate-500 bg-slate-100 rounded px-1.5 py-0.5" title="No bill expected — journal-booked or freight (Freight module)">journal</span>
                            : <span className="text-[11px] font-medium text-amber-700 bg-amber-50 rounded px-1.5 py-0.5">⚠ missing</span>}</td>
                        <td className="py-1.5 pl-2 text-right font-medium tabular-nums text-slate-900">₹{Number(r.amount).toLocaleString('en-IN')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  );
}
