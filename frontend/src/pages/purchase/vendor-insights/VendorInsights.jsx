/**
 * Vendor Insights — Vendor 360 (REAL data).
 *
 * The purchase-side mirror of Customer Insights, wired to endpoints that
 * already exist. Nothing here is computed specially for this page:
 *
 *   vendor list / profile      → /api/vendors/  &  /api/vendors/{id}/
 *   KPIs                       → /api/purchase/dashboard/?vendor=…
 *   opening/closing, bills,
 *     payments, timeline       → /api/purchase/bills/vendor-ledger/?vendor=…
 *   payment / aging buckets    → /api/purchase/dashboard/records/?type=payables_buckets
 *   month-on-month, products   → /api/purchase/dashboard/analytics/?vendor=…
 *
 * SIGNS ARE MIRRORED, NOT COPIED. On a customer ledger a sale DEBITS the party;
 * on a vendor ledger a bill CREDITS them — we owe more — and a payment debits.
 * So "Received (Cr)" over on the sales side becomes "Billed (Cr)" here, and the
 * green/paid column is the DEBIT one. Getting this backwards would invert every
 * figure on the page while still looking plausible, which is why the ledger card
 * names the Dr/Cr side explicitly rather than just "in"/"out".
 *
 * Metrics the ERP doesn't track (vendor rating, lead time, defect rate,
 * on-time-delivery %) are deliberately absent — everything here reconciles to
 * Tally.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ResponsiveContainer, LineChart, Line, PieChart, Pie, XAxis, YAxis,
  CartesianGrid, Tooltip, Cell, Legend,
} from 'recharts';
import {
  TrendingUp, Wallet, AlertCircle, Building2, MapPin, CreditCard,
  Calendar, FileText, Phone, Mail, User, Receipt, SlidersHorizontal,
  Loader2, Sparkles, Package, Search, X, ChevronRight,
} from 'lucide-react';
import { PeriodNavigator, usePeriodFilter, fyTokenFor, todayISO } from '@/components/common/PeriodNavigator';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { usePurchaseFilter } from '../components/purchaseFilter.js';
import { formatDate } from '@/utils/formatters';

// ── Formatting (same vocabulary as Customer Insights) ────────────────
const num = (v) => Number(v) || 0;
const fmtINR = (v) => {
  const n = num(v);
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};
const fmtFull = (v) => `₹${num(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtRup = (v) => `₹${Math.round(num(v)).toLocaleString('en-IN')}`;
const fmtQty = (v) => num(v).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const fmtDate = (iso) => (iso ? formatDate(iso) : '—');
const pct = (a, b) => (num(b) ? Math.round((num(a) / num(b)) * 100) : 0);
const tooltipStyle = { fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' };
const PIE_COLORS = ['#6366f1', '#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b', '#f43f5e', '#14b8a6', '#a855f7'];

// A payable balance is a CREDIT. Show it plainly with the side named, the way
// Tally does, instead of a bare number that could be read either way.
const bal = (v) => {
  const n = num(v);
  if (!n) return '₹0.00';
  return `${fmtFull(Math.abs(n))} ${n >= 0 ? 'Cr' : 'Dr'}`;
};

// Derived from the navigator's own state rather than imported — the shared
// module doesn't export a label helper, and the FY anchor token is a plain
// "2026-04-01..2027-03-31" pair, so the year reads straight off the range.
const periodLabelOf = (period, win) => {
  if (!win) return 'All Time';
  if (period === 'custom') return `${fmtDate(win.from)} – ${fmtDate(win.to)}`;
  if (period === 'today') return fmtDate(win.from);
  if (period === 'week') return `${fmtDate(win.from)} – ${fmtDate(win.to)}`;
  if (period === 'month') {
    const [y, m] = win.from.split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  }
  const y = Number(win.from.slice(0, 4));
  return `FY ${y}-${String((y + 1) % 100).padStart(2, '0')}`;
};

const shortCompany = (label) => {
  const w = String(label || '').replace(/[.,]/g, ' ').split(/\s+/)
    .filter(x => x && !/^(pvt|private|ltd|limited|llp|inc|co|company|india|the|and|&)$/i.test(x));
  return (w.slice(0, 2).join(' ') || label || '').toUpperCase();
};

// Identical four buckets to the sales side — payables_buckets returns the same
// keys as receivables_buckets, so the card is a true mirror.
const BUCKET_META = {
  paid_early:     { label: 'Paid early', color: '#10b981' },
  still_open:     { label: 'Still open', color: '#0ea5e9' },
  paid_late:      { label: 'Paid late', color: '#f59e0b' },
  overdue_unpaid: { label: 'Overdue', color: '#ef4444' },
};
const BUCKET_ORDER = ['paid_early', 'still_open', 'paid_late', 'overdue_unpaid'];

const typeCls = (t) => ({
  Bill: 'bg-sky-50 text-sky-700', Payment: 'bg-emerald-50 text-emerald-700',
  'Debit Note': 'bg-amber-50 text-amber-700', 'Credit Note': 'bg-blue-50 text-blue-700',
}[t] || 'bg-slate-100 text-slate-600');

const TONES = {
  indigo: 'bg-indigo-50 text-indigo-600', emerald: 'bg-emerald-50 text-emerald-600',
  rose: 'bg-rose-50 text-rose-600', sky: 'bg-sky-50 text-sky-600',
  violet: 'bg-violet-50 text-violet-600', amber: 'bg-amber-50 text-amber-600',
};

// Where a bill's Back button should return to: this page WITH its filter.
// It used to be the bare '/purchase/vendor-insights', which reset company,
// vendor and period on the way back.
//
// Module scope, not component scope: Vendor360 links to bills too, and as a
// SIBLING of VendorInsights it could not see a definition inside it — every
// bill link in that sub-tree threw ReferenceError on click.
const backHere = () => `${window.location.pathname}${window.location.search}`;

function Tile({ icon: Icon, tone = 'indigo', label, value, sub, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className="min-w-0 bg-white rounded-xl border border-slate-200 p-3 text-left hover:border-indigo-300 hover:shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300">
      <span className={`inline-flex w-7 h-7 rounded-lg items-center justify-center mb-2 ${TONES[tone]}`}><Icon size={15} /></span>
      <p className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold truncate">{label}</p>
      {/* `truncate` here CUT THE NUMBER OFF: a long rupee figure became
          "Rs 3,80,56..." with the rest behind an ellipsis, unreadable. A label
          may be abbreviated; the figure the tile exists to show may not. Wraps
          instead, matching Customer Insights. */}
      <p className="text-base sm:text-lg font-bold text-slate-900 tabular-nums leading-tight break-words">{value}</p>
      {sub && <p className="text-[11px] text-slate-400 truncate">{sub}</p>}
    </button>
  );
}

function Card({ title, subtitle, children }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      {title && <h3 className="text-sm font-semibold text-slate-800">{title}</h3>}
      {subtitle && <p className="text-[11px] text-slate-400 mb-3">{subtitle}</p>}
      {children}
    </div>
  );
}

function MiniStat({ label, value, tone }) {
  return (
    <div className="min-w-0 rounded-lg bg-slate-50 px-3 py-2">
      <p className="text-[11px] text-slate-400 truncate">{label}</p>
      <p className={`text-sm font-bold tabular-nums break-words leading-tight ${tone === 'emerald' ? 'text-emerald-700' : tone === 'rose' ? 'text-rose-700' : 'text-slate-800'}`}>{value}</p>
    </div>
  );
}

// ── Vendor 360 ───────────────────────────────────────────────────────
function Vendor360({ vendors, vendLoading, company, id, setId, from, to, periodLabel, onPickMonth }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState(null);
  const [bktTip, setBktTip] = useState(null);
  const [dropOpen, setDropOpen] = useState(false);

  // Switching company re-fetches this list, and an in-flight fetch shows as an
  // EMPTY list — so without the loading guard the check read "not in the list"
  // and threw the user back to the landing page every time they touched a
  // company chip while looking at a vendor. Wait for the list to arrive before
  // deciding a vendor is missing from it. Same fix as Customer Insights.
  useEffect(() => {
    if (vendLoading || !vendors.length) return;
    if (id && !vendors.some(v => String(v.value) === String(id))) { setId(''); setSearch(''); }
  }, [vendors, vendLoading]);   // eslint-disable-line react-hooks/exhaustive-deps

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [profile, setProfile] = useState(null);
  const [stats, setStats] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [products, setProducts] = useState([]);
  const [buckets, setBuckets] = useState(null);
  const [momTrend, setMomTrend] = useState([]);

  useEffect(() => {
    if (!id) return;
    let cancel = false; setLoading(true); setErr(null);
    const qs = `vendor=${id}&period=custom&from=${from}&to=${to}`;
    Promise.all([
      apiClient.get(`/api/vendors/${id}/`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/purchase/dashboard/?${qs}`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/purchase/bills/vendor-ledger/?vendor=${id}&from=${from}&to=${to}`).then(r => r.data).catch(() => null),
      apiClient.get(`/api/purchase/dashboard/records/?type=payables_buckets&${qs}`).then(r => r.data).catch(() => null),
      // Top products comes from ANALYTICS here, not from the bill rows. The
      // sales page derives it from dispatch `lines`, but purchase bill rows
      // carry no line detail — the analytics endpoint already aggregates it.
      apiClient.get(`/api/purchase/dashboard/analytics/?${qs}`).then(r => r.data).catch(() => null),
    ]).then(([prof, dash, led, bkt, ana]) => {
      if (cancel) return;
      setProfile(prof); setStats(dash?.stats || null); setLedger(led); setBuckets(bkt);
      setMomTrend(ana?.mom_trend || []);
      // Share is by VALUE, not quantity. top_products.qty sums across whatever
      // UOMs the vendor billed in — adding kg to litres to nos gives a number
      // that charts cleanly and means nothing. Rupees are comparable.
      const tp = (ana?.top_products || []).map(p => ({
        name: p.product_name || p.name || '—',
        amount: num(p.amount),
        qtyLabel: (p.qty_breakdown || []).map(b => `${fmtQty(b.qty)} ${b.uom}`).join(' · '),
      })).filter(p => p.amount > 0);
      setProducts(tp.slice(0, 6));
    }).catch(e => { if (!cancel) setErr(e.response?.data?.detail || 'Failed to load vendor data.'); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [id, from, to]);

  // Welcome facts — a LIVE "who do we owe" snapshot. The purchase `outstanding`
  // drill returns one row per BILL (the sales equivalent returns one per
  // customer), so it is rolled up by vendor here rather than asking the backend
  // for a shape it does not have.
  const [factRows, setFactRows] = useState([]);
  useEffect(() => {
    let cancel = false;
    apiClient.get(`/api/purchase/dashboard/records/?type=outstanding${company ? `&company=${company}` : ''}`)
      .then(r => { if (!cancel) setFactRows(r.data?.rows || []); })
      .catch(() => { if (!cancel) setFactRows([]); });
    return () => { cancel = true; };
  }, [company]);

  const facts = useMemo(() => {
    const byVendor = new Map();
    for (const r of factRows || []) {
      const key = (r.vendor || '').trim() || '—';
      const e = byVendor.get(key) || { name: key, out: 0, bills: 0 };
      e.out += num(r.balance);
      e.bills += 1;
      byVendor.set(key, e);
    }
    const rows = [...byVendor.values()].filter(r => r.out > 0);
    return {
      rows,
      totalOut: rows.reduce((s, r) => s + r.out, 0),
      count: rows.length,
      billCount: (factRows || []).length,
      top: [...rows].sort((a, b) => b.out - a.out),
    };
  }, [factRows]);

  // The rollup is keyed on vendor NAME (the drill rows carry no vendor id), so
  // map back to the picker's id by name to make a row clickable.
  const idByName = useMemo(() => {
    const m = new Map();
    vendors.forEach(v => m.set(String(v.label).trim().toLowerCase(), String(v.value)));
    return m;
  }, [vendors]);

  const sortedVendors = useMemo(() =>
    [...vendors].sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: 'base' })),
    [vendors]);

  if (!vendors.length) {
    return <div className="bg-white rounded-xl border border-slate-200 py-16 text-center text-sm text-slate-400">No vendors with purchases for this company.</div>;
  }

  // ── Welcome screen ────────────────────────────────────────────────
  if (!id) {
    const q = search.trim().toLowerCase();
    const dropList = sortedVendors.filter(v => !q || String(v.label).toLowerCase().includes(q));
    const quick = facts.top.slice(0, 6);
    const pick = (v) => { setId(String(v)); setSearch(''); setDropOpen(false); };
    const pickByName = (name) => { const vid = idByName.get(name.trim().toLowerCase()); if (vid) pick(vid); };
    const maxOut = facts.top[0]?.out || 1;
    return (
      <div className="space-y-3">
        <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 text-center">
          <p className="text-lg font-bold text-slate-900 mb-1">Find a vendor</p>
          <p className="text-sm text-slate-400 mb-4">Search {vendors.length} vendors, or pick one below.</p>
          <div className="max-w-2xl mx-auto relative">
            <Search size={20} className="text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
            <input value={search}
              onChange={e => { setSearch(e.target.value); setDropOpen(true); }}
              onFocus={() => setDropOpen(true)}
              placeholder="Search a vendor by name…"
              className="w-full pl-12 pr-4 py-3.5 rounded-2xl border border-slate-200 bg-white text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-300" />
            {dropOpen && q && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setDropOpen(false)} />
                <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden max-h-80 overflow-y-auto divide-y divide-slate-100 text-left">
                  {dropList.length ? dropList.slice(0, 40).map(v => (
                    <button key={v.value} type="button" onClick={() => pick(v.value)}
                      className="w-full text-left px-4 py-2.5 hover:bg-indigo-50/60">
                      <span className="block text-sm font-medium text-slate-700 break-words">{v.label}</span>
                    </button>
                  )) : <p className="px-4 py-3 text-sm text-slate-400">No vendor matches “{search}”.</p>}
                </div>
              </>
            )}
          </div>
          {quick.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">Quick pick</span>
              {/* Full name, no max-width and no " - " split. Chopping the suffix
                  collapsed distinct vendors into one label — several
                  "Kumaran Traders - <place>" read identically. */}
              {quick.map(v => (
                <button key={v.name} type="button" onClick={() => pickByName(v.name)}
                  className="group inline-flex items-center max-w-full px-3 py-1.5 rounded-full border border-slate-200 bg-white hover:border-indigo-300 hover:shadow-sm transition text-left">
                  <span className="text-sm text-slate-700 group-hover:text-indigo-600 break-words min-w-0">{v.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-3">
          <div className="rounded-2xl p-5 bg-white border border-slate-200 h-fit">
            <p className="text-sm font-semibold text-slate-800">At a glance</p>
            <p className="text-[11px] text-slate-400 mb-3">Payables snapshot · as at today</p>
            <p className="text-3xl font-extrabold tabular-nums text-slate-900 leading-none">{fmtRup(facts.totalOut)}</p>
            <p className="text-xs text-slate-500 mt-1">Total payable · {facts.count} vendors</p>
            <div className="mt-3 space-y-1.5 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">Unpaid bills</span><span className="font-bold tabular-nums text-slate-800">{facts.billCount}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Vendors owed</span><span className="font-bold text-slate-800">{facts.count}</span></div>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-3 sm:p-4">
            <div className="px-2 pb-2">
              <p className="text-sm font-bold text-slate-800">Top by payable</p>
              <p className="text-[11px] text-slate-400">Largest unpaid balances · tap to open</p>
            </div>
            {facts.top.length ? (
              <div className="space-y-0.5">
                {facts.top.slice(0, 8).map((v, i) => (
                  <button key={v.name} type="button" onClick={() => pickByName(v.name)}
                    className="w-full flex items-center gap-3 text-left px-3 py-2.5 rounded-xl hover:bg-slate-50 transition">
                    <span className={`w-6 h-6 rounded-full text-[11px] font-bold flex items-center justify-center shrink-0 ${i < 3 ? `${['bg-amber-400', 'bg-slate-400', 'bg-orange-400'][i]} text-white` : 'bg-slate-100 text-slate-400'}`}>{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-slate-800 break-words">{v.name}</span>
                      <span className="mt-1 block h-1.5 rounded-full bg-slate-100 overflow-hidden"><span className="block h-full rounded-full bg-blue-500" style={{ width: `${Math.max(6, v.out / maxOut * 100)}%` }} /></span>
                    </span>
                    <span className="text-right shrink-0">
                      <span className="block text-sm font-bold tabular-nums text-slate-900">{fmtRup(v.out)}</span>
                      <span className="text-[10px] text-slate-400">{v.bills} bill{v.bills === 1 ? '' : 's'}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : <p className="text-sm text-slate-400 py-8 text-center">No outstanding payables.</p>}
          </div>
        </div>
      </div>
    );
  }

  // ── Detail view ───────────────────────────────────────────────────
  const tp = stats?.total_purchase || {};
  // Headline is EX-GST, matching the Total Purchase card on Analytics: it's the
  // figure people work with, and input GST is recoverable rather than cost.
  // `gross` is kept because money actually moves at the incl-GST figure — paid,
  // outstanding and the ledger are all gross, so any RATIO against them has to
  // use gross or it overstates (paid/taxable can exceed 100%).
  const totalPurchase = num(tp.taxable ?? tp.total ?? tp.gross);
  const grossPurchase = num(tp.total ?? tp.gross);
  const gstPurchase = num(tp.gst);
  const paid = num(stats?.amount_paid?.total);
  const outstanding = num(stats?.outstanding_payables?.total);
  const billCount = num(stats?.bills?.count);
  // Same basis as the headline, so avg × bills reconciles to what's shown.
  const avgBill = billCount ? Math.round(totalPurchase / billCount) : 0;
  const qb = stats?.quantity_billed || {};
  const qtyStr = (qb.uom_breakdown || []).map(b => `${fmtQty(b.qty)} ${b.uom}`).join(' · ') || '—';

  const rows = ledger?.rows || [];
  // Mirrored from the sales page: a BILL is the credit side here.
  const allBills = [...rows].filter(r => r.type === 'Bill' || r.type === 'Credit Note').reverse();
  const allPayments = [...rows].filter(r => r.type === 'Payment' || r.type === 'Debit Note').reverse();
  const recentBills = allBills.slice(0, 6);
  const recentPayments = allPayments.slice(0, 6);
  const timeline = [...rows].slice(-8).reverse();

  const trend = momTrend.map(m => ({
    // `month` is the "YYYY-MM" key — kept so a click can jump the period there.
    month: m.month || '',
    label: (m.label || m.month || '').replace(' 20', " '"),
    billed: num(m.billed), paid: num(m.paid),
  }));
  const hasTrend = trend.some(m => m.billed || m.paid);
  const prodChart = products.map(p => ({ name: p.name, amount: Math.round(p.amount), qtyLabel: p.qtyLabel }));

  // Each `sub` already carries the backend's own `total`; trust it rather than
  // re-summing the parsed row strings.
  const subs = (buckets?.groups || []).flatMap(g => (g.sub || []).map(s => ({
    key: s.key,
    amount: s.total != null ? num(s.total) : (s.rows || []).reduce((a, r) => a + num(r.amount), 0),
    count: s.count ?? (s.rows || []).length,
    // Kept so a bucket can be opened. Each row already carries bill_id,
    // bill_no, due_date, days_label and status — no extra request needed.
    rows: s.rows || [],
  })));
  const bucketRows = BUCKET_ORDER
    .map(k => ({ k, ...BUCKET_META[k], ...(subs.find(s => s.key === k) || { amount: 0, count: 0, rows: [] }) }));
  const bucketTot = bucketRows.reduce((a, b) => a + b.amount, 0) || 1;

  const ba = profile?.billing_address || profile?.address || {};
  const location = [ba.city, ba.state].filter(Boolean).join(', ') || ba.state || '';
  const name = profile?.vendor_name || vendors.find(v => String(v.value) === String(id))?.label || 'Vendor';

  const fields = [
    { icon: FileText, label: 'GSTIN', value: profile?.gstin },
    { icon: User, label: 'Contact', value: profile?.contact_person },
    { icon: CreditCard, label: 'PAN', value: profile?.pan },
    { icon: Phone, label: 'Phone', value: profile?.contact_phone || profile?.phone },
    { icon: MapPin, label: 'Location', value: location },
    { icon: Mail, label: 'Email', value: profile?.contact_email || profile?.email },
    { icon: Calendar, label: 'Payment terms', value: profile?.payment_terms },
    { icon: Building2, label: 'Type', value: (Array.isArray(profile?.vendor_type) ? profile.vendor_type.join(', ') : profile?.vendor_type || '').toLowerCase() },
  ].filter(f => f.value && String(f.value).trim());

  return (
    <div className="space-y-4">
      {err && <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg p-3 text-sm flex items-center gap-2"><AlertCircle size={14} /> {err}</div>}

      {/* Profile strip */}
      <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white flex items-center justify-center font-bold shrink-0">{name.slice(0, 1)}</div>
            <div>
              {/* flex + break-words, not inline-flex: a bare text node inside an
                  inline-flex box sizes to its content and overruns the strip
                  instead of wrapping. */}
              <h3 className="text-base font-bold text-slate-900 leading-tight flex items-start gap-2">
                <span className="break-words min-w-0">{name}</span>
                {loading && <Loader2 size={14} className="animate-spin text-indigo-500 shrink-0 mt-1" />}
              </h3>
              <p className="text-[11px] text-slate-400">{profile?.created_at ? `Vendor since ${String(profile.created_at).slice(0, 4)}` : (profile?.vendor_code || '')}</p>
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

      {/* KPI tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 sm:gap-3">
        <Tile icon={TrendingUp} tone="indigo" label="Total Purchase" value={fmtRup(totalPurchase)} sub="ex. GST" onClick={() => setDetail('purchase')} />
        <Tile icon={Wallet} tone="emerald" label="Paid" value={fmtRup(paid)} sub={`${pct(paid, grossPurchase)}% settled`} onClick={() => setDetail('paid')} />
        <Tile icon={AlertCircle} tone="rose" label="Outstanding" value={fmtRup(outstanding)} sub={`${num(stats?.outstanding_payables?.count)} unpaid`} onClick={() => setDetail('outstanding')} />
        <Tile icon={FileText} tone="sky" label="Bills" value={billCount.toLocaleString('en-IN')} sub={periodLabel} onClick={() => setDetail('bills')} />
        <Tile icon={Receipt} tone="violet" label="Avg Bill Value" value={fmtRup(avgBill)} sub="per bill · ex. GST" onClick={() => setDetail('avg')} />
        {/* Billed quantity, NOT goods received — the backend emits a separate
            receipt-sourced `quantity_received` that covers a different period.
            Labelling this "Received" would quietly conflate the two. */}
        <Tile icon={Package} tone="amber" label="Qty Billed" value={<span className="text-sm sm:text-base">{qtyStr}</span>} sub={`${num(qb.bill_count)} bill(s)`} onClick={() => setDetail('qty')} />
      </div>

      {/* Payables ledger + buckets */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card title="Payables" subtitle="Running ledger · reconciles to Tally">
          <div className="grid grid-cols-2 gap-2.5">
            <MiniStat label="Opening" value={ledger ? bal(ledger.opening_balance) : '—'} />
            <MiniStat label="Billed (Cr)" value={ledger ? fmtFull(ledger.current_credit) : '—'} />
            <MiniStat label="Paid (Dr)" value={ledger ? fmtFull(ledger.current_debit) : '—'} tone="emerald" />
            <MiniStat label="TDS Deducted" value={ledger && Number(ledger.current_tds) ? `${fmtFull(ledger.current_tds)}` : '—'} />
            <MiniStat label="Closing" value={ledger ? bal(ledger.closing_balance) : '—'} tone="rose" />
          </div>
          <p className="text-[11px] text-slate-400 mt-2.5">Outstanding payable · <span className="font-semibold text-orange-700">{fmtRup(outstanding)}</span></p>
        </Card>

        <Card title="Payment Buckets" subtitle="Bills by due date · this period · click a row to see the bills">
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
                    ? <button key={b.k} type="button" aria-label={`${b.label} — ${b.count} bill(s)`}
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
                    className={`w-full flex items-center justify-between text-xs rounded-lg px-1.5 py-1 transition ${b.count ? 'hover:bg-slate-50 cursor-pointer' : 'cursor-default'}`}>
                    <span className="inline-flex items-center gap-1.5 text-slate-500">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: b.color }} />{b.label}
                      <span className="text-slate-300">· {b.count}</span>
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className={`tabular-nums ${b.k === 'overdue_unpaid' && b.amount > 0 ? 'text-red-600 font-semibold' : 'text-slate-600'}`}>{b.amount > 0 ? fmtRup(b.amount) : '—'}</span>
                      {b.count ? <ChevronRight size={13} className="text-slate-400 shrink-0" /> : <span className="w-[13px] shrink-0" />}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : <p className="text-sm text-slate-400 py-8 text-center">No bills in this period.</p>}
        </Card>
      </div>

      {/* Purchase trend — Billed vs Paid */}
      {/* The backend's mom_trend is a fixed rolling 12 months — it takes no
          start/end — so this chart does NOT follow the period picker. Say so
          rather than labelling it with a period it doesn't honour. */}
      <Card title="Purchase Trend" subtitle="Billed vs paid · last 12 months · click a month to filter">
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
              <Line type="monotone" dataKey="billed" name="Billed" stroke="#6366f1" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
              <Line type="monotone" dataKey="paid" name="Paid" stroke="#10b981" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        ) : <p className="text-sm text-slate-400 py-12 text-center">No activity in the last 12 months.</p>}
      </Card>

      {/* Top products + timeline */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card title="Top Items" subtitle={`Share of billed value · ${periodLabel}`}>
          {prodChart.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={prodChart} dataKey="amount" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={92} paddingAngle={2}
                  onClick={(d) => d?.name && setDetail(`item:${d.name}`)} className="cursor-pointer">
                  {prodChart.map((_, k) => <Cell key={k} fill={PIE_COLORS[k % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={tooltipStyle}
                  formatter={(v, n, p) => [`${fmtFull(v)}${p?.payload?.qtyLabel ? ` · ${p.payload.qtyLabel}` : ''}`, n]} />
                <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
              </PieChart>
            </ResponsiveContainer>
          ) : <p className="text-sm text-slate-400 py-12 text-center">No billed items in {periodLabel}.</p>}
        </Card>

        <Card title="Activity Timeline" subtitle="Most recent transactions">
          {timeline.length ? (
            <div className="space-y-0">
              {timeline.map((t, i) => {
                // Green = money leaving us (payment / debit note), which is the
                // debit side on a vendor ledger — the mirror of the sales page.
                const pay = t.type === 'Payment' || t.type === 'Debit Note';
                const amt = num(t.debit) || num(t.credit);
                // Only bills carry a ref_id, so only they can open. Everything
                // else stays a plain row rather than looking clickable and
                // doing nothing.
                const open = t.type === 'Bill' && t.ref_id
                  ? () => navigate(`/purchase/bills/${t.ref_id}`, { state: { backTo: backHere() } })
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
        <Card title="Recent Bills" subtitle="Latest vendor bills / credit notes">
          {recentBills.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-y border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                  <tr><th className="px-3 py-2 text-left font-semibold">Doc No</th><th className="px-3 py-2 text-left font-semibold">Type</th>
                    <th className="px-3 py-2 text-left font-semibold">Date</th><th className="px-3 py-2 text-right font-semibold">Amount</th></tr>
                </thead>
                <tbody>
                  {recentBills.map((b, i) => (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="px-3 py-2 font-medium">
                        {b.type === 'Bill' && b.ref_id
                          ? <button type="button" onClick={() => navigate(`/purchase/bills/${b.ref_id}`, { state: { backTo: backHere() } })}
                              className="text-blue-700 hover:underline">{b.doc_no || '—'}</button>
                          : <span className="text-slate-700">{b.doc_no || '—'}</span>}
                      </td>
                      <td className="px-3 py-2"><span className={`inline-flex px-1.5 py-0.5 rounded text-[11px] font-medium ${typeCls(b.type)}`}>{b.type}</span></td>
                      <td className="px-3 py-2 text-slate-500">{fmtDate(b.date)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-800">{fmtFull(b.credit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="text-sm text-slate-400 py-8 text-center">No bills in this period.</p>}
        </Card>

        <Card title="Recent Payments" subtitle="Latest payments made">
          {recentPayments.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-y border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                  <tr><th className="px-3 py-2 text-left font-semibold">Payment</th><th className="px-3 py-2 text-left font-semibold">Date</th>
                    <th className="px-3 py-2 text-right font-semibold">Amount</th></tr>
                </thead>
                <tbody>
                  {recentPayments.map((p, i) => (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="px-3 py-2 font-medium text-emerald-700">{p.doc_no || 'Payment'}</td>
                      <td className="px-3 py-2 text-slate-500">{fmtDate(p.date)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-800">{fmtFull(p.debit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="text-sm text-slate-400 py-8 text-center">No payments in this period.</p>}
        </Card>
      </div>

      {/* KPI drill-down. Also serves the chart drills — a bucket segment opens
          "bucket:<key>", a pie slice opens "item:<name>". */}
      {detail && (() => {
        const bkt = detail.startsWith('bucket:') ? bucketRows.find(b => b.k === detail.slice(7)) : null;
        const item = detail.startsWith('item:') ? products.find(p => p.name === detail.slice(5)) : null;
        const T = bkt
          ? { title: bkt.label, value: fmtFull(bkt.amount), sub: `${bkt.count} bill(s) · ${periodLabel}` }
          : item
            ? { title: item.name, value: fmtFull(item.amount), sub: `${pct(item.amount, products.reduce((a, p) => a + p.amount, 0))}% of billed value · ${periodLabel}` }
            : {
              purchase:    { title: 'Total Purchase', value: fmtFull(totalPurchase), sub: `ex. GST · ${periodLabel}` },
              paid:        { title: 'Paid', value: fmtFull(paid), sub: `${pct(paid, grossPurchase)}% of gross billed value` },
              outstanding: { title: 'Outstanding', value: fmtFull(outstanding), sub: `${num(stats?.outstanding_payables?.count)} unpaid bill(s)` },
              bills:       { title: 'Bills', value: billCount.toLocaleString('en-IN'), sub: periodLabel },
              avg:         { title: 'Avg Bill Value', value: fmtFull(avgBill), sub: 'per bill · ex. GST' },
              qty:         { title: 'Qty Billed', value: qtyStr, sub: `${num(qb.bill_count)} bill(s)` },
            }[detail];
        // An unrecognised key would otherwise throw on T.title below.
        if (!T) return null;
        const billTable = allBills.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-y border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                <tr><th className="px-4 py-2 text-left font-semibold">Doc No</th><th className="px-4 py-2 text-left font-semibold">Date</th><th className="px-4 py-2 text-right font-semibold">Amount</th><th className="px-4 py-2 text-right font-semibold">Balance</th><th className="px-4 py-2 text-right font-semibold">Status</th></tr>
              </thead>
              <tbody>
                {allBills.map((b, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="px-4 py-2 font-medium">
                      {b.type === 'Bill' && b.ref_id
                        ? <button type="button" onClick={() => navigate(`/purchase/bills/${b.ref_id}`, { state: { backTo: backHere() } })} className="text-blue-700 hover:underline">{b.doc_no || '—'}</button>
                        : <span className="text-slate-700">{b.doc_no || '—'}</span>}
                    </td>
                    <td className="px-4 py-2 text-slate-500">{fmtDate(b.date)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-800">{fmtFull(b.credit)}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{(() => {
                      // Outstanding on this bill = amount − paid.
                      if (b.type !== 'Bill') return <span className="text-slate-300">—</span>;
                      const bal = num(b.credit) - num(b.paid);
                      return <span className={bal > 0.5 ? 'text-rose-600 font-medium' : 'text-slate-400'}>{bal > 0.5 ? fmtFull(bal) : '—'}</span>;
                    })()}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">{(() => {
                      // Paid / Partial (+ how much) / Not paid, from paid vs amount.
                      if (b.type !== 'Bill') return <span className="text-slate-300">—</span>;
                      const amt = num(b.credit), pd = num(b.paid);
                      if (amt > 0 && pd >= amt - 0.5) return <span className="inline-flex px-1.5 py-0.5 rounded text-[11px] font-medium bg-emerald-50 text-emerald-700">Paid</span>;
                      if (pd > 0) return (
                        <span className="inline-flex flex-col items-end leading-tight">
                          <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-50 text-amber-700">Partial</span>
                          <span className="text-[10px] text-slate-400 tabular-nums mt-0.5">{fmtFull(pd)} paid</span>
                        </span>);
                      return <span className="inline-flex px-1.5 py-0.5 rounded text-[11px] font-medium bg-rose-50 text-rose-700">Not paid</span>;
                    })()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-slate-400 py-8 text-center">No bills in {periodLabel}.</p>;
        return (
          <div className="fixed inset-0 z-[60] bg-slate-900/40 flex items-center justify-center p-4" onClick={() => setDetail(null)}>
            <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85dvh] flex flex-col" onClick={e => e.stopPropagation()}>
              <div className="flex items-start justify-between border-b border-slate-200 px-4 py-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-800">{T.title}</h3>
                  <p className="text-xl font-bold text-slate-900 tabular-nums leading-tight mt-0.5">{T.value}</p>
                  <p className="text-[11px] text-slate-400">{T.sub}</p>
                </div>
                <button onClick={() => setDetail(null)} aria-label="Close" className="p-1.5 rounded hover:bg-slate-100 text-slate-500 shrink-0"><X size={16} /></button>
              </div>
              <div className="overflow-auto">
                {bkt && (
                  bkt.rows.length ? (
                    <table className="w-full text-sm">
                      <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-y border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                        <tr><th className="px-4 py-2 text-left font-semibold">Bill No</th><th className="px-4 py-2 text-left font-semibold">Due</th>
                          <th className="px-4 py-2 text-left font-semibold">Age</th><th className="px-4 py-2 text-right font-semibold">Amount</th></tr>
                      </thead>
                      <tbody>
                        {bkt.rows.map((r, i) => (
                          <tr key={i} className="border-b border-slate-100">
                            <td className="px-4 py-2 font-medium">
                              {r.bill_id && !r.is_opening
                                ? <button type="button" onClick={() => navigate(`/purchase/bills/${r.bill_id}`, { state: { backTo: backHere() } })} className="text-blue-700 hover:underline">{r.bill_no || '—'}</button>
                                : <span className="text-slate-700">{r.bill_no || '—'}</span>}
                            </td>
                            <td className="px-4 py-2 text-slate-500">{fmtDate(r.due_date)}</td>
                            <td className="px-4 py-2 text-slate-500">{r.days_label || '—'}</td>
                            <td className="px-4 py-2 text-right tabular-nums text-slate-800">{fmtFull(r.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <p className="text-sm text-slate-400 py-8 text-center">No bills in this bucket.</p>
                )}
                {item && (
                  <div className="p-4 space-y-1.5">
                    {item.qtyLabel
                      ? <div className="flex items-center justify-between text-sm border-b border-slate-100 pb-1.5">
                          <span className="text-slate-500">Quantity billed</span>
                          <span className="tabular-nums font-semibold text-slate-800">{item.qtyLabel}</span>
                        </div>
                      : null}
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-500">Value</span>
                      <span className="tabular-nums font-semibold text-slate-800">{fmtFull(item.amount)}</span>
                    </div>
                    <p className="text-[11px] text-slate-400 pt-1">Billed value for this item in {periodLabel}.</p>
                  </div>
                )}
                {detail === 'purchase' && (
                  // The table lists bills at their GROSS value while the headline
                  // is ex-GST, so show both. Deliberately NOT written as an
                  // equation: `taxable` now INCLUDES on-bill charges (so Charges
                  // below is a subset of Ex-GST, not an addition), and TDS /
                  // round-off also sit between the figures, so
                  // "Ex-GST + GST = Incl. GST" would not add up.
                  <div className="px-4 py-3 border-b border-slate-100 space-y-1">
                    {[['Ex-GST', totalPurchase], ['GST', gstPurchase],
                      ...(num(tp.charges) ? [['Charges', num(tp.charges)]] : []),
                      ...(num(tp.tds) ? [['TDS', num(tp.tds)]] : []),
                      ['Incl. GST', grossPurchase]].map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between text-sm">
                        <span className="text-slate-500">{k}</span>
                        <span className="tabular-nums font-semibold text-slate-800">{fmtFull(v)}</span>
                      </div>
                    ))}
                    <p className="text-[11px] text-slate-400 pt-0.5">Bills below are listed at their incl-GST value.</p>
                  </div>
                )}
                {(detail === 'purchase' || detail === 'bills') && billTable}
                {detail === 'avg' && (
                  <div>
                    <p className="text-sm text-slate-600 px-4 py-3 border-b border-slate-100">{fmtFull(totalPurchase)} total purchase ÷ {billCount || 0} bill(s) = <span className="font-semibold text-slate-900">{fmtFull(avgBill)}</span> per bill.</p>
                    {billTable}
                  </div>
                )}
                {detail === 'paid' && (
                  allPayments.length ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 border-y border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                          <tr><th className="px-4 py-2 text-left font-semibold">Payment</th><th className="px-4 py-2 text-left font-semibold">Date</th><th className="px-4 py-2 text-right font-semibold">Amount</th></tr>
                        </thead>
                        <tbody>
                          {allPayments.map((p, i) => (
                            <tr key={i} className="border-b border-slate-100">
                              <td className="px-4 py-2 font-medium text-emerald-700">{p.doc_no || 'Payment'}</td>
                              <td className="px-4 py-2 text-slate-500">{fmtDate(p.date)}</td>
                              <td className="px-4 py-2 text-right tabular-nums text-slate-800">{fmtFull(p.debit)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : <p className="text-sm text-slate-400 py-8 text-center">No payments in {periodLabel}.</p>
                )}
                {detail === 'outstanding' && (
                  <div className="p-4 space-y-3">
                    <div className="grid grid-cols-2 gap-2.5">
                      <MiniStat label="Opening" value={ledger ? bal(ledger.opening_balance) : '—'} />
                      <MiniStat label="Billed (Cr)" value={ledger ? fmtFull(ledger.current_credit) : '—'} />
                      <MiniStat label="Paid (Dr)" value={ledger ? fmtFull(ledger.current_debit) : '—'} tone="emerald" />
                      <MiniStat label="Closing" value={ledger ? bal(ledger.closing_balance) : '—'} tone="rose" />
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold mb-1.5">By due date</p>
                      <div className="space-y-1.5">
                        {bucketRows.map(b => (
                          <div key={b.k} className="flex items-center justify-between text-sm">
                            <span className="inline-flex items-center gap-1.5 text-slate-600"><span className="w-2.5 h-2.5 rounded-full" style={{ background: b.color }} />{b.label} <span className="text-slate-300">· {b.count}</span></span>
                            <span className="tabular-nums text-slate-700">{b.amount > 0 ? fmtFull(b.amount) : '—'}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                {detail === 'qty' && (
                  <div className="p-4">
                    {(qb.uom_breakdown || []).length ? (
                      <div className="space-y-1.5">
                        {qb.uom_breakdown.map((u, i) => (
                          <div key={i} className="flex items-center justify-between text-sm border-b border-slate-100 pb-1.5">
                            <span className="text-slate-500">{u.uom}</span>
                            <span className="tabular-nums font-semibold text-slate-800">{fmtQty(u.qty)} {u.uom}</span>
                          </div>
                        ))}
                        <p className="text-[11px] text-slate-400 pt-1">across {num(qb.bill_count)} bill(s)</p>
                      </div>
                    ) : <p className="text-sm text-slate-400 py-8 text-center">Nothing billed in {periodLabel}.</p>}
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
export default function VendorInsights() {
  const { options: companyOptions } = useLookup('/api/companies/');
  // Company, vendor and period come from the address (mirrored to the session),
  // so a company/period picked on Purchase Analytics or the Purchase Dashboard
  // is still applied here, and Back returns you there still filtered. The param
  // names are shared by all three pages -- see components/purchaseFilter.js.
  const f = usePurchaseFilter({ period: 'fy' });
  const company = f.get('company');
  const setCompany = (v) => f.setFilter({ company: v, vendor: '' });
  // The vendor being examined IS the shared `vendor` filter, so picking one on
  // Analytics opens this page already on that vendor.
  const id = f.get('vendor');
  // Opening a vendor is a DESTINATION, so it pushes a history entry; clearing
  // one replaces. That is what makes the browser's Back return to the vendor
  // list instead of skipping the page entirely and landing on Analytics.
  const setId = (v) => f.setFilter({ vendor: v }, { push: !!v });
  // Opening a vendor from a long list and coming back used to dump you at the
  // top of the page. The list is tall, the detail view is short, so there is
  // nothing to scroll back to at the moment the browser tries. Remember the
  // position on the way in and put it back on the way out. Navigation comfort
  // only — no figure, filter or request is affected.
  const SCROLL_KEY = 'vendor-insights-scroll';
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
  // The SHARED period hook, not another private copy of the navigator helpers —
  // Customer Insights carries its own, which is the 7th duplicate of that block.
  const period = usePeriodFilter(f.get('period', 'fy'), {
    anchor: f.get('anchor') || undefined,
    customFrom: f.get('from') || undefined,
    customTo: f.get('to') || undefined,
  });
  // usePeriodFilter('fy') never yields null, but effWindow returns null for
  // 'all' — guard anyway so a future picker change can't crash the page.
  // usePeriodFilter owns the navigator's state, so push it back to the address
  // whenever it moves -- only on a real change, or the write would loop.
  const np = period.navProps;
  useEffect(() => {
    const patch = {
      period: np.period,
      anchor: (np.period !== 'custom') ? np.anchor : '',
      from: np.period === 'custom' ? np.customFrom : '',
      to: np.period === 'custom' ? np.customTo : '',
    };
    const stale = Object.entries(patch).some(([k, v]) => (f.get(k) || '') !== (v || ''));
    if (stale) f.setFilter(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [np.period, np.anchor, np.customFrom, np.customTo]);

  const win = period.range || { from: todayISO(), to: todayISO() };
  const periodLabel = periodLabelOf(period.period, period.range);

  const vendUrl = company
    ? `/api/vendors/?company=${company}&has_purchases=true&slim=1`
    : '/api/vendors/?has_purchases=true&slim=1';
  const { options: vendors, isLoading: vendLoading } =
    useLookup(vendUrl, { labelField: 'vendor_name' });

  const companyChips = (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {companyOptions.map(co => {
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
  );

  return (
    <MainLayout>
      <PageHeader
        title="Vendor Insights"
        subtitle="360° view of a vendor — purchases, payables & payment history"
        icon={Sparkles}
        breadcrumbs={[{ label: 'Purchase', href: '/purchase/dashboard' }, { label: 'Vendor Insights' }]}
        actions={{ right: companyChips }}
        onBack={id ? () => setIdKeepingScroll('') : undefined}
      />

      {/* Period filter — detail page only, like the sales side. */}
      {id && (
        <div className="bg-white rounded-lg border border-slate-200 mb-4 px-3 py-2 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 font-medium"><SlidersHorizontal size={14} /> Period</span>
          <PeriodNavigator {...period.navProps} />
          <span className="text-[11px] text-slate-400 tabular-nums ml-auto">{periodLabel}</span>
          {period.period !== 'fy' && (
            <button onClick={() => { period.navProps.setPeriod('fy'); period.navProps.setAnchor(fyTokenFor(new Date())); }}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-indigo-600 border border-slate-200 rounded-lg px-2 py-1">
              Reset
            </button>
          )}
        </div>
      )}

      <Vendor360 vendors={vendors} vendLoading={vendLoading} company={company} id={id} setId={setIdKeepingScroll}
        onPickMonth={(m) => { period.navProps.setAnchor(`${m}-01`); period.navProps.setPeriod('month'); }}
        from={win.from} to={win.to} periodLabel={periodLabel} />
    </MainLayout>
  );
}
