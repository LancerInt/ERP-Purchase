/**
 * Sales -> Ledger — a Tally-style ledger explorer for the sales module.
 *
 * Two modes:
 *   - Debtors  : Sundry-Debtors group summary (opening + closing per customer);
 *                click a row to open that customer's statement. DEFAULT view, so
 *                the page shows data immediately instead of an empty picker.
 *   - Customer : running statement for one customer (Dr/Cr, TDS, balance),
 *                reconciles to Tally's Ledger Vouchers screen.
 *
 * 194Q TDS has its own page (Sales -> TDS 194Q). Data comes from
 * /api/sales/receivables/{debtors-summary,customer-ledger}/.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { BookOpen, Search, Download, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomSelect from '@/components/ui/CustomSelect';
import { PeriodNavigator, effWindow, todayISO } from '../../../components/common/PeriodNavigator';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import exportToExcel from '../../../utils/exportExcel.js';
import toast from 'react-hot-toast';

const fmt = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const bal = (v) => { const n = Number(v) || 0; return `${fmt(Math.abs(n))} ${n < 0 ? 'Cr' : 'Dr'}`; };
const typeCls = (t) => ({
  'Invoice': 'bg-sky-50 text-sky-700', 'Receipt': 'bg-emerald-50 text-emerald-700',
  'Debit Note': 'bg-amber-50 text-amber-700', 'Credit Note': 'bg-blue-50 text-blue-700',
}[t] || 'bg-slate-100 text-slate-600');
// Where each row opens, matching the Sales Analytics customer panel -- the
// same endpoint feeds both, and it has always carried ref_kind / ref_id.
// Previously notes and receipts dropped you on their LIST pages, which threw
// the record away: clicking "Tally receipt 16" showed every receipt.
//
// `customerId` is passed on the receipt link because the receipt page uses it
// to break the voucher back down into the invoices it settled.
const docHref = (r, customerId) => {
  if (r.type === 'Invoice' && r.ref_id) return `/sales/invoices/${r.ref_id}`;
  if (r.ref_kind === 'vendor_bill' && r.ref_id) return `/purchase/bills/${r.ref_id}`;
  if (r.ref_kind === 'payment_made' && r.ref_id) return `/purchase/payments-made/${r.ref_id}`;
  if (r.ref_kind === 'receipt' && r.ref_id) {
    return `/sales/receivables/receipt/${encodeURIComponent(r.ref_id)}?customer=${customerId}`;
  }
  if (r.ref_kind === 'note' && r.ref_id) return `/sales/debit-notes/${r.ref_id}`;
  if ((r.type === 'Debit Note' || r.type === 'Credit Note') && r.ref_id) {
    return `/sales/debit-notes/${r.ref_id}`;
  }
  return null;
};
const TYPE_FILTERS = ['All', 'Invoice', 'Receipt', 'Debit Note', 'Credit Note'];

export default function SalesLedger() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  // Opening a customer is a DESTINATION; changing a filter is not. The writer
  // below replaced the history entry for both, so clicking a customer
  // overwrote the Debtors entry instead of stacking on it -- and Back then
  // left the Ledger entirely for whatever page came before it.
  const lastNav = useRef(`${sp.get('mode') || 'group'}|${sp.get('customer') || ''}`);
  // True for the one pass where the reader below is adopting a URL that Back
  // (or Forward) just set. Both effects run in the same flush, reader first,
  // and the reader's setState has not committed yet -- so without this the
  // writer would still see the OLD mode, decide the address was wrong, and
  // push it straight back. The address bounced Debtors -> customer -> Debtors,
  // which is the flicker.
  const adopting = useRef(false);
  const [mode, setMode] = useState(sp.get('mode') || 'group');      // group | customer  (Debtors default)
  const [companyId, setCompanyId] = useState(sp.get('company') || '');
  const [customerId, setCustomerId] = useState(sp.get('customer') || '');
  const [q, setQ] = useState(sp.get('q') || '');
  // Period control — mirrors the Sales Analytics navigator. Defaults to the
  // current MONTH (use the month picker for Sep/Aug/Jul…, or "All Time" for the
  // full history). 'all' sends no from/to; the rest resolve via effWindow().
  const [period, setPeriod] = useState(sp.get('period') || 'month'); // all|today|week|month|fy|custom
  const [anchor, setAnchor] = useState(sp.get('anchor') || todayISO());
  const [customFrom, setCustomFrom] = useState(sp.get('cfrom') || todayISO());
  const [customTo, setCustomTo] = useState(sp.get('cto') || todayISO());
  const eff = effWindow(period, anchor, customFrom, customTo);
  const [typeFilter, setTypeFilter] = useState(sp.get('type') || 'All');   // customer-mode row filter

  const { options: companyOptions } = useLookup('/api/companies/');
  const { options: customerOptions } = useLookup(
    companyId ? `/api/customers/?company=${companyId}&has_sales=true` : '/api/customers/?has_sales=true',
    { labelField: 'customer_name' });

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Follow the address when it changes from OUTSIDE this component -- browser
  // Back and Forward, or the header chevron.
  //
  // The state below is seeded from the URL only on mount. Back changes the URL
  // but does NOT remount the page, so `mode` stayed 'customer' and the writer
  // effect below promptly rewrote the address back to the customer view. Back
  // looked like it did nothing. Reading the URL back into state is what makes
  // Back actually leave the statement.
  //
  // It cannot fight the writer: after the writer runs, the URL matches the
  // state, so the guard below is false and nothing happens. `lastNav` is moved
  // in step too, so adopting a URL is not mistaken for a new destination and
  // does not push another entry.
  useEffect(() => {
    const uMode = sp.get('mode') || 'group';
    const uCust = sp.get('customer') || '';
    if (uMode === mode && uCust === customerId) { adopting.current = false; return; }
    adopting.current = true;
    setMode(uMode);
    setCustomerId(uCust);
    setPeriod(sp.get('period') || 'month');
    setAnchor(sp.get('anchor') || todayISO());
    setCustomFrom(sp.get('cfrom') || todayISO());
    setCustomTo(sp.get('cto') || todayISO());
    setTypeFilter(sp.get('type') || 'All');
    setQ(sp.get('q') || '');
    lastNav.current = `${uMode}|${uCust}`;
  }, [sp]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Let the reader settle first; writing mid-adoption is what bounced the
    // address back and made the page flicker.
    if (adopting.current) { adopting.current = false; return; }
    const p = new URLSearchParams(sp);
    const put = (k, v, keep) => { if (keep) p.set(k, v); else p.delete(k); };
    put('mode', mode, !!mode);
    put('company', companyId, !!companyId);
    put('customer', customerId, mode === 'customer' && !!customerId);
    // The statement's own controls belong in the address too, or opening an
    // invoice from it and coming back lands on a reset statement.
    put('period', period, mode === 'customer' && period && period !== 'all');
    put('anchor', anchor, mode === 'customer' && period !== 'all' && period !== 'custom');
    put('cfrom', customFrom, mode === 'customer' && period === 'custom');
    put('cto', customTo, mode === 'customer' && period === 'custom');
    put('type', typeFilter, mode === 'customer' && typeFilter && typeFilter !== 'All');
    put('q', q, !!q.trim());
    const next = p.toString();
    if (next === sp.toString()) return;
    // Push when the mode or the customer changes -- those are the two things
    // that make this a different view, and Back should walk back through them.
    // Everything else (period, type, search, company) is a filter and replaces,
    // so Back is not forced to crawl through every dropdown that was touched.
    const navKey = `${mode}|${customerId}`;
    const isDestination = lastNav.current !== navKey;
    lastNav.current = navKey;
    setSp(p, { replace: !isDestination });
  }, [mode, companyId, customerId, period, anchor, customFrom, customTo, typeFilter, q, sp, setSp]);

  useEffect(() => {
    setError(null); setData(null);
    if (mode === 'customer' && !customerId) return;
    setLoading(true);
    let url, params = new URLSearchParams();
    if (mode === 'customer') { url = '/api/sales/receivables/customer-ledger/'; params.set('customer', customerId); }
    else { url = '/api/sales/receivables/debtors-summary/'; if (companyId) params.set('company', companyId); }
    // Date window applies to the customer statement (not the group summary).
    // eff is NULL when period is 'all' — see effWindow.
    if (mode === 'customer' && period !== 'all' && eff?.from && eff?.to) {
      params.set('from', eff.from);
      params.set('to', eff.to);
    }
    let cancelled = false;
    apiClient.get(`${url}?${params.toString()}`)
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(e => { if (!cancelled) setError(e.response?.data?.detail || 'Failed to load ledger.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // Evaluated every render regardless of the guard above, so it must be
    // null-safe or picking "All" throws.
  }, [mode, customerId, companyId, period, eff?.from, eff?.to]);

  const rows = useMemo(() => {
    let all = data?.rows || [];
    if (mode === 'customer' && typeFilter !== 'All') all = all.filter(r => r.type === typeFilter);
    const nq = q.trim().toLowerCase();
    if (!nq) return all;
    return all.filter(r => JSON.stringify(r).toLowerCase().includes(nq));
  }, [data, q, typeFilter, mode]);

  // 10 rows a page, like the other sales lists. The running-balance column is
  // per-row, so a page slice keeps every balance correct; the Opening Balance
  // header shows on page 1 and the Closing Balance footer on the last page, so
  // the statement still reads top-to-bottom as it did in Tally.
  const PAGE_SIZE = 10;
  const [pg, setPg] = useState(1);
  // Back to page 1 whenever the list underneath changes.
  useEffect(() => { setPg(1); }, [mode, customerId, companyId, typeFilter, q, period, eff?.from, eff?.to]);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const cp = Math.min(pg, totalPages);
  const pageRows = rows.slice((cp - 1) * PAGE_SIZE, cp * PAGE_SIZE);

  const openCustomer = (cid) => { setCustomerId(cid); setMode('customer'); };

  const exportRows = () => {
    if (!rows.length) return;
    if (mode === 'group') {
      exportToExcel(rows.map(r => ({ customer: r.customer_name, opening: Number(r.opening).toFixed(2), closing: Number(r.closing).toFixed(2) })),
        [{ field: 'customer', header: 'Customer' }, { field: 'opening', header: 'Opening (₹)' }, { field: 'closing', header: 'Closing (₹)' }],
        'debtors-summary', 'Sheet1');
    } else {
      exportToExcel(rows.map(r => ({ date: r.date, type: r.type, doc_no: r.doc_no, debit: Number(r.debit).toFixed(2), credit: Number(r.credit).toFixed(2), tds: Number(r.tds || 0).toFixed(2), balance: Number(r.balance).toFixed(2) })),
        [{ field: 'date', header: 'Date' }, { field: 'type', header: 'Type' }, { field: 'doc_no', header: 'Doc No' }, { field: 'debit', header: 'Debit (₹)' }, { field: 'credit', header: 'Credit (₹)' }, { field: 'tds', header: 'TDS (₹)' }, { field: 'balance', header: 'Balance (₹)' }],
        `customer-ledger-${(data?.customer_name || 'customer').replace(/[^\w-]+/g, '_')}`, 'Sheet1');
    }
    toast.success('Exported!');
  };

  // Only the group summary is a destination you choose. The customer
  // statement is still here -- clicking a customer row opens it, and the Back
  // arrow returns -- but it is not something you navigate TO from a tab,
  // because arriving without a customer showed an empty screen asking you to
  // pick one.
  const MODES = [
    { id: 'group', icon: BookOpen, l: 'Debtors' },
  ];

  // Company quick-switch chips in the header — same look as Sales Analytics.
  const companyButtons = (() => {
    const bio = companyOptions.find(c => /biochem/i.test(c.label));
    const uai = companyOptions.find(c => /united\s*agro/i.test(c.label));
    const quick = [...(bio ? [bio] : []), ...(uai ? [uai] : [])];
    if (!quick.length) return null;
    const short = (l) => /biochem/i.test(l) ? 'SS Biochem' : (/united\s*agro/i.test(l) ? 'United Agro' : l);
    return (
      <div className="hidden md:flex items-center gap-1.5 shrink-0">
        {quick.map(c => {
          const active = String(companyId || '') === String(c.value);
          return (
            <button key={c.value} type="button" title={c.label}
              onClick={() => { setCompanyId(active ? '' : c.value); setCustomerId(''); }}
              className={`px-2 py-1.5 rounded-lg text-xs font-semibold border transition whitespace-nowrap ${active
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                : 'bg-white text-slate-700 border-slate-200 hover:border-indigo-300 hover:text-indigo-600'}`}>
              {short(c.label)}
            </button>
          );
        })}
      </div>
    );
  })();

  return (
    <MainLayout>
      <PageHeader
        title="Ledger"
        subtitle="Tally-style ledger — debtors group summary and per-customer statement"
        icon={BookOpen}
        breadcrumbs={[{ label: 'Sales', href: '/sales/orders' }, { label: 'Ledger' }]}
        actions={{ right: mode === 'group' ? companyButtons : null }}
        onBack={mode === 'customer'
          ? () => (window.history.state?.idx > 0
            ? navigate(-1)
            : (setMode('group'), setCustomerId('')))
          : undefined}
      />

      {/* Filter bar — full-width row under the header, matching Sales Analytics. */}
      <div className="bg-white rounded-lg border border-slate-200 mb-4 px-2.5 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Mode — segmented control */}
          <div className="flex rounded-lg border border-slate-200 overflow-hidden shrink-0">
            {MODES.map(m => (
              <button key={m.id} type="button" onClick={() => setMode(m.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm ${mode === m.id ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}>
                <m.icon size={15} /> {m.l}
              </button>
            ))}
          </div>

          {/* Period — All time + full Today/Week/Month/FY/Custom navigator
              (customer statement only; the group summary is a point-in-time total) */}
          {mode === 'customer' && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setPeriod('all')}
                className={`px-2.5 py-1.5 rounded-lg text-xs border ${period === 'all' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'}`}>All Time</button>
              <PeriodNavigator period={period === 'all' ? '' : period} setPeriod={setPeriod}
                anchor={anchor} setAnchor={setAnchor}
                customFrom={customFrom} customTo={customTo} setCustomFrom={setCustomFrom} setCustomTo={setCustomTo} />
            </div>
          )}

          {/* Search sits where the company dropdown was. That dropdown chose
              between the same two companies as the chips in the header, so it
              was a second control for one decision -- and two controls for one
              thing can show different answers. The customer picker went with
              the Customer tab: you open a statement by clicking the customer
              you can see, not by hunting a name in a list. */}
          <div className="ml-auto flex items-center gap-1.5 min-w-0">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input value={q} onChange={e => setQ(e.target.value)}
                placeholder="Search customer…"
                className="border border-slate-300 rounded-lg pl-8 pr-2 py-1.5 text-xs bg-white w-[210px]" />
            </div>
          </div>
        </div>
      </div>

      {/* Type filter — customer statement only */}
      {mode === 'customer' && customerId && (
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          {TYPE_FILTERS.map(t => (
            <button key={t} type="button" onClick={() => setTypeFilter(t)}
              className={`px-2.5 py-1 rounded-lg text-xs border ${typeFilter === t ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
              {t}
            </button>
          ))}
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
        {/* header strip: totals + search + export */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-4 py-3 border-b border-slate-100">
          <div className="min-w-0">
            {mode === 'customer' && data && (
              <p className="text-sm font-semibold text-slate-800 truncate">{data.customer_name}
                <span className="ml-2 text-xs font-normal text-slate-500">
                  Opening {bal(data.opening_balance)} · Closing <b>{bal(data.closing_balance)}</b>
                </span></p>
            )}
            {mode === 'group' && data && (
              <p className="text-sm font-semibold text-slate-800">Sundry Debtors · {data.count} customers
                <span className="ml-2 text-xs font-normal text-slate-500">Total {bal(data.total)}</span></p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportRows} disabled={!rows.length}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
              <Download size={14} /> Excel
            </button>
          </div>
        </div>

        {loading && <div className="p-10 flex items-center justify-center text-slate-500"><Loader2 className="animate-spin mr-2" size={18} /> Loading…</div>}
        {error && <div className="p-4 sm:p-5 text-rose-600 text-sm">{error}</div>}
        {!loading && !error && mode === 'customer' && !customerId && (
          <div className="p-10 text-center text-slate-500 text-sm">Select a customer to see the running ledger — or pick one from the Debtors list.</div>
        )}

        {!loading && !error && data && (
          <div className="overflow-x-auto">
            {mode === 'customer' && (
              <table className="w-full text-sm">
                <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-slate-500 text-[11px] font-semibold uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-3 py-2.5">Date</th><th className="text-left px-3 py-2.5">Type</th>
                    <th className="text-left px-3 py-2.5">Doc No</th><th className="text-right px-3 py-2.5">Debit</th>
                    <th className="text-right px-3 py-2.5">Credit</th><th className="text-right px-3 py-2.5">TDS</th>
                    <th className="text-right px-3 py-2.5">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {cp === 1 && (
                  <tr className="border-t border-slate-100 bg-slate-50/50">
                    <td className="px-3 py-2.5 text-slate-500" colSpan={6}>Opening Balance</td>
                    <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{bal(data.opening_balance)}</td>
                  </tr>
                  )}
                  {pageRows.map((r, i) => (
                    <tr key={i} className="border-t border-slate-100 hover:bg-primary-50/40 transition-colors">
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">{r.date}</td>
                      <td className="px-3 py-2.5"><span className={`px-2 py-0.5 rounded text-xs font-medium ${typeCls(r.type)}`}>{r.type}</span></td>
                      <td className="px-3 py-2.5 text-slate-700">
                        {docHref(r, customerId)
                          ? (
                            <Link to={docHref(r, customerId)}
                              state={{ backTo: `${window.location.pathname}${window.location.search}` }}
                              className="text-indigo-600 hover:underline inline-flex items-center gap-1">
                              {r.doc_no}
                              {/* How many invoices this one receipt settled.
                                  The row stays ONE line -- Tally's ledger shows
                                  one line per receipt voucher too -- and the
                                  breakdown is a click away on the receipt
                                  page. `lines` comes from the API. */}
                              {r.lines > 0 && (
                                <span className="text-[10px] font-normal text-slate-400">
                                  {r.lines} invoice{r.lines > 1 ? 's' : ''}
                                </span>
                              )}
                            </Link>
                          )
                          : r.doc_no}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{Number(r.debit) ? fmt(r.debit) : '—'}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{Number(r.credit) ? fmt(r.credit) : '—'}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-indigo-600">{Number(r.tds) ? fmt(r.tds) : '—'}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-medium">{bal(r.balance)}</td>
                    </tr>
                  ))}
                  {cp === totalPages && (
                  <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                    <td className="px-3 py-2.5" colSpan={3}>Closing Balance</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmt(data.current_debit)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmt(data.current_credit)}</td>
                    <td></td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{bal(data.closing_balance)}</td>
                  </tr>
                  )}
                </tbody>
              </table>
            )}

            {mode === 'group' && (
              <table className="w-full text-sm">
                <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-slate-500 text-[11px] font-semibold uppercase tracking-wide">
                  <tr><th className="text-left px-3 py-2.5">Customer</th>
                    <th className="text-right px-3 py-2.5">Opening</th><th className="text-right px-3 py-2.5">Closing</th></tr>
                </thead>
                <tbody>
                  {pageRows.map((r, i) => (
                    <tr key={i} onClick={() => r.customer_id && openCustomer(r.customer_id)}
                      className="border-t border-slate-100 hover:bg-indigo-50 cursor-pointer">
                      <td className="px-3 py-2.5 text-slate-800">{r.customer_name}
                        {r.company_code && <span className="ml-2 text-[11px] text-slate-400">{r.company_code}</span>}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{Number(r.opening) ? bal(r.opening) : '—'}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-medium">{bal(r.closing)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {!rows.length && <div className="p-8 text-center text-slate-400 text-sm">No rows.</div>}
            {rows.length > PAGE_SIZE && (
              <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 text-xs text-slate-500">
                <span>Showing {(cp - 1) * PAGE_SIZE + 1} to {Math.min(cp * PAGE_SIZE, rows.length)} of {rows.length}</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => setPg(cp - 1)} disabled={cp <= 1}
                    className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Previous page"><ChevronLeft size={15} /></button>
                  <span className="px-2 tabular-nums">Page {cp} of {totalPages}</span>
                  <button onClick={() => setPg(cp + 1)} disabled={cp >= totalPages}
                    className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Next page"><ChevronRight size={15} /></button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </MainLayout>
  );
}
