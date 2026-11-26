/**
 * Purchase Workspace — full-screen 360 view for the Purchase module.
 *
 * Route: /purchase/workspace  (replaces the old Purchase Analytics entry)
 *
 * Modeled on the Sales Company-360 shell (top bar + collapsible left nav +
 * content header with period presets), but scoped to the GLOBAL company filter
 * and themed slate + indigo. Four sections are wired to live data (Top Vendors,
 * Purchase Trend, Item Analytics, TDS Summary); the rest are "coming soon".
 */
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronLeft, ChevronDown, AlertCircle, AlertTriangle,
  CreditCard, TrendingUp, Package, DollarSign,
  Shield, RotateCcw, Clock, Users as UsersIcon, Star,
  UserX, UserPlus, Target, BarChart3, ArrowLeftRight,
  Loader2, X, Calendar, Sparkles, Check, Building2, GitBranch,
  FileSpreadsheet, FileText, Award,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import apiClient from '../../../utils/api.js';
import exportToExcel from '../../../utils/exportExcel.js';
import { useGlobalCompany } from '@/hooks/useGlobalCompany.js';
import { formatDate } from '@/utils/formatters';

// ── Formatting ──────────────────────────────────────────────────────
const num = (v) => Number(v) || 0;
const fmtINR = (v) => {
  const n = num(v);
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};
const fmtRup = (v) => `₹${Math.round(num(v)).toLocaleString('en-IN')}`;
const fmtDate = (iso) => (iso ? formatDate(iso) : '—');
const fmtQty = (v) => num(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
// 'YYYY-MM' -> 'Nov 26'
const monthLabel = (ym) => {
  if (!ym || ym.length < 7) return ym || '';
  const [y, m] = ym.split('-');
  return `${MONTH_ABBR[Number(m) - 1] || m} '${String(y).slice(2)}`;
};

// ── Date range presets (copied from Company-360) ────────────────────
const _today = new Date();
const _isoDate = (d) => d.toISOString().slice(0, 10);
const _fyYear = (d) => d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
const _monthStart = (y, m) => `${y}-${String(m + 1).padStart(2, '0')}-01`;
const _monthEnd = (y, m) => _isoDate(new Date(y, m + 1, 0));
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function buildDatePresets() {
  const ty = _today.getFullYear();
  const tm = _today.getMonth();
  const fy = _fyYear(_today);
  const presets = [];
  presets.push({ key: 'fy', label: `FY ${fy}-${String(fy + 1).slice(2)}`, from: `${fy}-04-01`, to: `${fy + 1}-03-31` });
  presets.push({ key: 'pfy', label: `FY ${fy - 1}-${String(fy).slice(2)}`, from: `${fy - 1}-04-01`, to: `${fy}-03-31` });
  presets.push({ key: 'cm', label: MONTH_ABBR[tm] + ' ' + ty, from: _monthStart(ty, tm), to: _isoDate(_today) });
  for (let i = 1; i <= 5; i++) {
    const d = new Date(ty, tm - i, 1);
    presets.push({ key: `m${i}`, label: MONTH_ABBR[d.getMonth()] + ' ' + d.getFullYear(), from: _monthStart(d.getFullYear(), d.getMonth()), to: _monthEnd(d.getFullYear(), d.getMonth()) });
  }
  const qStarts = [[fy, 3], [fy, 6], [fy, 9], [fy + 1, 0]];
  const qLabels = ['Q1 (Apr-Jun)', 'Q2 (Jul-Sep)', 'Q3 (Oct-Dec)', 'Q4 (Jan-Mar)'];
  for (let i = 0; i < 4; i++) {
    const [qy, qm] = qStarts[i];
    const qEnd = new Date(qy, qm + 3, 0);
    if (qEnd <= _today) presets.push({ key: `q${i}`, label: qLabels[i], from: _monthStart(qy, qm), to: _isoDate(qEnd) });
    else if (new Date(qy, qm, 1) <= _today) presets.push({ key: `q${i}`, label: qLabels[i] + ' (so far)', from: _monthStart(qy, qm), to: _isoDate(_today) });
  }
  return presets;
}
const DATE_PRESETS = buildDatePresets();

// ── Nav groups (Purchase) ────────────────────────────────────────────
const NAV_GROUPS = [
  { title: 'Purchase Analytics', items: [
    { id: 'pa_item',  label: 'Item Analytics',  icon: Package },
    { id: 'pa_vturn', label: 'Vendor Turnover', icon: ArrowLeftRight },
    { id: 'pa_drill', label: 'Item Drill-down', icon: BarChart3 },
    { id: 'pa_trend', label: 'Purchase Trend',  icon: TrendingUp },
    { id: 'pa_branch', label: 'Branch Transfers', icon: GitBranch },
  ]},
  { title: 'Payables', items: [
    { id: 'pay_week',  label: 'This Week',       icon: AlertCircle },
    { id: 'pay_aged',  label: 'Overdue Ageing',  icon: AlertTriangle },
    { id: 'pay_up',    label: 'Upcoming',        icon: Clock },
    { id: 'top_vend',  label: 'Top Vendors',     icon: CreditCard },
  ]},
  { title: 'Vendors', items: [
    { id: 'v_top',    label: 'Top Vendors',     icon: Star },
    { id: 'v_inact',  label: 'Inactive',        icon: UserX },
    { id: 'v_score',  label: 'Scorecard',       icon: Award },
    { id: 'v_single', label: 'Single-Source Risk', icon: AlertTriangle },
    { id: 'v_msme',   label: 'MSME Compliance', icon: Shield },
    { id: 'v_price',  label: 'Price Watch',     icon: TrendingUp },
  ]},
  { title: 'Accounts', items: [
    { id: 'ac_pay',   label: 'Payment Efficiency', icon: Clock },
    { id: 'ac_cndn',  label: 'Credit/Debit Notes', icon: RotateCcw },
    { id: 'ac_gst',   label: 'GST Summary',        icon: DollarSign },
    { id: 'ac_tds',   label: 'TDS Summary',        icon: Shield },
  ]},
];
const SECTION_TITLES = {};
NAV_GROUPS.forEach(g => g.items.forEach(it => { SECTION_TITLES[it.id] = it.label; }));
const SECTION_ICON = {};
NAV_GROUPS.forEach(g => g.items.forEach(it => { SECTION_ICON[it.id] = it.icon; }));
const WIRED = new Set(['top_vend', 'pa_trend', 'pa_item', 'pa_drill', 'pa_vturn', 'pa_branch', 'ac_tds', 'pay_week', 'pay_aged', 'pay_up', 'v_top', 'v_inact', 'v_score', 'v_single', 'v_msme', 'v_price', 'ac_pay', 'ac_cndn', 'ac_gst']);

// Purchase categories for the Item Drill-down filter: chip label -> category code.
// Categories match the normalized values product_category() returns:
// RM (incl. Maize/Bought-note), PM (Packing), FRUIT. Keys equal those values so
// the drill-down's `it.category === drillCat` filter matches directly, and the
// vendor-turnover endpoint (which also normalizes) gets the same key.
const DRILL_CATS = [
  { key: '', label: 'All' },
  { key: 'RM', label: 'RM' },
  { key: 'PM', label: 'Packing' },
  { key: 'FRUIT', label: 'Fruit' },
];
// MSME filter options — a first-class header dropdown on vendor-facing views.
const MSME_OPTS = [
  { key: '', label: 'MSME: All' },
  { key: 'msme', label: 'MSME only' },
  { key: 'non', label: 'Non-MSME' },
];
// Normalize a bill's raw purchase_category to the DRILL_CATS keys, same mapping
// product_category() / the vendor-turnover endpoint use (PACKING→PM, MAIZE→RM,
// BOUGHT_NOTE→RM; RM/PM/FRUIT pass through).
const CAT_NORMALIZE = { RM: 'RM', PACKING: 'PM', MAIZE: 'RM', BOUGHT_NOTE: 'RM', PM: 'PM', FRUIT: 'FRUIT' };
const normCat = (raw) => { const k = String(raw || '').toUpperCase(); return CAT_NORMALIZE[k] || k; };

// ── Small presentational helpers (slate/indigo) ──────────────────────
function Card({ label, value, sub, color, borderColor }) {
  return (
    <div className={`bg-white border border-slate-300 rounded-lg px-3 py-2.5 shadow-sm ${borderColor ? `border-l-[3px] ${borderColor}` : ''}`}>
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-600">{label}</div>
      <div className={`text-lg font-extrabold tabular-nums mt-0.5 ${color || 'text-slate-900'}`}>{value}</div>
      {sub && <div className="text-[10px] font-medium text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}
function TH({ children, right }) {
  return <th className={`${right ? 'text-right' : 'text-left'} sticky top-0 z-10 px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 bg-slate-100 border-b-2 border-slate-200`}>{children}</th>;
}
function TD({ children, right, bold, color, clickable, onClick }) {
  // Numeric (right-aligned) cells read as values, so they default to semibold;
  // an explicit `bold` goes stronger. Keeps every analytics table's figures legible.
  const weight = bold ? 'font-bold' : (right ? 'font-semibold' : '');
  return <td onClick={onClick} className={`px-2 py-1.5 border-b border-slate-100 text-[11px] ${right ? 'text-right tabular-nums text-slate-800' : ''} ${weight} ${color || ''} ${clickable ? 'text-indigo-600 cursor-pointer hover:underline' : ''}`}>{children}</td>;
}
function ComingSoon({ sectionId }) {
  const Icon = SECTION_ICON[sectionId] || Sparkles;
  return (
    <div className="flex flex-col items-center justify-center text-center py-24 text-slate-400">
      <div className="w-14 h-14 rounded-2xl bg-indigo-50 text-indigo-500 flex items-center justify-center mb-3"><Icon size={26} /></div>
      <div className="text-sm font-semibold text-slate-500">{SECTION_TITLES[sectionId]}</div>
      <div className="text-xs mt-1">This section is coming soon.</div>
    </div>
  );
}

// Exact rupee (2dp) — for the "Detailed figures (for Tally verification)" view.
const fmtExact = (v) => `₹${num(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Monthly turnover pivot: Purchases / +Debit Notes / −Credit Notes / Net, then
// an "already excluded" sub-group (Branch Transfers, Freight). `fmt` controls
// compact (fmtINR) vs exact (fmtExact) rendering.
function BreakdownPivot({ breakdown, fmt }) {
  const months = breakdown?.months || [];
  const rows = breakdown?.rows || {};
  if (!months.length) return <div className="text-center py-8 text-slate-400 text-sm">No data for this period.</div>;
  const Row = ({ label, k, sign, labelCls, rowCls }) => (
    <tr className={rowCls || 'hover:bg-slate-50'}>
      <td className={`sticky left-0 bg-white px-2 py-1.5 text-[11px] font-semibold border-b border-slate-100 z-10 ${labelCls || 'text-slate-700'}`}>{label}</td>
      {months.map(m => {
        const v = rows[k]?.[m.month];
        return <td key={m.month} className={`text-right px-2 py-1.5 text-[10px] tabular-nums font-semibold border-b border-l border-slate-100 ${labelCls || 'text-slate-700'}`}>{v ? `${sign || ''}${fmt(v)}` : '—'}</td>;
      })}
      <td className={`text-right px-2 py-1.5 text-[11px] font-bold tabular-nums border-b border-l border-slate-200 ${labelCls || 'text-slate-700'}`}>{rows[k]?.total ? `${sign || ''}${fmt(rows[k].total)}` : '—'}</td>
    </tr>
  );
  return (
    <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
      <table className="min-w-[720px] w-full">
        <thead><tr>
          <th className="sticky top-0 left-0 z-20 bg-slate-100 text-left px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 border-b-2 border-slate-200">Type</th>
          {months.map(m => <th key={m.month} className="sticky top-0 z-10 text-center px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 bg-slate-100 border-b-2 border-l border-slate-200 min-w-[78px]">{m.label}</th>)}
          <th className="sticky top-0 z-10 text-right px-2 py-1.5 text-[9px] font-extrabold uppercase tracking-wider text-indigo-700 bg-slate-100 border-b-2 border-l border-slate-200">Total</th>
        </tr></thead>
        <tbody>
          <Row label="Purchases" k="purchases" labelCls="text-slate-800" />
          <Row label="+ Debit Notes" k="debit_notes" sign="+" labelCls="text-sky-700" />
          <Row label="− Credit Notes" k="credit_notes" sign="−" labelCls="text-red-600" />
          <tr className="bg-indigo-50/60 font-bold">
            <td className="sticky left-0 bg-indigo-50/60 px-2 py-1.5 text-[11px] font-bold text-indigo-800 border-b border-slate-200 z-10">Net Turnover</td>
            {months.map(m => <td key={m.month} className="text-right px-2 py-1.5 text-[10px] tabular-nums font-bold text-indigo-800 border-b border-l border-slate-200">{rows.net?.[m.month] ? fmt(rows.net[m.month]) : '—'}</td>)}
            <td className="text-right px-2 py-1.5 text-[11px] font-extrabold tabular-nums text-indigo-800 border-b border-l border-slate-200">{rows.net?.total ? fmt(rows.net.total) : '—'}</td>
          </tr>
          <tr>
            <td colSpan={months.length + 2} className="px-2 pt-2.5 pb-1 text-[9px] font-bold uppercase tracking-wider text-slate-500 bg-white">Already excluded from Purchases above</td>
          </tr>
          <Row label="Branch Transfers" k="branch_transfers" labelCls="text-amber-600" />
          <Row label="Freight / Charges" k="freight" labelCls="text-slate-500" />
        </tbody>
      </table>
    </div>
  );
}

// ── PDF report builder ────────────────────────────────────────────────
// Parse a possibly-formatted value ("₹34.19L", "1,202", "12%") to a number,
// expanding Indian magnitude suffixes so a chart scales correctly.
function parseNum(s) {
  if (s == null) return 0;
  if (typeof s === 'number') return s;
  const str = String(s).trim();
  const m = str.replace(/[₹,\s%]/g, '').match(/^(-?[\d.]+)\s*(cr|l|k)?/i);
  if (!m) return 0;
  let n = parseFloat(m[1]) || 0;
  const suf = (m[2] || '').toLowerCase();
  if (suf === 'cr') n *= 1e7; else if (suf === 'l') n *= 1e5; else if (suf === 'k') n *= 1e3;
  return n;
}

// Compact value label for chart ticks (₹1.2Cr / ₹3.4L / 1,234).
function chartNum(n) {
  const a = Math.abs(n);
  if (a >= 1e7) return `₹${(n / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `₹${(n / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `₹${(n / 1e3).toFixed(0)}K`;
  return n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

const _esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const _INDIGO_SHADES = ['#4f46e5', '#6366f1', '#818cf8', '#a5b4fc', '#c7d2fe', '#4338ca', '#3730a3', '#6d28d9'];
const _PIE_COLORS = ['#4f46e5', '#059669', '#d97706', '#dc2626', '#0284c7', '#7c3aed', '#94a3b8'];

// Build an inline SVG chart (bar | line | pie) from {label,value} points.
function buildChartSvg(points, chartType) {
  const pts = points.filter(p => p && isFinite(p.value)).slice();
  if (!pts.length) return '';
  const trunc = (s) => { s = String(s || ''); return s.length > 14 ? s.slice(0, 13) + '…' : s; };

  if (chartType === 'pie') {
    const sorted = [...pts].sort((a, b) => b.value - a.value);
    const top = sorted.slice(0, 6);
    const restV = sorted.slice(6).reduce((s, p) => s + p.value, 0);
    const slices = restV > 0 ? [...top, { label: 'Others', value: restV }] : top;
    const total = slices.reduce((s, p) => s + p.value, 0) || 1;
    let a0 = -Math.PI / 2; const cx = 95, cy = 95, r = 80;
    const arcs = slices.map((p, i) => {
      const frac = p.value / total; const a1 = a0 + frac * 2 * Math.PI;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      const large = frac > 0.5 ? 1 : 0;
      const d = `M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z`;
      a0 = a1;
      return `<path d="${d}" fill="${_PIE_COLORS[i % _PIE_COLORS.length]}" stroke="#fff" stroke-width="1"/>`;
    }).join('');
    const legend = slices.map((p, i) => `
      <div style="display:flex;align-items:center;gap:6px;font-size:10px;color:#334155;margin:2px 0">
        <span style="width:9px;height:9px;border-radius:2px;background:${_PIE_COLORS[i % _PIE_COLORS.length]};display:inline-block"></span>
        ${_esc(trunc(p.label))} · ${((p.value / total) * 100).toFixed(0)}%
      </div>`).join('');
    return `<div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
      <svg viewBox="0 0 190 190" width="190" height="190">${arcs}</svg>
      <div>${legend}</div></div>`;
  }

  // bar / line share a scaled plot
  const data = (chartType === 'bar' ? [...pts].sort((a, b) => b.value - a.value) : pts).slice(0, chartType === 'bar' ? 8 : 24);
  const max = Math.max(1, ...data.map(p => p.value));
  const W = 560, H = 170, padB = 34, padL = 8, padT = 16, plotH = H - padB - padT;
  const axis = `<line x1="${padL}" y1="${H - padB}" x2="${W - 8}" y2="${H - padB}" stroke="#cbd5e1"/>`;

  if (chartType === 'line') {
    const n = data.length; const step = (W - padL - 16) / Math.max(1, n - 1);
    const pxy = data.map((p, i) => [padL + i * step, padT + plotH - (p.value / max) * plotH]);
    const poly = pxy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const dots = pxy.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="#4f46e5"/>`).join('');
    const labels = data.map((p, i) => `<text x="${(padL + i * step).toFixed(1)}" y="${H - padB + 12}" font-size="7" fill="#64748b" text-anchor="middle">${_esc(trunc(p.label))}</text>`).join('');
    const grid = [0.25, 0.5, 0.75, 1].map(f => `<line x1="${padL}" y1="${(padT + plotH - f * plotH).toFixed(1)}" x2="${W - 8}" y2="${(padT + plotH - f * plotH).toFixed(1)}" stroke="#eef2f7"/>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" font-family="Inter,Arial,sans-serif">${grid}${axis}
      <polyline points="${poly}" fill="none" stroke="#4f46e5" stroke-width="2"/>${dots}${labels}</svg>`;
  }

  // bar
  const n = data.length; const gap = 10; const bw = Math.max(8, (W - padL - 16 - gap * n) / n);
  const bars = data.map((p, i) => {
    const h = (p.value / max) * plotH; const x = padL + i * (bw + gap); const y = padT + plotH - h;
    const lbl = i < 3 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}" font-size="7.5" font-weight="700" fill="#334155" text-anchor="middle">${chartNum(p.value)}</text>` : '';
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="3" fill="${_INDIGO_SHADES[i % _INDIGO_SHADES.length]}"/>
      <text x="${(x + bw / 2).toFixed(1)}" y="${H - padB + 12}" font-size="7" fill="#64748b" text-anchor="middle">${_esc(trunc(p.label))}</text>${lbl}`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" font-family="Inter,Arial,sans-serif">${axis}${bars}</svg>`;
}

// Build the full styled report document and open it for printing.
function buildReportHtml(opts) {
  const {
    title, metaLines = [], cols, data, landscape, content = 'everything',
    chartType = 'bar', kpis = [], chartSpec, showBanner = true, showTotals = true,
    companyName = '', initials = 'SB',
  } = opts;
  const esc = _esc;
  const firstField = cols[0]?.field;
  const isParent = (r) => firstField != null && !/^\s/.test(String(r[firstField] ?? ''));
  const hasNesting = data.some(r => firstField != null && /^\s/.test(String(r[firstField] ?? '')));

  const wantSummary = content === 'summary_table' || content === 'everything';
  const wantChart = (content === 'table_chart' || content === 'everything') && !!chartSpec;

  // KPI tiles
  const toneColor = { indigo: '#4f46e5', emerald: '#059669', amber: '#d97706', rose: '#dc2626' };
  const kpiHtml = (wantSummary && kpis.length) ? `<div class="kpis">${kpis.map(k => {
    const c = toneColor[k.tone] || '#4f46e5';
    return `<div class="kpi" style="border-top-color:${c}"><div class="k">${esc(k.label)}</div><div class="v" style="color:${c}">${esc(k.value)}</div></div>`;
  }).join('')}</div>` : '';

  // Chart
  let chartHtml = '';
  if (wantChart) {
    const src = hasNesting ? data.filter(isParent) : data;
    const points = src
      .filter(r => !/^total/i.test(String(r[firstField] ?? '').trim()))
      .map(r => ({ label: String(r[chartSpec.labelField] ?? ''), value: parseNum(r[chartSpec.valueField]) }))
      .filter(p => p.value > 0);
    const svg = buildChartSvg(points, chartType);
    if (svg) {
      const lblHdr = (cols.find(c => c.field === chartSpec.labelField)?.header) || 'Item';
      const valHdr = (cols.find(c => c.field === chartSpec.valueField)?.header) || 'Value';
      chartHtml = `<p class="sec">${esc(lblHdr)} by ${esc(valHdr)}</p><div class="chart">${svg}</div>`;
    }
  }

  // Table
  const thead = `<tr>${cols.map((c, i) => `<th style="text-align:${i === 0 ? 'left' : 'right'}">${esc(c.header)}</th>`).join('')}</tr>`;
  const lastIsTotal = showTotals && data.length && /^total/i.test(String(data[data.length - 1][firstField] ?? '').trim());
  const tbody = data.map((r, ri) => {
    const cls = [];
    if (hasNesting && isParent(r)) cls.push('parent');
    if (lastIsTotal && ri === data.length - 1) cls.push('total');
    return `<tr${cls.length ? ` class="${cls.join(' ')}"` : ''}>${cols.map((c, i) => {
      let v = esc(r[c.field]);
      if (i === 0) v = v.replace(/^ +/, (m) => '&nbsp;'.repeat(m.length));
      return `<td style="text-align:${i === 0 ? 'left' : 'right'}">${v}</td>`;
    }).join('')}</tr>`;
  }).join('');

  const today = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const metaRight = (showBanner ? metaLines : []).concat(`Generated ${today}`).map(esc).join('<br>');

  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(`<!doctype html><html><head><title>${esc(title)}</title><meta charset="utf-8">
  <style>
    @page{size:A4 ${landscape ? 'landscape' : 'portrait'};margin:0}
    *{box-sizing:border-box}
    body{font-family:Inter,Arial,sans-serif;color:#0f172a;margin:0}
    .wrap{padding:14mm 12mm}
    .rhead{background:linear-gradient(100deg,#4f46e5,#6366f1);color:#fff;padding:16px 22px;display:flex;align-items:center;justify-content:space-between;margin:-14mm -12mm 16px}
    .rhead .l{display:flex;align-items:center;gap:12px}
    .logo{width:38px;height:38px;border-radius:9px;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px}
    .co{font-size:15px;font-weight:800}.rt{font-size:11px;color:#c7d2fe;margin-top:1px}
    .rhead .meta{text-align:right;font-size:10px;color:#c7d2fe;line-height:1.5}
    .kpis{display:flex;gap:10px;margin-bottom:16px}
    .kpi{flex:1;border:1px solid #e2e8f0;border-radius:9px;padding:9px 11px;border-top:3px solid #4f46e5}
    .kpi .k{font-size:8.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#64748b}
    .kpi .v{font-size:15px;font-weight:800;margin-top:2px}
    .sec{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#4f46e5;margin:0 0 8px}
    .chart{border:1px solid #e2e8f0;border-radius:9px;padding:12px;margin-bottom:16px}
    table{width:100%;border-collapse:collapse;font-size:10.5px}
    th{background:#eef2ff;color:#3730a3;padding:6px 8px;border:1px solid #e2e8f0;font-size:8.5px;text-transform:uppercase;letter-spacing:.03em}
    td{padding:5px 8px;border:1px solid #eef2f7}
    tbody tr:nth-child(even) td{background:#f8fafc}
    tbody tr.parent td{font-weight:800;background:#eef2ff}
    tbody tr.total td{font-weight:800;background:#f1f5f9;border-top:2px solid #cbd5e1}
    .rfoot{margin-top:14px;padding-top:8px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:9px;display:flex;justify-content:space-between}
  </style></head>
  <body><div class="wrap">
    <div class="rhead"><div class="l"><div class="logo">${esc(initials)}</div>
      <div><div class="co">${esc(companyName || 'Company')}</div><div class="rt">${esc(title)}</div></div></div>
      <div class="meta">${metaRight}</div></div>
    ${wantSummary ? '<p class="sec">Summary</p>' : ''}${kpiHtml}
    ${chartHtml}
    <p class="sec">Details</p>
    <table><thead>${thead}</thead><tbody>${tbody}</tbody></table>
    <div class="rfoot"><span>Lancer ERP · Purchase Analytics</span><span>${esc(companyName)}</span></div>
  </div><script>window.onload=function(){window.print();}<\/script></body></html>`);
  w.document.close();
}

// ── "Build report" dialog ─────────────────────────────────────────────
function ReportDialog({ open, onClose, onGenerate, defaults = {}, canChart }) {
  const [content, setContent] = useState(canChart ? 'everything' : 'summary_table');
  const [chartType, setChartType] = useState('bar');
  const [showBanner, setShowBanner] = useState(true);
  const [showTotals, setShowTotals] = useState(true);
  const [landscape, setLandscape] = useState(!!defaults.landscape);
  useEffect(() => {
    if (open) {
      setContent(canChart ? 'everything' : 'summary_table');
      setChartType('bar'); setShowBanner(true); setShowTotals(true); setLandscape(!!defaults.landscape);
    }
  }, [open, canChart, defaults.landscape]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;

  const wantsChart = content === 'table_chart' || content === 'everything';
  const OPTS = [
    { v: 'table', d: 'Table only', s: 'Just the data, formatted' },
    { v: 'summary_table', d: 'Summary + table', s: 'KPI tiles on top' },
    ...(canChart ? [{ v: 'table_chart', d: 'Table + chart', s: 'Chart drawn from the data' }] : []),
    ...(canChart ? [{ v: 'everything', d: 'Everything', s: 'Summary · chart · table' }] : []),
  ];
  const Toggle = ({ label, on, set }) => (
    <div className="flex items-center justify-between text-[12px] text-slate-600 py-0.5">
      <span>{label}</span>
      <button type="button" onClick={() => set(v => !v)}
        className={`w-[34px] h-[19px] rounded-full relative transition ${on ? 'bg-indigo-600' : 'bg-slate-300'}`}>
        <span className={`absolute top-0.5 w-[15px] h-[15px] rounded-full bg-white transition-all ${on ? 'left-[17px]' : 'left-0.5'}`} />
      </button>
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-slate-900/50" />
      <div className="relative w-full max-w-[340px] bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <span className="text-[13px] font-extrabold text-slate-900">Build report</span>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={16} /></button>
        </div>
        <div className="px-4 py-3.5 flex flex-col gap-4 max-h-[70vh] overflow-y-auto">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Include</p>
            {OPTS.map(o => (
              <button key={o.v} type="button" onClick={() => setContent(o.v)}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border text-left mb-1.5 transition ${content === o.v ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-indigo-300'}`}>
                <span className={`w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 relative ${content === o.v ? 'border-indigo-600' : 'border-slate-300'}`}>
                  {content === o.v && <span className="absolute inset-0.5 rounded-full bg-indigo-600" />}
                </span>
                <span><span className="block text-[12.5px] font-semibold text-slate-800">{o.d}</span><span className="block text-[10.5px] text-slate-400">{o.s}</span></span>
              </button>
            ))}
          </div>
          {canChart && wantsChart && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Chart type</p>
              <div className="flex gap-1.5">
                {['bar', 'line', 'pie'].map(t => (
                  <button key={t} type="button" onClick={() => setChartType(t)}
                    className={`text-[11.5px] font-bold rounded-lg px-3 py-1.5 border capitalize transition ${chartType === t ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'}`}>{t}</button>
                ))}
              </div>
            </div>
          )}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">Options</p>
            <Toggle label="Company · period banner" on={showBanner} set={setShowBanner} />
            <Toggle label="Totals row" on={showTotals} set={setShowTotals} />
            <Toggle label="Landscape" on={landscape} set={setLandscape} />
          </div>
        </div>
        <div className="px-4 py-3 border-t border-slate-200 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="text-[12.5px] font-bold rounded-lg px-3.5 py-2 border border-slate-200 text-slate-600 hover:bg-slate-50">Cancel</button>
          <button type="button" onClick={() => { onGenerate({ content, chartType, showBanner, showTotals, landscape }); onClose(); }}
            className="text-[12.5px] font-bold rounded-lg px-3.5 py-2 bg-indigo-600 text-white hover:bg-indigo-700">Preview &amp; download</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function TableExport({ cols, data, filename, title, metaLines = [], landscape, boldRow, kpis, chartSpec, companyName, initials }) {
  const [dlgOpen, setDlgOpen] = useState(false);
  if (!data || data.length === 0) return null;
  const btn = 'text-[11px] font-semibold rounded-md px-2.5 py-1 border inline-flex items-center gap-1 transition';
  // Default: in a NESTED export (some rows are indented with leading spaces to
  // mark detail rows), bold the parent rows (no leading space) so groups stand
  // out. A flat table (no indented rows) gets no per-row bold — the header is
  // already bold, and bolding every row would be pointless.
  const firstField = cols[0]?.field;
  const hasNesting = firstField != null && data.some(r => /^\s/.test(String(r[firstField] ?? '')));
  const isBold = boldRow || (hasNesting ? (row) => !/^\s/.test(String(row[firstField] ?? '')) : null);
  const canChart = !!chartSpec;
  return (
    <div className="flex items-center gap-2">
      <button type="button" title="Download Excel"
        onClick={() => exportToExcel(data, cols, filename, 'Sheet1', null, [title, ...metaLines], isBold)}
        className={`${btn} border-emerald-200 text-emerald-700 bg-white hover:bg-emerald-50`}>
        <FileSpreadsheet size={12} /> Excel
      </button>
      <button type="button" title="Build PDF report"
        onClick={() => setDlgOpen(true)}
        className={`${btn} border-slate-300 text-slate-600 bg-white hover:border-indigo-400 hover:text-indigo-700`}>
        <FileText size={12} /> PDF
      </button>
      <ReportDialog
        open={dlgOpen} onClose={() => setDlgOpen(false)} canChart={canChart} defaults={{ landscape }}
        onGenerate={(chosen) => buildReportHtml({
          title, metaLines, cols, data, landscape: chosen.landscape, content: chosen.content,
          chartType: chosen.chartType, kpis, chartSpec, showBanner: chosen.showBanner,
          showTotals: chosen.showTotals, companyName, initials,
        })}
      />
    </div>
  );
}

export default function PurchaseWorkspace() {
  const navigate = useNavigate();
  const { company, companies, setCompany } = useGlobalCompany();

  // ── UI state ──
  const [activeSection, setActiveSection] = useState('pa_item');
  const [profileCollapsed, setProfileCollapsed] = useState(false);
  const [companyMenuOpen, setCompanyMenuOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState(() => {
    const o = {}; NAV_GROUPS.forEach(g => { o[g.title] = g.title === 'Purchase Analytics'; }); return o;
  });
  const [showDatePicker, setShowDatePicker] = useState(false);

  // ── Date range — default current FY ──
  const fy = _fyYear(_today);
  const [dateFrom, setDateFrom] = useState(`${fy}-04-01`);
  const [dateTo, setDateTo] = useState(`${fy + 1}-03-31`);
  const [activePeriod, setActivePeriod] = useState('fy');

  // ── Data ──
  const [loading, setLoading] = useState(true);
  const [dash, setDash] = useState(null);       // /purchase/dashboard/
  const [trend, setTrend] = useState([]);       // mom_trend
  const [items, setItems] = useState([]);       // item-rate-trend items
  const [tds, setTds] = useState(null);         // tds-summary
  const [breakdown, setBreakdown] = useState(null); // monthly-breakdown pivot
  const [showExact, setShowExact] = useState(false); // "detailed figures" toggle
  const [drillPivot, setDrillPivot] = useState(null); // item-rate-trend mode=pivot (vendor x month)
  const [branchTx, setBranchTx] = useState(null);   // branch-transfers payload
  const [branchOpen, setBranchOpen] = useState(null);    // expanded branch bill id
  const [branchBillLines, setBranchBillLines] = useState({}); // {bill_id: {loading, lines}}
  const [payCal, setPayCal] = useState(null);       // payables-calendar (live as-of-today snapshot)
  const [payMsme, setPayMsme] = useState('');       // '' | msme | non (Payables sections)
  const [payCat, setPayCat] = useState('');         // '' | RM | PM | FRUIT (Payables sections)
  const [vendorAct, setVendorAct] = useState(null); // vendor-activity (Vendors group)
  const [vendMsme, setVendMsme] = useState('');     // '' | msme | non (Vendors sections)
  const [vendCat, setVendCat] = useState('');       // '' | RM | PM | FRUIT (Vendors sections)
  const [accounts, setAccounts] = useState(null);   // accounts-summary (Accounts group)

  // ── Item Analytics UI state ──
  const [itemCat, setItemCat] = useState('');       // category filter (''=All)
  const [itemOpen, setItemOpen] = useState(null);   // expanded product row (name)

  // ── Item Drill-down UI state ──
  const [drillCat, setDrillCat] = useState('');     // category filter (''=All)
  const [drillItem, setDrillItem] = useState('');   // selected item name
  const [drillMeasure, setDrillMeasure] = useState('qty'); // qty | rate | value
  const [drillOpenVendor, setDrillOpenVendor] = useState(null); // expanded vendor row
  const [drillVendorBills, setDrillVendorBills] = useState({});  // {vendor: {loading, rows}}, keyed per item+vendor

  // ── Vendor Turnover UI state ──
  const [vturn, setVturn] = useState(null);         // vendor-turnover payload
  const [vturnCat, setVturnCat] = useState('');     // category filter (''=All)
  const [vturnMsme, setVturnMsme] = useState('');   // '' | msme | non
  const [topMsme, setTopMsme] = useState('');       // '' | msme | non (Top Vendors)
  const [vturnOpen, setVturnOpen] = useState(null); // expanded vendor name

  const applyPreset = (p) => { setDateFrom(p.from); setDateTo(p.to); setActivePeriod(p.key); setShowDatePicker(false); };

  // Expand a vendor row in the Item Drill-down -> that vendor's bills for the item.
  const toggleDrillVendor = (vendor) => {
    if (drillOpenVendor === vendor) { setDrillOpenVendor(null); return; }
    setDrillOpenVendor(vendor);
    if (!drillVendorBills[vendor]) {
      setDrillVendorBills(prev => ({ ...prev, [vendor]: { loading: true, rows: [] } }));
      const cp = company ? `company=${company}&` : '';
      apiClient.get(`/api/purchase/item-vendor-bills/?item=${encodeURIComponent(drillItem)}&vendor=${encodeURIComponent(vendor)}&${cp}from=${dateFrom}&to=${dateTo}`)
        .then(r => setDrillVendorBills(prev => ({ ...prev, [vendor]: { loading: false, rows: r.data?.rows || [] } })))
        .catch(() => setDrillVendorBills(prev => ({ ...prev, [vendor]: { loading: false, rows: [] } })));
    }
  };
  // Branch bill drill: expand a branch bill to its line items (from the bill detail).
  const toggleBranchBill = (billId) => {
    if (branchOpen === billId) { setBranchOpen(null); return; }
    setBranchOpen(billId);
    if (!branchBillLines[billId]) {
      setBranchBillLines(prev => ({ ...prev, [billId]: { loading: true, lines: [] } }));
      apiClient.get(`/api/purchase/bills/${billId}/`)
        .then(r => setBranchBillLines(prev => ({ ...prev, [billId]: { loading: false, lines: r.data?.bill_lines || [] } })))
        .catch(() => setBranchBillLines(prev => ({ ...prev, [billId]: { loading: false, lines: [] } })));
    }
  };
  const toggleGroup = (title) => setExpandedGroups(prev => ({ ...prev, [title]: !prev[title] }));
  const selectSection = (sid) => {
    setActiveSection(sid);
    const group = NAV_GROUPS.find(g => g.items.some(i => i.id === sid));
    if (group && !expandedGroups[group.title]) setExpandedGroups(prev => ({ ...prev, [group.title]: true }));
  };
  const sectionTitle = SECTION_TITLES[activeSection] || activeSection;

  const goBack = useCallback(() => {
    if (window.history.state?.idx > 0) navigate(-1); else navigate('/purchase/overview');
  }, [navigate]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') goBack(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goBack]);

  // ── Resolve the active company from the global list ──
  const co = useMemo(
    () => (companies || []).find(c => String(c.id) === String(company)) || null,
    [companies, company],
  );
  const companyName = co ? (co.legal_name || co.trade_name || co.company_code || 'Company') : 'All Companies';
  const companyGstin = co?.gstin || '';
  const initials = (companyName || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

  // Period label for export banners — the active preset's label, else the range.
  const periodLabel = useMemo(() => {
    const p = DATE_PRESETS.find(x => x.key === activePeriod);
    return p ? p.label : `${fmtDate(dateFrom)} — ${fmtDate(dateTo)}`;
  }, [activePeriod, dateFrom, dateTo]);
  const exportMeta = useMemo(() => [`${companyName} · ${periodLabel}`], [companyName, periodLabel]);
  const slug = (s) => String(s || 'export').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // ── Fetch on company / date change ──
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const cp = company ? `company=${company}&` : '';
    const win = `${cp}from=${dateFrom}&to=${dateTo}`;
    const fyParam = String(_fyYear(new Date(dateFrom)));
    setBreakdown(null); setDrillPivot(null); setBranchTx(null); setAccounts(null);
    Promise.all([
      apiClient.get(`/api/purchase/dashboard/?${cp}period=custom&from=${dateFrom}&to=${dateTo}`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/purchase/dashboard/analytics/?${win}`).then(r => r.data?.mom_trend || []).catch(() => []),
      apiClient.get(`/api/purchase/item-rate-trend/?side=purchase&${win}`).then(r => r.data?.items || []).catch(() => []),
      apiClient.get(`/api/purchase/tds-summary/?${cp}fy=${fyParam}`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/purchase/monthly-breakdown/?${win}`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/purchase/item-rate-trend/?side=purchase&mode=pivot&include_single=1&${win}`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/purchase/branch-transfers/?${win}`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/purchase/accounts-summary/?${win}`).then(r => r.data).catch(() => null),
    ]).then(([d, t, it, td, bd, pv, bt, ac]) => {
      if (!alive) return;
      setDash(d); setTrend(t || []); setItems(it || []); setTds(td); setBreakdown(bd); setDrillPivot(pv); setBranchTx(bt); setAccounts(ac);
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [company, dateFrom, dateTo]);

  // ── Vendor Turnover — its own fetch (also keyed on the category filter) ──
  useEffect(() => {
    let alive = true;
    setVturn(null); setVturnOpen(null);
    const cp = company ? `company=${company}&` : '';
    const catP = vturnCat ? `&category=${encodeURIComponent(vturnCat)}` : '';
    const msmeP = vturnMsme ? `&msme=${vturnMsme}` : '';
    apiClient.get(`/api/purchase/vendor-turnover/?${cp}from=${dateFrom}&to=${dateTo}${catP}${msmeP}`)
      .then(r => { if (alive) setVturn(r.data || { months: [], vendors: [] }); })
      .catch(() => { if (alive) setVturn({ months: [], vendors: [] }); });
    return () => { alive = false; };
  }, [company, dateFrom, dateTo, vturnCat, vturnMsme]);

  // ── Payables calendar — live as-of-today snapshot (company only, no window) ──
  useEffect(() => {
    let alive = true;
    setPayCal(null);
    const cp = company ? `company=${company}` : '';
    apiClient.get(`/api/purchase/payables-calendar/?${cp}`)
      .then(r => { if (alive) setPayCal(r.data || { bills: [] }); })
      .catch(() => { if (alive) setPayCal({ bills: [] }); });
    return () => { alive = false; };
  }, [company]);

  // ── Vendor activity — the Vendors group (Top / Inactive / New / Concentration) ──
  useEffect(() => {
    let alive = true;
    setVendorAct(null);
    const cp = company ? `company=${company}&` : '';
    apiClient.get(`/api/purchase/vendor-activity/?${cp}from=${dateFrom}&to=${dateTo}`)
      .then(r => { if (alive) setVendorAct(r.data || { vendors: [] }); })
      .catch(() => { if (alive) setVendorAct({ vendors: [] }); });
    return () => { alive = false; };
  }, [company, dateFrom, dateTo]);

  // ── Derived top-level figures (KPI strip + profile) ──
  const stats = dash?.stats || {};
  const vendorBreakdown = dash?.vendor_breakdown || [];
  const totalPurchase = num(stats.total_purchase?.total?.inclgst ?? stats.bills?.amount);
  const billed = num(stats.bills?.amount);
  const paid = num(stats.amount_paid?.total);
  const payable = num(stats.outstanding_payables?.total);
  const overdue = useMemo(() => vendorBreakdown.reduce((s, r) => s + num(r.overdue), 0), [vendorBreakdown]);
  const billCount = num(stats.bills?.count);
  const vendorCount = vendorBreakdown.length;

  // KPI tiles for the PDF report summary band (passed to every TableExport).
  const reportKpis = useMemo(() => [
    { label: 'Total Purchase', value: fmtINR(totalPurchase), tone: 'indigo' },
    { label: 'Paid', value: fmtINR(paid), tone: 'emerald' },
    { label: 'Payable', value: fmtINR(payable), tone: 'amber' },
    { label: 'Overdue', value: fmtINR(overdue), tone: 'rose' },
  ], [totalPurchase, paid, payable, overdue]);

  // ── Top vendors table rows (sorted by payable) ──
  const topVendors = useMemo(() => {
    const rows = vendorBreakdown
      .map(r => ({
        name: r.vendor_name || '(no vendor)',
        billed: num(r.billed), paid: num(r.paid),
        outstanding: num(r.outstanding), overdue: num(r.overdue),
        is_msme: r.is_msme,
      }))
      .filter(r => r.billed > 0 || r.outstanding > 0)
      .filter(r => !topMsme || (topMsme === 'msme' ? r.is_msme : !r.is_msme))
      .sort((a, b) => b.outstanding - a.outstanding);
    const totalOut = rows.reduce((s, r) => s + r.outstanding, 0);
    return rows.map(r => ({ ...r, pct: totalOut > 0 ? (r.outstanding / totalOut) * 100 : 0 })).slice(0, 25);
  }, [vendorBreakdown, topMsme]);
  const totalPayable = topVendors.reduce((s, r) => s + r.outstanding, 0);
  const totalOverdue = topVendors.reduce((s, r) => s + r.overdue, 0);
  const paymentRate = billed > 0 ? (paid / billed) * 100 : 0;

  // ── Item analytics rows ──
  const itemRows = useMemo(() => (items || [])
    .map(it => {
      const qty = num(it.total_qty); const val = num(it.total_value);
      return { item: it.item, uom: it.uom || '', category: (it.category || '').toUpperCase(), qty, value: val, avg: qty > 0 ? val / qty : 0 };
    })
    .filter(it => !itemCat || it.category === itemCat)
    .sort((a, b) => b.value - a.value)
    .slice(0, 40),
  [items, itemCat]);

  // Lookups for the expandable Item-Analytics rows:
  //  - pivot entry per item name (vendor × month breakdown; multi-vendor items only)
  //  - rate points per item name (MIN/MAX fallback for single-vendor items)
  const pivotByItem = useMemo(() => {
    const m = {};
    (drillPivot?.items || []).forEach(p => { m[p.item] = p; });
    return m;
  }, [drillPivot]);
  const pointsByItem = useMemo(() => {
    const m = {};
    (items || []).forEach(it => { m[it.item] = it.points || []; });
    return m;
  }, [items]);
  const itemMonths = drillPivot?.months || [];

  // MIN / MAX rate for a product: across its vendors' avg rates when in the
  // pivot, else across its monthly rate points. Returns {min, max} or nulls.
  const itemMinMax = (name) => {
    const piv = pivotByItem[name];
    let rates = [];
    if (piv) rates = piv.vendors.map(v => (v.avg_rate != null ? num(v.avg_rate) : null)).filter(r => r != null);
    if (rates.length === 0) rates = (pointsByItem[name] || []).map(p => p.rate).filter(r => r != null).map(num);
    if (rates.length === 0) return { min: null, max: null };
    return { min: Math.min(...rates), max: Math.max(...rates) };
  };

  // ── Item Drill-down derivations ──
  // Items available for the dropdown (from the rate-trend payload), filtered by
  // the category chip. Each carries category + per-month points.
  const drillItems = useMemo(() => {
    const list = (items || []).map(it => ({
      item: it.item, uom: it.uom || '', category: (it.category || '').toUpperCase(),
      qty: num(it.total_qty), value: num(it.total_value), points: it.points || [],
    }));
    const filtered = drillCat ? list.filter(it => it.category === drillCat) : list;
    return filtered.sort((a, b) => b.value - a.value);
  }, [items, drillCat]);

  // Keep the selected item valid for the current category filter.
  useEffect(() => {
    if (drillItems.length === 0) { if (drillItem) setDrillItem(''); return; }
    if (!drillItems.some(it => it.item === drillItem)) setDrillItem(drillItems[0].item);
  }, [drillItems, drillItem]);

  // A new item / company / period invalidates the cached vendor-bill drills.
  useEffect(() => { setDrillOpenVendor(null); setDrillVendorBills({}); }, [drillItem, company, dateFrom, dateTo]);
  // Collapse any open branch-bill drill when the scope changes.
  useEffect(() => { setBranchOpen(null); setBranchBillLines({}); }, [company, dateFrom, dateTo]);

  // Collapse any open Item-Analytics product row when the scope changes.
  useEffect(() => { setItemOpen(null); }, [itemCat, company, dateFrom, dateTo]);

  const drillSelected = useMemo(
    () => drillItems.find(it => it.item === drillItem) || null,
    [drillItems, drillItem]);

  // Vendor×month pivot entry for the selected item (only multi-vendor items are
  // present). months here are 'YYYY-MM' strings.
  const drillPivotItem = useMemo(() => {
    if (!drillPivot || !drillItem) return null;
    return (drillPivot.items || []).find(it => it.item === drillItem) || null;
  }, [drillPivot, drillItem]);
  const drillMonths = drillPivot?.months || [];

  // Vendor-wise rows for the selected item (sorted by value desc).
  const drillVendors = useMemo(() => {
    if (!drillPivotItem) return [];
    const total = num(drillPivotItem.vendors.reduce((s, v) => s + num(v.total_value), 0));
    return drillPivotItem.vendors
      .map(v => ({
        vendor: v.vendor, is_msme: !!v.is_msme, qty: num(v.total_qty), value: num(v.total_value),
        avg: v.avg_rate != null ? num(v.avg_rate) : (num(v.total_qty) > 0 ? num(v.total_value) / num(v.total_qty) : 0),
        cells: v.cells || {},
        pct: total > 0 ? (num(v.total_value) / total) * 100 : 0,
        cheapest: v.vendor === drillPivotItem.cheapest_vendor,
      }))
      .sort((a, b) => b.value - a.value);
  }, [drillPivotItem]);

  // Monthly price summary for the selected item. Avg from rate-trend points;
  // min/max rate across vendors from the pivot cells where available.
  const drillMonthly = useMemo(() => {
    if (!drillSelected) return [];
    const byMonth = {};
    (drillSelected.points || []).forEach(p => {
      if (!p || !p.month) return;
      byMonth[p.month] = { month: p.month, qty: num(p.qty), rate: p.rate != null ? num(p.rate) : null, min: null, max: null, vendors: 0 };
    });
    if (drillPivotItem) {
      drillPivotItem.vendors.forEach(v => {
        Object.entries(v.cells || {}).forEach(([ym, c]) => {
          if (!c || c.rate == null) return;
          const row = byMonth[ym] || (byMonth[ym] = { month: ym, qty: 0, rate: null, min: null, max: null, vendors: 0 });
          row.min = row.min == null ? c.rate : Math.min(row.min, c.rate);
          row.max = row.max == null ? c.rate : Math.max(row.max, c.rate);
          row.vendors += 1;
        });
      });
    }
    return Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));
  }, [drillSelected, drillPivotItem]);

  const drillHasMinMax = useMemo(() => drillMonthly.some(r => r.min != null), [drillMonthly]);

  // ── Purchase trend (bar chart scale) ──
  const trendRows = useMemo(() => (trend || []).map(r => ({
    month: r.month, label: r.label, billed: num(r.billed), paid: num(r.paid),
  })), [trend]);
  const trendMax = useMemo(() => Math.max(1, ...trendRows.flatMap(r => [r.billed, r.paid])), [trendRows]);

  // ── TDS rows ──
  const tdsRows = useMemo(() => (tds?.rows || []).slice(0, 40), [tds]);

  // ── Vendor Turnover derivations ──
  const vturnMonths = vturn?.months || [];
  const vturnVendors = vturn?.vendors || [];
  // Per-month and grand totals for the footer row.
  const vturnTotals = useMemo(() => {
    const byMonth = {}; let grand = 0;
    vturnMonths.forEach(m => { byMonth[m] = 0; });
    vturnVendors.forEach(v => {
      vturnMonths.forEach(m => { byMonth[m] += num(v.by_month?.[m]); });
      grand += num(v.by_month?.total);
    });
    return { byMonth, grand };
  }, [vturnVendors, vturnMonths]);

  // ── Branch Transfers derivations ──
  const branchMonths = branchTx?.months || [];       // [{month, label}]
  const branchRows = branchTx?.branches || [];
  const branchBills = branchTx?.bills || [];
  const branchTotals = useMemo(() => {
    const byMonth = {}; let grand = 0;
    branchMonths.forEach(m => { byMonth[m.month] = 0; });
    branchRows.forEach(b => {
      branchMonths.forEach(m => { byMonth[m.month] += num(b.by_month?.[m.month]); });
      grand += num(b.by_month?.total);
    });
    return { byMonth, grand };
  }, [branchRows, branchMonths]);

  // ── Payables derivations (from the live payables-calendar snapshot) ──
  // Each bill gets daysLate (>0 = overdue) + a status, then the sections slice
  // the same enriched list differently (this week / overdue / upcoming).
  const payBills = useMemo(() => {
    const bills = payCal?.bills || [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return bills
      .filter(b => num(b.balance) > 0)
      .filter(b => !payMsme || (payMsme === 'msme' ? b.vendor_is_msme : !b.vendor_is_msme))
      .filter(b => !payCat || normCat(b.purchase_category) === payCat)
      .map(b => {
        const due = b.due_date ? new Date(b.due_date) : null;
        if (due) due.setHours(0, 0, 0, 0);
        const daysLate = due ? Math.floor((today - due) / 86400000) : 0;
        return { ...b, _due: due, daysLate, overdue: daysLate > 0, amt: num(b.balance) };
      });
  }, [payCal, payMsme, payCat]);
  const payLoading = payCal == null;

  // This Week: already overdue OR due within the next 7 days.
  const payWeek = useMemo(() => {
    const rows = payBills.filter(b => b.overdue || (b.daysLate <= 0 && -b.daysLate <= 7));
    rows.sort((a, b) => (a.overdue === b.overdue ? (a.overdue ? b.daysLate - a.daysLate : a.daysLate - b.daysLate) : (a.overdue ? -1 : 1)));
    const overdueRows = rows.filter(b => b.overdue);
    const dueRows = rows.filter(b => !b.overdue);
    return {
      rows,
      total: rows.reduce((s, b) => s + b.amt, 0),
      overdueTotal: overdueRows.reduce((s, b) => s + b.amt, 0), overdueCount: overdueRows.length,
      dueTotal: dueRows.reduce((s, b) => s + b.amt, 0), dueCount: dueRows.length,
      vendors: new Set(rows.map(b => b.vendor_name)).size,
    };
  }, [payBills]);

  // Overdue Ageing: overdue bills, bucketed by days-late band.
  const AGE_BANDS = [[0, 30, '0-30'], [31, 60, '31-60'], [61, 90, '61-90'], [91, 180, '91-180'], [181, Infinity, '180+']];
  const payAged = useMemo(() => {
    const rows = payBills.filter(b => b.overdue).sort((a, b) => b.daysLate - a.daysLate);
    const bandOf = (d) => (AGE_BANDS.find(([lo, hi]) => d >= lo && d <= hi) || AGE_BANDS[0])[2];
    const bands = AGE_BANDS.map(([, , label]) => {
      const br = rows.filter(b => bandOf(b.daysLate) === label);
      return { label, total: br.reduce((s, b) => s + b.amt, 0), count: br.length };
    });
    return {
      rows, bandOf, bands,
      total: rows.reduce((s, b) => s + b.amt, 0),
      activeBands: bands.filter(b => b.count > 0).length,
      vendors: new Set(rows.map(b => b.vendor_name)).size,
    };
  }, [payBills]); // eslint-disable-line react-hooks/exhaustive-deps

  // Upcoming: not-yet-overdue bills (due in the future), soonest first.
  const payUp = useMemo(() => {
    const rows = payBills.filter(b => !b.overdue).sort((a, b) => a.daysLate - b.daysLate); // daysLate <= 0, nearest 0 first
    const dueIn = (b) => -b.daysLate; // days until due
    const next30 = rows.filter(b => dueIn(b) <= 30);
    const next60 = rows.filter(b => dueIn(b) > 30 && dueIn(b) <= 60);
    const later = rows.filter(b => dueIn(b) > 60);
    return {
      rows,
      next30Total: next30.reduce((s, b) => s + b.amt, 0),
      next60Total: next60.reduce((s, b) => s + b.amt, 0),
      laterTotal: later.reduce((s, b) => s + b.amt, 0),
      vendors: new Set(rows.map(b => b.vendor_name)).size,
    };
  }, [payBills]);

  // Export datasets for the payables tables.
  const expPayWeek = useMemo(() => ({
    cols: [{ field: 'vendor', header: 'Vendor' }, { field: 'invoice', header: 'Invoice' }, { field: 'due', header: 'Due Date' },
      { field: 'days', header: 'Days' }, { field: 'status', header: 'Status' }, { field: 'outstanding', header: 'Outstanding' }],
    data: payWeek.rows.map(b => ({ vendor: b.vendor_name, invoice: b.bill_no || b.vendor_invoice_no || '',
      due: fmtDate(b.due_date), days: b.overdue ? `${b.daysLate}d late` : `in ${-b.daysLate}d`,
      status: b.overdue ? 'OVERDUE' : 'DUE', outstanding: fmtRup(b.amt) })),
  }), [payWeek]);
  const expPayAged = useMemo(() => ({
    cols: [{ field: 'vendor', header: 'Vendor' }, { field: 'invoice', header: 'Invoice' }, { field: 'due', header: 'Due Date' },
      { field: 'days', header: 'Days Late' }, { field: 'band', header: 'Band' }, { field: 'outstanding', header: 'Outstanding' }],
    data: payAged.rows.map(b => ({ vendor: b.vendor_name, invoice: b.bill_no || b.vendor_invoice_no || '',
      due: fmtDate(b.due_date), days: `${b.daysLate}d`, band: payAged.bandOf(b.daysLate), outstanding: fmtRup(b.amt) })),
  }), [payAged]);
  const expPayUp = useMemo(() => ({
    cols: [{ field: 'vendor', header: 'Vendor' }, { field: 'invoice', header: 'Invoice' }, { field: 'due', header: 'Due Date' },
      { field: 'dueIn', header: 'Due In' }, { field: 'category', header: 'Category' }, { field: 'outstanding', header: 'Outstanding' }],
    data: payUp.rows.map(b => ({ vendor: b.vendor_name, invoice: b.bill_no || b.vendor_invoice_no || '',
      due: fmtDate(b.due_date), dueIn: `in ${-b.daysLate}d`, category: normCat(b.purchase_category), outstanding: fmtRup(b.amt) })),
  }), [payUp]);

  // ── Vendors group derivations (from the vendor-activity endpoint) ──
  // The filtered vendor list (Category + MSME header filters) feeds all 4
  // sections. period_value/period_bills are windowed; first/last/lifetime/
  // outstanding/days_inactive are all-time.
  const vendList = useMemo(() => {
    const vs = vendorAct?.vendors || [];
    return vs
      .filter(v => !vendMsme || (vendMsme === 'msme' ? v.is_msme : !v.is_msme))
      .filter(v => !vendCat || normCat(v.purchase_category) === vendCat);
  }, [vendorAct, vendMsme, vendCat]);
  const vendLoading = vendorAct == null;

  // v_top: vendors with purchases this period, ranked by period_value.
  const vTop = useMemo(() => {
    const rows = vendList.filter(v => v.period_value > 0).sort((a, b) => b.period_value - a.period_value);
    const total = rows.reduce((s, v) => s + v.period_value, 0);
    const top10 = rows.slice(0, 10).reduce((s, v) => s + v.period_value, 0);
    const repeat = rows.filter(v => v.period_bills > 1).length;
    return {
      rows: rows.map((v, i) => ({ ...v, rank: i + 1, pct: total > 0 ? (v.period_value / total) * 100 : 0 })),
      total, top10, count: rows.length,
      avg: rows.length ? total / rows.length : 0,
      repeatRate: rows.length ? (repeat / rows.length) * 100 : 0,
    };
  }, [vendList]);

  // v_inact: vendors with no bill in 30+ days, risk-banded.
  const vInact = useMemo(() => {
    const rows = vendList.filter(v => v.days_inactive != null && v.days_inactive >= 30)
      .sort((a, b) => b.days_inactive - a.days_inactive);
    const riskOf = (d) => (d >= 90 ? 'HIGH' : d >= 60 ? 'MEDIUM' : 'LOW');
    const c90 = rows.filter(v => v.days_inactive >= 90);
    const c60 = rows.filter(v => v.days_inactive >= 60 && v.days_inactive < 90);
    const c30 = rows.filter(v => v.days_inactive >= 30 && v.days_inactive < 60);
    return {
      rows: rows.map(v => ({ ...v, risk: riskOf(v.days_inactive) })),
      c90: c90.length, c60: c60.length, c30: c30.length,
      lostValue: c90.reduce((s, v) => s + v.lifetime_value, 0),
    };
  }, [vendList]);

  // v_new: vendors whose FIRST bill falls inside the window.
  const vNew = useMemo(() => {
    const inWin = (iso) => iso && iso >= dateFrom && iso <= dateTo;
    const rows = vendList.filter(v => inWin(v.first_bill_date)).sort((a, b) => b.period_value - a.period_value);
    const value = rows.reduce((s, v) => s + v.period_value, 0);
    const multi = rows.filter(v => v.period_bills > 1).length;
    return {
      rows, count: rows.length, value,
      avg: rows.length ? value / rows.length : 0,
      multiRate: rows.length ? (multi / rows.length) * 100 : 0,
    };
  }, [vendList, dateFrom, dateTo]);

  // v_conc: revenue concentration over period_value (tiers + cumulative).
  const vConc = useMemo(() => {
    const ranked = vendList.filter(v => v.period_value > 0).sort((a, b) => b.period_value - a.period_value);
    const total = ranked.reduce((s, v) => s + v.period_value, 0) || 1;
    const sumRange = (a, b) => ranked.slice(a, b).reduce((s, v) => s + v.period_value, 0);
    const TIERS = [['Top 5', 0, 5, 'indigo'], ['6-10', 5, 10, 'amber'], ['11-20', 10, 20, 'sky'],
      ['21-50', 20, 50, 'emerald'], ['Others', 50, ranked.length, 'slate']];
    let cum = 0;
    const tiers = TIERS.map(([label, a, b, tone]) => {
      const n = Math.max(0, Math.min(b, ranked.length) - a);
      const val = sumRange(a, b);
      cum += val;
      return { label, tone, count: n, value: val, pct: (val / total) * 100, cumPct: (cum / total) * 100,
        avg: n ? val / n : 0 };
    }).filter(t => t.count > 0 || t.label === 'Top 5');
    const pctOf = (b) => (sumRange(0, b) / total) * 100;
    const top5 = pctOf(5);
    return { tiers, total, top5, top10: pctOf(10), top20: pctOf(20),
      risk: top5 > 40 ? 'HIGH' : top5 > 25 ? 'MEDIUM' : 'LOW' };
  }, [vendList]);

  // Export datasets for the Vendors tables.
  const expVTop = useMemo(() => ({
    cols: [{ field: 'rank', header: '#' }, { field: 'vendor', header: 'Vendor' }, { field: 'category', header: 'Category' },
      { field: 'value', header: 'Purchase Value' }, { field: 'outstanding', header: 'Outstanding' }, { field: 'pct', header: '% Share' }],
    data: vTop.rows.map(v => ({ rank: v.rank, vendor: v.vendor_name + (v.is_msme ? ' (MSME)' : ''),
      category: normCat(v.purchase_category) || '—', value: fmtRup(v.period_value),
      outstanding: fmtRup(v.outstanding), pct: `${v.pct.toFixed(1)}%` })),
  }), [vTop]);
  const expVInact = useMemo(() => ({
    cols: [{ field: 'vendor', header: 'Vendor' }, { field: 'category', header: 'Category' }, { field: 'last', header: 'Last Bill' },
      { field: 'days', header: 'Days Inactive' }, { field: 'lifetime', header: 'Lifetime Value' }, { field: 'outstanding', header: 'Outstanding' }, { field: 'risk', header: 'Risk' }],
    data: vInact.rows.map(v => ({ vendor: v.vendor_name, category: normCat(v.purchase_category) || '—',
      last: fmtDate(v.last_bill_date), days: `${v.days_inactive}d`, lifetime: fmtRup(v.lifetime_value),
      outstanding: fmtRup(v.outstanding), risk: v.risk })),
  }), [vInact]);
  const expVNew = useMemo(() => ({
    cols: [{ field: 'vendor', header: 'Vendor' }, { field: 'category', header: 'Category' }, { field: 'first', header: 'First Bill' },
      { field: 'bills', header: 'Bills' }, { field: 'value', header: 'Value' }, { field: 'status', header: 'Status' }],
    data: vNew.rows.map(v => ({ vendor: v.vendor_name, category: normCat(v.purchase_category) || '—',
      first: fmtDate(v.first_bill_date), bills: v.period_bills, value: fmtRup(v.period_value),
      status: v.period_bills > 1 ? 'ACTIVE' : '1 BILL' })),
  }), [vNew]);
  const expVConc = useMemo(() => ({
    cols: [{ field: 'tier', header: 'Tier' }, { field: 'vendors', header: 'Vendors' }, { field: 'value', header: 'Value' },
      { field: 'pct', header: '% of total' }, { field: 'cum', header: 'Cumulative %' }, { field: 'avg', header: 'Avg / Vendor' }],
    data: vConc.tiers.map(t => ({ tier: t.label, vendors: t.count, value: fmtRup(t.value),
      pct: `${t.pct.toFixed(1)}%`, cum: `${t.cumPct.toFixed(1)}%`, avg: fmtRup(t.avg) })),
  }), [vConc]);

  // ── v_score: vendor reliability scorecard (return rate + inactivity). ──
  const scoreOf = (v) => {
    const r = num(v.return_rate), d = v.days_inactive == null ? 0 : v.days_inactive;
    if (r > 5 || d > 90) return 'POOR';
    if (r > 2 || d > 60) return 'FAIR';
    return 'GOOD';
  };
  const vScore = useMemo(() => {
    const rows = vendList.filter(v => v.period_value > 0 || v.lifetime_value > 0)
      .map(v => ({ ...v, score: scoreOf(v), return_rate: num(v.return_rate) }))
      .sort((a, b) => b.period_value - a.period_value);
    const avgRet = rows.length ? rows.reduce((s, v) => s + v.return_rate, 0) / rows.length : 0;
    const flagged = rows.filter(v => v.score === 'POOR').length;
    return { rows, count: rows.length, avgRet, flagged };
  }, [vendList]);
  const expVScore = useMemo(() => ({
    cols: [{ field: 'vendor', header: 'Vendor' }, { field: 'category', header: 'Category' }, { field: 'value', header: 'Purchase Value' },
      { field: 'bills', header: 'Bills' }, { field: 'ret', header: 'Return Rate' }, { field: 'outstanding', header: 'Outstanding' }, { field: 'score', header: 'Score' }],
    data: vScore.rows.map(v => ({ vendor: v.vendor_name + (v.is_msme ? ' (MSME)' : ''), category: normCat(v.purchase_category) || '—',
      value: fmtRup(v.period_value), bills: v.period_bills, ret: `${v.return_rate.toFixed(1)}%`,
      outstanding: fmtRup(v.outstanding), score: v.score })),
  }), [vScore]);

  // ── v_single: items bought from exactly ONE vendor (supply risk). ──
  const vSingle = useMemo(() => {
    const items = (drillPivot?.items || [])
      .filter(it => (it.vendors || []).length === 1)
      .filter(it => !vendCat || normCat(it.category) === vendCat)
      .map(it => {
        const v = it.vendors[0];
        return { item: it.item, category: normCat(it.category) || '—', vendor: v.vendor,
          is_msme: !!v.is_msme, qty: num(v.total_qty), value: num(v.total_value), uom: it.uom || '' };
      })
      .sort((a, b) => b.value - a.value);
    const exposed = items.reduce((s, i) => s + i.value, 0);
    const totalAll = (drillPivot?.items || []).reduce((s, it) => s + (it.vendors || []).reduce((t, v) => t + num(v.total_value), 0), 0);
    return { items, count: items.length, exposed, pct: totalAll > 0 ? (exposed / totalAll) * 100 : 0 };
  }, [drillPivot, vendCat]);
  const expVSingle = useMemo(() => ({
    cols: [{ field: 'item', header: 'Item' }, { field: 'category', header: 'Category' }, { field: 'vendor', header: 'Sole Vendor' },
      { field: 'qty', header: 'Qty' }, { field: 'value', header: 'Value' }],
    data: vSingle.items.map(i => ({ item: i.item, category: i.category, vendor: i.vendor + (i.is_msme ? ' (MSME)' : ''),
      qty: fmtQty(i.qty), value: fmtRup(i.value) })),
  }), [vSingle]);

  // ── v_msme: MSME payables aged vs the 45-day MSMED limit (§43B(h)). ──
  const vMsme = useMemo(() => {
    const bills = (payCal?.bills || []).filter(b => b.vendor_is_msme === true)
      .map(b => {
        const d = b.bill_date ? Math.floor((Date.now() - new Date(b.bill_date).getTime()) / 86400000) : null;
        return { ...b, daysSinceBill: d, over45: d != null && d > 45 };
      })
      .sort((a, b) => (b.daysSinceBill || 0) - (a.daysSinceBill || 0));
    const total = bills.reduce((s, b) => s + num(b.balance), 0);
    const over = bills.filter(b => b.over45);
    const overTotal = over.reduce((s, b) => s + num(b.balance), 0);
    const vendors = new Set(bills.map(b => b.vendor_name)).size;
    return { bills, vendors, total, overTotal, overCount: over.length };
  }, [payCal]);
  const expVMsme = useMemo(() => ({
    cols: [{ field: 'vendor', header: 'Vendor' }, { field: 'bill', header: 'Bill' }, { field: 'date', header: 'Bill Date' },
      { field: 'days', header: 'Days Since Bill' }, { field: 'balance', header: 'Balance' }, { field: 'status', header: 'Status' }],
    data: vMsme.bills.map(b => ({ vendor: b.vendor_name, bill: b.bill_no || b.vendor_invoice_no || '—',
      date: fmtDate(b.bill_date), days: b.daysSinceBill == null ? '—' : `${b.daysSinceBill}d`,
      balance: fmtRup(b.balance), status: b.over45 ? 'OVERDUE-45' : 'DUE' })),
  }), [vMsme]);

  // ── v_price: multi-vendor items with price creep / overpay vs cheapest. ──
  const vPrice = useMemo(() => {
    const items = (drillPivot?.items || [])
      .filter(it => (it.vendors || []).length > 1)
      .filter(it => !vendCat || normCat(it.category) === vendCat)
      .map(it => {
        const vendors = it.vendors || [];
        const rated = vendors.filter(v => v.avg_rate != null);
        const cheapRate = rated.length ? Math.min(...rated.map(v => num(v.avg_rate))) : 0;
        const overpay = vendors.reduce((s, v) => {
          if (v.avg_rate == null) return s;
          return s + Math.max(0, (num(v.avg_rate) - cheapRate)) * num(v.total_qty);
        }, 0);
        const curAvg = (() => {
          const tq = vendors.reduce((s, v) => s + num(v.total_qty), 0);
          const tv = vendors.reduce((s, v) => s + num(v.total_value), 0);
          return tq > 0 ? tv / tq : 0;
        })();
        return { item: it.item, category: normCat(it.category) || '—', curAvg,
          change_pct: it.change_pct, spread_pct: it.spread_pct, cheapest: it.cheapest_vendor || '—', overpay };
      })
      .sort((a, b) => b.overpay - a.overpay);
    const rising = items.filter(i => num(i.change_pct) > 0).length;
    const changes = items.filter(i => i.change_pct != null).map(i => num(i.change_pct));
    const avgChange = changes.length ? changes.reduce((s, c) => s + c, 0) / changes.length : 0;
    const saving = items.reduce((s, i) => s + i.overpay, 0);
    return { items, rising, avgChange, saving, count: items.length };
  }, [drillPivot, vendCat]);
  const expVPrice = useMemo(() => ({
    cols: [{ field: 'item', header: 'Item' }, { field: 'category', header: 'Category' }, { field: 'avg', header: 'Current Avg' },
      { field: 'change', header: 'Change %' }, { field: 'spread', header: 'Spread %' }, { field: 'cheapest', header: 'Cheapest Vendor' }, { field: 'overpay', header: 'Overpay' }],
    data: vPrice.items.map(i => ({ item: i.item, category: i.category, avg: fmtRup(i.curAvg),
      change: i.change_pct == null ? '—' : `${num(i.change_pct) > 0 ? '▲' : '▼'} ${Math.abs(num(i.change_pct)).toFixed(1)}%`,
      spread: i.spread_pct == null ? '—' : `${num(i.spread_pct).toFixed(1)}%`, cheapest: i.cheapest, overpay: fmtRup(i.overpay) })),
  }), [vPrice]);

  // ── Export datasets (cols + flat rows) per table ──
  // Top Vendors
  const expTopVendors = useMemo(() => ({
    cols: [{ field: 'vendor', header: 'Vendor' }, { field: 'billed', header: 'Billed' },
      { field: 'payable', header: 'Payable' }, { field: 'overdue', header: 'Overdue' }, { field: 'pct', header: '% of total' }],
    data: topVendors.map(r => ({ vendor: r.name + (r.is_msme ? ' (MSME)' : ''), billed: fmtRup(r.billed),
      payable: fmtRup(r.outstanding), overdue: fmtRup(r.overdue), pct: `${r.pct.toFixed(1)}%` })),
  }), [topVendors]);

  // Item Analytics — Product Summary, EXPANDED: every product row followed by
  // its per-vendor x month breakdown (what the UI shows when a row is opened),
  // so the download carries the drill-down detail, not just the top level.
  const expItems = useMemo(() => {
    const months = itemMonths;
    const cols = [
      { field: 'product', header: 'Product / Vendor' },
      { field: 'uom', header: 'UOM' },
      { field: 'qty', header: 'Qty' },
      { field: 'avg', header: 'Avg price' },
      { field: 'min', header: 'Min' },
      { field: 'max', header: 'Max' },
      ...months.map(m => ({ field: `m_${m}`, header: monthLabel(m) })),
      { field: 'value', header: 'Value' },
    ];
    const data = [];
    itemRows.forEach(r => {
      const { min, max } = itemMinMax(r.item);
      const base = { product: r.item, uom: r.uom || '', qty: fmtQty(r.qty), avg: fmtRup(r.avg),
        min: min != null ? fmtRup(min) : '', max: max != null ? fmtRup(max) : '', value: fmtRup(r.value) };
      months.forEach(m => { base[`m_${m}`] = ''; });   // product row leaves months blank
      data.push(base);
      // vendor rows (indented), each with its per-month qty · value
      const piv = pivotByItem[r.item];
      (piv?.vendors || []).forEach(v => {
        const row = { product: `   ${v.vendor}`, uom: r.uom || '',
          qty: fmtQty(num(v.total_qty)), avg: v.avg_rate != null ? fmtRup(v.avg_rate) : '',
          min: '', max: '', value: fmtRup(num(v.total_value)) };
        months.forEach(m => {
          const c = v.cells?.[m];
          row[`m_${m}`] = (c && c.qty) ? `${fmtQty(c.qty)} · ${fmtRup(c.rate)}` : '';
        });
        data.push(row);
      });
    });
    return { cols, data };
  }, [itemRows, pivotByItem, itemMonths]); // eslint-disable-line react-hooks/exhaustive-deps

  // Purchase Trend — monthly breakdown (compact + exact share the shape)
  const buildBreakdownExport = (fmt) => {
    const months = breakdown?.months || [];
    const rows = breakdown?.rows || {};
    const cols = [{ field: 'type', header: 'Type' }, ...months.map(m => ({ field: `m_${m.month}`, header: m.label })), { field: 'total', header: 'Total' }];
    const defs = [['Purchases', 'purchases', ''], ['+ Debit Notes', 'debit_notes', '+'], ['- Credit Notes', 'credit_notes', '-'],
      ['Net Turnover', 'net', ''], ['Branch Transfers', 'branch_transfers', ''], ['Freight / Charges', 'freight', '']];
    const data = defs.map(([label, k, sign]) => {
      const row = { type: label };
      months.forEach(m => { const v = rows[k]?.[m.month]; row[`m_${m.month}`] = v ? `${sign}${fmt(v)}` : ''; });
      row.total = rows[k]?.total ? `${sign}${fmt(rows[k].total)}` : '';
      return row;
    });
    return { cols, data };
  };
  const expTrend = useMemo(() => buildBreakdownExport(fmtINR), [breakdown]); // eslint-disable-line react-hooks/exhaustive-deps
  const expTrendExact = useMemo(() => buildBreakdownExport(fmtExact), [breakdown]); // eslint-disable-line react-hooks/exhaustive-deps

  // Vendor Turnover
  // Vendor Turnover, EXPANDED: each vendor row followed by its "Items Purchased"
  // rows (per-month value), so the download carries the drill detail too.
  const expVturn = useMemo(() => {
    const cols = [{ field: 'vendor', header: 'Vendor / Item' },
      ...vturnMonths.map(m => ({ field: `m_${m}`, header: monthLabel(m) })), { field: 'total', header: 'Total' }];
    const data = [];
    vturnVendors.forEach(v => {
      const row = { vendor: v.vendor };
      vturnMonths.forEach(m => { row[`m_${m}`] = v.by_month?.[m] ? fmtRup(v.by_month[m]) : ''; });
      row.total = fmtRup(v.by_month?.total);
      data.push(row);
      (v.items || []).forEach(it => {
        const ir = { vendor: `   ${it.item}` };
        vturnMonths.forEach(m => {
          const c = it.by_month?.[m];
          ir[`m_${m}`] = (c && c.value) ? fmtRup(c.value) : '';
        });
        ir.total = fmtRup(num(it.total_value));
        data.push(ir);
      });
    });
    return { cols, data };
  }, [vturnVendors, vturnMonths]);

  // Item Drill-down — vendor-wise
  const expDrillVendors = useMemo(() => ({
    cols: [{ field: 'vendor', header: 'Vendor' }, { field: 'uom', header: 'UOM' }, { field: 'qty', header: 'Qty' },
      { field: 'avg', header: 'Avg Price' }, { field: 'value', header: 'Total Value' }, { field: 'pct', header: '% Share' }],
    data: drillVendors.map(v => ({ vendor: v.vendor + (v.cheapest ? ' (cheapest)' : ''), uom: drillSelected?.uom || '',
      qty: fmtQty(v.qty), avg: fmtRup(v.avg), value: fmtRup(v.value), pct: `${v.pct.toFixed(1)}%` })),
  }), [drillVendors, drillSelected]);

  // Item Drill-down — monthly price summary
  const expDrillMonthly = useMemo(() => ({
    cols: [{ field: 'month', header: 'Month' }, { field: 'qty', header: 'Qty' }, { field: 'avg', header: 'Avg Price' },
      ...(drillHasMinMax ? [{ field: 'min', header: 'Min Price' }, { field: 'max', header: 'Max Price' }] : [])],
    data: drillMonthly.map(r => ({ month: monthLabel(r.month), qty: r.qty ? fmtQty(r.qty) : '', avg: r.rate != null ? fmtRup(r.rate) : '',
      min: r.min != null ? fmtRup(r.min) : '', max: r.max != null ? fmtRup(r.max) : '' })),
  }), [drillMonthly, drillHasMinMax]);

  // Item Drill-down — vendor × month pivot (uses the active measure)
  const expDrillPivot = useMemo(() => {
    const fmtCell = (x) => x == null ? '' : (drillMeasure === 'value' ? fmtRup(x) : drillMeasure === 'rate' ? fmtRup(x) : fmtQty(x));
    const cols = [{ field: 'vendor', header: 'Vendor' }, ...drillMonths.map(m => ({ field: `m_${m}`, header: monthLabel(m) })), { field: 'total', header: 'Total' }];
    const data = drillVendors.map(v => {
      const row = { vendor: v.vendor };
      drillMonths.forEach(m => {
        const c = v.cells[m];
        const val = !c ? null : drillMeasure === 'qty' ? c.qty : drillMeasure === 'rate' ? c.rate : (c.rate != null && c.qty != null ? c.rate * c.qty : null);
        row[`m_${m}`] = fmtCell(val);
      });
      row.total = fmtCell(drillMeasure === 'qty' ? v.qty : drillMeasure === 'value' ? v.value : v.avg);
      return row;
    });
    return { cols, data };
  }, [drillVendors, drillMonths, drillMeasure]);

  // TDS Summary
  const expTds = useMemo(() => ({
    cols: [{ field: 'vendor', header: 'Vendor' }, { field: 'section', header: 'Section' }, { field: 'rate', header: 'Rate' },
      { field: 'base', header: 'FY base' }, { field: 'erp', header: 'ERP TDS' }, { field: 'tally', header: 'Tally TDS' }, { field: 'diff', header: 'Diff' }],
    data: tdsRows.map(r => ({ vendor: r.vendor, section: r.section || '', rate: `${num(r.rate_pct).toFixed(2)}%`,
      base: fmtRup(num(r.fy_aggregate)), erp: fmtRup(num(r.erp_tds)), tally: fmtRup(num(r.tally_tds)), diff: fmtRup(num(r.difference)) })),
  }), [tdsRows]);

  // ── Accounts group (Payment Efficiency / Credit-Debit Notes / GST) ──
  const acc = accounts || null;
  const accGst = acc?.gst || {};
  const accNotes = acc?.notes || {};
  const accPay = acc?.payment || {};
  // Payment Efficiency — month-wise billed/paid/% pivot + slowest payers.
  const expPayTrend = useMemo(() => {
    const months = accPay.monthly || [];
    const cols = [{ field: 'metric', header: 'Metric' }, ...months.map(m => ({ field: `m_${m.month}`, header: m.label }))];
    const row = (metric, pick) => { const r = { metric }; months.forEach(m => { r[`m_${m.month}`] = pick(m); }); return r; };
    return { cols, data: [
      row('Billed', m => m.billed ? fmtRup(m.billed) : ''),
      row('Paid', m => m.paid ? fmtRup(m.paid) : ''),
      row('Payment %', m => m.pct != null ? `${m.pct}%` : '—'),
    ] };
  }, [accPay.monthly]);
  const expSlowest = useMemo(() => ({
    cols: [{ field: 'vendor', header: 'Vendor' }, { field: 'outstanding', header: 'Outstanding' },
      { field: 'overdue', header: 'Overdue' }, { field: 'rating', header: 'Rating' }],
    data: (accPay.slowest || []).map(r => ({ vendor: r.vendor, outstanding: fmtRup(r.outstanding),
      overdue: r.overdue ? fmtRup(r.overdue) : '—', rating: r.rating })),
  }), [accPay.slowest]);
  // Credit/Debit Notes — recent lists.
  const expDebitNotes = useMemo(() => ({
    cols: [{ field: 'no', header: 'No' }, { field: 'vendor', header: 'Vendor' }, { field: 'date', header: 'Date' }, { field: 'amount', header: 'Amount' }],
    data: (accNotes.recent_debit || []).map(r => ({ no: r.no, vendor: r.vendor, date: r.date ? fmtDate(r.date) : '', amount: fmtRup(r.amount) })),
  }), [accNotes.recent_debit]);
  const expCreditNotes = useMemo(() => ({
    cols: [{ field: 'no', header: 'No' }, { field: 'vendor', header: 'Vendor' }, { field: 'date', header: 'Date' }, { field: 'amount', header: 'Amount' }],
    data: (accNotes.recent_credit || []).map(r => ({ no: r.no, vendor: r.vendor, date: r.date ? fmtDate(r.date) : '', amount: fmtRup(r.amount) })),
  }), [accNotes.recent_credit]);
  // GST — monthly pivot.
  const expGstMonthly = useMemo(() => ({
    cols: [{ field: 'month', header: 'Month' }, { field: 'cgst', header: 'CGST' }, { field: 'sgst', header: 'SGST' },
      { field: 'igst', header: 'IGST' }, { field: 'total', header: 'Total GST' }],
    data: (accGst.monthly || []).map(m => ({ month: m.label, cgst: fmtRup(m.cgst), sgst: fmtRup(m.sgst),
      igst: fmtRup(m.igst), total: fmtRup(m.total_gst) })),
  }), [accGst.monthly]);
  const cnPctOfPurchases = num(accNotes.credit_total) && totalPurchase ? (num(accNotes.credit_total) / totalPurchase * 100) : 0;

  // Branch Transfers — summary (branch × month) + bills
  const expBranchSummary = useMemo(() => ({
    cols: [{ field: 'branch', header: 'Branch' }, ...branchMonths.map(m => ({ field: `m_${m.month}`, header: m.label })), { field: 'total', header: 'Total' }],
    data: branchRows.map(b => {
      const row = { branch: b.branch };
      branchMonths.forEach(m => { row[`m_${m.month}`] = b.by_month?.[m.month] ? fmtRup(b.by_month[m.month]) : ''; });
      row.total = fmtRup(b.by_month?.total);
      return row;
    }),
  }), [branchRows, branchMonths]);
  const expBranchBills = useMemo(() => ({
    cols: [{ field: 'invoice', header: 'Invoice #' }, { field: 'date', header: 'Date' }, { field: 'branch', header: 'Branch' },
      { field: 'taxable', header: 'Taxable' }, { field: 'total', header: 'Total (incl GST)' }],
    data: branchBills.map(r => ({ invoice: r.bill_no || '', date: fmtDate(r.bill_date), branch: r.branch,
      taxable: fmtRup(r.taxable), total: fmtRup(r.total) })),
  }), [branchBills]);

  // ── Render ──
  return createPortal(
    <div className="fixed inset-0 z-50 bg-slate-50 flex flex-col text-[13px] leading-relaxed" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* ── Top bar ── */}
      <div className="flex items-center gap-2.5 px-4 py-2 bg-white border-b-2 border-slate-200 flex-shrink-0">
        <button onClick={goBack} className="p-1.5 rounded-lg hover:bg-indigo-50 text-indigo-600 transition"><ChevronLeft size={18} /></button>
        {/* Company switcher — click the avatar/name to change the global company. */}
        <div className="relative flex-1 min-w-0">
          <button type="button" onClick={() => setCompanyMenuOpen(o => !o)}
            className="flex items-center gap-2.5 max-w-full rounded-lg px-1.5 py-1 -mx-1.5 hover:bg-slate-50 transition">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 text-white flex items-center justify-center font-extrabold text-[13px] flex-shrink-0">{initials}</div>
            <div className="min-w-0 text-left">
              <div className="text-sm font-bold text-slate-900 truncate flex items-center gap-1">
                {companyName}
                <ChevronDown size={13} className={`text-slate-400 transition-transform ${companyMenuOpen ? 'rotate-180' : ''}`} />
              </div>
              <div className="text-[10px] text-slate-400 truncate">{[companyGstin && `GSTIN: ${companyGstin}`, 'Purchase workspace'].filter(Boolean).join(' · ')}</div>
            </div>
          </button>
          {companyMenuOpen && (
            <>
              <div className="fixed inset-0 z-[5]" onClick={() => setCompanyMenuOpen(false)} />
              <div className="absolute left-0 top-full mt-1.5 z-10 w-64 bg-white border border-slate-200 rounded-xl shadow-xl py-1.5">
                <div className="px-3 py-1 text-[9px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5"><Building2 size={11} /> Company</div>
                {[{ id: '', legal_name: 'All Companies', trade_name: '' }, ...(companies || [])].map((c) => {
                  const cid = String(c.id || '');
                  const isActive = cid === String(company || '');
                  const nm = c.legal_name || c.trade_name || c.company_code || 'Company';
                  return (
                    <button key={cid || 'all'} type="button"
                      onClick={() => { setCompany(cid); setCompanyMenuOpen(false); }}
                      className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-[12.5px] text-left hover:bg-indigo-50 ${isActive ? 'text-indigo-700 font-semibold bg-indigo-50/60' : 'text-slate-700'}`}>
                      <span className="truncate">{nm}</span>
                      {isActive && <Check size={14} className="text-indigo-600 flex-shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
        <div className="hidden md:flex items-center gap-3.5 text-[11px] font-medium text-slate-600">
          <span>Purchase <b className="ml-1 text-indigo-600">{fmtINR(totalPurchase)}</b></span>
          <span>Billed <b className="ml-1 text-sky-600">{fmtINR(billed)}</b></span>
          <span>Paid <b className="ml-1 text-emerald-600">{fmtINR(paid)}</b></span>
          <span>Payable <b className="ml-1 text-amber-600">{fmtINR(payable)}</b></span>
          {overdue > 0 && <span>Overdue <b className="ml-1 text-red-600">{fmtINR(overdue)}</b></span>}
        </div>
        <button onClick={goBack} className="p-1.5 rounded-lg hover:bg-indigo-50 text-slate-400 hover:text-slate-600 transition ml-2"><X size={16} /></button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* ── Sidebar ── */}
        <div className="flex-shrink-0 w-[250px] bg-white border-r-2 border-slate-200 flex flex-col overflow-hidden">
          {/* Company profile */}
          <div className="p-3 border-b border-slate-100 flex-shrink-0">
            <button onClick={() => setProfileCollapsed(!profileCollapsed)}
              className="w-full flex items-center justify-between text-[10px] font-semibold text-indigo-600">
              <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-indigo-500"></span> Company Profile</span>
              <ChevronDown size={10} className={`text-slate-400 transition-transform ${profileCollapsed ? '-rotate-90' : ''}`} />
            </button>
            <div className={`overflow-hidden transition-all duration-200 ${profileCollapsed ? 'max-h-0 opacity-0' : 'max-h-[500px] opacity-100 mt-2'}`}>
              <div className="space-y-1 text-[11px]">
                <div className="flex justify-between"><span className="text-slate-600 font-medium">GSTIN</span><span className={`font-semibold tabular-nums ${companyGstin ? 'text-slate-900' : 'text-slate-300'}`}>{companyGstin || '—'}</span></div>
                {co?.pan && <div className="flex justify-between"><span className="text-slate-600 font-medium">PAN</span><span className="font-semibold tabular-nums text-slate-900">{co.pan}</span></div>}
                <div className="border-t border-slate-100 my-1.5 pt-1.5"></div>
                <div className="flex justify-between"><span className="text-slate-600 font-medium">Total Purchase</span><span className="font-bold text-indigo-600">{fmtINR(totalPurchase)}</span></div>
                <div className="flex justify-between"><span className="text-slate-600 font-medium">Paid</span><span className="font-bold text-emerald-600">{fmtINR(paid)}</span></div>
                <div className="flex justify-between"><span className="text-slate-600 font-medium">Payable</span><span className="font-bold text-amber-600">{fmtINR(payable)}</span></div>
                {overdue > 0 && <div className="flex justify-between"><span className="text-slate-600 font-medium">Overdue</span><span className="font-bold text-red-600">{fmtINR(overdue)}</span></div>}
                <div className="border-t border-slate-100 my-1.5 pt-1.5"></div>
                <div className="flex justify-between"><span className="text-slate-600 font-medium">Vendors</span><span className="font-bold text-slate-900">{vendorCount}</span></div>
                <div className="flex justify-between"><span className="text-slate-600 font-medium">Bills</span><span className="font-bold text-slate-900">{billCount}</span></div>
              </div>
            </div>
          </div>

          {/* Nav groups */}
          <div className="flex-1 overflow-y-auto p-1.5">
            {NAV_GROUPS.map(g => (
              <div key={g.title} className="mb-0.5">
                <button onClick={() => toggleGroup(g.title)}
                  className="w-full flex items-center gap-1 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-indigo-700 hover:text-indigo-800 hover:bg-indigo-50 rounded transition-colors">
                  <ChevronDown size={11} className={`text-indigo-400 transition-transform ${expandedGroups[g.title] ? '' : '-rotate-90'}`} />
                  <span>{g.title}</span>
                </button>
                {expandedGroups[g.title] && g.items.map(item => {
                  const Icon = item.icon;
                  const isActive = activeSection === item.id;
                  return (
                    <button key={item.id} onClick={() => selectSection(item.id)}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors ${isActive ? 'bg-indigo-50 text-indigo-700 font-semibold border-l-2 border-indigo-600' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}>
                      <Icon size={14} className="flex-shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* ── Main content ── */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <div className="px-5 py-2.5 bg-white border-b border-slate-200 flex items-center justify-between gap-3 flex-shrink-0">
            <h2 className="text-base font-bold text-slate-900 shrink-0">{sectionTitle}</h2>
            <div className="flex items-center gap-2.5 ml-auto">
            {activeSection === 'pa_vturn' && (
              <>
                <select value={vturnCat} onChange={e => { setVturnCat(e.target.value); setVturnOpen(null); }}
                  className="border border-slate-300 rounded-lg pl-3 pr-8 py-1.5 text-sm font-medium text-slate-700 bg-white focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 min-w-[150px]">
                  {DRILL_CATS.map(c => <option key={c.key || 'all'} value={c.key}>{c.key ? c.label : 'All Categories'}</option>)}
                </select>
                <select value={vturnMsme} onChange={e => { setVturnMsme(e.target.value); setVturnOpen(null); }}
                  className="border border-slate-300 rounded-lg pl-3 pr-8 py-1.5 text-sm font-medium text-slate-700 bg-white focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 min-w-[130px]">
                  {MSME_OPTS.map(o => <option key={o.key || 'all'} value={o.key}>{o.label}</option>)}
                </select>
              </>
            )}
            {activeSection === 'top_vend' && (
              <select value={topMsme} onChange={e => setTopMsme(e.target.value)}
                className="border border-slate-300 rounded-lg pl-3 pr-8 py-1.5 text-sm font-medium text-slate-700 bg-white focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 min-w-[130px]">
                {MSME_OPTS.map(o => <option key={o.key || 'all'} value={o.key}>{o.label}</option>)}
              </select>
            )}
            {activeSection === 'pa_item' && (
              <select value={itemCat} onChange={e => setItemCat(e.target.value)}
                className="border border-slate-300 rounded-lg pl-3 pr-8 py-1.5 text-sm font-medium text-slate-700 bg-white focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 min-w-[150px]">
                {DRILL_CATS.map(c => <option key={c.key || 'all'} value={c.key}>{c.key ? c.label : 'All Categories'}</option>)}
              </select>
            )}
            {activeSection === 'pa_drill' && (
              <>
                <select value={drillCat} onChange={e => setDrillCat(e.target.value)}
                  className="border border-slate-300 rounded-lg pl-3 pr-8 py-1.5 text-sm font-medium text-slate-700 bg-white focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 min-w-[150px]">
                  {DRILL_CATS.map(c => <option key={c.key || 'all'} value={c.key}>{c.key ? c.label : 'All Categories'}</option>)}
                </select>
                <select value={drillItem} onChange={e => setDrillItem(e.target.value)}
                  className="border border-slate-300 rounded-lg pl-3 pr-8 py-1.5 text-sm font-medium text-slate-900 bg-white focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 min-w-[200px]">
                  {drillItems.length === 0 && <option value="">— no items —</option>}
                  {drillItems.map(it => <option key={it.item} value={it.item}>{it.item}</option>)}
                </select>
              </>
            )}
            {(activeSection === 'pay_week' || activeSection === 'pay_aged' || activeSection === 'pay_up') && (
              <>
                <select value={payCat} onChange={e => setPayCat(e.target.value)}
                  className="border border-slate-300 rounded-lg pl-3 pr-8 py-1.5 text-sm font-medium text-slate-700 bg-white focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 min-w-[150px]">
                  {DRILL_CATS.map(c => <option key={c.key || 'all'} value={c.key}>{c.key ? c.label : 'All Categories'}</option>)}
                </select>
                <select value={payMsme} onChange={e => setPayMsme(e.target.value)}
                  className="border border-slate-300 rounded-lg pl-3 pr-8 py-1.5 text-sm font-medium text-slate-700 bg-white focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 min-w-[130px]">
                  {MSME_OPTS.map(o => <option key={o.key || 'all'} value={o.key}>{o.label}</option>)}
                </select>
              </>
            )}
            {['v_top', 'v_inact', 'v_score', 'v_single', 'v_price'].includes(activeSection) && (
              <>
                <select value={vendCat} onChange={e => setVendCat(e.target.value)}
                  className="border border-slate-300 rounded-lg pl-3 pr-8 py-1.5 text-sm font-medium text-slate-700 bg-white focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 min-w-[150px]">
                  {DRILL_CATS.map(c => <option key={c.key || 'all'} value={c.key}>{c.key ? c.label : 'All Categories'}</option>)}
                </select>
                {['v_top', 'v_inact', 'v_score'].includes(activeSection) && (
                  <select value={vendMsme} onChange={e => setVendMsme(e.target.value)}
                    className="border border-slate-300 rounded-lg pl-3 pr-8 py-1.5 text-sm font-medium text-slate-700 bg-white focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 min-w-[130px]">
                    {MSME_OPTS.map(o => <option key={o.key || 'all'} value={o.key}>{o.label}</option>)}
                  </select>
                )}
              </>
            )}
            <div className="relative flex items-center gap-1.5">
              {DATE_PRESETS.filter(p => p.key === 'fy' || p.key === 'pfy' || p.key === 'cm').map(p => (
                <button key={p.key} type="button" onClick={() => applyPreset(p)}
                  className={`px-2 py-1 rounded text-[10px] font-semibold border transition whitespace-nowrap ${activePeriod === p.key ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-400'}`}>
                  {p.label}
                </button>
              ))}
              <button type="button" onClick={() => setShowDatePicker(v => !v)}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold border transition whitespace-nowrap ${activePeriod === 'custom' || showDatePicker ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-400'}`}>
                <Calendar size={11} /> {activePeriod === 'custom' ? `${fmtDate(dateFrom)} — ${fmtDate(dateTo)}` : 'More'}
              </button>
              {showDatePicker && (
                <div className="absolute right-0 top-full mt-1 z-30 bg-white rounded-lg border border-slate-200 shadow-lg p-3 w-[340px]">
                  <div className="text-[9px] font-semibold text-indigo-700 uppercase tracking-wide mb-1.5">Month</div>
                  <div className="flex flex-wrap gap-1 mb-3">
                    {DATE_PRESETS.filter(p => p.key === 'cm' || p.key.startsWith('m')).map(p => (
                      <button key={p.key} type="button" onClick={() => applyPreset(p)}
                        className={`px-2 py-1 rounded text-[10px] font-medium border transition ${activePeriod === p.key ? 'bg-indigo-100 text-indigo-800 border-indigo-300' : 'bg-slate-50 text-slate-600 border-slate-100 hover:border-indigo-300'}`}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="text-[9px] font-semibold text-indigo-700 uppercase tracking-wide mb-1.5">Quarter</div>
                  <div className="flex flex-wrap gap-1 mb-3">
                    {DATE_PRESETS.filter(p => p.key.startsWith('q')).map(p => (
                      <button key={p.key} type="button" onClick={() => applyPreset(p)}
                        className={`px-2 py-1 rounded text-[10px] font-medium border transition ${activePeriod === p.key ? 'bg-indigo-100 text-indigo-800 border-indigo-300' : 'bg-slate-50 text-slate-600 border-slate-100 hover:border-indigo-300'}`}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="text-[9px] font-semibold text-indigo-700 uppercase tracking-wide mb-1.5">Custom Range</div>
                  <div className="flex items-center gap-2">
                    <input type="date" defaultValue={dateFrom} onChange={e => { setDateFrom(e.target.value); setActivePeriod('custom'); }}
                      className="border border-slate-200 rounded px-2 py-1 text-xs flex-1" />
                    <span className="text-xs text-slate-400">to</span>
                    <input type="date" defaultValue={dateTo} onChange={e => { setDateTo(e.target.value); setActivePeriod('custom'); }}
                      className="border border-slate-200 rounded px-2 py-1 text-xs flex-1" />
                  </div>
                </div>
              )}
            </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {loading && WIRED.has(activeSection) && (
              <div className="flex items-center justify-center py-24 text-slate-400">
                <Loader2 size={22} className="animate-spin text-indigo-500 mr-2" /> <span className="text-sm">Loading…</span>
              </div>
            )}

            {/* ===== Payables · This Week ===== */}
            {!loading && activeSection === 'pay_week' && (
              payLoading ? (
                <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 size={22} className="animate-spin text-indigo-500 mr-2" /> <span className="text-sm">Loading…</span></div>
              ) : (
                <div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                    <Card label="Total Due This Week" value={fmtINR(payWeek.total)} sub={`${payWeek.rows.length} bills`} color="text-amber-600" borderColor="border-amber-400" />
                    <Card label="Already Overdue" value={fmtINR(payWeek.overdueTotal)} sub={`${payWeek.overdueCount} past due`} color="text-red-600" borderColor="border-red-400" />
                    <Card label="Due This Week" value={fmtINR(payWeek.dueTotal)} sub={`${payWeek.dueCount} bills`} color="text-emerald-600" borderColor="border-emerald-400" />
                    <Card label="Vendors" value={payWeek.vendors} sub="affected" />
                  </div>
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Due or overdue this week</div>
                    <TableExport cols={expPayWeek.cols} data={expPayWeek.data} filename={`payables-this-week-${slug(companyName)}`} title="Payables — This Week" metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} />
                  </div>
                  <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                    <table className="w-full">
                      <thead><tr><TH>Vendor</TH><TH>Invoice</TH><TH>Due Date</TH><TH right>Days</TH><TH>Status</TH><TH right>Outstanding</TH></tr></thead>
                      <tbody>
                        {payWeek.rows.map((b, i) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <TD bold>{b.vendor_name}{b.vendor_is_msme && <span className="ml-1.5 text-[8px] font-bold px-1 py-0.5 rounded bg-indigo-50 text-indigo-700 align-middle">MSME</span>}</TD>
                            <TD clickable onClick={() => navigate(`/purchase/bills?quick=${b.bill_id}`)}>{b.bill_no || b.vendor_invoice_no || '—'}</TD>
                            <TD color="text-slate-500">{fmtDate(b.due_date)}</TD>
                            <TD right color={b.overdue ? 'text-red-600' : 'text-emerald-600'}>{b.overdue ? `${b.daysLate}d late` : `in ${-b.daysLate}d`}</TD>
                            <TD><span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full ${b.overdue ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'}`}>{b.overdue ? 'OVERDUE' : 'DUE'}</span></TD>
                            <TD right bold color={b.overdue ? 'text-red-600' : 'text-slate-800'}>{fmtRup(b.amt)}</TD>
                          </tr>
                        ))}
                        {payWeek.rows.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-slate-400 text-sm">No payables due this week.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}

            {/* ===== Payables · Overdue Ageing ===== */}
            {!loading && activeSection === 'pay_aged' && (
              payLoading ? (
                <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 size={22} className="animate-spin text-indigo-500 mr-2" /> <span className="text-sm">Loading…</span></div>
              ) : (
                <div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-4">
                    <Card label="Total Overdue" value={fmtINR(payAged.total)} sub={`${payAged.rows.length} bills`} color="text-red-600" borderColor="border-red-400" />
                    <Card label="Ageing Bands" value={payAged.activeBands} sub="active bands" />
                    <Card label="Vendors" value={payAged.vendors} sub="with overdue" color="text-red-600" />
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
                    {payAged.bands.map(b => (
                      <div key={b.label} className="bg-white rounded-lg border border-rose-200 p-2.5 text-center">
                        <div className="text-[9px] font-bold uppercase tracking-wider text-rose-700">{b.label}</div>
                        <div className="text-base font-extrabold text-red-600 tabular-nums mt-0.5">{fmtINR(b.total)}</div>
                        <div className="text-[10px] text-rose-400">{b.count} bill{b.count === 1 ? '' : 's'}</div>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Overdue bills</div>
                    <TableExport cols={expPayAged.cols} data={expPayAged.data} filename={`payables-overdue-${slug(companyName)}`} title="Payables — Overdue Ageing" metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} />
                  </div>
                  <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                    <table className="w-full">
                      <thead><tr><TH>Vendor</TH><TH>Invoice</TH><TH>Due Date</TH><TH right>Days Late</TH><TH>Band</TH><TH right>Outstanding</TH></tr></thead>
                      <tbody>
                        {payAged.rows.map((b, i) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <TD bold>{b.vendor_name}{b.vendor_is_msme && <span className="ml-1.5 text-[8px] font-bold px-1 py-0.5 rounded bg-indigo-50 text-indigo-700 align-middle">MSME</span>}</TD>
                            <TD clickable onClick={() => navigate(`/purchase/bills?quick=${b.bill_id}`)}>{b.bill_no || b.vendor_invoice_no || '—'}</TD>
                            <TD color="text-slate-500">{fmtDate(b.due_date)}</TD>
                            <TD right color="text-red-600">{b.daysLate}d</TD>
                            <TD><span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-700">{payAged.bandOf(b.daysLate)}</span></TD>
                            <TD right bold color="text-red-600">{fmtRup(b.amt)}</TD>
                          </tr>
                        ))}
                        {payAged.rows.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-slate-400 text-sm">No overdue payables.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}

            {/* ===== Payables · Upcoming ===== */}
            {!loading && activeSection === 'pay_up' && (
              payLoading ? (
                <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 size={22} className="animate-spin text-indigo-500 mr-2" /> <span className="text-sm">Loading…</span></div>
              ) : (
                <div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                    <Card label="Due Next 30 Days" value={fmtINR(payUp.next30Total)} color="text-amber-600" borderColor="border-amber-400" />
                    <Card label="Due Next 60 Days" value={fmtINR(payUp.next60Total)} color="text-indigo-700" borderColor="border-indigo-400" />
                    <Card label="Due Later" value={fmtINR(payUp.laterTotal)} color="text-slate-700" />
                    <Card label="Vendors" value={payUp.vendors} sub="upcoming" />
                  </div>
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Upcoming payables</div>
                    <TableExport cols={expPayUp.cols} data={expPayUp.data} filename={`payables-upcoming-${slug(companyName)}`} title="Payables — Upcoming" metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} />
                  </div>
                  <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                    <table className="w-full">
                      <thead><tr><TH>Vendor</TH><TH>Invoice</TH><TH>Due Date</TH><TH right>Due In</TH><TH>Category</TH><TH right>Outstanding</TH></tr></thead>
                      <tbody>
                        {payUp.rows.map((b, i) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <TD bold>{b.vendor_name}{b.vendor_is_msme && <span className="ml-1.5 text-[8px] font-bold px-1 py-0.5 rounded bg-indigo-50 text-indigo-700 align-middle">MSME</span>}</TD>
                            <TD clickable onClick={() => navigate(`/purchase/bills?quick=${b.bill_id}`)}>{b.bill_no || b.vendor_invoice_no || '—'}</TD>
                            <TD color="text-slate-500">{fmtDate(b.due_date)}</TD>
                            <TD right color="text-emerald-600">in {-b.daysLate}d</TD>
                            <TD color="text-slate-500">{normCat(b.purchase_category) || '—'}</TD>
                            <TD right bold color="text-slate-800">{fmtRup(b.amt)}</TD>
                          </tr>
                        ))}
                        {payUp.rows.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-slate-400 text-sm">No upcoming payables.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}

            {/* ===== Vendors · Top Vendors (by purchase value) ===== */}
            {!loading && activeSection === 'v_top' && (
              vendLoading ? (
                <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 size={22} className="animate-spin text-indigo-500 mr-2" /> <span className="text-sm">Loading…</span></div>
              ) : (
                <div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                    <Card label="Vendors This Period" value={vTop.count} sub="with purchases" />
                    <Card label="Top 10 Value" value={fmtINR(vTop.top10)} sub={vTop.total > 0 ? `${((vTop.top10 / vTop.total) * 100).toFixed(0)}% of total` : ''} color="text-indigo-700" borderColor="border-indigo-400" />
                    <Card label="Avg per Vendor" value={fmtINR(vTop.avg)} color="text-slate-700" />
                    <Card label="Repeat Rate" value={`${vTop.repeatRate.toFixed(0)}%`} sub="ordered >1" color="text-emerald-600" borderColor="border-emerald-400" />
                  </div>
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Top vendors by purchase value</div>
                    <TableExport cols={expVTop.cols} data={expVTop.data} filename={`vendors-top-${slug(companyName)}`} title="Top Vendors by Purchase Value" metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} chartSpec={{ labelField: 'vendor', valueField: 'value' }} />
                  </div>
                  <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                    <table className="w-full">
                      <thead><tr><TH>#</TH><TH>Vendor</TH><TH>Category</TH><TH right>Purchase Value</TH><TH right>Outstanding</TH><TH right>% Share</TH></tr></thead>
                      <tbody>
                        {vTop.rows.map((v, i) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <TD color="text-slate-400">{v.rank}</TD>
                            <TD bold>{v.vendor_name}{v.is_msme && <span className="ml-1.5 text-[8px] font-bold px-1 py-0.5 rounded bg-indigo-50 text-indigo-700 align-middle">MSME</span>}</TD>
                            <TD color="text-slate-500">{normCat(v.purchase_category) || '—'}</TD>
                            <TD right bold color="text-indigo-700">{fmtINR(v.period_value)}</TD>
                            <TD right color="text-amber-600">{v.outstanding ? fmtINR(v.outstanding) : '—'}</TD>
                            <TD right color="text-slate-400">{v.pct.toFixed(1)}%</TD>
                          </tr>
                        ))}
                        {vTop.rows.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-slate-400 text-sm">No vendor purchases in this period.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}

            {/* ===== Vendors · Inactive ===== */}
            {!loading && activeSection === 'v_inact' && (
              vendLoading ? (
                <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 size={22} className="animate-spin text-indigo-500 mr-2" /> <span className="text-sm">Loading…</span></div>
              ) : (
                <div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                    <Card label="90+ Days Inactive" value={vInact.c90} sub="no bill in 3+ months" color="text-red-600" borderColor="border-red-400" />
                    <Card label="60-90 Days" value={vInact.c60} sub="slowing down" color="text-amber-600" borderColor="border-amber-400" />
                    <Card label="30-60 Days" value={vInact.c30} sub="monitor" color="text-sky-600" borderColor="border-sky-400" />
                    <Card label="Lost Value" value={fmtINR(vInact.lostValue)} sub="lifetime of 90+ inactive" color="text-red-600" />
                  </div>
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Inactive vendors (no recent bills)</div>
                    <TableExport cols={expVInact.cols} data={expVInact.data} filename={`vendors-inactive-${slug(companyName)}`} title="Inactive Vendors" metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} />
                  </div>
                  <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                    <table className="w-full">
                      <thead><tr><TH>Vendor</TH><TH>Category</TH><TH>Last Bill</TH><TH right>Days Inactive</TH><TH right>Lifetime Value</TH><TH right>Outstanding</TH><TH>Risk</TH></tr></thead>
                      <tbody>
                        {vInact.rows.map((v, i) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <TD bold>{v.vendor_name}{v.is_msme && <span className="ml-1.5 text-[8px] font-bold px-1 py-0.5 rounded bg-indigo-50 text-indigo-700 align-middle">MSME</span>}</TD>
                            <TD color="text-slate-500">{normCat(v.purchase_category) || '—'}</TD>
                            <TD color="text-slate-500">{fmtDate(v.last_bill_date)}</TD>
                            <TD right color="text-red-600">{v.days_inactive}d</TD>
                            <TD right>{fmtINR(v.lifetime_value)}</TD>
                            <TD right color="text-amber-600">{v.outstanding ? fmtINR(v.outstanding) : '—'}</TD>
                            <TD><span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full ${v.risk === 'HIGH' ? 'bg-rose-50 text-rose-700' : v.risk === 'MEDIUM' ? 'bg-amber-50 text-amber-700' : 'bg-sky-50 text-sky-700'}`}>{v.risk}</span></TD>
                          </tr>
                        ))}
                        {vInact.rows.length === 0 && <tr><td colSpan={7} className="text-center py-8 text-slate-400 text-sm">No inactive vendors.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}

            {/* ===== Vendors · Scorecard ===== */}
            {!loading && activeSection === 'v_score' && (
              vendLoading ? (
                <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 size={22} className="animate-spin text-indigo-500 mr-2" /> <span className="text-sm">Loading…</span></div>
              ) : (
                <div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                    <Card label="Vendors Scored" value={vScore.count} sub="with purchase history" />
                    <Card label="Avg Return Rate" value={`${vScore.avgRet.toFixed(1)}%`} sub="debit notes / purchases" color="text-amber-600" borderColor="border-amber-400" />
                    <Card label="Good Vendors" value={vScore.rows.filter(v => v.score === 'GOOD').length} sub="low return · recent" color="text-emerald-600" borderColor="border-emerald-400" />
                    <Card label="Flagged" value={vScore.flagged} sub="return >5% or 90d+ idle" color="text-red-600" borderColor="border-red-400" />
                  </div>
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Vendor reliability scorecard</div>
                    <TableExport cols={expVScore.cols} data={expVScore.data} filename={`vendors-scorecard-${slug(companyName)}`} title="Vendor Scorecard" metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} chartSpec={{ labelField: 'vendor', valueField: 'value' }} />
                  </div>
                  <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                    <table className="w-full">
                      <thead><tr><TH>Vendor</TH><TH>Category</TH><TH right>Purchase Value</TH><TH right>Bills</TH><TH right>Return Rate</TH><TH right>Outstanding</TH><TH>Score</TH></tr></thead>
                      <tbody>
                        {vScore.rows.map((v, i) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <TD bold>{v.vendor_name}{v.is_msme && <span className="ml-1.5 text-[8px] font-bold px-1 py-0.5 rounded bg-indigo-50 text-indigo-700 align-middle">MSME</span>}</TD>
                            <TD color="text-slate-500">{normCat(v.purchase_category) || '—'}</TD>
                            <TD right bold color="text-indigo-700">{fmtINR(v.period_value)}</TD>
                            <TD right>{v.period_bills}</TD>
                            <TD right color={v.return_rate > 5 ? 'text-red-600' : v.return_rate > 2 ? 'text-amber-600' : 'text-slate-500'}>{v.return_rate.toFixed(1)}%</TD>
                            <TD right color="text-amber-600">{v.outstanding ? fmtINR(v.outstanding) : '—'}</TD>
                            <TD><span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full ${v.score === 'POOR' ? 'bg-rose-50 text-rose-700' : v.score === 'FAIR' ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>{v.score}</span></TD>
                          </tr>
                        ))}
                        {vScore.rows.length === 0 && <tr><td colSpan={7} className="text-center py-8 text-slate-400 text-sm">No vendors to score in this period.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}

            {/* ===== Vendors · Single-Source Risk ===== */}
            {!loading && activeSection === 'v_single' && (
              drillPivot == null ? (
                <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 size={22} className="animate-spin text-indigo-500 mr-2" /> <span className="text-sm">Loading…</span></div>
              ) : (
                <div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-4">
                    <Card label="Single-Source Items" value={vSingle.count} sub="one vendor only" color="text-red-600" borderColor="border-red-400" />
                    <Card label="Spend Exposed" value={fmtINR(vSingle.exposed)} sub="value at risk" color="text-amber-600" borderColor="border-amber-400" />
                    <Card label="% of Purchases" value={`${vSingle.pct.toFixed(1)}%`} sub="single-sourced" color="text-indigo-700" borderColor="border-indigo-400" />
                  </div>
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Items bought from a single vendor</div>
                    <TableExport cols={expVSingle.cols} data={expVSingle.data} filename={`single-source-${slug(companyName)}`} title="Single-Source Risk" metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} chartSpec={{ labelField: 'item', valueField: 'value' }} />
                  </div>
                  <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                    <table className="w-full">
                      <thead><tr><TH>Item</TH><TH>Category</TH><TH>Sole Vendor</TH><TH right>Qty</TH><TH right>Value</TH></tr></thead>
                      <tbody>
                        {vSingle.items.map((i, k) => (
                          <tr key={k} className="hover:bg-slate-50">
                            <TD bold>{i.item}</TD>
                            <TD color="text-slate-500">{i.category}</TD>
                            <TD>{i.vendor}{i.is_msme && <span className="ml-1.5 text-[8px] font-bold px-1 py-0.5 rounded bg-indigo-50 text-indigo-700 align-middle">MSME</span>}</TD>
                            <TD right>{fmtQty(i.qty)}<span className="text-slate-400 ml-0.5">{i.uom}</span></TD>
                            <TD right bold color="text-amber-600">{fmtINR(i.value)}</TD>
                          </tr>
                        ))}
                        {vSingle.items.length === 0 && <tr><td colSpan={5} className="text-center py-8 text-slate-400 text-sm">No single-source items — every item has 2+ vendors.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}

            {/* ===== Vendors · MSME Compliance ===== */}
            {!loading && activeSection === 'v_msme' && (
              payCal == null ? (
                <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 size={22} className="animate-spin text-indigo-500 mr-2" /> <span className="text-sm">Loading…</span></div>
              ) : (
                <div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                    <Card label="MSME Vendors Owed" value={vMsme.vendors} sub="with open bills" />
                    <Card label="Total MSME Payable" value={fmtINR(vMsme.total)} color="text-amber-600" borderColor="border-amber-400" />
                    <Card label="Overdue > 45 days" value={fmtINR(vMsme.overTotal)} sub="§43B(h) exposure" color="text-red-600" borderColor="border-red-400" />
                    <Card label="Bills Past 45d" value={vMsme.overCount} sub="non-deductible risk" color="text-red-600" />
                  </div>
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">MSME payables vs the 45-day MSMED limit</div>
                    <TableExport cols={expVMsme.cols} data={expVMsme.data} filename={`msme-compliance-${slug(companyName)}`} title="MSME Compliance (45-day)" metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} />
                  </div>
                  <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                    <table className="w-full">
                      <thead><tr><TH>Vendor</TH><TH>Bill</TH><TH>Bill Date</TH><TH right>Days Since Bill</TH><TH right>Balance</TH><TH>Status</TH></tr></thead>
                      <tbody>
                        {vMsme.bills.map((b, i) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <TD bold>{b.vendor_name}</TD>
                            <TD clickable onClick={() => navigate(`/purchase/bills?quick=${b.bill_id}`)}>{b.bill_no || b.vendor_invoice_no || '—'}</TD>
                            <TD color="text-slate-500">{fmtDate(b.bill_date)}</TD>
                            <TD right color={b.over45 ? 'text-red-600' : 'text-slate-500'}>{b.daysSinceBill == null ? '—' : `${b.daysSinceBill}d`}</TD>
                            <TD right bold color="text-amber-600">{fmtINR(b.balance)}</TD>
                            <TD><span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full ${b.over45 ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'}`}>{b.over45 ? 'OVERDUE-45' : 'DUE'}</span></TD>
                          </tr>
                        ))}
                        {vMsme.bills.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-slate-400 text-sm">No open MSME payables.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}

            {/* ===== Vendors · Price Watch ===== */}
            {!loading && activeSection === 'v_price' && (
              drillPivot == null ? (
                <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 size={22} className="animate-spin text-indigo-500 mr-2" /> <span className="text-sm">Loading…</span></div>
              ) : (
                <div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                    <Card label="Items Rising" value={vPrice.rising} sub="price up vs start" color="text-red-600" borderColor="border-red-400" />
                    <Card label="Avg Price Change" value={`${vPrice.avgChange > 0 ? '▲' : vPrice.avgChange < 0 ? '▼' : ''} ${Math.abs(vPrice.avgChange).toFixed(1)}%`} color={vPrice.avgChange > 0 ? 'text-red-600' : 'text-emerald-600'} />
                    <Card label="Potential Saving" value={fmtINR(vPrice.saving)} sub="vs cheapest vendor" color="text-emerald-600" borderColor="border-emerald-400" />
                    <Card label="Multi-Vendor Items" value={vPrice.count} sub="comparable" />
                  </div>
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Price watch — rate creep & overpay</div>
                    <TableExport cols={expVPrice.cols} data={expVPrice.data} filename={`price-watch-${slug(companyName)}`} title="Price Watch" metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} chartSpec={{ labelField: 'item', valueField: 'overpay' }} />
                  </div>
                  <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                    <table className="w-full">
                      <thead><tr><TH>Item</TH><TH>Category</TH><TH right>Current Avg</TH><TH right>Change %</TH><TH right>Spread %</TH><TH>Cheapest Vendor</TH><TH right>Overpay</TH></tr></thead>
                      <tbody>
                        {vPrice.items.map((i, k) => (
                          <tr key={k} className="hover:bg-slate-50">
                            <TD bold>{i.item}</TD>
                            <TD color="text-slate-500">{i.category}</TD>
                            <TD right>{fmtRup(i.curAvg)}</TD>
                            <TD right color={i.change_pct == null ? 'text-slate-400' : num(i.change_pct) > 0 ? 'text-red-600' : 'text-emerald-600'}>{i.change_pct == null ? '—' : `${num(i.change_pct) > 0 ? '▲' : '▼'} ${Math.abs(num(i.change_pct)).toFixed(1)}%`}</TD>
                            <TD right color="text-slate-500">{i.spread_pct == null ? '—' : `${num(i.spread_pct).toFixed(1)}%`}</TD>
                            <TD color="text-emerald-700">{i.cheapest}</TD>
                            <TD right bold color="text-amber-600">{i.overpay > 0 ? fmtINR(i.overpay) : '—'}</TD>
                          </tr>
                        ))}
                        {vPrice.items.length === 0 && <tr><td colSpan={7} className="text-center py-8 text-slate-400 text-sm">No multi-vendor items to compare.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}

            {/* ===== Vendors · New Vendors ===== */}
            {!loading && activeSection === 'v_new' && (
              vendLoading ? (
                <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 size={22} className="animate-spin text-indigo-500 mr-2" /> <span className="text-sm">Loading…</span></div>
              ) : (
                <div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                    <Card label="New This Period" value={vNew.count} sub="first bill in period" color="text-emerald-600" borderColor="border-emerald-400" />
                    <Card label="Value From New" value={fmtINR(vNew.value)} color="text-indigo-700" borderColor="border-indigo-400" />
                    <Card label="Avg First-Period" value={fmtINR(vNew.avg)} color="text-slate-700" />
                    <Card label="Multi-Bill Rate" value={`${vNew.multiRate.toFixed(0)}%`} sub="billed >1" color="text-emerald-600" />
                  </div>
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">New vendors this period</div>
                    <TableExport cols={expVNew.cols} data={expVNew.data} filename={`vendors-new-${slug(companyName)}`} title="New Vendors" metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} />
                  </div>
                  <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                    <table className="w-full">
                      <thead><tr><TH>Vendor</TH><TH>Category</TH><TH>First Bill</TH><TH right>Bills</TH><TH right>Value</TH><TH>Status</TH></tr></thead>
                      <tbody>
                        {vNew.rows.map((v, i) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <TD bold>{v.vendor_name}{v.is_msme && <span className="ml-1.5 text-[8px] font-bold px-1 py-0.5 rounded bg-indigo-50 text-indigo-700 align-middle">MSME</span>}</TD>
                            <TD color="text-slate-500">{normCat(v.purchase_category) || '—'}</TD>
                            <TD color="text-slate-500">{fmtDate(v.first_bill_date)}</TD>
                            <TD right>{v.period_bills}</TD>
                            <TD right bold color="text-indigo-700">{fmtINR(v.period_value)}</TD>
                            <TD><span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full ${v.period_bills > 1 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{v.period_bills > 1 ? 'ACTIVE' : '1 BILL'}</span></TD>
                          </tr>
                        ))}
                        {vNew.rows.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-slate-400 text-sm">No new vendors in this period.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}

            {/* ===== Vendors · Concentration ===== */}
            {!loading && activeSection === 'v_conc' && (
              vendLoading ? (
                <div className="flex items-center justify-center py-24 text-slate-400"><Loader2 size={22} className="animate-spin text-indigo-500 mr-2" /> <span className="text-sm">Loading…</span></div>
              ) : (
                <div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                    <Card label="Top 5 Vendors" value={`${vConc.top5.toFixed(0)}%`} sub="of total purchases" color="text-red-600" borderColor="border-red-400" />
                    <Card label="Top 10 Vendors" value={`${vConc.top10.toFixed(0)}%`} sub="of total" color="text-amber-600" borderColor="border-amber-400" />
                    <Card label="Top 20 Vendors" value={`${vConc.top20.toFixed(0)}%`} sub="of total" color="text-indigo-700" borderColor="border-indigo-400" />
                    <Card label="Risk Level" value={vConc.risk} sub="Top 5 > 40% = concentrated" color={vConc.risk === 'HIGH' ? 'text-red-600' : vConc.risk === 'MEDIUM' ? 'text-amber-600' : 'text-emerald-600'} />
                  </div>
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-2">Purchase concentration</div>
                  <div className="bg-white rounded-lg border border-slate-300 shadow-sm p-3 mb-4 space-y-1.5">
                    {vConc.tiers.map((t, i) => {
                      const barBg = t.tone === 'indigo' ? 'bg-indigo-500' : t.tone === 'amber' ? 'bg-amber-500' : t.tone === 'sky' ? 'bg-sky-500' : t.tone === 'emerald' ? 'bg-emerald-500' : 'bg-slate-400';
                      return (
                        <div key={i} className="flex items-center gap-2">
                          <div className="w-[120px] text-right text-[10px] font-semibold text-slate-600 shrink-0">{t.label} <span className="text-slate-400">({t.count})</span></div>
                          <div className="flex-1 h-5 bg-slate-100 rounded overflow-hidden min-w-0">
                            <div className={`h-full ${barBg} rounded flex items-center px-2 text-[9px] font-bold text-white whitespace-nowrap`} style={{ width: `${Math.max(t.pct, 4)}%`, minWidth: '64px' }}>
                              {fmtINR(t.value)} ({t.pct.toFixed(0)}%)
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Tier breakdown</div>
                    <TableExport cols={expVConc.cols} data={expVConc.data} filename={`vendors-concentration-${slug(companyName)}`} title="Vendor Concentration" metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} chartSpec={{ labelField: 'tier', valueField: 'value' }} />
                  </div>
                  <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                    <table className="w-full">
                      <thead><tr><TH>Tier</TH><TH right>Vendors</TH><TH right>Value</TH><TH right>% of total</TH><TH right>Cumulative %</TH><TH right>Avg / Vendor</TH></tr></thead>
                      <tbody>
                        {vConc.tiers.map((t, i) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <TD bold>{t.label}</TD>
                            <TD right>{t.count}</TD>
                            <TD right bold color="text-indigo-700">{fmtINR(t.value)}</TD>
                            <TD right>{t.pct.toFixed(1)}%</TD>
                            <TD right color="text-slate-500">{t.cumPct.toFixed(1)}%</TD>
                            <TD right>{fmtINR(t.avg)}</TD>
                          </tr>
                        ))}
                        {vConc.tiers.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-slate-400 text-sm">No vendor purchases in this period.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}

            {/* ===== Top Vendors ===== */}
            {!loading && activeSection === 'top_vend' && (
              <div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-4">
                  <Card label="Total Payable" value={fmtINR(totalPayable)} sub={`${topVendors.length} vendors`} color="text-amber-600" borderColor="border-amber-400" />
                  <Card label="Total Overdue" value={fmtINR(totalOverdue)} color="text-red-600" borderColor="border-red-400" />
                  <Card label="Payment Rate" value={`${paymentRate.toFixed(1)}%`} sub="Paid / Billed" color="text-emerald-600" borderColor="border-emerald-400" />
                </div>
                <div className="flex items-center justify-between gap-3 mb-1.5">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Top Vendors by Payable</div>
                  <TableExport cols={expTopVendors.cols} data={expTopVendors.data} filename={`top-vendors-${slug(companyName)}`} title="Top Vendors by Payable" metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} chartSpec={{ labelField: 'vendor', valueField: 'payable' }} />
                </div>
                <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                  <table className="w-full">
                    <thead><tr><TH>Vendor</TH><TH right>Billed</TH><TH right>Payable</TH><TH right>Overdue</TH><TH right>% of total</TH></tr></thead>
                    <tbody>
                      {topVendors.map((r, i) => (
                        <tr key={i} className="hover:bg-slate-50">
                          <TD bold>{r.name}{r.is_msme && <span className="ml-1.5 text-[8px] font-bold px-1 py-0.5 rounded bg-indigo-50 text-indigo-700 align-middle">MSME</span>}</TD>
                          <TD right>{fmtINR(r.billed)}</TD>
                          <TD right color="text-amber-600">{r.outstanding ? fmtINR(r.outstanding) : '—'}</TD>
                          <TD right color="text-red-600">{r.overdue ? fmtINR(r.overdue) : '—'}</TD>
                          <TD right color="text-slate-400">{r.pct.toFixed(1)}%</TD>
                        </tr>
                      ))}
                      {topVendors.length === 0 && <tr><td colSpan={5} className="text-center py-8 text-slate-400 text-sm">No vendor data for this period</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ===== Purchase Trend ===== */}
            {!loading && activeSection === 'pa_trend' && (
              <div>
                <div className="bg-white rounded-lg border border-slate-200 p-4 mb-4">
                  <div className="flex items-end gap-2.5 h-[200px] px-1">
                    {trendRows.map((r, i) => (
                      <div key={i} className="flex-1 min-w-0 h-full flex flex-col items-center justify-end gap-1">
                        <div className="flex items-end justify-center gap-[3px] w-full h-full">
                          <div className="w-[40%] max-w-[18px] rounded-t bg-indigo-500" style={{ height: `${(r.billed / trendMax) * 100}%` }} title={`Billed ${fmtINR(r.billed)}`}></div>
                          <div className="w-[40%] max-w-[18px] rounded-t bg-sky-400" style={{ height: `${(r.paid / trendMax) * 100}%` }} title={`Paid ${fmtINR(r.paid)}`}></div>
                        </div>
                        <div className="text-[9px] text-slate-400 whitespace-nowrap">{r.label}</div>
                      </div>
                    ))}
                    {trendRows.length === 0 && <div className="w-full text-center text-slate-400 text-sm self-center">No trend data</div>}
                  </div>
                  <div className="flex gap-5 justify-center mt-3 text-[11px] text-slate-500">
                    <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-indigo-500"></span> Billed</span>
                    <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-sky-400"></span> Paid</span>
                  </div>
                </div>
                {/* Monthly Turnover Breakdown (taxable, ex-GST) */}
                <div className="flex items-center justify-between gap-3 mb-1.5">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Monthly Turnover Breakdown <span className="text-slate-400 font-semibold normal-case">(taxable, ex-GST)</span></div>
                  <TableExport cols={expTrend.cols} data={expTrend.data} filename={`purchase-trend-${slug(companyName)}`} title="Monthly Turnover Breakdown" metaLines={exportMeta} landscape kpis={reportKpis} companyName={companyName} initials={initials} chartSpec={{ labelField: 'type', valueField: 'total' }} />
                </div>
                {breakdown == null
                  ? <div className="bg-white rounded-lg border border-slate-300 shadow-sm py-8 text-center text-slate-400 text-sm mb-4">Loading…</div>
                  : <div className="mb-4"><BreakdownPivot breakdown={breakdown} fmt={fmtINR} /></div>}

                {/* Detailed figures (exact ₹) — collapsible */}
                {breakdown != null && (breakdown.months || []).length > 0 && (
                  <div>
                    <div className="flex items-center justify-between gap-3 mb-1.5">
                      <button type="button" onClick={() => setShowExact(s => !s)}
                        className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-600 hover:text-indigo-700">
                        <ChevronDown size={13} className={`transition-transform ${showExact ? '' : '-rotate-90'}`} />
                        Detailed figures <span className="text-slate-400 font-semibold normal-case">(exact ₹ for Tally verification)</span>
                      </button>
                      <TableExport cols={expTrendExact.cols} data={expTrendExact.data} filename={`purchase-trend-exact-${slug(companyName)}`} title="Detailed figures (exact ₹)" metaLines={exportMeta} landscape kpis={reportKpis} companyName={companyName} initials={initials} chartSpec={{ labelField: 'type', valueField: 'total' }} />
                    </div>
                    {showExact && <BreakdownPivot breakdown={breakdown} fmt={fmtExact} />}
                  </div>
                )}
              </div>
            )}

            {/* ===== Item Analytics ===== */}
            {!loading && activeSection === 'pa_item' && (
              <div className="space-y-4">
                {/* Top items purchased — a ranked highlight above the table. */}
                {itemRows.length > 0 && (() => {
                  const top = [...itemRows].sort((a, b) => b.value - a.value).slice(0, 6);
                  const maxV = top[0]?.value || 1;
                  return (
                    <div className="bg-white rounded-lg border border-slate-300 shadow-sm px-4 py-3">
                      <div className="text-[11px] font-bold uppercase tracking-wider text-indigo-700 mb-2.5">Top items purchased</div>
                      <div className="space-y-1.5">
                        {top.map((it, i) => (
                          <div key={it.item} className="flex items-center gap-3">
                            <div className="w-[170px] shrink-0 text-right text-[11px] font-semibold text-slate-700 truncate">
                              <span className="text-slate-400 mr-1 tabular-nums">{i + 1}</span>{it.item}
                            </div>
                            <div className="flex-1 min-w-0 h-5 bg-slate-100 rounded overflow-hidden">
                              <div className="h-full bg-gradient-to-r from-indigo-500 to-indigo-400 rounded flex items-center px-2 text-[9px] font-bold text-white whitespace-nowrap"
                                style={{ width: `${Math.max((it.value / maxV) * 100, 6)}%`, minWidth: '54px' }}>
                                {fmtINR(it.value)}
                              </div>
                            </div>
                            <div className="w-[50px] shrink-0 text-right text-[10px] text-slate-400 tabular-nums">{it.uom || ''}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

              <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between gap-3">
                  <div className="text-[12px] font-bold text-slate-800">Product Summary <span className="font-medium text-slate-400 text-[11px] ml-1">({itemRows.length} products · click to expand)</span></div>
                  <TableExport cols={expItems.cols} data={expItems.data} filename={`item-analytics-${slug(companyName)}`} title="Item Analytics — Product Summary" metaLines={exportMeta} landscape kpis={reportKpis} companyName={companyName} initials={initials} chartSpec={{ labelField: 'product', valueField: 'value' }} />
                </div>
                <table className="w-full">
                  <thead><tr><TH>Product</TH><TH>UOM</TH><TH right>Qty</TH><TH right>Avg price</TH><TH right>Min</TH><TH right>Max</TH><TH right>Value</TH></tr></thead>
                  <tbody>
                    {itemRows.map((r, i) => {
                      const open = itemOpen === r.item;
                      const piv = pivotByItem[r.item];
                      const { min, max } = itemMinMax(r.item);
                      const vendors = piv ? [...piv.vendors].map(v => ({
                        vendor: v.vendor, qty: num(v.total_qty), value: num(v.total_value),
                        cells: v.cells || {}, cheapest: v.vendor === piv.cheapest_vendor,
                      })).sort((a, b) => b.value - a.value) : [];
                      const pts = pointsByItem[r.item] || [];
                      return (
                        <React.Fragment key={i}>
                          <tr onClick={() => setItemOpen(open ? null : r.item)}
                            className={`cursor-pointer hover:bg-slate-50 ${open ? 'bg-indigo-50/60' : ''}`}>
                            <TD bold>
                              <ChevronDown size={12} className={`inline-block mr-1 text-slate-400 transition-transform ${open ? '' : '-rotate-90'}`} />
                              {r.item}
                            </TD>
                            <TD color="text-slate-400">{r.uom || '—'}</TD>
                            <TD right>{fmtQty(r.qty)}</TD>
                            <TD right>{fmtRup(r.avg)}</TD>
                            <TD right color="text-emerald-600">{min != null ? fmtRup(min) : '—'}</TD>
                            <TD right color="text-rose-600">{max != null ? fmtRup(max) : '—'}</TD>
                            <TD right bold color="text-indigo-700">{fmtINR(r.value)}</TD>
                          </tr>
                          {open && (
                            <tr>
                              <td colSpan={7} className="bg-slate-50 border-t border-slate-200 px-3 py-2">
                                {vendors.length > 0 ? (
                                  <div className="bg-white rounded-md border border-slate-200 overflow-auto max-h-[50vh]">
                                    <table className="w-full min-w-[640px]">
                                      <thead><tr>
                                        <th className="sticky top-0 left-0 z-20 bg-slate-100 text-left px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 border-b-2 border-slate-200">Vendor</th>
                                        <TH>UOM</TH>
                                        {itemMonths.map(m => <th key={m} className="sticky top-0 z-10 text-right px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 bg-slate-100 border-b-2 border-l border-slate-200 min-w-[88px]">{monthLabel(m)}</th>)}
                                        <TH right>Total Qty</TH><TH right>Total Value</TH>
                                      </tr></thead>
                                      <tbody>
                                        {vendors.map((v, vi) => (
                                          <tr key={vi} className={`hover:bg-slate-50 ${v.cheapest ? 'bg-emerald-50/50' : ''}`}>
                                            <td className={`sticky left-0 px-2 py-1.5 text-[11px] font-semibold border-b border-slate-100 z-10 ${v.cheapest ? 'bg-emerald-50/50' : 'bg-white'}`}>
                                              {v.vendor}{v.cheapest && <span className="ml-1.5 text-[8px] font-bold uppercase tracking-wide text-emerald-700">cheapest</span>}
                                            </td>
                                            <td className="px-2 py-1.5 text-[11px] text-slate-400 border-b border-slate-100">{r.uom || '—'}</td>
                                            {itemMonths.map(m => {
                                              const c = v.cells[m];
                                              return (
                                                <td key={m} className="text-right px-2 py-1.5 text-[10px] tabular-nums font-semibold border-b border-l border-slate-100">
                                                  {c ? <span className="text-slate-700">{fmtQty(c.qty)}<span className="text-slate-400"> · {fmtRup((c.rate || 0) * (c.qty || 0))}</span></span> : <span className="text-slate-300">—</span>}
                                                </td>
                                              );
                                            })}
                                            <td className="text-right px-2 py-1.5 text-[11px] tabular-nums font-semibold border-b border-l border-slate-200">{fmtQty(v.qty)}</td>
                                            <td className="text-right px-2 py-1.5 text-[11px] tabular-nums font-bold text-indigo-700 border-b border-l border-slate-200">{fmtINR(v.value)}</td>
                                          </tr>
                                        ))}
                                        {/* Totals */}
                                        <tr className="bg-indigo-50/60 font-bold">
                                          <td className="sticky left-0 bg-indigo-50/60 px-2 py-1.5 text-[11px] font-bold text-indigo-800 border-t border-slate-200 z-10">Total</td>
                                          <td className="border-t border-slate-200"></td>
                                          {itemMonths.map(m => {
                                            const q = vendors.reduce((s, v) => s + (v.cells[m]?.qty || 0), 0);
                                            const val = vendors.reduce((s, v) => s + ((v.cells[m]?.rate || 0) * (v.cells[m]?.qty || 0)), 0);
                                            return <td key={m} className="text-right px-2 py-1.5 text-[10px] tabular-nums font-bold text-indigo-800 border-t border-l border-slate-200">{q ? <span>{fmtQty(q)}<span className="text-indigo-400"> · {fmtRup(val)}</span></span> : '—'}</td>;
                                          })}
                                          <td className="text-right px-2 py-1.5 text-[11px] tabular-nums font-extrabold text-indigo-800 border-t border-l border-slate-200">{fmtQty(vendors.reduce((s, v) => s + v.qty, 0))}</td>
                                          <td className="text-right px-2 py-1.5 text-[11px] tabular-nums font-extrabold text-indigo-800 border-t border-l border-slate-200">{fmtINR(vendors.reduce((s, v) => s + v.value, 0))}</td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </div>
                                ) : (
                                  <div>
                                    <div className="text-[11px] font-semibold text-slate-600 mb-1.5">Bought from a single vendor — monthly price trend:</div>
                                    <div className="flex flex-wrap gap-1.5">
                                      {pts.filter(p => p.rate != null).map((p, pi) => (
                                        <span key={pi} className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px]">
                                          <span className="text-slate-400">{monthLabel(p.month)}</span>
                                          <span className="font-semibold text-slate-700 tabular-nums">{fmtRup(p.rate)}</span>
                                        </span>
                                      ))}
                                      {pts.filter(p => p.rate != null).length === 0 && <span className="text-[11px] text-slate-400">No monthly rate data.</span>}
                                    </div>
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                    {itemRows.length === 0 && <tr><td colSpan={7} className="text-center py-8 text-slate-400 text-sm">No item data for this period</td></tr>}
                  </tbody>
                </table>
              </div>
              </div>
            )}

            {/* ===== Item Drill-down ===== */}
            {!loading && activeSection === 'pa_drill' && (
              <div>
                {!drillSelected ? (
                  <div className="text-center py-16 text-slate-400 text-sm">No purchased items in this period{drillCat ? ' for this category' : ''}.</div>
                ) : (
                  <div>
                    {/* Heading + category chip */}
                    <div className="flex items-center gap-2 mb-3">
                      <h3 className="text-sm font-bold text-slate-800">{drillSelected.item}</h3>
                      {drillSelected.uom && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{drillSelected.uom}</span>}
                      {drillSelected.category && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 uppercase tracking-wide">{drillSelected.category}</span>}
                    </div>

                    {/* 5 summary cards */}
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
                      <Card label="Total Qty" value={`${fmtQty(drillSelected.qty)} ${drillSelected.uom}`.trim()} />
                      <Card label="Total Value" value={fmtINR(drillSelected.value)} color="text-indigo-700" />
                      <Card label={`Avg Price/${drillSelected.uom || 'unit'}`} value={drillSelected.qty > 0 ? fmtRup(drillSelected.value / drillSelected.qty) : '—'} />
                      <Card label="Vendors" value={drillVendors.length || (drillPivotItem ? drillPivotItem.vendors.length : 1)} />
                      <Card label="Price Range" value={(() => {
                        const avgs = drillVendors.map(v => v.avg).filter(Boolean);
                        if (avgs.length >= 1) return `${fmtRup(Math.min(...avgs)).replace('₹', '')} - ${fmtRup(Math.max(...avgs)).replace('₹', '')}`;
                        const rates = (drillSelected.points || []).map(p => p.rate).filter(r => r != null);
                        return rates.length ? `${fmtRup(Math.min(...rates)).replace('₹', '')} - ${fmtRup(Math.max(...rates)).replace('₹', '')}` : '—';
                      })()} />
                    </div>

                    {/* Vendor-wise table (only for multi-vendor items) */}
                    {drillVendors.length > 0 ? (
                      <>
                        <div className="flex items-center justify-between gap-3 mb-1.5">
                          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Vendor-wise Purchases</div>
                          <TableExport cols={expDrillVendors.cols} data={expDrillVendors.data} filename={`item-drill-vendors-${slug(drillSelected?.item)}`} title={`${drillSelected?.item} — Vendor-wise Purchases`} metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} chartSpec={{ labelField: 'vendor', valueField: 'value' }} />
                        </div>
                        <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh] mb-4">
                          <table className="w-full">
                            <thead><tr><TH>Vendor</TH><TH>UOM</TH><TH right>Qty</TH><TH right>Avg Price</TH><TH right>Total Value</TH><TH right>% Share</TH></tr></thead>
                            <tbody>
                              {drillVendors.map((v, i) => {
                                const open = drillOpenVendor === v.vendor;
                                const drill = drillVendorBills[v.vendor];
                                return (
                                  <React.Fragment key={i}>
                                    <tr onClick={() => toggleDrillVendor(v.vendor)}
                                      className={`cursor-pointer hover:bg-slate-50 ${open ? 'bg-indigo-50/60' : v.cheapest ? 'bg-emerald-50/50' : ''}`}>
                                      <TD bold>
                                        <ChevronDown size={12} className={`inline-block mr-1 text-slate-400 transition-transform ${open ? '' : '-rotate-90'}`} />
                                        {v.vendor}{v.is_msme && <span className="ml-1.5 text-[8px] font-bold px-1 py-0.5 rounded bg-indigo-50 text-indigo-700 align-middle">MSME</span>}{v.cheapest && <span className="ml-1.5 text-[8px] font-bold uppercase tracking-wide text-emerald-700 align-middle">cheapest</span>}
                                      </TD>
                                      <TD color="text-slate-400">{drillSelected.uom || '—'}</TD>
                                      <TD right>{fmtQty(v.qty)}</TD>
                                      <TD right color={v.cheapest ? 'text-emerald-700' : ''}>{fmtRup(v.avg)}</TD>
                                      <TD right bold color="text-indigo-700">{fmtINR(v.value)}</TD>
                                      <TD right color="text-slate-400">{v.pct.toFixed(1)}%</TD>
                                    </tr>
                                    {open && (
                                      <tr>
                                        <td colSpan={6} className="bg-slate-50 border-t border-slate-200 px-3 py-2">
                                          {drill?.loading ? (
                                            <div className="text-[11px] text-slate-500 py-2 px-1">Loading…</div>
                                          ) : (drill?.rows?.length ? (
                                            <div className="bg-white rounded-md border border-slate-200 overflow-auto max-h-[50vh]">
                                              <table className="w-full min-w-[640px]">
                                                <thead><tr>
                                                  <TH>Month</TH><TH>Invoice #</TH><TH>Date</TH><TH right>Qty</TH><TH>UOM</TH><TH right>Rate/{drillSelected.uom || 'unit'}</TH><TH right>Taxable value</TH><TH>Status</TH>
                                                </tr></thead>
                                                <tbody>
                                                  {drill.rows.map((r, ri) => (
                                                    <tr key={ri} className="hover:bg-slate-50">
                                                      <TD color="text-slate-500">{monthLabel(r.month)}</TD>
                                                      <TD clickable onClick={() => navigate(`/purchase/bills?quick=${r.bill_id}`)}>{r.bill_no || '—'}</TD>
                                                      <TD color="text-slate-500">{r.bill_date ? formatDate(r.bill_date) : '—'}</TD>
                                                      <TD right>{fmtQty(r.qty)}</TD>
                                                      <TD color="text-slate-400">{r.uom || '—'}</TD>
                                                      <TD right>{fmtRup(r.rate)}</TD>
                                                      <TD right bold color="text-indigo-700">{fmtINR(r.amount)}</TD>
                                                      <TD color="text-slate-500">{r.status || '—'}</TD>
                                                    </tr>
                                                  ))}
                                                </tbody>
                                              </table>
                                            </div>
                                          ) : (
                                            <div className="text-[11px] text-slate-400 italic py-2 px-1">No bills for this vendor in the period.</div>
                                          ))}
                                        </td>
                                      </tr>
                                    )}
                                  </React.Fragment>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </>
                    ) : (
                      <div className="bg-indigo-50/50 border border-indigo-100 rounded-lg px-3 py-2 text-[11px] text-slate-600 mb-4">
                        Bought from a single vendor in this period — no vendor comparison. The monthly price trend is shown below.
                      </div>
                    )}

                    {/* Monthly price summary */}
                    {drillMonthly.length > 0 && (
                      <>
                        <div className="flex items-center justify-between gap-3 mb-1.5">
                          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Monthly Price Summary</div>
                          <TableExport cols={expDrillMonthly.cols} data={expDrillMonthly.data} filename={`item-drill-monthly-${slug(drillSelected?.item)}`} title={`${drillSelected?.item} — Monthly Price Summary`} metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} chartSpec={{ labelField: 'month', valueField: 'qty' }} />
                        </div>
                        <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh] mb-4">
                          <table className="min-w-[520px] w-full">
                            <thead><tr>
                              <TH>Month</TH><TH right>Qty</TH><TH right>Avg Price</TH>
                              {drillHasMinMax && <TH right>Min Price</TH>}
                              {drillHasMinMax && <TH right>Max Price</TH>}
                            </tr></thead>
                            <tbody>
                              {drillMonthly.map((r, i) => (
                                <tr key={i} className="hover:bg-slate-50">
                                  <TD bold>{monthLabel(r.month)}</TD>
                                  <TD right>{r.qty ? fmtQty(r.qty) : '—'}</TD>
                                  <TD right>{r.rate != null ? fmtRup(r.rate) : '—'}</TD>
                                  {drillHasMinMax && <TD right color="text-emerald-700">{r.min != null ? fmtRup(r.min) : '—'}</TD>}
                                  {drillHasMinMax && <TD right color="text-red-600">{r.max != null ? fmtRup(r.max) : '—'}</TD>}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}

                    {/* Vendor × Month pivot (only for multi-vendor items) */}
                    {drillPivotItem && drillMonths.length > 0 && (
                      <>
                        <div className="flex items-center justify-between gap-3 mb-1.5">
                          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Vendor × Month Pivot</div>
                          <div className="flex items-center gap-2">
                            <div className="flex gap-1">
                              {[['qty', 'Qty'], ['rate', 'Avg Rate'], ['value', 'Value']].map(([k, lbl]) => (
                                <button key={k} type="button" onClick={() => setDrillMeasure(k)}
                                  className={`px-2 py-0.5 rounded text-[10px] font-semibold border transition ${drillMeasure === k ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-300 hover:border-indigo-400'}`}>
                                  {lbl}
                                </button>
                              ))}
                            </div>
                            <TableExport cols={expDrillPivot.cols} data={expDrillPivot.data} filename={`item-drill-pivot-${slug(drillSelected?.item)}`} title={`${drillSelected?.item} — Vendor × Month Pivot`} metaLines={[...exportMeta, `Measure: ${drillMeasure}`]} landscape kpis={reportKpis} companyName={companyName} initials={initials} />
                          </div>
                        </div>
                        <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                          <table className="min-w-[640px] w-full">
                            <thead><tr>
                              <th className="sticky top-0 left-0 z-20 bg-slate-100 text-left px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 border-b-2 border-slate-200">Vendor</th>
                              {drillMonths.map(m => <th key={m} className="sticky top-0 z-10 text-center px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 bg-slate-100 border-b-2 border-l border-slate-200 min-w-[64px]">{monthLabel(m)}</th>)}
                              <th className="sticky top-0 z-10 text-right px-2 py-1.5 text-[9px] font-extrabold uppercase tracking-wider text-indigo-700 bg-slate-100 border-b-2 border-l border-slate-200">Total</th>
                            </tr></thead>
                            <tbody>
                              {drillVendors.map((v, i) => {
                                const cellVal = (c) => {
                                  if (!c) return null;
                                  if (drillMeasure === 'qty') return c.qty;
                                  if (drillMeasure === 'rate') return c.rate;
                                  return (c.rate != null && c.qty != null) ? c.rate * c.qty : null;
                                };
                                const fmtCell = (x) => x == null ? '—' : (drillMeasure === 'value' ? fmtINR(x) : drillMeasure === 'rate' ? fmtRup(x) : fmtQty(x));
                                const rowTotal = drillMeasure === 'qty' ? v.qty : drillMeasure === 'value' ? v.value : v.avg;
                                return (
                                  <tr key={i} className="hover:bg-slate-50">
                                    <td className="sticky left-0 bg-white px-2 py-1 text-[11px] font-semibold text-slate-800 border-b border-slate-100 z-10">{v.vendor}{v.is_msme && <span className="ml-1.5 text-[8px] font-bold px-1 py-0.5 rounded bg-indigo-50 text-indigo-700 align-middle">MSME</span>}</td>
                                    {drillMonths.map(m => <td key={m} className="text-right px-2 py-1 text-[10px] tabular-nums font-semibold border-b border-l border-slate-100">{fmtCell(cellVal(v.cells[m]))}</td>)}
                                    <td className="text-right px-2 py-1 text-[11px] font-bold tabular-nums text-indigo-700 border-b border-l border-slate-200">{fmtCell(rowTotal)}</td>
                                  </tr>
                                );
                              })}
                              {/* Totals row (qty / value only; rate has no column total) */}
                              <tr className="bg-slate-50 font-bold">
                                <td className="sticky left-0 bg-slate-50 px-2 py-1 text-[11px] font-bold text-slate-700 border-t border-slate-200 z-10">Total</td>
                                {drillMonths.map(m => {
                                  let t = null;
                                  if (drillMeasure === 'qty') t = drillVendors.reduce((s, v) => s + num(v.cells[m]?.qty), 0) || null;
                                  else if (drillMeasure === 'value') t = drillVendors.reduce((s, v) => { const c = v.cells[m]; return s + ((c && c.rate != null && c.qty != null) ? c.rate * c.qty : 0); }, 0) || null;
                                  else { const a = drillPivotItem.month_avg?.[m]; t = a?.rate ?? null; }
                                  return <td key={m} className="text-right px-2 py-1 text-[10px] tabular-nums font-bold text-slate-700 border-t border-l border-slate-200">{t == null ? '—' : (drillMeasure === 'value' ? fmtINR(t) : drillMeasure === 'rate' ? fmtRup(t) : fmtQty(t))}</td>;
                                })}
                                <td className="text-right px-2 py-1 text-[11px] font-extrabold tabular-nums text-indigo-800 border-t border-l border-slate-200">
                                  {drillMeasure === 'qty' ? fmtQty(drillSelected.qty) : drillMeasure === 'value' ? fmtINR(drillSelected.value) : (drillSelected.qty > 0 ? fmtRup(drillSelected.value / drillSelected.qty) : '—')}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ===== Payment Efficiency ===== */}
            {!loading && activeSection === 'ac_pay' && (
              acc == null ? (
                <div className="flex items-center justify-center py-24 text-slate-400">
                  <Loader2 size={22} className="animate-spin text-indigo-500 mr-2" /> <span className="text-sm">Loading…</span>
                </div>
              ) : (
                <div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                    <Card label="DPO (Days Payable Outstanding)" value={`${num(accPay.dpo)}d`} color="text-amber-600" borderColor="border-amber-400" />
                    <Card label="Payment Rate" value={`${num(accPay.payment_rate)}%`} sub="Paid / Billed" color="text-emerald-600" borderColor="border-emerald-400" />
                    <Card label="Outstanding" value={fmtRup(num(accPay.outstanding))} color="text-amber-600" borderColor="border-amber-400" />
                    <Card label="Overdue" value={fmtRup(num(accPay.overdue))} color="text-rose-600" borderColor="border-rose-400" />
                  </div>

                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Month-wise Payment Trend</div>
                    <TableExport cols={expPayTrend.cols} data={expPayTrend.data} filename={`payment-trend-${slug(companyName)}`} title="Month-wise Payment Trend" metaLines={exportMeta} landscape kpis={reportKpis} companyName={companyName} initials={initials} />
                  </div>
                  <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh] mb-5">
                    <table className="min-w-[640px] w-full">
                      <thead><tr>
                        <th className="sticky top-0 left-0 z-20 bg-slate-100 text-left px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 border-b-2 border-slate-200">Metric</th>
                        {(accPay.monthly || []).map(m => <th key={m.month} className="sticky top-0 z-10 bg-slate-100 text-right px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 border-b-2 border-l border-slate-200 min-w-[88px]">{m.label}</th>)}
                      </tr></thead>
                      <tbody>
                        {['Billed', 'Paid', 'Payment %'].map((metric, mi) => (
                          <tr key={metric} className="hover:bg-slate-50">
                            <td className={`sticky left-0 z-10 bg-white px-2 py-1.5 text-[11px] font-semibold border-b border-slate-100 ${mi === 1 ? 'text-emerald-700' : mi === 2 ? 'text-amber-600' : 'text-slate-800'}`}>{metric}</td>
                            {(accPay.monthly || []).map(m => {
                              const val = mi === 0 ? (m.billed ? fmtRup(m.billed) : '—') : mi === 1 ? (m.paid ? fmtRup(m.paid) : '—') : (m.pct != null ? `${m.pct}%` : '—');
                              return <td key={m.month} className="text-right px-2 py-1.5 text-[10px] tabular-nums font-semibold border-b border-l border-slate-100">{val}</td>;
                            })}
                          </tr>
                        ))}
                        {(accPay.monthly || []).length === 0 && <tr><td className="text-center py-8 text-slate-400 text-sm" colSpan={1}>No data</td></tr>}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Slowest Payers</div>
                    <TableExport cols={expSlowest.cols} data={expSlowest.data} filename={`slowest-payers-${slug(companyName)}`} title="Slowest Payers" metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} chartSpec={{ labelField: 'vendor', valueField: 'outstanding' }} />
                  </div>
                  <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                    <table className="w-full">
                      <thead><tr><TH>Vendor</TH><TH right>Outstanding</TH><TH right>Overdue</TH><TH>Rating</TH></tr></thead>
                      <tbody>
                        {(accPay.slowest || []).map((r, i) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <TD bold>{r.vendor}</TD>
                            <TD right color="text-amber-600">{fmtRup(r.outstanding)}</TD>
                            <TD right color={r.overdue ? 'text-rose-600' : 'text-slate-300'}>{r.overdue ? fmtRup(r.overdue) : '—'}</TD>
                            <TD><span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full ${r.rating === 'POOR' ? 'bg-rose-50 text-rose-700' : r.rating === 'FAIR' ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>{r.rating}</span></TD>
                          </tr>
                        ))}
                        {(accPay.slowest || []).length === 0 && <tr><td colSpan={4} className="text-center py-8 text-slate-400 text-sm">No open payables</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}

            {/* ===== Credit / Debit Notes ===== */}
            {!loading && activeSection === 'ac_cndn' && (
              acc == null ? (
                <div className="flex items-center justify-center py-24 text-slate-400">
                  <Loader2 size={22} className="animate-spin text-indigo-500 mr-2" /> <span className="text-sm">Loading…</span>
                </div>
              ) : (
                <div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                    <Card label="Credit Notes" value={fmtRup(num(accNotes.credit_total))} sub={`${num(accNotes.credit_count)} notes`} color="text-rose-600" borderColor="border-rose-400" />
                    <Card label="Debit Notes" value={fmtRup(num(accNotes.debit_total))} sub={`${num(accNotes.debit_count)} notes`} color="text-emerald-600" borderColor="border-emerald-400" />
                    <Card label="Net Adjustment" value={fmtRup(num(accNotes.net_adjustment))} sub="DN − CN" color={num(accNotes.net_adjustment) < 0 ? 'text-rose-600' : 'text-slate-800'} borderColor="border-indigo-400" />
                    <Card label="CN as % of Purchases" value={`${cnPctOfPurchases.toFixed(1)}%`} sub="Target < 2%" color="text-indigo-700" borderColor="border-sky-400" />
                  </div>

                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">Recent Debit Notes</div>
                    <TableExport cols={expDebitNotes.cols} data={expDebitNotes.data} filename={`debit-notes-${slug(companyName)}`} title="Recent Debit Notes" metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} />
                  </div>
                  <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh] mb-5">
                    <table className="w-full">
                      <thead><tr><TH>No</TH><TH>Vendor</TH><TH>Date</TH><TH right>Amount</TH></tr></thead>
                      <tbody>
                        {(accNotes.recent_debit || []).map((r, i) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <TD bold>{r.no}</TD><TD color="text-slate-600">{r.vendor}</TD>
                            <TD color="text-slate-500">{fmtDate(r.date)}</TD>
                            <TD right bold color="text-emerald-700">{fmtRup(r.amount)}</TD>
                          </tr>
                        ))}
                        {(accNotes.recent_debit || []).length === 0 && <tr><td colSpan={4} className="text-center py-8 text-slate-400 text-sm">No debit notes this period</td></tr>}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-rose-700">Recent Credit Notes</div>
                    <TableExport cols={expCreditNotes.cols} data={expCreditNotes.data} filename={`credit-notes-${slug(companyName)}`} title="Recent Credit Notes" metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} />
                  </div>
                  <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                    <table className="w-full">
                      <thead><tr><TH>No</TH><TH>Vendor</TH><TH>Date</TH><TH right>Amount</TH></tr></thead>
                      <tbody>
                        {(accNotes.recent_credit || []).map((r, i) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <TD bold>{r.no}</TD><TD color="text-slate-600">{r.vendor}</TD>
                            <TD color="text-slate-500">{fmtDate(r.date)}</TD>
                            <TD right bold color="text-rose-600">{fmtRup(r.amount)}</TD>
                          </tr>
                        ))}
                        {(accNotes.recent_credit || []).length === 0 && <tr><td colSpan={4} className="text-center py-8 text-slate-400 text-sm">No credit notes this period</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}

            {/* ===== GST Summary ===== */}
            {!loading && activeSection === 'ac_gst' && (
              acc == null ? (
                <div className="flex items-center justify-center py-24 text-slate-400">
                  <Loader2 size={22} className="animate-spin text-indigo-500 mr-2" /> <span className="text-sm">Loading…</span>
                </div>
              ) : (
                <div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-4">
                    <Card label="Ex-GST (Taxable)" value={fmtINR(num(accGst.exgst))} color="text-slate-800" borderColor="border-indigo-400" />
                    <Card label="Total GST" value={fmtINR(num(accGst.total_gst))} color="text-indigo-700" borderColor="border-indigo-400" />
                    <Card label="Incl. GST" value={fmtINR(num(accGst.inclgst))} sub="Total invoice value" color="text-emerald-600" borderColor="border-emerald-400" />
                  </div>
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">GST Breakup</div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-4">
                    <Card label="CGST" value={fmtRup(num(accGst.cgst))} color="text-slate-800" borderColor="border-sky-400" />
                    <Card label="SGST" value={fmtRup(num(accGst.sgst))} color="text-slate-800" borderColor="border-sky-400" />
                    <Card label="IGST" value={fmtRup(num(accGst.igst))} color="text-slate-800" borderColor="border-sky-400" />
                  </div>
                  <div className="grid grid-cols-2 gap-2 mb-4">
                    <Card label="Other Charges" value={fmtRup(num(accGst.charges))} sub="Freight / testing" color="text-amber-600" borderColor="border-amber-400" />
                    <Card label="Round Off" value={fmtRup(num(accGst.round_off))} color="text-slate-800" borderColor="border-slate-300" />
                  </div>
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">Debit / Credit Notes</div>
                  <div className="grid grid-cols-2 gap-2 mb-4">
                    <Card label="Debit Notes" value={fmtRup(num(accGst.debit_notes))} color="text-emerald-700" borderColor="border-emerald-400" />
                    <Card label="Credit Notes" value={fmtRup(num(accGst.credit_notes))} color="text-rose-600" borderColor="border-rose-400" />
                  </div>

                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">Monthly GST Pivot</div>
                    <TableExport cols={expGstMonthly.cols} data={expGstMonthly.data} filename={`gst-monthly-${slug(companyName)}`} title="Monthly GST Pivot" metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} chartSpec={{ labelField: 'month', valueField: 'total' }} />
                  </div>
                  <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                    <table className="w-full">
                      <thead><tr><TH>Month</TH><TH right>CGST</TH><TH right>SGST</TH><TH right>IGST</TH><TH right>Total GST</TH></tr></thead>
                      <tbody>
                        {(accGst.monthly || []).map((m, i) => (
                          <tr key={i} className="hover:bg-slate-50">
                            <TD bold>{m.label}</TD>
                            <TD right>{m.cgst ? fmtRup(m.cgst) : '—'}</TD>
                            <TD right>{m.sgst ? fmtRup(m.sgst) : '—'}</TD>
                            <TD right>{m.igst ? fmtRup(m.igst) : '—'}</TD>
                            <TD right bold color="text-indigo-700">{m.total_gst ? fmtRup(m.total_gst) : '—'}</TD>
                          </tr>
                        ))}
                        {(accGst.monthly || []).length === 0 && <tr><td colSpan={5} className="text-center py-8 text-slate-400 text-sm">No GST data for this period</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            )}

            {/* ===== TDS Summary ===== */}
            {!loading && activeSection === 'ac_tds' && (
              <div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-4">
                  <Card label="ERP TDS (expected)" value={fmtRup(num(tds?.erp_total))} sub={tds?.fy?.label || ''} color="text-indigo-700" borderColor="border-indigo-400" />
                  <Card label="Tally TDS (deducted)" value={fmtRup(num(tds?.tally_total))} color="text-sky-600" borderColor="border-sky-400" />
                  <Card label="Difference" value={fmtRup(num(tds?.difference_total))} sub={`${num(tds?.vendor_count)} vendors`} color={num(tds?.difference_total) > 0 ? 'text-amber-600' : 'text-emerald-600'} borderColor="border-amber-400" />
                </div>
                <div className="flex items-center justify-between gap-3 mb-1.5">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">TDS by Vendor</div>
                  <TableExport cols={expTds.cols} data={expTds.data} filename={`tds-summary-${slug(companyName)}`} title="TDS Summary by Vendor" metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} chartSpec={{ labelField: 'vendor', valueField: 'erp' }} />
                </div>
                <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                  <table className="w-full">
                    <thead><tr><TH>Vendor</TH><TH>Section</TH><TH right>Rate</TH><TH right>FY base</TH><TH right>ERP TDS</TH><TH right>Tally TDS</TH><TH right>Diff</TH></tr></thead>
                    <tbody>
                      {tdsRows.map((r, i) => (
                        <tr key={i} className="hover:bg-slate-50">
                          <TD bold>{r.vendor}</TD>
                          <TD color="text-slate-500">{r.section || '—'}</TD>
                          <TD right>{num(r.rate_pct).toFixed(2)}%</TD>
                          <TD right>{fmtINR(num(r.fy_aggregate))}</TD>
                          <TD right color="text-indigo-700">{fmtRup(num(r.erp_tds))}</TD>
                          <TD right color="text-sky-600">{fmtRup(num(r.tally_tds))}</TD>
                          <TD right color={num(r.difference) !== 0 ? 'text-amber-600' : 'text-slate-300'}>{fmtRup(num(r.difference))}</TD>
                        </tr>
                      ))}
                      {tdsRows.length === 0 && <tr><td colSpan={7} className="text-center py-8 text-slate-400 text-sm">No TDS data for this period</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ===== Vendor Turnover ===== */}
            {!loading && activeSection === 'pa_vturn' && (
              <div>
                {vturn == null ? (
                  <div className="flex items-center justify-center py-24 text-slate-400">
                    <Loader2 size={22} className="animate-spin text-indigo-500 mr-2" /> <span className="text-sm">Loading…</span>
                  </div>
                ) : vturnVendors.length === 0 ? (
                  <div className="text-center py-16 text-slate-400 text-sm">No vendor turnover in this period{vturnCat ? ' for this category' : ''}.</div>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-3 mb-1.5">
                      <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">
                        Vendor Turnover <span className="text-slate-400 font-semibold normal-case ml-1">(click vendor to see items purchased)</span>
                      </div>
                      <TableExport cols={expVturn.cols} data={expVturn.data} filename={`vendor-turnover-${slug(companyName)}`} title="Vendor Turnover" metaLines={exportMeta} landscape kpis={reportKpis} companyName={companyName} initials={initials} chartSpec={{ labelField: 'vendor', valueField: 'total' }} />
                    </div>
                    <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                      <table className="min-w-[720px] w-full">
                        <thead><tr>
                          <th className="sticky top-0 left-0 z-20 bg-slate-100 text-left px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 border-b-2 border-slate-200">Vendor</th>
                          {vturnMonths.map(m => <th key={m} className="sticky top-0 z-10 text-center px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 bg-slate-100 border-b-2 border-l border-slate-200 min-w-[70px]">{monthLabel(m)}</th>)}
                          <th className="sticky top-0 z-10 text-right px-2 py-1.5 text-[9px] font-extrabold uppercase tracking-wider text-indigo-700 bg-slate-100 border-b-2 border-l border-slate-200">Total</th>
                        </tr></thead>
                        <tbody>
                          {vturnVendors.map((v, i) => {
                            const open = vturnOpen === v.vendor;
                            return (
                              <React.Fragment key={i}>
                                <tr onClick={() => setVturnOpen(open ? null : v.vendor)}
                                  className={`cursor-pointer hover:bg-slate-50 ${open ? 'bg-indigo-50/60' : ''}`}>
                                  <td className="sticky left-0 bg-white px-2 py-1 text-[11px] font-semibold text-slate-800 border-b border-slate-100 z-10">
                                    <span className="flex items-center gap-1">
                                      <ChevronDown size={11} className={`text-slate-400 transition-transform flex-shrink-0 ${open ? '' : '-rotate-90'}`} />
                                      <span className="hover:underline">{v.vendor}</span>
                                    </span>
                                  </td>
                                  {vturnMonths.map(m => (
                                    <td key={m} className="text-right px-2 py-1 text-[10px] tabular-nums font-semibold border-b border-l border-slate-100">
                                      {v.by_month?.[m] ? fmtINR(v.by_month[m]) : <span className="text-slate-300">—</span>}
                                    </td>
                                  ))}
                                  <td className="text-right px-2 py-1 text-[11px] font-bold tabular-nums text-indigo-700 border-b border-l border-slate-200">{fmtINR(v.by_month?.total)}</td>
                                </tr>
                                {open && (
                                  <tr><td colSpan={vturnMonths.length + 2} className="p-0">
                                    <div className="bg-slate-50 border-t border-b border-slate-200 px-4 py-3">
                                      <div className="text-[10px] font-bold text-slate-600 uppercase mb-2">Items Purchased</div>
                                      {(v.items || []).length > 0 ? (
                                        <div className="bg-white rounded-md border border-slate-200 overflow-auto max-h-[50vh]">
                                          <table className="min-w-[640px] w-full">
                                            <thead><tr>
                                              <th className="sticky top-0 left-0 z-20 bg-slate-100 text-left px-2 py-1 text-[9px] font-bold uppercase text-indigo-700">Product</th>
                                              <th className="sticky top-0 z-10 bg-slate-100 text-left px-2 py-1 text-[9px] font-bold uppercase text-indigo-700">UOM</th>
                                              {vturnMonths.map(m => <th key={m} className="sticky top-0 z-10 bg-slate-100 text-center px-2 py-1 text-[9px] font-bold uppercase text-indigo-700 border-l border-slate-200 min-w-[72px]">{monthLabel(m)}</th>)}
                                              <th className="sticky top-0 z-10 bg-slate-100 text-right px-2 py-1 text-[9px] font-extrabold uppercase text-indigo-700 border-l border-slate-200">Total Qty</th>
                                              <th className="sticky top-0 z-10 bg-slate-100 text-right px-2 py-1 text-[9px] font-extrabold uppercase text-indigo-700 border-l border-slate-200">Total Value</th>
                                            </tr></thead>
                                            <tbody>
                                              {v.items.map((it, ii) => (
                                                <tr key={ii} className="hover:bg-slate-50 border-b border-slate-100">
                                                  <td className="sticky left-0 bg-white px-2 py-1 text-[11px] font-medium text-slate-800 z-10">{it.item}</td>
                                                  <td className="px-2 py-1 text-[10px] text-slate-400">{it.uom || '—'}</td>
                                                  {vturnMonths.map(m => {
                                                    const md = it.by_month?.[m];
                                                    return <td key={m} className="text-right px-2 py-1 text-[10px] tabular-nums border-l border-slate-100">
                                                      {md ? (
                                                        <div className="leading-tight">
                                                          <div className="font-semibold text-slate-700"><span className="text-slate-400 font-normal text-[8px] mr-0.5">Qty</span>{fmtQty(md.qty)}</div>
                                                          <div className="text-slate-500 text-[9px]"><span className="text-slate-400 mr-0.5">Rate</span>{md.qty > 0 ? fmtRup(md.value / md.qty) : '—'}</div>
                                                        </div>
                                                      ) : <span className="text-slate-300">—</span>}
                                                    </td>;
                                                  })}
                                                  <td className="text-right px-2 py-1 text-[10px] font-bold tabular-nums text-slate-700 border-l border-slate-200">{fmtQty(it.total_qty)}</td>
                                                  <td className="text-right px-2 py-1 text-[10px] font-bold tabular-nums text-indigo-700 border-l border-slate-200">{fmtINR(it.total_value)}</td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      ) : <div className="text-[11px] text-slate-400 italic">No item detail for this vendor.</div>}
                                    </div>
                                  </td></tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                          {/* Totals row */}
                          <tr className="bg-slate-50 font-bold">
                            <td className="sticky left-0 bg-slate-50 px-2 py-1 text-[11px] font-bold text-slate-700 border-t border-slate-200 z-10">Total · {vturnVendors.length} vendors</td>
                            {vturnMonths.map(m => (
                              <td key={m} className="text-right px-2 py-1 text-[10px] tabular-nums font-bold text-slate-700 border-t border-l border-slate-200">{vturnTotals.byMonth[m] ? fmtINR(vturnTotals.byMonth[m]) : '—'}</td>
                            ))}
                            <td className="text-right px-2 py-1 text-[11px] font-extrabold tabular-nums text-indigo-800 border-t border-l border-slate-200">{fmtINR(vturnTotals.grand)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ===== Branch Transfers ===== */}
            {!loading && activeSection === 'pa_branch' && (
              <div>
                {branchTx == null ? (
                  <div className="flex items-center justify-center py-24 text-slate-400">
                    <Loader2 size={22} className="animate-spin text-indigo-500 mr-2" /> <span className="text-sm">Loading…</span>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-4">
                      <Card label="Branch Transfer Total" value={fmtINR(num(branchTx.total))} sub="Taxable value (ex-GST)" color="text-amber-600" borderColor="border-amber-400" />
                      <Card label="Branch Vendors" value={num(branchTx.branch_count)} sub="Matched as branch" color="text-indigo-700" borderColor="border-indigo-400" />
                      <Card label="Company PAN" value={branchTx.company_pan || '—'} sub="Used for matching" color="text-slate-900" borderColor="border-sky-400" />
                    </div>

                    {branchRows.length === 0 ? (
                      <div className="text-center py-16 text-slate-400 text-sm">No branch transfers in this period.</div>
                    ) : (
                      <>
                        <div className="flex items-center justify-between gap-3 mb-1.5">
                          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">
                            Branch Transfer Summary <span className="text-slate-400 font-semibold normal-case ml-1">(excluded from Purchases)</span>
                          </div>
                          <TableExport cols={expBranchSummary.cols} data={expBranchSummary.data} filename={`branch-summary-${slug(companyName)}`} title="Branch Transfer Summary" metaLines={exportMeta} landscape kpis={reportKpis} companyName={companyName} initials={initials} chartSpec={{ labelField: 'branch', valueField: 'total' }} />
                        </div>
                        <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh] mb-5">
                          <table className="min-w-[720px] w-full">
                            <thead><tr>
                              <th className="sticky top-0 left-0 z-20 bg-slate-100 text-left px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 border-b-2 border-slate-200">Branch</th>
                              {branchMonths.map(m => <th key={m.month} className="sticky top-0 z-10 text-center px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 bg-slate-100 border-b-2 border-l border-slate-200 min-w-[78px]">{m.label}</th>)}
                              <th className="sticky top-0 z-10 text-right px-2 py-1.5 text-[9px] font-extrabold uppercase tracking-wider text-indigo-700 bg-slate-100 border-b-2 border-l border-slate-200">Total</th>
                            </tr></thead>
                            <tbody>
                              {branchRows.map((b, i) => (
                                <tr key={i} className="hover:bg-slate-50">
                                  <td className="sticky left-0 bg-white px-2 py-1 text-[11px] font-semibold text-slate-800 border-b border-slate-100 z-10">{b.branch}</td>
                                  {branchMonths.map(m => (
                                    <td key={m.month} className="text-right px-2 py-1 text-[10px] tabular-nums font-semibold border-b border-l border-slate-100">
                                      {b.by_month?.[m.month] ? fmtINR(b.by_month[m.month]) : <span className="text-slate-300">—</span>}
                                    </td>
                                  ))}
                                  <td className="text-right px-2 py-1 text-[11px] font-bold tabular-nums text-indigo-700 border-b border-l border-slate-200">{fmtINR(b.by_month?.total)}</td>
                                </tr>
                              ))}
                              <tr className="bg-slate-50 font-bold">
                                <td className="sticky left-0 bg-slate-50 px-2 py-1 text-[11px] font-bold text-slate-700 border-t border-slate-200 z-10">Total · {branchRows.length} branch{branchRows.length === 1 ? '' : 'es'}</td>
                                {branchMonths.map(m => (
                                  <td key={m.month} className="text-right px-2 py-1 text-[10px] tabular-nums font-bold text-slate-700 border-t border-l border-slate-200">{branchTotals.byMonth[m.month] ? fmtINR(branchTotals.byMonth[m.month]) : '—'}</td>
                                ))}
                                <td className="text-right px-2 py-1 text-[11px] font-extrabold tabular-nums text-amber-600 border-t border-l border-slate-200">{fmtINR(branchTotals.grand)}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>

                        <div className="flex items-center justify-between gap-3 mb-1.5">
                          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600">
                            Branch Bills <span className="text-slate-400 font-semibold normal-case ml-1">({branchBills.length})</span>
                          </div>
                          <TableExport cols={expBranchBills.cols} data={expBranchBills.data} filename={`branch-bills-${slug(companyName)}`} title="Branch Bills" metaLines={exportMeta} kpis={reportKpis} companyName={companyName} initials={initials} />
                        </div>
                        <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-auto max-h-[70vh]">
                          <table className="min-w-[640px] w-full">
                            <thead><tr><TH>Invoice #</TH><TH>Date</TH><TH>Branch</TH><TH right>Taxable</TH><TH right>Total (incl GST)</TH></tr></thead>
                            <tbody>
                              {branchBills.map((r, i) => {
                                const open = branchOpen === r.bill_id;
                                const det = branchBillLines[r.bill_id];
                                return (
                                  <React.Fragment key={i}>
                                    <tr onClick={() => toggleBranchBill(r.bill_id)}
                                      className={`cursor-pointer hover:bg-slate-50 ${open ? 'bg-indigo-50/60' : ''}`}>
                                      <TD bold>
                                        <ChevronDown size={12} className={`inline-block mr-1 text-slate-400 transition-transform ${open ? '' : '-rotate-90'}`} />
                                        <span className="text-indigo-600 hover:underline" onClick={(e) => { e.stopPropagation(); navigate(`/purchase/bills?quick=${r.bill_id}`); }}>{r.bill_no || '—'}</span>
                                      </TD>
                                      <TD color="text-slate-500">{fmtDate(r.bill_date)}</TD>
                                      <TD color="text-slate-600">{r.branch}</TD>
                                      <TD right>{fmtINR(r.taxable)}</TD>
                                      <TD right bold color="text-slate-900">{fmtINR(r.total)}</TD>
                                    </tr>
                                    {open && (
                                      <tr>
                                        <td colSpan={5} className="bg-slate-50 border-t border-slate-200 px-3 py-2">
                                          {det?.loading ? (
                                            <div className="text-[11px] text-slate-400 py-2">Loading line items…</div>
                                          ) : (det?.lines?.length ? (
                                            <div className="bg-white rounded-md border border-slate-200 overflow-auto max-h-[50vh]">
                                              <table className="w-full min-w-[520px]">
                                                <thead><tr>
                                                  <th className="sticky top-0 z-10 text-left px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 bg-slate-100 border-b-2 border-slate-200">Item</th>
                                                  <TH>UOM</TH><TH right>Qty</TH><TH right>Rate</TH><TH right>Tax%</TH><TH right>Amount</TH>
                                                </tr></thead>
                                                <tbody>
                                                  {det.lines.map((l, li) => {
                                                    const tax = Number(l.tax_percent) > 0 ? Number(l.tax_percent) : Number(l.effective_tax_percent) || 0;
                                                    return (
                                                      <tr key={li} className="hover:bg-slate-50">
                                                        <TD bold>{l.item_name || l.product_name || l.description || '—'}</TD>
                                                        <TD color="text-slate-400">{l.uom || '—'}</TD>
                                                        <TD right>{l.quantity != null ? fmtQty(l.quantity) : '—'}</TD>
                                                        <TD right>{l.rate != null ? fmtRup(l.rate) : '—'}</TD>
                                                        <TD right>{tax ? `${tax}%` : '—'}</TD>
                                                        <TD right bold color="text-slate-900">{l.amount != null ? fmtINR(l.amount) : '—'}</TD>
                                                      </tr>
                                                    );
                                                  })}
                                                </tbody>
                                              </table>
                                            </div>
                                          ) : (
                                            <div className="text-[11px] text-slate-400 py-2">No line items on this bill.</div>
                                          ))}
                                        </td>
                                      </tr>
                                    )}
                                  </React.Fragment>
                                );
                              })}
                              {branchBills.length === 0 && <tr><td colSpan={5} className="text-center py-8 text-slate-400 text-sm">No branch bills for this period</td></tr>}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ===== Coming soon (everything else) ===== */}
            {!WIRED.has(activeSection) && <ComingSoon sectionId={activeSection} />}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
