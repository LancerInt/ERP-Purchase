// Unified Deviations report. One place to review every kind of deviation the
// ERP detects — MSME overdue dues (payable + receivable), GSTR-1/GSTR-2B
// mismatches, ERP↔Tally sync gaps, and overdue/draft exceptions — with an
// acknowledge/resolve workflow. Backed by GET /api/deviations/ (+ /acks/).
import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  AlertTriangle, Loader2, ExternalLink, Check, RotateCcw, Download, X,
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
} from 'lucide-react';
import MainLayout from '../../../components/layout/MainLayout';
import PageHeader from '../../../components/common/PageHeader';
import CustomSelect from '@/components/ui/CustomSelect';
import { PeriodNavigator, usePeriodFilter } from '@/components/common/PeriodNavigator';
import apiClient from '../../../utils/api.js';
import useLookup from '../../../hooks/useLookup.js';
import { formatCurrency } from '@/utils/formatters';
import exportToExcel from '../../../utils/exportExcel.js';

// Tabs. MSME is one tab with a payable/receivable sub-toggle (two categories).
const TABS = [
  { key: 'MSME', label: 'MSME', cats: ['MSME_PAY', 'MSME_RECV'] },
  { key: 'GSTR1', label: 'GSTR-1', cats: ['GSTR1'] },
  { key: 'GSTR2B', label: 'GSTR-2B', cats: ['GSTR2B'] },
  { key: 'TALLY_ERP', label: 'ERP ↔ Tally', cats: ['TALLY_ERP'] },
  { key: 'PAYMENT_MADE', label: 'Payments made', cats: ['PAYMENT_MADE'] },
  { key: 'PAYMENT_RECV', label: 'Payments received', cats: ['PAYMENT_RECV'] },
  { key: 'EXCEPTION', label: 'Exceptions', cats: ['EXCEPTION'] },
];
const CAT_LABEL = {
  MSME_PAY: 'MSME payable (we owe)', MSME_RECV: 'MSME receivable (owed to us)',
  GSTR1: 'GSTR-1', GSTR2B: 'GSTR-2B', TALLY_ERP: 'ERP ↔ Tally',
  PAYMENT_MADE: 'Payments made (bank)', PAYMENT_RECV: 'Payments received (bank)',
  EXCEPTION: 'Exceptions',
};
const SEV = {
  high: 'bg-rose-50 text-rose-700 border-rose-200',
  med: 'bg-amber-50 text-amber-700 border-amber-200',
  low: 'bg-slate-50 text-slate-600 border-slate-200',
};
const DOT = { high: 'bg-rose-500', med: 'bg-amber-500', low: 'bg-slate-300' };
const PAGE_SIZE = 25;
const inr = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

export default function Deviations() {
  const { options: companies } = useLookup('/api/companies/', { labelField: 'legal_name' });
  // The active tile and company live in the URL, so opening a reference (a bill,
  // a bank line, an invoice) and pressing Back returns to the SAME tile and
  // company — not a fresh page reset to MSME. Seeded from the query string and
  // written back below.
  const [sp, setSp] = useSearchParams();
  const [company, setCompany] = useState(sp.get('company') || '');
  const period = usePeriodFilter('fy');
  const { from, to } = period.range || {};

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(() => {
    const t = sp.get('tab');
    return TABS.some((x) => x.key === t) ? t : 'MSME';
  });
  const [msmeSide, setMsmeSide] = useState('MSME_PAY');
  const [showResolved, setShowResolved] = useState(false);
  const [ackFor, setAckFor] = useState(null); // {row, status}
  const [page, setPage] = useState(1);

  // Default to SS BIOCHEM once the list loads, else the first company.
  // Skipped when the URL already named a company (a Back-restored view).
  useEffect(() => {
    if (!company && companies.length) {
      const biochem = companies.find((c) => /biochem/i.test(c.label || ''));
      setCompany(String((biochem || companies[0]).value));
    }
  }, [companies, company]);

  // Keep the address in step with the active tile + company, so Back reproduces
  // this exact view. `replace` on purpose — switching tiles is not a separate
  // history entry; only navigating AWAY (to a reference) is.
  useEffect(() => {
    const next = new URLSearchParams(sp);
    if (tab && tab !== 'MSME') next.set('tab', tab); else next.delete('tab');
    if (company) next.set('company', company); else next.delete('company');
    if (next.toString() !== sp.toString()) setSp(next, { replace: true });
  }, [tab, company, sp, setSp]);

  const fetchData = useCallback(() => {
    if (!company) { setData(null); return; }
    let cancelled = false;
    setLoading(true); setError(null);
    const p = new URLSearchParams({ company });
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    apiClient.get(`/api/deviations/?${p}`)
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch((e) => { if (!cancelled) setError(e?.response?.data?.detail || 'Failed to load deviations'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [company, from, to]);

  useEffect(() => { const c = fetchData(); return c; }, [fetchData]);

  const summary = data?.summary || {};
  const tabsData = data?.tabs || {};

  // Which categories feed the active tab (MSME tab respects the sub-toggle).
  const activeCats = tab === 'MSME' ? [msmeSide] : (TABS.find((t) => t.key === tab)?.cats || []);
  const rows = useMemo(() => {
    const out = [];
    for (const c of activeCats) out.push(...(tabsData[c]?.rows || []));
    return showResolved ? out : out.filter((r) => r.ack?.status !== 'resolved');
  }, [tabsData, activeCats, showResolved]);

  // Pagination (client-side). Reset to page 1 whenever the view changes.
  useEffect(() => { setPage(1); }, [tab, msmeSide, showResolved, company, from, to]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const curPage = Math.min(page, pageCount);
  const pageRows = rows.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);

  // Dynamic columns — show Date / Overdue only when the active tab's rows
  // actually carry those values. GSTR-2B rows have neither (a 2B line has no
  // due date and nothing is "overdue"), so both columns drop out for it; GSTR-1
  // keeps Date (invoice dates) but not Overdue; MSME / payments keep both. Keyed
  // off the full active row set, not the current page, so a column doesn't
  // appear and disappear as you page.
  const showDate = rows.some((r) => r.date);
  const showOverdue = rows.some((r) => r.days_overdue != null);

  // Per-tab count for the summary chip and the tab badge.
  const tabCount = (t) => t.cats.reduce((n, c) => n + (summary[c]?.count || 0), 0);
  const tabTotal = (t) => t.cats.reduce((n, c) => n + Number(summary[c]?.total || 0), 0);

  // ── acknowledge / resolve ──────────────────────────────────────────────────
  const applyAck = (row, status, note) => {
    // Optimistic: stamp the row in place.
    const prev = row.ack;
    row.ack = { status, note: note || '' };
    setData({ ...data });
    apiClient.post('/api/deviations/acks/', {
      category: row.category, dedup_key: row.dedup_key, company,
      status, note: note || '',
      snapshot: { party: row.party, ref: row.ref, amount: row.amount, date: row.date },
    }).then(() => toast.success(status === 'resolved' ? 'Marked resolved' : 'Acknowledged'))
      .catch(() => { row.ack = prev; setData({ ...data }); toast.error('Could not save'); });
    setAckFor(null);
  };
  const clearAck = (row) => {
    const prev = row.ack;
    row.ack = null;
    setData({ ...data });
    // Find the ack id by refetching is simplest; instead DELETE by filter is not
    // supported, so we POST status back to 'open' via a soft route: re-fetch.
    apiClient.get(`/api/deviations/acks/?company=${company}&category=${row.category}`)
      .then((r) => {
        const hit = (r.data?.results || r.data || []).find((a) => a.dedup_key === row.dedup_key);
        if (hit) return apiClient.delete(`/api/deviations/acks/${hit.id}/`);
      })
      .then(() => toast.success('Reopened'))
      .catch(() => { row.ack = prev; setData({ ...data }); toast.error('Could not reopen'); });
  };

  const exportTab = () => {
    if (!rows.length) return;
    exportToExcel(
      rows.map((r) => ({
        category: CAT_LABEL[r.category] || r.category,
        party: r.party, reference: r.ref, date: r.date || '',
        days_overdue: r.days_overdue ?? '', amount: Number(r.amount || 0).toFixed(2),
        detail: r.detail, status: r.ack?.status || 'open', note: r.ack?.note || '',
      })),
      [
        { field: 'category', header: 'Category' }, { field: 'party', header: 'Party' },
        { field: 'reference', header: 'Reference' }, { field: 'date', header: 'Date' },
        { field: 'days_overdue', header: 'Days Overdue' }, { field: 'amount', header: 'Amount (₹)' },
        { field: 'detail', header: 'Detail' }, { field: 'status', header: 'Status' },
        { field: 'note', header: 'Note' },
      ],
      `deviations-${tab}-${new Date().toISOString().slice(0, 10)}`,
    );
  };

  return (
    <MainLayout>
      <PageHeader
        title="Deviations"
        subtitle="MSME, GSTR, ERP↔Tally and exception deviations in one register"
        breadcrumbs={[{ label: 'Finance', href: '/finance/dashboard' }, { label: 'Deviations' }]}
        icon={AlertTriangle}
        actions={{ onPrint: () => window.print() }}
      />

      <div className="px-3 sm:px-0 pb-10 space-y-4">
        {/* Filters */}
        <div className="bg-white rounded-lg border border-slate-200 shadow-sm px-3 py-2.5 flex flex-wrap items-center gap-2">
          <CustomSelect value={company} onChange={(e) => setCompany(e.target.value)}
            className="border border-slate-300 rounded-lg px-2 text-sm bg-white min-w-[200px] h-9">
            {companies.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </CustomSelect>
          <PeriodNavigator allowAll {...period.navProps} />
          <span className="text-[11px] text-slate-400 ml-1">
            MSME is as of today; others use the period.
          </span>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-16 text-slate-500">
            <Loader2 className="animate-spin mr-2" size={18} /> Loading deviations…
          </div>
        )}
        {error && <p className="text-sm text-rose-600 text-center py-8">{error}</p>}

        {!loading && !error && data && (
          <>
            {/* Summary strip — one card per tab (count + ₹), click to open it. */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
              {TABS.map((t) => {
                const n = tabCount(t);
                const active = tab === t.key;
                return (
                  <button key={t.key} type="button" onClick={() => setTab(t.key)}
                    className={`text-left rounded-xl border p-3 transition ${active
                      ? 'border-indigo-400 bg-indigo-50/50 ring-1 ring-indigo-200'
                      : 'border-slate-200 bg-white hover:border-indigo-200'}`}>
                    <p className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold truncate">{t.label}</p>
                    <p className={`mt-1 text-lg font-bold tabular-nums ${n ? 'text-slate-900' : 'text-slate-300'}`}>{n}</p>
                    <p className="text-[11px] text-slate-400 tabular-nums truncate">{inr(tabTotal(t))}</p>
                  </button>
                );
              })}
            </div>

            {/* Tab controls */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {tab === 'MSME' && (
                  <div className="flex rounded-lg border border-slate-300 overflow-hidden text-xs">
                    {[['MSME_PAY', 'Payable'], ['MSME_RECV', 'Receivable']].map(([k, l]) => (
                      <button key={k} type="button" onClick={() => setMsmeSide(k)}
                        className={`px-2.5 py-1.5 ${msmeSide === k ? 'bg-indigo-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                        {l} <span className="opacity-70">({summary[k]?.count || 0})</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
                  <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
                  Show resolved
                </label>
                <button type="button" onClick={exportTab} disabled={!rows.length}
                  className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline disabled:opacity-40">
                  <Download size={13} /> Excel
                </button>
              </div>
            </div>

            {/* Rows */}
            <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              {rows.length === 0 ? (
                <div className="py-12 text-center text-sm text-slate-400">
                  No {CAT_LABEL[activeCats[0]] || 'deviations'} for this company &amp; period. ✓
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-primary-50 border-b-2 border-slate-300 text-[10px] uppercase tracking-wide text-primary-700">
                        <th className="px-3 py-2 text-left font-semibold">Party</th>
                        <th className="px-3 py-2 text-left font-semibold">Reference</th>
                        {showDate && <th className="px-3 py-2 text-left font-semibold">Date</th>}
                        {showOverdue && <th className="px-3 py-2 text-right font-semibold">Overdue</th>}
                        <th className="px-3 py-2 text-right font-semibold">Amount</th>
                        <th className="px-3 py-2 text-left font-semibold">Detail</th>
                        <th className="px-3 py-2 text-right font-semibold">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((r) => {
                        const resolved = r.ack?.status === 'resolved';
                        const ackd = r.ack?.status === 'acknowledged';
                        return (
                          <tr key={`${r.category}:${r.dedup_key}`}
                            className={`border-t border-slate-100 ${resolved ? 'opacity-50' : ''}`}>
                            <td className="px-3 py-2 text-slate-700 max-w-[200px] truncate" title={r.party}>
                              <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle ${DOT[r.severity] || 'bg-slate-300'}`} />
                              {r.party || '—'}
                            </td>
                            <td className="px-3 py-2 font-medium whitespace-nowrap">
                              {r.link
                                ? <Link to={r.link} className="text-indigo-600 hover:underline inline-flex items-center gap-1">{r.ref}<ExternalLink size={11} /></Link>
                                : <span className="text-slate-700">{r.ref}</span>}
                            </td>
                            {showDate && <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.date || '—'}</td>}
                            {showOverdue && (
                              <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                                {r.days_overdue != null
                                  ? <span className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${SEV[r.severity] || SEV.low}`}>{r.days_overdue}d</span>
                                  : '—'}
                              </td>
                            )}
                            <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-800 whitespace-nowrap">{formatCurrency(r.amount)}</td>
                            <td className="px-3 py-2 text-slate-500 max-w-[360px]">
                              <span className="line-clamp-2" title={r.detail}>{r.detail}</span>
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              {resolved ? (
                                <button type="button" onClick={() => clearAck(r)}
                                  className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-indigo-600">
                                  <RotateCcw size={12} /> Reopen
                                </button>
                              ) : (
                                <div className="inline-flex items-center gap-1.5">
                                  {ackd
                                    ? <span className="inline-flex items-center gap-1 text-[11px] text-amber-700" title={r.ack?.note || ''}><Check size={12} /> Ack'd</span>
                                    : <button type="button" onClick={() => setAckFor({ row: r, status: 'acknowledged' })}
                                        className="text-[11px] text-slate-500 hover:text-amber-700">Acknowledge</button>}
                                  <button type="button" onClick={() => setAckFor({ row: r, status: 'resolved' })}
                                    className="text-[11px] font-medium text-emerald-700 hover:underline">Resolve</button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            {rows.length > PAGE_SIZE && (
              <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                <span className="tabular-nums">
                  Showing {(curPage - 1) * PAGE_SIZE + 1}–{Math.min(curPage * PAGE_SIZE, rows.length)} of {rows.length.toLocaleString('en-IN')}
                </span>
                <div className="flex items-center gap-1">
                  <button type="button" aria-label="First page" disabled={curPage <= 1} onClick={() => setPage(1)}
                    className="p-1 rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50"><ChevronsLeft size={15} /></button>
                  <button type="button" aria-label="Previous page" disabled={curPage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="p-1 rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50"><ChevronLeft size={15} /></button>
                  <span className="px-1.5 tabular-nums">{curPage} / {pageCount}</span>
                  <button type="button" aria-label="Next page" disabled={curPage >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                    className="p-1 rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50"><ChevronRight size={15} /></button>
                  <button type="button" aria-label="Last page" disabled={curPage >= pageCount} onClick={() => setPage(pageCount)}
                    className="p-1 rounded-lg border border-slate-200 disabled:opacity-40 hover:bg-slate-50"><ChevronsRight size={15} /></button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Acknowledge / Resolve note modal */}
      {ackFor && (
        <AckModal info={ackFor} onClose={() => setAckFor(null)}
          onSave={(note) => applyAck(ackFor.row, ackFor.status, note)} />
      )}
    </MainLayout>
  );
}

function AckModal({ info, onClose, onSave }) {
  const [note, setNote] = useState(info.row.ack?.note || '');
  const title = info.status === 'resolved' ? 'Mark resolved' : 'Acknowledge';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/40" aria-hidden="true" />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md p-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
            <p className="text-[11px] text-slate-500 truncate">{info.row.party} · {info.row.ref}</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded text-slate-400 hover:bg-slate-100"><X size={16} /></button>
        </div>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
          placeholder="Note (optional) — reason, follow-up, who/when…"
          className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        <div className="flex justify-end gap-2 mt-3">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50">Cancel</button>
          <button type="button" onClick={() => onSave(note)}
            className={`px-3 py-1.5 text-sm rounded-lg text-white font-medium ${info.status === 'resolved' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-amber-600 hover:bg-amber-700'}`}>
            {title}
          </button>
        </div>
      </div>
    </div>
  );
}
