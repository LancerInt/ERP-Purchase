/**
 * Sales -> TDS (194Q) — the "TDS Receivable U/s 194Q" ledger.
 *
 * Every invoice/note's TDS in date order with a running total. Each entry splits
 * into "On invoice" (tds_total) and "At payment" (tds_at_payment, from the 194Q
 * journals) and links back to its source invoice. Data: /api/sales/receivables/tds-ledger/.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, Link, useLocation } from 'react-router-dom';
import { Percent, Search, Download, Loader2 } from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomSelect from '@/components/ui/CustomSelect';
import { PeriodNavigator, effWindow, todayISO } from '../../../components/common/PeriodNavigator';
import { CTRL_ROW, CTRL_FIELD, CTRL_SEG, CTRL_SEG_ITEM, CTRL_EXPORT, CTRL_H } from '@/components/common/controls';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { useUrlState } from '../../../hooks/useUrlState.js';
import exportToExcel from '../../../utils/exportExcel.js';
import toast from 'react-hot-toast';

const fmt = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Each TDS leg links to its source invoice (the 194Q journal/receipt is not
// stored as its own document); notes link to the register.
const refHref = (r) => {
  if (r.ref_kind === 'invoice' && r.ref_id) return `/sales/invoices/${r.ref_id}`;
  if (r.ref_kind === 'note') return '/sales/debit-notes';
  return null;
};
const kindCls = (k) => ({
  'On invoice': 'bg-sky-50 text-sky-700', 'At payment': 'bg-emerald-50 text-emerald-700',
  'Note': 'bg-amber-50 text-amber-700', 'Journal': 'bg-violet-50 text-violet-700',
}[k] || 'bg-slate-100 text-slate-600');
// The dashboard's TDS (194Q) tile calls these Total / On invoice / Journal and
// its buttons navigate straight to this page, so the page now uses the same
// three words instead of All / On invoice / At payment / Note.
//
// The label is no longer the filter value, because two of them differ from what
// the row actually carries: the backend still stores the at-payment 194Q
// journal as kind 'At payment', and 'Journal' is just what the tile calls it.
// So each entry is [button label, the kinds to match]; null means match
// everything. Note rows are not dropped -- they simply have no button of their
// own now and appear under Total with everything else.
//
// 'Journal' matches TWO kinds. `tds_at_payment` on an invoice is one route and
// is 0.00 on both companies today; the 194Q actually withheld at payment time
// is a journal of its own (ReceivableAdjustment) and arrives as kind 'Journal'.
// It is the bigger half -- SS Biochem 4,03,839.11 against 3,36,324.00 on
// invoices -- and used to be missing from this page altogether, so the button
// filtered to nothing.
const KIND_FILTERS = [
  ['Total', null],
  ['On invoice', ['On invoice']],
  ['Journal', ['At payment', 'Journal']],
];

export default function SalesTds({
  // Rendered INSIDE the Sales Analytics drill rather than as its own page.
  // Every other tile opens that way; TDS was the one that navigated off to a
  // separate screen with its own header, breadcrumb and company pills, so the
  // dashboard's filters were handed over as query params and the way back was
  // a browser Back rather than the drill's own close.
  inline = false,
  period0, anchor0, from0, to0, companyId0,
} = {}) {
  const [sp, setSp] = useSearchParams();
  const location = useLocation();
  const [companyId, setCompanyId] = useState(
    inline ? (companyId0 || '') : (sp.get('company') || ''));
  // Search / kind / customer are DOMAIN filters: standalone they live in the URL
  // (Back / refresh / sharing restore them); inline, the dashboard owns the URL,
  // so they stay as plain local state to avoid fighting it. Both hooks are always
  // called (stable order) and we pick the pair by `inline`, exactly like the
  // company / period seeding above.
  const urlQ = useUrlState('q', '');
  const stateQ = useState('');
  const [q, setQ] = inline ? stateQ : urlQ;
  const urlKind = useUrlState('kind', 'Total');
  const stateKind = useState('Total');
  const [activeKind, setActiveKind] = inline ? stateKind : urlKind;   // 'Total' = every kind
  const kindFilter = KIND_FILTERS.find(([label]) => label === activeKind)?.[1] ?? null;
  const urlCust = useUrlState('cust', '');
  const stateCust = useState('');
  const [custFilter, setCustFilter] = inline ? stateCust : urlCust;   // party name, '' = all
  // The window is taken from the URL when one is given -- the Sales Analytics
  // TDS tile hands over the period it is showing, so this page opens on the
  // same figure instead of on every entry ever recorded. With no parameter it
  // still opens on 'all', which is right for someone opening the ledger
  // directly from the menu.
  // Inline, the dashboard's own window is the starting point; standalone,
  // the URL is (and 'all' is right for someone opening the ledger from the
  // menu with no parameters).
  const [period, setPeriod] = useState(
    inline ? (period0 || 'month') : (sp.get('period') || 'all'));   // all|today|week|month|fy|custom
  const [anchor, setAnchor] = useState(
    inline ? (anchor0 || todayISO()) : (sp.get('anchor') || todayISO()));
  const [customFrom, setCustomFrom] = useState(
    inline ? (from0 || todayISO()) : (sp.get('cfrom') || todayISO()));
  const [customTo, setCustomTo] = useState(
    inline ? (to0 || todayISO()) : (sp.get('cto') || todayISO()));
  const eff = effWindow(period, anchor, customFrom, customTo);

  const { options: companyOptions } = useLookup('/api/companies/');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const p = new URLSearchParams(sp);
    const put = (k, v, keep) => { if (keep) p.set(k, v); else p.delete(k); };
    put('company', companyId, !!companyId);
    // The WINDOW has to survive in the address too, not just the company.
    // Writing a fresh object here deleted it, so Back returned to a URL that
    // no longer said `fy` and the page fell back to 'all'.
    put('period', period, period && period !== 'all');
    put('anchor', anchor, period !== 'custom' && period !== 'all');
    put('cfrom', customFrom, period === 'custom');
    put('cto', customTo, period === 'custom');
    const next = p.toString();
    // Inline, the dashboard owns the URL — it already carries `view=tds`
    // plus its own period/company, and writing ours over the top would
    // fight it on every filter change.
    if (!inline && next !== sp.toString()) setSp(p, { replace: true });
  }, [companyId, period, anchor, customFrom, customTo, sp, setSp]);

  useEffect(() => {
    setError(null); setLoading(true);
    const params = new URLSearchParams();
    if (companyId) params.set('company', companyId);
    // eff is NULL when period is 'all' — see effWindow. This page DEFAULTS to
    // 'all', so an unguarded eff.from throws on first render.
    if (period !== 'all' && eff?.from && eff?.to) { params.set('from', eff.from); params.set('to', eff.to); }
    let cancelled = false;
    apiClient.get(`/api/sales/receivables/tds-ledger/?${params.toString()}`)
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(e => { if (!cancelled) setError(e.response?.data?.detail || 'Failed to load TDS ledger.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // A dependency array is evaluated on EVERY render, before and regardless of
    // any guard inside the effect — which is what actually crashed this page.
  }, [companyId, period, eff?.from, eff?.to]);

  // Customer options = the distinct parties present in the loaded data, so the
  // dropdown always matches what the current company/period actually contains.
  const customerOptions = useMemo(() => {
    const set = new Set((data?.rows || []).map(r => (r.party || '').trim()).filter(Boolean));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [data]);

  // Drop a stale customer pick when it's no longer present (company/period change).
  useEffect(() => {
    if (custFilter && !customerOptions.includes(custFilter)) setCustFilter('');
  }, [customerOptions]);   // eslint-disable-line

  const rows = useMemo(() => {
    let all = data?.rows || [];
    if (kindFilter) all = all.filter(r => kindFilter.includes(r.kind));
    if (custFilter) all = all.filter(r => (r.party || '').trim() === custFilter);
    const nq = q.trim().toLowerCase();
    if (nq) all = all.filter(r => JSON.stringify(r).toLowerCase().includes(nq));
    return all;
  }, [data, q, kindFilter, custFilter]);

  const shownTotal = useMemo(
    () => rows.reduce((a, r) => a + (Number(r.tds) || 0), 0), [rows]);

  const exportRows = () => {
    if (!rows.length) return;
    exportToExcel(rows.map(r => ({ date: r.date, doc_no: r.doc_no, kind: r.kind, party: r.party, tds: Number(r.tds).toFixed(2), balance: Number(r.balance).toFixed(2) })),
      [{ field: 'date', header: 'Date' }, { field: 'doc_no', header: 'Doc No' }, { field: 'kind', header: 'Kind' }, { field: 'party', header: 'Party' }, { field: 'tds', header: 'TDS (₹)' }, { field: 'balance', header: 'Running (₹)' }],
      'tds-194q-ledger', 'Sheet1');
    toast.success('Exported!');
  };

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
              onClick={() => setCompanyId(active ? '' : c.value)}
              className={`${CTRL_H} px-2.5 rounded-lg text-xs font-semibold border transition whitespace-nowrap ${active
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                : 'bg-white text-slate-700 border-slate-300 hover:border-indigo-300 hover:text-indigo-600'}`}>
              {short(c.label)}
            </button>
          );
        })}
      </div>
    );
  })();

  // Inline, the drill already has the dashboard's heading, its "Viewing: TDS"
  // pill and its close button — a second title, breadcrumb and set of company
  // pills would be the page announcing itself twice.
  const body = (
    <>
      {!inline && (
        <PageHeader
          title="TDS (194Q)"
          subtitle="TDS Receivable U/s 194Q — on-invoice and at-payment, with a running total"
          icon={Percent}
          breadcrumbs={[{ label: 'Sales', href: '/sales/orders' }, { label: 'TDS 194Q' }]}
          actions={{ right: companyButtons }}
        />
      )}

      {/* One toolbar, everything left-aligned and wrapping.
          It used to be two rows with an `ml-auto` on each, which pinned the
          company and customer selects to the far right edge: on a wide screen
          the eye crossed a dead gap to reach a control that belongs with the
          pills, and the two selects stacked up against the card's own search
          box. Reading order is now when -> who -> what, in one flow.

          "All Time" was also a detached bordered button sitting beside the
          joined period segments; PeriodNavigator already has an `allowAll`
          pill, so it belongs INSIDE that group rather than next to it. */}
      <div className={`${CTRL_ROW} mb-3`}>
        <PeriodNavigator allowAll period={period} setPeriod={setPeriod}
          anchor={anchor} setAnchor={setAnchor}
          customFrom={customFrom} customTo={customTo} setCustomFrom={setCustomFrom} setCustomTo={setCustomTo} />

        <CustomSelect value={companyId} onChange={e => setCompanyId(e.target.value)}
          className={`${CTRL_FIELD} w-[150px]`} title="Company">
          <option value="">All Companies</option>
          {companyOptions.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </CustomSelect>

        <CustomSelect value={custFilter} onChange={e => setCustFilter(e.target.value)}
          className={`${CTRL_FIELD} w-[200px]`} title="Customer">
          <option value="">All Customers</option>
          {customerOptions.map(c => <option key={c} value={c}>{c}</option>)}
        </CustomSelect>

        {/* Joined, like the period control — these are one either/or choice,
            not four independent toggles. */}
        <div className={CTRL_SEG}>
          {KIND_FILTERS.map(([label], i) => (
            <button key={label} type="button" onClick={() => setActiveKind(label)}
              aria-pressed={activeKind === label}
              className={CTRL_SEG_ITEM(activeKind === label, i === 0)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-4 py-3 border-b border-slate-100">
          <p className="text-sm font-semibold text-slate-800">TDS Receivable U/s 194Q · {rows.length} entries
            <span className="ml-2 text-xs font-normal text-slate-500">Total {fmt(shownTotal)}</span></p>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search…"
                className={`${CTRL_FIELD} pl-8 pr-2 w-44`} />
            </div>
            <button onClick={exportRows} disabled={!rows.length}
              className={`${CTRL_EXPORT} disabled:opacity-50`}>
              <Download size={14} /> Excel
            </button>
          </div>
        </div>

        {loading && <div className="p-10 flex items-center justify-center text-slate-500"><Loader2 className="animate-spin mr-2" size={18} /> Loading…</div>}
        {error && <div className="p-4 sm:p-5 text-rose-600 text-sm">{error}</div>}

        {!loading && !error && data && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gradient-to-r from-primary-50/70 to-sky-50/40 text-slate-500 text-[11px] font-semibold uppercase tracking-wide">
                <tr><th className="text-left px-3 py-2.5">Date</th><th className="text-left px-3 py-2.5">Doc No</th>
                  <th className="text-left px-3 py-2.5">Kind</th>
                  <th className="text-left px-3 py-2.5">Party</th><th className="text-right px-3 py-2.5">TDS</th>
                  <th className="text-right px-3 py-2.5">Running</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-slate-100 hover:bg-primary-50/40 transition-colors">
                    <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">{r.date}</td>
                    <td className="px-3 py-2.5 text-slate-700">
                      {refHref(r)
                        ? <Link to={refHref(r)} state={{ backTo: `${location.pathname}${location.search}` }}
                            className="text-indigo-600 hover:underline">{r.doc_no}</Link>
                        : r.doc_no}
                    </td>
                    <td className="px-3 py-2.5"><span className={`px-2 py-0.5 rounded text-xs font-medium ${kindCls(r.kind)}`}>{r.kind}</span></td>
                    <td className="px-3 py-2.5 text-slate-700">{r.party}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-indigo-600">{fmt(r.tds)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-medium">{fmt(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && <div className="p-8 text-center text-slate-400 text-sm">No TDS entries for this filter.</div>}
          </div>
        )}
      </div>
    </>
  );

  return inline ? body : <MainLayout>{body}</MainLayout>;
}
