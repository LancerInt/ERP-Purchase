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
  Loader2, X, Calendar, Sparkles,
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
const WIRED = new Set(['top_vend', 'pa_trend', 'pa_item', 'ac_tds']);

// ── Small presentational helpers (slate/indigo) ──────────────────────
function Card({ label, value, sub, color, borderColor }) {
  return (
    <div className={`bg-white border border-slate-200 rounded-lg px-3 py-2.5 ${borderColor ? `border-l-[3px] ${borderColor}` : ''}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`text-lg font-extrabold tabular-nums mt-0.5 ${color || 'text-slate-900'}`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div>}
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

export default function PurchaseWorkspace() {
  const navigate = useNavigate();
  const { company, companies } = useGlobalCompany();

  // ── UI state ──
  const [activeSection, setActiveSection] = useState('top_vend');
  const [profileCollapsed, setProfileCollapsed] = useState(false);
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

  const applyPreset = (p) => { setDateFrom(p.from); setDateTo(p.to); setActivePeriod(p.key); setShowDatePicker(false); };
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
    Promise.all([
      apiClient.get(`/api/purchase/dashboard/?${cp}period=custom&from=${dateFrom}&to=${dateTo}`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/purchase/dashboard/analytics/?${win}`).then(r => r.data?.mom_trend || []).catch(() => []),
      apiClient.get(`/api/purchase/item-rate-trend/?side=purchase&${win}`).then(r => r.data?.items || []).catch(() => []),
      apiClient.get(`/api/purchase/tds-summary/?${cp}fy=${fyParam}`).then(r => r.data).catch(() => null),
    ]).then(([d, t, it, td]) => {
      if (!alive) return;
      setDash(d); setTrend(t || []); setItems(it || []); setTds(td);
    }).finally(() => { if (alive) setLoading(false); });
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

  // ── Purchase trend (bar chart scale) ──
  const trendRows = useMemo(() => (trend || []).map(r => ({
    month: r.month, label: r.label, billed: num(r.billed), paid: num(r.paid),
  })), [trend]);
  const trendMax = useMemo(() => Math.max(1, ...trendRows.flatMap(r => [r.billed, r.paid])), [trendRows]);

  // ── TDS rows ──
  const tdsRows = useMemo(() => (tds?.rows || []).slice(0, 40), [tds]);

  // ── Render ──
  return createPortal(
    <div className="fixed inset-0 z-50 bg-slate-50 flex flex-col text-[13px] leading-relaxed" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* ── Top bar ── */}
      <div className="flex items-center gap-2.5 px-4 py-2 bg-white border-b-2 border-slate-200 flex-shrink-0">
        <button onClick={goBack} className="p-1.5 rounded-lg hover:bg-indigo-50 text-indigo-600 transition"><ChevronLeft size={18} /></button>
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 text-white flex items-center justify-center font-extrabold text-[13px] flex-shrink-0">{initials}</div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-slate-900 truncate">{companyName}</div>
          <div className="text-[10px] text-slate-400 truncate">{[companyGstin && `GSTIN: ${companyGstin}`, 'Purchase workspace'].filter(Boolean).join(' · ')}</div>
        </div>
        <div className="hidden md:flex items-center gap-3.5 text-[11px] text-slate-400">
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
                <div className="flex justify-between"><span className="text-slate-400">GSTIN</span><span className={`font-semibold tabular-nums ${companyGstin ? '' : 'text-slate-300'}`}>{companyGstin || '—'}</span></div>
                {co?.pan && <div className="flex justify-between"><span className="text-slate-400">PAN</span><span className="font-semibold tabular-nums">{co.pan}</span></div>}
                <div className="border-t border-slate-100 my-1.5 pt-1.5"></div>
                <div className="flex justify-between"><span className="text-slate-400">Total Purchase</span><span className="font-semibold text-indigo-600">{fmtINR(totalPurchase)}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Paid</span><span className="font-semibold text-emerald-600">{fmtINR(paid)}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Payable</span><span className="font-semibold text-amber-600">{fmtINR(payable)}</span></div>
                {overdue > 0 && <div className="flex justify-between"><span className="text-slate-400">Overdue</span><span className="font-semibold text-red-600">{fmtINR(overdue)}</span></div>}
                <div className="border-t border-slate-100 my-1.5 pt-1.5"></div>
                <div className="flex justify-between"><span className="text-slate-400">Vendors</span><span className="font-semibold">{vendorCount}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Bills</span><span className="font-semibold">{billCount}</span></div>
              </div>
            </div>
          </div>

          {/* Nav groups */}
          <div className="flex-1 overflow-y-auto p-1.5">
            {NAV_GROUPS.map(g => (
              <div key={g.title} className="mb-0.5">
                <button onClick={() => toggleGroup(g.title)}
                  className="w-full flex items-center gap-1 px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-slate-400 hover:text-indigo-700 hover:bg-indigo-50 rounded transition-colors">
                  <ChevronDown size={10} className={`transition-transform ${expandedGroups[g.title] ? '' : '-rotate-90'}`} />
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
                <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
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
                <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                  <table className="w-full">
                    <thead><tr><TH>Month</TH><TH right>Billed</TH><TH right>Paid</TH><TH right>Unpaid</TH></tr></thead>
                    <tbody>
                      {trendRows.map((r, i) => (
                        <tr key={i} className="hover:bg-slate-50">
                          <TD bold>{r.label}</TD>
                          <TD right>{fmtINR(r.billed)}</TD>
                          <TD right color="text-emerald-600">{fmtINR(r.paid)}</TD>
                          <TD right color={r.billed - r.paid > 0 ? 'text-amber-600' : ''}>{fmtINR(Math.max(0, r.billed - r.paid))}</TD>
                        </tr>
                      ))}
                      {trendRows.length === 0 && <tr><td colSpan={4} className="text-center py-8 text-slate-400 text-sm">No data</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ===== Item Analytics ===== */}
            {!loading && activeSection === 'pa_item' && (
              <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
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

            {/* ===== TDS Summary ===== */}
            {!loading && activeSection === 'ac_tds' && (
              <div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-4">
                  <Card label="ERP TDS (expected)" value={fmtRup(num(tds?.erp_total))} sub={tds?.fy?.label || ''} color="text-indigo-700" borderColor="border-indigo-400" />
                  <Card label="Tally TDS (deducted)" value={fmtRup(num(tds?.tally_total))} color="text-sky-600" borderColor="border-sky-400" />
                  <Card label="Difference" value={fmtRup(num(tds?.difference_total))} sub={`${num(tds?.vendor_count)} vendors`} color={num(tds?.difference_total) > 0 ? 'text-amber-600' : 'text-emerald-600'} borderColor="border-amber-400" />
                </div>
                <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
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

            {/* ===== Coming soon (everything else) ===== */}
            {!WIRED.has(activeSection) && <ComingSoon sectionId={activeSection} />}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
