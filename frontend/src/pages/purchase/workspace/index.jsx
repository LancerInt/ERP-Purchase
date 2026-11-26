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
  Loader2, X, Calendar, Sparkles, Check, Building2,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import apiClient from '../../../utils/api.js';
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
  { title: 'Payables', items: [
    { id: 'pay_week',  label: 'This Week',       icon: AlertCircle },
    { id: 'pay_aged',  label: 'Overdue Ageing',  icon: AlertTriangle },
    { id: 'pay_up',    label: 'Upcoming',        icon: Clock },
    { id: 'top_vend',  label: 'Top Vendors',     icon: CreditCard },
  ]},
  { title: 'Vendors', items: [
    { id: 'v_top',    label: 'Top Vendors',     icon: Star },
    { id: 'v_inact',  label: 'Inactive',        icon: UserX },
    { id: 'v_new',    label: 'New Vendors',     icon: UserPlus },
    { id: 'v_conc',   label: 'Concentration',   icon: Target },
  ]},
  { title: 'Purchase Analytics', items: [
    { id: 'pa_item',  label: 'Item Analytics',  icon: Package },
    { id: 'pa_vturn', label: 'Vendor Turnover', icon: ArrowLeftRight },
    { id: 'pa_drill', label: 'Item Drill-down', icon: BarChart3 },
    { id: 'pa_trend', label: 'Purchase Trend',  icon: TrendingUp },
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
const WIRED = new Set(['top_vend', 'pa_trend', 'pa_item', 'pa_drill', 'pa_vturn', 'ac_tds']);

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
  return <th className={`${right ? 'text-right' : 'text-left'} px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 bg-slate-100 border-b-2 border-slate-200`}>{children}</th>;
}
function TD({ children, right, bold, color, clickable, onClick }) {
  return <td onClick={onClick} className={`px-2 py-1.5 border-b border-slate-100 text-[11px] ${right ? 'text-right tabular-nums' : ''} ${bold ? 'font-semibold' : ''} ${color || ''} ${clickable ? 'text-indigo-600 cursor-pointer hover:underline' : ''}`}>{children}</td>;
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
        return <td key={m.month} className={`text-right px-2 py-1.5 text-[10px] tabular-nums border-b border-l border-slate-100 ${labelCls || 'text-slate-700'}`}>{v ? `${sign || ''}${fmt(v)}` : '—'}</td>;
      })}
      <td className={`text-right px-2 py-1.5 text-[11px] font-bold tabular-nums border-b border-l border-slate-200 ${labelCls || 'text-slate-700'}`}>{rows[k]?.total ? `${sign || ''}${fmt(rows[k].total)}` : '—'}</td>
    </tr>
  );
  return (
    <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-x-auto">
      <table className="min-w-[720px] w-full">
        <thead><tr>
          <th className="sticky left-0 bg-slate-100 text-left px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 border-b-2 border-slate-200 z-10">Type</th>
          {months.map(m => <th key={m.month} className="text-center px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 bg-slate-100 border-b-2 border-l border-slate-200 min-w-[78px]">{m.label}</th>)}
          <th className="text-right px-2 py-1.5 text-[9px] font-extrabold uppercase tracking-wider text-indigo-700 bg-slate-100 border-b-2 border-l border-slate-200">Total</th>
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

export default function PurchaseWorkspace() {
  const navigate = useNavigate();
  const { company, companies, setCompany } = useGlobalCompany();

  // ── UI state ──
  const [activeSection, setActiveSection] = useState('top_vend');
  const [profileCollapsed, setProfileCollapsed] = useState(false);
  const [companyMenuOpen, setCompanyMenuOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState(() => {
    const o = {}; NAV_GROUPS.forEach(g => { o[g.title] = g.title === 'Payables'; }); return o;
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

  // ── Item Drill-down UI state ──
  const [drillCat, setDrillCat] = useState('');     // category filter (''=All)
  const [drillItem, setDrillItem] = useState('');   // selected item name
  const [drillMeasure, setDrillMeasure] = useState('qty'); // qty | rate | value
  const [drillOpenVendor, setDrillOpenVendor] = useState(null); // expanded vendor row
  const [drillVendorBills, setDrillVendorBills] = useState({});  // {vendor: {loading, rows}}, keyed per item+vendor

  // ── Vendor Turnover UI state ──
  const [vturn, setVturn] = useState(null);         // vendor-turnover payload
  const [vturnCat, setVturnCat] = useState('');     // category filter (''=All)
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

  // ── Fetch on company / date change ──
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const cp = company ? `company=${company}&` : '';
    const win = `${cp}from=${dateFrom}&to=${dateTo}`;
    const fyParam = String(_fyYear(new Date(dateFrom)));
    setBreakdown(null); setDrillPivot(null);
    Promise.all([
      apiClient.get(`/api/purchase/dashboard/?${cp}period=custom&from=${dateFrom}&to=${dateTo}`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/purchase/dashboard/analytics/?${win}`).then(r => r.data?.mom_trend || []).catch(() => []),
      apiClient.get(`/api/purchase/item-rate-trend/?side=purchase&${win}`).then(r => r.data?.items || []).catch(() => []),
      apiClient.get(`/api/purchase/tds-summary/?${cp}fy=${fyParam}`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/purchase/monthly-breakdown/?${win}`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/purchase/item-rate-trend/?side=purchase&mode=pivot&${win}`).then(r => r.data).catch(() => null),
    ]).then(([d, t, it, td, bd, pv]) => {
      if (!alive) return;
      setDash(d); setTrend(t || []); setItems(it || []); setTds(td); setBreakdown(bd); setDrillPivot(pv);
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [company, dateFrom, dateTo]);

  // ── Vendor Turnover — its own fetch (also keyed on the category filter) ──
  useEffect(() => {
    let alive = true;
    setVturn(null); setVturnOpen(null);
    const cp = company ? `company=${company}&` : '';
    const catP = vturnCat ? `&category=${encodeURIComponent(vturnCat)}` : '';
    apiClient.get(`/api/purchase/vendor-turnover/?${cp}from=${dateFrom}&to=${dateTo}${catP}`)
      .then(r => { if (alive) setVturn(r.data || { months: [], vendors: [] }); })
      .catch(() => { if (alive) setVturn({ months: [], vendors: [] }); });
    return () => { alive = false; };
  }, [company, dateFrom, dateTo, vturnCat]);

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
      .sort((a, b) => b.outstanding - a.outstanding);
    const totalOut = rows.reduce((s, r) => s + r.outstanding, 0);
    return rows.map(r => ({ ...r, pct: totalOut > 0 ? (r.outstanding / totalOut) * 100 : 0 })).slice(0, 25);
  }, [vendorBreakdown]);
  const totalPayable = topVendors.reduce((s, r) => s + r.outstanding, 0);
  const totalOverdue = topVendors.reduce((s, r) => s + r.overdue, 0);
  const paymentRate = billed > 0 ? (paid / billed) * 100 : 0;

  // ── Item analytics rows ──
  const itemRows = useMemo(() => (items || [])
    .map(it => {
      const qty = num(it.total_qty); const val = num(it.total_value);
      return { item: it.item, uom: it.uom || '', category: it.category || '', qty, value: val, avg: qty > 0 ? val / qty : 0 };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 40),
  [items]);

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
        vendor: v.vendor, qty: num(v.total_qty), value: num(v.total_value),
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
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="px-5 py-2.5 bg-white border-b border-slate-200 flex items-center justify-between gap-3 flex-shrink-0">
            <h2 className="text-base font-bold text-slate-900 shrink-0">{sectionTitle}</h2>
            <div className="flex items-center gap-2.5 ml-auto">
            {activeSection === 'pa_vturn' && (
              <select value={vturnCat} onChange={e => { setVturnCat(e.target.value); setVturnOpen(null); }}
                className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-700 bg-white focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100">
                {DRILL_CATS.map(c => <option key={c.key || 'all'} value={c.key}>{c.key ? c.label : 'All Categories'}</option>)}
              </select>
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

            {/* ===== Top Vendors ===== */}
            {!loading && activeSection === 'top_vend' && (
              <div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-4">
                  <Card label="Total Payable" value={fmtINR(totalPayable)} sub={`${topVendors.length} vendors`} color="text-amber-600" borderColor="border-amber-400" />
                  <Card label="Total Overdue" value={fmtINR(totalOverdue)} color="text-red-600" borderColor="border-red-400" />
                  <Card label="Payment Rate" value={`${paymentRate.toFixed(1)}%`} sub="Paid / Billed" color="text-emerald-600" borderColor="border-emerald-400" />
                </div>
                <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-hidden">
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
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">Monthly Turnover Breakdown <span className="text-slate-400 font-semibold normal-case">(taxable, ex-GST)</span></div>
                {breakdown == null
                  ? <div className="bg-white rounded-lg border border-slate-300 shadow-sm py-8 text-center text-slate-400 text-sm mb-4">Loading…</div>
                  : <div className="mb-4"><BreakdownPivot breakdown={breakdown} fmt={fmtINR} /></div>}

                {/* Detailed figures (exact ₹) — collapsible */}
                {breakdown != null && (breakdown.months || []).length > 0 && (
                  <div>
                    <button type="button" onClick={() => setShowExact(s => !s)}
                      className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-600 hover:text-indigo-700 mb-1.5">
                      <ChevronDown size={13} className={`transition-transform ${showExact ? '' : '-rotate-90'}`} />
                      Detailed figures <span className="text-slate-400 font-semibold normal-case">(exact ₹ for Tally verification)</span>
                    </button>
                    {showExact && <BreakdownPivot breakdown={breakdown} fmt={fmtExact} />}
                  </div>
                )}
              </div>
            )}

            {/* ===== Item Analytics ===== */}
            {!loading && activeSection === 'pa_item' && (
              <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-hidden">
                <div className="px-4 py-2.5 text-[12px] font-bold text-slate-800 border-b border-slate-100">
                  Product Summary <span className="font-medium text-slate-400 text-[11px] ml-1">({itemRows.length} products)</span>
                </div>
                <table className="w-full">
                  <thead><tr><TH>Product</TH><TH>UOM</TH><TH right>Qty</TH><TH right>Avg price</TH><TH right>Value</TH></tr></thead>
                  <tbody>
                    {itemRows.map((r, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <TD bold>{r.item}</TD>
                        <TD color="text-slate-400">{r.uom || '—'}</TD>
                        <TD right>{fmtQty(r.qty)}</TD>
                        <TD right>{fmtRup(r.avg)}</TD>
                        <TD right bold color="text-indigo-700">{fmtINR(r.value)}</TD>
                      </tr>
                    ))}
                    {itemRows.length === 0 && <tr><td colSpan={5} className="text-center py-8 text-slate-400 text-sm">No item data for this period</td></tr>}
                  </tbody>
                </table>
              </div>
            )}

            {/* ===== Item Drill-down ===== */}
            {!loading && activeSection === 'pa_drill' && (
              <div>
                {/* Category filter + item selector */}
                <div className="flex flex-wrap items-center gap-3 mb-4">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">Category:</span>
                  <div className="flex flex-wrap gap-1.5">
                    {DRILL_CATS.map(c => (
                      <button key={c.key || 'all'} type="button" onClick={() => setDrillCat(c.key)}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition ${drillCat === c.key ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-300 hover:border-indigo-400'}`}>
                        {c.label}
                      </button>
                    ))}
                  </div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600 ml-1">Item:</span>
                  <select value={drillItem} onChange={e => setDrillItem(e.target.value)}
                    className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-900 bg-white focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 min-w-[220px]">
                    {drillItems.length === 0 && <option value="">— no items —</option>}
                    {drillItems.map(it => <option key={it.item} value={it.item}>{it.item}</option>)}
                  </select>
                </div>

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
                        <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">Vendor-wise Purchases</div>
                        <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-hidden mb-4">
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
                                        {v.vendor}{v.cheapest && <span className="ml-1.5 text-[8px] font-bold uppercase tracking-wide text-emerald-700 align-middle">cheapest</span>}
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
                                            <div className="bg-white rounded-md border border-slate-200 overflow-x-auto">
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
                        <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">Monthly Price Summary</div>
                        <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-x-auto mb-4">
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
                          <div className="flex gap-1">
                            {[['qty', 'Qty'], ['rate', 'Avg Rate'], ['value', 'Value']].map(([k, lbl]) => (
                              <button key={k} type="button" onClick={() => setDrillMeasure(k)}
                                className={`px-2 py-0.5 rounded text-[10px] font-semibold border transition ${drillMeasure === k ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-300 hover:border-indigo-400'}`}>
                                {lbl}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-x-auto">
                          <table className="min-w-[640px] w-full">
                            <thead><tr>
                              <th className="sticky left-0 bg-slate-100 text-left px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 border-b-2 border-slate-200 z-10">Vendor</th>
                              {drillMonths.map(m => <th key={m} className="text-center px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 bg-slate-100 border-b-2 border-l border-slate-200 min-w-[64px]">{monthLabel(m)}</th>)}
                              <th className="text-right px-2 py-1.5 text-[9px] font-extrabold uppercase tracking-wider text-indigo-700 bg-slate-100 border-b-2 border-l border-slate-200">Total</th>
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
                                    <td className="sticky left-0 bg-white px-2 py-1 text-[11px] font-semibold text-slate-800 border-b border-slate-100 z-10">{v.vendor}</td>
                                    {drillMonths.map(m => <td key={m} className="text-right px-2 py-1 text-[10px] tabular-nums border-b border-l border-slate-100">{fmtCell(cellVal(v.cells[m]))}</td>)}
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

            {/* ===== TDS Summary ===== */}
            {!loading && activeSection === 'ac_tds' && (
              <div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-4">
                  <Card label="ERP TDS (expected)" value={fmtRup(num(tds?.erp_total))} sub={tds?.fy?.label || ''} color="text-indigo-700" borderColor="border-indigo-400" />
                  <Card label="Tally TDS (deducted)" value={fmtRup(num(tds?.tally_total))} color="text-sky-600" borderColor="border-sky-400" />
                  <Card label="Difference" value={fmtRup(num(tds?.difference_total))} sub={`${num(tds?.vendor_count)} vendors`} color={num(tds?.difference_total) > 0 ? 'text-amber-600' : 'text-emerald-600'} borderColor="border-amber-400" />
                </div>
                <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-hidden">
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
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">
                      Vendor Turnover <span className="text-slate-400 font-semibold normal-case ml-1">(click vendor to see items purchased)</span>
                    </div>
                    <div className="bg-white rounded-lg border border-slate-300 shadow-sm overflow-x-auto">
                      <table className="min-w-[720px] w-full">
                        <thead><tr>
                          <th className="sticky left-0 bg-slate-100 text-left px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 border-b-2 border-slate-200 z-10">Vendor</th>
                          {vturnMonths.map(m => <th key={m} className="text-center px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-indigo-700 bg-slate-100 border-b-2 border-l border-slate-200 min-w-[70px]">{monthLabel(m)}</th>)}
                          <th className="text-right px-2 py-1.5 text-[9px] font-extrabold uppercase tracking-wider text-indigo-700 bg-slate-100 border-b-2 border-l border-slate-200">Total</th>
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
                                    <td key={m} className="text-right px-2 py-1 text-[10px] tabular-nums border-b border-l border-slate-100">
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
                                        <div className="bg-white rounded-md border border-slate-200 overflow-x-auto">
                                          <table className="min-w-[640px] w-full">
                                            <thead><tr>
                                              <th className="sticky left-0 bg-slate-100 text-left px-2 py-1 text-[9px] font-bold uppercase text-indigo-700 z-10">Product</th>
                                              <th className="text-left px-2 py-1 text-[9px] font-bold uppercase text-indigo-700">UOM</th>
                                              {vturnMonths.map(m => <th key={m} className="text-center px-2 py-1 text-[9px] font-bold uppercase text-indigo-700 border-l border-slate-200 min-w-[72px]">{monthLabel(m)}</th>)}
                                              <th className="text-right px-2 py-1 text-[9px] font-extrabold uppercase text-indigo-700 border-l border-slate-200">Total Qty</th>
                                              <th className="text-right px-2 py-1 text-[9px] font-extrabold uppercase text-indigo-700 border-l border-slate-200">Total Value</th>
                                            </tr></thead>
                                            <tbody>
                                              {v.items.map((it, ii) => (
                                                <tr key={ii} className="hover:bg-slate-50 border-b border-slate-100">
                                                  <td className="sticky left-0 bg-white px-2 py-1 text-[11px] font-medium text-slate-800 z-10">{it.item}</td>
                                                  <td className="px-2 py-1 text-[10px] text-slate-400">{it.uom || '—'}</td>
                                                  {vturnMonths.map(m => {
                                                    const md = it.by_month?.[m];
                                                    return <td key={m} className="text-center px-2 py-1 text-[10px] tabular-nums border-l border-slate-100">
                                                      {md ? <><span className="font-medium text-slate-700">{fmtQty(md.qty)}</span><span className="text-slate-400 text-[9px]"> · {md.qty > 0 ? fmtRup(md.value / md.qty).replace('₹', '') : '—'}</span></> : <span className="text-slate-300">—</span>}
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

            {/* ===== Coming soon (everything else) ===== */}
            {!WIRED.has(activeSection) && <ComingSoon sectionId={activeSection} />}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
