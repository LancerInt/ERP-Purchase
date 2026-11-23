import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import useLookup from '../../../hooks/useLookup.js';
import apiClient from '../../../utils/api.js';
import { formatCurrency } from '@/utils/formatters';
import exportToExcel from '../../../utils/exportExcel.js';
import { billSource } from '../../purchase/bills/BillQuickView.jsx';
import toast from 'react-hot-toast';
import {
  PieChart, Loader2, TrendingUp, Users, ArrowLeftRight,
  ChevronLeft, ArrowRight, Search, Download, X, Calendar, AlertTriangle,
} from 'lucide-react';

const PAGE_SIZE = 15;
const monthKey = (d) => (d || '').slice(0, 7);
const monthLabel = (ym) => {
  if (!ym) return '—';
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
};
const num = (v) => Number(v) || 0;

// A bill is ERP-origin unless it was created by the Tally import. Reuses the
// SAME billSource() the Expense Bills page Source column uses, so the toggle
// ties to that page exactly. (TALLY = Apr–Sep Tally-imported; ERP = scanned /
// hand-entered, incl. Apr–Sep treated as ERP + Oct-onwards scans.)
const isTally = (b) => {
  const s = billSource(b);
  return s.inTally && !s.bornInErp;
};

// Headline KPI tile — one bluish-violet (indigo) chrome over a light backdrop,
// matching the Purchase / Sales Analytics KEY METRICS (teammate's tile
// redesign). Only the figure colour stays semantic. No icons, no left strip.
const HEAD_CHROME = {
  dot: 'bg-indigo-500', ring: 'focus-visible:ring-indigo-300',
  tint: 'bg-white border-indigo-400', hover: 'hover:border-transparent',
};
const HEAD_TONE = {
  spend:       { ...HEAD_CHROME, val: 'text-slate-900' },
  billed:      { ...HEAD_CHROME, val: 'text-slate-900' },
  paid:        { ...HEAD_CHROME, val: 'text-emerald-700' },
  categories:  { ...HEAD_CHROME, val: 'text-slate-900' },
  outstanding: { ...HEAD_CHROME, val: 'text-rose-600' },
};

function HeadCard({ label, value, context, tone = 'spend', onClick }) {
  const t = HEAD_TONE[tone] || HEAD_TONE.spend;
  const clickable = typeof onClick === 'function';
  const Tag = clickable ? 'button' : 'div';
  return (
    <Tag
      type={clickable ? 'button' : undefined}
      onClick={clickable ? onClick : undefined}
      className={`relative flex h-full w-full min-w-0 flex-col text-left rounded-lg border-2 ${t.tint} px-3 py-3 shadow-sm ${
        clickable
          ? `cursor-pointer transition hover:shadow-md ${t.hover} focus:outline-none focus-visible:ring-2 ${t.ring}`
          : `transition hover:shadow-md ${t.hover}`}`}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${t.dot}`} />
        <p className="text-xs sm:text-[13px] font-semibold uppercase tracking-[0.06em] text-slate-600 truncate">{label}</p>
      </div>
      <p className={`mt-1 text-lg sm:text-xl lg:text-2xl font-bold tracking-tight money leading-tight break-words ${t.val}`}>{value}</p>
      {context && <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{context}</p>}
    </Tag>
  );
}

// Expense Analytics — reads the SAME expense VendorBills the Expense Bills page
// shows (is_expense journals), so every figure ties to that page. Carries the
// Only-Tally / Only-ERP / Tally-vs-ERP source toggle (bill-origin based), a
// period bar + company chips, clickable tiles, a Records drill, an
// Outstanding-by-Age slide-over and a Monthly panel.
export default function ExpenseAnalyticsPage() {
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();

  // ── Filters (URL-driven) ─────────────────────────────────────────────
  const period = usePeriodFilter(sp.get('period') || 'month', {
    anchor: sp.get('anchor'), customFrom: sp.get('from'), customTo: sp.get('to'),
  });
  const [company, setCompany] = useState(sp.get('company') || '');
  // source: '' all | tally | scan(ERP). Mirrors Purchase Analytics.
  const [source, setSource] = useState(sp.get('source') || '');
  const [compareOpen, setCompareOpen] = useState(false);
  const view = sp.get('view') || '';          // '' | records
  const kind = sp.get('kind') || 'spend';     // spend | paid | outstanding
  const [agingOpen, setAgingOpen] = useState(false);

  const { options: companyOptions } = useLookup('/api/companies/', { labelField: 'company_code' });

  // SS Biochem is the default scope on every analytics page. Pre-select SS once
  // the company list loads (unless a company is already chosen); the user can
  // switch to United Agro or clear to see both for the session. Label here is the
  // company_code, so match the SS code as well as the legal name.
  const didDefaultCompany = useRef(false);
  useEffect(() => {
    if (didDefaultCompany.current) return;
    if (company) { didDefaultCompany.current = true; return; }
    const ss = (companyOptions || []).find((c) => /biochem/i.test(String(c.label)) || /^ss/i.test(String(c.label)));
    if (ss) { didDefaultCompany.current = true; setCompany(String(ss.value)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyOptions]);

  // Persist filters to the URL (replace).
  useEffect(() => {
    const p = new URLSearchParams(sp);
    const put = (k, val, keep) => { if (keep) p.set(k, val); else p.delete(k); };
    const np = period.navProps;
    put('period', np.period, np.period && np.period !== 'month');
    put('anchor', np.anchor, np.period !== 'all' && np.period !== 'custom' && !!np.anchor);
    put('from', np.customFrom, np.period === 'custom');
    put('to', np.customTo, np.period === 'custom');
    put('company', company, !!company);
    put('source', source, !!source);
    if (p.toString() !== sp.toString()) setSp(p, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.navProps, company, source]);

  // ── Data: the expense bills (same endpoint + universe as Expense Bills) ──
  const [bills, setBills] = useState([]);
  const [loading, setLoading] = useState(false);
  // Actual cash paid on EXPENSE in the window, from PaymentMade (the payment
  // hub), not bill.amount_paid — so Amount Paid here is the same money the
  // Payment Entries 'Expense' category shows and ties the Purchase/Freight
  // split. { PURCHASE, FREIGHT, EXPENSE } totals for the period + company.
  const [paidByCat, setPaidByCat] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const r = period.range;
    const iso = (v) => (typeof v === 'string' ? v.slice(0, 10) : '');
    const qp = new URLSearchParams({ period: period.period });
    if (r?.from) qp.set('from', iso(r.from));
    if (r?.to) qp.set('to', iso(r.to));
    if (company) qp.set('company', company);
    apiClient.get(`/api/purchase/dashboard/paid-by-category/?${qp.toString()}`)
      .then(({ data }) => { if (!cancelled) setPaidByCat(data); })
      .catch(() => { if (!cancelled) setPaidByCat(null); });
    return () => { cancelled = true; };
  }, [period.range?.from, period.range?.to, period.period, company]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const r = period.range;
    const iso = (v) => (typeof v === 'string' ? v.slice(0, 10) : '');
    const dates = (r?.from ? `&bill_date_from=${iso(r.from)}` : '')
      + (r?.to ? `&bill_date_to=${iso(r.to)}` : '');

    // The bills endpoint PAGINATES — fetch every page the same way useApiData
    // does: page_size=500 and iterate by `page=N` using `count` (NOT by
    // following the absolute `next` URL, which can point at a host axios won't
    // reuse the baseURL for). A single raw GET returns only the first page, so
    // the expense subset came back empty → every tile read ₹0, and later
    // months (e.g. October) silently dropped off.
    const base = `/api/purchase/bills/?slim=list&page_size=500${dates}`;
    (async () => {
      try {
        const all = [];
        const first = await apiClient.get(`${base}&page=1`);
        const d0 = first.data;
        const page0 = Array.isArray(d0) ? d0 : (d0?.results || []);
        all.push(...page0);
        const count = (!Array.isArray(d0) && d0?.count) || page0.length;
        const pageSize = page0.length || 500;
        const totalPages = Math.max(1, Math.ceil(count / pageSize));
        for (let pg = 2; pg <= totalPages; pg += 1) {
          const { data } = await apiClient.get(`${base}&page=${pg}`);
          const rows = Array.isArray(data) ? data : (data?.results || []);
          all.push(...rows);
        }
        if (cancelled) return;
        // Expense universe: a bill flagged is_expense OR booked as a Tally
        // journal. The old test (category_source==='voucher_type') only matched
        // TALLY-imported journals, so SCANNED expense bills (Oct onwards, which
        // carry category_source='expense_flag') dropped off entirely. Not
        // cancelled, not an opening carrier, not a branch transfer.
        const exp = all.filter((b) =>
          (b.is_expense === true || (b.tally_voucher_type || '').toLowerCase().includes('journal'))
          && !b.is_branch_transfer
          && b.status !== 'CANCELLED'
          && !(b.tally_guid || '').startsWith('OPENING'));
        setBills(exp);
      } catch {
        if (!cancelled) toast.error('Could not load expense bills.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [period.range?.from, period.range?.to]);

  // ── Scoped rows: company + source toggle ─────────────────────────────
  const scoped = useMemo(() => bills.filter((b) => {
    if (company && String(b.company || b.company_id || '') !== String(company)
        && !(!('company' in b) && !('company_id' in b))) {
      // company may only be on company_name; fall through when unknown
      if (b.company_name && companyOptions?.length) {
        const match = companyOptions.find((c) => String(c.value) === String(company));
        if (match && b.company_name !== match.label && b.company_code !== match.label) return false;
      }
    }
    if (source === 'tally' && !isTally(b)) return false;
    if (source === 'scan' && isTally(b)) return false;
    return true;
  }), [bills, company, source, companyOptions]);

  // ── KPI figures (all from the scoped expense bills) ──────────────────
  const totalSpend = useMemo(() => scoped.reduce((s, b) => s + num(b.total_amount), 0), [scoped]);
  const billed = totalSpend;
  const billCount = scoped.length;
  // Prefer the real cash paid on EXPENSE (payment hub); fall back to summing
  // bill.amount_paid if the endpoint is unavailable.
  const amountPaidBills = useMemo(() => scoped.reduce((s, b) => s + num(b.amount_paid), 0), [scoped]);
  const amountPaid = paidByCat && paidByCat.expense != null
    ? num(paidByCat.expense) : amountPaidBills;
  const outstanding = useMemo(() => scoped.reduce((s, b) => s + num(b.balance_due), 0), [scoped]);

  // Category breakdown by the bill's Tally expense_subcategory.
  const byCategory = useMemo(() => {
    const m = new Map();
    scoped.forEach((b) => {
      const key = (b.expense_subcategory || '').trim() || 'Uncategorised';
      const cur = m.get(key) || { category: key, total: 0, count: 0 };
      cur.total += num(b.total_amount); cur.count += 1; m.set(key, cur);
    });
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [scoped]);
  const categoriesUsed = byCategory.filter((c) => c.total > 0 && c.category !== 'Uncategorised').length;
  const grandCat = byCategory.reduce((s, c) => s + c.total, 0);

  // Top parties by outstanding (unpaid balance), from the same bills.
  const topParties = useMemo(() => {
    const m = new Map();
    scoped.forEach((b) => {
      const bal = num(b.balance_due);
      if (bal <= 0) return;
      const k = b.vendor_name || '—';
      m.set(k, (m.get(k) || 0) + bal);
    });
    return [...m.entries()].map(([party, out]) => ({ party, out }))
      .sort((a, b) => b.out - a.out).slice(0, 8);
  }, [scoped]);
  const maxParty = topParties.reduce((m, r) => Math.max(m, r.out), 0);

  // Tally-vs-ERP compare (ignores the active source filter — always both).
  const compare = useMemo(() => {
    const t = { count: 0, value: 0 }, e = { count: 0, value: 0 };
    bills.forEach((b) => {
      const bucket = isTally(b) ? t : e;
      bucket.count += 1; bucket.value += num(b.total_amount);
    });
    return { tally: t, erp: e, diff: Math.abs(t.value - e.value) };
  }, [bills]);

  const rangeLabel = period.range ? `${period.range.from} → ${period.range.to}` : 'all time';

  // ── Drill navigation ─────────────────────────────────────────────────
  const openRecords = (k, cat) => {
    const p = new URLSearchParams(sp);
    p.set('view', 'records'); p.set('kind', k);
    if (cat) p.set('cat', cat); else p.delete('cat');
    setSp(p);
  };
  const closeDrill = () => {
    const p = new URLSearchParams(sp);
    p.delete('view'); p.delete('kind'); p.delete('cat');
    setSp(p);
  };

  // ============ RECORDS DRILL ============
  if (view === 'records') {
    return (
      <MainLayout>
        <PageHeader
          compact
          title="Expense Analytics"
          subtitle="Records"
          breadcrumbs={[{ label: 'Expenses' }, { label: 'Analytics' }, { label: 'Records' }]}
        />
        <button onClick={closeDrill} className="inline-flex items-center gap-1.5 mb-3 text-sm text-slate-600 hover:text-slate-900">
          <ChevronLeft size={16} /> Back to analytics
        </button>
        <RecordsDrill
          kind={kind}
          initialCat={sp.get('cat') || ''}
          bills={scoped}
          topParties={topParties}
          rangeLabel={rangeLabel}
          navigate={navigate}
        />
      </MainLayout>
    );
  }

  // ============ MAIN ============
  return (
    <MainLayout>
      <PageHeader
        title="Expense Analytics"
        subtitle="Spend overview, category breakdown and outstanding payables"
        breadcrumbs={[{ label: 'Expenses' }, { label: 'Analytics' }]}
      />

      {/* Filter bar */}
      <div className="mb-4 rounded-xl border border-slate-200 bg-white p-3 sm:p-4 flex flex-wrap items-center gap-3">
        <PeriodNavigator allowAll {...period.navProps} />
        {companyOptions?.length > 1 && (
          <div className="flex rounded-lg border border-slate-300 overflow-hidden h-9">
            <button
              onClick={() => setCompany('')}
              className={`px-3 text-xs font-medium ${!company ? 'bg-primary-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            >All</button>
            {companyOptions.map((c) => (
              <button
                key={c.value}
                onClick={() => setCompany(String(c.value))}
                className={`px-3 text-xs font-medium border-l border-slate-300 ${String(company) === String(c.value) ? 'bg-primary-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
              >{c.label}</button>
            ))}
          </div>
        )}
        {/* Source toggle — Only Tally / Only ERP + Tally-vs-ERP compare */}
        <div className="flex items-center gap-2 ml-auto">
          <div className="flex rounded-lg border border-slate-300 overflow-hidden h-9">
            {[['tally', 'Only Tally'], ['scan', 'Only ERP']].map(([v, l], i) => (
              <button
                key={v}
                onClick={() => setSource(source === v ? '' : v)}
                className={`px-3 text-xs font-medium ${i ? 'border-l border-slate-300' : ''} ${source === v ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
              >{l}</button>
            ))}
          </div>
          <button
            onClick={() => setCompareOpen(true)}
            className="h-9 px-3 inline-flex items-center gap-1.5 text-xs font-medium border border-slate-300 rounded-lg text-indigo-700 hover:bg-indigo-50"
          >
            <ArrowLeftRight size={14} /> Tally vs ERP
          </button>
        </div>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2.5 sm:gap-3 mb-4">
        <HeadCard tone="spend" label={`Total Spend (${period.period === 'all' ? 'all time' : rangeLabel})`}
          value={formatCurrency(totalSpend)} onClick={() => openRecords('spend')} />
        <HeadCard tone="paid" label="Amount Paid" value={formatCurrency(amountPaid)}
          onClick={() => openRecords('paid')} />
        <HeadCard tone="billed" label="Bills" value={billCount.toLocaleString('en-IN')}
          onClick={() => openRecords('spend')} />
        <HeadCard tone="categories" label="Categories" value={categoriesUsed.toLocaleString('en-IN')} />
        <HeadCard tone="outstanding" label="Outstanding" value={formatCurrency(outstanding)}
          onClick={() => setAgingOpen(true)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Spend by category */}
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-blue-500" />
            <h3 className="text-sm font-semibold text-slate-800">Spend by Category</h3>
            <button onClick={() => openRecords('spend')} className="ml-auto text-xs text-primary-600 hover:underline inline-flex items-center gap-1">
              Records <ArrowRight size={12} />
            </button>
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-16 text-slate-400"><Loader2 className="w-6 h-6 animate-spin" /></div>
          ) : byCategory.length === 0 ? (
            <div className="py-14 text-center text-slate-500 text-sm">
              <PieChart className="w-8 h-8 mx-auto mb-2 text-slate-300" />
              No expense bills in this range.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[460px]">
                <thead>
                  <tr className="bg-slate-50 border-b text-left text-slate-500 text-xs uppercase tracking-wide">
                    <th className="px-4 py-2.5 font-semibold">Category</th>
                    <th className="px-4 py-2.5 font-semibold text-right">Bills</th>
                    <th className="px-4 py-2.5 font-semibold text-right">Amount</th>
                    <th className="px-4 py-2.5 font-semibold w-1/3">Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {byCategory.map((r) => {
                    const pct = grandCat > 0 ? (r.total / grandCat) * 100 : 0;
                    const uncat = r.category === 'Uncategorised';
                    return (
                      <tr
                        key={r.category}
                        onClick={() => openRecords('spend', r.category)}
                        className="hover:bg-slate-50 cursor-pointer"
                        title={`View ${r.category} bills`}
                      >
                        <td className="px-4 py-2.5 font-medium text-primary-700 whitespace-nowrap">
                          {r.category}
                          {uncat && <span className="ml-1.5 text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">no category</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{r.count}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-900 whitespace-nowrap">{formatCurrency(r.total)}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                              <div className={`h-full rounded-full ${uncat ? 'bg-amber-400' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
                            </div>
                            <span className="w-9 text-right text-xs tabular-nums text-slate-500">{pct.toFixed(0)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Top outstanding parties */}
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-rose-500" />
              <h3 className="text-sm font-semibold text-slate-800">Top Outstanding Parties</h3>
            </div>
            <button onClick={() => setAgingOpen(true)} className="text-xs text-primary-600 hover:underline inline-flex items-center gap-1">
              By age <ArrowRight size={12} />
            </button>
          </div>
          {topParties.length === 0 ? (
            <div className="py-14 text-center text-slate-500 text-sm">Nothing outstanding.</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {topParties.map((r) => {
                const pct = maxParty > 0 ? (r.out / maxParty) * 100 : 0;
                return (
                  <div key={r.party} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-3 mb-1">
                      <span className="text-sm font-medium text-slate-800 truncate">{r.party}</span>
                      <span className="text-sm font-semibold text-slate-900 tabular-nums whitespace-nowrap">{formatCurrency(r.out)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                      <div className="h-full rounded-full bg-rose-400" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Monthly spend */}
      <MonthlyPanel bills={scoped} />

      {/* Outstanding-by-Age slide-over (client-side, per-bill balance) */}
      <AgingDrawer open={agingOpen} onClose={() => setAgingOpen(false)} bills={scoped}
        onViewAll={() => navigate('/expenses/bills')} />

      {/* Tally vs ERP compare modal */}
      {compareOpen && (
        <CompareModal compare={compare} onClose={() => setCompareOpen(false)} />
      )}
    </MainLayout>
  );
}

// ── Records drill: List / By Month / By Category / By Party, over bills ──
function RecordsDrill({ kind, initialCat = '', bills, topParties, rangeLabel, navigate }) {
  const [pivot, setPivot] = useState('list');
  const [q, setQ] = useState('');
  const [catFilter, setCatFilter] = useState(initialCat);
  const [page, setPage] = useState(0);

  const title = { spend: 'Expense Bills', paid: 'Amount Paid', outstanding: 'Outstanding' }[kind] || 'Records';

  const baseRows = useMemo(() => {
    if (kind === 'outstanding') {
      return bills.filter((b) => num(b.balance_due) > 0).map((b) => ({
        date: b.bill_date, ref: b.bill_no || '', party: b.vendor_name || '—',
        category: (b.expense_subcategory || '').trim() || 'Uncategorised',
        label: b.status || '', amount: num(b.balance_due), id: b.id,
      }));
    }
    const amtKey = kind === 'paid' ? 'amount_paid' : 'total_amount';
    return bills
      .filter((b) => (kind === 'paid' ? num(b.amount_paid) > 0 : true))
      .map((b) => ({
        date: b.bill_date, ref: b.bill_no || '', party: b.vendor_name || '—',
        category: (b.expense_subcategory || '').trim() || 'Uncategorised',
        label: b.status || '', amount: num(b[amtKey]), id: b.id,
      }));
  }, [kind, bills]);

  const filtered = useMemo(() => {
    let rows = baseRows;
    if (catFilter) rows = rows.filter((r) => r.category === catFilter);
    const t = q.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter((r) =>
      [r.ref, r.party, r.category, r.label].some((v) => (v || '').toLowerCase().includes(t)));
  }, [baseRows, q, catFilter]);

  const total = useMemo(() => filtered.reduce((s, r) => s + r.amount, 0), [filtered]);

  const pivotRows = useMemo(() => {
    if (pivot === 'list') return null;
    const keyer = {
      month: (r) => monthLabel(monthKey(r.date)),
      category: (r) => r.category || 'Uncategorised',
      party: (r) => r.party || '—',
    }[pivot];
    const m = new Map();
    filtered.forEach((r) => {
      const k = keyer(r) || '—';
      const cur = m.get(k) || { group: k, total: 0, count: 0, sort: monthKey(r.date) };
      cur.total += r.amount; cur.count += 1; m.set(k, cur);
    });
    const arr = [...m.values()];
    if (pivot === 'month') arr.sort((a, b) => (a.sort < b.sort ? 1 : -1));
    else arr.sort((a, b) => b.total - a.total);
    return arr;
  }, [pivot, filtered]);

  const pivots = [['list', 'Records'], ['month', 'By Month'], ['category', 'By Category'], ['party', 'By Party']];
  useEffect(() => { setPage(0); }, [pivot, q, kind, catFilter]);

  const rows = pivotRows || filtered;
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const doExport = () => {
    if (pivotRows) {
      const data = pivotRows.map((r) => ({ group: r.group, count: r.count, total: r.total }));
      const cols = [
        { field: 'group', header: pivot === 'month' ? 'Month' : pivot === 'category' ? 'Category' : 'Party' },
        { field: 'count', header: 'Bills' }, { field: 'total', header: 'Amount' },
      ];
      exportToExcel(data, cols, `expense-${kind}-${pivot}`, 'Sheet1');
      return;
    }
    const cols = [
      { field: 'date', header: 'Date' }, { field: 'ref', header: 'Bill No' },
      { field: 'party', header: 'Vendor' }, { field: 'category', header: 'Category' },
      { field: 'label', header: 'Status' }, { field: 'amount', header: 'Amount' },
    ];
    exportToExcel(filtered, cols, `expense-${kind}`, 'Sheet1');
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        <span className="text-xs text-slate-400">{rangeLabel}</span>
        {catFilter && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-primary-700 bg-primary-50 border border-primary-200 px-2 py-0.5 rounded">
            {catFilter}
            <button onClick={() => setCatFilter('')} className="hover:text-primary-900" aria-label="Clear category"><X size={11} /></button>
          </span>
        )}
        <span className="ml-auto text-sm font-semibold text-slate-900 tabular-nums">{formatCurrency(total)}</span>
      </div>

      <div className="px-4 py-2.5 border-b border-slate-100 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-slate-300 overflow-hidden h-8">
          {pivots.map(([v, l], i) => (
            <button key={v} onClick={() => setPivot(v)}
              className={`px-3 text-xs font-medium ${i ? 'border-l border-slate-300' : ''} ${pivot === v ? 'bg-primary-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{l}</button>
          ))}
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…"
            className="h-8 pl-8 pr-7 text-sm border border-slate-300 rounded-lg w-44" />
          {q && <button onClick={() => setQ('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400"><X size={13} /></button>}
        </div>
        <button onClick={doExport} className="h-8 px-3 inline-flex items-center gap-1.5 text-xs font-medium border border-slate-300 rounded-lg text-slate-600 hover:bg-slate-50 ml-auto">
          <Download size={13} /> Export
        </button>
      </div>

      <div className="overflow-x-auto">
        {pivotRows ? (
          <table className="w-full text-sm min-w-[420px]">
            <thead>
              <tr className="bg-slate-50 border-b text-left text-slate-500 text-xs uppercase tracking-wide">
                <th className="px-4 py-2.5 font-semibold">{pivot === 'month' ? 'Month' : pivot === 'category' ? 'Category' : 'Party'}</th>
                <th className="px-4 py-2.5 font-semibold text-right">Bills</th>
                <th className="px-4 py-2.5 font-semibold text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pageRows.map((r) => (
                <tr key={r.group} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-medium text-slate-800">{r.group}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{r.count}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-900 whitespace-nowrap">{formatCurrency(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-sm min-w-[620px]">
            <thead>
              <tr className="bg-slate-50 border-b text-left text-slate-500 text-xs uppercase tracking-wide">
                <th className="px-4 py-2.5 font-semibold">Date</th>
                <th className="px-4 py-2.5 font-semibold">Bill No</th>
                <th className="px-4 py-2.5 font-semibold">Vendor</th>
                <th className="px-4 py-2.5 font-semibold">Category</th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
                <th className="px-4 py-2.5 font-semibold text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pageRows.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400">No bills.</td></tr>
              ) : pageRows.map((r) => {
                const link = r.party && r.party !== '—'
                  ? `/expenses/bills?vend=${encodeURIComponent(r.party)}` : '';
                return (
                <tr key={r.id} onClick={link ? () => navigate(link) : undefined}
                  className={`hover:bg-slate-50 ${link ? 'cursor-pointer' : ''}`} title={link ? 'Open in Expense Bills' : undefined}>
                  <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">{r.date}</td>
                  <td className={`px-4 py-2.5 font-medium whitespace-nowrap ${link ? 'text-primary-600' : 'text-slate-600'}`}>{r.ref || '—'}</td>
                  <td className="px-4 py-2.5 text-slate-800 font-medium">{r.party}</td>
                  <td className="px-4 py-2.5 text-slate-600">{r.category}</td>
                  <td className="px-4 py-2.5 text-slate-500">{r.label}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-900 whitespace-nowrap">{formatCurrency(r.amount)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {pageCount > 1 && (
        <div className="px-4 py-2.5 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
          <span>Page {page + 1} of {pageCount} · {rows.length} rows</span>
          <div className="flex gap-1.5">
            <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="px-2.5 py-1 border border-slate-300 rounded disabled:opacity-40">Prev</button>
            <button disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)} className="px-2.5 py-1 border border-slate-300 rounded disabled:opacity-40">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Monthly spend panel (billed / paid / outstanding per month) ─────────
function MonthlyPanel({ bills }) {
  const months = useMemo(() => {
    const m = new Map();
    bills.forEach((b) => {
      const k = monthKey(b.bill_date);
      if (!k) return;
      const cur = m.get(k) || { month: k, label: monthLabel(k), billed: 0, paid: 0, outstanding: 0, count: 0 };
      cur.billed += num(b.total_amount);
      cur.paid += num(b.amount_paid);
      cur.outstanding += num(b.balance_due);
      cur.count += 1;
      m.set(k, cur);
    });
    return [...m.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
  }, [bills]);
  const totalBilled = months.reduce((s, m) => s + m.billed, 0);

  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
        <Calendar className="w-4 h-4 text-indigo-500" />
        <h3 className="text-sm font-semibold text-slate-800">Monthly Spend</h3>
        <span className="ml-auto text-sm font-semibold text-slate-900 tabular-nums">{formatCurrency(totalBilled)}</span>
      </div>
      {months.length === 0 ? (
        <div className="py-12 text-center text-slate-500 text-sm">No expense bills in this range.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="bg-slate-50 border-b text-left text-slate-500 text-xs uppercase tracking-wide">
                <th className="px-4 py-2.5 font-semibold">Month</th>
                <th className="px-4 py-2.5 font-semibold text-right">Bills</th>
                <th className="px-4 py-2.5 font-semibold text-right">Billed</th>
                <th className="px-4 py-2.5 font-semibold text-right">Paid</th>
                <th className="px-4 py-2.5 font-semibold text-right">Outstanding</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {months.map((m) => (
                <tr key={m.month} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-medium text-slate-800 whitespace-nowrap">{m.label}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{m.count}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-900 whitespace-nowrap">{formatCurrency(m.billed)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-emerald-700 whitespace-nowrap">{formatCurrency(m.paid)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-rose-600 whitespace-nowrap">{formatCurrency(m.outstanding)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Outstanding-by-Age slide-over (client-side, per-bill balance) ───────
const AGE_BUCKETS = [
  { key: '0_30', label: '0–30 days', bar: 'bg-emerald-500', lo: 0, hi: 30 },
  { key: '31_60', label: '31–60 days', bar: 'bg-sky-500', lo: 31, hi: 60 },
  { key: '61_90', label: '61–90 days', bar: 'bg-amber-500', lo: 61, hi: 90 },
  { key: '91_180', label: '91–180 days', bar: 'bg-orange-500', lo: 91, hi: 180 },
  { key: '180p', label: '180+ days', bar: 'bg-rose-500', lo: 181, hi: 1e9 },
];

function AgingDrawer({ open, onClose, bills, onViewAll }) {
  const [expanded, setExpanded] = useState(null);
  const today = new Date();
  const buckets = useMemo(() => {
    const agg = AGE_BUCKETS.map((b) => ({ ...b, count: 0, total: 0, preview: [] }));
    bills.forEach((b) => {
      const bal = num(b.balance_due);
      if (bal <= 0) return;
      const d = b.bill_date ? new Date(b.bill_date) : today;
      const days = Math.max(0, Math.floor((today - d) / 86400000));
      const slot = agg.find((x) => days >= x.lo && days <= x.hi);
      if (!slot) return;
      slot.count += 1; slot.total += bal;
      if (slot.preview.length < 3) slot.preview.push({ party: b.vendor_name || '—', no: b.bill_no, days, out: bal });
    });
    return agg;
  }, [bills]);
  const grand = buckets.reduce((s, b) => s + b.total, 0);
  const urgent = buckets.filter((b) => b.key === '91_180' || b.key === '180p').reduce((s, b) => s + b.total, 0);

  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden="true" />}
      <div className={`fixed inset-y-0 right-0 z-50 w-[420px] max-w-[92vw] bg-white shadow-2xl transition-transform duration-200 ease-out flex flex-col ${open ? 'translate-x-0' : 'translate-x-full'}`}
        role="dialog" aria-modal="true" aria-label="Outstanding by age">
        <div className="flex items-center justify-between px-4 h-14 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-800">Outstanding by Age</h3>
            {urgent > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-700 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded">
                <AlertTriangle size={11} /> 91+ days {formatCurrency(urgent)}
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-2 -mr-2 text-slate-500 hover:text-slate-700 rounded-lg" aria-label="Close"><X size={18} /></button>
        </div>
        <div className="p-4 overflow-y-auto">
          <div className="mb-1 text-xs text-slate-500">Total outstanding</div>
          <div className="text-xl font-bold text-slate-900 mb-3 tabular-nums">{formatCurrency(grand)}</div>
          <div className="flex h-3 rounded-full overflow-hidden bg-slate-100 mb-4">
            {buckets.map((b) => {
              const pct = grand > 0 ? (b.total / grand) * 100 : 0;
              return pct > 0 ? <button key={b.key} onClick={() => setExpanded(expanded === b.key ? null : b.key)} className={`${b.bar} h-full`} style={{ width: `${pct}%` }} title={`${b.label}: ${formatCurrency(b.total)}`} /> : null;
            })}
          </div>
          <div className="space-y-1.5">
            {buckets.map((b) => {
              const isOpen = expanded === b.key;
              return (
                <div key={b.key} className="border border-slate-200 rounded-lg overflow-hidden">
                  <button onClick={() => setExpanded(isOpen ? null : b.key)} className="w-full flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-slate-50 text-left">
                    <span className="flex items-center gap-2">
                      <span className={`w-2.5 h-2.5 rounded-full ${b.bar}`} />
                      <span className="text-sm font-medium text-slate-800">{b.label}</span>
                      <span className="text-xs text-slate-400">{b.count} bill(s)</span>
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-slate-900">{formatCurrency(b.total)}</span>
                  </button>
                  {isOpen && (
                    <div className="border-t border-slate-100 bg-slate-50/50 px-3 py-2">
                      {b.preview.length === 0 ? (
                        <p className="text-xs text-slate-400 py-1">No bills.</p>
                      ) : (
                        <>
                          {b.preview.map((p, i) => (
                            <div key={i} className="flex items-center justify-between gap-2 py-1 text-xs">
                              <span className="min-w-0 truncate">
                                <span className="font-medium text-slate-700">{p.party}</span>
                                <span className="text-slate-400"> · {p.no || '—'} · {p.days}d</span>
                              </span>
                              <span className="tabular-nums font-medium text-slate-800 whitespace-nowrap">{formatCurrency(p.out)}</span>
                            </div>
                          ))}
                          {b.count > b.preview.length && (
                            <button onClick={onViewAll} className="mt-1 text-xs text-primary-600 hover:underline inline-flex items-center gap-1">
                              View all {b.count} bills <ArrowRight size={11} />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

// ── Tally vs ERP compare modal ──────────────────────────────────────────
function CompareModal({ compare, onClose }) {
  const { tally, erp, diff } = compare;
  const total = tally.value + erp.value;
  const row = (label, c, tone) => {
    const pct = total > 0 ? (c.value / total) * 100 : 0;
    return (
      <div className="px-5 py-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium text-slate-700">{label} <span className="text-slate-400">· {c.count} bill(s)</span></span>
          <span className="text-sm font-semibold tabular-nums text-slate-900">{formatCurrency(c.value)}</span>
        </div>
        <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
          <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} aria-hidden="true" />
      <div className="relative w-[440px] max-w-[94vw] rounded-2xl bg-white shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 h-14 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-800">Tally vs ERP — expense bills</h3>
          <button onClick={onClose} className="p-2 -mr-2 text-slate-500 hover:text-slate-700 rounded-lg" aria-label="Close"><X size={18} /></button>
        </div>
        <div className="divide-y divide-slate-100">
          {row('Tally (imported)', tally, 'bg-teal-500')}
          {row('ERP (scanned / entered)', erp, 'bg-indigo-500')}
        </div>
        <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-between text-sm">
          <span className="text-slate-500">Difference</span>
          <span className="font-semibold tabular-nums text-slate-900">{formatCurrency(diff)}</span>
        </div>
      </div>
    </div>
  );
}
