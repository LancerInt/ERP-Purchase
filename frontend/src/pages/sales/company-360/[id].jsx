/**
 * Company 360 — Detail view.
 *
 * Route: /sales/company-360/:id
 * Sidebar + grouped tabs layout matching Customer 360.
 * Company-wide analytics: receivables, customers, item pivots, collection efficiency.
 */
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ResponsiveContainer, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Legend,
} from 'recharts';
import {
  ChevronLeft, ChevronDown, AlertCircle, AlertTriangle,
  CreditCard, TrendingUp, Package, FileText, DollarSign,
  Shield, RotateCcw, Clock, Users as UsersIcon, Star,
  UserX, UserPlus, Target, BarChart3,
  Loader2, X, Calendar,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import apiClient from '../../../utils/api.js';
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
const fmtQty = (v) => num(v).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const monthLabel = (ym) => {
  const [y, m] = String(ym || '').split('-');
  const mi = parseInt(m, 10) - 1;
  return (MONTH_ABBR[mi] || '?') + " '" + String(y || '').slice(2);
};

// ── Date range presets ─────────────────────────────────────────────
const _today = new Date();
const _isoDate = (d) => d.toISOString().slice(0, 10);
const _fyYear = (d) => d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
const _monthStart = (y, m) => `${y}-${String(m + 1).padStart(2, '0')}-01`;
const _monthEnd = (y, m) => _isoDate(new Date(y, m + 1, 0));

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

// ── Nav groups (matching prototype) ──────────────────────────────────
const NAV_GROUPS = [
  { title: 'Receivables', items: [
    { id: 'recv_week',      label: 'This Week',          icon: AlertCircle },
    { id: 'overdue',        label: 'Overdue Ageing',     icon: AlertTriangle },
    { id: 'upcoming',       label: 'Upcoming',           icon: Clock },
    { id: 'top_debtors',    label: 'Top Debtors',        icon: CreditCard },
  ]},
  { title: 'Customers', items: [
    { id: 'top_customers',  label: 'Top Customers',      icon: Star },
    { id: 'inactive',       label: 'Inactive',           icon: UserX },
    { id: 'new_cust',       label: 'New Customers',      icon: UserPlus },
    { id: 'concentration',  label: 'Concentration',      icon: Target },
  ]},
  { title: 'Sales Analytics', items: [
    { id: 'item_pivot',     label: 'Item Analytics',     icon: Package },
    { id: 'cust_pivot',     label: 'Customer Turnover',  icon: UsersIcon },
    { id: 'item_drill',     label: 'Item Drill-down',    icon: BarChart3 },
    { id: 'trend',          label: 'Sales Trend',        icon: TrendingUp },
  ]},
  { title: 'Accounts', items: [
    { id: 'collection',     label: 'Collection Efficiency', icon: Clock },
    { id: 'cn_dn',          label: 'Credit/Debit Notes', icon: RotateCcw },
    { id: 'gst',            label: 'GST Summary',        icon: DollarSign },
    { id: 'tds',            label: 'TDS Summary',        icon: Shield },
  ]},
];

const SECTION_TITLES = {};
NAV_GROUPS.forEach(g => g.items.forEach(it => { SECTION_TITLES[it.id] = it.label; }));

const tooltipStyle = { fontSize: 12, borderRadius: 8, border: '1px solid #c8e0d0' };

function Pill({ children, color = 'slate' }) {
  const map = {
    green: 'bg-[#d1fae5] text-[#065f46]', red: 'bg-[#fee2e2] text-[#991b1b]',
    amber: 'bg-[#fef3c7] text-[#92400e]', blue: 'bg-[#dbeafe] text-[#2563eb]',
    slate: 'bg-slate-100 text-slate-600',
  };
  return <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${map[color] || map.slate}`}>{children}</span>;
}

function Card({ label, value, sub, color, borderColor }) {
  return (
    <div className={`bg-white border border-[#c8e0d0] rounded-lg px-3 py-2.5 ${borderColor ? `border-l-[3px] ${borderColor}` : ''}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[#7ba68e]">{label}</div>
      <div className={`text-lg font-extrabold tabular-nums mt-0.5 ${color || 'text-[#1a3a2a]'}`}>{value}</div>
      {sub && <div className="text-[10px] text-[#9cb8a8] mt-0.5">{sub}</div>}
    </div>
  );
}

function SectionLabel({ children, color }) {
  return <div className={`text-[10px] font-bold uppercase tracking-wider mb-1.5 ${color || 'text-[#4a7c5c]'}`}>{children}</div>;
}

// ── Table helper ──────────────────────────────────────────────────
function TH({ children, right }) {
  return <th className={`${right ? 'text-right' : 'text-left'} px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-[#4a7c5c] bg-[#e4f2ea] border-b-2 border-[#c8e0d0]`}>{children}</th>;
}
function TD({ children, right, bold, color, clickable }) {
  return <td className={`px-2 py-1.5 border-b border-[#e4f2ea] text-[11px] ${right ? 'text-right tabular-nums' : ''} ${bold ? 'font-semibold' : ''} ${color || ''} ${clickable ? 'text-[#4a7c5c] cursor-pointer hover:underline' : ''}`}>{children}</td>;
}

export default function CompanyDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  // ── State ───────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [company, setCompany] = useState(null);
  const [stats, setStats] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [unpaidRaw, setUnpaidRaw] = useState([]);
  const [dispLines, setDispLines] = useState([]);
  const [momTrend, setMomTrend] = useState([]);
  const [creditNotes, setCreditNotes] = useState([]);
  const [debitNotes, setDebitNotes] = useState([]);
  const [invoices, setInvoices] = useState([]);

  // UI state
  const [activeSection, setActiveSection] = useState('recv_week');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [profileCollapsed, setProfileCollapsed] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState(() => {
    const o = {};
    NAV_GROUPS.forEach(g => { o[g.title] = g.title === 'Receivables'; });
    return o;
  });
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [drillItem, setDrillItem] = useState('');
  const [expandedItem, setExpandedItem] = useState(null);
  const [expandedDrillCust, setExpandedDrillCust] = useState(null);
  const [expandedTurnoverCust, setExpandedTurnoverCust] = useState(null);

  // Date range — default current FY
  const fy = _fyYear(_today);
  const [dateFrom, setDateFrom] = useState(`${fy}-04-01`);
  const [dateTo, setDateTo] = useState(`${fy + 1}-03-31`);
  const [activePeriod, setActivePeriod] = useState('fy');

  const applyPreset = (p) => { setDateFrom(p.from); setDateTo(p.to); setActivePeriod(p.key); setShowDatePicker(false); };
  const toggleGroup = (title) => setExpandedGroups(prev => ({ ...prev, [title]: !prev[title] }));
  const selectSection = (sid) => {
    setActiveSection(sid);
    const group = NAV_GROUPS.find(g => g.items.some(i => i.id === sid));
    if (group && !expandedGroups[group.title]) setExpandedGroups(prev => ({ ...prev, [group.title]: true }));
  };
  const sectionTitle = SECTION_TITLES[activeSection] || activeSection;

  // ── Data fetching ──────────────────────────────────────────────
  useEffect(() => {
    if (!id) return;
    setLoading(true);
    const qs = `company=${id}&period=custom&from=${dateFrom}&to=${dateTo}&basis=turnover`;
    Promise.all([
      apiClient.get(`/api/companies/${id}/`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/sales/dashboard/?${qs}`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/customers/?company=${id}&has_sales=true`).then(r => r.data?.results || r.data || []).catch(() => []),
      apiClient.get(`/api/sales/dashboard/records/?type=receivables_buckets&company=${id}`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/sales/dashboard/records/?type=dispatches&${qs}`).then(r => r.data?.rows || []).catch(() => []),
      apiClient.get(`/api/sales/dashboard/analytics/?${qs}`).then(r => r.data?.mom_trend || []).catch(() => []),
      apiClient.get(`/api/sales/dashboard/records/?type=credit_notes&${qs}`).then(r => r.data?.rows || []).catch(() => []),
      apiClient.get(`/api/sales/dashboard/records/?type=debit_notes&${qs}`).then(r => r.data?.rows || []).catch(() => []),
      apiClient.get(`/api/sales/dashboard/records/?type=invoices&${qs}`).then(r => r.data?.rows || []).catch(() => []),
    ]).then(([comp, dash, custs, bkt, disp, trend, cn, dn, inv]) => {
      setCompany(comp);
      setStats(dash?.stats || null);
      setCustomers((custs || []).map(c => ({
        id: c.id || c.value,
        name: c.customer_name || c.label || c.name || '',
        gstin: c.gstin || '',
        city: (c.billing_address && typeof c.billing_address === 'object' ? c.billing_address.district : '') || c.city || '',
        state: (c.billing_address && typeof c.billing_address === 'object' ? c.billing_address.state : '') || c.state || '',
        outstanding: num(c.total_outstanding || c.outstanding),
        overdue: num(c.total_overdue || c.overdue),
        sales: num(c.total_sales || c.sales || c.turnover),
        credit_terms: c.credit_terms || '',
      })));
      // Receivables buckets: flatten groups[].sub[].rows[] into unpaid rows
      const unpaid = [];
      if (bkt?.groups) {
        for (const g of bkt.groups) {
          for (const sub of (g.sub || [])) {
            if (sub.key !== 'still_open' && sub.key !== 'overdue_unpaid') continue;
            for (const r of (sub.rows || [])) {
              const amt = num(r.amount);
              if (amt <= 0) continue;
              unpaid.push({
                invoice_number: r.invoice_no || '',
                invoice_id: r.invoice_id || '',
                customer_name: r.customer_name || '',
                customer_id: r.customer_id || '',
                date: r.invoice_date || '',
                due_date: r.due_date || '',
                days_late: num(r.days),
                status: sub.key === 'overdue_unpaid' ? 'OVERDUE' : 'OPEN',
                outstanding: amt,
              });
            }
          }
        }
      }
      setUnpaidRaw(unpaid);
      // Dispatch lines: each row has lines[] with {product, qty, amount, uom}
      setDispLines(disp.flatMap(row => (row.lines || []).map(l => ({
        product_name: l.product || '',
        quantity: num(l.qty),
        amount: num(l.amount || 0),
        uom: l.uom || '',
        date: row.date,
        customer: row.customer_name || row.customer || '',
        customer_id: row.customer_id || '',
        invoice_no: row.invoice_no || '',
        invoice_id: row.invoice_id || '',
        dc_number: row.dc_number || '',
        payment_status: row.payment_status || '',
      }))));
      setMomTrend(trend || []);
      setCreditNotes(cn || []);
      setDebitNotes(dn || []);
      setInvoices(inv || []);
    }).finally(() => setLoading(false));
  }, [id, dateFrom, dateTo]);

  const goBack = useCallback(() => window.history.state?.idx > 0 ? navigate(-1) : navigate('/sales/company-360'), [navigate]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') goBack(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goBack]);

  // ── Derived data ──────────────────────────────────────────────
  const rs = stats?.received_against_sales || {};
  const outRec = stats?.outstanding_receivables || {};
  const totalSales = num(rs.incl_gst || stats?.invoices?.amount);
  const outstanding = num(outRec.as_at_total || outRec.total);
  const received = num(stats?.amount_received?.total);
  // Overdue: sum from ageing bands that are past-due, or fall back to unpaid overdue rows
  const overdue = useMemo(() => {
    const ageing = outRec.ageing;
    if (ageing && ageing.length) return ageing.reduce((s, b) => s + num(b.amount), 0);
    return unpaidRaw.filter(r => r.status === 'OVERDUE').reduce((s, r) => s + num(r.outstanding), 0);
  }, [outRec.ageing, unpaidRaw]);
  const invCount = num(stats?.quantity_invoiced?.invoice_count || stats?.invoices?.count);
  const custCount = customers.length;

  // GST data from received_against_sales
  const gstData = useMemo(() => {
    if (!stats) return {};
    const rs2 = stats.received_against_sales || {};
    return {
      taxable: num(rs2.taxable), gst: num(rs2.gst),
      cgst: num(rs2.cgst), sgst: num(rs2.sgst), igst: num(rs2.igst),
      incl_gst: num(rs2.incl_gst),
      debit_notes: num(rs2.debit_notes), credit_notes: num(rs2.credit_notes),
      other_charges: num(rs2.other_charges), round_off: num(rs2.round_off),
    };
  }, [stats]);

  // TDS data from received_against_sales
  const tdsData = useMemo(() => {
    if (!stats) return {};
    const rs2 = stats.received_against_sales || {};
    const invoiceTds = num(rs2.tds);
    const paymentTds = num(rs2.tds_at_payment);
    const noteDebits = num(rs2.tds_note_debits);
    const reversed = num(rs2.tds_reversed);
    return { invoice_tds: invoiceTds, payment_tds: paymentTds, note_debits: noteDebits, reversed, net: invoiceTds + noteDebits + paymentTds - reversed };
  }, [stats]);

  // Overdue / Upcoming from unpaidRaw
  const overdueByBand = useMemo(() => {
    const rows = unpaidRaw.filter(r => r.status === 'OVERDUE');
    const bands = [
      { key: '0_30', label: '0-30 Days', min: 0, max: 30, rows: [], total: 0 },
      { key: '31_60', label: '31-60 Days', min: 31, max: 60, rows: [], total: 0 },
      { key: '61_90', label: '61-90 Days', min: 61, max: 90, rows: [], total: 0 },
      { key: '91_180', label: '91-180 Days', min: 91, max: 180, rows: [], total: 0 },
      { key: '180_plus', label: '180+ Days', min: 181, max: 99999, rows: [], total: 0 },
    ];
    let total = 0, count = 0;
    for (const r of rows) {
      const days = num(r.days_late || r.days);
      const amt = num(r.outstanding || r.balance || r.amount);
      total += amt; count++;
      const band = bands.find(b => days >= b.min && days <= b.max);
      if (band) { band.rows.push(r); band.total += amt; }
    }
    return { bands: bands.filter(b => b.rows.length > 0), total, count };
  }, [unpaidRaw]);

  const upcomingPayments = useMemo(() => {
    const rows = unpaidRaw.filter(r => r.status === 'OPEN');
    const today = new Date();
    const dayEnd = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
    const weekEnd = new Date(today); weekEnd.setDate(today.getDate() + (7 - today.getDay()));
    const nextWeekEnd = new Date(weekEnd); nextWeekEnd.setDate(weekEnd.getDate() + 7);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const buckets = [
      { key: 'this_week', label: 'This Week', rows: [], total: 0, test: d => d <= dayEnd(weekEnd) },
      { key: 'next_week', label: 'Next Week', rows: [], total: 0, test: d => d > dayEnd(weekEnd) && d <= dayEnd(nextWeekEnd) },
      { key: 'this_month', label: 'Rest of Month', rows: [], total: 0, test: d => d > dayEnd(nextWeekEnd) && d <= dayEnd(monthEnd) },
      { key: 'beyond', label: 'Beyond This Month', rows: [], total: 0, test: () => true },
    ];
    let total = 0, count = 0;
    for (const r of rows) {
      const due = new Date(r.due_date);
      const amt = num(r.outstanding || r.balance || r.amount);
      total += amt; count++;
      const bucket = buckets.find(b => b.test(due));
      if (bucket) { bucket.rows.push(r); bucket.total += amt; }
    }
    return { buckets: buckets.filter(b => b.rows.length > 0), total, count };
  }, [unpaidRaw]);

  // This week's receivables (overdue + due within 7 days)
  const recvThisWeek = useMemo(() => {
    const today = new Date();
    const weekEnd = new Date(today); weekEnd.setDate(today.getDate() + 7);
    const all = [];
    for (const r of unpaidRaw) {
      const due = new Date(r.due_date);
      const amt = num(r.outstanding || r.balance || r.amount);
      if (r.status === 'OVERDUE') {
        all.push({ ...r, amt, sortKey: 0, daysLabel: `${num(r.days_late || r.days)}d late`, statusPill: 'OVERDUE', pillColor: 'red' });
      } else if (due <= weekEnd) {
        const diff = Math.ceil((due - today) / 86400000);
        const label = diff <= 0 ? 'Today' : `${diff}d`;
        all.push({ ...r, amt, sortKey: 1, daysLabel: label, statusPill: diff <= 0 ? 'DUE TODAY' : 'DUE SOON', pillColor: diff <= 0 ? 'amber' : 'green' });
      }
    }
    all.sort((a, b) => a.sortKey - b.sortKey || b.amt - a.amt);
    const overdueTotal = all.filter(r => r.sortKey === 0).reduce((s, r) => s + r.amt, 0);
    const dueTotal = all.filter(r => r.sortKey === 1).reduce((s, r) => s + r.amt, 0);
    return { rows: all, overdueTotal, dueTotal, total: overdueTotal + dueTotal };
  }, [unpaidRaw]);

  const topDebtors = useMemo(() => {
    const hasOuts = customers.some(c => c.outstanding > 0);
    if (hasOuts) return [...customers].filter(c => c.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding).slice(0, 20);
    const byName = {};
    for (const r of unpaidRaw) {
      const n = r.customer_name || '';
      if (!n) continue;
      if (!byName[n]) byName[n] = { name: n, id: r.customer_id || '', outstanding: 0, overdue: 0, credit_terms: '' };
      byName[n].outstanding += num(r.outstanding);
      if (r.status === 'OVERDUE') byName[n].overdue += num(r.outstanding);
    }
    return Object.values(byName).filter(c => c.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding).slice(0, 20);
  }, [customers, unpaidRaw]);

  // Top customers by sales
  const topBySales = useMemo(() =>
    [...customers].filter(c => c.sales > 0).sort((a, b) => b.sales - a.sales),
  [customers]);

  // Inactive customers (no invoices in dispLines for last 60+ days)
  const inactiveCustomers = useMemo(() => {
    const custLastDate = {};
    for (const inv of invoices) {
      const name = inv.customer_name || inv.customer || '';
      const d = inv.date || '';
      if (!custLastDate[name] || d > custLastDate[name]) custLastDate[name] = d;
    }
    const today = _isoDate(_today);
    const inactive = [];
    for (const c of customers) {
      const last = custLastDate[c.name];
      if (!last) { inactive.push({ ...c, lastOrder: null, daysInactive: 999, risk: 'HIGH' }); continue; }
      const diff = Math.floor((new Date(today) - new Date(last)) / 86400000);
      if (diff >= 30) {
        inactive.push({ ...c, lastOrder: last, daysInactive: diff, risk: diff >= 90 ? 'HIGH' : diff >= 60 ? 'MEDIUM' : 'LOW' });
      }
    }
    inactive.sort((a, b) => b.daysInactive - a.daysInactive);
    return inactive;
  }, [customers, invoices]);

  // New customers (first invoice this FY)
  const newCustomers = useMemo(() => {
    const custFirstDate = {};
    for (const inv of invoices) {
      const name = inv.customer_name || inv.customer || '';
      const d = inv.date || '';
      if (!custFirstDate[name] || d < custFirstDate[name]) custFirstDate[name] = d;
    }
    const fyStart = dateFrom;
    return customers
      .filter(c => { const first = custFirstDate[c.name]; return first && first >= fyStart; })
      .map(c => ({ ...c, firstOrder: custFirstDate[c.name], orderCount: invoices.filter(inv => (inv.customer_name || inv.customer) === c.name).length }))
      .sort((a, b) => b.sales - a.sales);
  }, [customers, invoices, dateFrom]);

  // Concentration (Pareto)
  const concentration = useMemo(() => {
    const sorted = [...customers].filter(c => c.sales > 0).sort((a, b) => b.sales - a.sales);
    const total = sorted.reduce((s, c) => s + c.sales, 0);
    const tiers = [
      { label: 'Top 5', count: 5 }, { label: '6-10', count: 5 },
      { label: '11-20', count: 10 }, { label: '21-50', count: 30 },
      { label: 'Others', count: 9999 },
    ];
    let idx = 0, cumPct = 0;
    const rows = tiers.map(t => {
      const slice = sorted.slice(idx, idx + t.count);
      idx += t.count;
      const rev = slice.reduce((s, c) => s + c.sales, 0);
      const pct = total > 0 ? (rev / total) * 100 : 0;
      cumPct += pct;
      return { ...t, actual: slice.length, revenue: rev, pct, cumPct: Math.min(cumPct, 100) };
    }).filter(r => r.actual > 0);
    const top5pct = rows[0]?.cumPct || 0;
    const risk = top5pct > 50 ? 'HIGH' : top5pct > 40 ? 'MODERATE' : 'LOW';
    return { rows, total, risk, top5pct };
  }, [customers]);

  const itemAnalytics = useMemo(() => {
    const map = {};
    for (const l of dispLines) {
      const name = l.product_name || l.description || l.item || 'Unknown';
      if (!map[name]) map[name] = { name, qty: 0, value: 0, prices: [], months: {}, uoms: {}, invoiceLines: [] };
      const q = num(l.quantity || l.qty); const v = num(l.amount || l.value || l.total);
      const price = q > 0 ? v / q : 0;
      map[name].qty += q; map[name].value += v;
      if (l.uom) map[name].uoms[l.uom] = (map[name].uoms[l.uom] || 0) + q;
      if (price > 0) map[name].prices.push(price);
      map[name].invoiceLines.push({
        date: l.date, customer: l.customer, customer_id: l.customer_id || '',
        invoice_no: l.invoice_no || '', invoice_id: l.invoice_id || '',
        qty: q, uom: l.uom || '', rate: price, value: v, status: l.payment_status || '',
      });
      const ym = (l.date || '').slice(0, 7);
      if (ym) {
        if (!map[name].months[ym]) map[name].months[ym] = { qty: 0, value: 0 };
        map[name].months[ym].qty += q; map[name].months[ym].value += v;
      }
    }
    const list = Object.values(map).sort((a, b) => b.value - a.value);
    for (const it of list) {
      it.avg = it.prices.length ? it.prices.reduce((s, p) => s + p, 0) / it.prices.length : 0;
      it.min = it.prices.length ? Math.min(...it.prices) : 0;
      it.max = it.prices.length ? Math.max(...it.prices) : 0;
      it.customers = new Set(dispLines.filter(l => (l.product_name || l.description || l.item) === it.name).map(l => l.customer)).size;
      const uomEntries = Object.entries(it.uoms);
      it.uom = uomEntries.length ? uomEntries.sort((a, b) => b[1] - a[1])[0][0] : '';
      it.invoiceLines.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    }
    const allMonths = [...new Set(dispLines.map(l => (l.date || '').slice(0, 7)).filter(Boolean))].sort();
    return { items: list, months: allMonths };
  }, [dispLines]);

  const custItemsMap = useMemo(() => {
    const map = {};
    for (const l of dispLines) {
      const c = l.customer || 'Unknown';
      const p = l.product_name || l.description || l.item || 'Unknown';
      if (!map[c]) map[c] = {};
      if (!map[c][p]) map[c][p] = { name: p, qty: 0, value: 0, uom: '', uoms: {}, months: {} };
      const q = num(l.quantity || l.qty); const v = num(l.amount || l.value || l.total);
      map[c][p].qty += q; map[c][p].value += v;
      if (l.uom) map[c][p].uoms[l.uom] = (map[c][p].uoms[l.uom] || 0) + q;
      const ym = (l.date || '').slice(0, 7);
      if (ym) {
        if (!map[c][p].months[ym]) map[c][p].months[ym] = { qty: 0, value: 0 };
        map[c][p].months[ym].qty += q; map[c][p].months[ym].value += v;
      }
    }
    for (const c of Object.keys(map)) {
      for (const p of Object.keys(map[c])) {
        const ue = Object.entries(map[c][p].uoms);
        map[c][p].uom = ue.length ? ue.sort((a, b) => b[1] - a[1])[0][0] : '';
      }
    }
    return map;
  }, [dispLines]);

  const custTurnover = useMemo(() => {
    const map = {};
    const allMonths = new Set();
    for (const inv of invoices) {
      const name = inv.customer_name || inv.customer || 'Unknown';
      const ym = (inv.date || '').slice(0, 7);
      const amt = num(inv.total || inv.amount || inv.invoice_amount);
      if (!map[name]) map[name] = { name, customer_id: inv.customer_id || '', total: 0, months: {} };
      if (!map[name].customer_id && inv.customer_id) map[name].customer_id = inv.customer_id;
      map[name].total += amt;
      if (ym) {
        allMonths.add(ym);
        map[name].months[ym] = (map[name].months[ym] || 0) + amt;
      }
    }
    const sorted = Object.values(map).sort((a, b) => b.total - a.total).slice(0, 20);
    return { customers: sorted, months: [...allMonths].sort() };
  }, [invoices]);

  // Item drill-down
  const drillData = useMemo(() => {
    if (!drillItem) return null;
    const lines = dispLines.filter(l => (l.product_name || l.description || l.item) === drillItem);
    const custMap = {};
    for (const l of lines) {
      const c = l.customer || 'Unknown';
      if (!custMap[c]) custMap[c] = { name: c, customer_id: l.customer_id || '', qty: 0, value: 0, prices: [], months: {}, uoms: {}, invoiceLines: [] };
      if (!custMap[c].customer_id && l.customer_id) custMap[c].customer_id = l.customer_id;
      const q = num(l.quantity || l.qty); const v = num(l.amount || l.value || l.total);
      const price = q > 0 ? v / q : 0;
      custMap[c].qty += q; custMap[c].value += v;
      if (l.uom) custMap[c].uoms[l.uom] = (custMap[c].uoms[l.uom] || 0) + q;
      if (price > 0) custMap[c].prices.push(price);
      custMap[c].invoiceLines.push({
        date: l.date, invoice_no: l.invoice_no || '', invoice_id: l.invoice_id || '',
        product: l.product_name || '', qty: q, uom: l.uom || '', rate: price, value: v,
        status: l.payment_status || '',
      });
      const ym = (l.date || '').slice(0, 7);
      if (ym) {
        if (!custMap[c].months[ym]) custMap[c].months[ym] = { qty: 0, value: 0 };
        custMap[c].months[ym].qty += q; custMap[c].months[ym].value += v;
      }
    }
    const custs = Object.values(custMap).sort((a, b) => b.value - a.value);
    for (const c of custs) {
      c.avg = c.prices.length ? c.prices.reduce((s, p) => s + p, 0) / c.prices.length : 0;
      const uomEntries = Object.entries(c.uoms);
      c.uom = uomEntries.length ? uomEntries.sort((a, b) => b[1] - a[1])[0][0] : '';
      c.invoiceLines.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    }
    const totalQty = custs.reduce((s, c) => s + c.qty, 0);
    const totalVal = custs.reduce((s, c) => s + c.value, 0);
    const uomSet = {};
    for (const l of lines) { if (l.uom) uomSet[l.uom] = (uomSet[l.uom] || 0) + num(l.quantity); }
    const mainUom = Object.entries(uomSet).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const allMonths = [...new Set(lines.map(l => (l.date || '').slice(0, 7)).filter(Boolean))].sort();
    return { customers: custs, totalQty, totalVal, months: allMonths, uom: mainUom };
  }, [dispLines, drillItem]);

  // Auto-select first item for drill-down
  useEffect(() => {
    if (!drillItem && itemAnalytics.items.length > 0) setDrillItem(itemAnalytics.items[0].name);
  }, [itemAnalytics.items, drillItem]);

  // Collection efficiency
  const collectionEff = useMemo(() => {
    const dso = totalSales > 0 ? Math.round((outstanding / (totalSales / 365))) : 0;
    const collRate = totalSales > 0 ? ((received / totalSales) * 100).toFixed(1) : '0.0';
    const onTimePct = unpaidRaw.length > 0
      ? ((unpaidRaw.filter(r => r.status === 'OPEN').length / unpaidRaw.length) * 100).toFixed(0)
      : '—';
    return { dso, collRate, onTimePct };
  }, [totalSales, outstanding, received, unpaidRaw]);

  // Credit/debit notes
  const cnDnStats = useMemo(() => {
    const cnTotal = creditNotes.reduce((s, r) => s + num(r.total || r.amount || r.invoice_amount), 0);
    const dnTotal = debitNotes.reduce((s, r) => s + num(r.total || r.amount || r.invoice_amount), 0);
    const cnPct = totalSales > 0 ? ((cnTotal / totalSales) * 100).toFixed(1) : '0.0';
    return { cnTotal, dnTotal, net: cnTotal - dnTotal, cnPct, cnCount: creditNotes.length, dnCount: debitNotes.length };
  }, [creditNotes, debitNotes, totalSales]);

  // ── Company profile helpers ────────────────────────────────────
  const co = company || {};
  const addr = co.registered_address && typeof co.registered_address === 'object' ? co.registered_address : {};
  const companyLocation = [addr.district, addr.state].filter(Boolean).join(', ');
  const initials = (co.legal_name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

  // ── Loading / not found ────────────────────────────────────────
  if (loading) {
    return createPortal(
      <div className="fixed inset-0 z-50 bg-[#f0f7f4] flex items-center justify-center">
        <Loader2 size={28} className="animate-spin text-emerald-600 mr-3" />
        <span className="text-sm font-medium text-[#4a7c5c]">Loading Company 360…</span>
      </div>, document.body);
  }
  if (!company) {
    return createPortal(
      <div className="fixed inset-0 z-50 bg-[#f0f7f4] flex flex-col items-center justify-center gap-3">
        <div className="text-slate-400 text-sm">Company not found</div>
        <button onClick={goBack} className="text-emerald-600 text-sm font-medium hover:underline">← Back to list</button>
      </div>, document.body);
  }

  // ── Render ─────────────────────────────────────────────────────
  return createPortal(
    <div className="fixed inset-0 z-50 bg-[#f0f7f4] flex flex-col text-[13px] leading-relaxed" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
      {/* ── Top bar ── */}
      <div className="flex items-center gap-2.5 px-4 py-2 bg-white border-b-2 border-[#c8e0d0] flex-shrink-0">
        <button onClick={goBack} className="p-1.5 rounded-lg hover:bg-[#e4f2ea] text-[#4a7c5c] transition"><ChevronLeft size={18} /></button>
        <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-500 text-white flex items-center justify-center font-extrabold text-[13px] flex-shrink-0">{initials}</div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-[#1a3a2a] truncate">{co.legal_name || co.trade_name || co.company_code}</div>
          <div className="text-[10px] text-[#7ba68e] truncate">{[co.gstin && `GSTIN: ${co.gstin}`, companyLocation].filter(Boolean).join(' · ')}</div>
        </div>
        <div className="hidden md:flex items-center gap-3.5 text-[11px] text-slate-400">
          <span>Sales <b className="ml-1 text-emerald-600">{fmtINR(totalSales)}</b></span>
          <span>Received <b className="ml-1 text-sky-600">{fmtINR(received)}</b></span>
          <span>Outstanding <b className="ml-1 text-amber-600">{fmtINR(outstanding)}</b></span>
          {overdue > 0 && <span>Overdue <b className="ml-1 text-red-600">{fmtINR(overdue)}</b></span>}
        </div>
        <button onClick={goBack} className="p-1.5 rounded-lg hover:bg-[#e4f2ea] text-slate-400 hover:text-slate-600 transition ml-2"><X size={16} /></button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* ── Sidebar ── */}
        <div className={`flex-shrink-0 bg-white border-r-2 border-[#c8e0d0] flex flex-col transition-all duration-200 overflow-hidden ${sidebarCollapsed ? 'w-[52px]' : 'w-[250px]'}`}
          onMouseEnter={() => sidebarCollapsed && setSidebarCollapsed(false)}
        >
          {/* Company profile */}
          <div className="p-3 border-b border-[#e4f2ea] flex-shrink-0">
            <button onClick={() => setProfileCollapsed(!profileCollapsed)}
              className="w-full flex items-center justify-between text-[10px] font-semibold text-emerald-600">
              <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> Company Profile</span>
              <ChevronDown size={10} className={`text-slate-400 transition-transform ${profileCollapsed ? '-rotate-90' : ''}`} />
            </button>
            <div className={`overflow-hidden transition-all duration-200 ${profileCollapsed || sidebarCollapsed ? 'max-h-0 opacity-0' : 'max-h-[500px] opacity-100 mt-2'}`}>
              <div className="space-y-1 text-[11px]">
                <div className="flex justify-between"><span className="text-[#7ba68e]">GSTIN</span><span className={`font-semibold tabular-nums ${co.gstin ? '' : 'text-slate-300'}`}>{co.gstin || '—'}</span></div>
                {co.pan && <div className="flex justify-between"><span className="text-[#7ba68e]">PAN</span><span className="font-semibold tabular-nums">{co.pan}</span></div>}
                {co.cin && <div className="flex justify-between"><span className="text-[#7ba68e]">CIN</span><span className="font-semibold tabular-nums">{co.cin}</span></div>}
                <div className="border-t border-[#e4f2ea] my-1.5 pt-1.5"></div>
                <div className="flex justify-between"><span className="text-[#7ba68e]">Total Sales</span><span className="font-semibold text-emerald-600">{fmtINR(totalSales)}</span></div>
                <div className="flex justify-between"><span className="text-[#7ba68e]">Outstanding</span><span className="font-semibold text-amber-600">{fmtINR(outstanding)}</span></div>
                <div className="flex justify-between"><span className="text-[#7ba68e]">Received</span><span className="font-semibold text-sky-600">{fmtINR(received)}</span></div>
                {overdue > 0 && <div className="flex justify-between"><span className="text-[#7ba68e]">Overdue</span><span className="font-semibold text-red-600">{fmtINR(overdue)}</span></div>}
                <div className="flex justify-between"><span className="text-[#7ba68e]">Customers</span><span className="font-semibold">{custCount}</span></div>
                <div className="flex justify-between"><span className="text-[#7ba68e]">Invoices</span><span className="font-semibold">{invCount}</span></div>
                <div className="border-t border-[#e4f2ea] my-1.5 pt-1.5"></div>
                {co.contact_email && <div className="flex justify-between"><span className="text-[#7ba68e]">Email</span><span className="font-semibold truncate ml-2 text-[10px]">{co.contact_email}</span></div>}
                {co.contact_phone && <div className="flex justify-between"><span className="text-[#7ba68e]">Phone</span><span className="font-semibold">{co.contact_phone}</span></div>}
                {companyLocation && <div className="flex justify-between"><span className="text-[#7ba68e]">Location</span><span className="font-semibold">{companyLocation}</span></div>}
              </div>
            </div>
          </div>

          {/* Nav groups */}
          <div className="flex-1 overflow-y-auto p-1.5">
            {NAV_GROUPS.map(g => (
              <div key={g.title} className="mb-0.5">
                <button onClick={() => toggleGroup(g.title)}
                  className="w-full flex items-center gap-1 px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-[#7ba68e] hover:text-[#4a7c5c] hover:bg-[#e4f2ea] rounded transition-colors">
                  <ChevronDown size={10} className={`transition-transform ${expandedGroups[g.title] ? '' : '-rotate-90'}`} />
                  {!sidebarCollapsed && <span>{g.title}</span>}
                </button>
                {(expandedGroups[g.title] || sidebarCollapsed) && g.items.map(item => {
                  const Icon = item.icon;
                  const isActive = activeSection === item.id;
                  return (
                    <button key={item.id} onClick={() => selectSection(item.id)}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors ${isActive ? 'bg-[#d1fae5] text-[#065f46] font-semibold border-l-2 border-[#16a34a]' : 'text-[#4a7c5c] hover:bg-[#e4f2ea] hover:text-[#1a3a2a]'}`}>
                      <Icon size={14} className="flex-shrink-0" />
                      {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* ── Main content ── */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="px-5 py-2.5 bg-white border-b border-[#c8e0d0] flex items-center justify-between gap-3 flex-shrink-0">
            <h2 className="text-base font-bold text-[#1a3a2a] shrink-0">{sectionTitle}</h2>
            <div className="relative flex items-center gap-1.5" data-datepicker>
              {DATE_PRESETS.filter(p => p.key === 'fy' || p.key === 'pfy').map(p => (
                <button key={p.key} type="button" onClick={() => applyPreset(p)}
                  className={`px-2 py-1 rounded text-[10px] font-semibold border transition whitespace-nowrap ${activePeriod === p.key ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-[#4a7c5c] border-[#c8e0d0] hover:border-emerald-400'}`}>
                  {p.label}
                </button>
              ))}
              {DATE_PRESETS.filter(p => p.key === 'cm').map(p => (
                <button key={p.key} type="button" onClick={() => applyPreset(p)}
                  className={`px-2 py-1 rounded text-[10px] font-semibold border transition whitespace-nowrap ${activePeriod === p.key ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-[#4a7c5c] border-[#c8e0d0] hover:border-emerald-400'}`}>
                  {p.label}
                </button>
              ))}
              <button type="button" onClick={() => setShowDatePicker(v => !v)}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold border transition whitespace-nowrap ${activePeriod === 'custom' || showDatePicker ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-[#4a7c5c] border-[#c8e0d0] hover:border-emerald-400'}`}>
                <Calendar size={11} /> {activePeriod === 'custom' ? `${fmtDate(dateFrom)} — ${fmtDate(dateTo)}` : 'More'}
              </button>
              {showDatePicker && (
                <div className="absolute right-0 top-full mt-1 z-30 bg-white rounded-lg border border-[#c8e0d0] shadow-lg p-3 w-[340px]">
                  <div className="text-[9px] font-semibold text-[#4a7c5c] uppercase tracking-wide mb-1.5">Month</div>
                  <div className="flex flex-wrap gap-1 mb-3">
                    {DATE_PRESETS.filter(p => p.key === 'cm' || p.key.startsWith('m')).map(p => (
                      <button key={p.key} type="button" onClick={() => applyPreset(p)}
                        className={`px-2 py-1 rounded text-[10px] font-medium border transition ${activePeriod === p.key ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-[#f0f7f4] text-[#4a7c5c] border-[#e4f2ea] hover:border-emerald-300'}`}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="text-[9px] font-semibold text-[#4a7c5c] uppercase tracking-wide mb-1.5">Quarter</div>
                  <div className="flex flex-wrap gap-1 mb-3">
                    {DATE_PRESETS.filter(p => p.key.startsWith('q')).map(p => (
                      <button key={p.key} type="button" onClick={() => applyPreset(p)}
                        className={`px-2 py-1 rounded text-[10px] font-medium border transition ${activePeriod === p.key ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-[#f0f7f4] text-[#4a7c5c] border-[#e4f2ea] hover:border-emerald-300'}`}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="text-[9px] font-semibold text-[#4a7c5c] uppercase tracking-wide mb-1.5">Custom Range</div>
                  <div className="flex items-center gap-2">
                    <input type="date" defaultValue={dateFrom} onChange={e => { setDateFrom(e.target.value); setActivePeriod('custom'); }}
                      className="border border-[#c8e0d0] rounded px-2 py-1 text-xs flex-1" />
                    <span className="text-xs text-slate-400">to</span>
                    <input type="date" defaultValue={dateTo} onChange={e => { setDateTo(e.target.value); setActivePeriod('custom'); }}
                      className="border border-[#c8e0d0] rounded px-2 py-1 text-xs flex-1" />
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {/* ===== Receivables This Week ===== */}
            {activeSection === 'recv_week' && (
              <div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                  <Card label="Total Due This Week" value={fmtINR(recvThisWeek.total)} sub={`${recvThisWeek.rows.length} invoices`} color="text-amber-600" />
                  <Card label="Already Overdue" value={fmtINR(recvThisWeek.overdueTotal)} sub={`${recvThisWeek.rows.filter(r => r.sortKey === 0).length} past due`} color="text-red-600" />
                  <Card label="Due This Week" value={fmtINR(recvThisWeek.dueTotal)} sub={`${recvThisWeek.rows.filter(r => r.sortKey === 1).length} invoices`} color="text-emerald-600" />
                  <Card label="Customers" value={new Set(recvThisWeek.rows.map(r => r.customer_name || r.customer)).size} sub="affected" />
                </div>
                <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-hidden">
                  <table className="w-full">
                    <thead><tr><TH>Customer</TH><TH>Invoice</TH><TH>Due Date</TH><TH right>Days</TH><TH>Status</TH><TH right>Outstanding</TH></tr></thead>
                    <tbody>
                      {recvThisWeek.rows.slice(0, 50).map((r, i) => (
                        <tr key={i} className="hover:bg-[#e4f2ea]">
                          <TD bold clickable onClick={() => navigate(`/sales/customer-360/${r.customer_id}`)}>{r.customer_name || r.customer}</TD>
                          <TD>{r.invoice_number || r.voucher_number || r.ref}</TD>
                          <TD>{fmtDate(r.due_date)}</TD>
                          <TD right color={r.sortKey === 0 ? 'text-red-600' : 'text-emerald-600'}>{r.daysLabel}</TD>
                          <TD><Pill color={r.pillColor}>{r.statusPill}</Pill></TD>
                          <TD right bold color={r.sortKey === 0 ? 'text-red-600' : ''}>{fmtRup(r.amt)}</TD>
                        </tr>
                      ))}
                      {recvThisWeek.rows.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-slate-400 text-sm">No receivables this week</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ===== Overdue Ageing ===== */}
            {activeSection === 'overdue' && (
              <div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-4">
                  <Card label="Total Overdue" value={fmtINR(overdueByBand.total)} sub={`${overdueByBand.count} invoices`} color="text-red-600" />
                  <Card label="Bands" value={overdueByBand.bands.length} sub="active ageing bands" />
                  <Card label="Customers" value={new Set(unpaidRaw.filter(r => r.status === 'OVERDUE').map(r => r.customer_name || r.customer)).size} sub="with overdue" color="text-red-600" />
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
                  {overdueByBand.bands.map(b => (
                    <div key={b.key} className="bg-white rounded-lg border border-[#fecaca] p-2.5 text-center">
                      <div className="text-[9px] font-bold uppercase tracking-wider text-red-700">{b.label}</div>
                      <div className="text-base font-extrabold text-red-600 tabular-nums mt-0.5">{fmtINR(b.total)}</div>
                      <div className="text-[10px] text-red-400">{b.rows.length} inv</div>
                    </div>
                  ))}
                </div>
                <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-hidden">
                  <table className="w-full">
                    <thead><tr><TH>Customer</TH><TH>Invoice</TH><TH>Due Date</TH><TH right>Days Late</TH><TH>Band</TH><TH right>Outstanding</TH></tr></thead>
                    <tbody>
                      {overdueByBand.bands.flatMap(b => b.rows).sort((a, b) => num(b.days_late || b.days) - num(a.days_late || a.days)).slice(0, 50).map((r, i) => {
                        const days = num(r.days_late || r.days);
                        const bandLabel = days > 180 ? '180+' : days > 90 ? '91-180' : days > 60 ? '61-90' : days > 30 ? '31-60' : '0-30';
                        return (
                          <tr key={i} className="hover:bg-[#e4f2ea]">
                            <TD bold clickable>{r.customer_name || r.customer}</TD>
                            <TD>{r.invoice_number || r.voucher_number || r.ref}</TD>
                            <TD>{fmtDate(r.due_date)}</TD>
                            <TD right color="text-red-600">{days}d</TD>
                            <TD><Pill color="red">{bandLabel}</Pill></TD>
                            <TD right bold color="text-red-600">{fmtRup(num(r.outstanding || r.balance || r.amount))}</TD>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ===== Upcoming Payments ===== */}
            {activeSection === 'upcoming' && (
              <div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                  <Card label="Within Terms" value={fmtINR(upcomingPayments.total)} sub={`${upcomingPayments.count} invoices`} color="text-emerald-600" />
                  {upcomingPayments.buckets.map(b => (
                    <Card key={b.key} label={b.label} value={fmtINR(b.total)} sub={`${b.rows.length} invoices`} color="text-sky-600" />
                  ))}
                </div>
                <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-hidden">
                  <table className="w-full">
                    <thead><tr><TH>Customer</TH><TH>Invoice</TH><TH>Due Date</TH><TH right>Days to Due</TH><TH right>Amount</TH></tr></thead>
                    <tbody>
                      {upcomingPayments.buckets.flatMap(b => b.rows).slice(0, 50).map((r, i) => {
                        const diff = Math.ceil((new Date(r.due_date) - new Date()) / 86400000);
                        return (
                          <tr key={i} className="hover:bg-[#e4f2ea]">
                            <TD bold clickable>{r.customer_name || r.customer}</TD>
                            <TD>{r.invoice_number || r.voucher_number || r.ref}</TD>
                            <TD>{fmtDate(r.due_date)}</TD>
                            <TD right color="text-emerald-600">{diff}d</TD>
                            <TD right bold>{fmtRup(num(r.outstanding || r.balance || r.amount))}</TD>
                          </tr>
                        );
                      })}
                      {upcomingPayments.count === 0 && <tr><td colSpan={5} className="text-center py-8 text-slate-400 text-sm">No upcoming payments</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ===== Top Debtors ===== */}
            {activeSection === 'top_debtors' && (
              <div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-4">
                  <Card label="Total Outstanding" value={fmtINR(outstanding)} sub={`${topDebtors.length} customers`} color="text-amber-600" />
                  <Card label="Total Overdue" value={fmtINR(overdue)} color="text-red-600" />
                  <Card label="Collection Rate" value={`${collectionEff.collRate}%`} sub="Received / Sales" color="text-emerald-600" />
                </div>
                <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-hidden">
                  <table className="w-full">
                    <thead><tr><TH>Customer</TH><TH right>Outstanding</TH><TH right>Overdue</TH><TH right>% of Total</TH></tr></thead>
                    <tbody>
                      {topDebtors.map((c, i) => (
                        <tr key={i} className="hover:bg-[#e4f2ea]">
                          <TD bold clickable onClick={() => navigate(`/sales/customer-360/${c.id}`)}>{c.name}</TD>
                          <TD right bold color="text-amber-600">{fmtINR(c.outstanding)}</TD>
                          <TD right color={c.overdue > 0 ? 'text-red-600' : 'text-slate-300'}>{c.overdue > 0 ? fmtINR(c.overdue) : '—'}</TD>
                          <TD right>{outstanding > 0 ? ((c.outstanding / outstanding) * 100).toFixed(1) + '%' : '—'}</TD>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ===== Top Customers (by sales) ===== */}
            {activeSection === 'top_customers' && (
              <div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                  <Card label="Total Customers" value={custCount} sub="With sales this period" color="text-[#4a7c5c]" />
                  <Card label="Top 10 Revenue" value={fmtINR(topBySales.slice(0, 10).reduce((s, c) => s + c.sales, 0))} sub={totalSales > 0 ? `${((topBySales.slice(0, 10).reduce((s, c) => s + c.sales, 0) / totalSales) * 100).toFixed(0)}% of total` : ''} color="text-emerald-600" />
                  <Card label="Avg Per Customer" value={custCount > 0 ? fmtINR(totalSales / custCount) : '—'} color="text-sky-600" />
                  <Card label="Repeat Rate" value={`${custCount > 0 ? Math.round((customers.filter(c => c.sales > 0).length / custCount) * 100) : 0}%`} sub="Ordered in period" color="text-emerald-600" />
                </div>
                <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-hidden">
                  <table className="w-full">
                    <thead><tr><TH>#</TH><TH>Customer</TH><TH>Location</TH><TH right>Total Sales</TH><TH right>Outstanding</TH><TH right>% Share</TH></tr></thead>
                    <tbody>
                      {topBySales.slice(0, 25).map((c, i) => (
                        <tr key={i} className="hover:bg-[#e4f2ea]">
                          <TD color="text-slate-400">{i + 1}</TD>
                          <TD bold clickable onClick={() => navigate(`/sales/customer-360/${c.id}`)}>{c.name}</TD>
                          <TD color="text-slate-500">{[c.city, c.state].filter(Boolean).join(', ') || '—'}</TD>
                          <TD right bold color="text-emerald-600">{fmtINR(c.sales)}</TD>
                          <TD right color={c.outstanding > 0 ? 'text-amber-600' : 'text-slate-300'}>{c.outstanding > 0 ? fmtINR(c.outstanding) : '—'}</TD>
                          <TD right>{totalSales > 0 ? ((c.sales / totalSales) * 100).toFixed(1) + '%' : '—'}</TD>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ===== Inactive Customers ===== */}
            {activeSection === 'inactive' && (
              <div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                  <Card label="90+ Days Inactive" value={inactiveCustomers.filter(c => c.daysInactive >= 90).length} sub="No orders in 3+ months" color="text-red-600" borderColor="border-l-red-500" />
                  <Card label="60-90 Days" value={inactiveCustomers.filter(c => c.daysInactive >= 60 && c.daysInactive < 90).length} sub="Slowing down" color="text-amber-600" borderColor="border-l-amber-500" />
                  <Card label="30-60 Days" value={inactiveCustomers.filter(c => c.daysInactive >= 30 && c.daysInactive < 60).length} sub="Monitor" color="text-sky-600" borderColor="border-l-sky-500" />
                  <Card label="Lost Revenue" value={fmtINR(inactiveCustomers.reduce((s, c) => s + c.sales, 0))} sub="Previous sales from inactive" color="text-red-600" />
                </div>
                {inactiveCustomers.filter(c => c.daysInactive >= 90).length > 0 && (
                  <>
                    <SectionLabel color="text-red-600">90+ Days — No Recent Orders</SectionLabel>
                    <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-hidden mb-4">
                      <table className="w-full">
                        <thead><tr><TH>Customer</TH><TH>Location</TH><TH>Last Order</TH><TH right>Days Inactive</TH><TH right>Sales</TH><TH right>Outstanding</TH><TH>Risk</TH></tr></thead>
                        <tbody>
                          {inactiveCustomers.filter(c => c.daysInactive >= 90).map((c, i) => (
                            <tr key={i} className="hover:bg-[#e4f2ea]">
                              <TD bold clickable onClick={() => navigate(`/sales/customer-360/${c.id}`)}>{c.name}</TD>
                              <TD color="text-slate-500">{[c.city, c.state].filter(Boolean).join(', ') || '—'}</TD>
                              <TD>{fmtDate(c.lastOrder)}</TD>
                              <TD right color="text-red-600">{c.daysInactive}d</TD>
                              <TD right>{fmtINR(c.sales)}</TD>
                              <TD right color={c.outstanding > 0 ? 'text-red-600' : 'text-slate-300'}>{c.outstanding > 0 ? fmtINR(c.outstanding) : '—'}</TD>
                              <TD><Pill color="red">HIGH</Pill></TD>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
                {inactiveCustomers.filter(c => c.daysInactive >= 60 && c.daysInactive < 90).length > 0 && (
                  <>
                    <SectionLabel color="text-amber-600">60-90 Days — Slowing Down</SectionLabel>
                    <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-hidden mb-4">
                      <table className="w-full">
                        <thead><tr><TH>Customer</TH><TH>Location</TH><TH>Last Order</TH><TH right>Days Inactive</TH><TH right>Sales</TH><TH>Risk</TH></tr></thead>
                        <tbody>
                          {inactiveCustomers.filter(c => c.daysInactive >= 60 && c.daysInactive < 90).map((c, i) => (
                            <tr key={i} className="hover:bg-[#e4f2ea]">
                              <TD bold clickable>{c.name}</TD>
                              <TD color="text-slate-500">{[c.city, c.state].filter(Boolean).join(', ') || '—'}</TD>
                              <TD>{fmtDate(c.lastOrder)}</TD>
                              <TD right color="text-amber-600">{c.daysInactive}d</TD>
                              <TD right>{fmtINR(c.sales)}</TD>
                              <TD><Pill color="amber">MEDIUM</Pill></TD>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
                {inactiveCustomers.length === 0 && <div className="text-center py-12 text-slate-400 text-sm">All customers are active</div>}
              </div>
            )}

            {/* ===== New Customers ===== */}
            {activeSection === 'new_cust' && (
              <div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                  <Card label="New This Period" value={newCustomers.length} sub="First order in this period" color="text-emerald-600" />
                  <Card label="Revenue from New" value={fmtINR(newCustomers.reduce((s, c) => s + c.sales, 0))} sub={totalSales > 0 ? `${((newCustomers.reduce((s, c) => s + c.sales, 0) / totalSales) * 100).toFixed(1)}% of total` : ''} color="text-emerald-600" />
                  <Card label="Avg First-Period Sales" value={newCustomers.length > 0 ? fmtINR(newCustomers.reduce((s, c) => s + c.sales, 0) / newCustomers.length) : '—'} color="text-sky-600" />
                  <Card label="Multi-Order" value={`${newCustomers.length > 0 ? Math.round((newCustomers.filter(c => c.orderCount > 1).length / newCustomers.length) * 100) : 0}%`} sub={`${newCustomers.filter(c => c.orderCount > 1).length} of ${newCustomers.length} reordered`} color="text-emerald-600" />
                </div>
                <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-hidden">
                  <table className="w-full">
                    <thead><tr><TH>Customer</TH><TH>Location</TH><TH>First Order</TH><TH right>Orders</TH><TH right>Total Sales</TH><TH>Status</TH></tr></thead>
                    <tbody>
                      {newCustomers.map((c, i) => (
                        <tr key={i} className="hover:bg-[#e4f2ea]">
                          <TD bold clickable onClick={() => navigate(`/sales/customer-360/${c.id}`)}>{c.name}</TD>
                          <TD color="text-slate-500">{[c.city, c.state].filter(Boolean).join(', ') || '—'}</TD>
                          <TD>{fmtDate(c.firstOrder)}</TD>
                          <TD right>{c.orderCount}</TD>
                          <TD right bold color="text-emerald-600">{fmtINR(c.sales)}</TD>
                          <TD><Pill color={c.orderCount > 1 ? 'green' : 'amber'}>{c.orderCount > 1 ? 'ACTIVE' : '1 ORDER'}</Pill></TD>
                        </tr>
                      ))}
                      {newCustomers.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-slate-400 text-sm">No new customers in this period</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ===== Customer Concentration ===== */}
            {activeSection === 'concentration' && (
              <div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                  <Card label="Top 5 Customers" value={`${concentration.rows[0]?.pct.toFixed(0) || 0}%`} sub="of total revenue" color="text-red-600" borderColor="border-l-red-500" />
                  <Card label="Top 10 Customers" value={`${(concentration.rows.slice(0, 2).reduce((s, r) => s + r.pct, 0)).toFixed(0)}%`} sub="of total revenue" color="text-amber-600" borderColor="border-l-amber-500" />
                  <Card label="Top 20 Customers" value={`${(concentration.rows.slice(0, 3).reduce((s, r) => s + r.pct, 0)).toFixed(0)}%`} sub="of total revenue" color="text-emerald-600" borderColor="border-l-emerald-500" />
                  <Card label="Risk Level" value={concentration.risk} sub={`Top 5 > 40% = concentrated`} color={concentration.risk === 'HIGH' ? 'text-red-600' : concentration.risk === 'MODERATE' ? 'text-amber-600' : 'text-emerald-600'} />
                </div>
                <SectionLabel>Revenue Concentration</SectionLabel>
                <div className="mb-4 space-y-1.5">
                  {concentration.rows.map((r, i) => {
                    const colors = ['from-red-500 to-red-400', 'from-amber-500 to-amber-400', 'from-sky-500 to-sky-400', 'from-emerald-500 to-emerald-400', 'from-slate-400 to-slate-300'];
                    return (
                      <div key={i} className="flex items-center gap-2">
                        <div className="w-28 text-right text-[10px] font-semibold text-[#7ba68e]">{r.label} ({r.actual})</div>
                        <div className="flex-1 h-5 bg-[#e4f2ea] rounded overflow-hidden">
                          <div className={`h-full bg-gradient-to-r ${colors[i] || colors[4]} rounded flex items-center justify-center text-[9px] font-bold text-white`}
                            style={{ width: `${Math.max(r.pct, 5)}%` }}>
                            {fmtINR(r.revenue)} ({r.pct.toFixed(0)}%)
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-hidden">
                  <table className="w-full">
                    <thead><tr><TH>Tier</TH><TH right>Customers</TH><TH right>Revenue</TH><TH right>% of Total</TH><TH right>Cumulative %</TH><TH right>Avg / Customer</TH></tr></thead>
                    <tbody>
                      {concentration.rows.map((r, i) => {
                        const colors = ['text-red-600', 'text-amber-600', 'text-sky-600', 'text-emerald-600', 'text-slate-500'];
                        return (
                          <tr key={i} className="hover:bg-[#e4f2ea]">
                            <TD bold color={colors[i]}>{r.label}</TD>
                            <TD right>{r.actual}</TD>
                            <TD right bold>{fmtINR(r.revenue)}</TD>
                            <TD right>{r.pct.toFixed(1)}%</TD>
                            <TD right bold>{r.cumPct.toFixed(1)}%</TD>
                            <TD right>{r.actual > 0 ? fmtINR(r.revenue / r.actual) : '—'}</TD>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ===== Item Analytics ===== */}
            {activeSection === 'item_pivot' && (
              <div>
                <SectionLabel>Product Summary <span className="text-[8px] font-normal normal-case text-slate-400 ml-1">(click product to see invoices)</span></SectionLabel>
                <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-hidden mb-4">
                  <table className="w-full">
                    <thead><tr><TH>Product</TH><TH>UOM</TH><TH right>Qty</TH><TH right>Avg Price</TH><TH right>Min</TH><TH right>Max</TH><TH right>Customers</TH><TH right>Total Value</TH></tr></thead>
                    <tbody>
                      {itemAnalytics.items.slice(0, 30).map((it, i) => {
                        const isExpanded = expandedItem === it.name;
                        return (
                          <React.Fragment key={i}>
                            <tr className={`hover:bg-[#e4f2ea] cursor-pointer ${isExpanded ? 'bg-[#e4f2ea]' : ''}`}
                              onClick={() => setExpandedItem(isExpanded ? null : it.name)}>
                              <TD bold>
                                <span className="flex items-center gap-1">
                                  <ChevronDown size={12} className={`text-[#4a7c5c] transition-transform ${isExpanded ? '' : '-rotate-90'}`} />
                                  <span className="text-[#4a7c5c] hover:underline">{it.name}</span>
                                </span>
                              </TD>
                              <TD><Pill color="slate">{it.uom || '—'}</Pill></TD>
                              <TD right>{fmtQty(it.qty)}</TD>
                              <TD right>{fmtRup(it.avg)}</TD>
                              <TD right color="text-emerald-600">{fmtRup(it.min)}</TD>
                              <TD right color="text-red-600">{fmtRup(it.max)}</TD>
                              <TD right>{it.customers}</TD>
                              <TD right bold>{fmtINR(it.value)}</TD>
                            </tr>
                            {isExpanded && (
                              <tr><td colSpan={8} className="p-0">
                                <div className="bg-[#f0f9f4] border-t border-b border-[#c8e0d0] overflow-x-auto">
                                  <table className="w-full">
                                    <thead><tr className="bg-[#e4f2ea]/60">
                                      <th className="text-left px-3 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c]">Month</th>
                                      <th className="text-left px-3 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c]">Customer</th>
                                      <th className="text-left px-3 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c]">Invoice #</th>
                                      <th className="text-left px-3 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c]">Date</th>
                                      <th className="text-right px-3 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c]">Qty</th>
                                      <th className="text-left px-3 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c]">UOM</th>
                                      <th className="text-right px-3 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c]">Rate/{it.uom || 'Unit'}</th>
                                      <th className="text-right px-3 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c]">Taxable Value</th>
                                      <th className="text-left px-3 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c]">Status</th>
                                    </tr></thead>
                                    <tbody>
                                      {it.invoiceLines.map((ln, li) => (
                                        <tr key={li} className="hover:bg-white/60 border-b border-[#e4f2ea]">
                                          <td className="px-3 py-1 text-[10px] font-semibold text-[#4a7c5c]">{monthLabel((ln.date || '').slice(0, 7))}</td>
                                          <td className="px-3 py-1 text-[11px]">{ln.customer || '—'}</td>
                                          <td className="px-3 py-1 text-[11px]">
                                            {ln.invoice_id ? (
                                              <button type="button" onClick={(e) => { e.stopPropagation(); navigate(`/sales/invoices/${ln.invoice_id}`); }}
                                                className="text-[#4a7c5c] font-semibold underline decoration-dotted underline-offset-2 hover:text-emerald-700 cursor-pointer">
                                                {ln.invoice_no || '—'}
                                              </button>
                                            ) : <span className="text-slate-400">{ln.invoice_no || '—'}</span>}
                                          </td>
                                          <td className="px-3 py-1 text-[11px] text-slate-500">{fmtDate(ln.date)}</td>
                                          <td className="px-3 py-1 text-[11px] text-right tabular-nums">{fmtQty(ln.qty)}</td>
                                          <td className="px-3 py-1 text-[11px] text-slate-500">{ln.uom || '—'}</td>
                                          <td className="px-3 py-1 text-[11px] text-right tabular-nums">{fmtRup(ln.rate)}</td>
                                          <td className="px-3 py-1 text-[11px] text-right tabular-nums font-semibold">{fmtINR(ln.value)}</td>
                                          <td className="px-3 py-1 text-[11px]">{ln.status ? <Pill color={ln.status === 'PAID' ? 'green' : ln.status === 'OVERDUE' ? 'red' : 'amber'}>{ln.status}</Pill> : <span className="text-slate-300">—</span>}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </td></tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                      {itemAnalytics.items.length === 0 && <tr><td colSpan={8} className="text-center py-8 text-slate-400 text-sm">No dispatch data</td></tr>}
                    </tbody>
                  </table>
                </div>
                {itemAnalytics.months.length > 0 && (
                  <>
                    <SectionLabel>Month-wise Breakdown (Qty · Avg ₹)</SectionLabel>
                    <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-x-auto">
                      <table className="min-w-[700px] w-full">
                        <thead><tr>
                          <th className="sticky left-0 bg-[#e4f2ea] text-left px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-[#4a7c5c] border-b-2 border-[#c8e0d0] z-10">Product</th>
                          <th className="bg-[#e4f2ea] text-left px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-[#4a7c5c] border-b-2 border-[#c8e0d0] border-l border-[#c8e0d0]">UOM</th>
                          {itemAnalytics.months.map(m => <th key={m} className="text-center px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-[#4a7c5c] bg-[#e4f2ea] border-b-2 border-[#c8e0d0] border-l border-[#c8e0d0] min-w-[80px]">{monthLabel(m)}</th>)}
                        </tr></thead>
                        <tbody>
                          {itemAnalytics.items.slice(0, 15).map((it, i) => (
                            <tr key={i} className="hover:bg-[#e4f2ea]">
                              <td className="sticky left-0 bg-white px-2 py-1 text-[11px] font-semibold border-b border-[#e4f2ea] z-10">{it.name}</td>
                              <td className="px-2 py-1 text-[10px] text-slate-500 border-b border-[#e4f2ea] border-l border-[#e4f2ea]">{it.uom || '—'}</td>
                              {itemAnalytics.months.map(m => {
                                const md = it.months[m];
                                return <td key={m} className="text-right px-2 py-1 text-[10px] tabular-nums border-b border-[#e4f2ea] border-l border-[#e4f2ea]">
                                  {md ? `${fmtQty(md.qty)} · ${md.qty > 0 ? fmtRup(md.value / md.qty).replace('₹', '') : '—'}` : '—'}
                                </td>;
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ===== Customer Turnover Pivot ===== */}
            {activeSection === 'cust_pivot' && (
              <div>
                {/* Product contribution to turnover */}
                {itemAnalytics.items.length > 0 && (() => {
                  const totalVal = itemAnalytics.items.reduce((s, it) => s + it.value, 0);
                  const top10 = itemAnalytics.items.slice(0, 10);
                  return (
                    <>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                        <Card label="Total Turnover" value={fmtINR(totalVal)} color="text-emerald-600" />
                        <Card label="Products Sold" value={itemAnalytics.items.length} />
                        <Card label="Top Product" value={top10[0]?.name || '—'} sub={`${totalVal > 0 ? ((top10[0]?.value / totalVal) * 100).toFixed(0) : 0}% of turnover`} color="text-emerald-600" />
                        <Card label="Top 3 Share" value={`${totalVal > 0 ? (top10.slice(0, 3).reduce((s, it) => s + it.value, 0) / totalVal * 100).toFixed(0) : 0}%`} sub="of total turnover" />
                      </div>
                      <SectionLabel>Product Contribution to Turnover</SectionLabel>
                      <div className="bg-white rounded-lg border border-[#c8e0d0] p-3 mb-4 space-y-1">
                        {top10.map((it, i) => {
                          const pct = totalVal > 0 ? (it.value / totalVal) * 100 : 0;
                          const barColor = i < 3 ? 'from-emerald-500 to-emerald-400' : i < 6 ? 'from-sky-500 to-sky-400' : 'from-slate-400 to-slate-300';
                          const textColor = i < 3 ? 'text-emerald-700' : i < 6 ? 'text-sky-700' : 'text-slate-500';
                          return (
                            <div key={i} className="flex items-center gap-2">
                              <div className={`w-[180px] text-right text-[10px] font-semibold truncate ${textColor}`}>{it.name}</div>
                              <div className="flex-1 h-5 bg-slate-100 rounded overflow-hidden">
                                <div className={`h-full bg-gradient-to-r ${barColor} rounded flex items-center px-1.5 text-[9px] font-bold text-white`}
                                  style={{ width: `${Math.max(pct, 3)}%`, minWidth: '50px' }}>
                                  {fmtINR(it.value)} ({pct.toFixed(1)}%)
                                </div>
                              </div>
                              <div className="w-[50px] text-right text-[9px] text-slate-400 tabular-nums">{it.uom || ''}</div>
                            </div>
                          );
                        })}
                        {itemAnalytics.items.length > 10 && (
                          <div className="flex items-center gap-2">
                            <div className="w-[180px] text-right text-[10px] text-slate-400 italic">+{itemAnalytics.items.length - 10} more</div>
                            <div className="flex-1 h-5 bg-slate-100 rounded overflow-hidden">
                              <div className="h-full bg-slate-200 rounded flex items-center px-1.5 text-[9px] font-medium text-slate-500"
                                style={{ width: `${Math.max(totalVal > 0 ? (itemAnalytics.items.slice(10).reduce((s, it) => s + it.value, 0) / totalVal * 100) : 0, 3)}%`, minWidth: '50px' }}>
                                {fmtINR(itemAnalytics.items.slice(10).reduce((s, it) => s + it.value, 0))}
                              </div>
                            </div>
                            <div className="w-[50px]"></div>
                          </div>
                        )}
                      </div>
                    </>
                  );
                })()}
                <SectionLabel>Customer Turnover <span className="text-[8px] font-normal normal-case text-slate-400 ml-1">(click customer to see items purchased)</span></SectionLabel>
                <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-x-auto">
                  <table className="min-w-[700px] w-full">
                    <thead><tr>
                      <th className="sticky left-0 bg-[#e4f2ea] text-left px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-[#4a7c5c] border-b-2 border-[#c8e0d0] z-10">Customer</th>
                      {custTurnover.months.map(m => <th key={m} className="text-center px-2 py-1.5 text-[9px] font-bold uppercase tracking-wider text-[#4a7c5c] bg-[#e4f2ea] border-b-2 border-[#c8e0d0] border-l border-[#c8e0d0] min-w-[80px]">{monthLabel(m)}</th>)}
                      <th className="text-right px-2 py-1.5 text-[9px] font-extrabold uppercase tracking-wider text-[#4a7c5c] bg-[#e4f2ea] border-b-2 border-[#c8e0d0] border-l border-[#c8e0d0]">Total</th>
                    </tr></thead>
                    <tbody>
                      {custTurnover.customers.map((c, i) => {
                        const isExp = expandedTurnoverCust === c.name;
                        const custItems = custItemsMap[c.name] ? Object.values(custItemsMap[c.name]).sort((a, b) => b.value - a.value) : [];
                        const custId = c.customer_id || customers.find(cu => cu.name === c.name)?.id || '';
                        return (
                          <React.Fragment key={i}>
                            <tr className={`hover:bg-[#e4f2ea] cursor-pointer ${isExp ? 'bg-[#e4f2ea]' : ''}`}
                              onClick={() => setExpandedTurnoverCust(isExp ? null : c.name)}>
                              <td className="sticky left-0 bg-white px-2 py-1 text-[11px] font-semibold text-[#4a7c5c] border-b border-[#e4f2ea] z-10">
                                <span className="flex items-center gap-1">
                                  <ChevronDown size={10} className={`text-[#4a7c5c] transition-transform flex-shrink-0 ${isExp ? '' : '-rotate-90'}`} />
                                  <span className="hover:underline">{c.name}</span>
                                </span>
                              </td>
                              {custTurnover.months.map(m => (
                                <td key={m} className="text-right px-2 py-1 text-[10px] tabular-nums border-b border-[#e4f2ea] border-l border-[#e4f2ea]">
                                  {c.months[m] ? fmtINR(c.months[m]) : '—'}
                                </td>
                              ))}
                              <td className="text-right px-2 py-1 text-[11px] font-bold tabular-nums text-[#4a7c5c] border-b border-[#e4f2ea] border-l border-[#c8e0d0]">{fmtINR(c.total)}</td>
                            </tr>
                            {isExp && (
                              <tr><td colSpan={custTurnover.months.length + 2} className="p-0">
                                <div className="bg-[#f0f9f4] border-t border-b border-[#c8e0d0] px-4 py-3">
                                  <div className="flex items-center gap-2 mb-2">
                                    <span className="text-[10px] font-bold text-[#4a7c5c] uppercase">Items Purchased</span>
                                    {custId && (
                                      <button type="button" onClick={(e) => { e.stopPropagation(); navigate(`/sales/customer-360/${custId}`); }}
                                        className="text-[10px] font-semibold text-white bg-[#4a7c5c] hover:bg-[#3a6a4c] rounded px-2 py-0.5 transition-colors ml-auto">
                                        View Customer 360 →
                                      </button>
                                    )}
                                  </div>
                                  {custItems.length > 0 ? (
                                    <div className="overflow-x-auto">
                                      <table className="min-w-[600px] w-full">
                                        <thead><tr className="bg-[#e4f2ea]/60">
                                          <th className="sticky left-0 bg-[#e4f2ea]/60 text-left px-2 py-1 text-[9px] font-bold uppercase text-[#4a7c5c] z-10">Product</th>
                                          <th className="text-left px-2 py-1 text-[9px] font-bold uppercase text-[#4a7c5c]">UOM</th>
                                          {custTurnover.months.map(m => <th key={m} className="text-center px-2 py-1 text-[9px] font-bold uppercase text-[#4a7c5c] border-l border-[#c8e0d0] min-w-[70px]">{monthLabel(m)}</th>)}
                                          <th className="text-right px-2 py-1 text-[9px] font-extrabold uppercase text-[#4a7c5c] border-l border-[#c8e0d0]">Total Qty</th>
                                          <th className="text-right px-2 py-1 text-[9px] font-extrabold uppercase text-[#4a7c5c] border-l border-[#c8e0d0]">Total Value</th>
                                        </tr></thead>
                                        <tbody>
                                          {custItems.map((it, ii) => (
                                            <tr key={ii} className="hover:bg-white/60 border-b border-[#e4f2ea]">
                                              <td className="sticky left-0 bg-[#f0f9f4] px-2 py-1 text-[11px] font-medium z-10">{it.name}</td>
                                              <td className="px-2 py-1 text-[10px] text-slate-500">{it.uom || '—'}</td>
                                              {custTurnover.months.map(m => {
                                                const md = it.months[m];
                                                return <td key={m} className="text-center px-2 py-1 text-[10px] tabular-nums border-l border-[#e4f2ea]">
                                                  {md ? <><span className="font-medium">{fmtQty(md.qty)}</span><span className="text-slate-400 text-[9px]"> · {md.qty > 0 ? fmtRup(md.value / md.qty).replace('₹', '') : '—'}</span></> : <span className="text-slate-300">—</span>}
                                                </td>;
                                              })}
                                              <td className="text-right px-2 py-1 text-[10px] font-bold tabular-nums text-[#4a7c5c] border-l border-[#c8e0d0]">{fmtQty(it.qty)}</td>
                                              <td className="text-right px-2 py-1 text-[10px] font-bold tabular-nums text-[#4a7c5c] border-l border-[#c8e0d0]">{fmtINR(it.value)}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  ) : <div className="text-[11px] text-slate-400">No dispatch data for this customer</div>}
                                </div>
                              </td></tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                      {custTurnover.customers.length === 0 && <tr><td colSpan={custTurnover.months.length + 2} className="text-center py-8 text-slate-400 text-sm">No invoice data</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ===== Item Drill-down ===== */}
            {activeSection === 'item_drill' && (
              <div>
                <div className="flex items-center gap-3 mb-4">
                  <span className="text-[11px] font-semibold text-[#7ba68e] uppercase">Select Item:</span>
                  <select value={drillItem} onChange={e => { setDrillItem(e.target.value); setExpandedDrillCust(null); }}
                    className="border border-[#c8e0d0] rounded-lg px-3 py-1.5 text-sm font-medium text-[#1a3a2a] bg-white focus:border-emerald-400 focus:ring-1 focus:ring-emerald-100">
                    {itemAnalytics.items.map(it => <option key={it.name} value={it.name}>{it.name}</option>)}
                  </select>
                </div>
                {drillData && (
                  <div className="bg-[#e4f2ea] border border-[#c8e0d0] rounded-lg p-4">
                    <h4 className="text-sm font-bold text-[#4a7c5c] mb-3">{drillItem} {drillData.uom && <Pill color="slate">{drillData.uom}</Pill>}</h4>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
                      <Card label="Total Qty" value={`${fmtQty(drillData.totalQty)} ${drillData.uom}`} />
                      <Card label="Total Value" value={fmtINR(drillData.totalVal)} color="text-emerald-600" />
                      <Card label={`Avg Price/${drillData.uom || 'Unit'}`} value={drillData.totalQty > 0 ? fmtRup(drillData.totalVal / drillData.totalQty) : '—'} />
                      <Card label="Customers" value={drillData.customers.length} />
                      <Card label="Price Range" value={(() => { const item = itemAnalytics.items.find(it => it.name === drillItem); return item ? `${fmtRup(item.min).replace('₹', '')} - ${fmtRup(item.max).replace('₹', '')}` : '—'; })()} />
                    </div>
                    <SectionLabel>Customer-wise Sales <span className="text-[8px] font-normal normal-case text-slate-400 ml-1">(click customer to see invoices)</span></SectionLabel>
                    <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-hidden mb-4">
                      <table className="w-full">
                        <thead><tr><TH>Customer</TH><TH>UOM</TH><TH right>Qty</TH><TH right>Avg Price</TH><TH right>Total Value</TH><TH right>% Share</TH></tr></thead>
                        <tbody>
                          {drillData.customers.map((c, i) => {
                            const isExp = expandedDrillCust === c.name;
                            return (
                              <React.Fragment key={i}>
                                <tr className={`hover:bg-[#e4f2ea] cursor-pointer ${isExp ? 'bg-[#e4f2ea]' : ''}`}
                                  onClick={() => setExpandedDrillCust(isExp ? null : c.name)}>
                                  <TD bold>
                                    <span className="flex items-center gap-1">
                                      <ChevronDown size={12} className={`text-[#4a7c5c] transition-transform ${isExp ? '' : '-rotate-90'}`} />
                                      <span className="text-[#4a7c5c] hover:underline">{c.name}</span>
                                    </span>
                                  </TD>
                                  <TD><Pill color="slate">{c.uom || '—'}</Pill></TD>
                                  <TD right>{fmtQty(c.qty)}</TD>
                                  <TD right>{fmtRup(c.avg)}</TD>
                                  <TD right bold>{fmtINR(c.value)}</TD>
                                  <TD right>{drillData.totalVal > 0 ? ((c.value / drillData.totalVal) * 100).toFixed(1) + '%' : '—'}</TD>
                                </tr>
                                {isExp && (
                                  <tr><td colSpan={6} className="p-0">
                                    <div className="bg-[#f0f9f4] border-t border-b border-[#c8e0d0] overflow-x-auto">
                                      {c.customer_id && (
                                        <div className="px-3 pt-2">
                                          <button type="button" onClick={(e) => { e.stopPropagation(); navigate(`/sales/customer-360/${c.customer_id}`); }}
                                            className="text-[10px] font-semibold text-white bg-[#4a7c5c] hover:bg-[#3a6a4c] rounded px-2 py-0.5 transition-colors">
                                            View Customer 360 →
                                          </button>
                                        </div>
                                      )}
                                      <table className="w-full">
                                        <thead><tr className="bg-[#e4f2ea]/60">
                                          <th className="text-left px-3 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c]">Month</th>
                                          <th className="text-left px-3 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c]">Invoice #</th>
                                          <th className="text-left px-3 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c]">Date</th>
                                          <th className="text-right px-3 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c]">Qty</th>
                                          <th className="text-left px-3 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c]">UOM</th>
                                          <th className="text-right px-3 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c]">Rate/{drillData.uom || 'Unit'}</th>
                                          <th className="text-right px-3 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c]">Taxable Value</th>
                                          <th className="text-left px-3 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c]">Status</th>
                                        </tr></thead>
                                        <tbody>
                                          {c.invoiceLines.map((ln, li) => (
                                            <tr key={li} className="hover:bg-white/60 border-b border-[#e4f2ea]">
                                              <td className="px-3 py-1 text-[10px] font-semibold text-[#4a7c5c]">{monthLabel((ln.date || '').slice(0, 7))}</td>
                                              <td className="px-3 py-1 text-[11px]">
                                                {ln.invoice_id ? (
                                                  <button type="button" onClick={(e) => { e.stopPropagation(); navigate(`/sales/invoices/${ln.invoice_id}`); }}
                                                    className="text-[#4a7c5c] font-semibold underline decoration-dotted underline-offset-2 hover:text-emerald-700 cursor-pointer">
                                                    {ln.invoice_no || '—'}
                                                  </button>
                                                ) : <span className="text-slate-400">{ln.invoice_no || '—'}</span>}
                                              </td>
                                              <td className="px-3 py-1 text-[11px] text-slate-500">{fmtDate(ln.date)}</td>
                                              <td className="px-3 py-1 text-[11px] text-right tabular-nums">{fmtQty(ln.qty)}</td>
                                              <td className="px-3 py-1 text-[11px] text-slate-500">{ln.uom || '—'}</td>
                                              <td className="px-3 py-1 text-[11px] text-right tabular-nums">{fmtRup(ln.rate)}</td>
                                              <td className="px-3 py-1 text-[11px] text-right tabular-nums font-semibold">{fmtINR(ln.value)}</td>
                                              <td className="px-3 py-1 text-[11px]">{ln.status ? <Pill color={ln.status === 'PAID' ? 'green' : ln.status === 'OVERDUE' ? 'red' : 'amber'}>{ln.status}</Pill> : <span className="text-slate-300">—</span>}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </td></tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {drillData.months.length > 0 && (
                      <>
                        <SectionLabel>Month-wise Trend (Qty)</SectionLabel>
                        <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-x-auto">
                          <table className="min-w-[600px] w-full">
                            <thead><tr>
                              <th className="sticky left-0 bg-[#e4f2ea] text-left px-2 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c] border-b-2 border-[#c8e0d0] z-10">Customer</th>
                              <th className="bg-[#e4f2ea] text-left px-2 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c] border-b-2 border-[#c8e0d0] border-l border-[#c8e0d0]">UOM</th>
                              {drillData.months.map(m => <th key={m} className="text-center px-2 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c] bg-[#e4f2ea] border-b-2 border-[#c8e0d0] border-l border-[#c8e0d0] min-w-[60px]">{monthLabel(m)}</th>)}
                            </tr></thead>
                            <tbody>
                              {drillData.customers.slice(0, 10).map((c, i) => (
                                <tr key={i} className="hover:bg-[#e4f2ea]">
                                  <td className="sticky left-0 bg-white px-2 py-1 text-[11px] font-semibold border-b border-[#e4f2ea] z-10">{c.name}</td>
                                  <td className="px-2 py-1 text-[10px] text-slate-500 border-b border-[#e4f2ea] border-l border-[#e4f2ea]">{c.uom || '—'}</td>
                                  {drillData.months.map(m => (
                                    <td key={m} className="text-right px-2 py-1 text-[10px] tabular-nums border-b border-[#e4f2ea] border-l border-[#e4f2ea]">
                                      {c.months[m] ? fmtQty(c.months[m].qty) : '—'}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ===== Sales Trend ===== */}
            {activeSection === 'trend' && (
              <div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-4">
                  <Card label="Total Invoiced" value={fmtINR(totalSales)} sub="Selected period" color="text-emerald-600" />
                  <Card label="Total Received" value={fmtINR(received)} sub="Selected period" color="text-sky-600" />
                  <Card label="Collection %" value={`${collectionEff.collRate}%`} color="text-emerald-600" />
                </div>
                {momTrend.length > 0 ? (
                  <div className="bg-white rounded-lg border border-[#c8e0d0] p-4">
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={momTrend.map(m => ({
                        month: monthLabel(m.month),
                        Invoiced: num(m.invoiced || m.sales),
                        Received: num(m.received || m.collected),
                      }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e4f2ea" />
                        <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} tickFormatter={v => v >= 1e7 ? `${(v / 1e7).toFixed(1)}Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(0)}L` : v.toLocaleString()} />
                        <RTooltip contentStyle={tooltipStyle} formatter={(v) => fmtINR(v)} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Bar dataKey="Invoiced" fill="#10b981" radius={[3, 3, 0, 0]} />
                        <Bar dataKey="Received" fill="#0ea5e9" radius={[3, 3, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="bg-white rounded-lg border border-[#c8e0d0] p-10 text-center text-slate-400 text-sm">No trend data for this period</div>
                )}
                {/* Monthly Turnover Pivot — Invoices + Debit Notes */}
                {(() => {
                  const byMonth = {};
                  for (const inv of invoices) {
                    const ym = (inv.date || '').slice(0, 7); const v = num(inv.total || inv.amount || inv.invoice_amount);
                    if (!ym) continue;
                    if (!byMonth[ym]) byMonth[ym] = { invoices: 0, invCount: 0, dn: 0, dnCount: 0 };
                    byMonth[ym].invoices += v; byMonth[ym].invCount++;
                  }
                  for (const dn of debitNotes) {
                    const ym = (dn.date || '').slice(0, 7); const v = num(dn.total || dn.amount || dn.invoice_amount);
                    if (!ym) continue;
                    if (!byMonth[ym]) byMonth[ym] = { invoices: 0, invCount: 0, dn: 0, dnCount: 0 };
                    byMonth[ym].dn += v; byMonth[ym].dnCount++;
                  }
                  const months = Object.keys(byMonth).sort();
                  if (months.length === 0) return null;
                  const totInv = months.reduce((s, m) => s + byMonth[m].invoices, 0);
                  const totDN = months.reduce((s, m) => s + byMonth[m].dn, 0);
                  return (
                    <>
                      <SectionLabel>Monthly Turnover (Taxable)</SectionLabel>
                      <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-x-auto">
                        <table className="min-w-[700px] w-full">
                          <thead><tr>
                            <th className="sticky left-0 bg-[#e4f2ea] text-left px-2 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c] border-b-2 border-[#c8e0d0] z-10">Type</th>
                            {months.map(m => <th key={m} className="text-center px-2 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c] bg-[#e4f2ea] border-b-2 border-[#c8e0d0] border-l border-[#c8e0d0] min-w-[80px]">{monthLabel(m)}</th>)}
                            <th className="text-right px-2 py-1.5 text-[9px] font-extrabold uppercase text-[#4a7c5c] bg-[#e4f2ea] border-b-2 border-[#c8e0d0] border-l border-[#c8e0d0]">Total</th>
                          </tr></thead>
                          <tbody>
                            <tr className="hover:bg-[#e4f2ea]">
                              <td className="sticky left-0 bg-white px-2 py-1 text-[11px] font-semibold text-emerald-700 border-b border-[#e4f2ea] z-10">Invoices</td>
                              {months.map(m => <td key={m} className="text-right px-2 py-1 text-[10px] tabular-nums border-b border-[#e4f2ea] border-l border-[#e4f2ea]">{byMonth[m].invoices ? fmtINR(byMonth[m].invoices) : '—'}</td>)}
                              <td className="text-right px-2 py-1 text-[11px] font-bold tabular-nums text-emerald-700 border-b border-[#e4f2ea] border-l border-[#c8e0d0]">{fmtINR(totInv)}</td>
                            </tr>
                            <tr className="hover:bg-[#e4f2ea]">
                              <td className="sticky left-0 bg-white px-2 py-1 text-[11px] font-semibold text-sky-700 border-b border-[#e4f2ea] z-10">Debit Notes</td>
                              {months.map(m => <td key={m} className="text-right px-2 py-1 text-[10px] tabular-nums border-b border-[#e4f2ea] border-l border-[#e4f2ea]">{byMonth[m].dn ? fmtINR(byMonth[m].dn) : '—'}</td>)}
                              <td className="text-right px-2 py-1 text-[11px] font-bold tabular-nums text-sky-700 border-b border-[#e4f2ea] border-l border-[#c8e0d0]">{fmtINR(totDN)}</td>
                            </tr>
                            <tr className="bg-[#e4f2ea]/40 font-bold">
                              <td className="sticky left-0 bg-[#e4f2ea]/40 px-2 py-1 text-[11px] font-bold text-[#4a7c5c] border-b border-[#c8e0d0] z-10">Net Turnover</td>
                              {months.map(m => <td key={m} className="text-right px-2 py-1 text-[10px] tabular-nums font-bold text-[#4a7c5c] border-b border-[#c8e0d0] border-l border-[#c8e0d0]">{fmtINR(byMonth[m].invoices + byMonth[m].dn)}</td>)}
                              <td className="text-right px-2 py-1 text-[11px] font-extrabold tabular-nums text-[#4a7c5c] border-b border-[#c8e0d0] border-l border-[#c8e0d0]">{fmtINR(totInv + totDN)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </>
                  );
                })()}
              </div>
            )}

            {/* ===== Collection Efficiency ===== */}
            {activeSection === 'collection' && (
              <div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                  <Card label="DSO (Days Sales Outstanding)" value={`${collectionEff.dso}d`} color="text-amber-600" />
                  <Card label="Collection Rate" value={`${collectionEff.collRate}%`} sub={`${fmtINR(received)} / ${fmtINR(totalSales)}`} color="text-emerald-600" />
                  <Card label="Outstanding" value={fmtINR(outstanding)} color="text-amber-600" />
                  <Card label="Overdue" value={fmtINR(overdue)} color="text-red-600" />
                </div>
                {momTrend.length > 0 && (
                  <>
                    <SectionLabel>Month-wise Collection Trend</SectionLabel>
                    <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-x-auto mb-4">
                      <table className="min-w-[700px] w-full">
                        <thead><tr>
                          <th className="sticky left-0 bg-[#e4f2ea] text-left px-2 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c] border-b-2 border-[#c8e0d0] z-10">Metric</th>
                          {momTrend.map(m => <th key={m.month} className="text-center px-2 py-1.5 text-[9px] font-bold uppercase text-[#4a7c5c] bg-[#e4f2ea] border-b-2 border-[#c8e0d0] border-l border-[#c8e0d0] min-w-[80px]">{monthLabel(m.month)}</th>)}
                        </tr></thead>
                        <tbody>
                          <tr className="hover:bg-[#e4f2ea]">
                            <td className="sticky left-0 bg-white px-2 py-1 text-[11px] font-semibold border-b border-[#e4f2ea] z-10">Invoiced</td>
                            {momTrend.map(m => <td key={m.month} className="text-right px-2 py-1 text-[10px] tabular-nums border-b border-[#e4f2ea] border-l border-[#e4f2ea]">{fmtINR(num(m.invoiced || m.sales))}</td>)}
                          </tr>
                          <tr className="hover:bg-[#e4f2ea]">
                            <td className="sticky left-0 bg-white px-2 py-1 text-[11px] font-semibold text-emerald-600 border-b border-[#e4f2ea] z-10">Received</td>
                            {momTrend.map(m => <td key={m.month} className="text-right px-2 py-1 text-[10px] tabular-nums border-b border-[#e4f2ea] border-l border-[#e4f2ea]">{fmtINR(num(m.received || m.collected))}</td>)}
                          </tr>
                          <tr className="hover:bg-[#e4f2ea]">
                            <td className="sticky left-0 bg-white px-2 py-1 text-[11px] font-semibold text-amber-600 border-b border-[#e4f2ea] z-10">Collection %</td>
                            {momTrend.map(m => {
                              const inv = num(m.invoiced || m.sales);
                              const rec = num(m.received || m.collected);
                              return <td key={m.month} className="text-right px-2 py-1 text-[10px] tabular-nums border-b border-[#e4f2ea] border-l border-[#e4f2ea]">{inv > 0 ? `${((rec / inv) * 100).toFixed(0)}%` : '—'}</td>;
                            })}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
                <SectionLabel>Slowest Payers</SectionLabel>
                <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-hidden">
                  <table className="w-full">
                    <thead><tr><TH>Customer</TH><TH right>Credit Terms</TH><TH right>Outstanding</TH><TH right>Overdue</TH><TH>Rating</TH></tr></thead>
                    <tbody>
                      {topDebtors.slice(0, 15).map((c, i) => {
                        const hasOverdue = c.overdue > 0;
                        const pct = c.outstanding > 0 ? (c.overdue / c.outstanding) * 100 : 0;
                        const rating = pct > 60 ? 'POOR' : pct > 30 ? 'FAIR' : 'GOOD';
                        const ratingColor = rating === 'POOR' ? 'red' : rating === 'FAIR' ? 'amber' : 'green';
                        return (
                          <tr key={i} className="hover:bg-[#e4f2ea]">
                            <TD bold clickable onClick={() => navigate(`/sales/customer-360/${c.id}`)}>{c.name}</TD>
                            <TD right>{c.credit_terms ? c.credit_terms.replace('_', ' ') : '—'}</TD>
                            <TD right color="text-amber-600">{fmtINR(c.outstanding)}</TD>
                            <TD right color={hasOverdue ? 'text-red-600' : 'text-slate-300'}>{hasOverdue ? fmtINR(c.overdue) : '—'}</TD>
                            <TD><Pill color={ratingColor}>{rating}</Pill></TD>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ===== Credit/Debit Notes ===== */}
            {activeSection === 'cn_dn' && (
              <div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
                  <Card label="Credit Notes" value={fmtINR(cnDnStats.cnTotal)} sub={`${cnDnStats.cnCount} notes`} color="text-red-600" />
                  <Card label="Debit Notes" value={fmtINR(cnDnStats.dnTotal)} sub={`${cnDnStats.dnCount} notes`} color="text-emerald-600" />
                  <Card label="Net Adjustment" value={`${cnDnStats.net > 0 ? '-' : ''}${fmtINR(Math.abs(cnDnStats.net))}`} sub="CN - DN" color={cnDnStats.net > 0 ? 'text-red-600' : 'text-emerald-600'} />
                  <Card label="CN as % of Sales" value={`${cnDnStats.cnPct}%`} sub="Target: < 2%" color={num(cnDnStats.cnPct) > 2 ? 'text-red-600' : 'text-emerald-600'} />
                </div>
                {creditNotes.length > 0 && (
                  <>
                    <SectionLabel color="text-red-600">Recent Credit Notes</SectionLabel>
                    <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-hidden mb-4">
                      <table className="w-full">
                        <thead><tr><TH>CN #</TH><TH>Customer</TH><TH>Date</TH><TH right>Amount</TH></tr></thead>
                        <tbody>
                          {creditNotes.slice(0, 20).map((r, i) => (
                            <tr key={i} className="hover:bg-[#e4f2ea]">
                              <TD bold>{r.note_no || r.invoice_number || r.voucher_number || r.ref || `CN-${i + 1}`}</TD>
                              <TD clickable>{r.customer_name || r.customer}</TD>
                              <TD>{fmtDate(r.date)}</TD>
                              <TD right bold color="text-red-600">{fmtRup(num(r.total || r.amount || r.invoice_amount))}</TD>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
                {debitNotes.length > 0 && (
                  <>
                    <SectionLabel color="text-emerald-600">Recent Debit Notes</SectionLabel>
                    <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-hidden">
                      <table className="w-full">
                        <thead><tr><TH>DN #</TH><TH>Customer</TH><TH>Date</TH><TH right>Amount</TH></tr></thead>
                        <tbody>
                          {debitNotes.slice(0, 20).map((r, i) => (
                            <tr key={i} className="hover:bg-[#e4f2ea]">
                              <TD bold>{r.note_no || r.invoice_number || r.voucher_number || r.ref || `DN-${i + 1}`}</TD>
                              <TD clickable>{r.customer_name || r.customer}</TD>
                              <TD>{fmtDate(r.date)}</TD>
                              <TD right bold color="text-emerald-600">{fmtRup(num(r.total || r.amount || r.invoice_amount))}</TD>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
                {creditNotes.length === 0 && debitNotes.length === 0 && (
                  <div className="text-center py-12 text-slate-400 text-sm">No credit or debit notes in this period</div>
                )}
              </div>
            )}

            {/* ===== GST Summary ===== */}
            {activeSection === 'gst' && (
              <div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-4">
                  <Card label="Ex-GST (Taxable)" value={fmtINR(gstData.taxable)} />
                  <Card label="Total GST" value={fmtINR(gstData.gst)} color="text-emerald-600" />
                  <Card label="Incl. GST" value={fmtINR(gstData.incl_gst)} sub="Total invoice value" />
                </div>
                {(gstData.cgst > 0 || gstData.sgst > 0 || gstData.igst > 0) && (
                  <>
                    <SectionLabel>GST Breakup</SectionLabel>
                    <div className="grid grid-cols-3 gap-2 mb-4">
                      <div className="bg-white rounded-lg border border-[#c8e0d0] p-3 text-center">
                        <div className="text-[10px] font-semibold text-[#4a7c5c] uppercase">CGST</div>
                        <div className="text-lg font-bold text-[#1a3a2a] mt-1">{fmtINR(gstData.cgst)}</div>
                      </div>
                      <div className="bg-white rounded-lg border border-[#c8e0d0] p-3 text-center">
                        <div className="text-[10px] font-semibold text-[#4a7c5c] uppercase">SGST</div>
                        <div className="text-lg font-bold text-[#1a3a2a] mt-1">{fmtINR(gstData.sgst)}</div>
                      </div>
                      <div className="bg-white rounded-lg border border-[#c8e0d0] p-3 text-center">
                        <div className="text-[10px] font-semibold text-[#4a7c5c] uppercase">IGST</div>
                        <div className="text-lg font-bold text-[#1a3a2a] mt-1">{fmtINR(gstData.igst)}</div>
                      </div>
                    </div>
                  </>
                )}
                {gstData.other_charges > 0 && (
                  <div className="grid grid-cols-2 gap-2 mb-4">
                    <Card label="Other Charges" value={fmtINR(gstData.other_charges)} sub="Freight / testing" />
                    {gstData.round_off !== 0 && <Card label="Round Off" value={fmtRup(gstData.round_off)} />}
                  </div>
                )}
                {(gstData.debit_notes > 0 || gstData.credit_notes > 0) && (
                  <>
                    <SectionLabel>Debit / Credit Notes</SectionLabel>
                    <div className="grid grid-cols-2 gap-2 mb-4">
                      <Card label="Debit Notes" value={fmtINR(gstData.debit_notes)} color="text-red-600" />
                      <Card label="Credit Notes" value={fmtINR(gstData.credit_notes)} color="text-emerald-600" />
                    </div>
                  </>
                )}
                {(() => {
                  const gstMonths = momTrend.filter(m => num(m.cgst) + num(m.sgst) + num(m.igst) > 0);
                  if (!gstMonths.length) return null;
                  return (
                    <>
                      <SectionLabel>Monthly GST Pivot</SectionLabel>
                      <div className="bg-white rounded-lg border border-[#c8e0d0] overflow-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-[#c8e0d0] bg-[#e4f2ea]">
                              <TH>Month</TH><TH right>CGST</TH><TH right>SGST</TH><TH right>IGST</TH><TH right>Total GST</TH>
                            </tr>
                          </thead>
                          <tbody>
                            {gstMonths.map(m => {
                              const c = num(m.cgst), s = num(m.sgst), ig = num(m.igst);
                              return (
                                <tr key={m.month} className="hover:bg-[#e4f2ea]">
                                  <TD bold>{(m.label || monthLabel(m.month))}</TD>
                                  <TD right>{c > 0 ? fmtRup(c) : '—'}</TD>
                                  <TD right>{s > 0 ? fmtRup(s) : '—'}</TD>
                                  <TD right>{ig > 0 ? fmtRup(ig) : '—'}</TD>
                                  <TD right bold color="text-[#4a7c5c]">{fmtRup(c + s + ig)}</TD>
                                </tr>
                              );
                            })}
                            <tr className="bg-[#e4f2ea] font-semibold">
                              <TD bold>Total</TD>
                              <TD right bold>{fmtRup(gstMonths.reduce((a, m) => a + num(m.cgst), 0))}</TD>
                              <TD right bold>{fmtRup(gstMonths.reduce((a, m) => a + num(m.sgst), 0))}</TD>
                              <TD right bold>{fmtRup(gstMonths.reduce((a, m) => a + num(m.igst), 0))}</TD>
                              <TD right bold color="text-[#4a7c5c]">{fmtRup(gstMonths.reduce((a, m) => a + num(m.cgst) + num(m.sgst) + num(m.igst), 0))}</TD>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </>
                  );
                })()}
                {!gstData.gst && !gstData.taxable && <div className="text-center py-12 text-slate-400 text-sm">No GST data for this period</div>}
              </div>
            )}

            {/* ===== TDS Summary ===== */}
            {activeSection === 'tds' && (
              <div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-4">
                  <Card label="TDS on Invoices" value={fmtINR(tdsData.invoice_tds)} sub="194Q on sales" color="text-amber-600" />
                  <Card label="TDS at Payment" value={fmtINR(tdsData.payment_tds)} sub="Buyer withheld" color="text-amber-600" />
                  {tdsData.note_debits > 0 && <Card label="TDS on DN" value={fmtINR(tdsData.note_debits)} sub="Debit note withholding" />}
                  {tdsData.reversed > 0 && <Card label="TDS Reversed" value={fmtINR(tdsData.reversed)} sub="CN / Journal reversal" color="text-emerald-600" />}
                  <Card label="Net TDS Receivable" value={fmtINR(tdsData.net)} sub="Debit − Credit" color="text-red-600" />
                </div>
                {!tdsData.invoice_tds && !tdsData.payment_tds && <div className="text-center py-12 text-slate-400 text-sm">No TDS data for this period</div>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
